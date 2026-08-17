import { createHash, randomBytes as createRandomBytes, randomUUID as createRandomUUID, timingSafeEqual } from "node:crypto"
import * as fs from "node:fs"
import * as path from "node:path"

import Database from "better-sqlite3"

import { emitNervesEvent } from "../nerves/runtime"

type JsonPrimitive = string | number | boolean | null
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue }
export type JsonObject = { [key: string]: JsonValue }

export type ApprovalState =
  | "preparing"
  | "awaiting_prompt_binding"
  | "proposed"
  | "claimed"
  | "attempted"
  | "succeeded"
  | "failed"
  | "attempted_indeterminate"
  | "denied"
  | "expired"
  | "drifted"
  | "session_head_changed"
  | "abandoned_before_attempt"

export interface ApprovalRecord {
  approvalId: string
  state: ApprovalState
  toolCallId: string
  toolName: string
  arguments: JsonObject
  argumentDigest: string
  schemaDigest: string
  toolDigest: string
  policyDigest: string
  policyId: string
  sessionKey: string
  sessionPath: string
  baseSessionRevision: string
  suspendedSessionRevision: string | null
  checkpointDigest: string
  requesterId: string
  transport: string
  transportUserId: string
  transportChatId: string
  transportMessageId: string | null
  decisionTokenDigest: string
  expiresAt: string
  createdAt: string
  updatedAt: string
  ownerId: string | null
  epoch: number
  attemptedAt: string | null
  result: string | null
  reason: string | null
  frozenAssistantMessage: JsonObject
}

export interface PrepareApprovalInput {
  toolCallId: string
  toolName: string
  arguments: JsonObject
  schemaDigest: string
  toolDigest: string
  policyDigest: string
  policyId: string
  sessionKey: string
  sessionPath: string
  baseSessionRevision: string
  checkpointDigest: string
  requesterId: string
  transport: string
  transportUserId: string
  transportChatId: string
  expiresAt: string
  frozenAssistantMessage: JsonObject
}

export interface ApprovalStoreOptions {
  databasePath: string
  now?: () => Date
  randomUUID?: () => string
  randomBytes?: (size: number) => Buffer
  hooks?: {
    beforeClaimCas?: () => void
    beforeAttemptCas?: () => void
    beforeClose?: () => void
  }
}

export interface ApprovalStore {
  prepare(input: PrepareApprovalInput): { record: ApprovalRecord; decisionToken: string }
  activate(input: { approvalId: string; checkpointDigest: string; suspendedSessionRevision: string }): ApprovalRecord
  bindPrompt(input: { approvalId: string; transport: string; transportChatId: string; transportMessageId: string }): ApprovalRecord
  decide(input: {
    approvalId: string
    decisionToken: string
    decision: "approve" | "deny"
    requesterId: string
    transport: string
    transportUserId: string
    transportChatId: string
    transportMessageId: string
    sessionKey: string
    ownerId: string
  }): ApprovalRecord
  expire(input: { approvalId: string }): ApprovalRecord
  markAttempted(input: { approvalId: string; ownerId: string; epoch: number }): ApprovalRecord
  abandonBeforeAttempt(input: { approvalId: string; ownerId: string; epoch: number; reason: string }): ApprovalRecord
  complete(input: {
    approvalId: string
    ownerId: string
    epoch: number
    state: "succeeded" | "failed" | "attempted_indeterminate"
    result: string
  }): ApprovalRecord
  listPreparing(): ApprovalRecord[]
  recoverPreparing(input: {
    approvalId: string
    state: "abandoned_before_attempt" | "drifted"
    reason: string
  }): ApprovalRecord
  read(approvalId: string): ApprovalRecord | null
  close(): void
}

export class ApprovalStoreError extends Error {
  readonly code: string

  constructor(code: string, message = code) {
    super(message)
    this.name = "ApprovalStoreError"
    this.code = code
  }
}

