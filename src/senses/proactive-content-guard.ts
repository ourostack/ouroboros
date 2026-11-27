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
  | "routine_notice"

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

// A routine notice asks nothing of the person now and warns of nothing: it waits for their return summary.
const NO_ACTION_NOW_PATTERN = /\b(?:nothing (?:to do|needed|for you to do)|no action (?:is )?(?:needed|required)|nothing is needed|fyi|just so you know)\b/i
const FUTURE_GATE_PATTERN = /\b(?:nothing to do yet|nothing (?:is )?needed (?:from you )?yet|no action (?:is )?(?:needed|required) yet)\b/i
const FUTURE_GATE_LATER_PATTERN = /\b(?:when|once|after|later)\b[^.]*\b(?:i'll|i will|will)\b[^.]*\b(?:send|ask|prompt|text|message)\b/i
// Anything the person must know or act on now beats routine: a risk, a correction, a request, an update they asked for.
const MATERIAL_RISK_PATTERN = /\b(?:lost|lose|losing|data loss|outage|still (?:down|broken|failing)|is down|are down|went down|corrupt\w*|deleted|wiped|breach\w*|leak\w*|exposed|forced reboot|crash\w*|unrecoverable|at risk|urgent|failed to)\b/i
const CORRECTION_PATTERN = /\b(?:correction|i was wrong|i got that wrong|that was wrong|ignore (?:my )?(?:last|earlier|previous)|disregard|retract\w*|mistake|my earlier (?:message|note))\b/i
const PRESENT_ASK_PATTERN = /\b(?:please|can you|could you|would you|do you want|let me know|reply|need you to|need your|waiting (?:on|for) you|approve (?:it )?now|tap now|tap to approve|sign in now)\b/i

function getRoutineNoticeReason(text: string): ProactiveContentBlockReason | null {
  if (REQUESTED_STATUS_PATTERN.test(text) || MATERIAL_RISK_PATTERN.test(text) || CORRECTION_PATTERN.test(text)) return null
  if (FUTURE_GATE_PATTERN.test(text) && FUTURE_GATE_LATER_PATTERN.test(text)) return "routine_notice"
  if (NO_ACTION_NOW_PATTERN.test(text) && !PRESENT_ASK_PATTERN.test(text) && !/\?/.test(text)) return "routine_notice"
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
  return getUntestedClaimReason(text) ?? getRoutineNoticeReason(text)
}

/** A routine notice is kept for the person's return summary, not sent and not returned to the sender. */
export function isHeldForReturnReason(reason: ProactiveContentBlockReason | null | undefined): boolean {
  return reason === "routine_notice"
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
  if (reason === "routine_notice") {
    return "held, not sent (routine_notice): it asks nothing of them now and warns of nothing, so it is kept for the one summary they get when they next message. If it reports lost work, data loss or an outage, corrects an earlier message, or asks for something now, say so plainly and send it again"
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
