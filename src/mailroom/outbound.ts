import * as crypto from "node:crypto"
import * as fs from "node:fs"
import * as path from "node:path"
import { emitNervesEvent } from "../nerves/runtime"
import {
  buildConfirmedMailSendDecision,
  evaluateNativeMailSendPolicy,
} from "./autonomy"
import {
  buildMailProviderSubmission,
  normalizeMailAddress,
  parseAcsEmailDeliveryReportEvent,
  reconcileMailDeliveryEvent,
  type MailAutonomyPolicy,
  type MailDecisionActor,
  type MailOutboundDeliveryEvent,
  type MailOutboundProvider,
  type MailOutboundRecord,
} from "./core"
import type { MailroomStore } from "./file-store"

export type MailOutboundTransport =
  | { kind: "local-sink"; sinkPath: string }
  | {
    kind: "azure-communication-services"
    endpoint: string
    senderAddress?: string
    credentialItem?: string
    credentialFields?: MailOutboundCredentialFields
  }

export interface MailOutboundCredentialFields {
  accessKey?: string
  connectionString?: string
}

export interface CreateMailDraftInput {
  store: MailroomStore
  agentId: string
  from: string
  to: string[]
  cc?: string[]
  bcc?: string[]
  subject: string
  text: string
  actor: MailDecisionActor
  reason: string
  now?: () => Date
}

export interface ConfirmMailDraftSendInput {
  store: MailroomStore
  agentId: string
  draftId: string
  transport: MailOutboundTransport
  confirmation: string
  actor: MailDecisionActor
  reason: string
  autonomous?: boolean
  autonomyPolicy?: MailAutonomyPolicy
  providerClient?: MailOutboundProviderClient
  now?: () => Date
}

export interface MailProviderSubmissionResult {
  provider: MailOutboundProvider
  providerMessageId: string
  submittedAt?: string
  operationLocation?: string
  providerRequestId?: string
}

export interface MailOutboundProviderSubmitInput {
  draft: MailOutboundRecord
  transport: Extract<MailOutboundTransport, { kind: "azure-communication-services" }>
  submittedAt: string
}

export interface MailOutboundProviderClient {
  submit(input: MailOutboundProviderSubmitInput): Promise<MailProviderSubmissionResult>
}

export interface CreateAcsEmailProviderClientInput {
  endpoint: string
  accessKey: string
  fetch?: typeof fetch
  now?: () => Date
}

