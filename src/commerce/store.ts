import * as fs from "node:fs"
import * as path from "node:path"
import { createHash, randomUUID } from "node:crypto"
import { emitNervesEvent } from "../nerves/runtime"
import type { CommerceAccessLogEntry, CommerceMandateItem, CommerceMandateRecord } from "./types"

const DEFAULT_EXPIRES_MINUTES = 30
const CONFIRMATION_PHRASE = "CONFIRM_PURCHASE"

export interface CommercePreviewInput {
  agentRoot: string
  friendId: string
  merchant: string
  items?: CommerceMandateItem[]
  amount: number
  currency: string
  allowedTools?: string[]
  constraints?: Record<string, string>
  reason: string
  expiresInMinutes?: number
}

export interface CommerceAuthorityValidationInput {
  agentRoot: string
  token: string | undefined
  toolName: string
  args?: Record<string, string>
  friendId?: string
}

export type CommerceAuthorityValidationResult =
  | { ok: true; record: CommerceMandateRecord }
  | { ok: false; reason: string }

export type CommerceAuthorityReservationResult =
  | { ok: true; checkoutId: string; reservationToken: string; record: CommerceMandateRecord }
  | { ok: false; reason: string }

function commerceRoot(agentRoot: string): string {
  return path.join(agentRoot, "state", "commerce")
}

function recordsDir(agentRoot: string): string {
  return path.join(commerceRoot(agentRoot), "checkouts")
}

function accessLogPath(agentRoot: string): string {
  return path.join(commerceRoot(agentRoot), "access-log.jsonl")
}

function recordPath(agentRoot: string, checkoutId: string): string {
  return path.join(recordsDir(agentRoot), `${checkoutId}.json`)
}

function recordLockPath(agentRoot: string, checkoutId: string): string {
  return `${recordPath(agentRoot, checkoutId)}.lock`
}

function canonicalMandatePayload(input: {
  friendId: string
  merchant: string
  items: CommerceMandateItem[]
  amount: number
  currency: string
  allowedTools: string[]
  constraints: Record<string, string>
  reason: string
  expiresAt: string
}): string {
  return JSON.stringify({
    friendId: input.friendId,
    merchant: input.merchant.trim(),
    items: input.items.map((item) => ({
      name: item.name.trim(),
      ...(item.quantity !== undefined ? { quantity: item.quantity } : {}),
      ...(item.amount !== undefined ? { amount: item.amount } : {}),
    })),
    amount: input.amount,
    currency: input.currency.trim().toLowerCase(),
    allowedTools: [...input.allowedTools].sort(),
    constraints: Object.fromEntries(Object.entries(input.constraints).sort(([a], [b]) => a.localeCompare(b))),
    reason: input.reason.trim(),
    expiresAt: input.expiresAt,
  })
}

function digestFor(input: Parameters<typeof canonicalMandatePayload>[0]): string {
  return createHash("sha256").update(canonicalMandatePayload(input)).digest("hex")
}

function digestForRecord(record: CommerceMandateRecord): string {
  return digestFor({
    friendId: record.friendId,
    merchant: record.merchant,
    items: record.items,
    amount: record.amount,
    currency: record.currency,
    /* v8 ignore next -- legacy records missing allowedTools are rejected before validation digest checks; fallback keeps digesting total @preserve */
    allowedTools: record.allowedTools ?? [],
    /* v8 ignore next -- legacy records missing constraints are rejected before validation digest checks; fallback keeps digesting total @preserve */
    constraints: record.constraints ?? {},
    reason: record.reason,
    expiresAt: record.expiresAt,
  })
}

function consentSummary(record: Pick<CommerceMandateRecord, "merchant" | "amount" | "currency" | "allowedTools" | "constraints">): string {
  const tools = [...(record.allowedTools ?? [])].sort().join(",")
  const constraints = JSON.stringify(Object.fromEntries(Object.entries(record.constraints ?? {}).sort(([a], [b]) => a.localeCompare(b))))
  return `${record.merchant} ${record.amount} ${record.currency} via ${tools} constraints ${constraints}`
}

