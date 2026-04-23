import { BlobServiceClient } from "@azure/storage-blob"
import { emitNervesEvent } from "../nerves/runtime"
import {
  buildStoredMailMessage,
  decryptStoredMailMessage,
  type DecryptedMailMessage,
  type EncryptedPayload,
  type MailClassification,
  type MailDecisionRecord,
  type MailEnvelopeInput,
  type MailOutboundRecord,
  type MailPlacement,
  type ResolvedMailAddress,
  type MailScreenerCandidate,
  type StoredMailMessage,
} from "./core"
import type { MailAccessLogEntry, MailListFilters, MailroomStore, MailScreenerCandidateFilters } from "./file-store"

const MESSAGE_INDEX_PREFIX = "message-index"
const MESSAGE_INDEX_SORT_MAX_MS = 9_999_999_999_999
const MESSAGE_INDEX_SORT_WIDTH = 13
const MESSAGE_INDEX_NO_SOURCE = "~"
const MESSAGE_INDEX_BACKFILL_CONCURRENCY = 16
const MESSAGE_LIST_SCAN_CONCURRENCY = 32

interface StoredMailMessageIndexRecord {
  schemaVersion: 1
  id: string
  agentId: string
  compartmentKind: StoredMailMessage["compartmentKind"]
  placement: MailPlacement
  source?: string
  receivedAt: string
}

export interface AzureBlobMailroomStoreOptions {
  serviceClient: BlobServiceClient
  containerName: string
}

function compareNewestFirst(left: StoredMailMessage, right: StoredMailMessage): number {
  return Date.parse(right.receivedAt) - Date.parse(left.receivedAt)
}

function compareCandidatesNewestFirst(left: MailScreenerCandidate, right: MailScreenerCandidate): number {
  return Date.parse(right.lastSeenAt) - Date.parse(left.lastSeenAt)
}

function blobText(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf-8")
}

async function downloadJson<T>(blob: { exists(): Promise<boolean>; downloadToBuffer(): Promise<Buffer> }): Promise<T | null> {
  if (!await blob.exists()) return null
  return JSON.parse((await blob.downloadToBuffer()).toString("utf-8")) as T
}

function encodeSourceToken(source?: string): string {
  return source ? encodeURIComponent(source.toLowerCase()) : MESSAGE_INDEX_NO_SOURCE
}

function decodeSourceToken(token: string): string | undefined {
  return token === MESSAGE_INDEX_NO_SOURCE ? undefined : decodeURIComponent(token)
}

function parseSortMs(receivedAt: string): number {
  const parsed = Date.parse(receivedAt)
  if (!Number.isFinite(parsed)) return 0
  return Math.max(0, Math.min(MESSAGE_INDEX_SORT_MAX_MS, parsed))
}

function messageIndexPrefix(agentId: string): string {
  return `${MESSAGE_INDEX_PREFIX}/${agentId}/`
}

function messageIndexBlobName(message: Pick<StoredMailMessage, "id" | "agentId" | "compartmentKind" | "placement" | "source" | "receivedAt">): string {
  const sortKey = String(MESSAGE_INDEX_SORT_MAX_MS - parseSortMs(message.receivedAt)).padStart(MESSAGE_INDEX_SORT_WIDTH, "0")
  return `${messageIndexPrefix(message.agentId)}${sortKey}__${message.compartmentKind}__${message.placement}__${encodeSourceToken(message.source)}__${message.id}.json`
}

function messageIndexRecord(message: Pick<StoredMailMessage, "id" | "agentId" | "compartmentKind" | "placement" | "source" | "receivedAt">): StoredMailMessageIndexRecord {
  return {
    schemaVersion: 1,
    id: message.id,
    agentId: message.agentId,
    compartmentKind: message.compartmentKind,
    placement: message.placement,
    ...(message.source ? { source: message.source } : {}),
    receivedAt: message.receivedAt,
  }
}

