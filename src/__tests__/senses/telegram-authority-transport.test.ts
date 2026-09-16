import { describe, expect, it, vi } from "vitest"

import { authorityArtifactDigest } from "../../heart/daemon/sanctuary-authority-codec"
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

const observation = {
  schemaVersion: 1 as const,
  domain: "ouro.sanctuary.telegram-observation.v1",
  keyId: "issuer-1",
  payload: {
    targetHost: "sanctuary",
    botId: "123456",
    updateId: 10,
    updateClass: "message" as const,
    userId: "42",
    chatId: "42",
    ownerEligible: true,
    messageId: "110",
    callbackQueryId: null,
    rawUpdateDigest: "tgu_" + "a".repeat(43),
    observedAt: "2026-09-16T23:00:00.000Z",
    settlement: "pending" as const,
    nonce: "b".repeat(43),
    publicKeyDigest: `sha256:${"c".repeat(64)}`,
  },
  signature: "d".repeat(86),
}

function fixture() {
  const request = vi.fn(async (method: string) => {
    if (method === "telegram.poll") return { observation, update }
    if (method === "telegram.settle") return { settled: true, cursor: 11 }
    if (method === "telegram.request") return { message_id: 71 }
    throw new Error("unexpected method")
  })
  const close = vi.fn()
  const client: SanctuaryTelegramAuthorityProtocolClient = { request, close }
  return { client, close, request, transport: createSanctuaryTelegramAuthorityTransport(client) }
}

describe("Sanctuary Telegram authority transport", () => {
  it("converts root polling into the existing Bot API update shape and settles the exact observation", async () => {
    const f = fixture()
    await expect(f.transport.api.request("getUpdates", {
      offset: 0,
      timeout: 50,
      allowed_updates: ["message", "callback_query"],
    })).resolves.toEqual([update])
    await f.transport.settleTransport(update, "completed")
    expect(f.request).toHaveBeenNthCalledWith(2, "telegram.settle", {
      updateId: 10,
      observationDigest: authorityArtifactDigest(observation.domain, observation.payload),
      outcome: "completed",
    })
  })

  it("proxies non-poll Telegram methods through the closed root request operation", async () => {
    const f = fixture()
    await expect(f.transport.api.request("sendMessage", { chat_id: "42", text: "hello" })).resolves.toEqual({ message_id: 71 })
    expect(f.request).toHaveBeenCalledWith("telegram.request", {
      method: "sendMessage",
      body: { chat_id: "42", text: "hello" },
    })
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
      const transport = createSanctuaryTelegramAuthorityTransport({ request, close: vi.fn() })
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
      observation: { ...observation, payload: { ...observation.payload, nonce: "e".repeat(43) } },
      update,
    })
    await expect(f.transport.api.request("getUpdates", {
      offset: 0,
      timeout: 50,
      allowed_updates: ["message", "callback_query"],
    })).rejects.toThrow(/changed/u)
  })
})
