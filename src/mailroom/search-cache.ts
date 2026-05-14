import * as fs from "node:fs"
import * as path from "node:path"
import { getAgentRoot } from "../heart/identity"
import { emitNervesEvent } from "../nerves/runtime"
import type { MailCompartmentKind, MailPlacement, PrivateMailEnvelope, StoredMailMessageBase } from "./core"

/**
 * The search cache only needs metadata + a parsed `PrivateMailEnvelope`; it
 * does not care whether the underlying stored message is in plaintext or
 * encrypted form. Typed against the shared base so plaintext stored messages
 * and decrypted reader views both flow through naturally.
 */
type SearchCacheMessageView = Pick<StoredMailMessageBase, "id" | "agentId" | "receivedAt" | "placement" | "compartmentKind" | "ownerEmail" | "source">
import { privateMailEnvelopeReadableText } from "./core"
import { compareByRelevanceThenRecency, scoreMailSearchDocument } from "./search-relevance"

const SEARCH_TEXT_EXCERPT_LIMIT = 16_384
export const MAIL_SEARCH_TEXT_PROJECTION_VERSION = 2

export interface MailSearchCacheDocument {
  schemaVersion: 1
  messageId: string
  agentId: string
  receivedAt: string
  placement: MailPlacement
  compartmentKind: MailCompartmentKind
  ownerEmail?: string
  source?: string
  from: string[]
  subject: string
  snippet: string
  textExcerpt: string
  untrustedContentWarning: string
  searchText: string
  textProjectionVersion?: number
  // Optional fields populated on cache write but absent on docs cached before
  // these fields were introduced. Always treat as may-be-undefined on read.
  attachmentCount?: number
}

export interface MailSearchCacheFilters {
  agentId: string
  placement?: MailPlacement
  compartmentKind?: MailCompartmentKind
  source?: string
  queryTerms?: string[]
  limit?: number
}

export interface MailSearchCoverageKey {
  agentId: string
  placement?: MailPlacement
  compartmentKind?: MailCompartmentKind
  source?: string
  storeKind: string
}

export interface MailSearchCoverageRecord extends MailSearchCoverageKey {
  schemaVersion: 1
  indexedAt: string
  visibleMessageCount: number
  cachedMessageCount: number
  decryptableMessageCount: number
  skippedMessageCount: number
  messageIndexFingerprint?: string
  textProjectionVersion?: number
  oldestReceivedAt?: string
  newestReceivedAt?: string
}

interface MailSearchCacheState {
  loaded: boolean
  docs: Map<string, MailSearchCacheDocument>
}

export interface MailSearchCacheOptions {
  cacheDirForAgent?: (agentId: string) => string
}

const cacheStates = new Map<string, MailSearchCacheState>()

function defaultCacheDir(agentId: string): string {
  return path.join(getAgentRoot(agentId), "state", "mail-search")
}

function cacheDir(agentId: string, options: MailSearchCacheOptions = {}): string {
  const resolve = options.cacheDirForAgent ?? defaultCacheDir
  return resolve(agentId)
}

function cachePath(agentId: string, messageId: string, options?: MailSearchCacheOptions): string {
  return path.join(cacheDir(agentId, options), `${messageId}.json`)
}

function coverageDir(agentId: string, options?: MailSearchCacheOptions): string {
  return path.join(cacheDir(agentId, options), "coverage")
}

function normalizedCoverageKey(key: MailSearchCoverageKey): MailSearchCoverageKey {
  return {
    agentId: key.agentId,
    storeKind: key.storeKind,
    ...(key.placement ? { placement: key.placement } : {}),
    ...(key.compartmentKind ? { compartmentKind: key.compartmentKind } : {}),
    ...(key.source ? { source: key.source.toLowerCase() } : {}),
  }
}

function coveragePath(key: MailSearchCoverageKey, options?: MailSearchCacheOptions): string {
  const normalized = normalizedCoverageKey(key)
  const encoded = Buffer.from(JSON.stringify(normalized)).toString("base64url")
  return path.join(coverageDir(normalized.agentId, options), `${encoded}.json`)
}