function parseMessageIndexBlobName(name: string): StoredMailMessageIndexRecord | null {
  if (!name.startsWith(`${MESSAGE_INDEX_PREFIX}/`) || !name.endsWith(".json")) return null
  const parts = name.split("/")
  if (parts.length !== 3) return null
  const agentId = parts[1]
  const stem = parts[2]!.slice(0, -5)
  const [sortKey, compartmentKind, placement, sourceToken, ...idParts] = stem.split("__")
  if (!sortKey || !compartmentKind || !placement || !sourceToken || idParts.length === 0) return null
  if (compartmentKind !== "native" && compartmentKind !== "delegated") return null
  const receivedAtMs = MESSAGE_INDEX_SORT_MAX_MS - Number.parseInt(sortKey, 10)
  return {
    schemaVersion: 1,
    id: idParts.join("__"),
    agentId,
    compartmentKind,
    placement: placement as MailPlacement,
    ...(decodeSourceToken(sourceToken) ? { source: decodeSourceToken(sourceToken) } : {}),
    receivedAt: Number.isFinite(receivedAtMs) ? new Date(receivedAtMs).toISOString() : new Date(0).toISOString(),
  }
}

function sourceMatchesFilter(source: string | undefined, filter: string | undefined): boolean {
  if (!filter) return true
  if (!source) return false
  return source.toLowerCase() === filter.toLowerCase()
}

function messageMatchesFilters<T extends Pick<StoredMailMessageIndexRecord, "agentId" | "placement" | "compartmentKind" | "source">>(message: T, filters: MailListFilters): boolean {
  return message.agentId === filters.agentId &&
    (filters.placement ? message.placement === filters.placement : true) &&
    (filters.compartmentKind ? message.compartmentKind === filters.compartmentKind : true) &&
    sourceMatchesFilter(message.source, filters.source)
}

export class AzureBlobMailroomStore implements MailroomStore {
  private readonly serviceClient: BlobServiceClient
  private readonly containerName: string
  private containerReady: Promise<void> | null = null

  constructor(options: AzureBlobMailroomStoreOptions) {
    this.serviceClient = options.serviceClient
    this.containerName = options.containerName
    emitNervesEvent({
      component: "senses",
      event: "senses.mail_blob_store_init",
      message: "azure blob mailroom store initialized",
      meta: { containerName: this.containerName },
    })
  }

  private get container() {
    return this.serviceClient.getContainerClient(this.containerName)
  }

  private async ensureContainer(): Promise<void> {
    if (!this.containerReady) {
      this.containerReady = this.container.createIfNotExists().then(() => undefined)
    }
    await this.containerReady
  }

  private messageBlob(id: string) {
    return this.container.getBlockBlobClient(`messages/${id}.json`)
  }

  private messageIndexBlob(name: string) {
    return this.container.getBlockBlobClient(name)
  }

  private candidateBlob(id: string) {
    return this.container.getBlockBlobClient(`candidates/${id}.json`)
  }

  private rawBlob(objectName: string) {
    return this.container.getBlockBlobClient(objectName)
  }

  private decisionsBlob(agentId: string) {
    return this.container.getBlockBlobClient(`decisions/${agentId}.json`)
  }

  private accessLogBlob(agentId: string) {
    return this.container.getBlockBlobClient(`access-log/${agentId}.jsonl`)
  }

  private outboundBlob(id: string) {
    return this.container.getBlockBlobClient(`outbound/${id}.json`)
  }

  private async putMessageIndex(message: StoredMailMessage): Promise<void> {
    await this.messageIndexBlob(messageIndexBlobName(message)).uploadData(blobText(messageIndexRecord(message)))
  }

  private async removeMessageIndex(message: StoredMailMessage): Promise<void> {
    await (this.messageIndexBlob(messageIndexBlobName(message)) as { deleteIfExists(): Promise<unknown> }).deleteIfExists()
  }

  private async listMessagesLegacy(filters: MailListFilters): Promise<StoredMailMessage[]> {
    const messageBlobNames: string[] = []
    for await (const item of this.container.listBlobsFlat({ prefix: "messages/" })) {
      messageBlobNames.push(item.name)
    }
    const matches: StoredMailMessage[] = []
    const limit = filters.limit ?? 20
    let nextIndex = 0
    const worker = async () => {
      while (nextIndex < messageBlobNames.length) {
        const current = messageBlobNames[nextIndex]
        nextIndex += 1
        const message = await downloadJson<StoredMailMessage>(this.container.getBlockBlobClient(current))
        if (!message || !messageMatchesFilters(message, filters)) continue
        matches.push(message)
        matches.sort(compareNewestFirst)
        if (matches.length > limit) matches.length = limit
      }
    }
    await Promise.all(
      Array.from({ length: Math.min(MESSAGE_LIST_SCAN_CONCURRENCY, Math.max(messageBlobNames.length, 1)) }, async () => worker()),
    )
    return matches.sort(compareNewestFirst).slice(0, limit)
  }

