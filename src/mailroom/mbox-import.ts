import * as fs from "node:fs"
import { emitNervesEvent } from "../nerves/runtime"
import {
  type MailClassification,
  normalizeMailAddress,
  resolveMailAddress,
  type MailEnvelopeInput,
  type MailroomRegistry,
  type SourceGrantRecord,
  type StoredMailMessage,
} from "./core"
import { type MailroomStore } from "./file-store"

export interface MboxImportInput {
  registry: MailroomRegistry
  store: MailroomStore
  agentId: string
  rawMbox: Buffer
  ownerEmail?: string
  source?: string
  importedAt?: Date
}

export interface MboxFileImportInput extends Omit<MboxImportInput, "rawMbox"> {
  filePath: string
}

export interface MboxImportResult {
  agentId: string
  sourceGrant: SourceGrantRecord
  scanned: number
  imported: number
  duplicates: number
  sourceFreshThrough: string | null
  messages: StoredMailMessage[]
}

interface ParsedMboxMessage {
  rawMessage: Buffer
  envelope: MailEnvelopeInput
  messageDate?: Date
}

interface ImportParsedMessagesInput {
  sourceGrant: SourceGrantRecord
  resolved: NonNullable<ReturnType<typeof resolveMailAddress>>
  store: MailroomStore
  parsedMessages: Iterable<ParsedMboxMessage> | AsyncIterable<ParsedMboxMessage>
  importedAt?: Date
  collectMessages?: boolean
  sourceFreshThrough?: string | null
  maxConcurrency?: number
}

export function splitMboxMessages(rawMbox: Buffer): Buffer[] {
  const text = rawMbox.toString("utf-8")
  const separators = [...text.matchAll(/^From [^\r\n]*(?:\r?\n)/gm)]
  if (separators.length === 0) {
    const trimmed = text.trim()
    return trimmed ? [Buffer.from(text, "utf-8")] : []
  }

  const messages = separators
    .map((match, index) => {
      const start = (match.index as number) + match[0].length
      const end = index + 1 < separators.length ? separators[index + 1].index as number : text.length
      return text.slice(start, end).replace(/\r?\n$/, "")
    })
    .filter((message) => message.trim().length > 0)
    .map((message) => Buffer.from(message, "utf-8"))

  emitNervesEvent({
    component: "senses",
    event: "senses.mail_mbox_split",
    message: "mbox payload split into messages",
    meta: { messages: messages.length },
  })
  return messages
}

function trimTrailingLineEnding(message: Buffer): Buffer {
  if (message.length >= 2 && message[message.length - 2] === 0x0d && message[message.length - 1] === 0x0a) {
    return message.subarray(0, -2)
  }
  if (message.length >= 1 && message[message.length - 1] === 0x0a) {
    return message.subarray(0, -1)
  }
  return message
}

function isSeparatorLine(line: Buffer): boolean {
  return line.length >= 5 &&
    line[0] === 0x46 &&
    line[1] === 0x72 &&
    line[2] === 0x6f &&
    line[3] === 0x6d &&
    line[4] === 0x20
}

async function* streamMboxMessagesFromFile(filePath: string): AsyncGenerator<Buffer> {
  const stream = fs.createReadStream(filePath)
  let pending = Buffer.alloc(0)
  let currentParts: Buffer[] = []

  const flushCurrent = () => {
    if (currentParts.length === 0) return null
    const message = trimTrailingLineEnding(Buffer.concat(currentParts))
    currentParts = []
    return message
  }

  for await (const chunk of stream) {
    pending = pending.length > 0 ? Buffer.concat([pending, chunk]) : Buffer.from(chunk)
    let newlineIndex = pending.indexOf(0x0a)
    while (newlineIndex >= 0) {
      const line = pending.subarray(0, newlineIndex + 1)
      pending = pending.subarray(newlineIndex + 1)
      if (isSeparatorLine(line)) {
        const message = flushCurrent()
        if (message && message.length > 0) yield message
      } else {
        currentParts.push(Buffer.from(line))
      }
      newlineIndex = pending.indexOf(0x0a)
    }
  }

  if (pending.length > 0) {
    if (isSeparatorLine(pending)) {
      const message = flushCurrent()
      if (message && message.length > 0) yield message
    } else {
      currentParts.push(Buffer.from(pending))
    }
  }

  const finalMessage = flushCurrent()
  if (finalMessage && finalMessage.length > 0) yield finalMessage
}

