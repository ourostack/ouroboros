import * as fs from "node:fs"
import * as net from "node:net"
import * as path from "node:path"

import type { TelegramBotApi, TelegramUpdate } from "../../senses/telegram-client"
import { FIXED_ADMISSION_ACKNOWLEDGEMENT } from "../../senses/telegram-effect-adapter"
import { SocketFrontendClient } from "../frontend-socket-client"
import { authorityArtifactDigest } from "./sanctuary-authority-codec"
import {
  FileSanctuaryTelegramAuthorityGateway,
  type SanctuaryTelegramSettlement,
} from "./sanctuary-telegram-authority-gateway"
import { FileSanctuaryHostAuthority, type HostProposalRequestV1 } from "./sanctuary-host-authority"
import type { SignedAuthorityPayload } from "./sanctuary-authority-codec"

const PROTOCOL_VERSION = 1
const DEFAULT_MAX_REQUEST_BYTES = 256 * 1024
const DEFAULT_CONNECTION_TIMEOUT_MS = 30_000
const MAX_TELEGRAM_ATTACHMENT_BYTES = 20_000_000
const SAFE_TELEGRAM_FILE_PATH = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._/-]{1,512}$/u

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  return actual.length === expected.length && actual.every((key, index) => key === expected[index])
}

function emptyParams(value: unknown): value is Record<string, never> {
  return isObject(value) && Object.keys(value).length === 0
}

function exactBody(value: unknown, required: readonly string[], optional: readonly string[] = []): value is Record<string, unknown> {
  if (!isObject(value)) return false
  const keys = Object.keys(value)
  return required.every((key) => keys.includes(key))
    && keys.every((key) => required.includes(key) || optional.includes(key))
}

function boundedText(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength
}

