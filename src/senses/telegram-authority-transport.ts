import { createHash, type KeyLike } from "node:crypto"
import { emitNervesEvent } from "../nerves/runtime"
import { authorityArtifactDigest, verifyAuthorityPayload, type SignedAuthorityPayload } from "../heart/daemon/sanctuary-authority-codec"
import type { TelegramTransportObservationV1 } from "../heart/daemon/sanctuary-telegram-authority-gateway"
import type { TelegramAuthorityTransportMetadata, TelegramBotApi, TelegramUpdate } from "./telegram-client"
import { createRootHostApprovalPort, type RootHostApprovalPort } from "./root-host-approval-port"

export interface SanctuaryTelegramAuthorityProtocolClient {
  request(method: string, params: Record<string, unknown>): Promise<unknown>
  close(): void
}

export interface SanctuaryTelegramAuthorityTransport {
  api: TelegramBotApi
  settleTransport(update: TelegramUpdate, outcome: "completed" | "indeterminate"): Promise<void>
  downloadFile(filePath: string): Promise<Response>
  admitChat(input: { admissionId: string; updateId: number; userId: string; chatId: string }): Promise<void>
  revokeChat(input: { userId: string; chatId: string }): Promise<void>
  metadataForUpdate(update: TelegramUpdate): TelegramAuthorityTransportMetadata | null
  hostApproval?: RootHostApprovalPort
}