function normalizeSearchText(privateEnvelope: PrivateMailEnvelope): string {
  const readableText = privateMailEnvelopeReadableText(privateEnvelope)
  return [
    privateEnvelope.subject,
    privateEnvelope.snippet,
    readableText.slice(0, SEARCH_TEXT_EXCERPT_LIMIT),
    privateEnvelope.from.join(" "),
  ].join("\n").toLowerCase()
}

function readJsonDocument(filePath: string): MailSearchCacheDocument | null {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8")) as MailSearchCacheDocument
  } catch {
    return null
  }
}

function cacheState(agentId: string, options?: MailSearchCacheOptions): MailSearchCacheState {
  const key = `${agentId}:${cacheDir(agentId, options)}`
  let state = cacheStates.get(key)
  if (state) return state
  state = { loaded: false, docs: new Map() }
  cacheStates.set(key, state)
  return state
}

function loadCache(agentId: string, options?: MailSearchCacheOptions): Map<string, MailSearchCacheDocument> {
  const state = cacheState(agentId, options)
  if (state.loaded) return state.docs
  state.loaded = true
  const dir = cacheDir(agentId, options)
  if (!fs.existsSync(dir)) return state.docs
  for (const entry of fs.readdirSync(dir)) {
    if (!entry.endsWith(".json")) continue
    const document = readJsonDocument(path.join(dir, entry))
    if (!document || document.agentId !== agentId) continue
    state.docs.set(document.messageId, document)
  }
  return state.docs
}

export function buildMailSearchCacheDocument(message: SearchCacheMessageView, privateEnvelope: PrivateMailEnvelope): MailSearchCacheDocument {
  const readableText = privateMailEnvelopeReadableText(privateEnvelope)
  return {
    schemaVersion: 1,
    messageId: message.id,
    agentId: message.agentId,
    receivedAt: message.receivedAt,
    placement: message.placement,
    compartmentKind: message.compartmentKind,
    ...(message.ownerEmail ? { ownerEmail: message.ownerEmail } : {}),
    ...(message.source ? { source: message.source } : {}),
    from: [...privateEnvelope.from],
    subject: privateEnvelope.subject,
    snippet: privateEnvelope.snippet,
    textExcerpt: readableText.slice(0, SEARCH_TEXT_EXCERPT_LIMIT),
    untrustedContentWarning: privateEnvelope.untrustedContentWarning,
    searchText: normalizeSearchText(privateEnvelope),
    textProjectionVersion: MAIL_SEARCH_TEXT_PROJECTION_VERSION,
    attachmentCount: privateEnvelope.attachments.length,
  }
}

export function upsertMailSearchCacheDocument(
  message: SearchCacheMessageView,
  privateEnvelope: PrivateMailEnvelope,
  options?: MailSearchCacheOptions,
): MailSearchCacheDocument {
  const document = buildMailSearchCacheDocument(message, privateEnvelope)
  const dir = cacheDir(message.agentId, options)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(cachePath(message.agentId, message.id, options), `${JSON.stringify(document)}\n`, "utf-8")
  const state = cacheState(message.agentId, options)
  if (state.loaded) state.docs.set(document.messageId, document)
  emitNervesEvent({
    component: "senses",
    event: "senses.mail_search_cache_upserted",
    message: "mail search cache entry written",
    meta: {
      agentId: message.agentId,
      messageId: document.messageId,
      placement: document.placement,
      compartmentKind: document.compartmentKind,
    },
  })
  return document
}

export function syncMailSearchCacheMetadata(message: SearchCacheMessageView, options?: MailSearchCacheOptions): void {
  const existing = readJsonDocument(cachePath(message.agentId, message.id, options))
  if (!existing) return
  const updated: MailSearchCacheDocument = {
    ...existing,
    receivedAt: message.receivedAt,
    placement: message.placement,
    compartmentKind: message.compartmentKind,
    ...(message.ownerEmail ? { ownerEmail: message.ownerEmail } : {}),
    ...(message.source ? { source: message.source } : {}),
  }
  fs.writeFileSync(cachePath(message.agentId, message.id, options), `${JSON.stringify(updated)}\n`, "utf-8")
  const state = cacheState(message.agentId, options)
  if (state.loaded) state.docs.set(updated.messageId, updated)
}

