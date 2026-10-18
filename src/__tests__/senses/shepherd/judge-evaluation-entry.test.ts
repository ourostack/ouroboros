import { afterEach, expect, it, vi } from "vitest"
const run = vi.hoisted(() => vi.fn())
vi.mock("../../../senses/shepherd/judge-evaluation-command", () => ({ runShepherdJudgeEvaluationCommand: run }))
const previous = process.exitCode
afterEach(() => { process.exitCode = previous; vi.resetModules(); vi.restoreAllMocks() })
it.each([0, 1])("forwards explicit CLI arguments and the measured command exit status %d", async code => {
  process.exitCode = undefined
  run.mockResolvedValue(code)
  const argv = vi.spyOn(process, "argv", "get").mockReturnValue(["node", "entry", "--agent", "synthetic", "--output", "/tmp/unused"])
  await import("../../../senses/shepherd/judge-evaluation-entry")
  await vi.waitFor(() => expect(process.exitCode).toBe(code))
  expect(run).toHaveBeenLastCalledWith(["--agent", "synthetic", "--output", "/tmp/unused"])
  argv.mockRestore()
})
it("reports an unexpected rejection without exposing credentials or a success status", async () => {
  process.exitCode = undefined
  const error = vi.spyOn(console, "error").mockImplementation(() => {})
  run.mockRejectedValue(new Error("Bearer sk-synthetic-secret-value-1234567890"))
  await import("../../../senses/shepherd/judge-evaluation-entry")
  await vi.waitFor(() => expect(process.exitCode).toBe(1))
  expect(error).toHaveBeenCalledWith(expect.stringContaining('"v1Qualified":false'))
  expect(error.mock.calls.flat().join(" ")).not.toContain("sk-synthetic-secret-value-1234567890")
})
