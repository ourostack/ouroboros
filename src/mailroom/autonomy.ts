import * as crypto from "node:crypto"
import { emitNervesEvent } from "../nerves/runtime"
import {
  normalizeMailAddress,
  type MailAutonomyDecision,
  type MailAutonomyDecisionCode,
  type MailAutonomyDecisionFallback,
  type MailAutonomyDecisionMode,
  type MailAutonomyPolicy,
  type MailDecisionActor,
  type MailOutboundRecord,
} from "./core"

export interface BuildNativeMailAutonomyPolicyInput {
  agentId: string
  mailboxAddress: string
  enabled: boolean
  killSwitch: boolean
  allowedRecipients?: string[]
  allowedDomains?: string[]
  maxRecipientsPerMessage: number
  rateLimit: {
    maxSends: number
    windowMs: number
  }
  actor?: MailDecisionActor
  reason?: string
  updatedAt?: string
}

export interface EvaluateNativeMailSendPolicyInput {
  policy: MailAutonomyPolicy
  draft: MailOutboundRecord
  recentOutbound: MailOutboundRecord[]
  now?: Date
}

export interface BuildConfirmedMailSendDecisionInput {
  draft: MailOutboundRecord
  policy?: MailAutonomyPolicy
  now?: Date
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`
  }
  return JSON.stringify(value) as string
}

function safeAddressPart(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
}

function normalizeDomain(value: string): string {
  return value.trim().toLowerCase().replace(/^@/, "")
}

function autonomyPolicyId(input: Omit<MailAutonomyPolicy, "schemaVersion" | "policyId">): string {
  return `mail_auto_${crypto.createHash("sha256").update(stableJson(input)).digest("hex").slice(0, 16)}`
}

function recipientsForDecision(record: Pick<MailOutboundRecord, "to" | "cc" | "bcc">): string[] {
  return [...record.to, ...record.cc, ...record.bcc].map(normalizeMailAddress)
}

function decision(input: Omit<MailAutonomyDecision, "schemaVersion">): MailAutonomyDecision {
  return { schemaVersion: 1, ...input }
}

function recipientDomain(recipient: string): string {
  return recipient.slice(recipient.indexOf("@") + 1).toLowerCase()
}

function isRecipientAllowed(policy: MailAutonomyPolicy, recipient: string): boolean {
  return policy.allowedRecipients.includes(recipient) || policy.allowedDomains.includes(recipientDomain(recipient))
}

function autonomousSentAt(record: MailOutboundRecord): string | null {
  if (record.sendMode !== "autonomous") return null
  return record.sentAt ?? record.submittedAt ?? record.acceptedAt ?? record.deliveredAt ?? record.failedAt ?? record.updatedAt
}

function countRecentAutonomousSends(input: {
  recentOutbound: MailOutboundRecord[]
  nowMs: number
  windowMs: number
}): number {
  const startsAt = input.nowMs - input.windowMs
  return input.recentOutbound.filter((record) => {
    const sentAt = autonomousSentAt(record)
    if (!sentAt) return false
    const sentMs = Date.parse(sentAt)
    return Number.isFinite(sentMs) && sentMs >= startsAt && sentMs <= input.nowMs
  }).length
}

export function buildNativeMailAutonomyPolicy(input: BuildNativeMailAutonomyPolicyInput): MailAutonomyPolicy {
  const normalized: Omit<MailAutonomyPolicy, "schemaVersion" | "policyId"> = {
    agentId: safeAddressPart(input.agentId) || "agent",
    mailboxAddress: normalizeMailAddress(input.mailboxAddress),
    enabled: input.enabled,
    killSwitch: input.killSwitch,
    allowedRecipients: [...new Set((input.allowedRecipients ?? []).map(normalizeMailAddress))].sort(),
    allowedDomains: [...new Set((input.allowedDomains ?? []).map(normalizeDomain).filter(Boolean))].sort(),
    maxRecipientsPerMessage: Math.max(1, Math.floor(input.maxRecipientsPerMessage)),
    rateLimit: {
      maxSends: Math.max(0, Math.floor(input.rateLimit.maxSends)),
      windowMs: Math.max(1, Math.floor(input.rateLimit.windowMs)),
    },
    ...(input.actor ? { actor: input.actor } : {}),
    ...(input.reason ? { reason: input.reason } : {}),
    ...(input.updatedAt ? { updatedAt: input.updatedAt } : {}),
  }
  const policy: MailAutonomyPolicy = {
    schemaVersion: 1,
    policyId: autonomyPolicyId(normalized),
    ...normalized,
  }
  emitNervesEvent({
    component: "senses",
    event: "senses.mail_native_autonomy_policy_built",
    message: "native mail autonomy policy built",
    meta: { agentId: policy.agentId, policyId: policy.policyId, enabled: policy.enabled, killSwitch: policy.killSwitch },
  })
  return policy
}

export function evaluateNativeMailSendPolicy(input: EvaluateNativeMailSendPolicyInput): MailAutonomyDecision {
  const now = input.now ?? new Date()
  const evaluatedAt = now.toISOString()
  const recipients = recipientsForDecision(input.draft)
  const policyId = input.policy.policyId
  const blocked = (
    code: MailAutonomyDecisionCode,
    reason: string,
    mode: MailAutonomyDecisionMode = "blocked",
    fallback: MailAutonomyDecisionFallback = "none",
  ) => decision({
    allowed: false,
    mode,
    code,
    reason,
    evaluatedAt,
    recipients,
    fallback,
    policyId,
  })

  if (input.draft.status !== "draft") {
    return blocked("draft-not-sendable", `Draft ${input.draft.id} is already ${input.draft.status}`)
  }
  if (input.draft.mailboxRole === "delegated-human-mailbox" || input.draft.ownerEmail || input.draft.source || input.draft.sendAuthority !== "agent-native") {
    return blocked("delegated-send-as-human-not-authorized", "Delegated human mail does not grant send-as-human authority")
  }
  if (safeAddressPart(input.draft.agentId) !== input.policy.agentId) {
    return blocked("agent-mismatch", `Draft belongs to ${input.draft.agentId}, not ${input.policy.agentId}`)
  }
  if (normalizeMailAddress(input.draft.from) !== input.policy.mailboxAddress) {
    return blocked("native-mailbox-mismatch", `${input.draft.from} is not the native mailbox ${input.policy.mailboxAddress}`)
  }
  if (!input.policy.enabled) {
    return blocked("autonomy-policy-disabled", "Autonomous native-agent mail policy is disabled", "confirmation-required", "CONFIRM_SEND")
  }
  if (input.policy.killSwitch) {
    return blocked("autonomy-kill-switch", "Autonomous native-agent mail kill switch is enabled", "confirmation-required", "CONFIRM_SEND")
  }
  if (recipients.length > input.policy.maxRecipientsPerMessage) {
    return blocked("recipient-limit-exceeded", `Autonomous native-agent mail is limited to ${input.policy.maxRecipientsPerMessage} recipient(s)`)
  }
  const unallowed = recipients.find((recipient) => !isRecipientAllowed(input.policy, recipient))
  if (unallowed) {
    return blocked(
      "recipient-not-allowed",
      `${unallowed} is not allowed for autonomous native-agent mail`,
      "confirmation-required",
      "CONFIRM_SEND",
    )
  }
  const recentCount = countRecentAutonomousSends({
    recentOutbound: input.recentOutbound,
    nowMs: now.getTime(),
    windowMs: input.policy.rateLimit.windowMs,
  })
  if (recentCount >= input.policy.rateLimit.maxSends) {
    return blocked("autonomous-rate-limit", "Autonomous native-agent mail rate limit is exhausted")
  }
  const allowed = decision({
    allowed: true,
    mode: "autonomous",
    code: "allowed",
    reason: "Autonomous native-agent mail policy allowed this send",
    evaluatedAt,
    recipients,
    fallback: "none",
    policyId,
    remainingSendsInWindow: Math.max(0, input.policy.rateLimit.maxSends - recentCount - 1),
  })
  emitNervesEvent({
    component: "senses",
    event: "senses.mail_native_autonomy_allowed",
    message: "native mail autonomy policy allowed send",
    meta: { agentId: input.policy.agentId, policyId, recipientCount: recipients.length },
  })
  return allowed
}

export function buildConfirmedMailSendDecision(input: BuildConfirmedMailSendDecisionInput): MailAutonomyDecision {
  const decisionValue = decision({
    allowed: true,
    mode: "confirmed",
    code: "explicit-confirmation",
    reason: "Explicit confirmation authorized this native-agent send",
    evaluatedAt: (input.now ?? new Date()).toISOString(),
    recipients: recipientsForDecision(input.draft),
    fallback: "none",
    ...(input.policy ? { policyId: input.policy.policyId } : {}),
  })
  emitNervesEvent({
    component: "senses",
    event: "senses.mail_native_send_confirmed",
    message: "native mail send confirmed",
    meta: {
      agentId: input.draft.agentId,
      recipientCount: decisionValue.recipients.length,
      ...(input.policy ? { policyId: input.policy.policyId } : {}),
    },
  })
  return decisionValue
}
