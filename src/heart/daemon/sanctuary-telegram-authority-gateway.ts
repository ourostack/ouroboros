import { createHash, createPublicKey, randomBytes, type KeyLike } from "node:crypto"
import * as fs from "node:fs"
import * as path from "node:path"

import type { TelegramUpdate } from "../../senses/telegram-client"
import {
  readSessionTransaction,
  withImmediateSessionTurnLease,
  writeSessionTransaction,
} from "../../mind/session-transaction"
import {
  authorityArtifactDigest,
  signAuthorityPayload,
  type SignedAuthorityPayload,
} from "./sanctuary-authority-codec"

const SCHEMA_VERSION = 1 as const
const OBSERVATION_DOMAIN = "ouro.sanctuary.telegram-observation.v1"
const RAW_UPDATE_DIGEST = /^tgu_[A-Za-z0-9_-]{43}$/u
const DECIMAL_ID = /^[1-9][0-9]*$/u
const NONCE = /^[A-Za-z0-9_-]{43}$/u

export interface TelegramTransportObservationV1 {
  targetHost: string
  botId: string
  updateId: number
  updateClass: "message" | "callback"
  userId: string
  chatId: string
  ownerEligible: boolean
  messageId: string | null
  callbackQueryId: string | null
  rawUpdateDigest: string
  observedAt: string
  settlement: "pending"
  nonce: string
  publicKeyDigest: string
}

interface DispatchRecord {
  updateId: number
  rawUpdateDigest: string
  rawUpdate: TelegramUpdate
  disposition: "dispatch"
  settlement: "pending" | "completed" | "indeterminate"
  observation: SignedAuthorityPayload<TelegramTransportObservationV1>
}

interface IgnoredRecord {
  updateId: number
  rawUpdateDigest: string
  rawUpdate: TelegramUpdate
  disposition: "ignored"
  settlement: "ignored"
  observation: null
}

export type SanctuaryTelegramAuthorityRecord = DispatchRecord | IgnoredRecord

interface SanctuaryTelegramAuthorityState {
  schemaVersion: typeof SCHEMA_VERSION
  cursor: number
  records: Record<string, SanctuaryTelegramAuthorityRecord>
}

export interface SanctuaryTelegramAuthorityGatewayOptions {
  targetHost: string
  botId: string
  ownerUserId: string
  ownerChatId: string
  keyId: string
  publicKeyDigest: string
  privateKey: KeyLike
  now?: () => string
  nonce?: () => string
}

export interface SanctuaryTelegramSettlement {
  updateId: number
  observationDigest: string
  outcome: "completed" | "indeterminate"
}

export interface SanctuaryTelegramAuthorityIdentity {
  targetHost: string
  botId: string
  ownerUserId: string
  ownerChatId: string
  keyId: string
  publicKeyDigest: string
}

export function sanctuaryTelegramAuthorityStatePath(agentRoot: string): string {
  return path.join(agentRoot, "authority", "telegram-state.json")
}

export function sanctuaryAuthorityPublicKeyDigest(key: KeyLike): string {
  const bytes = createPublicKey(key).export({ type: "spki", format: "der" })
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  return actual.length === expected.length && actual.every((key, index) => key === expected[index])
}

function validTime(value: unknown): value is string {
  if (typeof value !== "string") return false
  try {
    return new Date(value).toISOString() === value
  } catch {
    return false
  }
}

function rawUpdateDigest(update: TelegramUpdate): string {
  return `tgu_${createHash("sha256")
    .update(`ouroboros.telegram.update.v1\0${JSON.stringify(update)}`, "utf8")
    .digest("base64url")}`
}

function validUpdate(value: unknown): value is TelegramUpdate {
  return isObject(value) && Number.isSafeInteger(value.update_id) && (value.update_id as number) >= 0
}

