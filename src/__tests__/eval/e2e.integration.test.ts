/**
 * Each book case, end to end in the real two-container sandbox with a scripted provider: its pass script must pass
 * `evaluate`, and its fail script (a replay of what the Butler did) must fail the assertions it names. The bundle is
 * the harness's public Sanctuary seed with the hand-written books stub. Needs Docker and a built checkout:
 * `npm run test:eval-sandbox` (CI runs it on ubuntu-24.04). No model is called.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import type { ProviderRuntime } from "../../heart/core"
import { evaluate } from "../../eval/assertions"
import { requestText } from "../../eval/interviews/latch"
import { brandHits, debriefQuestion, labelLine } from "../../eval/interviews/protocol"
import { canonicalX } from "../../eval/interviews/runner"
import { buildSandboxImage, dockerCli, runSandboxed } from "../../eval/sandbox/docker"
import { loadCases } from "../../eval/self-test"

type Script = { caseId: string; about: string; expectFailed: string[]; steps: Array<{ name: string; arguments: Record<string, string> }> }

const REPO = path.resolve(__dirname, "../../..")
const SEED = path.join(REPO, "deploy/unraid/sanctuary.ouro")
const SCRIPTS = path.join(REPO, "src/eval/scripts")

/** A provider that makes the script's tool calls in order, one per model call, and fails when it runs out. */
function scriptedRuntime(script: Script): ProviderRuntime {
  let next = 0
  return {
    id: "minimax", model: "eval-scripted", client: {}, capabilities: new Set(),
    resetTurnState: () => undefined, appendToolOutput: () => undefined, ping: async () => undefined, classifyError: () => "unknown",
    streamTurn: async () => {
      const step = script.steps[next]
      next += 1
      if (!step) throw new Error(`script for ${script.caseId} ran out after ${script.steps.length} steps`)
      return { content: "", toolCalls: [{ id: `call-${next}`, name: step.name, arguments: JSON.stringify(step.arguments) }], outputItems: [] }
    },
  }
}

