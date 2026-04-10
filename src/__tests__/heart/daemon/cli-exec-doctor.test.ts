import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("../../../nerves/runtime", () => ({
  emitNervesEvent: vi.fn(),
}))

vi.mock("../../../heart/daemon/doctor", () => ({
  runDoctorChecks: vi.fn(),
}))

vi.mock("../../../heart/daemon/cli-render-doctor", () => ({
  formatDoctorOutput: vi.fn(),
}))

import { emitNervesEvent } from "../../../nerves/runtime"
import { runDoctorChecks } from "../../../heart/daemon/doctor"
import { formatDoctorOutput } from "../../../heart/daemon/cli-render-doctor"
import { runOuroCli, type OuroCliDeps } from "../../../heart/daemon/daemon-cli"
import type { DoctorResult } from "../../../heart/daemon/doctor-types"

function createMinimalDeps(overrides: Partial<OuroCliDeps> = {}): OuroCliDeps {
  return {
    socketPath: "/tmp/test.sock",
    sendCommand: vi.fn().mockResolvedValue({ ok: true, message: "ok" }),
    startDaemonProcess: vi.fn().mockResolvedValue({ pid: 1234 }),
    writeStdout: vi.fn(),
    checkSocketAlive: vi.fn().mockResolvedValue(false),
    cleanupStaleSocket: vi.fn(),
    fallbackPendingMessage: vi.fn().mockReturnValue("/tmp/pending"),
    ...overrides,
  }
}

const MOCK_RESULT: DoctorResult = {
  categories: [{ name: "Test", checks: [{ label: "ok", status: "pass" }] }],
  summary: { passed: 1, warnings: 0, failed: 0 },
}

describe("ouro doctor CLI execution", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(runDoctorChecks).mockResolvedValue(MOCK_RESULT)
    vi.mocked(formatDoctorOutput).mockReturnValue("formatted output")
  })

  it("calls runDoctorChecks and formatDoctorOutput", async () => {
    const deps = createMinimalDeps()
    await runOuroCli(["doctor"], deps)

    expect(runDoctorChecks).toHaveBeenCalledTimes(1)
    expect(formatDoctorOutput).toHaveBeenCalledWith(MOCK_RESULT)
  })

  it("passes the injected fetch implementation into doctor diagnostics", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch
    const deps = createMinimalDeps({ fetchImpl })
    await runOuroCli(["doctor"], deps)

    expect(runDoctorChecks).toHaveBeenCalledWith(expect.objectContaining({ fetchImpl }))
  })

  it("writes formatted output to stdout", async () => {
    const deps = createMinimalDeps()
    await runOuroCli(["doctor"], deps)

    expect(deps.writeStdout).toHaveBeenCalledWith("formatted output")
  })

  it("returns formatted output as result", async () => {
    const deps = createMinimalDeps()
    const result = await runOuroCli(["doctor"], deps)

    expect(result).toBe("formatted output")
  })

  it("emits daemon.doctor_run nerves event", async () => {
    const deps = createMinimalDeps()
    await runOuroCli(["doctor"], deps)

    expect(emitNervesEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        component: "daemon",
        event: "daemon.doctor_run",
      }),
    )
  })
})
