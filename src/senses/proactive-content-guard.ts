import { execFileSync } from "child_process"
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
  | "not_theirs_to_do"
  | "false_sign_in_claim"
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

// ── Asks that aren't theirs ─────────────────────────────────────
// An ask reaches a person only when it names something only their body can do: approve a number or prompt on their own
// phone, pay with their card, or make an irreversible call that is theirs. The rest goes back to the sender.

// The sentence asks them to act: it opens with a command, or asks "can you", "please", "you need to".
const ASK_FRAME = /^\s*(?:[-*\u2022]\s*)?(?:\w+[:,]\s*)?(?:please\s+)?(?:run|type|press|paste|enter|sign|log|accept|make|open|check|click|restart|grab|copy|create|grant)\b|\b(?:(?:can|could|would|will) you|please|you(?:'ll)? (?:need|have) to|needs? you to|ask(?:ing)? you to|the (?:human|owner) (?:needs?|has) to)\b/i
// Keyboard and terminal work, codes in their mail, a sign-in or a setting: never theirs.
const AT_A_KEYBOARD: RegExp[] = [
  /\b(?:run|type|paste|enter)\s+(?:`[^`\n]+`|(?:gh|ouro|npm|npx|git|claude|brew|bw)\b)/i,
  /\b(?:in|from|at) (?:a|your|the) (?:terminal|shell|command line)\b/i,
  /\bpress(?:ing)? (?:\d+|enter|return|y(?:es)?|no?)\b|\bat the [^.?!\n]{0,30}\bprompt\b/i,
  /\b(?:paste|send|give|forward|tell|read|grab|copy)\b[^.?!\n]{0,40}\bcodes?\b(?!\s+review)/i,
  /(?:^\s*|\b(?:you(?:'ll)? (?:need|have) to|(?:can|could|would) you|please|needs? you to)\s+)(?:re-?)?(?:sign|log)\s*-?\s*(?:in|into|on)\b|\bre-?(?:auth(?:enticate)?|login)\b|\b(?:gh auth (?:login|refresh)|ouro up)\b/i,
  /\baccept\b[^.?!\n]{0,40}\b(?:agreement|terms|tos|eula|licen[cs]e)\b|\bmake\b[^.?!\n]{0,40}\b(?:public|private)\b/i,
  /\b(?:by hand|manually|system settings|full disk access)\b|\bgrant\b[^.?!\n]{0,30}\baccess\b/i,
  /\b(?:restart|relaunch|re-?run|rotate|click|merge)\b|\b(?:create|generate)\b[^.?!\n]{0,40}\b(?:token|api key)\b/i,
]
// A particular machine: theirs only when the sentence is about a phone approval or a payment.
const ON_A_MACHINE = /\b(?:in|on) (?:edge|chrome|safari|firefox|the browser|(?:the |your )?(?:mac(?: mini)?|macbook|laptop|desktop|computer)|[\w-]+-host)\b/i
// A check an agent can run, asked for in its own words ("open X and tell me if it shows").
const ROUTINE_CHECKS: RegExp[] = [
  /\b(?:open|check|look at|test|try|verify|confirm)\b[^.?!]{0,160}\b(?:tell|let) me\b(?![^.?!]*\bworks? for you\b)/i,
  /\b(?:tell|let) me(?: know)? (?:if|whether)\b[^.?!]{0,80}\b(?:show|shows|showing|load|loads|loading|works?(?! for you)|render|renders|appear|appears)\b/i,
  /\b(?:can|could) you (?:check|see|look at)\b[^.?!\n]{0,40}\b(?:whether|logs?)\b/i,
]
const BODY_ONLY = /\b(?:passkey|face id|touch id|github mobile|authenticator|(?:approve|tap|confirm)\b[^.?!\n]{0,40}\b(?:on|in) (?:your|their|his|her) (?:own )?phone|tap \d+|pay|payment|(?:your|their|his|her) card|irreversible|can'?t be undone|permanently)\b/i
// A sign-in ask whose claim the agent can check, and the command that checks it.
const SIGN_IN_CLAIMS: Array<{ ask: RegExp; command: string; args: string[] }> = [
  { ask: /\bgh auth (?:login|refresh)\b|\b(?:sign|log)\s*-?\s*(?:in|into)\s+(?:to\s+)?(?:gh|the github cli)\b/i, command: "gh", args: ["auth", "status"] },
]

/** The first sentence that asks them for something that isn't theirs to do, or null. */
function askNotTheirs(text: string): string | null {
  // Only they hold the vault's own unlock secret.
  return text.split(/(?<=[.?!])\s+|\n+/).find((sentence) => !/\bouro vault (?:unlock|create)\b/i.test(sentence) && (
    (ASK_FRAME.test(sentence) && AT_A_KEYBOARD.some((p) => p.test(sentence)))
    || (!BODY_ONLY.test(sentence) && ((ASK_FRAME.test(sentence) && ON_A_MACHINE.test(sentence)) || ROUTINE_CHECKS.some((p) => p.test(sentence))))
  )) ?? null
}

/** True when the sign-in the ask wants is already done, by the claim's own status command. */
function isSignInClaimFalse(ask: string): boolean {
  const claim = SIGN_IN_CLAIMS.find((c) => c.ask.test(ask))
  if (!claim) return false
  try {
    execFileSync(claim.command, claim.args, { stdio: "ignore", timeout: 5_000 })
    return true
  } catch {
    return false
  }
}

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
  const ask = askNotTheirs(text)
  if (ask) return isSignInClaimFalse(ask) ? "false_sign_in_claim" : "not_theirs_to_do"
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

/** Reasons the sender is told about, so it can do the work itself instead of asking. */
export function isReturnToSenderReason(reason: ProactiveContentBlockReason | null | undefined): boolean {
  return reason === "not_theirs_to_do" || reason === "false_sign_in_claim" || reason === "untested_delivery_claim"
}

/** What the sending lane is told when the guard refuses its text. */
export function proactiveContentBlockGuidance(reason: ProactiveContentBlockReason | null | undefined): string {
  if (reason === "not_theirs_to_do") {
    return "held back, not sent (not_theirs_to_do): do it yourself; you have standing authority. An ask reaches them only when their body must do it: approve a number or prompt on their own phone (2FA, GitHub Mobile, passkey), pay with their card, or an irreversible call that is theirs. Keyboard and terminal steps, anything on a particular machine, codes in their mail, sign-ins (the password is in your vault) and checks you can run are yours; when a sign-in ends in a phone prompt, send only the number to approve"
  }
  if (reason === "false_sign_in_claim") {
    return "dropped, not sent (false_sign_in_claim): its status command says that sign-in is already done (for gh, `gh auth status` passes), so there is nothing to ask them; retry what failed and read its real error"
  }
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
