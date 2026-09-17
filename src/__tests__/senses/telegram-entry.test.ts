import { afterEach, beforeEach, expect, it, vi } from "vitest"

const boot = vi.hoisted(() => ({
  wait: vi.fn(), read: vi.fn(), refresh: vi.fn(), machine: vi.fn(), start: vi.fn(), log: vi.fn(), configure: vi.fn(),
}))
vi.mock("../../heart/runtime-credentials", () => ({
  waitForRuntimeCredentialBootstrap: boot.wait, readRuntimeCredentialConfig: boot.read,
  refreshRuntimeCredentialConfig: boot.refresh, refreshMachineRuntimeCredentialConfig: boot.machine,
}))
vi.mock("../../heart/machine-identity", () => ({ loadOrCreateMachineIdentity: () => ({ machineId: "fixture" }) }))
vi.mock("../../heart/daemon/runtime-logging", () => ({ configureDaemonRuntimeLogger: boot.configure }))
vi.mock("../../nerves/runtime", () => ({ emitNervesEvent: boot.log }))
vi.mock("../../senses/telegram", () => ({ startTelegramSenseApp: boot.start }))
const argv = process.argv
beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
  process.argv = ["node", "telegram-entry.js", "--agent", "sanctuary"]
  boot.wait.mockResolvedValue(true)
  boot.read.mockReturnValue({ ok: true })
  boot.refresh.mockResolvedValue(undefined)
  boot.machine.mockResolvedValue(undefined)
})
afterEach(() => { process.argv = argv; vi.restoreAllMocks() })

it("requires an explicit agent before any startup work", async () => {
  process.argv = ["node", "telegram-entry.js"]
  vi.spyOn(console, "error").mockImplementation(() => undefined)
  const exit = vi.spyOn(process, "exit").mockImplementation(() => { throw new Error("process exited") })
  await expect(import("../../senses/telegram-entry")).rejects.toThrow("process exited")
  expect(exit).toHaveBeenCalledWith(1)
  expect(boot.start).not.toHaveBeenCalled()
})

it.each([[true, true], [false, true], [false, false]])("passes managed dependency waiting after bootstrap %s/cache %s and closes once", async (bootstrapped, cached) => {
  boot.wait.mockResolvedValue(bootstrapped)
  boot.read.mockReturnValue({ ok: cached })
  const app = { run: vi.fn(async () => undefined), stop: vi.fn(async () => undefined) }
  boot.start.mockResolvedValue(app)
  const listeners = new Map<string, () => void>()
  vi.spyOn(process, "once").mockImplementation(((event: string, listener: () => void) => { listeners.set(event, listener); return process }) as typeof process.once)
  await import("../../senses/telegram-entry")
  await vi.waitFor(() => expect(app.run).toHaveBeenCalledOnce())
  expect(boot.start).toHaveBeenCalledWith("sanctuary", true)
  expect(boot.refresh).toHaveBeenCalledTimes(!bootstrapped && !cached ? 1 : 0)
  listeners.get("SIGTERM")!()
  listeners.get("SIGINT")!()
  await vi.waitFor(() => expect(app.stop).toHaveBeenCalledOnce())
})

it.each([new Error("failed startup"), "primitive failure"])("reports real startup failures without swallowing them", async (error) => {
  boot.machine.mockRejectedValue(new Error("machine refresh unavailable"))
  boot.start.mockRejectedValue(error)
  vi.spyOn(console, "error").mockImplementation(() => undefined)
  const exit = vi.spyOn(process, "exit").mockReturnValue(undefined as never)
  await import("../../senses/telegram-entry")
  await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1))
  expect(boot.log).toHaveBeenCalledWith(expect.objectContaining({ event: "senses.entry_error" }))
})