const HASH = /^[a-f0-9]{64}$/
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i
const RECORD_KEYS: readonly (keyof ApprovalRecord)[] = [
  "approvalId", "state", "toolCallId", "toolName", "arguments", "argumentDigest", "schemaDigest",
  "toolDigest", "policyDigest", "policyId", "sessionKey", "sessionPath", "baseSessionRevision",
  "suspendedSessionRevision", "checkpointDigest", "requesterId", "transport", "transportUserId",
  "transportChatId", "transportMessageId", "decisionTokenDigest", "expiresAt", "createdAt", "updatedAt",
  "ownerId", "epoch", "attemptedAt", "result", "reason", "frozenAssistantMessage",
]
const STATES = new Set<ApprovalState>([
  "preparing", "awaiting_prompt_binding", "proposed", "claimed", "attempted", "succeeded", "failed",
  "attempted_indeterminate", "denied", "expired", "drifted", "session_head_changed", "abandoned_before_attempt",
])
const ATTEMPT_TERMINALS = new Set<ApprovalState>(["succeeded", "failed", "attempted_indeterminate"])

function fail(code: string): never {
  throw new ApprovalStoreError(code)
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value
}

function isNonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0
}

function assertJsonValue(value: unknown): asserts value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return
  if (typeof value === "number" && Number.isFinite(value)) return
  if (Array.isArray(value)) {
    for (const item of value) assertJsonValue(item)
    return
  }
  if (isObject(value)) {
    for (const item of Object.values(value)) assertJsonValue(item)
    return
  }
  fail("invalid_json_value")
}

function canonicalize(value: JsonValue): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalize(value[key]!)}`).join(",")}}`
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex")
}

export function canonicalApprovalArguments(value: JsonObject): { canonical: string; digest: string } {
  if (!isObject(value)) fail("arguments_not_object")
  assertJsonValue(value)
  const canonical = canonicalize(value)
  return { canonical, digest: sha256(canonical) }
}

function hasExactKeys(value: Record<string, unknown>): boolean {
  const actual = Object.keys(value).sort()
  const expected = [...RECORD_KEYS].sort()
  return actual.length === expected.length && actual.every((key, index) => key === expected[index])
}

function validStateShape(record: ApprovalRecord): boolean {
  const hasOwner = isNonEmpty(record.ownerId)
  const hasAttempt = isTimestamp(record.attemptedAt)
  const hasSuspension = typeof record.suspendedSessionRevision === "string"
    && HASH.test(record.suspendedSessionRevision)
  const hasPromptBinding = isNonEmpty(record.transportMessageId)
  const hasValidOwnershipEpoch = hasOwner ? record.epoch > 0 : record.epoch === 0
  if (record.state === "preparing") {
    return record.suspendedSessionRevision === null && record.transportMessageId === null
      && !hasOwner && record.epoch === 0 && !hasAttempt && record.result === null && record.reason === null
  }
  if (record.state === "awaiting_prompt_binding") {
    return hasSuspension && record.transportMessageId === null
      && !hasOwner && record.epoch === 0 && !hasAttempt && record.result === null && record.reason === null
  }
  if (record.state === "proposed") {
    return hasSuspension && hasPromptBinding
      && !hasOwner && record.epoch === 0 && !hasAttempt && record.result === null && record.reason === null
  }
  if (record.state === "claimed") {
    return hasSuspension && hasPromptBinding && hasOwner && record.epoch > 0
      && !hasAttempt && record.result === null && record.reason === null
  }
  if (record.state === "attempted") {
    return hasSuspension && hasPromptBinding && hasOwner && record.epoch > 0
      && hasAttempt && record.result === null && record.reason === null
  }
  if (ATTEMPT_TERMINALS.has(record.state)) {
    return hasSuspension && hasPromptBinding && hasOwner && record.epoch > 0
      && hasAttempt && isNonEmpty(record.result) && record.reason === null
  }
  if (record.state === "abandoned_before_attempt") {
    const validPreparingRecovery = !hasOwner && record.epoch === 0
      && record.suspendedSessionRevision === null && record.transportMessageId === null
    const validClaimRecovery = hasOwner && record.epoch > 0 && hasSuspension && hasPromptBinding
    return (validPreparingRecovery || validClaimRecovery)
      && !hasAttempt && record.result === null && isNonEmpty(record.reason)
  }
  if (record.state === "drifted") {
    const validPreparingRecovery = !hasOwner && record.epoch === 0
      && record.suspendedSessionRevision === null && record.transportMessageId === null
    const validPostCheckpoint = !hasOwner && record.epoch === 0 && hasSuspension
      && (hasPromptBinding || record.transportMessageId === null)
    const validPostClaim = hasOwner && record.epoch > 0 && hasSuspension && hasPromptBinding
    return (validPreparingRecovery || validPostCheckpoint || validPostClaim)
      && !hasAttempt && record.result === null && isNonEmpty(record.reason)
  }
  if (record.state === "denied") {
    return hasValidOwnershipEpoch && hasSuspension && hasPromptBinding
      && !hasAttempt && record.result === null && record.reason === null
  }
  if (record.state === "expired") {
    const validPostCheckpoint = !hasOwner && record.epoch === 0 && hasSuspension
      && (hasPromptBinding || record.transportMessageId === null)
    const validPostClaim = hasOwner && record.epoch > 0 && hasSuspension && hasPromptBinding
    return (validPostCheckpoint || validPostClaim)
      && !hasAttempt && record.result === null && record.reason === null
  }
  return hasValidOwnershipEpoch && hasSuspension && hasPromptBinding
    && !hasAttempt && record.result === null && isNonEmpty(record.reason)
}