function updateCoordinates(update: TelegramUpdate): {
  updateClass: "message" | "callback"
  userId: string
  chatId: string
  messageId: string | null
  callbackQueryId: string | null
} | null {
  const callback = update.callback_query
  if (
    callback
    && Number.isSafeInteger(callback.from?.id)
    && callback.message
    && Number.isSafeInteger(callback.message.message_id)
    && Number.isSafeInteger(callback.message.chat?.id)
    && typeof callback.id === "string"
    && callback.id.length > 0
  ) {
    return {
      updateClass: "callback",
      userId: String(callback.from.id),
      chatId: String(callback.message.chat.id),
      messageId: String(callback.message.message_id),
      callbackQueryId: callback.id,
    }
  }
  const message = update.message
  if (
    message
    && message.chat?.type === "private"
    && message.from
    && Number.isSafeInteger(message.from.id)
    && Number.isSafeInteger(message.chat.id)
    && Number.isSafeInteger(message.message_id)
  ) {
    return {
      updateClass: "message",
      userId: String(message.from.id),
      chatId: String(message.chat.id),
      messageId: String(message.message_id),
      callbackQueryId: null,
    }
  }
  return null
}

function initialState(): SanctuaryTelegramAuthorityState {
  return { schemaVersion: SCHEMA_VERSION, cursor: 0, records: {} }
}

function validateObservation(value: unknown): asserts value is SignedAuthorityPayload<TelegramTransportObservationV1> {
  if (
    !isObject(value)
    || !exactKeys(value, ["schemaVersion", "domain", "keyId", "payload", "signature"])
    || value.schemaVersion !== 1
    || value.domain !== OBSERVATION_DOMAIN
    || typeof value.keyId !== "string"
    || value.keyId.length === 0
    || typeof value.signature !== "string"
    || !isObject(value.payload)
  ) {
    throw new Error("Sanctuary Telegram authority observation is malformed")
  }
}

function validateRecord(value: unknown, updateId: number): asserts value is SanctuaryTelegramAuthorityRecord {
  if (
    !isObject(value)
    || !exactKeys(value, ["updateId", "rawUpdateDigest", "rawUpdate", "disposition", "settlement", "observation"])
    || value.updateId !== updateId
    || typeof value.rawUpdateDigest !== "string"
    || !RAW_UPDATE_DIGEST.test(value.rawUpdateDigest)
    || !isObject(value.rawUpdate)
    || value.rawUpdate.update_id !== updateId
  ) {
    throw new Error(`Sanctuary Telegram authority record ${updateId} is malformed`)
  }
  if (value.disposition === "ignored") {
    if (value.settlement !== "ignored" || value.observation !== null) {
      throw new Error(`Sanctuary Telegram authority ignored record ${updateId} is ambiguous`)
    }
    return
  }
  if (
    value.disposition !== "dispatch"
    || !["pending", "completed", "indeterminate"].includes(String(value.settlement))
  ) {
    throw new Error(`Sanctuary Telegram authority record ${updateId} has invalid settlement`)
  }
  validateObservation(value.observation)
}

function validateState(value: unknown): asserts value is SanctuaryTelegramAuthorityState {
  if (
    !isObject(value)
    || !exactKeys(value, ["schemaVersion", "cursor", "records"])
    || value.schemaVersion !== SCHEMA_VERSION
    || !Number.isSafeInteger(value.cursor)
    || (value.cursor as number) < 0
    || !isObject(value.records)
  ) {
    throw new Error("Sanctuary Telegram authority state is malformed")
  }
  for (const [key, record] of Object.entries(value.records)) {
    if (!/^(?:0|[1-9][0-9]*)$/u.test(key)) {
      throw new Error("Sanctuary Telegram authority state has an invalid update key")
    }
    validateRecord(record, Number(key))
  }
}

function transactionState(transaction: ReturnType<typeof readSessionTransaction>): SanctuaryTelegramAuthorityState {
  if (transaction.value === null) {
    if (transaction.bytes) throw new Error("Sanctuary Telegram authority state is malformed")
    return initialState()
  }
  validateState(transaction.value)
  return transaction.value
}

export class FileSanctuaryTelegramAuthorityGateway {
  readonly #statePath: string
  readonly #options: Required<Pick<SanctuaryTelegramAuthorityGatewayOptions, "now" | "nonce">>
    & Omit<SanctuaryTelegramAuthorityGatewayOptions, "now" | "nonce">