  private async listMessagesFromIndexes(filters: MailListFilters): Promise<StoredMailMessage[] | null> {
    const messageIds: string[] = []
    let sawIndex = false
    for await (const item of this.container.listBlobsFlat({ prefix: messageIndexPrefix(filters.agentId) })) {
      sawIndex = true
      const parsed = parseMessageIndexBlobName(item.name)
      if (!parsed || !messageMatchesFilters(parsed, filters)) continue
      messageIds.push(parsed.id)
      if (messageIds.length >= (filters.limit ?? 20)) break
    }
    if (!sawIndex) return null
    return (await Promise.all(messageIds.map(async (id) => downloadJson<StoredMailMessage>(this.messageBlob(id)))))
      .filter((message): message is StoredMailMessage => message !== null)
      .filter((message) => messageMatchesFilters(message, filters))
      .sort(compareNewestFirst)
      .slice(0, filters.limit ?? 20)
  }

  async backfillMessageIndexes(agentId?: string): Promise<number> {
    await this.ensureContainer()
    const messageBlobNames: string[] = []
    for await (const item of this.container.listBlobsFlat({ prefix: "messages/" })) {
      messageBlobNames.push(item.name)
    }
    let indexed = 0
    let nextIndex = 0
    const worker = async () => {
      while (nextIndex < messageBlobNames.length) {
        const current = messageBlobNames[nextIndex]
        nextIndex += 1
        const message = await downloadJson<StoredMailMessage>(this.container.getBlockBlobClient(current))
        if (!message) continue
        if (agentId && message.agentId !== agentId) continue
        await this.messageIndexBlob(messageIndexBlobName(message)).uploadData(blobText(messageIndexRecord(message)))
        indexed += 1
      }
    }
    await Promise.all(
      Array.from({ length: Math.min(MESSAGE_INDEX_BACKFILL_CONCURRENCY, Math.max(messageBlobNames.length, 1)) }, async () => worker()),
    )
    emitNervesEvent({
      component: "senses",
      event: "senses.mail_blob_index_backfilled",
      message: "azure blob mailroom message indexes backfilled",
      meta: { agentId: agentId ?? null, indexed },
    })
    return indexed
  }

  async putRawMessage(input: {
    resolved: ResolvedMailAddress
    envelope: MailEnvelopeInput
    rawMime: Buffer
    receivedAt?: Date
    classification?: MailClassification
  }): Promise<{ created: boolean; message: StoredMailMessage }> {
    await this.ensureContainer()
    const { message, rawPayload, candidate } = await buildStoredMailMessage(input)
    const existing = await downloadJson<StoredMailMessage>(this.messageBlob(message.id))
    if (existing) {
      await this.putMessageIndex(existing)
      emitNervesEvent({
        component: "senses",
        event: "senses.mail_blob_store_dedupe",
        message: "azure blob mailroom store deduped existing message",
        meta: { id: message.id, agentId: message.agentId },
      })
      return { created: false, message: existing }
    }
    await this.rawBlob(message.rawObject).uploadData(blobText(rawPayload))
    await this.messageBlob(message.id).uploadData(blobText(message))
    await this.putMessageIndex(message)
    if (candidate) {
      await this.candidateBlob(candidate.id).uploadData(blobText(candidate))
    }
    emitNervesEvent({
      component: "senses",
      event: "senses.mail_blob_store_message_written",
      message: "azure blob mailroom store wrote message",
      meta: { id: message.id, agentId: message.agentId, candidate: candidate !== undefined },
    })
    return { created: true, message }
  }