export class SanctuaryTelegramAuthorityService {
  readonly #api: TelegramBotApi
  readonly #gateway: FileSanctuaryTelegramAuthorityGateway
  readonly #downloadFile: ((filePath: string) => Promise<{ body: Buffer; contentType?: string }>) | undefined
  readonly #hostAuthority: FileSanctuaryHostAuthority | undefined
  readonly #hostExecutor: {
    execute(permit: SignedAuthorityPayload<Record<string, unknown>>): Promise<unknown>
    acknowledge?(permitId: string): void
  } | undefined
  readonly #allowedFilePaths = new Set<string>()
  readonly #hostExecutions = new Map<string, Promise<void>>()
  readonly #hostExecutionFailures = new Map<string, string>()
  readonly #hostMaintenanceFailures = new Map<string, string>()

  constructor(options: {
    api: TelegramBotApi
    gateway: FileSanctuaryTelegramAuthorityGateway
    hostAuthority?: FileSanctuaryHostAuthority
    hostExecutor?: {
      execute(permit: SignedAuthorityPayload<Record<string, unknown>>): Promise<unknown>
      acknowledge?(permitId: string): void
    }
    downloadFile?: (filePath: string) => Promise<{ body: Buffer; contentType?: string }>
  }) {
    this.#api = options.api
    this.#gateway = options.gateway
    this.#hostAuthority = options.hostAuthority
    this.#hostExecutor = options.hostExecutor
    this.#downloadFile = options.downloadFile
  }

  async dispatch(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (this.#hostAuthority) {
      for (const registrationId of this.#hostAuthority.expireRegistrations()) {
        await this.#maintainHostCard(registrationId)
      }
    }
    if (method === "telegram.poll") {
      if (!emptyParams(params)) throw new Error("Sanctuary Telegram poll params are invalid")
      const updates = await this.#api.request<TelegramUpdate[]>("getUpdates", {
        offset: this.#gateway.cursor(),
        timeout: 50,
        allowed_updates: ["message", "callback_query"],
      })
      if (!Array.isArray(updates)) throw new Error("Sanctuary Telegram poll result must be an array")
      this.#gateway.capture(updates)
      const observation = this.#gateway.poll()
      if (!observation) return null
      const record = this.#gateway.record(observation.payload.updateId)
      if (!record || record.disposition !== "dispatch") {
        throw new Error("Sanctuary Telegram pending observation state is unavailable")
      }
      const callback = record.rawUpdate.callback_query
      let hostCallback: SignedAuthorityPayload<Record<string, unknown>> | null = null
      if (callback && callback.message && this.#hostAuthority) {
        hostCallback = this.#hostAuthority.claimCallback({
          callbackQueryId: callback.id,
          callbackData: callback.data ?? "",
          telegramMessageId: callback.message.message_id,
          userId: String(callback.from.id),
          chatId: String(callback.message.chat.id),
          callbackObservationDigest: authorityArtifactDigest(observation.domain, observation.payload),
          decidedAt: observation.payload.observedAt,
        })
        if (hostCallback) await this.#maintainHostCard(hostCallback.payload.registrationId as string)
      }
      return {
        observation, update: record.rawUpdate,
        ...(hostCallback ? {
          hostClaimed: true, hostCallback,
          ...(hostCallback.payload.decision ? { hostDecision: hostCallback.payload.decision } : {}),
        } : {}),
      }
    }
    if (method === "telegram.settle") {
      this.#gateway.settle(params as unknown as SanctuaryTelegramSettlement)
      return { settled: true, cursor: this.#gateway.cursor() }
    }
    if (method === "telegram.cursor") {
      if (!emptyParams(params)) throw new Error("Sanctuary Telegram cursor params are invalid")
      return { cursor: this.#gateway.cursor() }
    }
    if (method === "telegram.chat.admit") {
      this.#gateway.admitChat(params as {
        admissionId: string
        updateId: number
        userId: string
        chatId: string
      })
      return { admitted: true }
    }
    if (method === "telegram.chat.revoke") {
      this.#gateway.revokeChat(params as { userId: string; chatId: string })
      return { revoked: true }
    }
    if (method === "telegram.request") {
      if (
        (!exactKeys(params, ["method", "body"]) && !exactKeys(params, ["method", "body", "observation"]))
        || typeof params.method !== "string"
      ) {
        throw new Error("Sanctuary Telegram request params are invalid")
      }
      const requestMethod = params.method
      const body = params.body
      const ownerChatId = this.#gateway.identity().ownerChatId
      if (requestMethod === "getMe") {
        if (!emptyParams(body)) throw new Error("Sanctuary Telegram getMe body is invalid")
      } else if (requestMethod === "sendMessage") {
        if (
          !exactBody(body, ["chat_id", "text"], ["parse_mode", "reply_markup"])
        ) {
          throw new Error("Sanctuary Telegram send body is invalid")
        }
        if (
          !boundedText(body.text, 4_096)
          || (body.parse_mode !== undefined && body.parse_mode !== "HTML")
          || (body.reply_markup !== undefined && !isObject(body.reply_markup))
        ) {
          throw new Error("Sanctuary Telegram send body is invalid")
        }
        const chatId = String(body.chat_id)
        if (
          this.#hostAuthority?.ownsPrompt(body.text)
          || (chatId === ownerChatId && body.reply_markup !== undefined && this.#hostAuthority?.ownerMutationFrozen())
          || (body.reply_markup !== undefined && this.#replyMarkupContainsHostHandle(body.reply_markup))
        ) {
          throw new Error("Sanctuary Telegram host approval content is root-owned")
        }
        const observedStrangerAcknowledgement = body.text === FIXED_ADMISSION_ACKNOWLEDGEMENT
          && isObject(params.observation)
          && exactKeys(params.observation, ["updateId", "observationDigest"])
          && this.#gateway.ownsCurrentObservation({
            updateId: params.observation.updateId as number,
            observationDigest: params.observation.observationDigest as string,
            chatId,
          })
        if (
          chatId !== ownerChatId
          && !observedStrangerAcknowledgement
          && !this.#gateway.isAuthorizedChat(chatId)
        ) {
          throw new Error("Sanctuary Telegram send target is invalid")
        }
      } else if (requestMethod === "editMessageText") {
        if (
          !exactBody(body, ["chat_id", "message_id", "text"], ["parse_mode", "reply_markup"])
          || String(body.chat_id) !== ownerChatId
        ) {
          throw new Error("Sanctuary Telegram edit target is invalid")
        }
        if (
          this.#hostAuthority?.ownsMessage(body.message_id as number)
          || this.#hostAuthority?.ownerMutationFrozen()
          || this.#hostAuthority?.ownsPrompt(body.text as string)
          || (body.reply_markup !== undefined && this.#replyMarkupContainsHostHandle(body.reply_markup))
        ) {
          throw new Error("Sanctuary Telegram host approval message is root-owned")
        }
        if (
          !Number.isSafeInteger(body.message_id)
          || (body.message_id as number) <= 0
          || !boundedText(body.text, 4_096)
          || (body.parse_mode !== undefined && body.parse_mode !== "HTML")
          || (body.reply_markup !== undefined && !isObject(body.reply_markup))
        ) {
          throw new Error("Sanctuary Telegram edit body is invalid")
        }
      } else if (requestMethod === "answerCallbackQuery") {
        if (!exactBody(body, ["callback_query_id"], ["text", "show_alert"])) {
          throw new Error("Sanctuary Telegram callback body is invalid")
        }
        if (
          !boundedText(body.callback_query_id, 256)
          || !this.#gateway.ownsCallbackQuery(body.callback_query_id)
        ) {
          throw new Error("Sanctuary Telegram callback is not root-observed")
        }
        if (
          (body.text !== undefined && !boundedText(body.text, 200))
          || (body.show_alert !== undefined && body.show_alert !== true)
        ) {
          throw new Error("Sanctuary Telegram callback body is invalid")
        }
      } else if (requestMethod === "getFile") {
        if (!exactBody(body, ["file_id"]) || !boundedText(body.file_id, 512)) {
          throw new Error("Sanctuary Telegram file body is invalid")
        }
        if (!this.#gateway.ownsFileId(body.file_id)) {
          throw new Error("Sanctuary Telegram file is not root-observed")
        }
      } else {
        throw new Error("Sanctuary Telegram request method is not available")
      }
      const result = await this.#api.request(requestMethod, body as Record<string, unknown>)
      if (requestMethod === "getFile") {
        if (
          !isObject(result)
          || typeof result.file_path !== "string"
          || !SAFE_TELEGRAM_FILE_PATH.test(result.file_path)
          || (result.file_size !== undefined
            && (!Number.isSafeInteger(result.file_size)
              || (result.file_size as number) < 0
              || (result.file_size as number) > MAX_TELEGRAM_ATTACHMENT_BYTES))
        ) {
          throw new Error("Sanctuary Telegram file metadata is invalid")
        }
        this.#allowedFilePaths.add(result.file_path)
      }
      return result
    }
    if (method === "host.approval") {
      if (!this.#hostAuthority) throw new Error("Sanctuary host authority is unavailable")
      if (!exactKeys(params, ["proposal"])) throw new Error("Sanctuary host approval params are invalid")
      const prepared = this.#hostAuthority.prepare(params.proposal as HostProposalRequestV1)
      try {
        const sent = await this.#api.request("sendMessage", {
          chat_id: this.#gateway.identity().ownerChatId,
          text: prepared.prompt,
          parse_mode: "HTML",
          reply_markup: prepared.replyMarkup,
        })
        if (!isObject(sent) || !Number.isSafeInteger(sent.message_id) || (sent.message_id as number) <= 0) {
          throw new Error("Sanctuary host approval message result is invalid")
        }
        const registration = this.#hostAuthority.commit({
          registrationId: prepared.registrationId,
          telegramMessageId: sent.message_id as number,
        })
        return {
          registration,
          registrationId: prepared.registrationId,
          telegramMessageId: sent.message_id,
          expiresAt: prepared.expiresAt,
        }
      } catch (error) {
        this.#hostAuthority.reconcilePrepared()
        throw error
      }
    }
    if (method === "host.status") {
      if (!this.#hostAuthority) throw new Error("Sanctuary host authority is unavailable")
      if (!exactKeys(params, ["registrationId"]) || (params.registrationId !== null && typeof params.registrationId !== "string")) {
        throw new Error("Sanctuary host status params are invalid")
      }
      if (params.registrationId === null) {
        return { health: this.#hostAuthority.attestStatus(Boolean(this.#hostExecutor) && !this.#hostAuthority.ownerMutationFrozen()) }
      }
      let status = this.#hostAuthority.status(params.registrationId)
      if (!status) return null
      if (status.state === "executed") {
        try {
          if (
            !isObject(status.receipt)
            || status.receipt.schemaVersion !== 1
            || typeof status.receipt.domain !== "string"
            || typeof status.receipt.keyId !== "string"
            || typeof status.receipt.signature !== "string"
            || !isObject(status.receipt.payload)
          ) {
            throw new Error("Sanctuary host terminal receipt is invalid")
          }
          const terminalReceipt: SignedAuthorityPayload<Record<string, unknown>> = {
            schemaVersion: 1,
            domain: status.receipt.domain,
            keyId: status.receipt.keyId,
            signature: status.receipt.signature,
            payload: status.receipt.payload,
          }
          await this.#completeHostMaintenance(
            params.registrationId,
            terminalReceipt,
          )
          this.#hostMaintenanceFailures.delete(params.registrationId)
          status = this.#hostAuthority.status(params.registrationId)!
        } catch {
          this.#hostMaintenanceFailures.set(params.registrationId, "Sanctuary host terminal cleanup is pending")
        }
      } else {
        await this.#maintainHostCard(params.registrationId)
        status = this.#hostAuthority.status(params.registrationId)!
      }
      const result = {
        ...status,
        execution: this.#hostExecutions.has(params.registrationId)
          ? "running"
          : this.#hostExecutionFailures.has(params.registrationId)
            ? "reconciliation_required"
            : status.state === "permitted"
              ? "reconciliation_required"
              : "terminal",
        ...(this.#hostExecutionFailures.has(params.registrationId)
          ? { executionError: this.#hostExecutionFailures.get(params.registrationId) }
          : {}),
        ...(this.#hostMaintenanceFailures.has(params.registrationId)
          ? { maintenanceError: this.#hostMaintenanceFailures.get(params.registrationId) }
          : {}),
      }
      return { ...result, authority: this.#hostAuthority.attestStatus(result) }
    }
    if (method === "host.execute") {
      if (!this.#hostAuthority || !this.#hostExecutor) throw new Error("Sanctuary host execution is unavailable")
      if (!exactKeys(params, ["correlation"]) || !isObject(params.correlation)) {
        throw new Error("Sanctuary host execution params are invalid")
      }
      const permit = this.#hostAuthority.issuePermit(params.correlation as Parameters<FileSanctuaryHostAuthority["issuePermit"]>[0])
      const registrationId = (params.correlation as Record<string, unknown>).registrationId as string
      const execution = this.#completeHostExecution(registrationId, permit)
      this.#hostExecutions.set(registrationId, execution)
      void execution.finally(() => this.#hostExecutions.delete(registrationId)).catch(() => undefined)
      return {
        registrationId,
        permitId: permit.payload.permitId,
        state: "executing",
      }
    }
    if (method === "telegram.file") {
      if (
        !exactKeys(params, ["filePath"])
        || typeof params.filePath !== "string"
        || !SAFE_TELEGRAM_FILE_PATH.test(params.filePath)
        || !this.#allowedFilePaths.has(params.filePath)
      ) {
        throw new Error("Sanctuary Telegram file path is not root-observed")
      }
      if (!this.#downloadFile) throw new Error("Sanctuary Telegram file transport is unavailable")
      const result = await this.#downloadFile(params.filePath)
      if (
        !Buffer.isBuffer(result.body)
        || result.body.length > MAX_TELEGRAM_ATTACHMENT_BYTES
        || (result.contentType !== undefined && !boundedText(result.contentType, 256))
      ) {
        throw new Error("Sanctuary Telegram file response is invalid")
      }
      return {
        bodyBase64: result.body.toString("base64"),
        ...(result.contentType ? { contentType: result.contentType } : {}),
      }
    }
    throw new Error("Sanctuary authority method is not available")
  }

  #replyMarkupContainsHostHandle(value: unknown): boolean {
    if (typeof value === "string") return this.#hostAuthority?.ownsHandle(value) ?? false
    if (Array.isArray(value)) return value.some((entry) => this.#replyMarkupContainsHostHandle(entry))
    if (!isObject(value)) return false
    return Object.values(value).some((entry) => this.#replyMarkupContainsHostHandle(entry))
  }

  async #flushHostCard(registrationId: string): Promise<void> {
    const hostAuthority = this.#hostAuthority!
    const pending = hostAuthority.pendingCardEdit(registrationId)
    if (!pending) return
    await this.#api.request("editMessageText", {
      chat_id: this.#gateway.identity().ownerChatId,
      message_id: pending.telegramMessageId,
      text: pending.text,
      parse_mode: "HTML",
      reply_markup: { inline_keyboard: [] },
    })
    hostAuthority.markCardEdited(registrationId, pending.revision)
  }

  async #maintainHostCard(registrationId: string): Promise<void> {
    try {
      await this.#flushHostCard(registrationId)
      this.#hostMaintenanceFailures.delete(registrationId)
    } catch {
      this.#hostMaintenanceFailures.set(registrationId, "Sanctuary host terminal cleanup is pending")
    }
  }

  async #completeHostExecution(
    registrationId: string,
    permit: SignedAuthorityPayload<Record<string, unknown>>,
  ): Promise<void> {
    let receipt: SignedAuthorityPayload<Record<string, unknown>>
    try {
      receipt = await this.#hostExecutor!.execute(permit) as SignedAuthorityPayload<Record<string, unknown>>
      this.#hostAuthority!.completeExecution(registrationId, receipt)
      this.#hostExecutionFailures.delete(registrationId)
    } catch (error) {
      this.#hostExecutionFailures.set(registrationId, "Sanctuary host execution failed")
      throw error
    }
    try {
      await this.#completeHostMaintenance(registrationId, receipt)
      this.#hostMaintenanceFailures.delete(registrationId)
    } catch {
      this.#hostMaintenanceFailures.set(registrationId, "Sanctuary host terminal cleanup is pending")
    }
  }

  async #completeHostMaintenance(
    registrationId: string,
    receipt: SignedAuthorityPayload<Record<string, unknown>>,
  ): Promise<void> {
    this.#hostExecutor!.acknowledge?.(String(receipt.payload.permitId))
    await this.#flushHostCard(registrationId)
  }
}

