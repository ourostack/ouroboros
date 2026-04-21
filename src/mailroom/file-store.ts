import * as fs from "node:fs"
import * as path from "node:path"
import { emitNervesEvent } from "../nerves/runtime"
import {
  buildStoredMailMessage,
  decryptStoredMailMessage,
  type DecryptedMailMessage,
  type EncryptedPayload,
  type MailClassification,
  type MailDecisionRecord,
  type MailEnvelopeInput,
  type MailPlacement,
  type MailroomRegistry,
  type ResolvedMailAddress,
  type MailScreenerCandidate,
  type MailScreenerCandidateStatus,
  type StoredMailMessage,
} from "./core"

export interface MailAccessLogEntry {
  id: string
  agentId: string
  messageId?: string
  threadId?: string
  tool: string
  reason: string
  session?: string
  accessedAt: string
}

export interface MailListFilters {
  agentId: string
  placement?: MailPlacement
  compartmentKind?: "native" | "delegated"
  source?: string
  limit?: number
}

export interface MailScreenerCandidateFilters {
  agentId: string
  status?: MailScreenerCandidateStatus
  placement?: MailPlacement
  limit?: number
}

export interface MailroomStore {
  putRawMessage(input: {
    resolved: ResolvedMailAddress
    envelope: MailEnvelopeInput
    rawMime: Buffer
    receivedAt?: Date
    classification?: MailClassification
  }): Promise<{ created: boolean; message: StoredMailMessage }>
  getMessage(id: string): Promise<StoredMailMessage | null>
  listMessages(filters: MailListFilters): Promise<StoredMailMessage[]>
  updateMessagePlacement(id: string, placement: MailPlacement): Promise<StoredMailMessage | null>
  readRawPayload(objectName: string): Promise<EncryptedPayload | null>
  putScreenerCandidate(candidate: MailScreenerCandidate): Promise<MailScreenerCandidate>
  updateScreenerCandidate(candidate: MailScreenerCandidate): Promise<MailScreenerCandidate>
  listScreenerCandidates(filters: MailScreenerCandidateFilters): Promise<MailScreenerCandidate[]>
  recordMailDecision(entry: Omit<MailDecisionRecord, "schemaVersion" | "id" | "createdAt"> & { id?: string; createdAt?: string }): Promise<MailDecisionRecord>
  listMailDecisions(agentId: string): Promise<MailDecisionRecord[]>
  recordAccess(entry: Omit<MailAccessLogEntry, "id" | "accessedAt">): Promise<MailAccessLogEntry>
  listAccessLog(agentId: string): Promise<MailAccessLogEntry[]>
}

export interface FileMailroomStoreOptions {
  rootDir: string
}

function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true })
}

function readJson<T>(filePath: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8")) as T
  } catch {
    return null
  }
}

function writeJson(filePath: string, value: unknown): void {
  ensureDir(path.dirname(filePath))
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf-8")
}

function compareNewestFirst(left: StoredMailMessage, right: StoredMailMessage): number {
  return Date.parse(right.receivedAt) - Date.parse(left.receivedAt)
}

function compareCandidatesNewestFirst(left: MailScreenerCandidate, right: MailScreenerCandidate): number {
  return Date.parse(right.lastSeenAt) - Date.parse(left.lastSeenAt)
}

export class FileMailroomStore implements MailroomStore {
  private readonly rootDir: string

  constructor(options: FileMailroomStoreOptions) {
    this.rootDir = options.rootDir
    ensureDir(this.messagesDir)
    ensureDir(this.rawDir)
    ensureDir(this.logsDir)
    ensureDir(this.candidatesDir)
    ensureDir(this.decisionsDir)
    emitNervesEvent({
      component: "senses",
      event: "senses.mail_file_store_init",
      message: "file mailroom store initialized",
      meta: { rootDir: this.rootDir },
    })
  }

  private get messagesDir(): string {
    return path.join(this.rootDir, "messages")
  }

  private get rawDir(): string {
    return path.join(this.rootDir, "raw")
  }

  private get logsDir(): string {
    return path.join(this.rootDir, "access-log")
  }

  private get candidatesDir(): string {
    return path.join(this.rootDir, "candidates")
  }

  private get decisionsDir(): string {
    return path.join(this.rootDir, "decisions")
  }

  private messagePath(id: string): string {
    return path.join(this.messagesDir, `${id}.json`)
  }

  private candidatePath(id: string): string {
    return path.join(this.candidatesDir, `${id}.json`)
  }

  private rawPath(objectName: string): string {
    return path.join(this.rootDir, objectName)
  }

  private decisionLogPath(agentId: string): string {
    return path.join(this.decisionsDir, `${agentId}.jsonl`)
  }

  private accessLogPath(agentId: string): string {
    return path.join(this.logsDir, `${agentId}.jsonl`)
  }

