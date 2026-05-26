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

function writeRecord(agentRoot: string, record: CommerceMandateRecord): void {
  fs.mkdirSync(recordsDir(agentRoot), { recursive: true })
  fs.writeFileSync(recordPath(agentRoot, record.id), `${JSON.stringify(record, null, 2)}\n`, "utf-8")
}

export function commerceAuthorityToken(record: Pick<CommerceMandateRecord, "id" | "digest">): string {
  const token = `commerce:${record.id}:${record.digest}`
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
  if (Date.parse(record.expiresAt) <= Date.now()) throw new Error("commerce checkout preview has expired")
  if (record.digest !== input.digest) throw new Error("commerce digest mismatch")
  if (input.confirmation.trim() !== CONFIRMATION_PHRASE) throw new Error(`confirmation must be ${CONFIRMATION_PHRASE}`)
  const currentUserMessage = input.currentUserMessage?.trim() ?? ""
  if (!currentUserMessage.includes(CONFIRMATION_PHRASE)
    || !currentUserMessage.includes(record.id)
    || !currentUserMessage.includes(record.digest)) {
    throw new Error(`current human message must include ${CONFIRMATION_PHRASE}, checkout id, and digest`)
  }
  const now = new Date().toISOString()
  const confirmed: CommerceMandateRecord = {
    ...record,
    status: "confirmed",
    confirmedAt: now,
    updatedAt: now,
    confirmation: CONFIRMATION_PHRASE,
    confirmedByMessage: currentUserMessage,
    authorityToken: commerceAuthorityToken(record),
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
  const parsed = Number.parseFloat(raw)
  return Number.isFinite(parsed) ? parsed : null
}

function currencyFromArgs(args: Record<string, string> | undefined): string | null {
  const raw = args?.currency
  return raw ? raw.trim().toLowerCase() : null
}

function requiredAmountForTool(toolName: string): "amount" | "spend_limit" | null {
  if (toolName === "stripe_create_card") return "spend_limit"
  if (toolName === "flight_book") return "amount"
  return null
}

function requiredConstraintsForTool(toolName: string): string[] {
  if (toolName === "stripe_create_card") return ["type"]
  if (toolName === "flight_hold" || toolName === "flight_book") return ["offer_id"]
  return []
}

export function validateCommerceAuthorityToken(input: CommerceAuthorityValidationInput): CommerceAuthorityValidationResult {
  const token = input.token?.trim()
  if (!token) return { ok: false, reason: "missing commerce_authority token" }
  const match = /^commerce:([^:]+):([a-f0-9]{64})$/.exec(token)
  if (!match) return { ok: false, reason: "invalid commerce_authority token format" }
  const checkoutId = match[1]
  const digest = match[2]
  const record = readCommerceRecord(input.agentRoot, checkoutId)
  if (!record) return { ok: false, reason: "commerce checkout not found" }
  let reason: string | null = null
  if (record.status !== "confirmed") reason = `commerce checkout is ${record.status}, not confirmed`
  if (!reason && input.friendId && record.friendId !== input.friendId) reason = "commerce_authority belongs to a different friend"
  if (!reason && record.digest !== digest) reason = "commerce_authority digest mismatch"
  if (!reason && Date.parse(record.expiresAt) <= Date.now()) reason = "commerce_authority expired"
  const allowedTools = record.allowedTools ?? []
  if (!reason && !allowedTools.includes(input.toolName)) reason = "tool is not allowed by commerce_authority"
  const requiredAmountKey = requiredAmountForTool(input.toolName)
  const amount = amountFromArgs(input.args)
  if (!reason && requiredAmountKey && amount === null) reason = `tool ${requiredAmountKey} is required for commerce_authority validation`
  if (!reason && amount !== null && amount !== record.amount) reason = "tool amount does not match commerce_authority amount"
  const currency = currencyFromArgs(input.args)
  if (!reason && requiredAmountKey && !currency) reason = "tool currency is required for commerce_authority validation"
  if (!reason && currency && currency !== record.currency) reason = "tool currency does not match commerce_authority"
  const constraints = record.constraints ?? {}
  for (const key of requiredConstraintsForTool(input.toolName)) {
    if (reason) break
    if (!constraints[key]) reason = `commerce_authority is missing required ${key} constraint`
  }
  for (const [key, expected] of Object.entries(constraints)) {
    if (reason) break
    const actual = input.args?.[key]?.trim()
    if (actual !== expected) reason = `tool ${key} does not match commerce_authority`
  }
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
