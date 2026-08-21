import { createHmac, randomUUID } from "node:crypto"
import {
  appendFileSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs"
import path from "node:path"

import type { LogEvent } from "../nerves"
import { redactLogEntry, redactString } from "../nerves/redact"
import { emitNervesEvent } from "../nerves/runtime"

const SCHEMA = "sanctuary-telegram-audit-chain-v1"
const GENESIS_MAC = "0".repeat(64)
const SHA256 = /^[0-9a-f]{64}$/u
const MAX_BYTES = 32 * 1024 * 1024
const MAX_ROWS = 100_000
const MAX_ROW_BYTES = 64 * 1024
const LEVELS = new Set(["debug", "info", "warn", "error"])
const ROW_KEYS = ["component", "event", "level", "message", "meta", "previousMac", "rowMac", "schemaVersion", "sequence", "trace_id", "ts"].sort()
const HEAD_KEYS = ["headMac", "lastMac", "recordCount", "schemaVersion"].sort()

export const TELEGRAM_ACCEPTANCE_AUDIT_RELATIVE_PATH = path.join("state", "acceptance", "telegram-audit-chain.ndjson")
export const TELEGRAM_ACCEPTANCE_AUDIT_HEAD_RELATIVE_PATH = path.join("state", "acceptance", "telegram-audit-chain.head.json")

interface AuditRow {
  schemaVersion: typeof SCHEMA
  sequence: number
  previousMac: string
  ts: string
  level: LogEvent["level"]
  event: string
  component: string
  trace_id: string
  message: string
  meta: Record<string, unknown>
  rowMac: string
}

interface AuditHead {
  schemaVersion: typeof SCHEMA
  recordCount: number
  lastMac: string
  headMac: string
}

export interface VerifiedTelegramAuditEvent {
  event: string
  at: number
  meta: Record<string, unknown>
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`
  }
  const rendered = JSON.stringify(value)
  if (rendered === undefined) throw new Error("Telegram audit ledger contains an unsupported value")
  return rendered
}

function rowMac(identityKey: string, row: Omit<AuditRow, "rowMac">): string {
  return createHmac("sha256", identityKey).update(`ouroboros.telegram.audit-row.v1\0${canonicalJson(row)}`, "utf8").digest("hex")
}

function headMac(identityKey: string, recordCount: number, lastMac: string): string {
  return createHmac("sha256", identityKey).update(`ouroboros.telegram.audit-head.v1\0${recordCount}\0${lastMac}`, "utf8").digest("hex")
}

function canonicalIso(value: unknown): value is string {
  return typeof value === "string" && value.length <= 30 && Number.isFinite(Date.parse(value)) && new Date(Date.parse(value)).toISOString() === value
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} is invalid`)
  return value as Record<string, unknown>
}

function parseJson(raw: string, label: string): unknown {
  try { return JSON.parse(raw) as unknown }
  catch (error) { throw new Error(`${label} JSON is invalid`, { cause: error }) }
}

function containsPrivateMaterial(raw: string, privateValues: readonly string[]): boolean {
  return privateValues.some((value) => value.length >= 5 && raw.includes(value))
    || /\b\d{5,16}:[A-Za-z0-9_-]{20,}\b/u.test(raw)
    || /"(?:authorized_?user_?id|authorized_?chat_?id|transport_?user_?id|transport_?chat_?id|user_?id|chat_?id|update_?id|message_?id)"\s*:\s*"?\d{1,20}"?/iu.test(raw)
}

function parseHead(raw: string, identityKey: string): AuditHead {
  if (Buffer.byteLength(raw) > 4 * 1024) throw new Error("Telegram audit head exceeds its bound")
  const value = object(parseJson(raw, "Telegram audit head"), "Telegram audit head")
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(HEAD_KEYS)
    || value.schemaVersion !== SCHEMA
    || !Number.isSafeInteger(value.recordCount) || Number(value.recordCount) < 0 || Number(value.recordCount) > MAX_ROWS
    || typeof value.lastMac !== "string" || !SHA256.test(value.lastMac)
    || typeof value.headMac !== "string" || !SHA256.test(value.headMac)
    || value.headMac !== headMac(identityKey, Number(value.recordCount), value.lastMac)) throw new Error("Telegram audit head MAC is invalid")
  return value as unknown as AuditHead
}