  async putRawMessage(input: {
    resolved: ResolvedMailAddress
    envelope: MailEnvelopeInput
    rawMime: Buffer
    receivedAt?: Date
    classification?: MailClassification
  }): Promise<{ created: boolean; message: StoredMailMessage }> {
    const { message, rawPayload, candidate } = await buildStoredMailMessage(input)
    const existing = readJson<StoredMailMessage>(this.messagePath(message.id))
    if (existing) {
      emitNervesEvent({
        component: "senses",
        event: "senses.mail_store_dedupe",
        message: "mailroom store deduped existing message",
        meta: { id: message.id, agentId: message.agentId },
      })
      return { created: false, message: existing }
    }
    writeJson(this.rawPath(message.rawObject), rawPayload)
    writeJson(this.messagePath(message.id), message)
    if (candidate) {
      writeJson(this.candidatePath(candidate.id), candidate)
    }
    emitNervesEvent({
      component: "senses",
      event: "senses.mail_store_message_written",
      message: "mailroom store wrote message",
      meta: { id: message.id, agentId: message.agentId, candidate: candidate !== undefined },
    })
    return { created: true, message }
  }

  async getMessage(id: string): Promise<StoredMailMessage | null> {
    const message = readJson<StoredMailMessage>(this.messagePath(id))
    emitNervesEvent({
      component: "senses",
      event: "senses.mail_store_message_read",
      message: "mailroom store read message",
      meta: { id, found: message !== null },
    })
    return message
  }

  async listMessages(filters: MailListFilters): Promise<StoredMailMessage[]> {
    const messages = fs.readdirSync(this.messagesDir)
      .filter((name) => name.endsWith(".json"))
      .map((name) => readJson<StoredMailMessage>(path.join(this.messagesDir, name)))
      .filter((message): message is StoredMailMessage => message !== null)
      .filter((message) => message.agentId === filters.agentId)
      .filter((message) => filters.placement ? message.placement === filters.placement : true)
      .filter((message) => filters.compartmentKind ? message.compartmentKind === filters.compartmentKind : true)
      .filter((message) => filters.source ? message.source === filters.source : true)
      .sort(compareNewestFirst)
      .slice(0, filters.limit ?? 20)
    emitNervesEvent({
      component: "senses",
      event: "senses.mail_store_messages_listed",
      message: "mailroom store listed messages",
      meta: { agentId: filters.agentId, count: messages.length },
    })
    return messages
  }

  async updateMessagePlacement(id: string, placement: MailPlacement): Promise<StoredMailMessage | null> {
    const message = readJson<StoredMailMessage>(this.messagePath(id))
    if (!message) {
      emitNervesEvent({
        component: "senses",
        event: "senses.mail_store_message_placement_updated",
        message: "mailroom store message placement update missed",
        meta: { id, placement, found: false },
      })
      return null
    }
    const updated: StoredMailMessage = { ...message, placement }
    writeJson(this.messagePath(id), updated)
    emitNervesEvent({
      component: "senses",
      event: "senses.mail_store_message_placement_updated",
      message: "mailroom store updated message placement",
      meta: { id, placement, found: true },
    })
    return updated
  }

  async readRawPayload(objectName: string): Promise<EncryptedPayload | null> {
    const payload = readJson<EncryptedPayload>(this.rawPath(objectName))
    emitNervesEvent({
      component: "senses",
      event: "senses.mail_store_raw_read",
      message: "mailroom store read raw payload",
      meta: { objectName, found: payload !== null },
    })
    return payload
  }

  async putScreenerCandidate(candidate: MailScreenerCandidate): Promise<MailScreenerCandidate> {
    writeJson(this.candidatePath(candidate.id), candidate)
    emitNervesEvent({
      component: "senses",
      event: "senses.mail_screener_candidate_written",
      message: "mail screener candidate written",
      meta: { id: candidate.id, agentId: candidate.agentId, status: candidate.status },
    })
    return candidate
  }

  async updateScreenerCandidate(candidate: MailScreenerCandidate): Promise<MailScreenerCandidate> {
    return this.putScreenerCandidate(candidate)
  }

  async listScreenerCandidates(filters: MailScreenerCandidateFilters): Promise<MailScreenerCandidate[]> {
    const candidates = fs.readdirSync(this.candidatesDir)
      .filter((name) => name.endsWith(".json"))
      .map((name) => readJson<MailScreenerCandidate>(path.join(this.candidatesDir, name)))
      .filter((candidate): candidate is MailScreenerCandidate => candidate !== null)
      .filter((candidate) => candidate.agentId === filters.agentId)
      .filter((candidate) => filters.status ? candidate.status === filters.status : true)
      .filter((candidate) => filters.placement ? candidate.placement === filters.placement : true)
      .sort(compareCandidatesNewestFirst)
      .slice(0, filters.limit ?? 50)
    emitNervesEvent({
      component: "senses",
      event: "senses.mail_screener_candidates_listed",
      message: "mail screener candidates listed",
      meta: { agentId: filters.agentId, count: candidates.length },
    })
    return candidates
  }