function expectedConfirmationMessage(record: Pick<CommerceMandateRecord, "id" | "digest" | "merchant" | "amount" | "currency" | "allowedTools" | "constraints">): string {
  return `${CONFIRMATION_PHRASE} checkout ${record.id} digest ${record.digest} for ${consentSummary(record)}`
}

export function commerceConfirmationMessage(record: Pick<CommerceMandateRecord, "id" | "digest" | "merchant" | "amount" | "currency" | "allowedTools" | "constraints">): string {
  emitNervesEvent({
    component: "repertoire",
    event: "repertoire.commerce_confirmation_message_built",
    message: "built commerce confirmation message",
    meta: { checkoutId: record.id },
  })
  return expectedConfirmationMessage(record)
}

function parseAmount(value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error("commerce amount must be a positive number")
  }
  return Math.round(value * 100) / 100
}

function normalizeItems(items: CommerceMandateItem[] | undefined, merchant: string, amount: number): CommerceMandateItem[] {
  if (!items || items.length === 0) return [{ name: merchant, quantity: 1, amount }]
  return items.map((item) => ({
    name: item.name.trim(),
    ...(item.quantity !== undefined ? { quantity: item.quantity } : {}),
    ...(item.amount !== undefined ? { amount: parseAmount(item.amount) } : {}),
  }))
}

function normalizeToolName(toolName: string): string {
  const normalized = toolName.trim()
  if (!normalized) throw new Error("commerce allowed tool is required")
  return normalized
}

function normalizeAllowedTools(allowedTools: string[] | undefined): string[] {
  const tools = (allowedTools ?? []).map(normalizeToolName)
  if (tools.length === 0) throw new Error("commerce preview must name at least one allowed tool")
  return [...new Set(tools)].sort()
}

function normalizeConstraints(constraints: Record<string, string> | undefined): Record<string, string> {
  const normalized: Record<string, string> = {}
  for (const [key, value] of Object.entries(constraints ?? {})) {
    const cleanKey = key.trim()
    const cleanValue = String(value).trim()
    if (!cleanKey || !cleanValue) continue
    normalized[cleanKey] = cleanValue
  }
  return Object.fromEntries(Object.entries(normalized).sort(([a], [b]) => a.localeCompare(b)))
}

function appendAccessLog(agentRoot: string, entry: Omit<CommerceAccessLogEntry, "at">): void {
  fs.mkdirSync(commerceRoot(agentRoot), { recursive: true })
  fs.appendFileSync(accessLogPath(agentRoot), `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`, "utf-8")
}

function timestampMillis(value: string): number | null {
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}

function writeRecord(agentRoot: string, record: CommerceMandateRecord): void {
  fs.mkdirSync(recordsDir(agentRoot), { recursive: true })
  const { authorityToken: _authorityToken, ...persisted } = record
  fs.writeFileSync(recordPath(agentRoot, record.id), `${JSON.stringify(persisted, null, 2)}\n`, "utf-8")
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

function withRecordLock<T>(agentRoot: string, checkoutId: string, fn: () => T): T {
  fs.mkdirSync(recordsDir(agentRoot), { recursive: true })
  const lockPath = recordLockPath(agentRoot, checkoutId)
  const deadline = Date.now() + 5_000
  let fd: number | null = null
  while (fd === null) {
    try {
      fd = fs.openSync(lockPath, "wx")
      fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
      try {
        const ageMs = Date.now() - fs.statSync(lockPath).mtimeMs
        if (ageMs > 30_000) {
          fs.unlinkSync(lockPath)
          continue
        }
      } catch {
        /* v8 ignore next -- another process can remove a stale lock between failed open and stat; the next loop rechecks from scratch @preserve */
        continue
      }
      if (Date.now() >= deadline) throw new Error("commerce_authority lock timed out")
      sleepSync(25)
    }
  }
  try {
    return fn()
  } finally {
    fs.closeSync(fd)
    try {
      fs.unlinkSync(lockPath)
    } catch {
      /* v8 ignore next -- lock cleanup is best-effort after successful close; stale-lock reap handles rare removal races @preserve */
    }
  }
}

function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex")
}