export interface ReconcileOutboundDeliveryEventInput {
  store: MailroomStore
  agentId: string
  event: MailOutboundDeliveryEvent
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function textField(value: Record<string, unknown>, key: string): string {
  const raw = value[key]
  return typeof raw === "string" ? raw.trim() : ""
}

function credentialFields(value: unknown): MailOutboundCredentialFields | undefined {
  if (!isRecord(value)) return undefined
  const accessKey = textField(value, "accessKey")
  const connectionString = textField(value, "connectionString")
  const fields = {
    ...(accessKey ? { accessKey } : {}),
    ...(connectionString ? { connectionString } : {}),
  }
  return Object.keys(fields).length > 0 ? fields : undefined
}

function normalizeList(values: string[]): string[] {
  return values
    .map((value) => value.trim())
    .filter(Boolean)
    .map(normalizeMailAddress)
}

function contentHash(body: string): string {
  return crypto.createHash("sha256").update(body, "utf-8").digest("base64")
}

function hmacSignature(input: { method: string; pathAndQuery: string; date: string; host: string; contentHash: string; accessKey: string }): string {
  const stringToSign = `${input.method}\n${input.pathAndQuery}\n${input.date};${input.host};${input.contentHash}`
  return crypto.createHmac("sha256", Buffer.from(input.accessKey, "base64")).update(stringToSign, "utf-8").digest("base64")
}

function recipientObjects(addresses: string[]): Array<{ address: string }> {
  return addresses.map((address) => ({ address }))
}

function providerMessageIdFromOperationLocation(operationLocation: string): string {
  const match = operationLocation.match(/\/operations\/([^?/#]+)/)
  return match?.[1] ?? ""
}

export function createAcsEmailProviderClient(input: CreateAcsEmailProviderClientInput): MailOutboundProviderClient {
  const endpoint = input.endpoint.replace(/\/+$/, "")
  const fetchImpl = input.fetch ?? fetch
  return {
    async submit(submitInput) {
      const url = new URL(`${endpoint}/emails:send?api-version=2025-09-01`)
      const senderAddress = submitInput.transport.senderAddress ?? submitInput.draft.from
      const body = JSON.stringify({
        senderAddress,
        recipients: {
          to: recipientObjects(submitInput.draft.to),
          cc: recipientObjects(submitInput.draft.cc),
          bcc: recipientObjects(submitInput.draft.bcc),
        },
        content: {
          subject: submitInput.draft.subject,
          plainText: submitInput.draft.text,
        },
      })
      const date = (input.now ?? (() => new Date()))().toUTCString()
      const hash = contentHash(body)
      const signature = hmacSignature({
        method: "POST",
        pathAndQuery: `${url.pathname}${url.search}`,
        date,
        host: url.host,
        contentHash: hash,
        accessKey: input.accessKey,
      })
      const response = await fetchImpl(url.toString(), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-ms-date": date,
          "x-ms-content-sha256": hash,
          authorization: `HMAC-SHA256 SignedHeaders=x-ms-date;host;x-ms-content-sha256&Signature=${signature}`,
        },
        body,
      })
      const operationLocation = response.headers.get("operation-location") ?? undefined
      const providerRequestId = response.headers.get("x-ms-request-id") ?? undefined
      const payload = await response.json().catch(() => ({})) as { id?: unknown; status?: unknown; error?: { message?: unknown } }
      if (!response.ok) {
        const reason = typeof payload.error?.message === "string" ? payload.error.message : `HTTP ${response.status}`
        throw new Error(`ACS outbound send failed: ${reason}`)
      }
      const providerMessageId = typeof payload.id === "string"
        ? payload.id
        : operationLocation
          ? providerMessageIdFromOperationLocation(operationLocation)
          : ""
      if (!providerMessageId) throw new Error("ACS outbound send did not return an operation id")
      return {
        provider: "azure-communication-services",
        providerMessageId,
        ...(operationLocation ? { operationLocation } : {}),
        ...(providerRequestId ? { providerRequestId } : {}),
        submittedAt: submitInput.submittedAt,
      }
    },
  }
}

function draftId(): string {
  return `draft_${crypto.randomBytes(12).toString("hex")}`
}

function ensureRecipients(to: string[]): void {
  if (to.length === 0) throw new Error("at least one recipient is required")
}

export function resolveOutboundTransport(config: unknown): MailOutboundTransport {
  const outbound = isRecord(config) && isRecord(config.outbound) ? config.outbound : null
  if (!outbound) {
    throw new Error("outbound mail transport is not configured; human-required: set mailroom.outbound before confirmed sends")
  }
  const transport = textField(outbound, "transport")
  if (transport === "local-sink") {
    const sinkPath = textField(outbound, "sinkPath")
    if (!sinkPath) throw new Error("outbound local-sink transport is missing sinkPath")
    return { kind: "local-sink", sinkPath }
  }
  if (transport === "azure-communication-services") {
    if ("credentialItemNoteQuery" in outbound || "noteQuery" in outbound || "notes" in outbound) {
      throw new Error("outbound provider binding must not infer credentials from vault notes")
    }
    const endpoint = textField(outbound, "endpoint")
    if (!endpoint) throw new Error("outbound Azure Communication Services transport is missing endpoint")
    const senderAddress = textField(outbound, "senderAddress")
    const credentialItem = textField(outbound, "credentialItem")
    const fields = credentialFields(outbound.credentialFields)
    return {
      kind: "azure-communication-services",
      endpoint,
      ...(senderAddress ? { senderAddress } : {}),
      ...(credentialItem ? { credentialItem } : {}),
      ...(fields ? { credentialFields: fields } : {}),
    }
  }
  throw new Error("outbound mail transport is not configured; human-required: choose local-sink or azure-communication-services")
}

export async function createMailDraft(input: CreateMailDraftInput): Promise<MailOutboundRecord> {
  const now = (input.now ?? (() => new Date()))().toISOString()
  const to = normalizeList(input.to)
  ensureRecipients(to)
  const record: MailOutboundRecord = {
    schemaVersion: 1,
    id: draftId(),
    agentId: input.agentId,
    status: "draft",
    mailboxRole: "agent-native-mailbox",
    sendAuthority: "agent-native",
    ownerEmail: null,
    source: null,
    from: normalizeMailAddress(input.from),
    to,
    cc: normalizeList(input.cc ?? []),
    bcc: normalizeList(input.bcc ?? []),
    subject: input.subject.trim(),
    text: input.text,
    actor: input.actor,
    reason: input.reason,
    createdAt: now,
    updatedAt: now,
  }
  await input.store.upsertMailOutbound(record)
  emitNervesEvent({
    component: "senses",
    event: "senses.mail_draft_created",
    message: "mail draft created",
    meta: { agentId: record.agentId, id: record.id, toCount: record.to.length },
  })
  return record
}

function appendLocalSink(transport: Extract<MailOutboundTransport, { kind: "local-sink" }>, record: MailOutboundRecord, sentAt: string): string {
  fs.mkdirSync(path.dirname(transport.sinkPath), { recursive: true })
  const transportMessageId = `local_${crypto.randomBytes(10).toString("hex")}`
  fs.appendFileSync(transport.sinkPath, `${JSON.stringify({
    schemaVersion: 1,
    transportMessageId,
    draftId: record.id,
    agentId: record.agentId,
    from: record.from,
    to: record.to,
    cc: record.cc,
    bcc: record.bcc,
    subject: record.subject,
    text: record.text,
    sendMode: record.sendMode,
    policyId: record.policyDecision?.policyId ?? null,
    sentAt,
  })}\n`, "utf-8")
  return transportMessageId
}

function transportSend(transport: Extract<MailOutboundTransport, { kind: "local-sink" }>, record: MailOutboundRecord, sentAt: string): string {
  return appendLocalSink(transport, record, sentAt)
}

export async function confirmMailDraftSend(input: ConfirmMailDraftSendInput): Promise<MailOutboundRecord> {
  const draft = await input.store.getMailOutbound(input.draftId)
  if (!draft || draft.agentId !== input.agentId) throw new Error(`No draft found for ${input.draftId}`)
  if (draft.status !== "draft") throw new Error(`Draft ${input.draftId} is already ${draft.status}`)

  const sentAt = (input.now ?? (() => new Date()))().toISOString()
  const recentOutbound = await input.store.listMailOutbound(input.agentId)
  const policyDecision = input.autonomous
    ? (() => {
        if (!input.autonomyPolicy) {
          throw new Error("Autonomous mail sending requires an enabled native-agent policy")
        }
        const decision = evaluateNativeMailSendPolicy({
          policy: input.autonomyPolicy,
          draft,
          recentOutbound,
          now: new Date(sentAt),
        })
        if (!decision.allowed) {
          if (decision.mode === "confirmation-required") {
            throw new Error(`Autonomous mail send ${decision.code} requires confirmation=CONFIRM_SEND: ${decision.reason}`)
          }
          throw new Error(`${decision.code}: ${decision.reason}`)
        }
        return decision
      })()
    : (() => {
        if (input.confirmation !== "CONFIRM_SEND") {
          throw new Error("mail_send requires confirmation=CONFIRM_SEND before any outbound mail leaves the agent")
        }
        return buildConfirmedMailSendDecision({
          draft,
          policy: input.autonomyPolicy,
          now: new Date(sentAt),
        })
      })()
  const pendingSent: MailOutboundRecord = {
    ...draft,
    status: input.transport.kind === "local-sink" ? "sent" : "submitted",
    actor: input.actor,
    reason: input.reason,
    updatedAt: sentAt,
    sendMode: input.autonomous ? "autonomous" : "confirmed",
    policyDecision,
    sentAt,
  }
  if (input.transport.kind === "azure-communication-services") {
    if (!input.providerClient) {
      throw new Error("Azure Communication Services outbound send is configured but not enabled on this machine; human-required setup is still needed")
    }
    const submission = await input.providerClient.submit({
      draft: pendingSent,
      transport: input.transport,
      submittedAt: sentAt,
    })
    const submitted = {
      ...buildMailProviderSubmission({
        draft: pendingSent,
        provider: submission.provider,
        providerMessageId: submission.providerMessageId,
        submittedAt: submission.submittedAt ?? sentAt,
        ...(submission.operationLocation ? { operationLocation: submission.operationLocation } : {}),
        ...(submission.providerRequestId ? { providerRequestId: submission.providerRequestId } : {}),
      }),
      transport: input.transport.kind,
    }
    await input.store.upsertMailOutbound(submitted)
    emitNervesEvent({
      component: "senses",
      event: "senses.mail_draft_submitted",
      message: "mail draft submitted to outbound provider",
      meta: { agentId: submitted.agentId, id: submitted.id, provider: submitted.provider, providerMessageId: submitted.providerMessageId },
    })
    return submitted
  }
  const transportMessageId = transportSend(input.transport, pendingSent, sentAt)
  const sent: MailOutboundRecord = {
    ...pendingSent,
    transport: input.transport.kind,
    transportMessageId,
  }
  await input.store.upsertMailOutbound(sent)
  emitNervesEvent({
    component: "senses",
    event: "senses.mail_draft_sent",
    message: "mail draft sent",
    meta: { agentId: sent.agentId, id: sent.id, transport: sent.transport },
  })
  return sent
}

export function listMailOutboundRecords(store: MailroomStore, agentId: string): Promise<MailOutboundRecord[]> {
  return store.listMailOutbound(agentId)
}

export async function reconcileOutboundDeliveryEvent(input: ReconcileOutboundDeliveryEventInput): Promise<MailOutboundRecord> {
  const records = await input.store.listMailOutbound(input.agentId)
  const outbound = records.find((record) => record.providerMessageId === input.event.providerMessageId)
  if (!outbound) throw new Error(`No outbound record found for provider message ${input.event.providerMessageId}`)
  const updated = reconcileMailDeliveryEvent({ outbound, event: input.event })
  await input.store.upsertMailOutbound(updated)
  emitNervesEvent({
    component: "senses",
    event: "senses.mail_delivery_event_reconciled",
    message: "mail delivery event reconciled",
    meta: {
      agentId: updated.agentId,
      id: updated.id,
      provider: input.event.provider,
      providerEventId: input.event.providerEventId,
      outcome: input.event.outcome,
    },
  })
  return updated
}

export { parseAcsEmailDeliveryReportEvent }
