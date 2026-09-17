import { createHash, generateKeyPairSync } from "node:crypto"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, describe, expect, it } from "vitest"

import {
  FileSanctuaryTelegramAuthorityGateway,
  sanctuaryAuthorityPublicKeyDigest,
  sanctuaryTelegramAuthorityStatePath,
} from "../../../heart/daemon/sanctuary-telegram-authority-gateway"
import { authorityArtifactDigest, verifyAuthorityPayload } from "../../../heart/daemon/sanctuary-authority-codec"
import type { TelegramUpdate } from "../../../senses/telegram-client"

const roots: string[] = []

function root(): string {
  const value = fs.mkdtempSync(path.join(os.tmpdir(), "sanctuary-telegram-authority-"))
  roots.push(value)
  return value
}

afterEach(() => {
  for (const value of roots.splice(0)) fs.rmSync(value, { recursive: true, force: true })
})

function message(updateId: number, userId = 42, chatId = userId): TelegramUpdate {
  return {
    update_id: updateId,
    message: {
      message_id: updateId + 100,
      from: { id: userId, first_name: "Ari" },
      chat: { id: chatId, type: "private" },
      text: `update ${updateId}`,
    },
  }
}

function fixture(agentRoot = root()) {
  const keys = generateKeyPairSync("ed25519")
  let nonce = 0
  const configuration = {
    targetHost: "sanctuary",
    botId: "123456",
    ownerUserId: "42",
    ownerChatId: "42",
    keyId: "sanctuary-root-2026-09-16",
    publicKeyDigest: sanctuaryAuthorityPublicKeyDigest(keys.privateKey),
    privateKey: keys.privateKey,
    now: () => "2026-09-16T22:00:00.000Z",
    nonce: () => Buffer.alloc(32, ++nonce).toString("base64url"),
  }
  const gateway = new FileSanctuaryTelegramAuthorityGateway(agentRoot, configuration)
  return { agentRoot, configuration, gateway, publicKey: keys.publicKey }
}

