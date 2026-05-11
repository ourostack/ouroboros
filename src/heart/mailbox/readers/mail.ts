import { emitNervesEvent } from "../../../nerves/runtime"
import { decryptMessages, type MailAccessLogEntry } from "../../../mailroom/file-store"
import { resolveMailroomReaderWithRefresh } from "../../../mailroom/reader"
import { describeMailProvenance, type DecryptedMailMessage, type StoredMailMessage } from "../../../mailroom/core"
import type { MailOutboundRecord, MailScreenerCandidate } from "../../../mailroom/core"
import type {
  MailboxMailAccessEntry,
  MailboxMailFolder,
  MailboxMailMessageDetail,
  MailboxMailMessageSummary,
  MailboxMailMessageView,
  MailboxMailOutboundRecord,
  MailboxMailProvenance,
  MailboxMailRecoverySummary,
  MailboxMailScreenerCandidate,
  MailboxMailStatus,
  MailboxMailView,
} from "../mailbox-types"

const MAILBOX_MAIL_LIST_LIMIT = 50
const MAILBOX_MAIL_SUMMARY_LIMIT = MAILBOX_MAIL_LIST_LIMIT
const MAILBOX_MAIL_BODY_LIMIT = 12_000

interface MailDecryptSkip {
  messageId: string
  keyId: string
}

interface VisibleMailDecryptResult {
  decrypted: DecryptedMailMessage[]
  skipped: MailDecryptSkip[]
}

function emptyFolders(): MailboxMailFolder[] {
  return [
    { id: "imbox", label: "Imbox", count: 0 },
    { id: "screener", label: "Screener", count: 0 },
    { id: "discarded", label: "Discarded", count: 0 },
    { id: "quarantine", label: "Quarantine", count: 0 },
    { id: "draft", label: "Drafts", count: 0 },
    { id: "sent", label: "Sent", count: 0 },
    { id: "delegated", label: "Delegated", count: 0 },
    { id: "native", label: "Native", count: 0 },
  ]
}

function emptyRecovery(): MailboxMailRecoverySummary {
  return { discardedCount: 0, quarantineCount: 0, undecryptableCount: 0, missingKeyIds: [] }
}

function unavailableMailView(agentName: string, status: Exclude<MailboxMailStatus, "ready">, error: string): MailboxMailView {
  return {
    status,
    agentName,
    mailboxAddress: null,
    generatedAt: new Date().toISOString(),
    store: null,
    folders: emptyFolders(),
    messages: [],
    screener: [],
    outbound: [],
    recovery: emptyRecovery(),
    accessLog: [],
    error,
  }
}

function unavailableMessageView(agentName: string, status: Exclude<MailboxMailStatus, "ready">, error: string): MailboxMailMessageView {
  return {
    status,
    agentName,
    mailboxAddress: null,
    generatedAt: new Date().toISOString(),
    message: null,
    accessLog: [],
    error,
  }
}

function mailSummary(message: DecryptedMailMessage): MailboxMailMessageSummary {
  const provenance: MailboxMailProvenance = {
    placement: message.placement,
    compartmentKind: message.compartmentKind,
    ownerEmail: message.ownerEmail ?? null,
    source: message.source ?? null,
    recipient: message.recipient,
    mailboxId: message.mailboxId,
    grantId: message.grantId ?? null,
    trustReason: message.trustReason,
  }
  return {
    id: message.id,
    subject: message.private.subject,
    from: message.private.from,
    to: message.private.to,
    cc: message.private.cc,
    date: message.private.date ?? null,
    receivedAt: message.receivedAt,
    snippet: message.private.snippet,
    placement: message.placement,
    compartmentKind: message.compartmentKind,
    ownerEmail: message.ownerEmail ?? null,
    source: message.source ?? null,
    recipient: message.recipient,
    attachmentCount: message.private.attachments.length,
    untrustedContentWarning: message.private.untrustedContentWarning,
    provenance,
  }
}

