import { afterEach, describe, expect, it, vi } from "vitest"
import type { TelegramBotApi } from "../../../senses/telegram-client"
import { executeSanctuaryAcceptanceAdapter, type SanctuaryAcceptanceAdapterDependencies } from "../../../heart/daemon/sanctuary-acceptance-adapter"

afterEach(() => vi.restoreAllMocks())

function fixture() {
  const request = vi.fn<TelegramBotApi["request"]>(async () => ({ id: 8541786263, username: "MendelowCloudButlerBot" }))
  const stop = vi.fn()
  const refresh = vi.fn(async () => true)
  const cursorSnapshot = vi.fn(async () => ({ cursor: 42, progressDigest: `sha256:${"a".repeat(64)}` }))
  const gateway = { credentials: { botId: "8541786263", authorizedUserId: "42", authorizedChatId: "42" }, cursorSnapshot, authorityTransport: { api: { request, stop }, hostApproval: { refresh } } }
  const forbidden = vi.fn(() => { throw new Error("resident token access forbidden") })
  const deps = { gateway: () => gateway, refreshRuntime: forbidden, telegramCredentials: forbidden, createTelegramApi: forbidden } as unknown as SanctuaryAcceptanceAdapterDependencies
  return { deps, gateway, request, stop, refresh, cursorSnapshot, forbidden }
}

describe("tokenless gateway acceptance readiness", () => {
  it("requires fresh root health, signed cursor and pinned getMe without resident tokens", async () => {
    const f = fixture()
    await expect(executeSanctuaryAcceptanceAdapter({ operation: "telegram_readiness" }, f.deps)).resolves.toEqual({ ready: true, identityMatches: true })
    expect(f.refresh).toHaveBeenCalledOnce()
    expect(f.cursorSnapshot).toHaveBeenCalledOnce()
    expect(f.request).toHaveBeenCalledWith("getMe", {}, expect.any(AbortSignal))
    expect(f.stop).toHaveBeenCalledOnce()
    expect(f.forbidden).not.toHaveBeenCalled()
  })

  it.each(["missing", "open", "health", "cursor", "getMe", "identity", "stop"])("fails %s closed with no secret in caller guidance", async (kind) => {
    const f = fixture()
    const secret = "8541786263:must-never-escape"
    if (kind === "missing") Object.assign(f.deps, { gateway: undefined })
    if (kind === "open") Object.assign(f.deps, { gateway: () => { throw new Error(secret) } })
    if (kind === "health") f.refresh.mockResolvedValue(false)
    if (kind === "cursor") f.cursorSnapshot.mockRejectedValue(new Error(secret))
    if (kind === "getMe") f.request.mockRejectedValue(new Error(secret))
    if (kind === "identity") f.request.mockResolvedValue({ id: 123, username: secret })
    if (kind === "stop") f.stop.mockImplementation(() => { throw new Error(secret) })
    const error = await executeSanctuaryAcceptanceAdapter({ operation: "telegram_readiness" }, f.deps).catch((error: Error) => error)
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toMatch(/actor:/u)
    expect((error as Error).message).not.toContain(secret)
    expect(f.forbidden).not.toHaveBeenCalled()
    if (kind !== "missing" && kind !== "open") expect(f.stop).toHaveBeenCalledOnce()
  })
})