  constructor(agentRoot: string, options: SanctuaryTelegramAuthorityGatewayOptions) {
    if (typeof agentRoot !== "string" || agentRoot.length === 0) {
      throw new Error("Sanctuary Telegram authority root is invalid")
    }
    for (const [label, value] of [
      ["bot id", options.botId],
      ["owner user id", options.ownerUserId],
      ["owner chat id", options.ownerChatId],
    ] as const) {
      if (!DECIMAL_ID.test(value)) throw new Error(`Sanctuary Telegram authority ${label} is invalid`)
    }
    if (
      !options.targetHost
      || !options.keyId
      || options.publicKeyDigest !== sanctuaryAuthorityPublicKeyDigest(options.privateKey)
    ) {
      throw new Error("Sanctuary Telegram authority issuer configuration is invalid")
    }
    this.#statePath = sanctuaryTelegramAuthorityStatePath(agentRoot)
    this.#options = {
      ...options,
      now: options.now ?? (() => new Date().toISOString()),
      nonce: options.nonce ?? (() => randomBytes(32).toString("base64url")),
    }
  }

  capture(updates: readonly TelegramUpdate[]): void {
    if (!Array.isArray(updates)) throw new Error("Sanctuary Telegram authority updates must be an array")
    withImmediateSessionTurnLease(this.#statePath, (lease) => {
      const transaction = readSessionTransaction(this.#statePath, lease)
      const state = transactionState(transaction)
      let changed = false
      for (const update of updates) {
        if (!validUpdate(update)) {
          throw new Error("Sanctuary Telegram authority update is invalid")
        }
        const updateId = update.update_id
        const digest = rawUpdateDigest(update)
        const existing = state.records[String(updateId)]
        if (existing) {
          if (existing.rawUpdateDigest !== digest) {
            throw new Error(`Sanctuary Telegram authority duplicate update ${updateId} changed`)
          }
          continue
        }
        if (updateId < state.cursor) {
          throw new Error(`Sanctuary Telegram authority update ${updateId} is stale`)
        }
        const coordinates = updateCoordinates(update)
        if (!coordinates) {
          state.records[String(updateId)] = {
            updateId,
            rawUpdateDigest: digest,
            rawUpdate: structuredClone(update),
            disposition: "ignored",
            settlement: "ignored",
            observation: null,
          }
          changed = true
          continue
        }
        const observedAt = this.#options.now()
        if (!validTime(observedAt)) throw new Error("Sanctuary Telegram authority clock is invalid")
        const nonce = this.#options.nonce()
        if (!NONCE.test(nonce)) throw new Error("Sanctuary Telegram authority nonce is invalid")
        if (Object.values(state.records).some((record) => record.observation?.payload.nonce === nonce)) {
          throw new Error("Sanctuary Telegram authority nonce is already used")
        }
        const payload: TelegramTransportObservationV1 = {
          targetHost: this.#options.targetHost,
          botId: this.#options.botId,
          updateId,
          ...coordinates,
          ownerEligible: coordinates.userId === this.#options.ownerUserId
            && coordinates.chatId === this.#options.ownerChatId,
          rawUpdateDigest: digest,
          observedAt,
          settlement: "pending",
          nonce,
          publicKeyDigest: this.#options.publicKeyDigest,
        }
        state.records[String(updateId)] = {
          updateId,
          rawUpdateDigest: digest,
          rawUpdate: structuredClone(update),
          disposition: "dispatch",
          settlement: "pending",
          observation: signAuthorityPayload({
            domain: OBSERVATION_DOMAIN,
            keyId: this.#options.keyId,
            payload,
            privateKey: this.#options.privateKey,
          }),
        }
        changed = true
      }
      this.#advanceCursor(state)
      if (changed) this.#write(state, transaction.revision, lease)
    })
  }

  poll(): SignedAuthorityPayload<TelegramTransportObservationV1> | null {
    return this.#read((state) => {
      const record = Object.values(state.records)
        .filter((candidate): candidate is DispatchRecord => candidate.disposition === "dispatch"
          && candidate.settlement === "pending"
          && candidate.updateId >= state.cursor)
        .sort((left, right) => left.updateId - right.updateId)[0]
      return record?.observation ?? null
    })
  }

  settle(settlement: SanctuaryTelegramSettlement): void {
    if (
      !isObject(settlement)
      || !exactKeys(settlement, ["updateId", "observationDigest", "outcome"])
      || !Number.isSafeInteger(settlement.updateId)
      || settlement.updateId < 0
      || typeof settlement.observationDigest !== "string"
      || !/^sha256:[a-f0-9]{64}$/u.test(settlement.observationDigest)
      || !["completed", "indeterminate"].includes(String(settlement.outcome))
    ) {
      throw new Error("Sanctuary Telegram authority settlement is malformed")
    }
    withImmediateSessionTurnLease(this.#statePath, (lease) => {
      const transaction = readSessionTransaction(this.#statePath, lease)
      const state = transactionState(transaction)
      const record = state.records[String(settlement.updateId)]
      if (!record || record.disposition !== "dispatch") {
        throw new Error(`Sanctuary Telegram authority update ${settlement.updateId} is missing`)
      }
      if (record.settlement !== "pending") {
        throw new Error(`Sanctuary Telegram authority update ${settlement.updateId} is already settled`)
      }
      const digest = authorityArtifactDigest(record.observation.domain, record.observation.payload)
      if (digest !== settlement.observationDigest) {
        throw new Error(`Sanctuary Telegram authority observation digest changed for ${settlement.updateId}`)
      }
      record.settlement = settlement.outcome
      this.#advanceCursor(state)
      this.#write(state, transaction.revision, lease)
    })
  }

  cursor(): number {
    return this.#read((state) => state.cursor)
  }

  identity(): SanctuaryTelegramAuthorityIdentity {
    return {
      targetHost: this.#options.targetHost,
      botId: this.#options.botId,
      ownerUserId: this.#options.ownerUserId,
      ownerChatId: this.#options.ownerChatId,
      keyId: this.#options.keyId,
      publicKeyDigest: this.#options.publicKeyDigest,
    }
  }

  ownsCallbackQuery(callbackQueryId: string): boolean {
    if (typeof callbackQueryId !== "string" || callbackQueryId.length === 0) return false
    return this.#read((state) => Object.values(state.records).some((record) =>
      record.disposition === "dispatch"
      && record.rawUpdate.callback_query?.id === callbackQueryId))
  }

  ownsFileId(fileId: string): boolean {
    if (typeof fileId !== "string" || fileId.length === 0) return false
    return this.#read((state) => Object.values(state.records).some((record) => {
      if (record.disposition !== "dispatch") return false
      const message = record.rawUpdate.message
      return message?.document?.file_id === fileId
        || message?.audio?.file_id === fileId
        || message?.video?.file_id === fileId
        || message?.voice?.file_id === fileId
        || message?.animation?.file_id === fileId
        || message?.sticker?.file_id === fileId
        || message?.photo?.some((photo) => photo.file_id === fileId) === true
    }))
  }

  record(updateId: number): SanctuaryTelegramAuthorityRecord | null {
    if (!Number.isSafeInteger(updateId) || updateId < 0) {
      throw new Error("Sanctuary Telegram authority update id is invalid")
    }
    return this.#read((state) => state.records[String(updateId)] ?? null)
  }

  #advanceCursor(state: SanctuaryTelegramAuthorityState): void {
    const records = Object.values(state.records)
      .filter((record) => record.updateId >= state.cursor)
      .sort((left, right) => left.updateId - right.updateId)
    for (const record of records) {
      if (record.disposition === "dispatch" && record.settlement === "pending") break
      state.cursor = record.updateId + 1
    }
  }

  #read<T>(read: (state: SanctuaryTelegramAuthorityState) => T): T {
    return withImmediateSessionTurnLease(this.#statePath, (lease) => {
      const transaction = readSessionTransaction(this.#statePath, lease)
      return read(transactionState(transaction))
    })
  }

  #write(
    state: SanctuaryTelegramAuthorityState,
    expectedRevision: string,
    lease: Parameters<typeof writeSessionTransaction>[2]["lease"],
  ): void {
    fs.chmodSync(path.dirname(this.#statePath), 0o700)
    writeSessionTransaction(this.#statePath, state, { lease, expectedRevision })
  }
}