export interface SanctuaryTelegramAuthorityServer {
  listen(): Promise<void>
  close(): Promise<void>
}

export function createSanctuaryTelegramAuthorityServer(options: {
  socketPath: string
  dispatch(method: string, params: Record<string, unknown>): unknown | Promise<unknown>
  maxRequestBytes?: number
  connectionTimeoutMs?: number
}): SanctuaryTelegramAuthorityServer {
  if (!path.isAbsolute(options.socketPath)) throw new Error("Sanctuary authority socket path must be absolute")
  const maxRequestBytes = options.maxRequestBytes ?? DEFAULT_MAX_REQUEST_BYTES
  if (!Number.isSafeInteger(maxRequestBytes) || maxRequestBytes < 128) {
    throw new Error("Sanctuary authority request limit is invalid")
  }
  const connectionTimeoutMs = options.connectionTimeoutMs ?? DEFAULT_CONNECTION_TIMEOUT_MS
  if (!Number.isSafeInteger(connectionTimeoutMs) || connectionTimeoutMs < 1) {
    throw new Error("Sanctuary authority connection timeout is invalid")
  }
  const connections = new Set<net.Socket>()
  let dispatchTail = Promise.resolve()
  const server = net.createServer({ allowHalfOpen: true }, (connection) => {
    connections.add(connection)
    connection.setEncoding("utf8")
    connection.setTimeout(connectionTimeoutMs, () => connection.destroy())
    connection.once("close", () => connections.delete(connection))
    let buffer = ""
    connection.on("data", (chunk) => {
      buffer += chunk
      if (Buffer.byteLength(buffer) > maxRequestBytes) {
        connection.end(`${JSON.stringify({
          protocolVersion: PROTOCOL_VERSION,
          id: null,
          ok: false,
          error: { message: "Sanctuary authority request is too large" },
        })}\n`)
        return
      }
      for (;;) {
        const newline = buffer.indexOf("\n")
        if (newline < 0) break
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        if (!line.trim()) continue
        let request: unknown
        try {
          request = JSON.parse(line)
        } catch {
          connection.end(`${JSON.stringify({
            protocolVersion: PROTOCOL_VERSION,
            id: null,
            ok: false,
            error: { message: "Sanctuary authority request failed" },
          })}\n`)
          return
        }
        const frame = request
        if (
          !isObject(frame)
          || !exactKeys(frame, ["protocolVersion", "id", "method", "params"])
          || frame.protocolVersion !== PROTOCOL_VERSION
          || typeof frame.id !== "string"
          || frame.id.length === 0
          || typeof frame.method !== "string"
          || frame.method.length === 0
          || !isObject(frame.params)
        ) {
          connection.end(`${JSON.stringify({
            protocolVersion: PROTOCOL_VERSION,
            id: isObject(frame) && typeof frame.id === "string" ? frame.id : null,
            ok: false,
            error: { message: "Sanctuary authority request failed" },
          })}\n`)
          return
        }
        const response = dispatchTail.then(async () => {
          try {
            const result = await options.dispatch(frame.method as string, frame.params as Record<string, unknown>)
            connection.write(`${JSON.stringify({
              protocolVersion: PROTOCOL_VERSION,
              id: frame.id,
              ok: true,
              result,
            })}\n`)
          } catch {
            connection.write(`${JSON.stringify({
              protocolVersion: PROTOCOL_VERSION,
              id: frame.id,
              ok: false,
              error: { message: "Sanctuary authority request failed" },
            })}\n`)
          }
        })
        dispatchTail = response
      }
    })
  })

  return {
    listen: () => new Promise<void>((resolve, reject) => {
      const directory = path.dirname(options.socketPath)
      if (fs.existsSync(directory)) {
        const directoryStat = fs.lstatSync(directory)
        if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
          throw new Error("Sanctuary authority socket directory is unsafe")
        }
      } else {
        fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
      }
      if (fs.existsSync(options.socketPath)) {
        const socketStat = fs.lstatSync(options.socketPath)
        /* v8 ignore next -- the valid stale-socket branch is exercised by the deployment restart fixture @preserve */
        if (!socketStat.isSocket()) {
          throw new Error("Sanctuary authority socket path is unsafe")
        }
        /* v8 ignore next -- stale Unix-socket inode cleanup is exercised by the deployment restart fixture @preserve */
        fs.unlinkSync(options.socketPath)
      }
      server.once("error", reject)
      server.listen(options.socketPath, () => {
        server.removeListener("error", reject)
        fs.chmodSync(options.socketPath, 0o660)
        resolve()
      })
    }),
    close: async () => {
      for (const connection of connections) connection.destroy()
      await dispatchTail
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve())
      })
      /* v8 ignore start -- Node removes the bound Unix socket on ordinary close; changed-path cleanup is a live race defense @preserve */
      if (fs.existsSync(options.socketPath)) {
        const socketStat = fs.lstatSync(options.socketPath)
        if (!socketStat.isSocket()) {
          throw new Error("Sanctuary authority socket path changed before cleanup")
        }
        fs.unlinkSync(options.socketPath)
      }
      /* v8 ignore stop */
    },
  }
}

export class SocketSanctuaryTelegramAuthorityClient {
  readonly #client: SocketFrontendClient

  constructor(socketPath: string) {
    if (!path.isAbsolute(socketPath)) throw new Error("Sanctuary authority socket path must be absolute")
    this.#client = new SocketFrontendClient(socketPath)
  }

  request(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (typeof method !== "string" || method.length === 0) {
      return Promise.reject(new Error("Sanctuary authority method is invalid"))
    }
    if (!isObject(params)) {
      return Promise.reject(new Error("Sanctuary authority params are invalid"))
    }
    return this.#client.request(method, params)
  }

  close(): void {
    this.#client.close()
  }
}
