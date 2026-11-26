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

// An untested result offered as the news.
const UNTESTED_CLAIM_PATTERNS: RegExp[] = [
  /\b(?:hasn'?t|has not|haven'?t|have not|not yet|never)\s+(?:been\s+)?(?:tested|verified|confirmed)\b/i,
  /\b(?:untested|unverified|not (?:yet )?(?:tested|verified|confirmed))\b/i,
]
const SHOULD_WORK_PATTERN = /\bshould (?:now )?(?:load|show|display|render|work|be (?:fixed|visible|working|showing))\b/i
const VERIFIED_BY_SENDER_PATTERN = /\b(?:i|we)(?:'ve| have)?\s+(?:verified|confirmed|tested|checked)\b|\bverified:/i
// The person asked for this update, so labelling it unverified is honest progress, not a delivery claim.
const REQUESTED_STATUS_PATTERN = /\b(?:as you asked|you asked (?:for|me)|you wanted (?:an )?update|status you asked)\b/i

function getUntestedClaimReason(text: string): ProactiveContentBlockReason | null {
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
  return getUntestedClaimReason(text)
}

/** Reasons the sender is told about, so it can verify the result itself. */
export function isReturnToSenderReason(reason: ProactiveContentBlockReason | null | undefined): boolean {
  return reason === "untested_delivery_claim"
}

/** What the sending lane is told when the guard refuses its text. */
export function proactiveContentBlockGuidance(reason: ProactiveContentBlockReason | null | undefined): string {
  if (reason === "untested_delivery_claim") {
    return "held back, not sent (untested_delivery_claim): do not report an untested result. Verify it yourself, then send the verified result with its proof, naming exactly what you verified (a mobile-web browser render is not proof for the native app). A status update they asked for may go unverified if it says so (\"as you asked\")"
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
