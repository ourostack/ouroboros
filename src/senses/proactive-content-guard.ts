import { emitNervesEvent } from "../nerves/runtime"

// ── Content block reasons ───────────────────────────────────────

export type ProactiveContentBlockReason =
  | "raw_meta_marker"
  | "legacy_private_runtime_reference"
  | "attention_queue_reference"
  | "return_obligation_reference"
  | "surfacing_mechanics_reference"
  | "prompt_reference"
  | "routing_reference"
  | "heartbeat_status"
  | "routine_verification_request"
  | "untested_delivery_claim"

// ── Patterns ────────────────────────────────────────────────────

const PROACTIVE_INTERNAL_CONTENT_PATTERNS: Array<{ reason: ProactiveContentBlockReason; pattern: RegExp }> = [
  // PR 447 patterns: raw meta markers
  { reason: "raw_meta_marker", pattern: /<\s*\/?\s*(think|analysis|commentary)\b[^>]*>/i },
  { reason: "raw_meta_marker", pattern: /\[\s*surfaced from inner dialog\s*\]/i },
  // Stale private-runtime vocabulary / attention / obligation references
  { reason: "legacy_private_runtime_reference", pattern: /\binner (dialog|dialogue)\b/i },
  { reason: "attention_queue_reference", pattern: /\battention queues?\b/i },
  { reason: "return_obligation_reference", pattern: /\b(return|held|heart|inner)\s+obligations?\b/i },
  // Surfacing mechanics
  { reason: "surfacing_mechanics_reference", pattern: /\b(surface tool|surfacing (mechanics|itself)|surfaced? outward|call `?surface`?|delegationId|delegation id)\b/i },
  // Prompt references
  { reason: "prompt_reference", pattern: /\b(system|developer|inner|tool|orientation)\s+prompts?\b|\bprompt\/orientation\b|\bprompt wording\b/i },
  // Routing references
  { reason: "routing_reference", pattern: /\b(routing target|reply target|route through surface|routed through surface|proactive bluebubbles delivery)\b/i },
  // Heartbeat / status patterns
  { reason: "heartbeat_status", pattern: /\bheartbeat\b/i },
  { reason: "heartbeat_status", pattern: /\bcheck-in\b/i },
  { reason: "heartbeat_status", pattern: /\btask board\b/i },
  { reason: "heartbeat_status", pattern: /\ball else settled\b/i },
  { reason: "heartbeat_status", pattern: /\bobligations?\s+showing\b/i },
  { reason: "heartbeat_status", pattern: /\bsame state\b/i },
]

// Asking the person to run a check an agent could run ("open X and tell me if it shows").
const ROUTINE_VERIFICATION_REQUEST_PATTERNS: RegExp[] = [
  /\b(?:could|can|would|will)\s+you\s+(?:please\s+)?(?:quickly\s+)?(?:open|check|look at|take a look at|test|try|verify|confirm)\b[^.?!]{0,160}\b(?:tell|let) me\b/i,
  /\b(?:please\s+)?(?:open|check|look at|test|try)\b[^.?!]{0,120}\b(?:and\s+)?(?:tell|let) me(?: know)? (?:if|whether)\b/i,
  /\b(?:tell|let) me(?: know)? (?:if|whether)\b[^.?!]{0,80}\b(?:show|shows|showing|load|loads|loading|work|works|render|renders|appear|appears)\b/i,
]

// Only the person can do these, so asking is not a chore an agent could take.
const USER_ONLY_BLOCKER_PATTERN =
  /\b(?:sign[- ]?in|log[- ]?in|mfa|2fa|passkey|password|one[- ]time code|verification code|payment|invoice|approve|approval|authori[sz]e|consent|irreversible|permanent(?:ly)?|plug(?:ged)? in|power[- ]cycle|press the)\b/i