function findSourceGrant(input: {
  registry: MailroomRegistry
  agentId: string
  ownerEmail?: string
  source?: string
}): SourceGrantRecord {
  const ownerEmail = input.ownerEmail ? normalizeMailAddress(input.ownerEmail) : undefined
  const source = input.source?.trim().toLowerCase()
  const grants = input.registry.sourceGrants.filter((grant) => {
    if (!grant.enabled || grant.agentId !== input.agentId) return false
    if (ownerEmail && normalizeMailAddress(grant.ownerEmail) !== ownerEmail) return false
    if (source && grant.source.toLowerCase() !== source) return false
    return true
  })
  if (grants.length === 0) {
    throw new Error(`No enabled Mailroom source grant found for ${input.agentId}${ownerEmail ? ` owner ${ownerEmail}` : ""}${source ? ` source ${source}` : ""}`)
  }
  if (grants.length > 1 && !ownerEmail && !source) {
    throw new Error(`Multiple source grants found for ${input.agentId}; pass --owner-email or --source to choose one`)
  }
  return grants[0]
}

function parseMboxMessage(rawMessage: Buffer, grant: SourceGrantRecord): ParsedMboxMessage {
  const mailFrom = extractHeaderAddress(rawMessage, "from")
  const messageDate = extractHeaderDate(rawMessage, "date")
  return {
    rawMessage,
    envelope: {
      mailFrom: mailFrom ? normalizeMailAddress(mailFrom) : "",
      rcptTo: [normalizeMailAddress(grant.aliasAddress)],
      remoteAddress: "mbox-import",
    },
    ...(messageDate ? { messageDate } : {}),
  }
}

function latestMessageDate(messages: ParsedMboxMessage[]): string | null {
  const timestamps = messages
    .map((message) => message.messageDate?.getTime())
    .filter((timestamp): timestamp is number => typeof timestamp === "number" && Number.isFinite(timestamp))
  if (timestamps.length === 0) return null
  return new Date(Math.max(...timestamps)).toISOString()
}

function readHeaderBlock(rawMessage: Buffer): string {
  const crlfBoundary = rawMessage.indexOf("\r\n\r\n")
  if (crlfBoundary >= 0) {
    return rawMessage.subarray(0, crlfBoundary).toString("utf-8")
  }
  const lfBoundary = rawMessage.indexOf("\n\n")
  if (lfBoundary >= 0) {
    return rawMessage.subarray(0, lfBoundary).toString("utf-8")
  }
  return rawMessage.toString("utf-8")
}

function extractHeaderValue(rawMessage: Buffer, headerName: string): string {
  const target = `${headerName.toLowerCase()}:`
  let currentHeader = ""
  const unfoldedHeaders: string[] = []
  for (const line of readHeaderBlock(rawMessage).split(/\r?\n/)) {
    if (/^[ \t]/.test(line) && currentHeader) {
      currentHeader += ` ${line.trim()}`
      continue
    }
    if (currentHeader) unfoldedHeaders.push(currentHeader)
    currentHeader = line
  }
  if (currentHeader) unfoldedHeaders.push(currentHeader)
  const match = unfoldedHeaders.find((line) => line.toLowerCase().startsWith(target))
  return match ? match.slice(target.length).trim() : ""
}

function extractHeaderAddress(rawMessage: Buffer, headerName: string): string {
  const value = extractHeaderValue(rawMessage, headerName)
  if (!value) return ""
  const bracketed = value.match(/<([^>]+)>/)
  if (bracketed?.[1]) return bracketed[1]
  const plain = value.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)
  return plain?.[0] ?? ""
}

function extractHeaderDate(rawMessage: Buffer, headerName: string): Date | undefined {
  const value = extractHeaderValue(rawMessage, headerName)
  if (!value) return undefined
  const parsed = new Date(value)
  return Number.isFinite(parsed.getTime()) ? parsed : undefined
}

function historicalImportClassification(resolvedPlacement: StoredMailMessage["placement"], sourceGrant: SourceGrantRecord): MailClassification {
  return {
    placement: resolvedPlacement,
    candidate: false,
    trustReason: `delegated source grant ${sourceGrant.source} historical mbox import`,
  }
}

