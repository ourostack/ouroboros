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

const mailAuthorityMocks = vi.hoisted(() => ({
  resolve: vi.fn(),
}))
vi.mock("../../../mailroom/reader", async () => {
  const actual = await vi.importActual<typeof import("../../../mailroom/reader")>("../../../mailroom/reader")
  return { ...actual, resolveHostedMailAuthority: mailAuthorityMocks.resolve }
})

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
    mailAuthorityMocks.resolve.mockReturnValue({ ok: false, error: "authority not configured" })
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

  it("injects a mutation-free hosted authority observer with definitive and transient error classification", async () => {
    const deps = createMinimalDeps()
    await runOuroCli(["doctor"], deps)
    const doctorDeps = vi.mocked(runDoctorChecks).mock.calls[0]![0]

    await expect(doctorDeps.observeHostedMailAuthority!("slugger")).resolves.toEqual({
      ok: false,
      definitive: true,
      detail: "authority not configured",
    })

    const observe = vi.fn()
    mailAuthorityMocks.resolve.mockReturnValue({ ok: true, authority: { observeMessageIndexAuthority: observe } })
    observe.mockRejectedValueOnce(Object.assign(new Error("forbidden"), { statusCode: 403 }))
    await expect(doctorDeps.observeHostedMailAuthority!("slugger")).resolves.toEqual({
      ok: false,
      definitive: true,
      detail: "forbidden",
    })
    observe.mockRejectedValueOnce("offline")
    await expect(doctorDeps.observeHostedMailAuthority!("slugger")).resolves.toEqual({
      ok: false,
      definitive: false,
      detail: "offline",
    })
    const observation = { records: [], parseFailureCount: 0, duplicateIds: [] }
    observe.mockResolvedValueOnce(observation)
    await expect(doctorDeps.observeHostedMailAuthority!("slugger")).resolves.toEqual({ ok: true, observation })
  })

  it("passes daemon log diagnostics through the injected homeDir", async () => {
    const deps = createMinimalDeps({ homeDir: "/tmp/ouro-test-home" })
    await runOuroCli(["doctor"], deps)

    expect(runDoctorChecks).toHaveBeenCalledWith(expect.objectContaining({
      daemonLogsDir: "/tmp/ouro-test-home/.ouro-cli/daemon/logs",
    }))
  })

  it("passes an empty envPath to doctor diagnostics when PATH is unset", async () => {
    const previousPath = process.env.PATH
    delete process.env.PATH
    try {
      const deps = createMinimalDeps()
      await runOuroCli(["doctor"], deps)

      expect(runDoctorChecks).toHaveBeenCalledWith(expect.objectContaining({ envPath: "" }))
    } finally {
      if (previousPath === undefined) {
        delete process.env.PATH
      } else {
        process.env.PATH = previousPath
      }
    }
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