export function verifyTelegramAuditLedger(options: {
  ledgerRaw: string
  headRaw: string
  identityKey: string
  privateValues?: readonly string[]
}): VerifiedTelegramAuditEvent[] {
  if (Buffer.byteLength(options.ledgerRaw) > MAX_BYTES) throw new Error("Telegram audit ledger exceeds its bound")
  const lines = options.ledgerRaw.split("\n").filter(Boolean)
  if (lines.length > MAX_ROWS || lines.some((line) => Buffer.byteLength(line) > MAX_ROW_BYTES)) throw new Error("Telegram audit ledger exceeds its bound")
  const head = parseHead(options.headRaw, options.identityKey)
  let previousMac = GENESIS_MAC
  const events = lines.map((line, index) => {
    if (containsPrivateMaterial(line, options.privateValues ?? [])) throw new Error("Telegram audit ledger contains private material")
    const value = object(parseJson(line, "Telegram audit ledger row"), "Telegram audit ledger row")
    if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(ROW_KEYS)
      || value.schemaVersion !== SCHEMA || value.sequence !== index + 1 || value.previousMac !== previousMac
      || !canonicalIso(value.ts) || typeof value.level !== "string" || !LEVELS.has(value.level)
      || typeof value.event !== "string" || value.event.length < 1 || value.event.length > 256
      || typeof value.component !== "string" || value.component.length < 1 || value.component.length > 128
      || typeof value.trace_id !== "string" || value.trace_id.length < 1 || value.trace_id.length > 256
      || typeof value.message !== "string" || value.message.length > 4_096
      || !value.meta || typeof value.meta !== "object" || Array.isArray(value.meta)
      || typeof value.rowMac !== "string" || !SHA256.test(value.rowMac)) throw new Error("Telegram audit ledger row is invalid")
    const unsigned = Object.fromEntries(Object.entries(value).filter(([key]) => key !== "rowMac")) as unknown as Omit<AuditRow, "rowMac">
    if (value.rowMac !== rowMac(options.identityKey, unsigned)) throw new Error("Telegram audit ledger row MAC is invalid")
    previousMac = value.rowMac
    return { event: value.event, at: Date.parse(value.ts), meta: value.meta as Record<string, unknown> }
  })
  if (head.recordCount !== lines.length || head.lastMac !== previousMac) throw new Error("Telegram audit head does not match the append-only ledger")
  return events
}

function writeHead(filePath: string, directory: string, head: AuditHead): void {
  const temporary = `${filePath}.tmp-${process.pid}-${randomUUID()}`
  writeFileSync(temporary, `${JSON.stringify(head)}\n`, { flag: "wx", mode: 0o600 })
  const file = openSync(temporary, "r")
  try { fsyncSync(file) } finally { closeSync(file) }
  renameSync(temporary, filePath)
  const directoryHandle = openSync(directory, "r")
  try { fsyncSync(directoryHandle) } finally { closeSync(directoryHandle) }
}

export interface TelegramAuditLedger {
  ledgerPath: string
  headPath: string
  append(event: LogEvent): void
  assertHealthy(): void
  assertCapacity(additionalRows?: number): void
}