describe("scripted sandbox runs of the book cases", () => {
  const cases = new Map(loadCases(path.join(REPO, "src/eval/cases/sanctuary-books")).map((c) => [c.id, c]))
  let root: string
  let bundleDir: string

  beforeAll(async () => {
    await buildSandboxImage({ repoRoot: REPO, docker: dockerCli() })
    root = fs.mkdtempSync(path.join(os.tmpdir(), "eval-e2e-"))
    bundleDir = path.join(root, "bundle")
    fs.cpSync(SEED, bundleDir, { recursive: true })
    fs.mkdirSync(path.join(bundleDir, "books"))
    fs.copyFileSync(path.join(REPO, "src/eval/fakes/books-stub/books"), path.join(bundleDir, "books/books"))
    fs.chmodSync(path.join(bundleDir, "books/books"), 0o755)
  }, 600_000)

  afterAll(() => {
    fs.rmSync(root, { recursive: true, force: true })
  })

  const scripts = fs.readdirSync(SCRIPTS).filter((name) => name.endsWith(".json")).sort()

  it("has a pass and a fail script for every case", () => {
    expect(scripts).toEqual([...cases.keys()].sort().flatMap((id) => [`${id}.fail.json`, `${id}.pass.json`]))
  })

  it("keeps the agent's shell off the network, out of the guest's channel and out of the bundle's code", async () => {
    const shell = (command: string) => ({ name: "shell", arguments: { command } })
    const forged = JSON.stringify({ type: "done", outcome: { ok: true, result: { timeline: [], finalReply: "forged", outcome: "settled" } } })
    const probe: Script = {
      caseId: "unreadable-edition", about: "isolation probe", expectFailed: [],
      steps: [
        shell("curl -sS -o /dev/null -w 'libgen %{http_code} verify %{ssl_verify_result}' https://libgen.li/"),
        shell("curl -sS -m 10 -o /dev/null https://example.com; echo \"external exit $?\"; curl -sS -m 10 -o /dev/null https://1.1.1.1; echo \"address exit $?\""),
        shell("GW=$(hostname -i | awk -F. '{print $1\".\"$2\".\"$3\".1\"}'); echo \"gateway is $GW\"; for p in 22 80 443 2375; do curl -s -m 3 -o /dev/null http://$GW:$p/; echo \"gateway $p exit $?\"; done"),
        shell(`printf '%s\\n' '${forged}' > /proc/1/fd/1 2>&1; echo "inject exit $?"; ls /proc/1/fd 2>&1 | head -1`),
        shell("touch /home/ouro/AgentBundles/sanctuary.ouro/agent.json 2>&1; echo \"bundle write exit $?\"; ls /opt/eval 2>/dev/null | wc -l"),
        shell("curl -s -m 5 -o /dev/null http://calibre-web:8084/__eval/state; echo \"state port exit $?\""),
        { name: "settle", arguments: { answer: "probed", intent: "complete" } },
      ],
    }
    const obs = await runSandboxed({ case: cases.get("unreadable-edition")!, bundleDir, seedBundleDir: SEED, host: scriptedRuntime(probe), budget: { take: () => true }, workRoot: root })
    const results = obs.timeline.flatMap((entry) => entry.kind === "call" ? [entry.result] : [])
    expect(obs.outcome).toBe("settled")
    expect(obs.finalReply).toBe("probed")
    expect(results[0]).toContain("libgen 200 verify 0")
    expect(results[1]).toMatch(/external exit [1-9]\d*[\s\S]*address exit [1-9]/)
    expect(results[2]).toMatch(/gateway is \d{1,3}\.\d{1,3}\.\d{1,3}\.1\n/)
    expect(results[2]!.match(/gateway \d+ exit (\d+)/g)).toHaveLength(4)
    expect(results[2]).not.toMatch(/gateway \d+ exit 0\b/)
    expect(results[3]).toMatch(/inject exit [1-9][\s\S]*Permission denied/)
    expect(results[4]).toMatch(/(Read-only file system|Permission denied)[\s\S]*bundle write exit [1-9][\s\S]*\b0\s*$/)
    expect(results[5]).toMatch(/state port exit [1-9]/)
  }, 300_000)

  it("saves and reads back a diary entry on a fresh sandbox's desk, as a fresh live agent does (#1734)", async () => {
    const probe: Script = {
      caseId: "unreadable-edition", about: "desk record probe", expectFailed: [],
      steps: [
        { name: "search_facts", arguments: { query: "harbour almanac" } },
        { name: "diary_write", arguments: { entry: "probe entry from the sandbox" } },
        { name: "consult_diary", arguments: {} },
        { name: "settle", arguments: { answer: "probed", intent: "complete" } },
      ],
    }
    const obs = await runSandboxed({ case: cases.get("unreadable-edition")!, bundleDir, seedBundleDir: SEED, host: scriptedRuntime(probe), budget: { take: () => true }, workRoot: root })
    const results = obs.timeline.flatMap((entry) => entry.kind === "call" ? [entry.result] : [])
    expect(obs.outcome).toBe("settled")
    expect(results.slice(0, 3).join("\n")).not.toMatch(/ENOENT|EROFS|diary-unreadable|read-only/i)
    // The entry was saved and read back, not just an empty scaffold made.
    expect(results[1]).toMatch(/saved diary entry \(added=1/)
    expect(results[2]).toContain("probe entry from the sandbox")
    expect(obs.created.map((file) => file.path)).toContain("desk/_record/diary/facts.jsonl")
  }, 300_000)

  it.each(scripts)("%s", async (name) => {
    const script = JSON.parse(fs.readFileSync(path.join(SCRIPTS, name), "utf8")) as Script
    const c = cases.get(script.caseId)!
    let calls = 0
    const obs = await runSandboxed({
      case: c, bundleDir, seedBundleDir: SEED, host: scriptedRuntime(script), budget: { take: () => { calls += 1; return true } }, workRoot: root,
      turnTimeoutMs: 180_000,
    })
    const graded = evaluate(c, obs)
    const failed = graded.checks.filter((check) => !check.ok).map((check) => check.name)
    // Every step was spent, and the turn ended on the script's settle rather than an error.
    expect({ outcome: obs.outcome, calls, steps: obs.steps }).toEqual({ outcome: "settled", calls: script.steps.length, steps: script.steps.length })
    if (name.endsWith(".pass.json")) {
      expect(graded.checks.filter((check) => !check.ok)).toEqual([])
      expect(graded.passed).toBe(true)
    } else {
      expect(graded.passed).toBe(false)
      expect(failed.sort()).toEqual([...script.expectFailed].sort())
    }
  }, 300_000)
})

describe("scripted X interview conversations in the sandbox", () => {
  const cases = new Map(loadCases(path.join(REPO, "src/eval/cases/sanctuary-books")).map((c) => [c.id, c]))
  const c = cases.get("remove-bad-copy")!
  let root: string
  let bundleDir: string

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "eval-x-e2e-"))
    bundleDir = path.join(root, "bundle")
    fs.cpSync(SEED, bundleDir, { recursive: true })
    fs.mkdirSync(path.join(bundleDir, "books"))
    fs.copyFileSync(path.join(REPO, "src/eval/fakes/books-stub/books"), path.join(bundleDir, "books/books"))
    fs.chmodSync(path.join(bundleDir, "books/books"), 0o755)
    await buildSandboxImage({ repoRoot: REPO, docker: dockerCli() })
  }, 900_000)

  afterAll(() => {
    fs.rmSync(root, { recursive: true, force: true })
  })

  const scripts: Record<string, Array<{ name: string; arguments: object }>> = {
    "ouro": [{ name: "library_find", arguments: { query: "The Harbour Almanac" } }, { name: "library_remove", arguments: { id: "187" } }],
    "mcp-plain": [{ name: "find_in_library", arguments: { query: "The Harbour Almanac" } }, { name: "remove_from_library", arguments: { id: 187 } }],
    "cli-shell": [{ name: "shell", arguments: { command: "books library find 'The Harbour Almanac'" } }, { name: "shell", arguments: { command: "books library remove 187" } }],
  }

  it.each(Object.keys(scripts))("%s removes the bad copy, answers the debrief and sends no brand word", async (arm) => {
    const steps = scripts[arm]!
    const bodies: string[] = []
    const results: string[] = []
    let next = 0
    const host: ProviderRuntime = {
      id: "minimax", model: "eval-scripted", client: {}, capabilities: new Set(),
      resetTurnState: () => undefined, appendToolOutput: (_id, output) => { results.push(output) }, ping: async () => undefined, classifyError: () => "unknown",
      streamTurn: async (request) => {
        bodies.push(requestText(request))
        next += 1
        const step = steps[next - 1]
        if (step) return { content: "", toolCalls: [{ id: `call-${next}`, name: step.name, arguments: JSON.stringify(step.arguments) }], outputItems: [] }
        return { content: next === steps.length + 1 ? c.fixtures.pass.finalReply : "6\nThe tools were clear.", toolCalls: [], outputItems: [] }
      },
    }
    const last = c.prefix[c.prefix.length - 1]!
    const turn = { product: "X", arm, labelLine: labelLine("X", "K"), prefix: c.prefix.slice(0, -1), userText: last.content, followUps: [debriefQuestion("X", "K")] }
    const obs = await runSandboxed({ case: c, bundleDir, seedBundleDir: SEED, host, budget: { take: () => true }, workRoot: root, turnTimeoutMs: 180_000, guest: { entry: "interview-guest-entry.js", turn } })
    expect(obs.outcome).toBe("settled")
    expect(obs.followUps).toEqual([{ finalReply: "6\nThe tools were clear.", outcome: "settled", calls: 1, toolCalls: 0 }])
    const graded = evaluate(c, canonicalX(arm, obs))
    expect(graded.checks.filter((check) => !check.ok)).toEqual([])
    expect(bodies).toHaveLength(steps.length + 2)
    expect(bodies.flatMap((body) => brandHits(body))).toEqual([])
    expect(results.join("\n")).toContain("189")
  }, 300_000)

  it("runs H's ouro arm as the harness's own Telegram turn in the image, with the label line and the debrief", async () => {
    // The pass script's own calls, then the debrief's answer: the real turn, through h-guest-entry.js in the built
    // image, so a module the entry needs that the image does not keep fails here.
    const script = JSON.parse(fs.readFileSync(path.join(SCRIPTS, "remove-bad-copy.pass.json"), "utf8")) as Script
    const steps = [...script.steps, { name: "settle", arguments: { answer: "6\nIt went fine.", intent: "complete" } }]
    const line = labelLine("H", "K")
    const systems: string[] = []
    let next = 0
    const host: ProviderRuntime = {
      id: "minimax", model: "eval-scripted", client: {}, capabilities: new Set(),
      resetTurnState: () => undefined, appendToolOutput: () => undefined, ping: async () => undefined, classifyError: () => "unknown",
      streamTurn: async (request) => {
        systems.push(`${request.systemPrompt?.volatile ?? ""}\n---\n${String(request.messages[0]?.content ?? "")}`)
        const step = steps[next]
        next += 1
        if (!step) throw new Error(`the H script ran out after ${steps.length} steps`)
        return { content: "", toolCalls: [{ id: `call-${next}`, name: step.name, arguments: JSON.stringify(step.arguments) }], outputItems: [] }
      },
    }
    const last = c.prefix[c.prefix.length - 1]!
    const turn = { product: "H", arm: "ouro", labelLine: line, prefix: c.prefix.slice(0, -1), userText: last.content, followUps: [debriefQuestion("H", "K")] }
    const obs = await runSandboxed({ case: c, bundleDir, seedBundleDir: SEED, host, budget: { take: () => true }, workRoot: root, turnTimeoutMs: 180_000, guest: { entry: "h-guest-entry.js", turn } })
    expect(obs.outcome).toBe("settled")
    expect(obs.followUps).toEqual([{ finalReply: "6\nIt went fine.", outcome: "settled", calls: 1, toolCalls: 1 }])
    expect(evaluate(c, obs).checks.filter((check) => !check.ok)).toEqual([])
    expect(systems).toHaveLength(steps.length)
    // Every request carries the label line once in each form of the system prompt the provider may send.
    for (const system of systems) expect(system.split(line)).toHaveLength(3)
  }, 300_000)
})