function reservationToken(): string {
  return randomUUID()
}

function createCommerceAuthorityToken(record: Pick<CommerceMandateRecord, "id" | "digest">): string {
  return `commerce:${record.id}:${record.digest}:${randomUUID()}`
}

export function commerceAuthorityToken(record: Pick<CommerceMandateRecord, "id" | "digest"> & { authorityToken?: string }): string {
  if (!record.authorityToken) throw new Error("commerce authority token is only available after confirmation")
  const token = record.authorityToken
  emitNervesEvent({
    component: "repertoire",
    event: "repertoire.commerce_authority_token_built",
    message: "built commerce authority token",
    meta: { checkoutId: record.id },
  })
  return token
}

export function createCommercePreview(input: CommercePreviewInput): CommerceMandateRecord {
  const now = new Date()
  const amount = parseAmount(input.amount)
  const currency = input.currency.trim().toLowerCase()
  if (!currency) throw new Error("commerce currency is required")
  const merchant = input.merchant.trim()
  if (!merchant) throw new Error("commerce merchant is required")
  const reason = input.reason.trim()
  if (!reason) throw new Error("commerce reason is required")
  const allowedTools = normalizeAllowedTools(input.allowedTools)
  const constraints = normalizeConstraints(input.constraints)
  const expiresAt = new Date(now.getTime() + (input.expiresInMinutes ?? DEFAULT_EXPIRES_MINUTES) * 60_000).toISOString()
  const items = normalizeItems(input.items, merchant, amount)
  const digest = digestFor({
    friendId: input.friendId,
    merchant,
    items,
    amount,
    currency,
    allowedTools,
    constraints,
    reason,
    expiresAt,
  })
  const record: CommerceMandateRecord = {
    id: randomUUID(),
    status: "previewed",
    friendId: input.friendId,
    merchant,
    items,
    amount,
    currency,
    allowedTools,
    constraints,
    reason,
    digest,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    expiresAt,
  }
  writeRecord(input.agentRoot, record)
  appendAccessLog(input.agentRoot, { checkoutId: record.id, action: "preview", friendId: input.friendId, ok: true })
  emitNervesEvent({
    component: "repertoire",
    event: "repertoire.commerce_preview_created",
    message: "created commerce checkout preview",
    meta: { checkoutId: record.id, merchant, amount, currency },
  })
  return record
}

export function readCommerceRecord(agentRoot: string, checkoutId: string): CommerceMandateRecord | null {
  try {
    const raw = fs.readFileSync(recordPath(agentRoot, checkoutId), "utf-8")
    const record = JSON.parse(raw) as CommerceMandateRecord
    appendAccessLog(agentRoot, { checkoutId, action: "read", ok: true })
    emitNervesEvent({
      component: "repertoire",
      event: "repertoire.commerce_record_read",
      message: "read commerce checkout record",
      meta: { checkoutId },
    })
    return record
  } catch {
    appendAccessLog(agentRoot, { checkoutId, action: "read", ok: false, reason: "not_found" })
    return null
  }
}

