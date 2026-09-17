import { afterEach, describe, expect, it, vi } from "vitest"
import { migrateSanctuaryAuthorityVault } from "../../../heart/daemon/sanctuary-authority-vault-migration"
import { createLogger, type LogEvent } from "../../../nerves"
import { setRuntimeLogger } from "../../../nerves/runtime"

const runtime = vi.hoisted(() => ({
  refreshRuntimeCredentialConfig: vi.fn(), refreshMachineRuntimeCredentialConfig: vi.fn(),
  upsertRuntimeCredentialConfig: vi.fn(), upsertMachineRuntimeCredentialConfig: vi.fn(),
}))
vi.mock("../../../heart/runtime-credentials", () => runtime)
const oldToken = "123:oldTokenabcdefghijklmnopqrstuvwxyz"
const newToken = "123:newTokenabcdefghijklmnopqrstuvwxyz"
function fixture() {
  vi.spyOn(process, "getuid").mockReturnValue(0)
  vi.spyOn(process, "getgid").mockReturnValue(0)
  let portable: Record<string, unknown> = { telegramBotToken: oldToken, telegramAuthorizedUserId: "42", telegramAuthorizedChatId: "42", mail: { untouched: "portable" } }
  let machine: Record<string, unknown> = { telegramBotToken: oldToken, telegramAuthorizedUserId: "42", telegramAuthorizedChatId: "42", sabnzbdApiKey: "unrelated-fixture" }
  runtime.refreshRuntimeCredentialConfig.mockImplementation(async () => ({ ok: true, config: structuredClone(portable) }))
  runtime.refreshMachineRuntimeCredentialConfig.mockImplementation(async () => ({ ok: true, config: structuredClone(machine) }))
  runtime.upsertRuntimeCredentialConfig.mockImplementation(async (_agent, value) => { portable = structuredClone(value) })
  runtime.upsertMachineRuntimeCredentialConfig.mockImplementation(async (_agent, _machine, value) => { machine = structuredClone(value) })
  return { values: () => ({ portable, machine }) }
}
afterEach(() => { vi.restoreAllMocks(); vi.resetAllMocks() })
describe("fixed Sanctuary vault handoff", () => {
  it("emits a non-secret audit event without recording snapshot credentials", async () => {
    fixture()
    const events: LogEvent[] = []
    setRuntimeLogger(createLogger({ sinks: [(event) => { events.push(event) }] }))
    try {
      await migrateSanctuaryAuthorityVault("snapshot")
      expect(events).toContainEqual(expect.objectContaining({ event: "daemon.sanctuary_vault_handoff_requested", meta: { operation: "snapshot" } }))
      expect(JSON.stringify(events)).not.toContain(oldToken)
    } finally { setRuntimeLogger(null) }
  })
  it("refuses a restoration whose token persists but configured owner coordinates do not", async () => {
    fixture()
    runtime.refreshRuntimeCredentialConfig.mockResolvedValue({ ok: true, config: { telegramBotToken: newToken, telegramAuthorizedUserId: "99", telegramAuthorizedChatId: "99" } })
    runtime.refreshMachineRuntimeCredentialConfig.mockResolvedValue({ ok: true, config: {} })
    await expect(migrateSanctuaryAuthorityVault("restore", { token: newToken, botId: "123", ownerUserId: "42", ownerChatId: "42" })).rejects.toThrow(/readback/u)
  })
  it("snapshots matching bot/owner identity without writing either owner", async () => {
    fixture()
    expect(await migrateSanctuaryAuthorityVault("presence")).toEqual({ tokenPresent: true })
    expect(await migrateSanctuaryAuthorityVault("snapshot")).toEqual({ token: oldToken, botId: "123", ownerUserId: "42", ownerChatId: "42" })
    expect(runtime.upsertRuntimeCredentialConfig).not.toHaveBeenCalled()
    expect(runtime.upsertMachineRuntimeCredentialConfig).not.toHaveBeenCalled()
  })
  it("removes from both owners, preserves unrelated fields, verifies readback, and retries a partial write", async () => {
    const f = fixture()
    runtime.upsertMachineRuntimeCredentialConfig.mockRejectedValueOnce(new Error("vault unavailable"))
    await expect(migrateSanctuaryAuthorityVault("remove")).rejects.toThrow("vault unavailable")
    expect(f.values().portable.telegramBotToken).toBeUndefined()
    expect(f.values().machine.telegramBotToken).toBe(oldToken)
    expect(await migrateSanctuaryAuthorityVault("remove")).toEqual({ tokenAbsent: true })
    expect(await migrateSanctuaryAuthorityVault("absent")).toEqual({ tokenAbsent: true })
    expect(await migrateSanctuaryAuthorityVault("presence")).toEqual({ tokenPresent: false })
    expect(f.values()).toEqual({
      portable: { telegramAuthorizedUserId: "42", telegramAuthorizedChatId: "42", mail: { untouched: "portable" } },
      machine: { telegramAuthorizedUserId: "42", telegramAuthorizedChatId: "42", sabnzbdApiKey: "unrelated-fixture" },
    })
  })
  it("hands only the current token to the canonical portable owner and leaves the machine token absent", async () => {
    const f = fixture()
    await migrateSanctuaryAuthorityVault("remove")
    expect(await migrateSanctuaryAuthorityVault("restore", { token: newToken, botId: "123", ownerUserId: "42", ownerChatId: "42" })).toEqual({ restored: true })
    expect(f.values().portable.telegramBotToken).toBe(newToken)
    expect(f.values().machine.telegramBotToken).toBeUndefined()
  })
  it("refuses token residue and a write which did not actually persist", async () => {
    fixture()
    await expect(migrateSanctuaryAuthorityVault("absent")).rejects.toThrow(/residue/u)
    runtime.upsertRuntimeCredentialConfig.mockResolvedValue(undefined)
    await expect(migrateSanctuaryAuthorityVault("remove")).rejects.toThrow(/residue/u)
  })
  it("refuses a lost restoration write", async () => {
    fixture()
    await migrateSanctuaryAuthorityVault("remove")
    runtime.upsertRuntimeCredentialConfig.mockResolvedValue(undefined)
    await expect(migrateSanctuaryAuthorityVault("restore", { token: newToken, botId: "123", ownerUserId: "42", ownerChatId: "42" })).rejects.toThrow(/readback/u)
  })
  it.each([
    { token: oldToken, botId: "456", ownerUserId: "42", ownerChatId: "42" },
    { token: "invalid", botId: "123", ownerUserId: "42", ownerChatId: "42" },
    { token: newToken, botId: "123", ownerUserId: "41", ownerChatId: "42" },
    null,
  ])("refuses invalid rollback input %j without mutation", async (input) => {
    fixture()
    await expect(migrateSanctuaryAuthorityVault("restore", input)).rejects.toThrow(/identity/u)
    expect(runtime.upsertRuntimeCredentialConfig).not.toHaveBeenCalled()
  })
  it("refuses non-root execution and unknown commands", async () => {
    fixture()
    vi.mocked(process.getuid!).mockReturnValue(10001)
    await expect(migrateSanctuaryAuthorityVault("snapshot")).rejects.toThrow(/root/u)
    vi.mocked(process.getuid!).mockReturnValue(0)
    await expect(migrateSanctuaryAuthorityVault("other")).rejects.toThrow(/operation/u)
  })
  it("tolerates a missing machine item but never masks unavailable or invalid vault state", async () => {
    fixture()
    runtime.refreshMachineRuntimeCredentialConfig.mockResolvedValue({ ok: false, reason: "missing" })
    expect(await migrateSanctuaryAuthorityVault("snapshot")).toMatchObject({ token: oldToken })
    for (const reason of ["unavailable", "invalid"]) {
      runtime.refreshMachineRuntimeCredentialConfig.mockResolvedValue({ ok: false, reason })
      await expect(migrateSanctuaryAuthorityVault("remove")).rejects.toThrow(/unavailable/u)
    }
  })
  it("refuses inconsistent tokens, missing tokens and mismatched configured owners", async () => {
    fixture()
    for (const config of [
      { telegramBotToken: newToken }, { telegramAuthorizedUserId: "43" }, { telegramAuthorizedChatId: "43" },
    ]) {
      runtime.refreshMachineRuntimeCredentialConfig.mockResolvedValue({ ok: true, config })
      await expect(migrateSanctuaryAuthorityVault("snapshot")).rejects.toThrow(/identity/u)
    }
    runtime.refreshMachineRuntimeCredentialConfig.mockResolvedValue({ ok: false, reason: "missing" })
    runtime.refreshRuntimeCredentialConfig.mockResolvedValue({ ok: false, reason: "missing" })
    await expect(migrateSanctuaryAuthorityVault("snapshot")).rejects.toThrow(/identity/u)
  })
})