describe("Sanctuary root Telegram authority gateway state", () => {
  it("durably captures and re-delivers one byte-identical signed owner observation", () => {
    const f = fixture()
    const update = message(10)
    f.gateway.capture([update])

    const first = f.gateway.poll()
    expect(first).not.toBeNull()
    f.gateway.capture([update])
    expect(f.gateway.poll()).toEqual(first)
    expect(new FileSanctuaryTelegramAuthorityGateway(f.agentRoot, f.configuration).poll()).toEqual(first)
    expect(verifyAuthorityPayload({
      artifact: first,
      expectedDomain: "ouro.sanctuary.telegram-observation.v1",
      expectedKeyId: "sanctuary-root-2026-09-16",
      publicKey: f.publicKey,
    })).toMatchObject({
      targetHost: "sanctuary",
      botId: "123456",
      updateId: 10,
      updateClass: "message",
      userId: "42",
      chatId: "42",
      ownerEligible: true,
      messageId: "110",
      callbackQueryId: null,
      rawUpdateDigest: `tgu_${createHash("sha256").update(`ouroboros.telegram.update.v1\0${JSON.stringify(update)}`, "utf8").digest("base64url")}`,
      observedAt: "2026-09-16T22:00:00.000Z",
      settlement: "pending",
    })
    expect(fs.statSync(sanctuaryTelegramAuthorityStatePath(f.agentRoot)).mode & 0o777).toBe(0o600)
    expect(fs.statSync(path.dirname(sanctuaryTelegramAuthorityStatePath(f.agentRoot))).mode & 0o777).toBe(0o700)
  })

  it("settles only the exact observation and advances across the contiguous settled prefix", () => {
    const f = fixture()
    f.gateway.capture([message(20), message(21, 84)])
    const first = f.gateway.poll()!
    expect(first.payload.updateId).toBe(20)
    expect(() => f.gateway.settle({ updateId: 20, observationDigest: "sha256:" + "f".repeat(64), outcome: "completed" })).toThrow(/digest/u)
    expect(f.gateway.cursor()).toBe(0)

    f.gateway.settle({
      updateId: 20,
      observationDigest: authorityArtifactDigest(first.domain, first.payload),
      outcome: "completed",
    })
    expect(f.gateway.cursor()).toBe(21)
    expect(f.gateway.poll()!.payload).toMatchObject({ updateId: 21, ownerEligible: false })
    expect(new FileSanctuaryTelegramAuthorityGateway(f.agentRoot, f.configuration).cursor()).toBe(21)
  })

  it("auto-settles unsupported and missing-sender updates without granting authority or stalling", () => {
    const f = fixture()
    f.gateway.capture([
      { update_id: 30, message: { message_id: 130, chat: { id: 42, type: "private" }, text: "missing sender" } },
      { update_id: 31 },
      message(32),
    ])
    expect(f.gateway.cursor()).toBe(32)
    expect(f.gateway.poll()!.payload.updateId).toBe(32)
    expect(f.gateway.record(30)).toMatchObject({ disposition: "ignored", settlement: "ignored" })
    expect(f.gateway.record(31)).toMatchObject({ disposition: "ignored", settlement: "ignored" })
  })

  it("captures later updates but delivers them in order until the earlier observation settles", () => {
    const f = fixture()
    f.gateway.capture([message(40), message(41), message(42)])
    expect(f.gateway.poll()!.payload.updateId).toBe(40)
    expect(f.gateway.poll()!.payload.updateId).toBe(40)
    const first = f.gateway.poll()!
    f.gateway.settle({
      updateId: 40,
      observationDigest: authorityArtifactDigest(first.domain, first.payload),
      outcome: "indeterminate",
    })
    expect(f.gateway.poll()!.payload.updateId).toBe(41)
  })

  it("resolves only an exact pending owner observation for root host approval", () => {
    const f = fixture()
    expect(f.gateway.ownerObservation({ updateId: 1.5, observationDigest: `sha256:${"a".repeat(64)}` })).toBeNull()
    expect(f.gateway.ownerObservation({ updateId: -1, observationDigest: `sha256:${"a".repeat(64)}` })).toBeNull()
    expect(f.gateway.ownerObservation({ updateId: 1, observationDigest: "bad" })).toBeNull()
    expect(f.gateway.ownerObservation({ updateId: 999, observationDigest: `sha256:${"a".repeat(64)}` })).toBeNull()

    f.gateway.capture([{ update_id: 79 }, message(80), message(81, 84)])
    const owner = f.gateway.poll()!
    const ownerDigest = authorityArtifactDigest(owner.domain, owner.payload)
    expect(f.gateway.ownerObservation({ updateId: 79, observationDigest: `sha256:${"a".repeat(64)}` })).toBeNull()
    expect(f.gateway.ownerObservation({ updateId: 80, observationDigest: `sha256:${"a".repeat(64)}` })).toBeNull()
    expect(f.gateway.ownerObservation({ updateId: 80, observationDigest: ownerDigest })).toEqual(owner)
    f.gateway.settle({ updateId: 80, observationDigest: ownerDigest, outcome: "completed" })
    expect(f.gateway.ownerObservation({ updateId: 80, observationDigest: ownerDigest })).toBeNull()
    const nonOwner = f.gateway.poll()!
    expect(f.gateway.ownerObservation({
      updateId: 81,
      observationDigest: authorityArtifactDigest(nonOwner.domain, nonOwner.payload),
    })).toBeNull()
  })

  it("refuses changed duplicate updates, duplicate settlement, malformed state, and invalid capture input", () => {
    const f = fixture()
    f.gateway.capture([message(50)])
    const before = fs.readFileSync(sanctuaryTelegramAuthorityStatePath(f.agentRoot), "utf8")
    expect(() => f.gateway.capture([{ ...message(50), message: { ...message(50).message!, text: "changed" } }])).toThrow(/duplicate/u)
    expect(fs.readFileSync(sanctuaryTelegramAuthorityStatePath(f.agentRoot), "utf8")).toBe(before)
    expect(() => f.gateway.capture([{ update_id: -1 }])).toThrow(/update/u)
    const observation = f.gateway.poll()!
    const settlement = {
      updateId: 50,
      observationDigest: authorityArtifactDigest(observation.domain, observation.payload),
      outcome: "completed" as const,
    }
    f.gateway.settle(settlement)
    expect(() => f.gateway.settle(settlement)).toThrow(/settled/u)
    fs.writeFileSync(sanctuaryTelegramAuthorityStatePath(f.agentRoot), "{\"schemaVersion\":1,\"records\":[]}", "utf8")
    expect(() => f.gateway.cursor()).toThrow(/state/u)
  })

  it("refuses a mismatched issuer key digest and reused observation nonce", () => {
    const f = fixture()
    expect(() => new FileSanctuaryTelegramAuthorityGateway(root(), {
      ...f.configuration,
      publicKeyDigest: `sha256:${"f".repeat(64)}`,
    })).toThrow(/issuer/u)

    const duplicateNonce = Buffer.alloc(32, 7).toString("base64url")
    const gateway = new FileSanctuaryTelegramAuthorityGateway(root(), {
      ...f.configuration,
      nonce: () => duplicateNonce,
    })
    gateway.capture([message(60)])
    expect(() => gateway.capture([message(61)])).toThrow(/nonce/u)
  })

  it("captures callbacks and exercises secure default time and nonce generation", () => {
    const f = fixture()
    const gateway = new FileSanctuaryTelegramAuthorityGateway(root(), {
      ...f.configuration,
      now: undefined,
      nonce: undefined,
    })
    gateway.capture([{
      update_id: 70,
      callback_query: {
        id: "callback-70",
        from: { id: 42 },
        data: "approve",
        message: { message_id: 170, chat: { id: 42 } },
      },
    }])
    expect(gateway.poll()!.payload).toMatchObject({
      updateClass: "callback",
      userId: "42",
      chatId: "42",
      messageId: "170",
      callbackQueryId: "callback-70",
      ownerEligible: true,
    })
    expect(gateway.ownsCallbackQuery("callback-70")).toBe(true)
    expect(gateway.ownsCallbackQuery("callback-missing")).toBe(false)
    expect(gateway.ownsCallbackQuery("")).toBe(false)
    expect(gateway.ownsCallbackQuery(1 as never)).toBe(false)
    expect(gateway.identity()).toEqual({
      targetHost: "sanctuary",
      botId: "123456",
      ownerUserId: "42",
      ownerChatId: "42",
      keyId: "sanctuary-root-2026-09-16",
      publicKeyDigest: f.configuration.publicKeyDigest,
    })
  })

  it("recognizes only file ids captured from root-observed updates", () => {
    const f = fixture()
    f.gateway.capture([{
      update_id: 71,
      message: {
        message_id: 171,
        from: { id: 42 },
        chat: { id: 42, type: "private" },
        document: { file_id: "document-1" },
        photo: [{ file_id: "photo-1" }],
        audio: { file_id: "audio-1" },
        video: { file_id: "video-1" },
        voice: { file_id: "voice-1" },
        animation: { file_id: "animation-1" },
        sticker: { file_id: "sticker-1" },
      },
    }, { update_id: 72 }])
    for (const fileId of ["document-1", "photo-1", "audio-1", "video-1", "voice-1", "animation-1", "sticker-1"]) {
      expect(f.gateway.ownsFileId(fileId)).toBe(true)
    }
    expect(f.gateway.ownsFileId("missing")).toBe(false)
    expect(f.gateway.ownsFileId("")).toBe(false)
    expect(f.gateway.ownsFileId(1 as never)).toBe(false)
  })

  it("binds stranger acknowledgement and admitted egress to durable root-observed coordinates", () => {
    const agentRoot = root()
    const keys = generateKeyPairSync("ed25519")
    let now = "2026-09-16T22:00:00.000Z"
    let nonce = 0
    const configuration = {
      targetHost: "sanctuary",
      botId: "123456",
      ownerUserId: "42",
      ownerChatId: "42",
      keyId: "sanctuary-root-2026-09-16",
      publicKeyDigest: sanctuaryAuthorityPublicKeyDigest(keys.privateKey),
      privateKey: keys.privateKey,
      now: () => now,
      nonce: () => Buffer.alloc(32, ++nonce).toString("base64url"),
    }
    const gateway = new FileSanctuaryTelegramAuthorityGateway(agentRoot, configuration)
    gateway.capture([message(100, 84)])
    const observation = gateway.poll()!
    const observationDigest = authorityArtifactDigest(observation.domain, observation.payload)
    expect(gateway.ownsCurrentObservation({ updateId: 100, observationDigest, chatId: "84" })).toBe(true)
    expect(gateway.ownsCurrentObservation({ updateId: 100, observationDigest: `sha256:${"f".repeat(64)}`, chatId: "84" })).toBe(false)
    for (const invalid of [
      { updateId: -1, observationDigest, chatId: "84" },
      { updateId: 1.5, observationDigest, chatId: "84" },
      { updateId: 100, observationDigest: "bad", chatId: "84" },
      { updateId: 100, observationDigest, chatId: "0" },
    ]) expect(gateway.ownsCurrentObservation(invalid)).toBe(false)
    expect(gateway.isAuthorizedChat("84")).toBe(false)
    expect(gateway.isAuthorizedChat("0")).toBe(false)
    expect(gateway.isAuthorizedChat("42")).toBe(true)

    gateway.admitChat({ admissionId: "a".repeat(20), updateId: 100, userId: "84", chatId: "84" })
    gateway.admitChat({ admissionId: "a".repeat(20), updateId: 100, userId: "84", chatId: "84" })
    expect(() => gateway.admitChat({ admissionId: "b".repeat(20), updateId: 100, userId: "84", chatId: "84" })).toThrow(/changed/u)
    expect(gateway.isAuthorizedChat("84")).toBe(true)
    now = "not-time"
    expect(() => gateway.isAuthorizedChat("84")).toThrow(/clock/u)
    now = "2026-09-16T22:00:00.000Z"
    expect(new FileSanctuaryTelegramAuthorityGateway(agentRoot, configuration).isAuthorizedChat("84")).toBe(true)
    expect(() => gateway.admitChat({ admissionId: "short", updateId: 100, userId: "84", chatId: "84" })).toThrow(/malformed/u)
    expect(() => gateway.admitChat({ admissionId: "b".repeat(20), updateId: -1, userId: "84", chatId: "84" })).toThrow(/malformed/u)
    expect(() => gateway.admitChat({ admissionId: "b".repeat(20), updateId: 999, userId: "84", chatId: "84" })).toThrow(/root-observed/u)
    expect(() => gateway.admitChat({ admissionId: "b".repeat(20), updateId: 100, userId: "85", chatId: "84" })).toThrow(/root-observed/u)
    expect(() => gateway.admitChat({ admissionId: "b".repeat(20), updateId: 100, userId: "84", chatId: "85" })).toThrow(/root-observed/u)
    gateway.capture([message(101)])
    expect(() => gateway.admitChat({ admissionId: "b".repeat(20), updateId: 101, userId: "42", chatId: "42" })).toThrow(/root-observed/u)
    expect(() => gateway.revokeChat({ userId: "0", chatId: "84" })).toThrow(/malformed/u)
    gateway.revokeChat({ userId: "85", chatId: "85" })
    gateway.revokeChat({ userId: "84", chatId: "84" })
    expect(gateway.isAuthorizedChat("84")).toBe(false)

    gateway.admitChat({ admissionId: "a".repeat(20), updateId: 100, userId: "84", chatId: "84" })
    now = "2027-09-17T22:00:00.000Z"
    expect(gateway.isAuthorizedChat("84")).toBe(false)
  })

  it("caps admitted Telegram communication coordinates at 64 live entries", () => {
    const f = fixture()
    for (let index = 0; index < 65; index += 1) {
      const updateId = 200 + index
      const userId = 1_000 + index
      f.gateway.capture([message(updateId, userId)])
      if (index < 64) {
        f.gateway.admitChat({
          admissionId: index.toString(16).padStart(20, "0"),
          updateId,
          userId: String(userId),
          chatId: String(userId),
        })
      } else {
        expect(() => f.gateway.admitChat({
          admissionId: index.toString(16).padStart(20, "0"),
          updateId,
          userId: String(userId),
          chatId: String(userId),
        })).toThrow(/limit/u)
      }
    }
  })

  it("refuses invalid configuration, clocks, nonces, stale updates, and settlement shapes", () => {
    const f = fixture()
    for (const [overrides, pattern] of [
      [{ botId: "0" }, /bot id/u],
      [{ ownerUserId: "not-decimal" }, /owner user id/u],
      [{ ownerChatId: "" }, /owner chat id/u],
      [{ targetHost: "" }, /issuer/u],
      [{ keyId: "" }, /issuer/u],
    ] as const) {
      expect(() => new FileSanctuaryTelegramAuthorityGateway(root(), { ...f.configuration, ...overrides })).toThrow(pattern)
    }
    expect(() => new FileSanctuaryTelegramAuthorityGateway("" as never, f.configuration)).toThrow(/root/u)
    expect(() => new FileSanctuaryTelegramAuthorityGateway(1 as never, f.configuration)).toThrow(/root/u)
    expect(() => f.gateway.capture(null as never)).toThrow(/array/u)
    expect(() => f.gateway.capture([null as never])).toThrow(/update/u)
    expect(() => f.gateway.capture([{ update_id: 1.5 }])).toThrow(/update/u)

    const badClock = new FileSanctuaryTelegramAuthorityGateway(root(), { ...f.configuration, now: () => "not-time" })
    expect(() => badClock.capture([message(80)])).toThrow(/clock/u)
    const nonStringClock = new FileSanctuaryTelegramAuthorityGateway(root(), { ...f.configuration, now: (() => 1) as never })
    expect(() => nonStringClock.capture([message(80)])).toThrow(/clock/u)
    const throwingClock = new FileSanctuaryTelegramAuthorityGateway(root(), { ...f.configuration, now: () => "999999-01-01T00:00:00.000Z" })
    expect(() => throwingClock.capture([message(80)])).toThrow(/clock/u)
    const badNonce = new FileSanctuaryTelegramAuthorityGateway(root(), { ...f.configuration, nonce: () => "short" })
    expect(() => badNonce.capture([message(80)])).toThrow(/nonce/u)

    f.gateway.capture([message(80)])
    const observation = f.gateway.poll()!
    f.gateway.settle({
      updateId: 80,
      observationDigest: authorityArtifactDigest(observation.domain, observation.payload),
      outcome: "completed",
    })
    f.gateway.capture([])
    expect(f.gateway.poll()).toBeNull()
    expect(f.gateway.record(81)).toBeNull()
    expect(() => f.gateway.capture([message(79)])).toThrow(/stale/u)
    for (const candidate of [
      null,
      {},
      { updateId: -1, observationDigest: `sha256:${"a".repeat(64)}`, outcome: "completed" },
      { updateId: 81, observationDigest: "bad", outcome: "completed" },
      { updateId: 81, observationDigest: `sha256:${"a".repeat(64)}`, outcome: "ignored" },
      { updateId: 81, observationDigest: `sha256:${"a".repeat(64)}`, outcome: "completed", extra: true },
    ]) {
      expect(() => f.gateway.settle(candidate as never)).toThrow(/settlement/u)
    }
    expect(() => f.gateway.settle({ updateId: 81, observationDigest: `sha256:${"a".repeat(64)}`, outcome: "completed" })).toThrow(/missing/u)
    expect(() => f.gateway.record(-1)).toThrow(/update id/u)
    expect(() => f.gateway.record(1.5)).toThrow(/update id/u)
  })

  it("refuses every malformed durable gateway state instead of repairing authority", () => {
    const f = fixture()
    f.gateway.capture([message(90)])
    const file = sanctuaryTelegramAuthorityStatePath(f.agentRoot)
    const valid = JSON.parse(fs.readFileSync(file, "utf8")) as any
    const record = valid.records["90"]
    const malformed = [
      null,
      [],
      { ...valid, extra: true },
      { ...valid, schemaVersion: 2 },
      { ...valid, cursor: -1 },
      { ...valid, cursor: "0" },
      { ...valid, records: [] },
      { ...valid, authorizedChats: [] },
      { ...valid, authorizedChats: { bad: null } },
      { ...valid, authorizedChats: { "84:84": { admissionId: "short", updateId: 90, userId: "84", chatId: "84", admittedAt: "2026-09-16T22:00:00.000Z", lastUsedAt: "2026-09-16T22:00:00.000Z" } } },
      { ...valid, authorizedChats: Object.fromEntries(Array.from({ length: 65 }, (_, index) => [`${1000 + index}:${1000 + index}`, { admissionId: index.toString(16).padStart(20, "0"), updateId: 90, userId: String(1000 + index), chatId: String(1000 + index), admittedAt: "2026-09-16T22:00:00.000Z", lastUsedAt: "2026-09-16T22:00:00.000Z" }])) },
      { ...valid, records: { invalid: record } },
      { ...valid, records: { "90": null } },
      { ...valid, records: { "90": { ...record, extra: true } } },
      { ...valid, records: { "90": { ...record, updateId: 91 } } },
      { ...valid, records: { "90": { ...record, rawUpdateDigest: "bad" } } },
      { ...valid, records: { "90": { ...record, rawUpdate: null } } },
      { ...valid, records: { "90": { ...record, rawUpdate: { update_id: 91 } } } },
      { ...valid, records: { "90": { ...record, disposition: "ignored", settlement: "pending", observation: null } } },
      { ...valid, records: { "90": { ...record, disposition: "dispatch", settlement: "ignored" } } },
      { ...valid, records: { "90": { ...record, observation: null } } },
      { ...valid, records: { "90": { ...record, observation: { ...record.observation, schemaVersion: 2 } } } },
      { ...valid, records: { "90": { ...record, observation: { ...record.observation, payload: null } } } },
    ]
    for (const state of malformed) {
      fs.writeFileSync(file, JSON.stringify(state), "utf8")
      expect(() => f.gateway.cursor(), JSON.stringify(state)).toThrow(/state|record|observation|settlement|ignored|update key|registry/u)
    }
  })
})