export function confirmCommercePreview(input: {
  agentRoot: string
  checkoutId: string
  digest: string
  confirmation: string
  friendId: string
  currentUserMessage?: string
}): CommerceMandateRecord {
  const record = readCommerceRecord(input.agentRoot, input.checkoutId)
  if (!record) throw new Error(`commerce checkout not found: ${input.checkoutId}`)
  if (record.friendId !== input.friendId) throw new Error("commerce checkout belongs to a different friend")
  if (record.status !== "previewed") throw new Error(`commerce checkout is ${record.status}, not previewed`)
  const expiresAtMs = timestampMillis(record.expiresAt)
  if (expiresAtMs === null) throw new Error("commerce checkout preview has invalid expiry")
  if (expiresAtMs <= Date.now()) throw new Error("commerce checkout preview has expired")
  if (record.digest !== input.digest) throw new Error("commerce digest mismatch")
  if (digestForRecord(record) !== record.digest) throw new Error("commerce record digest mismatch")
  if (input.confirmation.trim() !== CONFIRMATION_PHRASE) throw new Error(`confirmation must be ${CONFIRMATION_PHRASE}`)
  const currentUserMessage = input.currentUserMessage?.trim() ?? ""
  if (currentUserMessage !== expectedConfirmationMessage(record)) {
    throw new Error(`current human message must exactly equal: ${expectedConfirmationMessage(record)}`)
  }
  const now = new Date().toISOString()
  const authorityToken = createCommerceAuthorityToken(record)
  const confirmed: CommerceMandateRecord = {
    ...record,
    status: "confirmed",
    confirmedAt: now,
    updatedAt: now,
    confirmation: CONFIRMATION_PHRASE,
    confirmedByMessage: currentUserMessage,
    authorityToken,
    authorityTokenHash: tokenHash(authorityToken),
  }
  writeRecord(input.agentRoot, confirmed)
  appendAccessLog(input.agentRoot, { checkoutId: record.id, action: "confirm", friendId: input.friendId, ok: true })
  emitNervesEvent({
    component: "repertoire",
    event: "repertoire.commerce_preview_confirmed",
    message: "confirmed commerce checkout preview",
    meta: { checkoutId: record.id },
  })
  return confirmed
}

function amountFromArgs(args: Record<string, string> | undefined): number | null {
  if (!args) return null
  const raw = args.amount ?? args.spend_limit
  if (!raw) return null
  if (!/^\d+(?:\.\d{1,2})?$/.test(raw.trim())) return Number.NaN
  const parsed = Number(raw)
  return Number.isFinite(parsed) ? parsed : null
}

function currencyFromArgs(args: Record<string, string> | undefined): string | null {
  const raw = args?.currency
  return raw ? raw.trim().toLowerCase() : null
}

function requiredAmountForTool(toolName: string): "amount" | "spend_limit" | null {
  if (toolName === "stripe_create_card") return "spend_limit"
  if (toolName === "flight_hold" || toolName === "flight_book") return "amount"
  return null
}

function requiredConstraintsForTool(toolName: string): string[] {
  if (toolName === "stripe_create_card") return ["type", "merchant_categories"]
  if (toolName === "flight_hold" || toolName === "flight_book") return ["offer_id"]
  return []
}

