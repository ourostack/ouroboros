import * as fs from "node:fs"
import * as path from "node:path"
import { emitNervesEvent } from "../nerves/runtime"
import {
  SENSE_CONTEXT_PACKET_POLICY_VERSION,
  type SenseContextPacket,
  type SenseContextPacketMessage,
} from "./context-packets"

export interface SenseContextPacketWriteResult {
  packetPath: string
  ledgerPath: string
  receiptPath: string
}

export interface SenseContextLedgerRow {
  schemaVersion: 1
  policyVersion: typeof SENSE_CONTEXT_PACKET_POLICY_VERSION
  packetId: string
  sense: string
  agent: string
  chatKeyHash: string
  anchorMessageGuid: string
  anchorTimestamp: string
  createdAt: string
  packetPath: string
  receiptPath: string
  messageCount: number
  sourceRefs: string[]
  bodyHashes: string[]
  rawBodyStored: false
  privacyClass: "private-runtime"
  omittedMessages: number
  truncatedMessages: number
}

interface SenseContextReceipt {
  schemaVersion: 1
  policyVersion: typeof SENSE_CONTEXT_PACKET_POLICY_VERSION
  packetId: string
  sense: string
  agent: string
  createdAt: string
  compacted: boolean
  sourceRefs: string[]
  bodyHashes: string[]
  messagePreviews?: Array<{ sourceRef: string; preview: string }>
}

export interface LatestVisibleSenseContextPacketInput {
  sense: string
  chatKeyHash: string
  beforeAnchorTimestamp: string
  maxAgeMs: number
}

export interface CompactSenseContextPacketReceiptsResult {
  inspected: number
  compacted: number
}

export type SenseContextPacketSummary = Pick<
  SenseContextLedgerRow,
  | "packetId"
  | "sense"
  | "agent"
  | "chatKeyHash"
  | "anchorMessageGuid"
  | "anchorTimestamp"
  | "createdAt"
  | "messageCount"
  | "sourceRefs"
  | "bodyHashes"
  | "rawBodyStored"
  | "privacyClass"
  | "omittedMessages"
  | "truncatedMessages"
>

export interface SenseContextPacketSummaryList {
  totalCount: number
  limit: number
  items: SenseContextPacketSummary[]
}

export interface SenseContextPacketViewMessage {
  timestamp: string
  authorLabel: string
  bodyHash: string
  bodyPreview: string
  sourceRef: SenseContextPacketMessage["sourceRef"]
  renderedSourceRef: string
}

export interface SenseContextPacketViewPacket {
  packetId: string
  sense: string
  agent: string
  privacyClass: SenseContextPacket["privacyClass"]
  messages: SenseContextPacketViewMessage[]
  omittedMessages: number
  truncatedMessages: number
}

export interface SenseContextPacketView {
  row: SenseContextPacketSummary
  packet: SenseContextPacketViewPacket
}

export interface SenseContextPacketListOptions {
  sense?: string
  limit?: number
}

function contextPacketRoot(agentRoot: string, sense: string): string {
  return path.join(agentRoot, "state", "senses", "context-packets", sense)
}

function contextPacketBaseRoot(agentRoot: string): string {
  return path.join(agentRoot, "state", "senses", "context-packets")
}

function packetPath(agentRoot: string, packet: SenseContextPacket): string {
  const month = packet.anchorTimestamp.slice(0, 7) || "unknown"
  return path.join(contextPacketRoot(agentRoot, packet.sense), month, `${packet.packetId}.json`)
}

function ledgerPath(agentRoot: string, sense: string): string {
  return path.join(contextPacketRoot(agentRoot, sense), "ledger.jsonl")
}

function receiptsDir(agentRoot: string, sense: string): string {
  return path.join(contextPacketRoot(agentRoot, sense), "receipts")
}

function receiptPath(agentRoot: string, packet: SenseContextPacket): string {
  return path.join(receiptsDir(agentRoot, packet.sense), `${packet.packetId}.json`)
}

function atomicWriteJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`
  fs.writeFileSync(tmpPath, `${JSON.stringify(value, null, 2)}\n`, "utf-8")
  fs.renameSync(tmpPath, filePath)
}

function preview160(message: SenseContextPacketMessage): { sourceRef: string; preview: string } {
  return {
    sourceRef: message.renderedSourceRef,
    preview: message.bodyPreview.slice(0, 160),
  }
}

function buildReceipt(packet: SenseContextPacket, createdAt: string): SenseContextReceipt {
  return {
    schemaVersion: 1,
    policyVersion: SENSE_CONTEXT_PACKET_POLICY_VERSION,
    packetId: packet.packetId,
    sense: packet.sense,
    agent: packet.agent,
    createdAt,
    compacted: false,
    sourceRefs: packet.messages.map((message) => message.renderedSourceRef),
    bodyHashes: packet.messages.map((message) => message.bodyHash),
    messagePreviews: packet.messages.map(preview160),
  }
}

function buildLedgerRow(
  packet: SenseContextPacket,
  createdAt: string,
  paths: { packetPath: string; receiptPath: string },
): SenseContextLedgerRow {
  return {
    schemaVersion: 1,
    policyVersion: SENSE_CONTEXT_PACKET_POLICY_VERSION,
    packetId: packet.packetId,
    sense: packet.sense,
    agent: packet.agent,
    chatKeyHash: packet.chatKeyHash,
    anchorMessageGuid: packet.anchorMessageGuid,
    anchorTimestamp: packet.anchorTimestamp,
    createdAt,
    packetPath: paths.packetPath,
    receiptPath: paths.receiptPath,
    messageCount: packet.messages.length,
    sourceRefs: packet.messages.map((message) => message.renderedSourceRef),
    bodyHashes: packet.messages.map((message) => message.bodyHash),
    rawBodyStored: false,
    privacyClass: "private-runtime",
    omittedMessages: packet.omittedMessages,
    truncatedMessages: packet.truncatedMessages,
  }
}

export function writeSenseContextPacket(
  agentRoot: string,
  packet: SenseContextPacket,
  options: { now?: string } = {},
): SenseContextPacketWriteResult {
  const createdAt = options.now ?? new Date().toISOString()
  const paths = {
    packetPath: packetPath(agentRoot, packet),
    ledgerPath: ledgerPath(agentRoot, packet.sense),
    receiptPath: receiptPath(agentRoot, packet),
  }
  atomicWriteJson(paths.packetPath, packet)
  atomicWriteJson(paths.receiptPath, buildReceipt(packet, createdAt))
  fs.mkdirSync(path.dirname(paths.ledgerPath), { recursive: true })
  fs.appendFileSync(paths.ledgerPath, `${JSON.stringify(buildLedgerRow(packet, createdAt, paths))}\n`, "utf-8")
  emitNervesEvent({
    component: "senses",
    event: "senses.context_packet_persisted",
    message: "persisted sense context packet",
    meta: {
      sense: packet.sense,
      packetId: packet.packetId,
      messageCount: packet.messages.length,
    },
  })
  return paths
}

function isLedgerRow(value: unknown): value is SenseContextLedgerRow {
  const row = value as Partial<SenseContextLedgerRow> | null
  return !!row
    && row.schemaVersion === 1
    && row.policyVersion === SENSE_CONTEXT_PACKET_POLICY_VERSION
    && typeof row.packetId === "string"
    && typeof row.sense === "string"
    && typeof row.agent === "string"
    && typeof row.chatKeyHash === "string"
    && typeof row.anchorMessageGuid === "string"
    && typeof row.anchorTimestamp === "string"
    && typeof row.createdAt === "string"
    && typeof row.packetPath === "string"
    && typeof row.receiptPath === "string"
    && typeof row.messageCount === "number"
    && Array.isArray(row.sourceRefs)
    && Array.isArray(row.bodyHashes)
    && row.rawBodyStored === false
    && row.privacyClass === "private-runtime"
    && typeof row.omittedMessages === "number"
    && typeof row.truncatedMessages === "number"
}

function emitMalformedLedgerRow(sense: string, lineNumber: number, reason: string): void {
  emitNervesEvent({
    level: "warn",
    component: "senses",
    event: "senses.context_packet_ledger_malformed",
    message: "skipped malformed sense context packet ledger row",
    meta: { sense, lineNumber, reason },
  })
}

export function readSenseContextLedger(agentRoot: string, sense: string): SenseContextLedgerRow[] {
  const filePath = ledgerPath(agentRoot, sense)
  if (!fs.existsSync(filePath)) return []
  const lines = fs.readFileSync(filePath, "utf-8").split("\n").filter((line) => line.trim().length > 0)
  const rows: SenseContextLedgerRow[] = []
  lines.forEach((line, index) => {
    try {
      const parsed = JSON.parse(line) as unknown
      if (isLedgerRow(parsed)) {
        rows.push(parsed)
      } else {
        emitMalformedLedgerRow(sense, index + 1, "invalid shape")
      }
    } catch (error) {
      emitMalformedLedgerRow(sense, index + 1, String(error))
    }
  })
  return rows
}

function safeContextPacketLimit(limit: number | undefined): number {
  return Number.isInteger(limit) && typeof limit === "number" && limit >= 1 && limit <= 100 ? limit : 20
}

function discoverContextPacketSenses(agentRoot: string): string[] {
  const root = contextPacketBaseRoot(agentRoot)
  if (!fs.existsSync(root)) return []
  return fs.readdirSync(root)
    .filter((entry) => {
      try {
        return fs.statSync(path.join(root, entry)).isDirectory()
      } catch {
        return false
      }
    })
    .sort()
}

function summarizeLedgerRow(row: SenseContextLedgerRow): SenseContextPacketSummary {
  return {
    packetId: row.packetId,
    sense: row.sense,
    agent: row.agent,
    chatKeyHash: row.chatKeyHash,
    anchorMessageGuid: row.anchorMessageGuid,
    anchorTimestamp: row.anchorTimestamp,
    createdAt: row.createdAt,
    messageCount: row.messageCount,
    sourceRefs: row.sourceRefs,
    bodyHashes: row.bodyHashes,
    rawBodyStored: row.rawBodyStored,
    privacyClass: row.privacyClass,
    omittedMessages: row.omittedMessages,
    truncatedMessages: row.truncatedMessages,
  }
}

function readAllContextPacketRows(agentRoot: string, sense?: string): SenseContextLedgerRow[] {
  const senses = sense ? [sense] : discoverContextPacketSenses(agentRoot)
  return senses.flatMap((entry) => readSenseContextLedger(agentRoot, entry))
}

function timestampSortValue(value: string): number {
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : 0
}

export function listSenseContextPacketSummaries(
  agentRoot: string,
  options: SenseContextPacketListOptions = {},
): SenseContextPacketSummaryList {
  const limit = safeContextPacketLimit(options.limit)
  const rows = readAllContextPacketRows(agentRoot, options.sense)
    .sort((left, right) =>
      timestampSortValue(right.createdAt || right.anchorTimestamp) - timestampSortValue(left.createdAt || left.anchorTimestamp))
  return {
    totalCount: rows.length,
    limit,
    items: rows.slice(0, limit).map(summarizeLedgerRow),
  }
}

function isSafeContextPacketId(packetId: string): boolean {
  return /^scp_[A-Za-z0-9_-]+$/.test(packetId)
}

function pathInsideContextPacketRoot(agentRoot: string, sense: string, filePath: string): boolean {
  const root = path.resolve(contextPacketRoot(agentRoot, sense))
  const resolved = path.resolve(filePath)
  return resolved === root || resolved.startsWith(`${root}${path.sep}`)
}

function redactPreview(value: string): string {
  return value
    .replace(/\bpassword=[^\s]+/gi, "password=[redacted]")
    .replace(/\b(token|api[_-]?key|secret)=[^\s]+/gi, "$1=[redacted]")
}

function viewMessage(message: SenseContextPacketMessage): SenseContextPacketViewMessage {
  const { chatGuid: _chatGuid, ...sourceRef } = message.sourceRef as SenseContextPacketMessage["sourceRef"] & { chatGuid?: string }
  return {
    timestamp: message.timestamp,
    authorLabel: message.authorLabel,
    bodyHash: message.bodyHash,
    bodyPreview: redactPreview(message.bodyPreview),
    sourceRef,
    renderedSourceRef: message.renderedSourceRef,
  }
}

function emitContextPacketReadWarning(packetId: string, reason: string): void {
  emitNervesEvent({
    level: "warn",
    component: "senses",
    event: "senses.context_packet_read_error",
    message: "failed to read sense context packet view",
    meta: { packetId, reason },
  })
}

export function readSenseContextPacketView(agentRoot: string, packetId: string): SenseContextPacketView | null {
  if (!isSafeContextPacketId(packetId)) return null
  const row = readAllContextPacketRows(agentRoot).find((entry) => entry.packetId === packetId)
  if (!row) return null
  if (!pathInsideContextPacketRoot(agentRoot, row.sense, row.packetPath)) {
    emitContextPacketReadWarning(packetId, "packet path escaped context-packet root")
    return null
  }
  if (!fs.existsSync(row.packetPath)) return null
  try {
    const packet = JSON.parse(fs.readFileSync(row.packetPath, "utf-8")) as Partial<SenseContextPacket>
    if (packet.packetId !== packetId || !Array.isArray(packet.messages)) return null
    return {
      row: summarizeLedgerRow(row),
      packet: {
        packetId,
        sense: typeof packet.sense === "string" ? packet.sense : row.sense,
        agent: typeof packet.agent === "string" ? packet.agent : row.agent,
        privacyClass: packet.privacyClass === "private-runtime" ? packet.privacyClass : "private-runtime",
        messages: packet.messages.map((message) => viewMessage(message as SenseContextPacketMessage)),
        omittedMessages: typeof packet.omittedMessages === "number" ? packet.omittedMessages : row.omittedMessages,
        truncatedMessages: typeof packet.truncatedMessages === "number" ? packet.truncatedMessages : row.truncatedMessages,
      },
    }
  } catch (error) {
    emitContextPacketReadWarning(packetId, error instanceof Error ? error.message : String(error))
    return null
  }
}

function timestampMs(value: string): number {
  return Date.parse(value)
}

export function readLatestVisibleSenseContextPacket(
  agentRoot: string,
  input: LatestVisibleSenseContextPacketInput,
): SenseContextPacket | null {
  const beforeMs = timestampMs(input.beforeAnchorTimestamp)
  const rows = readSenseContextLedger(agentRoot, input.sense)
    .filter((row) => row.chatKeyHash === input.chatKeyHash)
    .filter((row) => timestampMs(row.anchorTimestamp) < beforeMs)
    .filter((row) => beforeMs - timestampMs(row.anchorTimestamp) <= input.maxAgeMs)
    .sort((left, right) => timestampMs(right.anchorTimestamp) - timestampMs(left.anchorTimestamp))
  const row = rows[0]
  if (!row) return null
  try {
    return JSON.parse(fs.readFileSync(row.packetPath, "utf-8")) as SenseContextPacket
  } catch (error) {
    emitNervesEvent({
      level: "warn",
      component: "senses",
      event: "senses.context_packet_read_failed",
      message: "failed to read visible sense context packet",
      meta: {
        sense: input.sense,
        packetId: row.packetId,
        reason: String(error),
      },
    })
    return null
  }
}

function compactReceipt(receipt: SenseContextReceipt): SenseContextReceipt {
  const { messagePreviews: _messagePreviews, ...metadataOnly } = receipt
  return { ...metadataOnly, compacted: true }
}

export function compactSenseContextPacketReceipts(
  agentRoot: string,
  options: { sense: string; now?: string },
): CompactSenseContextPacketReceiptsResult {
  const dir = receiptsDir(agentRoot, options.sense)
  if (!fs.existsSync(dir)) return { inspected: 0, compacted: 0 }
  const nowMs = timestampMs(options.now ?? new Date().toISOString())
  const thresholdMs = 30 * 24 * 60 * 60 * 1000
  let inspected = 0
  let compacted = 0
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith(".json")) continue
    inspected += 1
    const filePath = path.join(dir, name)
    const receipt = JSON.parse(fs.readFileSync(filePath, "utf-8")) as SenseContextReceipt
    if (!receipt.compacted && nowMs - timestampMs(receipt.createdAt) > thresholdMs) {
      atomicWriteJson(filePath, compactReceipt(receipt))
      compacted += 1
    }
  }
  emitNervesEvent({
    component: "senses",
    event: "senses.context_packet_receipts_compacted",
    message: "compacted aged sense context packet receipts",
    meta: { sense: options.sense, inspected, compacted },
  })
  return { inspected, compacted }
}
