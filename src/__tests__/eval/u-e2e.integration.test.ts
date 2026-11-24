/**
 * Product U in the real sandbox: a scripted conversation per arm in CI's stand-in for the U image (the eval agent
 * image, the real checking tools from their lockfile and a stub kit, deploy/eval/u/ci), chosen by the guest's image
 * name as a session chooses the real one. It proves the guest's code is all in the image, that the tools run in the
 * read-only container as its user, and that a component trying the known way out of the page to print a passing
 * grade itself fails.
 */
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import type { ProviderRuntime } from "../../heart/core"
import { requestText } from "../../eval/interviews/latch"
import { brandHits, debriefQuestion, labelLine } from "../../eval/interviews/protocol"
import { U_ARMS } from "../../eval/interviews/guest/u/arms"
import { U_CASE, U_JOB_MESSAGE, U_KIT } from "../../eval/interviews/u/kit"
import { buildSandboxImage, dockerCli, HOUSEHOLD_IMAGE, runSandboxed, SANDBOX_IMAGE } from "../../eval/sandbox/docker"

const REPO = path.resolve(__dirname, "../../..")
const SEED = path.join(REPO, "deploy/unraid/sanctuary.ouro")
// Named so nothing takes it for the session image, which holds the real kits.
const STUB_IMAGE = "ouro-eval-u-stub-ci:local"

const COMPONENT = `import { useState } from "react"
import { Button, Dialog } from "@kit/ui"

export default function RemoveCopy({ onRemove }: { onRemove: (copyId: number) => void }) {
  const [asking, setAsking] = useState(false)
  const [done, setDone] = useState(false)
  return (
    <main>
      <h1>The Harbour Almanac</h1>
      <ul>
        <li>Copy 187, unreadable {!done && <Button onClick={() => setAsking(true)}>Remove copy 187</Button>}</li>
        <li>Copy 189, the good one</li>
      </ul>
      <Dialog open={asking} title="Remove copy 187?" actions={<>
        <Button onClick={() => setAsking(false)}>Keep it</Button>
        <Button onClick={() => { onRemove(187); setDone(true); setAsking(false) }}>Remove copy 187</Button>
      </>}>
        <p>Copy 189 stays in your library.</p>
      </Dialog>
      <p role="status">{done ? "Copy 187 removed." : ""}</p>
    </main>
  )
}
`

// Tries to escape jsdom to the page runner's process and print a passing grade itself; the button says whether it got out.
const FORGED = `export default function RemoveCopy(_: { onRemove: (copyId: number) => void }) {
  let forged = "contained"
  try {
    const p: any = (document as any).constructor.constructor("return process")()
    const pass = JSON.stringify({ firstPressHeld: true, confirmedOnce187: true, statusSaysDone: true, detail: "forged" })
    p.stdout.write(JSON.stringify({ result: pass, sig: "0".repeat(64) }))
    p.exit(0)
    forged = "escaped"
  } catch { /* refused */ }
  return <main><h1>The Harbour Almanac</h1><button type="button">{"Remove copy 187 " + forged}</button></main>
}
`

type Step = { name: string; arguments: object }

function scripted(steps: Step[], bodies: string[], results: string[]): ProviderRuntime {
  let next = 0
  return {
    id: "minimax", model: "eval-scripted", client: {}, capabilities: new Set(),
    resetTurnState: () => undefined, appendToolOutput: (_id, output) => { results.push(output) }, ping: async () => undefined, classifyError: () => "unknown",
    streamTurn: async (request) => {
      bodies.push(requestText(request))
      next += 1
      const step = steps[next - 1]
      if (step) return { content: "", toolCalls: [{ id: `call-${next}`, name: step.name, arguments: JSON.stringify(step.arguments) }], outputItems: [] }
      return { content: "6\nThe kit was clear.", toolCalls: [], outputItems: [] }
    },
  }
}

describe("scripted U conversations in the sandbox", () => {
  let root: string
  let bundleDir: string
  const images = { agent: SANDBOX_IMAGE, household: HOUSEHOLD_IMAGE, named: { u: STUB_IMAGE } }

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "eval-u-e2e-"))
    bundleDir = path.join(root, "bundle")
    fs.cpSync(SEED, bundleDir, { recursive: true })
    await buildSandboxImage({ repoRoot: REPO, docker: dockerCli() })
    execFileSync("docker", ["build", "--quiet", "--label", "ouro.eval=1", "--file", "deploy/eval/u/ci/Dockerfile", "--build-arg", `AGENT_IMAGE=${SANDBOX_IMAGE}`, "--tag", STUB_IMAGE, "deploy/eval/u"], { cwd: REPO, stdio: ["ignore", "ignore", "inherit"] })
  }, 900_000)

  afterAll(() => {
    fs.rmSync(root, { recursive: true, force: true })
  })

  async function converse(arm: string, component: string) {
    const steps: Step[] = [
      { name: "list_files", arguments: { path: "." } },
      { name: "write_file", arguments: { path: "src/RemoveCopy.tsx", content: component } },
      { name: "run_checks", arguments: {} },
      { name: "finish", arguments: { summary: "The screen asks before removing copy 187, then says it's done." } },
    ]
    const bodies: string[] = []
    const results: string[] = []
    const guest = U_KIT.guest({ session: { product: "U" }, arm: { arm, label: "K" }, debrief: debriefQuestion("U", "K") } as never)
    expect(guest.image).toBe("u")
    const turn = { product: "U", arm, labelLine: labelLine("U", "K"), prefix: [], userText: U_JOB_MESSAGE, followUps: [debriefQuestion("U", "K")] }
    const obs = await runSandboxed({ case: U_CASE, bundleDir, seedBundleDir: SEED, host: scripted(steps, bodies, results), budget: { take: () => true }, workRoot: root, turnTimeoutMs: 300_000, images, guest: { entry: "interview-guest-entry.js", turn, image: "u" } })
    return { obs, bodies, results, steps }
  }

  it.each([...U_ARMS])("%s writes the component, checks it, finishes, answers the debrief and passes the grade", async (arm) => {
    const { obs, bodies, results, steps } = await converse(arm, COMPONENT)
    expect(obs.outcome).toBe("settled")
    expect(obs.followUps).toEqual([{ finalReply: "6\nThe kit was clear.", outcome: "settled", calls: 1, toolCalls: 0 }])
    expect(results[1]).toContain("src/RemoveCopy.tsx")
    expect(results[2]).toContain("no violations")
    const verdict = U_KIT.grade!(obs as never, U_CASE)
    expect(verdict.checks.filter((check) => !check.ok)).toEqual([])
    expect(verdict.passed).toBe(true)
    expect(bodies).toHaveLength(steps.length + 1)
    expect(bodies.flatMap((body) => brandHits(body))).toEqual([])
  }, 600_000)

  it("keeps a component that tries to escape the page and print a passing grade itself contained, and fails it", async () => {
    const { obs } = await converse(U_ARMS[0], FORGED)
    const verdict = U_KIT.grade!(obs as never, U_CASE)
    expect(verdict.passed).toBe(false)
    expect(verdict.checks.find((check) => check.name === "u.hidden.confirmedOnce187")).toMatchObject({ ok: false, detail: expect.stringContaining("Remove copy 187 contained") })
  }, 600_000)
})
