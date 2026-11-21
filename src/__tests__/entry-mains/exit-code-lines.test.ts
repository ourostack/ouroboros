// The short `node dist/...` mains turn their runner's exit number into the `code: <code>` line their card names, then
// set process.exitCode (not process.exit, which can drop the line on a macOS pipe).
import { afterEach, describe, expect, it, vi } from "vitest"

const runners = vi.hoisted(() => ({
  playback: vi.fn(), stats: vi.fn(), audit: vi.fn(), review: vi.fn(), voice: vi.fn(),
}))
vi.mock("../../heart/session-playback-cli", () => ({ runSessionPlaybackCli: runners.playback }))
vi.mock("../../heart/session-stats", () => ({ runSessionStatsCli: runners.stats }))
vi.mock("../../nerves/coverage/cli", () => ({ runAuditCli: runners.audit }))
vi.mock("../../nerves/review/cli", () => ({ runNervesReviewCli: runners.review }))
vi.mock("../../senses/voice-realtime-eval-command", () => ({ runVoiceRealtimeEvalCommand: runners.voice }))

const previous = process.exitCode
afterEach(() => { process.exitCode = previous; vi.resetModules(); vi.restoreAllMocks() })

async function run(module: string): Promise<{ stderr: string[]; exitCode: typeof process.exitCode }> {
  const stderr: string[] = []
  vi.spyOn(process.stderr, "write").mockImplementation(((chunk: string) => { stderr.push(String(chunk)); return true }) as typeof process.stderr.write)
  vi.spyOn(console, "log").mockImplementation(() => {})
  const exit = vi.spyOn(process, "exit").mockImplementation((() => { throw new Error("process.exit called") }) as typeof process.exit)
  process.exitCode = undefined
  await import(module)
  expect(exit).not.toHaveBeenCalled()
  return { stderr, exitCode: process.exitCode }
}

describe("short entry mains", () => {
  it.each([
    ["../../heart/session-playback-cli-main", runners.playback, [[0, []], [1, []], [2, ["code: usage\n"]]]],
    ["../../heart/session-stats-cli-main", runners.stats, [[0, []], [1, []], [2, ["code: usage\n"]]]],
    ["../../nerves/coverage/cli-main", runners.audit, [[0, []], [1, ["code: audit-failed\n"]], [2, ["code: no-run-dir\n"]]]],
    ["../../nerves/review/cli-main", runners.review, [[0, []], [1, []], [2, ["code: bad-duration\n"]]]],
  ] as const)("%s maps each exit number to its card's code", async (module, runner, table) => {
    for (const [code, lines] of table) {
      runner.mockReturnValue(code)
      vi.resetModules()
      expect(await run(module)).toEqual({ stderr: lines, exitCode: code })
    }
  })

  it("the voice eval names a run that couldn't start apart from one that didn't match", async () => {
    const module = "../../senses/voice-realtime-eval-entry"
    for (const [result, lines] of [
      [{ exitCode: 0, payload: {} }, []],
      [{ exitCode: 1, payload: { summary: { failed: 1 } } }, ["code: eval-failed\n"]],
      [{ exitCode: 1, payload: { error: "unknown argument: --x" } }, ["code: eval-error\n"]],
    ] as const) {
      runners.voice.mockReturnValue(result)
      vi.resetModules()
      expect(await run(module)).toEqual({ stderr: lines, exitCode: result.exitCode === 0 ? undefined : result.exitCode })
    }
  })
})