function missingPrivateMailKeyId(error: unknown): string | null {
  /* v8 ignore next -- non-Error throw branch: decryptMessages only ever throws Error subclasses (MissingPrivateMailKeyError or crypto errors); this guard is defensive. @preserve */
  if (!(error instanceof Error)) return null
  const errorWithKeyId = error as Error & { keyId?: unknown }
  return typeof errorWithKeyId.keyId === "string" && errorWithKeyId.keyId.length > 0
    ? errorWithKeyId.keyId
    : null
}

function decryptVisibleMessages(messages: StoredMailMessage[], privateKeys: Record<string, string>): VisibleMailDecryptResult {
  const decrypted: DecryptedMailMessage[] = []
  const skipped: MailDecryptSkip[] = []
  for (const message of messages) {
    try {
      decrypted.push(decryptMessages([message], privateKeys)[0]!)
    } catch (error) {
      const keyId = missingPrivateMailKeyId(error)
      if (!keyId) throw error
      skipped.push({ messageId: message.id, keyId })
    }
  }
  return { decrypted, skipped }
}

function buildFolders(messages: MailboxMailMessageSummary[], outbound: MailboxMailOutboundRecord[]): MailboxMailFolder[] {
  const folders = [
    { id: "imbox", label: "Imbox", count: messages.filter((message) => message.placement === "imbox").length },
    { id: "screener", label: "Screener", count: messages.filter((message) => message.placement === "screener").length },
    { id: "discarded", label: "Discarded", count: messages.filter((message) => message.placement === "discarded").length },
    { id: "quarantine", label: "Quarantine", count: messages.filter((message) => message.placement === "quarantine").length },
    { id: "draft", label: "Drafts", count: outbound.filter((record) => record.status === "draft").length },
    { id: "sent", label: "Sent", count: outbound.filter((record) => record.status !== "draft").length },
    { id: "delegated", label: "Delegated", count: messages.filter((message) => message.compartmentKind === "delegated").length },
    { id: "native", label: "Native", count: messages.filter((message) => message.compartmentKind === "native").length },
  ]
  const sourceCounts = new Map<string, number>()
  const sourceOwnerCounts = new Map<string, Map<string, number>>()
  for (const message of messages) {
    if (!message.source) continue
    sourceCounts.set(message.source, (sourceCounts.get(message.source) ?? 0) + 1)
    const owner = message.ownerEmail ?? ""
    const ownerCounts = sourceOwnerCounts.get(message.source) ?? new Map<string, number>()
    ownerCounts.set(owner, (ownerCounts.get(owner) ?? 0) + 1)
    sourceOwnerCounts.set(message.source, ownerCounts)
  }
  for (const [source, count] of [...sourceCounts.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const ownerCounts = sourceOwnerCounts.get(source)
    if (!ownerCounts || ownerCounts.size <= 1) {
      folders.push({ id: `source:${source}`, label: source.toUpperCase(), count })
      continue
    }
    for (const [owner, ownerCount] of [...ownerCounts.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      const ownerLabel = owner || "unknown owner"
      const ownerId = owner || "unknown-owner"
      folders.push({ id: `source:${source}:${ownerId}`, label: `${source.toUpperCase()} / ${ownerLabel}`, count: ownerCount })
    }
  }
  return folders
}

function screenerCandidate(candidate: MailScreenerCandidate): MailboxMailScreenerCandidate {
  return {
    id: candidate.id,
    messageId: candidate.messageId,
    senderEmail: candidate.senderEmail,
    senderDisplay: candidate.senderDisplay,
    recipient: candidate.recipient,
    source: candidate.source ?? null,
    ownerEmail: candidate.ownerEmail ?? null,
    status: candidate.status,
    placement: candidate.placement,
    trustReason: candidate.trustReason,
    firstSeenAt: candidate.firstSeenAt,
    lastSeenAt: candidate.lastSeenAt,
    messageCount: candidate.messageCount,
  }
}

function outboundRecord(record: MailOutboundRecord): MailboxMailOutboundRecord {
  const policyDecision = record.policyDecision
  return {
    id: record.id,
    status: record.status,
    mailboxRole: record.mailboxRole ?? "agent-native-mailbox",
    sendAuthority: record.sendAuthority ?? "agent-native",
    ownerEmail: record.ownerEmail ?? null,
    source: record.source ?? null,
    from: record.from,
    to: record.to,
    cc: record.cc,
    bcc: record.bcc,
    subject: record.subject,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    sentAt: record.sentAt ?? null,
    submittedAt: record.submittedAt ?? null,
    acceptedAt: record.acceptedAt ?? null,
    deliveredAt: record.deliveredAt ?? null,
    failedAt: record.failedAt ?? null,
    sendMode: record.sendMode ?? null,
    policyDecision: policyDecision
      ? {
          allowed: policyDecision.allowed,
          mode: policyDecision.mode,
          code: policyDecision.code,
          reason: policyDecision.reason,
          evaluatedAt: policyDecision.evaluatedAt,
          recipients: policyDecision.recipients,
          fallback: policyDecision.fallback,
          policyId: policyDecision.policyId ?? null,
          remainingSendsInWindow: policyDecision.remainingSendsInWindow ?? null,
        }
      : null,
    provider: record.provider ?? null,
    providerMessageId: record.providerMessageId ?? null,
    providerRequestId: record.providerRequestId ?? null,
    operationLocation: record.operationLocation ?? null,
    deliveryEvents: (record.deliveryEvents ?? []).map((event) => ({
      provider: event.provider,
      providerEventId: event.providerEventId,
      providerMessageId: event.providerMessageId,
      outcome: event.outcome,
      recipient: event.recipient ?? null,
      occurredAt: event.occurredAt,
      receivedAt: event.receivedAt,
      bodySafeSummary: event.bodySafeSummary,
      providerStatus: event.providerStatus ?? null,
    })),
    transport: record.transport ?? null,
    reason: record.reason,
  }
}

function buildRecovery(messages: MailboxMailMessageSummary[], skipped: MailDecryptSkip[] = []): MailboxMailRecoverySummary {
  return {
    discardedCount: messages.filter((message) => message.placement === "discarded").length,
    quarantineCount: messages.filter((message) => message.placement === "quarantine").length,
    undecryptableCount: skipped.length,
    missingKeyIds: [...new Set(skipped.map((entry) => entry.keyId))].sort(),
  }
}

function accessEntries(entries: MailAccessLogEntry[]): MailboxMailAccessEntry[] {
  return entries
    .slice()
    .sort((left, right) => right.accessedAt.localeCompare(left.accessedAt))
    .slice(0, 20)
    .map((entry) => ({
      id: entry.id,
      messageId: entry.messageId ?? null,
      threadId: entry.threadId ?? null,
      tool: entry.tool,
      reason: entry.reason,
      mailboxRole: entry.mailboxRole ?? null,
      compartmentKind: entry.compartmentKind ?? null,
      ownerEmail: entry.ownerEmail ?? null,
      source: entry.source ?? null,
      accessedAt: entry.accessedAt,
    }))
}

function accessProvenance(message: DecryptedMailMessage): Pick<MailAccessLogEntry, "mailboxRole" | "compartmentKind" | "ownerEmail" | "source"> {
  const provenance = describeMailProvenance(message)
  return {
    mailboxRole: provenance.mailboxRole,
    compartmentKind: message.compartmentKind,
    ownerEmail: provenance.ownerEmail,
    source: provenance.source,
  }
}

function emitMailRead(agentName: string, mode: "list" | "message", status: MailboxMailStatus): void {
  emitNervesEvent({
    component: "heart",
    event: "heart.mailbox_mail_read",
    message: "reading Mailbox mail surface",
    meta: { agentName, mode, status },
  })
}

function statusFromReaderFailure(reason: "auth-required" | "misconfigured"): "auth-required" | "misconfigured" {
  return reason
}

export async function readMailView(agentName: string): Promise<MailboxMailView> {
  const resolved = await resolveMailroomReaderWithRefresh(agentName)
  if (!resolved.ok) {
    const status = statusFromReaderFailure(resolved.reason)
    emitMailRead(agentName, "list", status)
    return unavailableMailView(agentName, status, resolved.error)
  }

  try {
    const stored = await resolved.store.listMessages({ agentId: agentName, limit: MAILBOX_MAIL_SUMMARY_LIMIT })
    const result = decryptVisibleMessages(stored, resolved.config.privateKeys)
    const summaries = result.decrypted.map(mailSummary)
    const screener = (await resolved.store.listScreenerCandidates({ agentId: agentName, status: "pending", limit: 100 }))
      .map(screenerCandidate)
    const outbound = (await resolved.store.listMailOutbound(agentName)).map(outboundRecord)
    await resolved.store.recordAccess({
      agentId: agentName,
      tool: "mailbox_mail_list",
      reason: "mailbox read-only mailbox",
    })
    const accessLog = accessEntries(await resolved.store.listAccessLog(agentName))
    emitMailRead(agentName, "list", "ready")
    return {
      status: "ready",
      agentName,
      mailboxAddress: resolved.config.mailboxAddress,
      generatedAt: new Date().toISOString(),
      store: {
        kind: resolved.storeKind,
        label: resolved.storeLabel,
      },
      folders: buildFolders(summaries, outbound),
      messages: summaries.slice(0, MAILBOX_MAIL_LIST_LIMIT),
      screener,
      outbound,
      recovery: buildRecovery(summaries, result.skipped),
      accessLog,
      error: null,
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    emitMailRead(agentName, "list", "error")
    return unavailableMailView(agentName, "error", message)
  }
}

export async function readMailMessageView(agentName: string, messageId: string): Promise<MailboxMailMessageView> {
  const resolved = await resolveMailroomReaderWithRefresh(agentName)
  if (!resolved.ok) {
    const status = statusFromReaderFailure(resolved.reason)
    emitMailRead(agentName, "message", status)
    return unavailableMessageView(agentName, status, resolved.error)
  }

  try {
    const stored = await resolved.store.getMessage(messageId)
    if (!stored || stored.agentId !== agentName) {
      emitMailRead(agentName, "message", "not-found")
      return {
        status: "not-found",
        agentName,
        mailboxAddress: resolved.config.mailboxAddress,
        generatedAt: new Date().toISOString(),
        message: null,
        accessLog: accessEntries(await resolved.store.listAccessLog(agentName)),
        error: `No visible mail message found for ${messageId}.`,
      }
    }

    const decrypted = decryptMessages([stored], resolved.config.privateKeys)[0]!
    const access = await resolved.store.recordAccess({
      agentId: agentName,
      messageId,
      tool: "mailbox_mail_message",
      reason: "mailbox read-only message body",
      ...accessProvenance(decrypted),
    })
    const body = decrypted.private.text.length > MAILBOX_MAIL_BODY_LIMIT
      ? decrypted.private.text.slice(0, MAILBOX_MAIL_BODY_LIMIT)
      : decrypted.private.text
    const detail: MailboxMailMessageDetail = {
      ...mailSummary(decrypted),
      text: body,
      htmlAvailable: typeof decrypted.private.html === "string" && decrypted.private.html.length > 0,
      bodyTruncated: decrypted.private.text.length > MAILBOX_MAIL_BODY_LIMIT,
      attachments: decrypted.private.attachments,
      access: {
        tool: access.tool,
        reason: access.reason,
        accessedAt: access.accessedAt,
      },
    }
    emitMailRead(agentName, "message", "ready")
    return {
      status: "ready",
      agentName,
      mailboxAddress: resolved.config.mailboxAddress,
      generatedAt: new Date().toISOString(),
      message: detail,
      accessLog: accessEntries(await resolved.store.listAccessLog(agentName)),
      error: null,
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    emitMailRead(agentName, "message", "error")
    return unavailableMessageView(agentName, "error", message)
  }
}