export function parseApprovalRecord(value: unknown): ApprovalRecord {
  if (!isObject(value) || !hasExactKeys(value)) fail("corrupt_record")
  const record = value as unknown as ApprovalRecord
  if (!UUID.test(record.approvalId) || !STATES.has(record.state)) fail("corrupt_record")
  for (const field of [
    "toolCallId", "toolName", "policyId", "sessionKey", "sessionPath", "requesterId", "transport",
    "transportUserId", "transportChatId",
  ] as const) if (!isNonEmpty(record[field])) fail("corrupt_record")
  for (const field of [
    "argumentDigest", "schemaDigest", "toolDigest", "policyDigest", "baseSessionRevision", "checkpointDigest",
    "decisionTokenDigest",
  ] as const) if (typeof record[field] !== "string" || !HASH.test(record[field])) fail("corrupt_record")
  if (!isObject(record.arguments) || !isObject(record.frozenAssistantMessage)) fail("corrupt_record")
  assertJsonValue(record.arguments)
  assertJsonValue(record.frozenAssistantMessage)
  if (canonicalApprovalArguments(record.arguments).digest !== record.argumentDigest) fail("corrupt_record")
  if (!isTimestamp(record.expiresAt) || !isTimestamp(record.createdAt) || !isTimestamp(record.updatedAt)) fail("corrupt_record")
  if (record.ownerId !== null && !isNonEmpty(record.ownerId)) fail("corrupt_record")
  if (record.attemptedAt !== null && !isTimestamp(record.attemptedAt)) fail("corrupt_record")
  if (record.reason !== null && !isNonEmpty(record.reason)) fail("corrupt_record")
  if (record.result !== null && !isNonEmpty(record.result)) fail("corrupt_record")
  if (record.transportMessageId !== null && !isNonEmpty(record.transportMessageId)) fail("corrupt_record")
  if (record.suspendedSessionRevision !== null
    && (typeof record.suspendedSessionRevision !== "string" || !HASH.test(record.suspendedSessionRevision))) fail("corrupt_record")
  if (!Number.isInteger(record.epoch) || record.epoch < 0 || !validStateShape(record)) fail("corrupt_record")
  return structuredClone(record)
}

function assertHash(value: string, code: string): void {
  if (!HASH.test(value)) fail(code)
}