// An untested result offered as the news.
const UNTESTED_CLAIM_PATTERNS: RegExp[] = [
  /\b(?:hasn'?t|has not|haven'?t|have not|not yet|never)\s+(?:been\s+)?(?:tested|verified|confirmed)\b/i,
  /\b(?:untested|unverified|not (?:yet )?(?:tested|verified|confirmed))\b/i,
]
const SHOULD_WORK_PATTERN = /\bshould (?:now )?(?:load|show|display|render|work|be (?:fixed|visible|working|showing))\b/i
const VERIFIED_BY_SENDER_PATTERN = /\b(?:i|we)(?:'ve| have)?\s+(?:verified|confirmed|tested|checked)\b|\bverified:/i
// The person asked for this update, so labelling it unverified is honest progress, not a delivery claim.
const REQUESTED_STATUS_PATTERN = /\b(?:as you asked|you asked (?:for|me)|you wanted (?:an )?update|status you asked)\b/i

function getVerificationHoldReason(text: string): ProactiveContentBlockReason | null {
  if (!USER_ONLY_BLOCKER_PATTERN.test(text) && ROUTINE_VERIFICATION_REQUEST_PATTERNS.some((p) => p.test(text))) {
    return "routine_verification_request"
  }
  if (REQUESTED_STATUS_PATTERN.test(text)) return null
  if (UNTESTED_CLAIM_PATTERNS.some((p) => p.test(text))) return "untested_delivery_claim"
  if (SHOULD_WORK_PATTERN.test(text) && !VERIFIED_BY_SENDER_PATTERN.test(text)) return "untested_delivery_claim"
  return null
}

// ── Public API ──────────────────────────────────────────────────

/**
 * The reason a proactive (off-turn) send must not reach the person, or null.
 * Replies inside a live turn never pass through here.
 */
export function getProactiveInternalContentBlockReason(text: string): ProactiveContentBlockReason | null {
  for (const { reason, pattern } of PROACTIVE_INTERNAL_CONTENT_PATTERNS) {
    if (pattern.test(text)) return reason
  }
  return getVerificationHoldReason(text)
}

export function isVerificationHoldReason(reason: ProactiveContentBlockReason | null | undefined): boolean {
  return reason === "routine_verification_request" || reason === "untested_delivery_claim"
}

/** What the sending lane is told when the guard refuses its text. */
export function proactiveContentBlockGuidance(reason: ProactiveContentBlockReason | null | undefined): string {
  if (isVerificationHoldReason(reason)) {
    return `held back, not sent (${reason}): do not ask them to run a routine check or report an untested result. Verify it yourself, then send the verified result with its proof, naming exactly what you verified (a mobile-web browser render is not proof for the native app). Only a step that needs them (sign-in, MFA, payment, contacting someone, an irreversible decision, a physical action) or a status update they asked for, labelled unverified ("as you asked"), may go to them unverified`
  }
  return `blocked: this reads as internal status${reason ? ` (${reason})` : ""}, so no chat sends it; rewrite it as plain words for them`
}

/**
 * A held pending message has no live sender, so the guidance goes back to the agent's own
 * private runtime, where its next wake reads it with the held text.
 */
export async function returnHeldProactiveMessage(params: {
  agentName: string
  friendId: string
  text: string
  reason: ProactiveContentBlockReason
}): Promise<void> {
  const { queuePendingMessage, getPrivateRuntimePendingDir, PRIVATE_RUNTIME_PENDING } = await import("../mind/pending")
  queuePendingMessage(getPrivateRuntimePendingDir(params.agentName), {
    from: params.agentName,
    ...PRIVATE_RUNTIME_PENDING,
    content: `A message you queued for friend ${params.friendId} was held back before it reached them. ${proactiveContentBlockGuidance(params.reason)}.\n\nHeld text:\n${params.text}`,
    timestamp: Date.now(),
    mode: "reflect",
  })
}

export function emitProactiveInternalContentBlocked(params: {
  friendId: string
  sessionKey?: string
  reason: ProactiveContentBlockReason
  source: "session_send" | "pending_drain"
  intent?: string
}): void {
  emitNervesEvent({
    level: "warn",
    component: "senses",
    event: "senses.proactive_internal_content_blocked",
    message: "proactive send blocked: internal content",
    meta: {
      friendId: params.friendId,
      source: params.source,
      reason: params.reason,
      ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
      ...(params.intent ? { intent: params.intent } : {}),
    },
  })
}
