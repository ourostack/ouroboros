import { describe, expect, it, vi } from "vitest"
import * as path from "node:path"

const {
  runSanctuaryHealthAcceptanceProbeEntrySmoke,
} = require(path.resolve(__dirname, "../../../scripts/sanctuary-health-acceptance-probe-entry-smoke.cjs"))

describe("compiled Sanctuary health acceptance probe entry smoke", () => {
  it("executes the packaged entry and accepts only its canonical invalid-args result", () => {
    const spawnSync = vi.fn(() => ({
      status: 1,
      signal: null,
      error: undefined,
      stdout: "",
      stderr: "usage: sanctuary-health-acceptance-probe <run|stop|recover|finalize> --label <label> --scenario <digest> --owner-image <digest> --owner-container <digest> [--owner-image-after <digest> --owner-container-after <digest>]\n",
    }))
    const writeStderr = vi.fn()

    expect(runSanctuaryHealthAcceptanceProbeEntrySmoke("/repo", {
      execPath: "/node",
      join: path.join,
      spawnSync,
      writeStderr,
    })).toBe(0)
    expect(spawnSync).toHaveBeenCalledWith(
      "/node",
      ["/repo/dist/senses/sanctuary-health-acceptance-probe-entry.js"],
      { cwd: "/repo", encoding: "utf8" },
    )
    expect(writeStderr).not.toHaveBeenCalled()
  })

  it.each([
    { result: { status: 0, stdout: "", stderr: "" }, reason: "expected exit code 1" },
    { result: { status: 1, stdout: "", stderr: "wrong" }, reason: "canonical usage" },
    { result: { status: 1, stdout: "", stderr: "usage: sanctuary-health-acceptance-probe <run|stop|recover|finalize> --label <label>\ntrailing nerves output\n" }, reason: "canonical usage" },
    { result: { status: null, signal: "SIGTERM", stdout: "", stderr: "" }, reason: "SIGTERM" },
    { result: { status: null, error: new Error("spawn failed"), stdout: "", stderr: "" }, reason: "spawn failed" },
  ])("fails closed when the packaged entry result is not canonical %#", ({ result, reason }) => {
    const writeStderr = vi.fn()
    const status = runSanctuaryHealthAcceptanceProbeEntrySmoke("/repo", {
      execPath: "/node",
      join: path.join,
      spawnSync: vi.fn(() => result),
      writeStderr,
    })

    expect(status).toBe(1)
    expect(writeStderr).toHaveBeenCalledWith(expect.stringContaining(reason))
  })
})
