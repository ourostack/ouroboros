import { randomUUID } from "node:crypto"

import { emitNervesEvent } from "../nerves/runtime"
import {
  canonicalMailIndexRecordSnapshot,
  type HostedMailIndexAuthorityReader,
  type HostedMailIndexAuthorityObservation,
} from "./blob-store"
import { MissingPrivateMailKeyError, readDecryptedMailMessage, type MailPlacement, type StoredMailMessage } from "./core"
import type { MailListFilters, MailMessageIndexRecord, MailroomStore } from "./file-store"
import {
  inspectMailSearchCacheFiles,
  inspectMailSearchSkipReceipts,
  MAIL_SEARCH_TEXT_PROJECTION_VERSION,
  removeMailSearchCacheDocument,
  removeMailSearchCacheFile,
  removeMailSearchSkipReceipt,
  removeMailSearchSkipReceiptFile,
  readMailSearchSkipReceipt,
  searchMailSearchCache,
  upsertMailSearchCacheDocument,
  writeMailSearchSkipReceipt,
  writeMailSearchCoverageRecord,
  type MailSearchCacheDocument,
  type MailSearchCacheOptions,
  type MailSearchCoverageRecord,
} from "./search-cache"

type HostedAuthorityStore = MailroomStore & {
  observeMessageIndexAuthority?(agentId: string): Promise<HostedMailIndexAuthorityObservation>
}

export interface HostedMailSearchCacheSyncInput {
  agentId: string
  mode: "full-convergence" | "scoped-upsert"
  store: HostedAuthorityStore
  authority?: HostedMailIndexAuthorityReader
  privateKeys: Record<string, string>
  storeKind: string
  cacheOptions?: MailSearchCacheOptions
  placement?: MailPlacement
  scope?: "native" | "delegated"
  source?: string
  onProgress?: (progress: HostedMailSearchCacheSyncProgress) => void
}

export interface HostedMailSearchCacheSyncProgress {
  phase: "pass-start" | "settled" | "pass-complete" | "heartbeat"
  pass: number
  settled: number
  total: number
}

export interface HostedMailSearchCacheSyncResult {
  coverage: MailSearchCoverageRecord
  fetched: number
  alreadyCached: number
  removed: number
  skipped: number
}

function filtersFor(input: HostedMailSearchCacheSyncInput): MailListFilters {
  return {
    agentId: input.agentId,
    ...(input.placement ? { placement: input.placement } : {}),
    ...(input.scope ? { compartmentKind: input.scope } : {}),
    ...(input.source ? { source: input.source } : {}),
  }
}