function assertPrepareInput(input: PrepareApprovalInput): void {
  for (const value of [input.toolCallId, input.toolName, input.policyId, input.sessionKey, input.sessionPath,
    input.requesterId, input.transport, input.transportUserId, input.transportChatId]) {
    if (!isNonEmpty(value)) fail("invalid_proposal")
  }
  for (const value of [input.schemaDigest, input.toolDigest, input.policyDigest, input.baseSessionRevision, input.checkpointDigest]) {
    assertHash(value, "invalid_proposal")
  }
  if (!isTimestamp(input.expiresAt) || !isObject(input.arguments) || !isObject(input.frozenAssistantMessage)) fail("invalid_proposal")
  assertJsonValue(input.arguments)
  assertJsonValue(input.frozenAssistantMessage)
}

function tokenMatches(token: string, digest: string): boolean {
  const actual = Buffer.from(sha256(token), "hex")
  const expected = Buffer.from(digest, "hex")
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

function sameDecisionBinding(record: ApprovalRecord, input: Parameters<ApprovalStore["decide"]>[0]): boolean {
  return tokenMatches(input.decisionToken, record.decisionTokenDigest)
    && input.requesterId === record.requesterId
    && input.transport === record.transport
    && input.transportUserId === record.transportUserId
    && input.transportChatId === record.transportChatId
    && input.transportMessageId === record.transportMessageId
    && input.sessionKey === record.sessionKey
}

function operationErrorMeta(operation: string, error: unknown): Record<string, unknown> {
  return {
    operation,
    outcome: "error",
    code: error instanceof ApprovalStoreError ? error.code : "unexpected_error",
  }
}

function observePrepare<T>(operation: () => T): T {
  try {
    const result = operation()
    emitNervesEvent({ component: "heart", event: "approval.store_prepare", message: "approval store prepare completed", meta: { operation: "prepare", outcome: "success" } })
    return result
  } catch (error) {
    emitNervesEvent({ level: "error", component: "heart", event: "approval.store_prepare", message: "approval store prepare failed", meta: operationErrorMeta("prepare", error) })
    throw error
  }
}

function observeActivate<T>(operation: () => T): T {
  try {
    const result = operation()
    emitNervesEvent({ component: "heart", event: "approval.store_activate", message: "approval store activation completed", meta: { operation: "activate", outcome: "success" } })
    return result
  } catch (error) {
    emitNervesEvent({ level: "error", component: "heart", event: "approval.store_activate", message: "approval store activation failed", meta: operationErrorMeta("activate", error) })
    throw error
  }
}

function observeBindPrompt<T>(operation: () => T): T {
  try {
    const result = operation()
    emitNervesEvent({ component: "heart", event: "approval.store_bind_prompt", message: "approval prompt binding completed", meta: { operation: "bind_prompt", outcome: "success" } })
    return result
  } catch (error) {
    emitNervesEvent({ level: "error", component: "heart", event: "approval.store_bind_prompt", message: "approval prompt binding failed", meta: operationErrorMeta("bind_prompt", error) })
    throw error
  }
}

function observeDecide<T>(operation: () => T): T {
  try {
    const result = operation()
    emitNervesEvent({ component: "heart", event: "approval.store_decide", message: "approval decision completed", meta: { operation: "decide", outcome: "success" } })
    return result
  } catch (error) {
    emitNervesEvent({ level: "error", component: "heart", event: "approval.store_decide", message: "approval decision failed", meta: operationErrorMeta("decide", error) })
    throw error
  }
}

function observeExpire<T>(operation: () => T): T {
  try {
    const result = operation()
    emitNervesEvent({ component: "heart", event: "approval.store_expire", message: "approval expiry completed", meta: { operation: "expire", outcome: "success" } })
    return result
  } catch (error) {
    emitNervesEvent({ level: "error", component: "heart", event: "approval.store_expire", message: "approval expiry failed", meta: operationErrorMeta("expire", error) })
    throw error
  }
}

function observeMarkAttempted<T>(operation: () => T): T {
  try {
    const result = operation()
    emitNervesEvent({ component: "heart", event: "approval.store_mark_attempted", message: "approval attempt marker completed", meta: { operation: "mark_attempted", outcome: "success" } })
    return result
  } catch (error) {
    emitNervesEvent({ level: "error", component: "heart", event: "approval.store_mark_attempted", message: "approval attempt marker failed", meta: operationErrorMeta("mark_attempted", error) })
    throw error
  }
}

function observeAbandonBeforeAttempt<T>(operation: () => T): T {
  try {
    const result = operation()
    emitNervesEvent({ component: "heart", event: "approval.store_abandon_before_attempt", message: "approval abandonment completed", meta: { operation: "abandon_before_attempt", outcome: "success" } })
    return result
  } catch (error) {
    emitNervesEvent({ level: "error", component: "heart", event: "approval.store_abandon_before_attempt", message: "approval abandonment failed", meta: operationErrorMeta("abandon_before_attempt", error) })
    throw error
  }
}

function observeComplete<T>(operation: () => T): T {
  try {
    const result = operation()
    emitNervesEvent({ component: "heart", event: "approval.store_complete", message: "approval completion completed", meta: { operation: "complete", outcome: "success" } })
    return result
  } catch (error) {
    emitNervesEvent({ level: "error", component: "heart", event: "approval.store_complete", message: "approval completion failed", meta: operationErrorMeta("complete", error) })
    throw error
  }
}

function observeRead<T>(operation: () => T): T {
  try {
    const result = operation()
    emitNervesEvent({ component: "heart", event: "approval.store_read", message: "approval store read completed", meta: { operation: "read", outcome: "success" } })
    return result
  } catch (error) {
    emitNervesEvent({ level: "error", component: "heart", event: "approval.store_read", message: "approval store read failed", meta: operationErrorMeta("read", error) })
    throw error
  }
}

function observeListPreparing<T>(operation: () => T): T {
  try {
    const result = operation()
    emitNervesEvent({ component: "heart", event: "approval.store_list_preparing", message: "preparing approval listing completed", meta: { operation: "list_preparing", outcome: "success" } })
    return result
  } catch (error) {
    emitNervesEvent({ level: "error", component: "heart", event: "approval.store_list_preparing", message: "preparing approval listing failed", meta: operationErrorMeta("list_preparing", error) })
    throw error
  }
}

function observeRecoverPreparing<T>(operation: () => T): T {
  try {
    const result = operation()
    emitNervesEvent({ component: "heart", event: "approval.store_recover_preparing", message: "preparing approval recovery completed", meta: { operation: "recover_preparing", outcome: "success" } })
    return result
  } catch (error) {
    emitNervesEvent({ level: "error", component: "heart", event: "approval.store_recover_preparing", message: "preparing approval recovery failed", meta: operationErrorMeta("recover_preparing", error) })
    throw error
  }
}

function observeClose<T>(operation: () => T): T {
  try {
    const result = operation()
    emitNervesEvent({ component: "heart", event: "approval.store_close", message: "approval store close completed", meta: { operation: "close", outcome: "success" } })
    return result
  } catch (error) {
    emitNervesEvent({ level: "error", component: "heart", event: "approval.store_close", message: "approval store close failed", meta: operationErrorMeta("close", error) })
    throw error
  }
}

export function openApprovalStore(options: ApprovalStoreOptions): ApprovalStore {
  fs.mkdirSync(path.dirname(options.databasePath), { recursive: true })
  const database = new Database(options.databasePath)
  database.pragma("journal_mode = WAL")
  database.pragma("busy_timeout = 5000")
  database.exec(`
    CREATE TABLE IF NOT EXISTS approval_actions (
      approval_id TEXT PRIMARY KEY,
      state TEXT NOT NULL,
      epoch INTEGER NOT NULL,
      record_json TEXT NOT NULL
    )
  `)
  const now = options.now ?? (() => new Date())
  const randomUUID = options.randomUUID ?? createRandomUUID
  const randomBytes = options.randomBytes ?? createRandomBytes

  const rawRead = (approvalId: string): ApprovalRecord | null => {
    const row = database.prepare("SELECT record_json FROM approval_actions WHERE approval_id = ?")
      .get(approvalId) as { record_json: string } | undefined
    if (!row) return null
    try {
      return parseApprovalRecord(JSON.parse(row.record_json))
    } catch (error) {
      if (error instanceof ApprovalStoreError) throw error
      fail("corrupt_record")
    }
  }

  const insert = (record: ApprovalRecord): void => {
    database.prepare("INSERT INTO approval_actions (approval_id, state, epoch, record_json) VALUES (?, ?, ?, ?)")
      .run(record.approvalId, record.state, record.epoch, JSON.stringify(record))
  }

  const cas = (previous: ApprovalRecord, next: ApprovalRecord): ApprovalRecord => {
    const changed = database.prepare(`
      UPDATE approval_actions SET state = ?, epoch = ?, record_json = ?
      WHERE approval_id = ? AND state = ? AND epoch = ? AND record_json = ?
    `).run(next.state, next.epoch, JSON.stringify(next), previous.approvalId, previous.state, previous.epoch, JSON.stringify(previous))
    if (changed.changes !== 1) fail("transition_conflict")
    return structuredClone(next)
  }

  const requireRecord = (approvalId: string): ApprovalRecord => rawRead(approvalId) ?? fail("approval_not_found")
  const timestamp = (): string => now().toISOString()

  return {
    prepare(input) {
      return observePrepare(() => {
        assertPrepareInput(input)
        const approvalId = randomUUID()
        if (!UUID.test(approvalId)) fail("invalid_approval_id")
        const tokenBytes = randomBytes(32)
        if (tokenBytes.length !== 32) fail("invalid_token_entropy")
        const decisionToken = tokenBytes.toString("base64url")
        const createdAt = timestamp()
        const record: ApprovalRecord = {
          approvalId,
          state: "preparing",
          toolCallId: input.toolCallId,
          toolName: input.toolName,
          arguments: structuredClone(input.arguments),
          argumentDigest: canonicalApprovalArguments(input.arguments).digest,
          schemaDigest: input.schemaDigest,
          toolDigest: input.toolDigest,
          policyDigest: input.policyDigest,
          policyId: input.policyId,
          sessionKey: input.sessionKey,
          sessionPath: input.sessionPath,
          baseSessionRevision: input.baseSessionRevision,
          suspendedSessionRevision: null,
          checkpointDigest: input.checkpointDigest,
          requesterId: input.requesterId,
          transport: input.transport,
          transportUserId: input.transportUserId,
          transportChatId: input.transportChatId,
          transportMessageId: null,
          decisionTokenDigest: sha256(decisionToken),
          expiresAt: input.expiresAt,
          createdAt,
          updatedAt: createdAt,
          ownerId: null,
          epoch: 0,
          attemptedAt: null,
          result: null,
          reason: null,
          frozenAssistantMessage: structuredClone(input.frozenAssistantMessage),
        }
        insert(parseApprovalRecord(record))
        return { record: structuredClone(record), decisionToken }
      })
    },

    activate(input) {
      return observeActivate(() => {
        const previous = requireRecord(input.approvalId)
        if (previous.state !== "preparing" || input.checkpointDigest !== previous.checkpointDigest) fail("invalid_activation")
        assertHash(input.suspendedSessionRevision, "invalid_activation")
        return cas(previous, { ...previous, state: "awaiting_prompt_binding", suspendedSessionRevision: input.suspendedSessionRevision, updatedAt: timestamp() })
      })
    },

    bindPrompt(input) {
      return observeBindPrompt(() => {
        const previous = requireRecord(input.approvalId)
        if (previous.state !== "awaiting_prompt_binding" || input.transport !== previous.transport
          || input.transportChatId !== previous.transportChatId || !isNonEmpty(input.transportMessageId)) fail("invalid_prompt_binding")
        return cas(previous, { ...previous, state: "proposed", transportMessageId: input.transportMessageId, updatedAt: timestamp() })
      })
    },

    decide(input) {
      return observeDecide(() => {
        const previous = requireRecord(input.approvalId)
        if (!sameDecisionBinding(previous, input)) fail("decision_binding_mismatch")
        if (previous.state === "denied" && input.decision === "deny") return previous
        if (previous.state !== "proposed") fail("decision_not_eligible")
        if (now().getTime() >= Date.parse(previous.expiresAt)) {
          return cas(previous, { ...previous, state: "expired", updatedAt: timestamp() })
        }
        if (input.decision === "deny") {
          return cas(previous, { ...previous, state: "denied", updatedAt: timestamp() })
        }
        if (!isNonEmpty(input.ownerId)) fail("invalid_owner")
        options.hooks?.beforeClaimCas?.()
        if (now().getTime() >= Date.parse(previous.expiresAt)) {
          return cas(previous, { ...previous, state: "expired", updatedAt: timestamp() })
        }
        return cas(previous, { ...previous, state: "claimed", ownerId: input.ownerId, epoch: previous.epoch + 1, updatedAt: timestamp() })
      })
    },

    expire(input) {
      return observeExpire(() => {
        const previous = requireRecord(input.approvalId)
        if (previous.state === "expired") return previous
        if ((previous.state !== "proposed" && previous.state !== "awaiting_prompt_binding")
          || now().getTime() < Date.parse(previous.expiresAt)) fail("expiry_not_eligible")
        return cas(previous, { ...previous, state: "expired", updatedAt: timestamp() })
      })
    },

    markAttempted(input) {
      return observeMarkAttempted(() => {
        const previous = requireRecord(input.approvalId)
        if (previous.state !== "claimed" || previous.ownerId !== input.ownerId || previous.epoch !== input.epoch) fail("attempt_not_eligible")
        options.hooks?.beforeAttemptCas?.()
        return cas(previous, { ...previous, state: "attempted", attemptedAt: timestamp(), updatedAt: timestamp() })
      })
    },

    abandonBeforeAttempt(input) {
      return observeAbandonBeforeAttempt(() => {
        const previous = requireRecord(input.approvalId)
        if (previous.state === "abandoned_before_attempt" && previous.ownerId === input.ownerId
          && previous.epoch === input.epoch && previous.reason === input.reason) return previous
        if (previous.state !== "claimed" || previous.ownerId !== input.ownerId || previous.epoch !== input.epoch
          || !isNonEmpty(input.reason)) fail("abandon_not_eligible")
        return cas(previous, { ...previous, state: "abandoned_before_attempt", reason: input.reason, updatedAt: timestamp() })
      })
    },

    complete(input) {
      return observeComplete(() => {
        const previous = requireRecord(input.approvalId)
        if (ATTEMPT_TERMINALS.has(previous.state)) {
          if (previous.state === input.state && previous.ownerId === input.ownerId && previous.epoch === input.epoch
            && previous.result === input.result) return previous
          fail("completion_conflict")
        }
        if (previous.state !== "attempted" || previous.ownerId !== input.ownerId || previous.epoch !== input.epoch
          || !ATTEMPT_TERMINALS.has(input.state) || !isNonEmpty(input.result)) fail("completion_not_eligible")
        return cas(previous, { ...previous, state: input.state, result: input.result, updatedAt: timestamp() })
      })
    },

    listPreparing() {
      return observeListPreparing(() => {
        const rows = database.prepare("SELECT record_json FROM approval_actions WHERE state = ? ORDER BY approval_id")
          .all("preparing") as { record_json: string }[]
        return rows.map((row) => {
          try {
            return parseApprovalRecord(JSON.parse(row.record_json))
          } catch (error) {
            if (error instanceof ApprovalStoreError) throw error
            return fail("corrupt_record")
          }
        })
      })
    },

    recoverPreparing(input) {
      return observeRecoverPreparing(() => {
        const previous = requireRecord(input.approvalId)
        if (!isNonEmpty(input.reason)) fail("recovery_not_eligible")
        if (previous.state === input.state && previous.ownerId === null && previous.epoch === 0
          && previous.attemptedAt === null && previous.reason === input.reason) return previous
        if (previous.state !== "preparing") fail("recovery_not_eligible")
        return cas(previous, { ...previous, state: input.state, reason: input.reason, updatedAt: timestamp() })
      })
    },

    read(approvalId) { return observeRead(() => rawRead(approvalId)) },
    close() {
      return observeClose(() => {
        options.hooks?.beforeClose?.()
        database.close()
      })
    },
  }
}