function authorityRecordValidationReason(
  record: CommerceMandateRecord,
  input: CommerceAuthorityValidationInput,
  options: { token?: string; digest?: string } = {},
): string | null {
  const expiresAtMs = timestampMillis(record.expiresAt)
  if (!Array.isArray(record.allowedTools) || record.allowedTools.length === 0) return "commerce_authority is missing allowed tools"
  if (!record.constraints || typeof record.constraints !== "object" || Array.isArray(record.constraints)) {
    return "commerce_authority constraints are invalid"
  }
  if (expiresAtMs === null) return "commerce_authority has invalid expiry"
  if (record.digest !== digestForRecord(record)) return "commerce_authority record digest mismatch"
  if (record.status !== "confirmed") return `commerce checkout is ${record.status}, not confirmed`
  if (timestampMillis(record.confirmedAt ?? "") === null) return "commerce_authority confirmation state is invalid"
  if (record.confirmation !== CONFIRMATION_PHRASE) return "commerce_authority confirmation state is invalid"
  if (record.confirmedByMessage !== expectedConfirmationMessage(record)) return "commerce_authority confirmation state is invalid"
  if (typeof record.authorityTokenHash !== "string" || !/^[a-f0-9]{64}$/.test(record.authorityTokenHash)) {
    return "commerce_authority confirmation state is invalid"
  }
  if (options.token !== undefined && record.authorityTokenHash !== tokenHash(options.token)) return "commerce_authority token mismatch"
  if (input.friendId && record.friendId !== input.friendId) return "commerce_authority belongs to a different friend"
  if (options.digest !== undefined && record.digest !== options.digest) return "commerce_authority digest mismatch"
  if (expiresAtMs <= Date.now()) return "commerce_authority expired"
  if (!record.allowedTools.includes(input.toolName)) return "tool is not allowed by commerce_authority"
  const requiredAmountKey = requiredAmountForTool(input.toolName)
  const amount = amountFromArgs(input.args)
  if (requiredAmountKey && amount === null) return `tool ${requiredAmountKey} is required for commerce_authority validation`
  if (amount !== null && (!Number.isFinite(amount) || amount !== record.amount)) return "tool amount does not match commerce_authority amount"
  const currency = currencyFromArgs(input.args)
  if (requiredAmountKey && !currency) return "tool currency is required for commerce_authority validation"
  if (currency && currency !== record.currency) return "tool currency does not match commerce_authority"
  for (const key of requiredConstraintsForTool(input.toolName)) {
    if (!record.constraints[key]) return `commerce_authority is missing required ${key} constraint`
  }
  for (const [key, expected] of Object.entries(record.constraints)) {
    const actual = input.args?.[key]?.trim()
    if (actual !== expected) return `tool ${key} does not match commerce_authority`
  }
  return null
}

export function validateCommerceAuthorityToken(input: CommerceAuthorityValidationInput): CommerceAuthorityValidationResult {
  const token = input.token?.trim()
  if (!token) return { ok: false, reason: "missing commerce_authority token" }
  const match = /^commerce:([^:]+):([a-f0-9]{64}):([0-9a-f-]{36})$/.exec(token)
  if (!match) return { ok: false, reason: "invalid commerce_authority token format" }
  const checkoutId = match[1]
  const digest = match[2]
  const record = readCommerceRecord(input.agentRoot, checkoutId)
  if (!record) return { ok: false, reason: "commerce checkout not found" }
  const reason = authorityRecordValidationReason(record, input, { token, digest })
  const ok = !reason
  appendAccessLog(input.agentRoot, {
    checkoutId,
    action: "validate",
    toolName: input.toolName,
    ok,
    ...(reason ? { reason } : {}),
  })
  emitNervesEvent({
    component: "repertoire",
    event: "repertoire.commerce_authority_validated",
    message: "validated commerce authority token",
    meta: { checkoutId, toolName: input.toolName, ok, reason: reason ?? "" },
  })
  return ok ? { ok: true, record } : { ok: false, reason: reason! }
}

function readAllCommerceRecords(agentRoot: string): CommerceMandateRecord[] {
  try {
    return fs.readdirSync(recordsDir(agentRoot))
      .filter((file) => file.endsWith(".json"))
      .flatMap((file) => {
        try {
          return [JSON.parse(fs.readFileSync(path.join(recordsDir(agentRoot), file), "utf-8")) as CommerceMandateRecord]
        } catch {
          return []
        }
      })
  } catch {
    return []
  }
}

function matchingCommerceRecords(input: CommerceAuthorityValidationInput): CommerceMandateRecord[] {
  return readAllCommerceRecords(input.agentRoot)
    .filter((record) => authorityRecordValidationReason(record, input) === null)
}

function noMatchingAuthorityReason(records: CommerceMandateRecord[], input: CommerceAuthorityValidationInput): string {
  const reasons = records
    .map((record) => authorityRecordValidationReason(record, input))
    .filter((reason): reason is string => typeof reason === "string")
  const uniqueReasons = [...new Set(reasons)]
  return uniqueReasons.length === 1 ? uniqueReasons[0]! : "no matching confirmed commerce_authority"
}