  async recordMailDecision(entry: Omit<MailDecisionRecord, "schemaVersion" | "id" | "createdAt"> & { id?: string; createdAt?: string }): Promise<MailDecisionRecord> {
    const complete: MailDecisionRecord = {
      schemaVersion: 1,
      ...entry,
      id: entry.id ?? `decision_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      createdAt: entry.createdAt ?? new Date().toISOString(),
    }
    ensureDir(this.decisionsDir)
    fs.appendFileSync(this.decisionLogPath(entry.agentId), `${JSON.stringify(complete)}\n`, "utf-8")
    emitNervesEvent({
      component: "senses",
      event: "senses.mail_decision_recorded",
      message: "mail decision recorded",
      meta: { agentId: entry.agentId, messageId: entry.messageId, action: entry.action },
    })
    return complete
  }

  async listMailDecisions(agentId: string): Promise<MailDecisionRecord[]> {
    const filePath = this.decisionLogPath(agentId)
    if (!fs.existsSync(filePath)) {
      emitNervesEvent({
        component: "senses",
        event: "senses.mail_decisions_listed",
        message: "mail decisions listed",
        meta: { agentId, count: 0 },
      })
      return []
    }
    const entries = fs.readFileSync(filePath, "utf-8")
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line) as MailDecisionRecord)
    emitNervesEvent({
      component: "senses",
      event: "senses.mail_decisions_listed",
      message: "mail decisions listed",
      meta: { agentId, count: entries.length },
    })
    return entries
  }

  async recordAccess(entry: Omit<MailAccessLogEntry, "id" | "accessedAt">): Promise<MailAccessLogEntry> {
    const complete: MailAccessLogEntry = {
      ...entry,
      id: `access_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      accessedAt: new Date().toISOString(),
    }
    ensureDir(this.logsDir)
    fs.appendFileSync(this.accessLogPath(entry.agentId), `${JSON.stringify(complete)}\n`, "utf-8")
    emitNervesEvent({
      component: "senses",
      event: "senses.mail_access_recorded",
      message: "mail access recorded",
      meta: { agentId: entry.agentId, messageId: entry.messageId ?? null, tool: entry.tool },
    })
    return complete
  }

  async listAccessLog(agentId: string): Promise<MailAccessLogEntry[]> {
    const filePath = this.accessLogPath(agentId)
    if (!fs.existsSync(filePath)) {
      emitNervesEvent({
        component: "senses",
        event: "senses.mail_access_log_listed",
        message: "mail access log listed",
        meta: { agentId, count: 0 },
      })
      return []
    }
    const entries = fs.readFileSync(filePath, "utf-8")
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line) as MailAccessLogEntry)
    emitNervesEvent({
      component: "senses",
      event: "senses.mail_access_log_listed",
      message: "mail access log listed",
      meta: { agentId, count: entries.length },
    })
    return entries
  }
}

export async function ingestRawMailToStore(input: {
  registry: MailroomRegistry
  store: MailroomStore
  envelope: MailEnvelopeInput
  rawMime: Buffer
  receivedAt?: Date
  authentication?: import("./core").MailAuthenticationSummary
}): Promise<{ accepted: StoredMailMessage[]; rejectedRecipients: string[] }> {
  const { resolveMailAddress } = await import("./core")
  const { classifyResolvedMailPlacement } = await import("./policy")
  const accepted: StoredMailMessage[] = []
  const rejectedRecipients: string[] = []
  for (const recipient of input.envelope.rcptTo) {
    const resolved = resolveMailAddress(input.registry, recipient)
    if (!resolved) {
      rejectedRecipients.push(recipient)
      continue
    }
    const classification = classifyResolvedMailPlacement({
      registry: input.registry,
      resolved,
      sender: input.envelope.mailFrom,
      ...(input.authentication ? { authentication: input.authentication } : {}),
    })
    const result = await input.store.putRawMessage({
      resolved,
      envelope: input.envelope,
      rawMime: input.rawMime,
      receivedAt: input.receivedAt,
      classification,
    })
    accepted.push(result.message)
  }
  emitNervesEvent({
    component: "senses",
    event: "senses.mail_ingest_complete",
    message: "mail ingest completed",
    meta: { accepted: accepted.length, rejected: rejectedRecipients.length },
  })
  return { accepted, rejectedRecipients }
}

export function decryptMessages(messages: StoredMailMessage[], privateKeys: Record<string, string>): DecryptedMailMessage[] {
  const decrypted = messages.map((message) => decryptStoredMailMessage(message, privateKeys))
  emitNervesEvent({
    component: "senses",
    event: "senses.mail_messages_decrypted",
    message: "mail messages decrypted",
    meta: { count: decrypted.length },
  })
  return decrypted
}
