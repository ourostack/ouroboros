import { randomUUID } from "node:crypto"

import { emitNervesEvent } from "../nerves/runtime"
import {
  canonicalMailIndexRecordSnapshot,
  type HostedMailIndexAuthorityReader,
  type HostedMailIndexAuthorityObservation,
} from "./blob-store"
import { readDecryptedMailMessage, type MailPlacement, type StoredMailMessage } from "./core"
import type { MailListFilters, MailMessageIndexRecord, MailroomStore } from "./file-store"
import {
  inspectMailSearchCacheFiles,
  MAIL_SEARCH_TEXT_PROJECTION_VERSION,
  removeMailSearchCacheDocument,
  removeMailSearchCacheFile,
  searchMailSearchCache,
  upsertMailSearchCacheDocument,
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
  return document.schemaVersion === 1
    && document.agentId === record.agentId
    && document.messageId === record.id
    && document.receivedAt === record.receivedAt
    && document.placement === record.placement
    && document.compartmentKind === record.compartmentKind
    && sameOptionalText(document.source, record.source)
    && document.textProjectionVersion === MAIL_SEARCH_TEXT_PROJECTION_VERSION
    && (!requireKeyProvenance || typeof document.decryptionKeyId === "string")
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

function missingPrivateKeyId(error: unknown): string | null {
  if (!(error instanceof Error)) return null
  const keyId = (error as Error & { keyId?: unknown }).keyId
  return typeof keyId === "string" && keyId.length > 0 ? keyId : null
}

/**
 * Converge a local decrypted cache against hosted index authority, or perform
 * the legacy bounded upsert used by the in-agent refresh tool. This core never
 * writes remote mail state and never records access; adapters own audit policy.
 */
async function performHostedMailSearchCacheSync(
  input: HostedMailSearchCacheSyncInput,
): Promise<HostedMailSearchCacheSyncResult> {
  let authority: HostedMailIndexAuthorityObservation | null = null
  let records: MailMessageIndexRecord[]
  if (input.mode === "full-convergence") {
    const observer = input.authority ?? input.store
    if (!observer.observeMessageIndexAuthority) {
      throw new Error("hosted mail authority observer is unavailable")
    }
    authority = await observer.observeMessageIndexAuthority(input.agentId)
    if (authority.parseFailureCount > 0 || authority.duplicateIds.length > 0) {
      throw new Error(
        `hosted mail authority is ambiguous: ${authority.parseFailureCount} malformed index name(s), ${authority.duplicateIds.length} duplicate message id(s)`,
      )
    }
    if (authority.records.length === 0) {
      throw new Error("hosted mail authority is empty and cannot safely drive full convergence")
    }
    records = authority.records
  } else {
    records = await scopedRecords(input)
  }

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
  const failures: Array<{ id: string; error: string }> = []
  for (const record of records) {
    const cached = canonicalDocuments.get(record.id)
    if (cached && input.mode === "full-convergence" && cached.decryptionKeyId && !input.privateKeys[cached.decryptionKeyId]) {
      removed += removeCanonicalIfPresent(input.agentId, record.id, input.cacheOptions)
      skipped += 1
      continue
    }
    if (cached && mailSearchCacheDocumentMatchesRecord(cached, record, input.mode === "full-convergence")) {
      alreadyCached += 1
      continue
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
    } catch (error) {
      if (input.mode === "full-convergence" || missingPrivateKeyId(error)) {
        removed += removeCanonicalIfPresent(input.agentId, record.id, input.cacheOptions)
        skipped += 1
      } else {
        failures.push({ id: record.id, error: error instanceof Error ? error.message : String(error) })
      }
    }
  }

  if (failures.length > 0) {
    const sample = failures.slice(0, 3).map((entry) => `${entry.id}: ${entry.error}`).join("; ")
    throw new Error(`mail search index refresh incomplete; ${failures.length} fetch failed. first failure(s): ${sample}`)
  }

  const cachedIds = new Set(searchMailSearchCache({
    agentId: input.agentId,
    placement: input.placement,
    compartmentKind: input.scope,
    source: input.source,
  }, input.cacheOptions).filter((document) => recordsById.has(document.messageId)).map((document) => document.messageId))
  const snapshot = authority?.snapshot ?? canonicalMailIndexRecordSnapshot(records)
  const coverage = writeMailSearchCoverageRecord({
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
    skippedMessageCount: skipped,
    messageIndexFingerprint: snapshot.messageIndexFingerprint,
    textProjectionVersion: MAIL_SEARCH_TEXT_PROJECTION_VERSION,
    ...(snapshot.oldestReceivedAt ? { oldestReceivedAt: snapshot.oldestReceivedAt } : {}),
    ...(snapshot.newestReceivedAt ? { newestReceivedAt: snapshot.newestReceivedAt } : {}),
  }, input.cacheOptions)
  emitNervesEvent({
    component: "senses",
    event: "senses.mail_search_cache_synced",
    message: "hosted mail search cache synchronized",
    meta: {
      agentId: input.agentId,
      mode: input.mode,
      visible: records.length,
      fetched,
      alreadyCached,
      removed,
      skipped,
    },
  })
  return { coverage, fetched, alreadyCached, removed, skipped }
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