function validateMatchingCommerceAuthority(input: CommerceAuthorityValidationInput): CommerceAuthorityValidationResult {
  const records = readAllCommerceRecords(input.agentRoot)
  const matching = records.filter((record) => authorityRecordValidationReason(record, input) === null)
  if (matching.length === 0) return { ok: false, reason: noMatchingAuthorityReason(records, input) }
  if (matching.length > 1) return { ok: false, reason: "multiple matching confirmed commerce_authority records" }
  return { ok: true, record: matching[0]! }
}

export function validateCommerceAuthority(input: CommerceAuthorityValidationInput): CommerceAuthorityValidationResult {
  return input.token?.trim() ? validateCommerceAuthorityToken(input) : validateMatchingCommerceAuthority(input)
}

function consumeValidatedCommerceRecord(
  agentRoot: string,
  record: CommerceMandateRecord,
  input: CommerceAuthorityValidationInput,
): CommerceAuthorityValidationResult {
  const now = new Date().toISOString()
  const consumed: CommerceMandateRecord = {
    ...record,
    status: "consumed",
    reservedAt: undefined,
    reservedByTool: undefined,
    reservationTokenHash: undefined,
    attemptedAt: undefined,
    attemptedByTool: undefined,
    consumedAt: now,
    consumedByTool: input.toolName,
    updatedAt: now,
  }
  writeRecord(agentRoot, consumed)
  appendAccessLog(agentRoot, {
    checkoutId: record.id,
    action: "consume",
    toolName: input.toolName,
    friendId: input.friendId,
    ok: true,
  })
  emitNervesEvent({
    component: "repertoire",
    event: "repertoire.commerce_authority_consumed",
    message: "consumed commerce authority token",
    meta: { checkoutId: record.id, toolName: input.toolName },
  })
  return { ok: true, record: consumed }
}

function consumeMatchingCommerceAuthority(input: CommerceAuthorityValidationInput): CommerceAuthorityValidationResult {
  const matching = matchingCommerceRecords(input)
  if (matching.length === 0) return { ok: false, reason: "no matching confirmed commerce_authority" }
  if (matching.length > 1) return { ok: false, reason: "multiple matching confirmed commerce_authority records" }
  const record = matching[0]!
  return withRecordLock(input.agentRoot, record.id, () => {
    const fresh = readCommerceRecord(input.agentRoot, record.id)
    /* v8 ignore next -- race-defense: matching records can disappear between directory scan and checkout lock @preserve */
    if (!fresh) return { ok: false, reason: "commerce checkout not found" }
    const reason = authorityRecordValidationReason(fresh, input)
    /* v8 ignore next -- race-defense: matching records can change between directory scan and checkout lock @preserve */
    if (reason) return { ok: false, reason }
    return consumeValidatedCommerceRecord(input.agentRoot, fresh, input)
  })
}

function checkoutIdFromAuthorityToken(token: string | undefined): string | undefined {
  return token ? /^commerce:([^:]+):[a-f0-9]{64}:[0-9a-f-]{36}$/.exec(token)?.[1] : undefined
}

function reserveValidatedCommerceRecord(
  agentRoot: string,
  record: CommerceMandateRecord,
  input: CommerceAuthorityValidationInput,
): CommerceAuthorityReservationResult {
  const now = new Date().toISOString()
  const token = reservationToken()
  const reserved: CommerceMandateRecord = {
    ...record,
    status: "reserved",
    reservedAt: now,
    reservedByTool: input.toolName,
    reservationTokenHash: tokenHash(token),
    updatedAt: now,
  }
  writeRecord(agentRoot, reserved)
  appendAccessLog(agentRoot, {
    checkoutId: record.id,
    action: "reserve",
    toolName: input.toolName,
    friendId: input.friendId,
    ok: true,
  })
  emitNervesEvent({
    component: "repertoire",
    event: "repertoire.commerce_authority_reserved",
    message: "reserved commerce authority for tool execution",
    meta: { checkoutId: record.id, toolName: input.toolName },
  })
  return { ok: true, checkoutId: record.id, reservationToken: token, record: reserved }
}