function sourceMatches(source: string | undefined, filter: string | undefined): boolean {
  if (!filter) return true
  if (!source) return false
  return source.toLowerCase() === filter.toLowerCase()
}

function documentMatchesFilters(document: MailSearchCacheDocument, filters: MailSearchCacheFilters): boolean {
  const queryTerms = filters.queryTerms ?? []
  return (filters.placement ? document.placement === filters.placement : true)
    && (filters.compartmentKind ? document.compartmentKind === filters.compartmentKind : true)
    && sourceMatches(document.source, filters.source)
    && (queryTerms.length
      ? queryTerms.some((term) => document.searchText.includes(term))
      : true)
}

function* readCacheDocuments(agentId: string, options?: MailSearchCacheOptions): Generator<MailSearchCacheDocument> {
  const dir = cacheDir(agentId, options)
  if (!fs.existsSync(dir)) return
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue
    const document = readJsonDocument(path.join(dir, entry.name))
    if (!document || document.agentId !== agentId) continue
    yield document
  }
}

function insertLimitedMatch(
  matches: MailSearchCacheDocument[],
  candidate: MailSearchCacheDocument,
  filters: MailSearchCacheFilters & { limit: number },
): void {
  matches.push(candidate)
  const queryTerms = filters.queryTerms ?? []
  if (queryTerms.length > 0) {
    matches.sort((left, right) => compareByRelevanceThenRecency(
      { document: left, relevance: scoreMailSearchDocument(left, queryTerms) },
      { document: right, relevance: scoreMailSearchDocument(right, queryTerms) },
    ))
  } else {
    matches.sort((left, right) => right.receivedAt.localeCompare(left.receivedAt))
  }
  if (matches.length > filters.limit) matches.length = filters.limit
}

function streamSearchMailSearchCache(filters: MailSearchCacheFilters & { limit: number }, options?: MailSearchCacheOptions): MailSearchCacheDocument[] {
  const matches: MailSearchCacheDocument[] = []
  for (const document of readCacheDocuments(filters.agentId, options)) {
    if (!documentMatchesFilters(document, filters)) continue
    insertLimitedMatch(matches, document, filters)
  }
  return matches
}

export function searchMailSearchCache(filters: MailSearchCacheFilters, options?: MailSearchCacheOptions): MailSearchCacheDocument[] {
  if (typeof filters.limit === "number" && !cacheState(filters.agentId, options).loaded) {
    return streamSearchMailSearchCache({ ...filters, limit: filters.limit }, options)
  }
  const queryTerms = filters.queryTerms ?? []
  const docs = [...loadCache(filters.agentId, options).values()]
    .filter((document) => documentMatchesFilters(document, filters))

  let ordered: MailSearchCacheDocument[]
  if (queryTerms.length > 0) {
    ordered = docs
      .map((document) => ({ document, relevance: scoreMailSearchDocument(document, queryTerms) }))
      .sort(compareByRelevanceThenRecency)
      .map((entry) => entry.document)
  } else {
    ordered = docs.sort((left, right) => right.receivedAt.localeCompare(left.receivedAt))
  }
  return typeof filters.limit === "number" ? ordered.slice(0, filters.limit) : ordered
}

export interface MailSearchCacheFilterSnapshot {
  totalDocuments: number
  currentProjectionDocuments: number
  oldestReceivedAt?: string
  newestReceivedAt?: string
}

