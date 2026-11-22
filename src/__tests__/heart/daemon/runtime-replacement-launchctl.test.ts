import { describe, expect, it, vi } from "vitest"

import { readDaemonJobPidFailSafe } from "../../../heart/daemon/cli-defaults"

describe("readDaemonJobPidFailSafe", () => {
  it("asks launchctl for the daemon's job and returns its running pid", () => {
    const run = vi.fn(() => "gui/501/bot.ouro.daemon = {\n\tpid = 90084\n}")
    expect(readDaemonJobPidFailSafe(run)).toBe(90084)
    expect(run).toHaveBeenCalledWith("launchctl", ["print", expect.stringMatching(/^gui\/\d+\/bot\.ouro\.daemon$/)])
  })

  it("returns null when the label isn't loaded (launchctl exit 113)", () => {
    const run = vi.fn(() => { throw Object.assign(new Error("Could not find service"), { status: 113 }) })
    expect(readDaemonJobPidFailSafe(run)).toBeNull()
  })

  it("throws on any other failure, so the caller fails safe to a hand-off", () => {
    const timeout = vi.fn(() => { throw Object.assign(new Error("spawnSync launchctl ETIMEDOUT"), { code: "ETIMEDOUT" }) })
    expect(() => readDaemonJobPidFailSafe(timeout)).toThrow("ETIMEDOUT")
    const otherExit = vi.fn(() => { throw Object.assign(new Error("launchctl failed"), { status: 1 }) })
    expect(() => readDaemonJobPidFailSafe(otherExit)).toThrow("launchctl failed")
  })
})