function reserveMatchingCommerceAuthority(input: CommerceAuthorityValidationInput): CommerceAuthorityReservationResult {
  const records = readAllCommerceRecords(input.agentRoot)
  const matching = records.filter((record) => authorityRecordValidationReason(record, input) === null)
  if (matching.length === 0) return { ok: false, reason: noMatchingAuthorityReason(records, input) }
  if (matching.length > 1) return { ok: false, reason: "multiple matching confirmed commerce_authority records" }
  const record = matching[0]!
  return withRecordLock(input.agentRoot, record.id, () => {
    const fresh = readCommerceRecord(input.agentRoot, record.id)
    /* v8 ignore next -- race-defense: matching records can disappear between directory scan and checkout lock @preserve */
    if (!fresh) return { ok: false, reason: "commerce checkout not found" }
    const reason = authorityRecordValidationReason(fresh, input)
    /* v8 ignore next -- race-defense: matching records can change between directory scan and checkout lock @preserve */
    if (reason) return { ok: false, reason }
    return reserveValidatedCommerceRecord(input.agentRoot, fresh, input)
  })
}

export function reserveCommerceAuthority(input: CommerceAuthorityValidationInput): CommerceAuthorityReservationResult {
  const token = input.token?.trim()
  const checkoutId = checkoutIdFromAuthorityToken(token)
  if (!checkoutId) {
    if (!token) return reserveMatchingCommerceAuthority(input)
    return { ok: false, reason: "invalid commerce_authority token format" }
  }
  return withRecordLock(input.agentRoot, checkoutId, () => {
    const validation = validateCommerceAuthorityToken(input)
    if (!validation.ok) return validation
    return reserveValidatedCommerceRecord(input.agentRoot, validation.record, input)
  })
}

export function consumeReservedCommerceAuthority(input: {
  agentRoot: string
  checkoutId: string
  reservationToken: string
  toolName: string
  friendId?: string
}): CommerceAuthorityValidationResult {
  return withRecordLock(input.agentRoot, input.checkoutId, () => {
    const record = readCommerceRecord(input.agentRoot, input.checkoutId)
    if (!record) return { ok: false, reason: "commerce checkout not found" }
    if (record.status !== "reserved" && record.status !== "attempted") {
      return { ok: false, reason: `commerce checkout is ${record.status}, not reserved or attempted` }
    }
    if (record.reservedByTool !== input.toolName) return { ok: false, reason: "commerce_authority reservation belongs to a different tool" }
    if (input.friendId && record.friendId !== input.friendId) return { ok: false, reason: "commerce_authority belongs to a different friend" }
    if (record.reservationTokenHash !== tokenHash(input.reservationToken)) return { ok: false, reason: "commerce_authority reservation token mismatch" }
    return consumeValidatedCommerceRecord(input.agentRoot, record, {
      agentRoot: input.agentRoot,
      token: undefined,
      toolName: input.toolName,
      friendId: input.friendId,
    })
  })
}