  async getMessage(id: string): Promise<StoredMailMessage | null> {
    await this.ensureContainer()
    const message = await downloadJson<StoredMailMessage>(this.messageBlob(id))
    emitNervesEvent({
      component: "senses",
      event: "senses.mail_blob_store_message_read",
      message: "azure blob mailroom store read message",
      meta: { id, found: message !== null },
    })
    return message
  }

  async listMessages(filters: MailListFilters): Promise<StoredMailMessage[]> {
    await this.ensureContainer()
    let filtered = await this.listMessagesFromIndexes(filters)
    let source: "index" | "legacy" = "index"
    if (filtered === null) {
      filtered = await this.listMessagesLegacy(filters)
      source = "legacy"
    }
    emitNervesEvent({
      component: "senses",
      event: "senses.mail_blob_store_messages_listed",
      message: "azure blob mailroom store listed messages",
      meta: { agentId: filters.agentId, count: filtered.length, source },
    })
    return filtered
  }

  async updateMessagePlacement(id: string, placement: MailPlacement): Promise<StoredMailMessage | null> {
    await this.ensureContainer()
    const blob = this.messageBlob(id)
    const message = await downloadJson<StoredMailMessage>(blob)
    if (!message) {
      emitNervesEvent({
        component: "senses",
        event: "senses.mail_blob_store_message_placement_updated",
        message: "azure blob mailroom store message placement update missed",
        meta: { id, placement, found: false },
      })
      return null
    }
    const updated: StoredMailMessage = { ...message, placement }
    await blob.uploadData(blobText(updated))
    await this.removeMessageIndex(message)
    await this.putMessageIndex(updated)
    emitNervesEvent({
      component: "senses",
      event: "senses.mail_blob_store_message_placement_updated",
      message: "azure blob mailroom store updated message placement",
      meta: { id, placement, found: true },
    })
    return updated
  }

  async readRawPayload(objectName: string): Promise<EncryptedPayload | null> {
    await this.ensureContainer()
    const payload = await downloadJson<EncryptedPayload>(this.rawBlob(objectName))
    emitNervesEvent({
      component: "senses",
      event: "senses.mail_blob_store_raw_read",
      message: "azure blob mailroom store read raw payload",
      meta: { objectName, found: payload !== null },
    })
    return payload
  }

  async putScreenerCandidate(candidate: MailScreenerCandidate): Promise<MailScreenerCandidate> {
    await this.ensureContainer()
    await this.candidateBlob(candidate.id).uploadData(blobText(candidate))
    emitNervesEvent({
      component: "senses",
      event: "senses.mail_blob_screener_candidate_written",
      message: "azure blob mail screener candidate written",
      meta: { id: candidate.id, agentId: candidate.agentId, status: candidate.status },
    })
    return candidate
  }

  async updateScreenerCandidate(candidate: MailScreenerCandidate): Promise<MailScreenerCandidate> {
    return this.putScreenerCandidate(candidate)
  }

  async listScreenerCandidates(filters: MailScreenerCandidateFilters): Promise<MailScreenerCandidate[]> {
    await this.ensureContainer()
    const candidates: MailScreenerCandidate[] = []
    for await (const item of this.container.listBlobsFlat({ prefix: "candidates/" })) {
      const candidate = await downloadJson<MailScreenerCandidate>(this.container.getBlockBlobClient(item.name))
      if (candidate) candidates.push(candidate)
    }
    const filtered = candidates
      .filter((candidate) => candidate.agentId === filters.agentId)
      .filter((candidate) => filters.status ? candidate.status === filters.status : true)
      .filter((candidate) => filters.placement ? candidate.placement === filters.placement : true)
      .sort(compareCandidatesNewestFirst)
      .slice(0, filters.limit ?? 50)
    emitNervesEvent({
      component: "senses",
      event: "senses.mail_blob_screener_candidates_listed",
      message: "azure blob mail screener candidates listed",
      meta: { agentId: filters.agentId, count: filtered.length },
    })
    return filtered
  }

