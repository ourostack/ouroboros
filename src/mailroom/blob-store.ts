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
import type { MailAccessLogEntry, MailAccessLogListing, MailListFilters, MailroomStore, MailScreenerCandidateFilters } from "./file-store"
import { syncMailSearchCacheMetadata, upsertMailSearchCacheDocument } from "./search-cache"

const MESSAGE_INDEX_PREFIX = "message-index"
const MESSAGE_INDEX_SORT_MAX_MS = 9_999_999_999_999
const MESSAGE_INDEX_SORT_WIDTH = 13
const MESSAGE_INDEX_NO_SOURCE = "~"
// Bumped from 20s after Slugger's HEY-corpus validation revealed that
// real-world mail bodies (HTML-heavy booking confirmations, MBOX-imported
// large messages) regularly exceed the original 20s ceiling. 60s with 2
// attempts = 120s max wait, which is closer to what Azure Blob actually
// needs for cold reads of a few-MB message body. Index reads still fit
// comfortably in this budget.
const DEFAULT_BLOB_OPERATION_TIMEOUT_MS = 60_000
const DEFAULT_BLOB_DOWNLOAD_ATTEMPTS = 2
const DEFAULT_MESSAGE_FETCH_CONCURRENCY = 20
const DEFAULT_MESSAGE_INDEX_BACKFILL_CONCURRENCY = 8
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
  blobOperationTimeoutMs?: number
  messageFetchConcurrency?: number
  backfillConcurrency?: number
}

interface DownloadBlobClientLike {
  name?: string
  exists(): Promise<boolean>
  downloadToBuffer(offset?: number, count?: number, options?: { abortSignal?: AbortSignal }): Promise<Buffer>
}

interface UploadBlobClientLike {
  name?: string
  uploadData(data: Buffer, options?: { abortSignal?: AbortSignal }): Promise<unknown>
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

function applyOptionalLimit<T>(items: T[], limit: number | undefined): T[] {
  return typeof limit === "number" ? items.slice(0, limit) : items
}

function positiveInteger(value: number | undefined, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback
  const normalized = Math.floor(value)
  return normalized > 0 ? normalized : fallback
}

function blobClientName(blob: { name?: string }): string {
  return typeof blob.name === "string" && blob.name.trim().length > 0 ? blob.name : "<unknown-blob>"
}

function timeoutSignal(timeoutMs: number): { signal: AbortSignal; dispose(): void } {
  if (typeof AbortSignal.timeout === "function") {
    return {
      signal: AbortSignal.timeout(timeoutMs),
      dispose() {
        return undefined
      },
    }
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error(`The operation timed out after ${timeoutMs}ms`)), timeoutMs)
  return {
    signal: controller.signal,
    dispose() {
      clearTimeout(timer)
    },
  }
}

async function withBlobOperationTimeout<T>(timeoutMs: number, operation: (abortSignal: AbortSignal) => Promise<T>): Promise<T> {
  const timeout = timeoutSignal(timeoutMs)
  try {
    return await operation(timeout.signal)
  } finally {
    timeout.dispose()
  }
}

function normalizeBlobOperationError(action: "download" | "upload", blob: { name?: string }, timeoutMs: number, error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error)
  if ((error instanceof Error && error.name === "AbortError") || message.toLowerCase().includes("aborted")) {
    return new Error(`${action} ${blobClientName(blob)} timed out after ${timeoutMs}ms`)
  }
  return new Error(`${action} ${blobClientName(blob)} failed: ${message}`)
}

function isRetryableBlobDownloadError(error: unknown): boolean {
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase()
  return message.includes("timed out") ||
    message.includes("abort") ||
    message.includes("econnreset") ||
    message.includes("etimedout") ||
    message.includes("socket closed")
}

async function downloadJson<T>(blob: DownloadBlobClientLike, timeoutMs: number): Promise<T | null> {
  if (!await blob.exists()) return null
  let lastError: unknown = null
  for (let attempt = 1; attempt <= DEFAULT_BLOB_DOWNLOAD_ATTEMPTS; attempt += 1) {
    try {
      const buffer = await withBlobOperationTimeout(timeoutMs, (abortSignal) => {
        return blob.downloadToBuffer(undefined, undefined, { abortSignal })
      })
      return JSON.parse(buffer.toString("utf-8")) as T
    } catch (error) {
      lastError = error
      if (attempt >= DEFAULT_BLOB_DOWNLOAD_ATTEMPTS || !isRetryableBlobDownloadError(error)) break
    }
  }
  throw normalizeBlobOperationError("download", blob, timeoutMs, lastError)
}

