import { createHash, generateKeyPairSync } from "node:crypto"
import { describe, expect, it, vi } from "vitest"

import { authorityArtifactDigest, signAuthorityPayload } from "../../heart/daemon/sanctuary-authority-codec"
import {
  sanctuaryAuthorityPublicKeyDigest,
  type TelegramTransportObservationV1,
} from "../../heart/daemon/sanctuary-telegram-authority-gateway"
import {
  createSanctuaryTelegramAuthorityTransport,
  type SanctuaryTelegramAuthorityProtocolClient,
} from "../../senses/telegram-authority-transport"

const update = {
  update_id: 10,
  message: {
    message_id: 110,
    from: { id: 42 },
    chat: { id: 42, type: "private" },
    text: "hello",
  },
}

const keys = generateKeyPairSync("ed25519")
const publicKeyDigest = sanctuaryAuthorityPublicKeyDigest(keys.privateKey)
const digestUpdate = (value: unknown): string => `tgu_${createHash("sha256")
  .update(`ouroboros.telegram.update.v1\0${JSON.stringify(value)}`, "utf8")
  .digest("base64url")}`
const signObservation = (payload: TelegramTransportObservationV1) => signAuthorityPayload({
  domain: "ouro.sanctuary.telegram-observation.v1",
  keyId: "issuer-1",
  payload,
  privateKey: keys.privateKey,
})
const observation = signObservation({
    targetHost: "sanctuary",
    botId: "123456",
    updateId: 10,
    updateClass: "message" as const,
    userId: "42",
    chatId: "42",
    ownerEligible: true,
    messageId: "110",
    callbackQueryId: null,
    rawUpdateDigest: digestUpdate(update),
    observedAt: "2026-09-16T23:00:00.000Z",
    settlement: "pending" as const,
    nonce: "b".repeat(43),
    publicKeyDigest,
})
const verification = {
  expectedTargetHost: "sanctuary",
  expectedBotId: "123456",
  expectedOwnerUserId: "42",
  expectedOwnerChatId: "42",
  expectedKeyId: "issuer-1",
  expectedPublicKeyDigest: publicKeyDigest,
  publicKey: keys.publicKey,
}
const observationFor = (
  telegramUpdate: typeof update | {
    update_id: number
    callback_query: {
      id: string
      from: { id: number }
      message: { message_id: number; chat: { id: number; type: string } }
      data: string
    }
  },
  ownerEligible: boolean,
) => {
  const callback = "callback_query" in telegramUpdate ? telegramUpdate.callback_query : undefined
  const message = "message" in telegramUpdate ? telegramUpdate.message : undefined
  return signObservation({
    ...observation.payload,
    updateId: telegramUpdate.update_id,
    updateClass: callback ? "callback" : "message",
    userId: String(callback?.from.id ?? message!.from.id),
    chatId: String(callback?.message.chat.id ?? message!.chat.id),
    ownerEligible,
    messageId: String(callback?.message.message_id ?? message!.message_id),
    callbackQueryId: callback?.id ?? null,
    rawUpdateDigest: digestUpdate(telegramUpdate),
    nonce: createHash("sha256").update(JSON.stringify(telegramUpdate)).digest("base64url"),
  })
}

function fixture() {
  const request = vi.fn(async (method: string) => {
    if (method === "telegram.poll") return { observation, update }
    if (method === "telegram.settle") return { settled: true, cursor: 11 }
    if (method === "telegram.request") return { message_id: 71 }
    if (method === "telegram.file") return { bodyBase64: Buffer.from("file-body").toString("base64"), contentType: "text/plain" }
    if (method === "telegram.chat.admit") return { admitted: true }
    if (method === "telegram.chat.revoke") return { revoked: true }
    throw new Error("unexpected method")
  })
  const close = vi.fn()
  const client: SanctuaryTelegramAuthorityProtocolClient = { request, close }
  return { client, close, request, transport: createSanctuaryTelegramAuthorityTransport(client, verification) }
}