export interface SanctuaryTelegramAuthorityVerification {
  expectedTargetHost: string
  expectedBotId: string
  expectedOwnerUserId: string
  expectedOwnerChatId: string
  expectedKeyId: string
  expectedPublicKeyDigest: string
  publicKey: KeyLike
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function validPollBody(body: Record<string, unknown>): boolean {
  return Object.keys(body).sort().join(",") === "allowed_updates,offset,timeout"
    && Number.isSafeInteger(body.offset)
    && (body.offset as number) >= 0
    && body.timeout === 50
    && Array.isArray(body.allowed_updates)
    && body.allowed_updates.length === 2
    && body.allowed_updates[0] === "message"
    && body.allowed_updates[1] === "callback_query"
}

function rawUpdateDigest(update: TelegramUpdate): string {
  return `tgu_${createHash("sha256")
    .update(`ouroboros.telegram.update.v1\0${JSON.stringify(update)}`, "utf8")
    .digest("base64url")}`
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  return actual.length === expected.length && actual.every((key, index) => key === expected[index])
}

function canonicalTime(value: unknown): value is string {
  if (typeof value !== "string") return false
  const instant = new Date(value)
  return !Number.isNaN(instant.getTime()) && instant.toISOString() === value
}

function verifyObservation(
  artifact: SignedAuthorityPayload<TelegramTransportObservationV1>,
  update: TelegramUpdate,
  verification: SanctuaryTelegramAuthorityVerification,
): TelegramAuthorityTransportMetadata {
  let payload: TelegramTransportObservationV1
  try {
    payload = verifyAuthorityPayload({
      artifact,
      expectedDomain: "ouro.sanctuary.telegram-observation.v1",
      expectedKeyId: verification.expectedKeyId,
      publicKey: verification.publicKey,
    })
  } catch (error) {
    throw new Error("Sanctuary Telegram authority poll response is invalid", { cause: error })
  }
  if (
    !isObject(payload)
    || !exactKeys(payload, [
      "targetHost", "botId", "updateId", "updateClass", "userId", "chatId", "ownerEligible",
      "messageId", "callbackQueryId", "rawUpdateDigest", "observedAt", "settlement", "nonce", "publicKeyDigest",
      ...(Object.hasOwn(payload, "deliveryUpdateDigest") ? ["deliveryUpdateDigest"] : []),
    ])
    || payload.targetHost !== verification.expectedTargetHost
    || payload.botId !== verification.expectedBotId
    || payload.publicKeyDigest !== verification.expectedPublicKeyDigest
    || payload.updateId !== update.update_id
    || !["message", "callback"].includes(String(payload.updateClass))
    || typeof payload.userId !== "string"
    || typeof payload.chatId !== "string"
    || typeof payload.ownerEligible !== "boolean"
    || (payload.messageId !== null && typeof payload.messageId !== "string")
    || (payload.callbackQueryId !== null && typeof payload.callbackQueryId !== "string")
    || typeof payload.rawUpdateDigest !== "string"
    || !/^tgu_[A-Za-z0-9_-]{43}$/u.test(payload.rawUpdateDigest)
    || (Object.hasOwn(payload, "deliveryUpdateDigest") && typeof payload.deliveryUpdateDigest !== "string")
    || (payload.deliveryUpdateDigest ?? payload.rawUpdateDigest) !== rawUpdateDigest(update)
    || !canonicalTime(payload.observedAt)
    || payload.settlement !== "pending"
    || typeof payload.nonce !== "string"
    || !/^[A-Za-z0-9_-]{43}$/u.test(payload.nonce)
  ) {
    throw new Error("Sanctuary Telegram authority observation payload is invalid")
  }
  const callback = update.callback_query
  const message = update.message
  if ((!callback && !message) || (callback && message) || (callback && (!callback.message || !callback.from)) || (message && !message.from)) {
    throw new Error("Sanctuary Telegram authority observation update is unsupported")
  }
  const updateClass = callback ? "callback" : "message"
  const userId = String(callback ? callback.from.id : message!.from!.id)
  const chatId = String(callback ? callback.message!.chat.id : message!.chat.id)
  const messageId = String(callback ? callback.message!.message_id : message!.message_id)
  const callbackQueryId = callback ? callback.id : null
  if (
    payload.updateClass !== updateClass
    || payload.userId !== userId
    || payload.chatId !== chatId
    || payload.messageId !== messageId
    || payload.callbackQueryId !== callbackQueryId
    || payload.ownerEligible !== (userId === verification.expectedOwnerUserId && chatId === verification.expectedOwnerChatId)
  ) {
    throw new Error("Sanctuary Telegram authority observation coordinates changed")
  }
  return Object.freeze({
    schemaVersion: 1,
    observationDigest: authorityArtifactDigest(artifact.domain, payload),
    targetHost: payload.targetHost,
    botId: payload.botId,
    updateId: payload.updateId,
    updateClass: payload.updateClass,
    userId: payload.userId,
    chatId: payload.chatId,
    ownerEligible: payload.ownerEligible,
    messageId: payload.messageId,
    callbackQueryId: payload.callbackQueryId,
    rawUpdateDigest: payload.rawUpdateDigest,
    ...(payload.deliveryUpdateDigest ? { deliveryUpdateDigest: payload.deliveryUpdateDigest } : {}),
    observedAt: payload.observedAt,
    keyId: artifact.keyId,
    publicKeyDigest: payload.publicKeyDigest,
  })
}

export function createSanctuaryTelegramAuthorityTransport(
  client: SanctuaryTelegramAuthorityProtocolClient,
  verification: SanctuaryTelegramAuthorityVerification,
): SanctuaryTelegramAuthorityTransport {
  emitNervesEvent({ component: "senses", event: "senses.sanctuary_authority_transport_created", message: "Tokenless Sanctuary Telegram authority transport created" })
  verification = Object.freeze({ ...verification })
  const observations = new Map<number, SignedAuthorityPayload<TelegramTransportObservationV1>>()
  const metadata = new Map<number, TelegramAuthorityTransportMetadata>()
  const callbacks = new Map<number, unknown>()
  let currentObservation: SignedAuthorityPayload<TelegramTransportObservationV1> | null = null
  let stopped = false
  const api: TelegramBotApi = {
    async request<T>(method: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
      if (signal?.aborted) throw signal.reason
      if (stopped) throw new Error("Sanctuary Telegram authority transport is stopped")
      if (method !== "getUpdates") {
        return await client.request("telegram.request", {
          method,
          body,
          ...(currentObservation ? {
            observation: {
              updateId: currentObservation.payload.updateId,
              observationDigest: authorityArtifactDigest(currentObservation.domain, currentObservation.payload),
            },
          } : {}),
        }) as T
      }
      if (!validPollBody(body)) throw new Error("Sanctuary Telegram authority poll request is invalid")
      const result = await client.request("telegram.poll", {})
      if (result === null) return [] as T
      if (
        !isObject(result)
        || !isObject(result.observation)
        || !isObject(result.observation.payload)
        || !isObject(result.update)
        || !Number.isSafeInteger(result.update.update_id)
        || result.observation.payload.updateId !== result.update.update_id
      ) {
        throw new Error("Sanctuary Telegram authority poll response is invalid")
      }
      const update = result.update as unknown as TelegramUpdate
      const observation = result.observation as unknown as SignedAuthorityPayload<TelegramTransportObservationV1>
      const verifiedMetadata = verifyObservation(observation, update, verification)
      const existing = observations.get(update.update_id)
      if (
        existing
        && authorityArtifactDigest(existing.domain, existing.payload)
          !== authorityArtifactDigest(observation.domain, observation.payload)
      ) {
        throw new Error("Sanctuary Telegram authority observation changed during redelivery")
      }
      observations.set(update.update_id, observation)
      metadata.set(update.update_id, verifiedMetadata)
      callbacks.set(update.update_id, result.hostCallback)
      currentObservation = observation
      return [update] as T
    },
    stop() {
      if (stopped) return
      stopped = true
      client.close()
    },
  }

  const transport: SanctuaryTelegramAuthorityTransport = {
    api,
    async downloadFile(filePath) {
      const result = await client.request("telegram.file", { filePath })
      if (
        !isObject(result)
        || typeof result.bodyBase64 !== "string"
        || (result.contentType !== undefined && typeof result.contentType !== "string")
      ) {
        throw new Error("Sanctuary Telegram authority file response is invalid")
      }
      const body = Buffer.from(result.bodyBase64, "base64")
      if (body.toString("base64") !== result.bodyBase64 || body.length > 20_000_000) {
        throw new Error("Sanctuary Telegram authority file response is invalid")
      }
      return new Response(body, {
        headers: result.contentType ? { "content-type": result.contentType } : undefined,
      })
    },
    async admitChat(input) {
      await client.request("telegram.chat.admit", input)
    },
    async revokeChat(input) {
      await client.request("telegram.chat.revoke", input)
    },
    metadataForUpdate(update) {
      const value = metadata.get(update.update_id)
      if (!value) return null
      if ((value.deliveryUpdateDigest ?? value.rawUpdateDigest) !== rawUpdateDigest(update)) {
        throw new Error("Sanctuary Telegram authority update changed after verification")
      }
      return value
    },
    async settleTransport(update, outcome) {
      const observation = observations.get(update.update_id)
      if (!observation) throw new Error("Sanctuary Telegram authority observation is unavailable for settlement")
      await client.request("telegram.settle", {
        updateId: update.update_id,
        observationDigest: authorityArtifactDigest(observation.domain, observation.payload),
        outcome,
      })
      observations.delete(update.update_id)
      metadata.delete(update.update_id)
      callbacks.delete(update.update_id)
      if (currentObservation?.payload.updateId === update.update_id) currentObservation = null
    },
  }
  transport.hostApproval = createRootHostApprovalPort(client, verification, {
    current: () => currentObservation ? metadata.get(currentObservation.payload.updateId)! : null,
    lookup: (update) => {
      const value = transport.metadataForUpdate(update)
      return value ? { metadata: value, hostCallback: callbacks.get(update.update_id) } : null
    },
    stopped: () => stopped,
  })
  return transport
}
