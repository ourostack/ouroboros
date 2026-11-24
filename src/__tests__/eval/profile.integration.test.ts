/**
 * The sandbox runs an agent other than the Butler: a scripted X interview conversation, end to end in the real
 * two-container sandbox, with a profile whose agent is `evalbot` and whose writable paths are only the books CLI's
 * and `state`. The turn must still remove the bad copy, through evalbot's own bundle. Needs Docker and a built checkout: `npm run test:eval-sandbox` (CI runs it on
 * ubuntu-24.04). No model is called.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import type { ProviderRuntime } from "../../heart/core"
import { debriefQuestion, labelLine } from "../../eval/interviews/protocol"
import type { AgentProfile } from "../../eval/sandbox/agent-profile"
import { buildSandboxImage, dockerCli, runSandboxed } from "../../eval/sandbox/docker"
import { projectBundle } from "../../eval/sandbox/projection"
import { loadCases } from "../../eval/self-test"

const REPO = path.resolve(__dirname, "../../..")
const SEED = path.join(REPO, "deploy/unraid/sanctuary.ouro")

describe("a scripted sandbox run of an agent other than the Butler", () => {
  const c = loadCases(path.join(REPO, "src/eval/cases/sanctuary-books")).find((each) => each.id === "remove-bad-copy")!
  let root: string
  let bundleDir: string

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "eval-profile-e2e-"))
    bundleDir = path.join(root, "bundle")
    fs.mkdirSync(path.join(bundleDir, "books"), { recursive: true })
    fs.writeFileSync(path.join(bundleDir, "agent.json"), "{\"name\":\"evalbot\"}\n")
    fs.copyFileSync(path.join(REPO, "src/eval/fakes/books-stub/books"), path.join(bundleDir, "books/books"))
    fs.chmodSync(path.join(bundleDir, "books/books"), 0o755)
    await buildSandboxImage({ repoRoot: REPO, docker: dockerCli() })
  }, 900_000)

  afterAll(() => {
    fs.rmSync(root, { recursive: true, force: true })
  })

  it("mounts the agent's own bundle at its own path and runs the conversation on it", async () => {
    const profile: AgentProfile = {
      agent: "evalbot",
      bundleSource: ({ include, out }) => projectBundle({ bundleDir, seedBundleDir: SEED, include, out }),
      writable: ["books/work", "books/removed", "books/ledger.ndjson", "state"],
    }
    // The arm's shell runs only `books` commands. The guest runs on the one bundle mounted (`mountedAgentRoot` refuses
    // any other count) and its books CLI is that bundle's, so a removal that lands proves the run used evalbot's bundle
    // and could write its `books` paths; the mount path and `--agent` are pinned by `sanctuary-default.test.ts`.
    const steps = [
      { name: "shell", arguments: { command: "books library find 'The Harbour Almanac'" } },
      { name: "shell", arguments: { command: "books library remove 187" } },
    ]
    const results: string[] = []
    let next = 0
    const host: ProviderRuntime = {
      id: "minimax", model: "eval-scripted", client: {}, capabilities: new Set(),
      resetTurnState: () => undefined, appendToolOutput: (_id, output) => { results.push(output) }, ping: async () => undefined, classifyError: () => "unknown",
      streamTurn: async () => {
        next += 1
        const step = steps[next - 1]
        if (step) return { content: "", toolCalls: [{ id: `call-${next}`, name: step.name, arguments: JSON.stringify(step.arguments) }], outputItems: [] }
        return { content: next === steps.length + 1 ? c.fixtures.pass.finalReply : "6\nfine", toolCalls: [], outputItems: [] }
      },
    }
    const last = c.prefix[c.prefix.length - 1]!
    const turn = { product: "X", arm: "cli-shell", labelLine: labelLine("X", "K"), prefix: c.prefix.slice(0, -1), userText: last.content, followUps: [debriefQuestion("X", "K")] }
    const obs = await runSandboxed({
      case: c, bundleDir, seedBundleDir: SEED, host, budget: { take: () => true }, workRoot: root, turnTimeoutMs: 180_000,
      guest: { entry: "interview-guest-entry.js", turn }, profile,
    })
    expect(obs.outcome).toBe("settled")
    expect(results.join("\n")).toContain("189")
    expect(obs.library.map((book) => book.id)).not.toContain(187)
  }, 300_000)
})