describe("Sanctuary Telegram authority transport", () => {
  it("verifies a redacted host callback without replacing its signed raw-update commitment", async () => {
    const raw = { update_id: 12, callback_query: { id: "host-12", from: { id: 42 }, message: { message_id: 112, chat: { id: 42, type: "private" } }, data: "ouh:private" } }
    const projected = { ...raw, callback_query: { ...raw.callback_query, data: "root-host-callback" } }
    const artifact = signObservation({
      ...observationFor(raw, true).payload,
      deliveryUpdateDigest: digestUpdate(projected),
    } as TelegramTransportObservationV1)
    const f = fixture()
    f.request.mockResolvedValueOnce({ observation: artifact, update: projected } as never)
    await expect(f.transport.api.request("getUpdates", { offset: 0, timeout: 50, allowed_updates: ["message", "callback_query"] })).resolves.toEqual([projected])
    expect(f.transport.metadataForUpdate(projected)).toMatchObject({ rawUpdateDigest: digestUpdate(raw), deliveryUpdateDigest: digestUpdate(projected) })
    expect(() => f.transport.metadataForUpdate(raw)).toThrow(/changed after verification/u)
    await expect(f.transport.settleTransport(projected, "completed")).resolves.toBeUndefined()
  })

  it("converts root polling into the existing Bot API update shape and settles the exact observation", async () => {
    const f = fixture()
    await expect(f.transport.api.request("getUpdates", {
      offset: 0,
      timeout: 50,
      allowed_updates: ["message", "callback_query"],
    })).resolves.toEqual([update])
    const metadata = f.transport.metadataForUpdate(update)
    expect(metadata).toMatchObject({
      schemaVersion: 1,
      observationDigest: authorityArtifactDigest(observation.domain, observation.payload),
      targetHost: "sanctuary",
      botId: "123456",
      updateId: 10,
      userId: "42",
      chatId: "42",
      ownerEligible: true,
      keyId: "issuer-1",
      publicKeyDigest,
    })

    expect(Object.isFrozen(metadata)).toBe(true)
    expect(() => f.transport.metadataForUpdate({
      ...update,
      message: { ...update.message, text: "changed" },
    })).toThrow(/changed after verification/u)
    await f.transport.settleTransport(update, "completed")
    expect(f.request).toHaveBeenNthCalledWith(2, "telegram.settle", {
      updateId: 10,
      observationDigest: authorityArtifactDigest(observation.domain, observation.payload),
      outcome: "completed",
    })
    expect(f.transport.metadataForUpdate(update)).toBeNull()
    await f.transport.api.request("getMe", {})
    expect(f.request).toHaveBeenLastCalledWith("telegram.request", { method: "getMe", body: {} })
  })

  it("accepts signed non-owner messages and owner callbacks with exact immutable metadata", async () => {
    const strangerUpdate = {
      update_id: 12,
      message: {
        message_id: 112,
        from: { id: 84 },
        chat: { id: 84, type: "private" },
        text: "hello",
      },
    }
    const callbackUpdate = {
      update_id: 13,
      callback_query: {
        id: "callback-13",
        from: { id: 42 },
        message: { message_id: 113, chat: { id: 42, type: "private" } },
        data: "approve",
      },
    }
    for (const [telegramUpdate, ownerEligible] of [[strangerUpdate, false], [callbackUpdate, true]] as const) {
      const transport = createSanctuaryTelegramAuthorityTransport({
        request: vi.fn(async () => ({ update: telegramUpdate, observation: observationFor(telegramUpdate, ownerEligible) })),
        close: vi.fn(),
      }, verification)
      await expect(transport.api.request("getUpdates", {
        offset: 0, timeout: 50, allowed_updates: ["message", "callback_query"],
      })).resolves.toEqual([telegramUpdate])
      expect(transport.metadataForUpdate(telegramUpdate)).toMatchObject({
        updateId: telegramUpdate.update_id,
        ownerEligible,
        updateClass: "callback_query" in telegramUpdate ? "callback" : "message",
      })
    }
  })

  it("refuses altered signatures, pins, payload fields, coordinates, eligibility, and payload shape", async () => {
    const otherKeys = generateKeyPairSync("ed25519")
    const signed = (payload: TelegramTransportObservationV1, domain = observation.domain, keyId = observation.keyId) =>
      signAuthorityPayload({ domain, keyId, payload, privateKey: keys.privateKey })
    const candidates = [
      { artifact: { ...observation, signature: `${observation.signature[0] === "A" ? "B" : "A"}${observation.signature.slice(1)}` } },
      { artifact: signed(observation.payload, "wrong.domain") },
      { artifact: signed(observation.payload, observation.domain, "wrong-key") },
      { artifact: signed({ ...observation.payload, targetHost: "wrong-host" }) },
      { artifact: signed({ ...observation.payload, botId: "654321" }) },
      { artifact: signed({ ...observation.payload, rawUpdateDigest: `tgu_${"a".repeat(43)}` }) },
      { artifact: signed({ ...observation.payload, userId: "84" }) },
      { artifact: signed({ ...observation.payload, chatId: "84" }) },
      { artifact: signed({ ...observation.payload, messageId: "999" }) },
      { artifact: signed({ ...observation.payload, ownerEligible: false }) },
      { artifact: signed({ ...observation.payload, observedAt: 42 } as TelegramTransportObservationV1) },
      { artifact: signed({ ...observation.payload, observedAt: "not-a-time" }) },
      { artifact: signed({ ...observation.payload, extra: true } as TelegramTransportObservationV1) },
    ]
    for (const candidate of candidates) {
      const transport = createSanctuaryTelegramAuthorityTransport({
        request: vi.fn(async () => ({ observation: candidate.artifact, update })),
        close: vi.fn(),
      }, verification)
      await expect(transport.api.request("getUpdates", {
        offset: 0, timeout: 50, allowed_updates: ["message", "callback_query"],
      })).rejects.toThrow(/invalid|changed/u)
    }
    const wrongKeyTransport = createSanctuaryTelegramAuthorityTransport({
      request: vi.fn(async () => ({ observation, update })),
      close: vi.fn(),
    }, { ...verification, publicKey: otherKeys.publicKey })
    await expect(wrongKeyTransport.api.request("getUpdates", {
      offset: 0, timeout: 50, allowed_updates: ["message", "callback_query"],
    })).rejects.toThrow(/invalid/u)

    const unsupportedUpdate = { update_id: 14 }
    const unsupportedArtifact = signObservation({
      ...observation.payload,
      updateId: 14,
      userId: "",
      chatId: "",
      ownerEligible: false,
      messageId: null,
      rawUpdateDigest: digestUpdate(unsupportedUpdate),
    })
    const unsupportedTransport = createSanctuaryTelegramAuthorityTransport({
      request: vi.fn(async () => ({ observation: unsupportedArtifact, update: unsupportedUpdate })),
      close: vi.fn(),
    }, verification)
    await expect(unsupportedTransport.api.request("getUpdates", {
      offset: 0, timeout: 50, allowed_updates: ["message", "callback_query"],
    })).rejects.toThrow(/unsupported/u)
  })

  it("retains a newer current observation when an older captured update settles", async () => {
    const f = fixture()
    await f.transport.api.request("getUpdates", {
      offset: 0, timeout: 50, allowed_updates: ["message", "callback_query"],
    })
    const update11 = { ...update, update_id: 11 }
    const observation11 = signObservation({
      ...observation.payload,
      updateId: 11,
      rawUpdateDigest: digestUpdate(update11),
    })
    f.request.mockResolvedValueOnce({ observation: observation11, update: update11 })
    await f.transport.api.request("getUpdates", {
      offset: 0, timeout: 50, allowed_updates: ["message", "callback_query"],
    })
    await f.transport.settleTransport(update, "completed")
    await f.transport.api.request("getMe", {})
    expect(f.request).toHaveBeenLastCalledWith("telegram.request", {
      method: "getMe",
      body: {},
      observation: {
        updateId: 11,
        observationDigest: authorityArtifactDigest(observation11.domain, observation11.payload),
      },
    })
  })

  it("proxies non-poll Telegram methods through the closed root request operation", async () => {
    const f = fixture()
    await f.transport.api.request("getUpdates", {
      offset: 0,
      timeout: 50,
      allowed_updates: ["message", "callback_query"],
    })
    await expect(f.transport.api.request("sendMessage", { chat_id: "42", text: "hello" })).resolves.toEqual({ message_id: 71 })
    expect(f.request).toHaveBeenCalledWith("telegram.request", {
      method: "sendMessage",
      body: { chat_id: "42", text: "hello" },
      observation: {
        updateId: 10,
        observationDigest: authorityArtifactDigest(observation.domain, observation.payload),
      },
    })
    const response = await f.transport.downloadFile("documents/file.txt")
    await expect(response.text()).resolves.toBe("file-body")
    expect(response.headers.get("content-type")).toBe("text/plain")
    expect(f.request).toHaveBeenCalledWith("telegram.file", { filePath: "documents/file.txt" })
    await f.transport.admitChat({ admissionId: "a".repeat(20), updateId: 10, userId: "84", chatId: "84" })
    expect(f.request).toHaveBeenCalledWith("telegram.chat.admit", {
      admissionId: "a".repeat(20), updateId: 10, userId: "84", chatId: "84",
    })
    await f.transport.revokeChat({ userId: "84", chatId: "84" })
    expect(f.request).toHaveBeenCalledWith("telegram.chat.revoke", { userId: "84", chatId: "84" })
  })

  it("returns an empty poll, refuses missing settlement authority, respects abort, and closes once", async () => {
    const f = fixture()
    f.request.mockResolvedValueOnce(null)
    await expect(f.transport.api.request("getUpdates", {
      offset: 0,
      timeout: 50,
      allowed_updates: ["message", "callback_query"],
    })).resolves.toEqual([])
    await expect(f.transport.settleTransport(update, "completed")).rejects.toThrow(/observation/u)
    await expect(f.transport.api.request("getUpdates", {})).rejects.toThrow(/poll/u)
    const controller = new AbortController()
    controller.abort(new Error("cancelled"))
    await expect(f.transport.api.request("getMe", {}, controller.signal)).rejects.toThrow("cancelled")
    f.transport.api.stop()
    f.transport.api.stop()
    expect(f.close).toHaveBeenCalledOnce()
    await expect(f.transport.api.request("getMe", {})).rejects.toThrow(/stopped/u)
  })

  it("refuses malformed or changed root poll responses", async () => {
    for (const candidate of [
      {},
      { observation: null, update },
      { observation: { payload: null }, update },
      { observation, update: null },
      { observation, update: { update_id: 1.5 } },
      { observation, update: { ...update, update_id: 11 } },
    ]) {
      const request = vi.fn(async () => candidate)
      const transport = createSanctuaryTelegramAuthorityTransport({ request, close: vi.fn() }, verification)
      await expect(transport.api.request("getUpdates", {
        offset: 0,
        timeout: 50,
        allowed_updates: ["message", "callback_query"],
      })).rejects.toThrow(/response/u)
    }

    const f = fixture()
    await f.transport.api.request("getUpdates", {
      offset: 0,
      timeout: 50,
      allowed_updates: ["message", "callback_query"],
    })
    f.request.mockResolvedValueOnce({
      observation: signObservation({ ...observation.payload, nonce: "e".repeat(43) }),
      update,
    })
    await expect(f.transport.api.request("getUpdates", {
      offset: 0,
      timeout: 50,
      allowed_updates: ["message", "callback_query"],
    })).rejects.toThrow(/changed/u)
  })

  it("refuses malformed root file responses", async () => {
    for (const candidate of [
      null,
      {},
      { bodyBase64: 42 },
      { bodyBase64: "", contentType: 42 },
      { bodyBase64: "*" },
      { bodyBase64: Buffer.alloc(20_000_001).toString("base64") },
    ]) {
      const transport = createSanctuaryTelegramAuthorityTransport({
        request: vi.fn(async () => candidate),
        close: vi.fn(),
        }, verification)
      await expect(transport.downloadFile("documents/file.bin")).rejects.toThrow(/file response/u)
    }
    const transport = createSanctuaryTelegramAuthorityTransport({
      request: vi.fn(async () => ({ bodyBase64: Buffer.from("data").toString("base64") })),
      close: vi.fn(),
    }, verification)
    const response = await transport.downloadFile("documents/file.bin")
    expect(response.headers.get("content-type")).toBeNull()
  })
})