export function snapshotMailSearchCacheForFilters(
  filters: Omit<MailSearchCacheFilters, "queryTerms" | "limit">,
  options?: MailSearchCacheOptions,
): MailSearchCacheFilterSnapshot {
  let totalDocuments = 0
  let currentProjectionDocuments = 0
  let oldestReceivedAt: string | undefined
  let newestReceivedAt: string | undefined
  for (const document of readCacheDocuments(filters.agentId, options)) {
    if (!documentMatchesFilters(document, filters)) continue
    totalDocuments += 1
    if (document.textProjectionVersion === MAIL_SEARCH_TEXT_PROJECTION_VERSION) {
      currentProjectionDocuments += 1
    }
    if (!oldestReceivedAt || document.receivedAt < oldestReceivedAt) oldestReceivedAt = document.receivedAt
    if (!newestReceivedAt || document.receivedAt > newestReceivedAt) newestReceivedAt = document.receivedAt
  }
  return {
    totalDocuments,
    currentProjectionDocuments,
    ...(oldestReceivedAt ? { oldestReceivedAt } : {}),
    ...(newestReceivedAt ? { newestReceivedAt } : {}),
  }
}

/**
 * Snapshot of the on-disk mail search cache. Used to detect cache-vs-store
 * divergence after a substrate event (key rotation, hosted → local migration,
 * wiped encrypted store) leaves cache documents stranded without their backing
 * encrypted messages. Counts `.json` entries via `readdir` only — no JSON
 * parsing — so the diagnostic stays cheap on bundles with tens of thousands
 * of cached documents.
 */
export interface MailSearchCacheSnapshot {
  totalDocuments: number
}

export function snapshotMailSearchCache(agentId: string, options?: MailSearchCacheOptions): MailSearchCacheSnapshot {
  const dir = cacheDir(agentId, options)
  if (!fs.existsSync(dir)) return { totalDocuments: 0 }
  let total = 0
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith(".json")) total += 1
  }
  return { totalDocuments: total }
}

export function readMailSearchCoverageRecord(key: MailSearchCoverageKey, options?: MailSearchCacheOptions): MailSearchCoverageRecord | null {
  const document = readJsonDocument(coveragePath(key, options)) as MailSearchCoverageRecord | null
  if (!document || document.schemaVersion !== 1 || document.agentId !== key.agentId) return null
  const normalized = normalizedCoverageKey(key)
  const stored = normalizedCoverageKey(document)
  if (JSON.stringify(stored) !== JSON.stringify(normalized)) return null
  return document
}

export function writeMailSearchCoverageRecord(
  record: MailSearchCoverageRecord,
  options?: MailSearchCacheOptions,
): MailSearchCoverageRecord {
  const normalized = normalizedCoverageKey(record)
  const document: MailSearchCoverageRecord = {
    schemaVersion: 1,
    ...normalized,
    indexedAt: record.indexedAt,
    visibleMessageCount: record.visibleMessageCount,
    cachedMessageCount: record.cachedMessageCount,
    decryptableMessageCount: record.decryptableMessageCount,
    skippedMessageCount: record.skippedMessageCount,
    ...(record.messageIndexFingerprint ? { messageIndexFingerprint: record.messageIndexFingerprint } : {}),
    textProjectionVersion: record.textProjectionVersion,
    ...(record.oldestReceivedAt ? { oldestReceivedAt: record.oldestReceivedAt } : {}),
    ...(record.newestReceivedAt ? { newestReceivedAt: record.newestReceivedAt } : {}),
  }
  fs.mkdirSync(coverageDir(document.agentId, options), { recursive: true })
  fs.writeFileSync(coveragePath(document, options), `${JSON.stringify(document)}\n`, "utf-8")
  emitNervesEvent({
    component: "senses",
    event: "senses.mail_search_coverage_written",
    message: "mail search coverage record written",
    meta: {
      agentId: document.agentId,
      placement: document.placement ?? null,
      compartmentKind: document.compartmentKind ?? null,
      source: document.source ?? null,
      storeKind: document.storeKind,
      visibleMessageCount: document.visibleMessageCount,
      decryptableMessageCount: document.decryptableMessageCount,
    },
  })
  return document
}

export function resetMailSearchCacheForTests(): void {
  cacheStates.clear()
}
