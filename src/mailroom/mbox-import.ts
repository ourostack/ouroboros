import { simpleParser } from "mailparser"
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

async function parseMboxMessage(rawMessage: Buffer, grant: SourceGrantRecord): Promise<ParsedMboxMessage> {
  const parsed = await simpleParser(rawMessage)
  const mailFrom = parsed.from?.value?.[0]?.address
  return {
    rawMessage,
    envelope: {
      mailFrom: mailFrom ? normalizeMailAddress(mailFrom) : "",
      rcptTo: [normalizeMailAddress(grant.aliasAddress)],
      remoteAddress: "mbox-import",
    },
    ...(parsed.date ? { messageDate: parsed.date } : {}),
  }
}

function latestMessageDate(messages: ParsedMboxMessage[]): string | null {
  const timestamps = messages
    .map((message) => message.messageDate?.getTime())
    .filter((timestamp): timestamp is number => typeof timestamp === "number" && Number.isFinite(timestamp))
  if (timestamps.length === 0) return null
  return new Date(Math.max(...timestamps)).toISOString()
}

function historicalImportClassification(resolvedPlacement: StoredMailMessage["placement"], sourceGrant: SourceGrantRecord): MailClassification {
  return {
    placement: resolvedPlacement,
    candidate: false,
    trustReason: `delegated source grant ${sourceGrant.source} historical mbox import`,
  }
}

export async function importMboxToStore(input: MboxImportInput): Promise<MboxImportResult> {
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

  let imported = 0
  let duplicates = 0
  const messages: StoredMailMessage[] = []
  const rawMessages = splitMboxMessages(input.rawMbox)
  const parsedMessages = await Promise.all(rawMessages.map((rawMessage) => parseMboxMessage(rawMessage, sourceGrant)))
  const importedAt = (input.importedAt ?? new Date()).toISOString()
  const sourceFreshThrough = latestMessageDate(parsedMessages)
  for (const parsedMessage of parsedMessages) {
    const result = await input.store.putRawMessage({
      resolved,
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
      classification: historicalImportClassification(resolved.defaultPlacement, sourceGrant),
    })
    messages.push(result.message)
    if (result.created) imported += 1
    else duplicates += 1
  }

  emitNervesEvent({
    component: "senses",
    event: "senses.mail_mbox_imported",
    message: "mbox mail imported",
    meta: { agentId, scanned: rawMessages.length, imported, duplicates, grantId: sourceGrant.grantId },
  })
  return {
    agentId,
    sourceGrant,
    scanned: rawMessages.length,
    imported,
    duplicates,
    sourceFreshThrough,
    messages,
  }
}