export function markReservedCommerceAuthorityAttempted(input: {
  agentRoot: string
  checkoutId: string
  reservationToken: string
  toolName: string
  friendId?: string
}): CommerceAuthorityValidationResult {
  return withRecordLock(input.agentRoot, input.checkoutId, () => {
    const record = readCommerceRecord(input.agentRoot, input.checkoutId)
    if (!record) return { ok: false, reason: "commerce checkout not found" }
    if (record.status !== "reserved") return { ok: false, reason: `commerce checkout is ${record.status}, not reserved` }
    if (record.reservedByTool !== input.toolName) return { ok: false, reason: "commerce_authority reservation belongs to a different tool" }
    if (input.friendId && record.friendId !== input.friendId) return { ok: false, reason: "commerce_authority belongs to a different friend" }
    if (record.reservationTokenHash !== tokenHash(input.reservationToken)) return { ok: false, reason: "commerce_authority reservation token mismatch" }
    const now = new Date().toISOString()
    const attempted: CommerceMandateRecord = {
      ...record,
      status: "attempted",
      attemptedAt: now,
      attemptedByTool: input.toolName,
      updatedAt: now,
    }
    writeRecord(input.agentRoot, attempted)
    appendAccessLog(input.agentRoot, {
      checkoutId: record.id,
      action: "attempt",
      toolName: input.toolName,
      friendId: input.friendId,
      ok: true,
    })
    emitNervesEvent({
      component: "repertoire",
      event: "repertoire.commerce_authority_attempted",
      message: "marked commerce authority as externally attempted",
      meta: { checkoutId: record.id, toolName: input.toolName },
    })
    return { ok: true, record: attempted }
  })
}

export function releaseReservedCommerceAuthority(input: {
  agentRoot: string
  checkoutId: string
  reservationToken: string
  toolName: string
  friendId?: string
}): CommerceAuthorityValidationResult {
  return withRecordLock(input.agentRoot, input.checkoutId, () => {
    const record = readCommerceRecord(input.agentRoot, input.checkoutId)
    if (!record || record.status !== "reserved") return { ok: false, reason: "commerce checkout is not reserved" }
    if (record.reservedByTool !== input.toolName) return { ok: false, reason: "commerce_authority reservation belongs to a different tool" }
    if (input.friendId && record.friendId !== input.friendId) return { ok: false, reason: "commerce_authority belongs to a different friend" }
    if (record.reservationTokenHash !== tokenHash(input.reservationToken)) return { ok: false, reason: "commerce_authority reservation token mismatch" }
    const now = new Date().toISOString()
    const released: CommerceMandateRecord = {
      ...record,
      status: "confirmed",
      reservedAt: undefined,
      reservedByTool: undefined,
      reservationTokenHash: undefined,
      updatedAt: now,
    }
    writeRecord(input.agentRoot, released)
    appendAccessLog(input.agentRoot, {
      checkoutId: record.id,
      action: "release",
      toolName: input.toolName,
      friendId: input.friendId,
      ok: true,
    })
    emitNervesEvent({
      component: "repertoire",
      event: "repertoire.commerce_authority_released",
      message: "released reserved commerce authority",
      meta: { checkoutId: record.id, toolName: input.toolName },
    })
    return { ok: true, record: released }
  })
}

export function consumeCommerceAuthorityToken(input: CommerceAuthorityValidationInput): CommerceAuthorityValidationResult {
  const token = input.token?.trim()
  const checkoutId = checkoutIdFromAuthorityToken(token)
  if (!checkoutId) return token ? validateCommerceAuthorityToken(input) : consumeMatchingCommerceAuthority(input)
  return withRecordLock(input.agentRoot, checkoutId, () => {
    const validation = validateCommerceAuthorityToken(input)
    if (!validation.ok) return validation
    return consumeValidatedCommerceRecord(input.agentRoot, validation.record, input)
  })
}

export function readCommerceAccessLog(agentRoot: string, limit = 20): CommerceAccessLogEntry[] {
  try {
    const lines = fs.readFileSync(accessLogPath(agentRoot), "utf-8").trim().split("\n").filter(Boolean)
    const entries = lines.map((line) => JSON.parse(line) as CommerceAccessLogEntry)
    emitNervesEvent({
      component: "repertoire",
      event: "repertoire.commerce_access_log_read",
      message: "read commerce access log",
      meta: { limit },
    })
    return entries.slice(-limit)
  } catch {
    return []
  }
}

export function confirmationPhrase(): string {
  emitNervesEvent({
    component: "repertoire",
    event: "repertoire.commerce_confirmation_phrase_read",
    message: "read commerce confirmation phrase",
    meta: {},
  })
  return CONFIRMATION_PHRASE
}
