import { afterEach, describe, expect, it, vi } from "vitest"

describe("nerves/coverage cli-main", () => {
  afterEach(() => {
    vi.resetModules()
    vi.restoreAllMocks()
  })

  it("invokes runAuditCli with argv args and sets the returned exit code", async () => {
    const runAuditCli = vi.fn(() => 7)
    vi.doMock("../../nerves/coverage/cli", () => ({
      runAuditCli,
    }))

    const originalArgv = process.argv
    process.argv = ["node", "cli-main", "--run-dir", "/tmp/run"]

    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation((() => undefined) as never)

    const previousExitCode = process.exitCode
    await import("../../nerves/coverage/cli-main")

    expect(runAuditCli).toHaveBeenCalledWith(["--run-dir", "/tmp/run"])
    expect(exitSpy).not.toHaveBeenCalled()
    expect(process.exitCode).toBe(7)

    process.exitCode = previousExitCode
    process.argv = originalArgv
  })
})