function recordFor(message: StoredMailMessage): MailMessageIndexRecord {
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

function sameOptionalText(left: string | undefined, right: string | undefined): boolean {
  return (left ?? "").toLowerCase() === (right ?? "").toLowerCase()
}

export function mailSearchCacheDocumentMatchesRecord(
  document: MailSearchCacheDocument,
  record: MailMessageIndexRecord,
  requireKeyProvenance: boolean,
): boolean {
  const bodyProvenanceMatches = !requireKeyProvenance ||
    (document.bodyForm === "plaintext" && document.decryptionKeyId === undefined) ||
    (document.bodyForm === "encrypted" && typeof document.decryptionKeyId === "string")
  return document.schemaVersion === 1
    && document.agentId === record.agentId
    && document.messageId === record.id
    && document.receivedAt === record.receivedAt
    && document.placement === record.placement
    && document.compartmentKind === record.compartmentKind
    && sameOptionalText(document.source, record.source)
    && document.textProjectionVersion === MAIL_SEARCH_TEXT_PROJECTION_VERSION
    && bodyProvenanceMatches
}

function messageMatchesRecord(message: StoredMailMessage, record: MailMessageIndexRecord): boolean {
  return message.id === record.id
    && message.agentId === record.agentId
    && message.receivedAt === record.receivedAt
    && message.placement === record.placement
    && message.compartmentKind === record.compartmentKind
    && sameOptionalText(message.source, record.source)
}

async function scopedRecords(input: HostedMailSearchCacheSyncInput): Promise<MailMessageIndexRecord[]> {
  const filters = filtersFor(input)
  const indexed = await input.store.listMessageIndexRecords?.(filters)
  if (indexed) return indexed
  return (await input.store.listMessages(filters)).map(recordFor)
}

async function fetchIndexedMessage(store: MailroomStore, id: string): Promise<StoredMailMessage | null> {
  return store.getIndexedMessageById
    ? store.getIndexedMessageById(id)
    : store.getMessage(id)
}

function removeCanonicalIfPresent(
  agentId: string,
  messageId: string,
  options: MailSearchCacheOptions | undefined,
): number {
  return removeMailSearchCacheDocument(agentId, messageId, options) ? 1 : 0
}

function recordFingerprint(record: MailMessageIndexRecord): string {
  return canonicalMailIndexRecordSnapshot([record]).messageIndexFingerprint
}

const FULL_CONVERGENCE_MAX_PASSES = 3
const FULL_CONVERGENCE_CONCURRENCY = 20
const PROGRESS_SETTLEMENT_INTERVAL = 250
const PROGRESS_HEARTBEAT_MS = 30_000

interface ReconciliationResult {
  fetched: number
  alreadyCached: number
  removed: number
  skipped: number
}

interface ProgressCursor {
  pass: number
  settled: number
  total: number
}

function safeProgress(
  input: HostedMailSearchCacheSyncInput,
  progress: HostedMailSearchCacheSyncProgress,
): void {
  try {
    input.onProgress?.(progress)
  } catch {
    // Progress is advisory terminal UX. A broken sink must not alter convergence.
  }
}

function validateAuthorityObservation(
  authority: HostedMailIndexAuthorityObservation,
): HostedMailIndexAuthorityObservation {
  if (authority.parseFailureCount > 0 || authority.duplicateIds.length > 0) {
    throw new Error(
      `hosted mail authority is ambiguous: ${authority.parseFailureCount} malformed index name(s), ${authority.duplicateIds.length} duplicate message id(s)`,
    )
  }
  if (authority.records.length === 0) {
    throw new Error("hosted mail authority is empty and cannot safely drive full convergence")
  }
  return authority
}

async function reconcileRecords(
  input: HostedMailSearchCacheSyncInput,
  records: MailMessageIndexRecord[],
  pass: number,
  progressCursor: ProgressCursor,
): Promise<ReconciliationResult> {
  const recordsById = new Map(records.map((record) => [record.id, record]))
  const canonicalDocuments = new Map<string, MailSearchCacheDocument>()
  let removed = 0
  if (input.mode === "full-convergence") {
    for (const inspected of inspectMailSearchCacheFiles(input.agentId, input.cacheOptions)) {
      const document = inspected.document
      const canonicalName = document ? `${document.messageId}.json` : null
      const record = document ? recordsById.get(document.messageId) : undefined
      if (!document || inspected.fileName !== canonicalName || document.agentId !== input.agentId || !record) {
        removed += Number(removeMailSearchCacheFile(input.agentId, inspected.fileName, input.cacheOptions))
        continue
      }
      canonicalDocuments.set(document.messageId, document)
    }
    for (const inspected of inspectMailSearchSkipReceipts(input.agentId, input.cacheOptions)) {
      const receipt = inspected.receipt
      if (!receipt || !inspected.canonical || !recordsById.has(receipt.messageId)) {
        removeMailSearchSkipReceiptFile(input.agentId, inspected.fileName, input.cacheOptions)
      }
    }
  } else {
    for (const document of searchMailSearchCache({
      agentId: input.agentId,
      placement: input.placement,
      compartmentKind: input.scope,
      source: input.source,
    }, input.cacheOptions)) {
      canonicalDocuments.set(document.messageId, document)
    }
  }

  let fetched = 0
  let alreadyCached = 0
  let skipped = 0
  let settled = 0
  let nextRecord = 0
  const failures: Array<{ index: number; id: string; error: string }> = []
  progressCursor.pass = pass
  progressCursor.settled = settled
  progressCursor.total = records.length
  safeProgress(input, { phase: "pass-start", pass, settled, total: records.length })

  async function processRecord(record: MailMessageIndexRecord): Promise<void> {
    const cached = canonicalDocuments.get(record.id)
    const cachedEncryptedKeyMissing = input.mode === "full-convergence" &&
      cached?.bodyForm === "encrypted" &&
      typeof cached.decryptionKeyId === "string" &&
      !input.privateKeys[cached.decryptionKeyId]
    if (cached &&
      !cachedEncryptedKeyMissing &&
      mailSearchCacheDocumentMatchesRecord(cached, record, input.mode === "full-convergence")) {
      if (input.mode === "full-convergence") {
        removeMailSearchSkipReceipt(input.agentId, record.id, input.cacheOptions)
      }
      alreadyCached += 1
      return
    }
    if (input.mode === "full-convergence") {
      const receipt = readMailSearchSkipReceipt(input.agentId, record.id, input.cacheOptions)
      if (receipt &&
        receipt.recordFingerprint === recordFingerprint(record) &&
        !input.privateKeys[receipt.missingKeyId]) {
        removed += removeCanonicalIfPresent(input.agentId, record.id, input.cacheOptions)
        skipped += 1
        return
      }
      if (receipt) removeMailSearchSkipReceipt(input.agentId, record.id, input.cacheOptions)
    }

    try {
      const message = await fetchIndexedMessage(input.store, record.id)
      if (!message) throw new Error("indexed message was not retrievable")
      fetched += 1
      if (!messageMatchesRecord(message, record)) {
        throw new Error(`indexed message metadata did not match authority for ${record.id}`)
      }
      const decrypted = readDecryptedMailMessage(message, input.privateKeys)
      upsertMailSearchCacheDocument(message, decrypted.private, input.cacheOptions, {
        ...(message.bodyForm === "encrypted" ? { decryptionKeyId: message.privateEnvelope.keyId } : {}),
      })
      if (input.mode === "full-convergence") {
        removeMailSearchSkipReceipt(input.agentId, record.id, input.cacheOptions)
      }
    } catch (error) {
      if (error instanceof MissingPrivateMailKeyError) {
        removed += removeCanonicalIfPresent(input.agentId, record.id, input.cacheOptions)
        skipped += 1
        if (input.mode === "full-convergence") {
          writeMailSearchSkipReceipt({
            schemaVersion: 1,
            agentId: input.agentId,
            messageId: record.id,
            recordFingerprint: recordFingerprint(record),
            missingKeyId: error.keyId,
            reason: "missing-private-key",
            observedAt: new Date().toISOString(),
          }, input.cacheOptions)
        }
      } else {
        throw error
      }
    }
  }

  async function worker(): Promise<void> {
    while (true) {
      const recordIndex = nextRecord
      nextRecord += 1
      if (recordIndex >= records.length) return
      try {
        await processRecord(records[recordIndex]!)
      } catch (error) {
        failures.push({
          index: recordIndex,
          id: records[recordIndex]!.id,
          error: error instanceof Error ? error.message : String(error),
        })
      } finally {
        settled += 1
        progressCursor.settled = settled
        if (settled % PROGRESS_SETTLEMENT_INTERVAL === 0) {
          safeProgress(input, { phase: "settled", pass, settled, total: records.length })
        }
      }
    }
  }

  try {
    const workerCount = Math.min(FULL_CONVERGENCE_CONCURRENCY, records.length)
    await Promise.allSettled(Array.from({ length: workerCount }, () => worker()))
  } finally {
    safeProgress(input, { phase: "pass-complete", pass, settled, total: records.length })
  }

  if (failures.length > 0) {
    failures.sort((left, right) => left.index - right.index)
    const sample = failures.slice(0, 3).map((entry) => `${entry.id}: ${entry.error}`).join("; ")
    throw new Error(`mail search index refresh incomplete; ${failures.length} record operation(s) failed. first failure(s): ${sample}`)
  }
  return { fetched, alreadyCached, removed, skipped }
}

function writeCoverage(
  input: HostedMailSearchCacheSyncInput,
  records: MailMessageIndexRecord[],
  snapshot: HostedMailIndexAuthorityObservation["snapshot"],
): MailSearchCoverageRecord {
  const recordsById = new Map(records.map((record) => [record.id, record]))
  const cachedIds = new Set(searchMailSearchCache({
    agentId: input.agentId,
    placement: input.placement,
    compartmentKind: input.scope,
    source: input.source,
  }, input.cacheOptions).filter((document) => recordsById.has(document.messageId)).map((document) => document.messageId))
  return writeMailSearchCoverageRecord({
    schemaVersion: 1,
    agentId: input.agentId,
    storeKind: input.storeKind,
    ...(input.placement ? { placement: input.placement } : {}),
    ...(input.scope ? { compartmentKind: input.scope } : {}),
    ...(input.source ? { source: input.source } : {}),
    indexedAt: new Date().toISOString(),
    visibleMessageCount: records.length,
    cachedMessageCount: cachedIds.size,
    decryptableMessageCount: cachedIds.size,
    skippedMessageCount: records.length - cachedIds.size,
    messageIndexFingerprint: snapshot.messageIndexFingerprint,
    textProjectionVersion: MAIL_SEARCH_TEXT_PROJECTION_VERSION,
    ...(snapshot.oldestReceivedAt ? { oldestReceivedAt: snapshot.oldestReceivedAt } : {}),
    ...(snapshot.newestReceivedAt ? { newestReceivedAt: snapshot.newestReceivedAt } : {}),
  }, input.cacheOptions)
}

/**
 * Converge a local decrypted cache against hosted index authority, or perform
 * the legacy bounded upsert used by the in-agent refresh tool. This core never
 * writes remote mail state and never records access; adapters own audit policy.
 */
async function performHostedMailSearchCacheSyncWithProgress(
  input: HostedMailSearchCacheSyncInput,
  progressCursor: ProgressCursor,
): Promise<HostedMailSearchCacheSyncResult> {
  let finalRecords: MailMessageIndexRecord[]
  let finalSnapshot: HostedMailIndexAuthorityObservation["snapshot"]
  let fetched = 0
  let removed = 0
  let alreadyCached = 0

  if (input.mode === "full-convergence") {
    const observer = input.authority ?? input.store
    if (!observer.observeMessageIndexAuthority) {
      throw new Error("hosted mail authority observer is unavailable")
    }
    let authority = validateAuthorityObservation(await observer.observeMessageIndexAuthority(input.agentId))
    let stable = false
    for (let pass = 1; pass <= FULL_CONVERGENCE_MAX_PASSES; pass += 1) {
      const reconciliation = await reconcileRecords(input, authority.records, pass, progressCursor)
      fetched += reconciliation.fetched
      removed += reconciliation.removed
      alreadyCached = reconciliation.alreadyCached
      const followup = validateAuthorityObservation(await observer.observeMessageIndexAuthority(input.agentId))
      if (followup.snapshot.messageIndexFingerprint === authority.snapshot.messageIndexFingerprint) {
        authority = followup
        stable = true
        break
      }
      authority = followup
    }
    if (!stable) {
      throw new Error(`hosted mail authority did not stabilize after ${FULL_CONVERGENCE_MAX_PASSES} passes`)
    }
    finalRecords = authority.records
    finalSnapshot = authority.snapshot
  } else {
    finalRecords = await scopedRecords(input)
    const reconciliation = await reconcileRecords(input, finalRecords, 1, progressCursor)
    fetched = reconciliation.fetched
    removed = reconciliation.removed
    alreadyCached = reconciliation.alreadyCached
    finalSnapshot = canonicalMailIndexRecordSnapshot(finalRecords)
  }

  const coverage = writeCoverage(input, finalRecords, finalSnapshot)
  const skipped = coverage.skippedMessageCount
  emitNervesEvent({
    component: "senses",
    event: "senses.mail_search_cache_synced",
    message: "hosted mail search cache synchronized",
    meta: {
      agentId: input.agentId,
      mode: input.mode,
      visible: finalRecords.length,
      fetched,
      alreadyCached,
      removed,
      skipped,
    },
  })
  return { coverage, fetched, alreadyCached, removed, skipped }
}

async function performHostedMailSearchCacheSync(
  input: HostedMailSearchCacheSyncInput,
): Promise<HostedMailSearchCacheSyncResult> {
  const progressCursor: ProgressCursor = { pass: 1, settled: 0, total: 0 }
  const heartbeat = setInterval(() => {
    safeProgress(input, { phase: "heartbeat", ...progressCursor })
  }, PROGRESS_HEARTBEAT_MS)
  try {
    return await performHostedMailSearchCacheSyncWithProgress(input, progressCursor)
  } finally {
    clearInterval(heartbeat)
  }
}

export async function syncHostedMailSearchCache(
  input: HostedMailSearchCacheSyncInput,
): Promise<HostedMailSearchCacheSyncResult> {
  const traceId = randomUUID()
  emitNervesEvent({
    component: "senses",
    event: "senses.mail_search_cache_sync_start",
    trace_id: traceId,
    message: "synchronizing hosted mail search cache",
    meta: { agentId: input.agentId, mode: input.mode, storeKind: input.storeKind },
  })
  try {
    const result = await performHostedMailSearchCacheSync(input)
    emitNervesEvent({
      component: "senses",
      event: "senses.mail_search_cache_sync_end",
      trace_id: traceId,
      message: "hosted mail search cache synchronization completed",
      meta: {
        agentId: input.agentId,
        mode: input.mode,
        storeKind: input.storeKind,
        visible: result.coverage.visibleMessageCount,
        fetched: result.fetched,
        alreadyCached: result.alreadyCached,
        removed: result.removed,
        skipped: result.skipped,
      },
    })
    return result
  } catch (error) {
    emitNervesEvent({
      component: "senses",
      event: "senses.mail_search_cache_sync_error",
      trace_id: traceId,
      level: "error",
      message: "hosted mail search cache synchronization failed",
      meta: {
        agentId: input.agentId,
        mode: input.mode,
        storeKind: input.storeKind,
        error: String(error),
      },
    })
    throw error
  }
}