export function createTelegramAuditLedger(options: {
  root: string
  identityKey: string
  privateValues?: readonly string[]
  /** Test seam for exercising aggregate overflow without allocating a 32 MB fixture. */
  _maxBytes?: number
}): TelegramAuditLedger {
  const directory = path.join(options.root, "state", "acceptance")
  const ledgerPath = path.join(options.root, TELEGRAM_ACCEPTANCE_AUDIT_RELATIVE_PATH)
  const headPath = path.join(options.root, TELEGRAM_ACCEPTANCE_AUDIT_HEAD_RELATIVE_PATH)
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  if (existsSync(ledgerPath) !== existsSync(headPath)) throw new Error("Telegram audit ledger/head presence mismatch")
  if (!existsSync(ledgerPath)) {
    writeFileSync(ledgerPath, "", { flag: "wx", mode: 0o600 })
    writeHead(headPath, directory, { schemaVersion: SCHEMA, recordCount: 0, lastMac: GENESIS_MAC, headMac: headMac(options.identityKey, 0, GENESIS_MAC) })
  }
  let records = verifyTelegramAuditLedger({ ledgerRaw: readFileSync(ledgerPath, "utf8"), headRaw: readFileSync(headPath, "utf8"), identityKey: options.identityKey, privateValues: options.privateValues })
  let currentHead = parseHead(readFileSync(headPath, "utf8"), options.identityKey)
  const maxBytes = options._maxBytes ?? MAX_BYTES
  let failure: Error | undefined
  emitNervesEvent({
    component: "senses",
    event: "senses.telegram_audit_ledger_ready",
    message: "Telegram acceptance audit ledger is verified",
    meta: { recordCount: currentHead.recordCount },
  })
  return {
    ledgerPath,
    headPath,
    append(event) {
      if (failure) throw failure
      try {
        const original = JSON.stringify(event)
        if (containsPrivateMaterial(original, options.privateValues ?? [])) throw new Error("Telegram audit event contains private material")
        const redacted = JSON.parse(redactString(JSON.stringify(redactLogEntry(event)))) as LogEvent
        const unsigned: Omit<AuditRow, "rowMac"> = {
          schemaVersion: SCHEMA,
          sequence: currentHead.recordCount + 1,
          previousMac: currentHead.lastMac,
          ts: redacted.ts,
          level: redacted.level,
          event: redacted.event,
          component: redacted.component,
          trace_id: redacted.trace_id,
          message: redacted.message,
          meta: redacted.meta,
        }
        const row: AuditRow = { ...unsigned, rowMac: rowMac(options.identityKey, unsigned) }
        const serialized = JSON.stringify(row)
        if (Buffer.byteLength(serialized) > MAX_ROW_BYTES || currentHead.recordCount >= MAX_ROWS
          || Buffer.byteLength(readFileSync(ledgerPath)) + Buffer.byteLength(serialized) + 1 > maxBytes) throw new Error("Telegram audit ledger exceeds its bound")
        appendFileSync(ledgerPath, `${serialized}\n`, { encoding: "utf8", mode: 0o600 })
        const ledgerHandle = openSync(ledgerPath, "r")
        try { fsyncSync(ledgerHandle) } finally { closeSync(ledgerHandle) }
        currentHead = {
          schemaVersion: SCHEMA,
          recordCount: row.sequence,
          lastMac: row.rowMac,
          headMac: headMac(options.identityKey, row.sequence, row.rowMac),
        }
        writeHead(headPath, directory, currentHead)
        records = [...records, { event: row.event, at: Date.parse(row.ts), meta: row.meta }]
      } catch (error) {
        failure = error instanceof Error ? error : new Error(String(error))
        throw failure
      }
    },
    assertHealthy() {
      if (failure) throw failure
      records = verifyTelegramAuditLedger({ ledgerRaw: readFileSync(ledgerPath, "utf8"), headRaw: readFileSync(headPath, "utf8"), identityKey: options.identityKey, privateValues: options.privateValues })
      currentHead = parseHead(readFileSync(headPath, "utf8"), options.identityKey)
    },
    assertCapacity(additionalRows = 1) {
      if (!Number.isSafeInteger(additionalRows) || additionalRows < 1) throw new Error("Telegram audit capacity reservation is invalid")
      if (failure) throw failure
      if (currentHead.recordCount + additionalRows > MAX_ROWS
        || Buffer.byteLength(readFileSync(ledgerPath)) + additionalRows * (MAX_ROW_BYTES + 1) > maxBytes) {
        throw new Error("Telegram audit ledger lacks reserved capacity")
      }
    },
  }
}
