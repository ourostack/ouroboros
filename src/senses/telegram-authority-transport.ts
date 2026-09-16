import { authorityArtifactDigest, type SignedAuthorityPayload } from "../heart/daemon/sanctuary-authority-codec"
import type { TelegramTransportObservationV1 } from "../heart/daemon/sanctuary-telegram-authority-gateway"
import type { TelegramBotApi, TelegramUpdate } from "./telegram-client"

export interface SanctuaryTelegramAuthorityProtocolClient {
  request(method: string, params: Record<string, unknown>): Promise<unknown>
  close(): void
}

export interface SanctuaryTelegramAuthorityTransport {
  api: TelegramBotApi
  settleTransport(update: TelegramUpdate, outcome: "completed" | "indeterminate"): Promise<void>
  downloadFile(filePath: string): Promise<Response>
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

export function createSanctuaryTelegramAuthorityTransport(
  client: SanctuaryTelegramAuthorityProtocolClient,
): SanctuaryTelegramAuthorityTransport {
  const observations = new Map<number, SignedAuthorityPayload<TelegramTransportObservationV1>>()
  let stopped = false
  const api: TelegramBotApi = {
    async request<T>(method: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
      if (signal?.aborted) throw signal.reason
      if (stopped) throw new Error("Sanctuary Telegram authority transport is stopped")
      if (method !== "getUpdates") {
        return await client.request("telegram.request", { method, body }) as T
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
      const existing = observations.get(update.update_id)
      if (
        existing
        && authorityArtifactDigest(existing.domain, existing.payload)
          !== authorityArtifactDigest(observation.domain, observation.payload)
      ) {
        throw new Error("Sanctuary Telegram authority observation changed during redelivery")
      }
      observations.set(update.update_id, observation)
      return [update] as T
    },
    stop() {
      if (stopped) return
      stopped = true
      client.close()
    },
  }

  return {
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
    async settleTransport(update, outcome) {
      const observation = observations.get(update.update_id)
      if (!observation) throw new Error("Sanctuary Telegram authority observation is unavailable for settlement")
      await client.request("telegram.settle", {
        updateId: update.update_id,
        observationDigest: authorityArtifactDigest(observation.domain, observation.payload),
        outcome,
      })
      observations.delete(update.update_id)
    },
  }
}
