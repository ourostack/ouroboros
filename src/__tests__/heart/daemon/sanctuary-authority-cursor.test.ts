import { generateKeyPairSync } from "node:crypto"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { authorityArtifactDigest, verifyAuthorityPayload } from "../../../heart/daemon/sanctuary-authority-codec"
import { FileSanctuaryTelegramAuthorityGateway, sanctuaryAuthorityPublicKeyDigest, sanctuaryTelegramAuthorityStatePath } from "../../../heart/daemon/sanctuary-telegram-authority-gateway"
import { SanctuaryTelegramAuthorityService } from "../../../heart/daemon/sanctuary-telegram-authority-service"

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }) })
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "authority-cursor-"))
  roots.push(root)
  const keys = generateKeyPairSync("ed25519")
  let now = "2026-09-17T00:00:00.000Z"
  const options = { targetHost: "sanctuary", botId: "123", ownerUserId: "42", ownerChatId: "42", keyId: "epoch-1", privateKey: keys.privateKey, publicKeyDigest: sanctuaryAuthorityPublicKeyDigest(keys.privateKey), now: () => now }
  const gateway = new FileSanctuaryTelegramAuthorityGateway(root, options)
  const api = { request: vi.fn(async () => []), stop: vi.fn() }
  return { root, keys, options, gateway, api, service: new SanctuaryTelegramAuthorityService({ api, gateway }), advance: () => { now = "2026-09-17T00:00:01.000Z" } }
}

describe("signed gateway cursor migration and evidence", () => {
  it("binds sorted pending progress and refuses a changed resident delivery projection", () => {
    const f = fixture()
    f.gateway.capture([2, 1].map((update_id) => ({ update_id, message: { message_id: update_id, from: { id: 42 }, chat: { id: 42, type: "private" }, text: "ordinary" } })))
    expect(f.gateway.cursorSnapshot().payload.pendingUpdateIds).toEqual([1, 2])
    const file = sanctuaryTelegramAuthorityStatePath(f.root)
    const state = JSON.parse(fs.readFileSync(file, "utf8"))
    state.records["1"].deliveryUpdate = { update_id: 1 }
    fs.writeFileSync(file, JSON.stringify(state))
    expect(() => f.gateway.cursorSnapshot()).toThrow(/projection changed/u)
  })
  it("refuses an absent or invalid durable root cursor rather than signing a genesis fallback", () => {
    const f = fixture()
    expect(() => f.gateway.cursorSnapshot()).toThrow(/state/u)
  })
  it("imports the exact quiescent predecessor cursor once and retains it after restart", () => {
    const f = fixture()
    f.gateway.initializeCursor(812)
    expect(f.gateway.cursor()).toBe(812)
    f.gateway.initializeCursor(812)
    expect(new FileSanctuaryTelegramAuthorityGateway(f.root, f.options).cursor()).toBe(812)
    expect(() => f.gateway.initializeCursor(811)).toThrow(/cursor/u)
    for (const invalid of [-1, 0.5, NaN, Number.MAX_SAFE_INTEGER + 1, "812", null]) expect(() => f.gateway.initializeCursor(invalid as number)).toThrow(/cursor/u)
  })
  it("signs logical progress independently from snapshot time and never returns raw updates or private handles", async () => {
    const f = fixture()
    f.gateway.initializeCursor(812)
    const first = f.gateway.cursorSnapshot()
    f.advance()
    const second = f.gateway.cursorSnapshot()
    expect(second.payload.observedAt).not.toBe(first.payload.observedAt)
    expect(second.payload.progressDigest).toBe(first.payload.progressDigest)
    expect(verifyAuthorityPayload({ artifact: second, expectedDomain: "ouro.sanctuary.telegram-cursor.v1", expectedKeyId: "epoch-1", publicKey: f.keys.publicKey })).toEqual(second.payload)
    f.gateway.capture([{ update_id: 812, message: { message_id: 4, from: { id: 42 }, chat: { id: 42, type: "private" }, text: "private owner text" } }])
    const pending = f.gateway.cursorSnapshot()
    expect(pending.payload.progressDigest).not.toBe(second.payload.progressDigest)
    expect(pending.payload.pendingUpdateIds).toEqual([812])
    expect(() => f.gateway.initializeCursor(812)).toThrow(/cursor/u)
    const observation = f.gateway.poll()!
    f.gateway.settle({ updateId: 812, observationDigest: authorityArtifactDigest(observation.domain, observation.payload), outcome: "completed" })
    const settled = f.gateway.cursorSnapshot()
    expect(settled.payload.cursor).toBe(813)
    expect(settled.payload.pendingUpdateIds).toEqual([])
    expect(settled.payload.progressDigest).not.toBe(pending.payload.progressDigest)
    expect(JSON.stringify(settled)).not.toContain("private owner text")
    expect(await f.service.dispatch("telegram.cursor.snapshot", {})).toEqual(settled)
    expect(f.api.request).not.toHaveBeenCalled()
    await expect(f.service.dispatch("telegram.cursor.snapshot", { offset: 0 })).rejects.toThrow(/params/u)
  })
})
