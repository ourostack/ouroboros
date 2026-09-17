import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { executeSanctuaryAcceptanceHarness } from "../../../heart/daemon/sanctuary-acceptance-harness"

const roots: string[] = []
afterEach(() => { vi.useRealTimers(); for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }) })
function fixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "gateway-bootstrap-")))
  roots.push(root)
  const now = Date.parse("2026-09-17T00:00:00.000Z")
  const nonce = "01".repeat(16)
  const update = { update_id: 41, message: { message_id: 1, date: now / 1000, text: nonce, from: { id: 42 }, chat: { id: 42, type: "private" } } }
  let cursor = 0
  const connection = {
    credentials: { botId: "123", authorizedUserId: "42", authorizedChatId: "42" },
    cursorSnapshot: vi.fn(async () => ({ cursor, progressDigest: `sha256:${cursor ? "b".repeat(64) : "a".repeat(64)}` })),
    authorityTransport: {
      hostApproval: { refresh: vi.fn(async () => true) },
      api: { request: vi.fn(async (method: string) => method === "getMe" ? { id: 123, username: "fixture" } : [update]), stop: vi.fn() },
      metadataForUpdate: vi.fn(() => ({ ownerEligible: true, userId: "42", chatId: "42" })),
      settleTransport: vi.fn(async () => { cursor = 42 }),
    },
  }
  const forbidden = vi.fn(() => { throw new Error("resident credential access is forbidden") })
  const deps = {
    gateway: () => connection,
    readSecret: forbidden, refreshRuntime: forbidden, telegramCredentials: forbidden, mergeRuntime: forbidden, fetch: forbidden,
    realpath: fs.realpathSync, now: () => now, randomBytes: () => Buffer.from(nonce, "hex"), sleep: async () => undefined,
    runAdapter: vi.fn(async () => ({ quiesced: true, activePollers: 1 })),
  }
  const config = {
    allowedRoot: root, evidencePath: path.join(root, "proof.json"), offsetPath: path.join(root, "cursor.json"), noncePath: path.join(root, "nonce"),
    expectedBotId: "123", expectedUsername: "fixture", currentOffset: 0, pollerAdapter: "/opt/ouro/deploy/unraid/sanctuary-acceptance-adapter.sh", deadlineMs: 300_000, pollTimeoutSeconds: 50,
  }
  return { root, update, connection, forbidden, deps, config }
}
describe("gateway-owned acceptance bootstrap", () => {
  it("confirms only the pinned root-observed owner nonce and settles through root without any token access", async () => {
    const f = fixture()
    await executeSanctuaryAcceptanceHarness("telegram-bootstrap", f.config, f.deps as never)
    expect(f.forbidden).not.toHaveBeenCalled()
    expect(f.connection.authorityTransport.settleTransport).toHaveBeenCalledWith(f.update, "completed")
    expect(f.connection.authorityTransport.api.stop).toHaveBeenCalledOnce()
    expect(JSON.parse(fs.readFileSync(f.config.offsetPath, "utf8"))).toEqual({ nextUpdateId: 42, progressDigest: `sha256:${"b".repeat(64)}` })
    expect(JSON.parse(fs.readFileSync(f.config.evidencePath, "utf8"))).toMatchObject({ phase: "complete", offsetDigest: "b".repeat(64) })
  })
  it.each(["unrelated", "non-owner", "stale-cursor"])("refuses %s evidence without discarding or settling another update", async (kind) => {
    const f = fixture()
    if (kind === "unrelated") f.update.message.text = "a real owner request"
    if (kind === "non-owner") f.connection.authorityTransport.metadataForUpdate.mockReturnValue({ ownerEligible: false, userId: "42", chatId: "42" })
    if (kind === "stale-cursor") f.config.currentOffset = 50
    await expect(executeSanctuaryAcceptanceHarness("telegram-bootstrap", f.config, f.deps as never)).rejects.toThrow(/gateway|owner|pending/u)
    expect(f.forbidden).not.toHaveBeenCalled()
    expect(f.connection.authorityTransport.settleTransport).not.toHaveBeenCalled()
    expect(f.connection.authorityTransport.api.stop).toHaveBeenCalledOnce()
  })
  it("refuses unhealthy root authority before publishing the nonce", async () => {
    const f = fixture()
    f.connection.authorityTransport.hostApproval.refresh.mockResolvedValue(false)
    await expect(executeSanctuaryAcceptanceHarness("telegram-bootstrap", f.config, f.deps as never)).rejects.toThrow(/health/u)
    expect(fs.existsSync(f.config.noncePath)).toBe(false)
    expect(f.connection.authorityTransport.api.stop).toHaveBeenCalledOnce()
  })
  it("bounds a hung gateway call, closes the socket, and never publishes a nonce", async () => {
    vi.useFakeTimers()
    const f = fixture()
    f.connection.authorityTransport.api.request.mockImplementation(() => new Promise(() => undefined))
    const result = executeSanctuaryAcceptanceHarness("telegram-bootstrap", f.config, { ...f.deps, telegramTimeoutMs: 25 } as never)
    const assertion = expect(result).rejects.toThrow(/timed out/u)
    await vi.advanceTimersByTimeAsync(25)
    await assertion
    expect(fs.existsSync(f.config.noncePath)).toBe(false)
    expect(f.connection.authorityTransport.api.stop).toHaveBeenCalledOnce()
  })
  it.each(["getMe", "getUpdates"] as const)("redacts a %s dependency error and preserves the method category", async (method) => {
    const f = fixture()
    const original = f.connection.authorityTransport.api.request.getMockImplementation()!
    f.connection.authorityTransport.api.request.mockImplementation(async (name) => {
      if (name === method) throw new Error("123:private-credential-value")
      return original(name)
    })
    await expect(executeSanctuaryAcceptanceHarness("telegram-bootstrap", f.config, f.deps as never)).rejects.toThrow(`Telegram ${method} failed`)
    expect(fs.existsSync(f.config.offsetPath)).toBe(false)
    expect(f.connection.authorityTransport.api.stop).toHaveBeenCalledOnce()
  })
  it.each(["missing", "identity", "pin", "shape", "multiple", "quiescence", "quiescence-extra", "missing-message", "group", "missing-from", "forward", "stale", "invalid-date", "missing-observation", "wrong-user", "wrong-chat", "settlement", "readback", "nonce-race", "offset-directory"])("refuses %s and never fabricates successful cursor evidence", async (fault) => {
    const f = fixture()
    const transport = f.connection.authorityTransport
    const original = transport.api.request.getMockImplementation()!
    if (fault === "missing") Object.assign(f.deps, { gateway: undefined })
    if (fault === "identity") transport.api.request.mockResolvedValue({ id: 999, username: "fixture" } as never)
    if (fault === "pin") f.connection.credentials.botId = "999"
    if (fault === "shape" || fault === "multiple") transport.api.request.mockImplementation(async (method) => method === "getMe" ? original(method) : fault === "shape" ? {} as never : [f.update, f.update])
    if (fault === "quiescence") f.deps.runAdapter.mockResolvedValue({ quiesced: false, activePollers: 1 })
    if (fault === "quiescence-extra") f.deps.runAdapter.mockResolvedValue({ quiesced: true, activePollers: 1, fake: true } as never)
    if (fault === "missing-message") delete (f.update as Partial<typeof f.update>).message
    if (fault === "group") f.update.message.chat.type = "group"
    if (fault === "missing-from") delete (f.update.message as Partial<typeof f.update.message>).from
    if (fault === "forward") Object.assign(f.update.message, { forward_date: 1 })
    if (fault === "stale") f.update.message.date -= 1
    if (fault === "invalid-date") f.update.message.date = NaN
    if (fault === "missing-observation") transport.metadataForUpdate.mockReturnValue(null as never)
    if (fault === "wrong-user") transport.metadataForUpdate.mockReturnValue({ ownerEligible: true, userId: "99", chatId: "42" })
    if (fault === "wrong-chat") transport.metadataForUpdate.mockReturnValue({ ownerEligible: true, userId: "42", chatId: "99" })
    if (fault === "settlement") transport.settleTransport.mockRejectedValue(new Error("settlement unavailable"))
    if (fault === "readback") transport.settleTransport.mockResolvedValue(undefined)
    if (fault === "nonce-race") f.deps.runAdapter.mockImplementation(async () => { fs.writeFileSync(f.config.noncePath, "racer"); return { quiesced: true, activePollers: 1 } })
    if (fault === "offset-directory") fs.mkdirSync(f.config.offsetPath)
    await expect(executeSanctuaryAcceptanceHarness("telegram-bootstrap", f.config, f.deps as never)).rejects.toThrow()
    expect(f.forbidden).not.toHaveBeenCalled()
    if (fs.existsSync(f.config.evidencePath)) expect(JSON.parse(fs.readFileSync(f.config.evidencePath, "utf8")).phase).not.toBe("complete")
  })
  it.each([false, true])("waits for a delayed nonce without discarding updates; timeout=%s", async (timeout) => {
    const f = fixture()
    let clock = f.deps.now()
    f.deps.now = () => clock
    const original = f.connection.authorityTransport.api.request.getMockImplementation()!
    let polls = 0
    f.connection.authorityTransport.api.request.mockImplementation(async (method) => {
      if (method !== "getUpdates") return original(method)
      if (++polls === 1 || timeout) { clock += 100_000; return [] }
      return [f.update]
    })
    const result = executeSanctuaryAcceptanceHarness("telegram-bootstrap", f.config, f.deps as never)
    if (timeout) await expect(result).rejects.toThrow(/nonce confirmation timed out/u)
    else {
      await result
      expect(polls).toBe(2)
      expect(f.connection.authorityTransport.settleTransport).toHaveBeenCalledOnce()
    }
  })
})