  async recordMailDecision(entry: Omit<MailDecisionRecord, "schemaVersion" | "id" | "createdAt"> & { id?: string; createdAt?: string }): Promise<MailDecisionRecord> {
    await this.ensureContainer()
    const complete: MailDecisionRecord = {
      schemaVersion: 1,
      ...entry,
      id: entry.id ?? `decision_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      createdAt: entry.createdAt ?? new Date().toISOString(),
    }
    const blob = this.decisionsBlob(entry.agentId)
    const existing = await downloadJson<MailDecisionRecord[]>(blob).catch(() => null)
    const entries = Array.isArray(existing) ? existing : []
    entries.push(complete)
    await blob.uploadData(blobText(entries))
    emitNervesEvent({
      component: "senses",
      event: "senses.mail_blob_decision_recorded",
      message: "azure blob mail decision recorded",
      meta: { agentId: entry.agentId, messageId: entry.messageId, action: entry.action },
    })
    return complete
  }

  async listMailDecisions(agentId: string): Promise<MailDecisionRecord[]> {
    await this.ensureContainer()
    const entries = await downloadJson<MailDecisionRecord[]>(this.decisionsBlob(agentId))
    const safeEntries = Array.isArray(entries) ? entries : []
    emitNervesEvent({
      component: "senses",
      event: "senses.mail_blob_decisions_listed",
      message: "azure blob mail decisions listed",
      meta: { agentId, count: safeEntries.length },
    })
    return safeEntries
  }

  async upsertMailOutbound(record: MailOutboundRecord): Promise<MailOutboundRecord> {
    await this.ensureContainer()
    await this.outboundBlob(record.id).uploadData(blobText(record))
    emitNervesEvent({
      component: "senses",
      event: "senses.mail_blob_outbound_record_written",
      message: "azure blob mail outbound record written",
      meta: { agentId: record.agentId, id: record.id, status: record.status },
    })
    return record
  }

  async getMailOutbound(id: string): Promise<MailOutboundRecord | null> {
    await this.ensureContainer()
    const record = await downloadJson<MailOutboundRecord>(this.outboundBlob(id))
    emitNervesEvent({
      component: "senses",
      event: "senses.mail_blob_outbound_record_read",
      message: "azure blob mail outbound record read",
      meta: { id, found: record !== null },
    })
    return record
  }

  async listMailOutbound(agentId: string): Promise<MailOutboundRecord[]> {
    await this.ensureContainer()
    const records: MailOutboundRecord[] = []
    for await (const item of this.container.listBlobsFlat({ prefix: "outbound/" })) {
      const record = await downloadJson<MailOutboundRecord>(this.container.getBlockBlobClient(item.name))
      if (record) records.push(record)
    }
    const filtered = records
      .filter((record) => record.agentId === agentId)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    emitNervesEvent({
      component: "senses",
      event: "senses.mail_blob_outbound_records_listed",
      message: "azure blob mail outbound records listed",
      meta: { agentId, count: filtered.length },
    })
    return filtered
  }

  async recordAccess(entry: Omit<MailAccessLogEntry, "id" | "accessedAt">): Promise<MailAccessLogEntry> {
    await this.ensureContainer()
    const complete: MailAccessLogEntry = {
      ...entry,
      id: `access_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      accessedAt: new Date().toISOString(),
    }
    const blob = this.accessLogBlob(entry.agentId)
    const existing = await downloadJson<MailAccessLogEntry[]>(blob).catch(() => null)
    const entries = Array.isArray(existing) ? existing : []
    entries.push(complete)
    await blob.uploadData(blobText(entries))
    emitNervesEvent({
      component: "senses",
      event: "senses.mail_blob_access_recorded",
      message: "azure blob mail access recorded",
      meta: { agentId: entry.agentId, messageId: entry.messageId ?? null, tool: entry.tool },
    })
    return complete
  }

  async listAccessLog(agentId: string): Promise<MailAccessLogEntry[]> {
    await this.ensureContainer()
    const entries = await downloadJson<MailAccessLogEntry[]>(this.accessLogBlob(agentId))
    const safeEntries = Array.isArray(entries) ? entries : []
    emitNervesEvent({
      component: "senses",
      event: "senses.mail_blob_access_log_listed",
      message: "azure blob mail access log listed",
      meta: { agentId, count: safeEntries.length },
    })
    return safeEntries
  }
}

export function decryptBlobMessages(messages: StoredMailMessage[], privateKeys: Record<string, string>): DecryptedMailMessage[] {
  return messages.map((message) => decryptStoredMailMessage(message, privateKeys))
}