async function importParsedMessagesToStore(input: ImportParsedMessagesInput): Promise<MboxImportResult> {
  let imported = 0
  let duplicates = 0
  const messages: StoredMailMessage[] = []
  let scanned = 0
  const importedAt = (input.importedAt ?? new Date()).toISOString()
  const sourceFreshThrough = input.sourceFreshThrough ?? null
  const maxConcurrency = Math.max(1, input.maxConcurrency ?? 1)
  const inFlight = new Set<Promise<void>>()

  const enqueue = (parsedMessage: ParsedMboxMessage) => {
    const task = (async () => {
      const result = await input.store.putRawMessage({
        resolved: input.resolved,
        envelope: parsedMessage.envelope,
        rawMime: parsedMessage.rawMessage,
        receivedAt: parsedMessage.messageDate ?? input.importedAt,
        ingest: {
          schemaVersion: 1,
          kind: "mbox-import",
          importedAt,
          sourceFreshThrough,
          attentionSuppressed: true,
        },
        classification: historicalImportClassification(input.resolved.defaultPlacement, input.sourceGrant),
      })
      if (input.collectMessages !== false) messages.push(result.message)
      if (result.created) imported += 1
      else duplicates += 1
    })().finally(() => {
      inFlight.delete(task)
    })
    inFlight.add(task)
    return task
  }

  for await (const parsedMessage of input.parsedMessages) {
    scanned += 1
    enqueue(parsedMessage)
    if (inFlight.size >= maxConcurrency) {
      await Promise.race(inFlight)
    }
  }
  await Promise.all(inFlight)

  emitNervesEvent({
    component: "senses",
    event: "senses.mail_mbox_imported",
    message: "mbox mail imported",
    meta: { agentId: input.sourceGrant.agentId.toLowerCase(), scanned, imported, duplicates, grantId: input.sourceGrant.grantId },
  })
  return {
    agentId: input.sourceGrant.agentId.toLowerCase(),
    sourceGrant: input.sourceGrant,
    scanned,
    imported,
    duplicates,
    sourceFreshThrough,
    messages,
  }
}

async function scanMboxFileFreshness(filePath: string, sourceGrant: SourceGrantRecord): Promise<string | null> {
  let latestTimestamp = Number.NEGATIVE_INFINITY
  for await (const rawMessage of streamMboxMessagesFromFile(filePath)) {
    const parsedMessage = parseMboxMessage(rawMessage, sourceGrant)
    if (parsedMessage.messageDate) {
      latestTimestamp = Math.max(latestTimestamp, parsedMessage.messageDate.getTime())
    }
  }
  return Number.isFinite(latestTimestamp) ? new Date(latestTimestamp).toISOString() : null
}

function resolveImportTarget(input: Pick<MboxImportInput, "registry" | "agentId" | "ownerEmail" | "source">): {
  agentId: string
  sourceGrant: SourceGrantRecord
  resolved: NonNullable<ReturnType<typeof resolveMailAddress>>
} {
  const agentId = input.agentId.toLowerCase()
  const sourceGrant = findSourceGrant({
    registry: input.registry,
    agentId,
    ownerEmail: input.ownerEmail,
    source: input.source,
  })
  const resolved = resolveMailAddress(input.registry, sourceGrant.aliasAddress)
  /* v8 ignore start -- findSourceGrant and resolveMailAddress share the same registry; this is a corruption guard. @preserve */
  if (!resolved) {
    throw new Error(`Source grant alias ${sourceGrant.aliasAddress} is not resolvable`)
  }
  /* v8 ignore stop */
  return { agentId, sourceGrant, resolved }
}

export async function importMboxToStore(input: MboxImportInput): Promise<MboxImportResult> {
  const target = resolveImportTarget(input)
  const rawMessages = splitMboxMessages(input.rawMbox)
  const parsedMessages = rawMessages.map((rawMessage) => parseMboxMessage(rawMessage, target.sourceGrant))
  const sourceFreshThrough = latestMessageDate(parsedMessages)
  return importParsedMessagesToStore({
    sourceGrant: target.sourceGrant,
    resolved: target.resolved,
    store: input.store,
    parsedMessages,
    importedAt: input.importedAt,
    collectMessages: true,
    sourceFreshThrough,
    maxConcurrency: 1,
  })
}

export async function importMboxFileToStore(input: MboxFileImportInput): Promise<MboxImportResult> {
  const target = resolveImportTarget(input)
  const sourceFreshThrough = await scanMboxFileFreshness(input.filePath, target.sourceGrant)
  async function* parsedMessages(): AsyncGenerator<ParsedMboxMessage> {
    for await (const rawMessage of streamMboxMessagesFromFile(input.filePath)) {
      yield parseMboxMessage(rawMessage, target.sourceGrant)
    }
  }
  return importParsedMessagesToStore({
    sourceGrant: target.sourceGrant,
    resolved: target.resolved,
    store: input.store,
    parsedMessages: parsedMessages(),
    importedAt: input.importedAt,
    collectMessages: false,
    sourceFreshThrough,
    maxConcurrency: 8,
  })
}
