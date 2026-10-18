import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { describe, expect, it, vi } from "vitest"
import { runShepherdJudgeEvaluationCommand } from "../../../senses/shepherd/judge-evaluation-command"
import corpus from "../../../senses/shepherd/shepherd-judge-corpus-v1.json"
import { validateShepherdJudgeCorpus } from "../../../senses/shepherd/judge-evaluation"
import type { ReturnPacket } from "../../../senses/shepherd/judge"

const provenance = { provider: "fixture", model: "fixture-model", runtimeVersion: "fixture",
  judgeSha256: "a".repeat(64), evaluatorSha256: "b".repeat(64) }
function setup() {
  const reports: unknown[] = [], output: string[] = []
  const close = vi.fn()
  const write = vi.fn((report: unknown) => { reports.push(report) })
  const loadJudge = vi.fn(async () => ({ provenance, judge: async (packet: ReturnPacket) => {
    const kind = validateShepherdJudgeCorpus(corpus).cases.find(item => item.screen === packet.screen)!.expectedKind
    return { kind, reply: kind === "premature" ? { text: "Continue the existing authorized task." } : null,
      reason: "Synthetic command test.", latencyMs: 1, inputTokens: 1 }
  } }))
  return { reports, output, close, write, loadJudge, dependencies: {
    loadJudge, openOutput: vi.fn(() => ({ write, close })), print: (message: string) => { output.push(message) },
  } }
}
describe("explicit Shepherd judge evaluation command", () => {
  it("requires explicit agent/output and rejects unknown, repeated, or missing arguments before calls or writes", async () => {
    for (const args of [[], ["--agent", "a"], ["--output", "/tmp/report"], ["--agent"], ["--agent", "a", "--output"],
      ["--agent", "a", "--output", "/tmp/report", "--unsafe"], ["--agent", "a", "--agent", "b", "--output", "/tmp/report"],
      ["--agent", "../other", "--output", "/tmp/report"], ["--agent", "a", "--output", ""]]) {
      const fixture = setup()
      const result = await runShepherdJudgeEvaluationCommand(args, fixture.dependencies)
      expect(result).toBe(1)
      expect(fixture.loadJudge).not.toHaveBeenCalled()
      expect(fixture.dependencies.openOutput).not.toHaveBeenCalled()
      expect(fixture.output.join(" ")).toContain("error")
    }
  })

  it("writes a complete qualified-only-for-classification report, not v1, and closes the output", async () => {
    const fixture = setup()
    expect(await runShepherdJudgeEvaluationCommand(["--agent", "synthetic", "--output", "/tmp/unused"], fixture.dependencies)).toBe(0)
    expect(fixture.loadJudge).toHaveBeenCalledWith("synthetic")
    expect(fixture.reports.at(-1)).toMatchObject({ phase: "judge-classification-only", classificationPassed: true, v1Qualified: false })
    expect(fixture.close).toHaveBeenCalledTimes(1)
    expect(fixture.output.join(" ")).toContain("not v1 qualification")
  })

  it("returns nonzero for a measured threshold failure but still preserves its evidence", async () => {
    const fixture = setup()
    fixture.loadJudge.mockResolvedValue({ provenance, judge: async () => ({ kind: "unclear", reply: null,
      reason: "Not a continuation.", latencyMs: 1, inputTokens: 1 }) })
    expect(await runShepherdJudgeEvaluationCommand(["--agent", "synthetic", "--output", "/tmp/unused"], fixture.dependencies)).toBe(1)
    expect(fixture.reports.at(-1)).toMatchObject({ classificationPassed: false, v1Qualified: false })
  })

  it("reserves the output before model calls and reports output/credential failures without false success", async () => {
    const fixture = setup()
    fixture.dependencies.openOutput.mockImplementation(() => { throw new Error("Output already exists") })
    expect(await runShepherdJudgeEvaluationCommand(["--agent", "synthetic", "--output", "/tmp/unused"], fixture.dependencies)).toBe(1)
    expect(fixture.loadJudge).not.toHaveBeenCalled()
    expect(fixture.close).not.toHaveBeenCalled()
    const failed = setup()
    failed.loadJudge.mockRejectedValue(new Error("No provider credentials"))
    expect(await runShepherdJudgeEvaluationCommand(["--agent", "synthetic", "--output", "/tmp/unused"], failed.dependencies)).toBe(1)
    expect(failed.reports.at(-1)).toMatchObject({ state: "error", v1Qualified: false })
    expect(failed.close).toHaveBeenCalledOnce()
  })

  it("reports failure to persist an error, and always closes the reserved output", async () => {
    const fixture = setup()
    fixture.write.mockImplementation(() => { throw new Error("Disk full") })
    expect(await runShepherdJudgeEvaluationCommand(["--agent", "synthetic", "--output", "/tmp/unused"], fixture.dependencies)).toBe(1)
    expect(fixture.output.join(" ")).toContain("Could not persist")
    expect(fixture.close).toHaveBeenCalledOnce()
  })

  it("reports output-close failure explicitly and returns nonzero instead of rejecting after a successful measurement", async () => {
    const fixture = setup()
    fixture.close.mockImplementation(() => { throw new Error("Synthetic close failure") })
    await expect(runShepherdJudgeEvaluationCommand(["--agent", "synthetic", "--output", "/tmp/unused"], fixture.dependencies)).resolves.toBe(1)
    expect(fixture.output.join(" ")).toContain("Could not close")
    expect(fixture.output.join(" ")).not.toContain('"classificationPassed":true')
  })

  it("uses exclusive 0600 output creation in the real default writer and does not overwrite an existing file", async () => {
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), "shepherd-evaluation-command-"))
    const file = path.join(folder, "report.json")
    const fixture = setup()
    const { openShepherdJudgeEvaluationOutput } = await import("../../../senses/shepherd/judge-evaluation-command")
    expect(await runShepherdJudgeEvaluationCommand(["--agent", "synthetic", "--output", file],
      { ...fixture.dependencies, openOutput: openShepherdJudgeEvaluationOutput })).toBe(0)
    expect(fs.statSync(file).mode & 0o777).toBe(0o600)
    const before = fs.readFileSync(file, "utf8")
    expect(JSON.parse(before).v1Qualified).toBe(false)
    expect(await runShepherdJudgeEvaluationCommand(["--agent", "synthetic", "--output", file],
      { ...fixture.dependencies, openOutput: openShepherdJudgeEvaluationOutput })).toBe(1)
    expect(fs.readFileSync(file, "utf8")).toBe(before)
  })
})
