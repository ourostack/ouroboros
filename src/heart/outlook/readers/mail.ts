import { emitNervesEvent } from "../../../nerves/runtime"
import { decryptMessages, type MailAccessLogEntry } from "../../../mailroom/file-store"
import { resolveMailroomReader } from "../../../mailroom/reader"
import type { DecryptedMailMessage } from "../../../mailroom/core"
import type {
  OutlookMailAccessEntry,
  OutlookMailFolder,
  OutlookMailMessageDetail,
  OutlookMailMessageSummary,
  OutlookMailMessageView,
  OutlookMailStatus,
  OutlookMailView,
} from "../outlook-types"

const OUTLOOK_MAIL_LIST_LIMIT = 50
const OUTLOOK_MAIL_COUNT_LIMIT = 500
const OUTLOOK_MAIL_BODY_LIMIT = 12_000

function emptyFolders(): OutlookMailFolder[] {
  return [
    { id: "imbox", label: "Imbox", count: 0 },
    { id: "screener", label: "Screener", count: 0 },
    { id: "delegated", label: "Delegated", count: 0 },
    { id: "native", label: "Native", count: 0 },
  ]
}

function unavailableMailView(agentName: string, status: Exclude<OutlookMailStatus, "ready">, error: string): OutlookMailView {
  return {
    status,
    agentName,
    mailboxAddress: null,
    generatedAt: new Date().toISOString(),
    store: null,
    folders: emptyFolders(),
    messages: [],
    accessLog: [],
    error,
  }
}

function unavailableMessageView(agentName: string, status: Exclude<OutlookMailStatus, "ready">, error: string): OutlookMailMessageView {
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

function mailSummary(message: DecryptedMailMessage): OutlookMailMessageSummary {
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
  }
}

function buildFolders(messages: OutlookMailMessageSummary[]): OutlookMailFolder[] {
  const folders = [
    { id: "imbox", label: "Imbox", count: messages.filter((message) => message.placement === "imbox").length },
    { id: "screener", label: "Screener", count: messages.filter((message) => message.placement === "screener").length },
    { id: "delegated", label: "Delegated", count: messages.filter((message) => message.compartmentKind === "delegated").length },
    { id: "native", label: "Native", count: messages.filter((message) => message.compartmentKind === "native").length },
  ]
  const sourceCounts = new Map<string, number>()
  for (const message of messages) {
    if (!message.source) continue
    sourceCounts.set(message.source, (sourceCounts.get(message.source) ?? 0) + 1)
  }
  for (const [source, count] of [...sourceCounts.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    folders.push({ id: `source:${source}`, label: source.toUpperCase(), count })
  }
  return folders
}

function accessEntries(entries: MailAccessLogEntry[]): OutlookMailAccessEntry[] {
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
      accessedAt: entry.accessedAt,
    }))
}

function emitMailRead(agentName: string, mode: "list" | "message", status: OutlookMailStatus): void {
  emitNervesEvent({
    component: "heart",
    event: "heart.outlook_mail_read",
    message: "reading Outlook mail surface",
    meta: { agentName, mode, status },
  })
}

function statusFromReaderFailure(reason: "auth-required" | "misconfigured"): "auth-required" | "misconfigured" {
  return reason
}

export async function readMailView(agentName: string): Promise<OutlookMailView> {
  const resolved = resolveMailroomReader(agentName)
  if (!resolved.ok) {
    const status = statusFromReaderFailure(resolved.reason)
    emitMailRead(agentName, "list", status)
    return unavailableMailView(agentName, status, resolved.error)
  }

  try {
    const stored = await resolved.store.listMessages({ agentId: agentName, limit: OUTLOOK_MAIL_COUNT_LIMIT })
    const decrypted = decryptMessages(stored, resolved.config.privateKeys)
    const summaries = decrypted.map(mailSummary)
    await resolved.store.recordAccess({
      agentId: agentName,
      tool: "outlook_mail_list",
      reason: "outlook read-only mailbox",
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
      folders: buildFolders(summaries),
      messages: summaries.slice(0, OUTLOOK_MAIL_LIST_LIMIT),
      accessLog,
      error: null,
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    emitMailRead(agentName, "list", "error")
    return unavailableMailView(agentName, "error", message)
  }
}

export async function readMailMessageView(agentName: string, messageId: string): Promise<OutlookMailMessageView> {
  const resolved = resolveMailroomReader(agentName)
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
      tool: "outlook_mail_message",
      reason: "outlook read-only message body",
    })
    const body = decrypted.private.text.length > OUTLOOK_MAIL_BODY_LIMIT
      ? decrypted.private.text.slice(0, OUTLOOK_MAIL_BODY_LIMIT)
      : decrypted.private.text
    const detail: OutlookMailMessageDetail = {
      ...mailSummary(decrypted),
      text: body,
      htmlAvailable: typeof decrypted.private.html === "string" && decrypted.private.html.length > 0,
      bodyTruncated: decrypted.private.text.length > OUTLOOK_MAIL_BODY_LIMIT,
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
