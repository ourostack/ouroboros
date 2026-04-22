import * as crypto from "node:crypto"
import { emitNervesEvent } from "../nerves/runtime"
import {
  normalizeMailAddress,
  resolveMailAddress,
  type MailAuthenticationSummary,
  type MailClassification,
  type MailDecisionAction,
  type MailDecisionActor,
  type MailDecisionRecord,
  type MailPlacement,
  type MailroomRegistry,
  type MailSenderPolicyAction,
  type MailSenderPolicyMatch,
  type MailSenderPolicyRecord,
  type MailSenderPolicyScope,
  type MailScreenerCandidate,
  type MailScreenerCandidateStatus,
  type ResolvedMailAddress,
} from "./core"
import type { MailroomStore } from "./file-store"

export type {
  MailAuthenticationSummary,
  MailDecisionAction,
  MailDecisionActor,
  MailDecisionRecord,
  MailSenderPolicyAction,
  MailSenderPolicyMatch,
  MailSenderPolicyRecord,
  MailSenderPolicyScope,
  MailScreenerCandidate,
  MailScreenerCandidateStatus,
}

export interface BuildSenderPolicyInput {
  agentId: string
  scope: MailSenderPolicyScope
  match: MailSenderPolicyMatch
  action: MailSenderPolicyAction
  actor: MailDecisionActor
  reason: string
  now?: Date
}

export interface ClassifyMailPlacementInput {
  registry: MailroomRegistry
  recipient: string
  sender: string
  authentication?: MailAuthenticationSummary
}

export interface ClassifyResolvedMailPlacementInput {
  registry: MailroomRegistry
  resolved: ResolvedMailAddress
  sender: string
  authentication?: MailAuthenticationSummary
}

export interface ApplyMailDecisionInput {
  store: MailroomStore
  agentId: string
  messageId: string
  action: MailDecisionAction
  actor: MailDecisionActor
  reason: string
  friendId?: string
  now?: Date
}

