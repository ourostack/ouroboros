import { describe, expect, it } from "vitest"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { runVoiceRealtimeEvalCommand } from "../../senses/voice-realtime-eval-command"

const fixtureDir = path.resolve(__dirname, "../fixtures/voice-realtime-traces")

function fixturePath(name: string): string {
  return path.join(fixtureDir, name)
}

function writeTraceCopy(name: string, patch: Record<string, unknown>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "voice-eval-command-"))
  const source = JSON.parse(fs.readFileSync(fixturePath(name), "utf8")) as Record<string, unknown>
  const target = path.join(dir, name)
  fs.writeFileSync(target, JSON.stringify({ ...source, ...patch }, null, 2))
  return target
}

describe("voice realtime eval command", () => {
  it("preserves built-in suite behavior with no trace arguments", () => {
    const result = runVoiceRealtimeEvalCommand([])

    expect(result.exitCode).toBe(0)
    expect(result.payload).toMatchObject({
      summary: {
        passed: 1,
        failed: 1,
        total: 2,
        failedScenarioIds: ["voice-known-bad-latency"],
      },
      expectedKnownBadFailed: true,
      happyPathPassed: true,
    })
    expect(result.payload.traces).toBeUndefined()
  })

  it("grades repeated trace artifacts and treats expected-fail traces as canaries", () => {
    const result = runVoiceRealtimeEvalCommand([
      "--trace",
      fixturePath("clean-call.json"),
      "--trace",
      fixturePath("delayed-audio-transcript-mismatch.json"),
      "--trace",
      fixturePath("duplicate-late-provider-event.json"),
    ])

    expect(result.exitCode).toBe(0)
    expect(result.payload.traceSummary).toEqual({
      matched: 3,
      mismatched: 0,
      total: 3,
      mismatchedScenarioIds: [],
    })
    expect(result.payload.traces?.map((trace) => ({
      scenarioId: trace.scenarioId,
      expectedOutcome: trace.expectedOutcome,
      outcomeMatched: trace.outcomeMatched,
      passed: trace.report.passed,
    }))).toEqual([
      { scenarioId: "clean-call", expectedOutcome: "pass", outcomeMatched: true, passed: true },
      { scenarioId: "delayed-audio-transcript-mismatch", expectedOutcome: "expected-fail", outcomeMatched: true, passed: false },
      { scenarioId: "duplicate-late-provider-event", expectedOutcome: "pass", outcomeMatched: true, passed: true },
    ])
    expect(result.payload.traces?.[2]?.ignoredEvents.map((event) => event.event)).toEqual([
      "openai.realtime.output_audio.delta",
      "openai.realtime.rate_limits.updated",
      "openai.realtime.response.done",
    ])
  })

  it("exits nonzero when a trace unexpectedly fails or unexpectedly passes", () => {
    const unexpectedFailPath = writeTraceCopy("delayed-audio-transcript-mismatch.json", {
      traceId: "unexpected-fail",
      scenarioId: "unexpected-fail",
      expectedOutcome: "pass",
    })
    const unexpectedPassPath = writeTraceCopy("clean-call.json", {
      traceId: "unexpected-pass",
      scenarioId: "unexpected-pass",
      expectedOutcome: "expected-fail",
    })

    const result = runVoiceRealtimeEvalCommand(["--trace", unexpectedFailPath, "--trace", unexpectedPassPath])

    expect(result.exitCode).toBe(1)
    expect(result.payload.traceSummary).toEqual({
      matched: 0,
      mismatched: 2,
      total: 2,
      mismatchedScenarioIds: ["unexpected-fail", "unexpected-pass"],
    })
  })

  it("returns actionable JSON-shaped errors for invalid arguments and bad files", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "voice-eval-command-bad-"))
    const badJsonPath = path.join(dir, "bad.json")
    const badArtifactPath = path.join(dir, "bad-artifact.json")
    fs.writeFileSync(badJsonPath, "{")
    fs.writeFileSync(badArtifactPath, "{}")

    expect(runVoiceRealtimeEvalCommand(["--bogus"])).toMatchObject({
      exitCode: 1,
      payload: { error: "unknown argument: --bogus" },
    })
    expect(runVoiceRealtimeEvalCommand(["--trace"])).toMatchObject({
      exitCode: 1,
      payload: { error: "--trace requires a file path" },
    })
    expect(runVoiceRealtimeEvalCommand(["--trace", path.join(dir, "missing.json")])).toMatchObject({
      exitCode: 1,
      payload: { error: expect.stringContaining("failed to read trace artifact") },
    })
    expect(runVoiceRealtimeEvalCommand(["--trace", badJsonPath])).toMatchObject({
      exitCode: 1,
      payload: { error: expect.stringContaining("invalid JSON") },
    })
    expect(runVoiceRealtimeEvalCommand(["--trace", badArtifactPath])).toMatchObject({
      exitCode: 1,
      payload: { error: expect.stringContaining("schemaVersion must be 1") },
    })
  })
})