async function uploadJson(blob: UploadBlobClientLike, value: unknown, timeoutMs: number): Promise<void> {
  try {
    await withBlobOperationTimeout(timeoutMs, (abortSignal) => {
      return blob.uploadData(blobText(value), { abortSignal })
    })
  } catch (error) {
    throw normalizeBlobOperationError("upload", blob, timeoutMs, error)
  }
}

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return []
  const results = new Array<R>(items.length)
  let nextIndex = 0
  const workerLoop = async () => {
    while (true) {
      const current = nextIndex
      nextIndex += 1
      if (current >= items.length) return
      results[current] = await worker(items[current]!, current)
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => workerLoop()),
  )
  return results
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
  private readonly blobOperationTimeoutMs: number
  private readonly messageFetchConcurrency: number
  private readonly backfillConcurrency: number
  private containerReady: Promise<void> | null = null

  constructor(options: AzureBlobMailroomStoreOptions) {
    this.serviceClient = options.serviceClient
    this.containerName = options.containerName
    this.blobOperationTimeoutMs = positiveInteger(options.blobOperationTimeoutMs, DEFAULT_BLOB_OPERATION_TIMEOUT_MS)
    this.messageFetchConcurrency = positiveInteger(options.messageFetchConcurrency, DEFAULT_MESSAGE_FETCH_CONCURRENCY)
    this.backfillConcurrency = positiveInteger(options.backfillConcurrency, DEFAULT_MESSAGE_INDEX_BACKFILL_CONCURRENCY)
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
    await uploadJson(this.messageIndexBlob(messageIndexBlobName(message)), messageIndexRecord(message), this.blobOperationTimeoutMs)
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
    let nextIndex = 0
    const worker = async () => {
      while (nextIndex < messageBlobNames.length) {
        const current = messageBlobNames[nextIndex]
        nextIndex += 1
        const message = await downloadJson<StoredMailMessage>(this.container.getBlockBlobClient(current), this.blobOperationTimeoutMs)
        if (!message || !messageMatchesFilters(message, filters)) continue
        matches.push(message)
        matches.sort(compareNewestFirst)
        if (typeof filters.limit === "number" && matches.length > filters.limit) matches.length = filters.limit
      }
    }
    await Promise.all(
      Array.from({ length: Math.min(MESSAGE_LIST_SCAN_CONCURRENCY, Math.max(messageBlobNames.length, 1)) }, async () => worker()),
    )
    return applyOptionalLimit(matches.sort(compareNewestFirst), filters.limit)
  }

  private async listMessagesFromIndexes(filters: MailListFilters): Promise<StoredMailMessage[] | null> {
    const messageIds: string[] = []
    let sawIndex = false
    for await (const item of this.container.listBlobsFlat({ prefix: messageIndexPrefix(filters.agentId) })) {
      sawIndex = true
      const parsed = parseMessageIndexBlobName(item.name)
      if (!parsed || !messageMatchesFilters(parsed, filters)) continue
      messageIds.push(parsed.id)
      if (typeof filters.limit === "number" && messageIds.length >= filters.limit) break
    }
    if (!sawIndex) return null
    const messages = (await mapWithConcurrency(messageIds, this.messageFetchConcurrency, async (id) => {
      return downloadJson<StoredMailMessage>(this.messageBlob(id), this.blobOperationTimeoutMs)
    }))
      .filter((message): message is StoredMailMessage => message !== null)
      .filter((message) => messageMatchesFilters(message, filters))
      .sort(compareNewestFirst)
    return applyOptionalLimit(messages, filters.limit)
  }

  async backfillMessageIndexes(
    agentId?: string,
    onProgress?: (progress: { scanned: number; indexed: number; failures: number; total: number }) => void,
  ): Promise<number> {
    await this.ensureContainer()
    const messageBlobNames: string[] = []
    for await (const item of this.container.listBlobsFlat({ prefix: "messages/" })) {
      messageBlobNames.push(item.name)
    }
    let indexed = 0
    const failures: string[] = []
    let scanned = 0
    let nextIndex = 0
    const worker = async () => {
      while (nextIndex < messageBlobNames.length) {
        const current = messageBlobNames[nextIndex]
        nextIndex += 1
        try {
          const message = await downloadJson<StoredMailMessage>(this.container.getBlockBlobClient(current), this.blobOperationTimeoutMs)
          if (!message) continue
          if (agentId && message.agentId !== agentId) continue
          await uploadJson(this.messageIndexBlob(messageIndexBlobName(message)), messageIndexRecord(message), this.blobOperationTimeoutMs)
          indexed += 1
        } catch (error) {
          failures.push(error instanceof Error ? error.message : String(error))
        } finally {
          scanned += 1
          onProgress?.({ scanned, indexed, failures: failures.length, total: messageBlobNames.length })
        }
      }
    }
    await Promise.all(
      Array.from({ length: Math.min(this.backfillConcurrency, Math.max(messageBlobNames.length, 1)) }, async () => worker()),
    )
    if (failures.length > 0) {
      const sample = failures.slice(0, 3).join("; ")
      throw new Error(
        `hosted message index backfill incomplete after indexing ${indexed} message(s); ${failures.length} blob operation(s) failed. first failure(s): ${sample}. rerun the command to retry remaining messages.`,
      )
    }
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
    const { message, rawPayload, privateEnvelope, candidate } = await buildStoredMailMessage(input)
    const messageBlob = this.messageBlob(message.id)
    let existing: StoredMailMessage | null = null
    try {
      existing = await downloadJson<StoredMailMessage>(messageBlob, this.blobOperationTimeoutMs)
    } catch (error) {
      if (isRetryableBlobDownloadError(error) && await messageBlob.exists().catch(() => false)) {
        emitNervesEvent({
          level: "warn",
          component: "senses",
          event: "senses.mail_blob_store_dedupe_degraded",
          message: "azure blob mailroom store treated an unreadable existing message as a duplicate",
          meta: {
            id: message.id,
            agentId: message.agentId,
            error: error instanceof Error ? error.message : String(error),
          },
        })
        return { created: false, message }
      }
      throw error
    }
    if (existing) {
      upsertMailSearchCacheDocument(existing, privateEnvelope)
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
    upsertMailSearchCacheDocument(message, privateEnvelope)
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
    const message = await downloadJson<StoredMailMessage>(this.messageBlob(id), this.blobOperationTimeoutMs)
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
    const message = await downloadJson<StoredMailMessage>(blob, this.blobOperationTimeoutMs)
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
    syncMailSearchCacheMetadata(updated)
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
    const payload = await downloadJson<EncryptedPayload>(this.rawBlob(objectName), this.blobOperationTimeoutMs)
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
      const candidate = await downloadJson<MailScreenerCandidate>(this.container.getBlockBlobClient(item.name), this.blobOperationTimeoutMs)
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
    const existing = await downloadJson<MailDecisionRecord[]>(blob, this.blobOperationTimeoutMs).catch(() => null)
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
    const entries = await downloadJson<MailDecisionRecord[]>(this.decisionsBlob(agentId), this.blobOperationTimeoutMs)
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
    const record = await downloadJson<MailOutboundRecord>(this.outboundBlob(id), this.blobOperationTimeoutMs)
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
      const record = await downloadJson<MailOutboundRecord>(this.container.getBlockBlobClient(item.name), this.blobOperationTimeoutMs)
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
    const existing = await downloadJson<MailAccessLogEntry[]>(blob, this.blobOperationTimeoutMs).catch(() => null)
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

  async listAccessLog(agentId: string): Promise<MailAccessLogListing> {
    await this.ensureContainer()
    const entries = await downloadJson<MailAccessLogEntry[]>(this.accessLogBlob(agentId), this.blobOperationTimeoutMs)
    const safeEntries = (Array.isArray(entries) ? entries : []) as MailAccessLogListing
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