function stableJson(value: unknown): string {
  /* v8 ignore next -- current sender-policy IDs are built from object/scalar fields; array support is defensive. @preserve */
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`
  }
  return JSON.stringify(value)
}

function policyId(input: BuildSenderPolicyInput): string {
  return `policy_${crypto.createHash("sha256").update(stableJson({
    agentId: input.agentId.toLowerCase(),
    scope: input.scope,
    match: normalizeMatch(input.match),
    action: input.action,
    reason: input.reason,
  })).digest("hex").slice(0, 16)}`
}

function normalizeSender(sender: string): string | null {
  try {
    return normalizeMailAddress(sender)
  } catch {
    return null
  }
}

function senderDomain(sender: string | null): string | null {
  if (!sender) return null
  /* v8 ignore next -- normalizeMailAddress guarantees a domain for non-null senders. @preserve */
  return sender.split("@")[1]?.toLowerCase() ?? null
}

function normalizeMatch(match: MailSenderPolicyMatch): MailSenderPolicyMatch {
  if (match.kind === "email") return { kind: "email", value: normalizeMailAddress(match.value) }
  return { kind: match.kind, value: match.value.trim().toLowerCase() }
}

function authenticationFailed(authentication?: MailAuthenticationSummary): boolean {
  if (!authentication) return false
  return authentication.dmarc === "fail" || (
    authentication.spf === "fail" &&
    authentication.dkim === "fail"
  )
}

function scopeMatches(policy: MailSenderPolicyRecord, resolved: ResolvedMailAddress): boolean {
  if (policy.scope === "all") return true
  if (policy.scope === resolved.compartmentKind) return true
  if (policy.scope.startsWith("source:")) return resolved.source?.toLowerCase() === policy.scope.slice("source:".length)
  return false
}

function policyMatches(policy: MailSenderPolicyRecord, resolved: ResolvedMailAddress, sender: string | null): boolean {
  if (policy.agentId !== resolved.agentId || !scopeMatches(policy, resolved)) return false
  const match = normalizeMatch(policy.match)
  if (match.kind === "email") return sender === match.value
  if (match.kind === "domain") return senderDomain(sender) === match.value
  if (match.kind === "source") return resolved.source?.toLowerCase() === match.value
  return false
}

function classificationForPolicy(policy: MailSenderPolicyRecord): MailClassification {
  const placement: MailPlacement = policy.action === "allow"
    ? "imbox"
    : policy.action === "discard"
      ? "discarded"
      : "quarantine"
  return {
    placement,
    candidate: false,
    trustReason: `sender policy ${policy.action} ${policy.match.kind} ${normalizeMatch(policy.match).value}`,
  }
}

export function buildSenderPolicy(input: BuildSenderPolicyInput): MailSenderPolicyRecord {
  const policy: MailSenderPolicyRecord = {
    schemaVersion: 1,
    policyId: policyId(input),
    agentId: input.agentId.toLowerCase(),
    scope: input.scope,
    match: normalizeMatch(input.match),
    action: input.action,
    actor: input.actor,
    reason: input.reason,
    createdAt: (input.now ?? new Date()).toISOString(),
  }
  emitNervesEvent({
    component: "senses",
    event: "senses.mail_sender_policy_built",
    message: "mail sender policy built",
    meta: { agentId: policy.agentId, action: policy.action, scope: policy.scope, matchKind: policy.match.kind },
  })
  return policy
}

export function classifyResolvedMailPlacement(input: ClassifyResolvedMailPlacementInput): MailClassification {
  if (authenticationFailed(input.authentication)) {
    const classification: MailClassification = {
      placement: "quarantine",
      candidate: false,
      trustReason: "mail authentication failed",
      authentication: input.authentication,
    }
    emitNervesEvent({
      component: "senses",
      event: "senses.mail_classified",
      message: "mail classified by authentication failure",
      meta: { agentId: input.resolved.agentId, placement: classification.placement },
    })
    return classification
  }

  const sender = normalizeSender(input.sender)
  const policy = input.registry.senderPolicies?.find((entry) => policyMatches(entry, input.resolved, sender))
  if (policy) {
    const classification = classificationForPolicy(policy)
    emitNervesEvent({
      component: "senses",
      event: "senses.mail_classified",
      message: "mail classified by sender policy",
      meta: { agentId: input.resolved.agentId, placement: classification.placement, policyId: policy.policyId },
    })
    return classification
  }

  const placement = input.resolved.defaultPlacement
  const classification: MailClassification = {
    placement,
    candidate: placement === "screener",
    trustReason: input.resolved.compartmentKind === "delegated"
      ? `delegated source grant ${input.resolved.source ?? input.resolved.compartmentId}`
      : placement === "imbox"
        ? "screened-in native agent mailbox"
        : "native agent mailbox default screener",
    ...(input.authentication ? { authentication: input.authentication } : {}),
  }
  emitNervesEvent({
    component: "senses",
    event: "senses.mail_classified",
    message: "mail classified by default placement",
    meta: { agentId: input.resolved.agentId, placement: classification.placement, candidate: classification.candidate },
  })
  return classification
}

export function classifyMailPlacement(input: ClassifyMailPlacementInput): MailClassification {
  const resolved = resolveMailAddress(input.registry, input.recipient)
  if (!resolved) throw new Error(`Cannot classify unknown mail recipient ${input.recipient}`)
  return classifyResolvedMailPlacement({
    registry: input.registry,
    resolved,
    sender: input.sender,
    ...(input.authentication ? { authentication: input.authentication } : {}),
  })
}

function decisionPlacement(action: MailDecisionAction): MailPlacement {
  if (action === "discard") return "discarded"
  if (action === "quarantine") return "quarantine"
  return "imbox"
}

function candidateStatus(action: MailDecisionAction): MailScreenerCandidateStatus {
  if (action === "discard") return "discarded"
  if (action === "quarantine") return "quarantined"
  if (action === "restore") return "restored"
  return "allowed"
}

export async function listPendingScreenerCandidates(
  store: Pick<MailroomStore, "listScreenerCandidates">,
  agentId: string,
): Promise<MailScreenerCandidate[]> {
  const candidates = await store.listScreenerCandidates({ agentId, status: "pending" })
  emitNervesEvent({
    component: "senses",
    event: "senses.mail_pending_screener_candidates_listed",
    message: "pending mail screener candidates listed",
    meta: { agentId, count: candidates.length },
  })
  return candidates
}

export async function applyMailDecision(input: ApplyMailDecisionInput): Promise<MailDecisionRecord> {
  const message = await input.store.getMessage(input.messageId)
  if (!message || message.agentId !== input.agentId) {
    throw new Error(`No mail message ${input.messageId} for ${input.agentId}`)
  }
  const candidate = (await input.store.listScreenerCandidates({ agentId: input.agentId }))
    .find((entry) => entry.messageId === input.messageId)
  const nextPlacement = decisionPlacement(input.action)
  const decision = await input.store.recordMailDecision({
    agentId: input.agentId,
    messageId: input.messageId,
    ...(candidate ? { candidateId: candidate.id } : {}),
    action: input.action,
    actor: input.actor,
    reason: input.reason,
    previousPlacement: message.placement,
    nextPlacement,
    ...(candidate?.senderEmail ? { senderEmail: candidate.senderEmail } : {}),
    ...(input.friendId ? { friendId: input.friendId } : {}),
    ...(input.now ? { createdAt: input.now.toISOString() } : {}),
  })
  await input.store.updateMessagePlacement(input.messageId, nextPlacement)
  if (candidate) {
    await input.store.updateScreenerCandidate({
      ...candidate,
      placement: nextPlacement,
      status: candidateStatus(input.action),
      lastSeenAt: decision.createdAt,
      resolvedByDecisionId: decision.id,
    })
  }
  emitNervesEvent({
    component: "senses",
    event: "senses.mail_decision_applied",
    message: "mail decision applied",
    meta: { agentId: input.agentId, messageId: input.messageId, action: input.action, nextPlacement },
  })
  return decision
}
