import type OpenAI from "openai";
import * as fs from "fs";
import { createHash } from "crypto";
import { canonicalizeTelegramSessionKey } from "../heart/config";
import { getAgentRoot, getAgentName } from "../heart/identity";
import { handleSurface, type SurfaceRouteResult } from "../senses/surface-tool";
import { advanceReturnObligation, findPendingObligationForOrigin, fulfillObligation } from "../arc/obligations";
import { completePonderPacket } from "../arc/packets";
import { listSessionActivity } from "../heart/session-activity";
import { containsInternalMetaMarkers } from "../senses/bluebubbles-meta-guard";
import { getProactiveInternalContentBlockReason, isReturnToSenderReason, proactiveContentBlockGuidance } from "../senses/proactive-content-guard";
import { emitNervesEvent } from "../nerves/runtime";
import * as path from "path";
import type { AttentionItem } from "../arc/attention-types";
import { placeTrustedFriendVoiceOutboundCall } from "../senses/voice/outbound";
import type { ToolDefinition, ToolDoorCard, VoiceCallAudioRequest } from "./tools-base";
import { withCode } from "./tool-error-code";

type SurfaceDeliveryChannel = "auto" | "voice" | "teams"

export interface SurfaceDeliveryHint {
  channel?: SurfaceDeliveryChannel
  phoneNumber?: string
  initialAudio?: VoiceCallAudioRequest
  /** Absolute path of a local image to send with the text on iMessage. */
  imagePath?: string
}

const IMAGE_ONLY_ON_OUTREACH = "an image goes only with spontaneous outreach to a person (friendId) on iMessage"

/** Why an image can't ride this delivery, or undefined when it can; nothing is sent when this returns a reason. */
export function surfaceImageRefusal(hint: SurfaceDeliveryHint | undefined, route: { heldThought: boolean }): string | undefined {
  if (!hint?.imagePath) return undefined
  if (!hint.imagePath.startsWith("/")) return withCode("imagePath must be an absolute path to an image.", "relative-path")
  if (hint.channel === "voice" || hint.channel === "teams" || route.heldThought) return withCode(`${IMAGE_ONLY_ON_OUTREACH}, not this delivery; nothing was sent. Send the text without imagePath.`, "image-unsupported")
  return undefined
}

/* v8 ignore start -- surface voice delivery hints are covered at the outbound voice bridge; this adapter only normalizes optional tool args @preserve */
function normalizeSurfaceDeliveryChannel(value: unknown): SurfaceDeliveryChannel {
  if (typeof value !== "string") return "auto"
  const normalized = value.trim().toLowerCase()
  return normalized === "voice" ? "voice" : normalized === "teams" ? "teams" : "auto"
}

function parseSurfaceVoiceInitialAudio(args: Record<string, string>): VoiceCallAudioRequest | undefined {
  const source = args.voiceAudioSource === "url" || args.voiceAudioSource === "file" || args.voiceAudioSource === "tone"
    ? args.voiceAudioSource
    : undefined
  const hasAudioHint = Boolean(
    source
    || args.voiceAudioUrl?.trim()
    || args.voiceAudioPath?.trim()
    || args.voiceAudioLabel?.trim()
    || args.voiceAudioToneHz?.trim()
    || args.voiceAudioDurationMs?.trim(),
  )
  if (!hasAudioHint) return undefined
  const toneHz = args.voiceAudioToneHz?.trim() ? Number(args.voiceAudioToneHz) : undefined
  const durationMs = args.voiceAudioDurationMs?.trim() ? Number(args.voiceAudioDurationMs) : undefined
  return {
    source: source ?? "tone",
    ...(args.voiceAudioUrl?.trim() ? { url: args.voiceAudioUrl.trim() } : {}),
    ...(args.voiceAudioPath?.trim() ? { path: args.voiceAudioPath.trim() } : {}),
    ...(args.voiceAudioLabel?.trim() ? { label: args.voiceAudioLabel.trim() } : {}),
    ...(Number.isFinite(toneHz) ? { toneHz } : {}),
    ...(Number.isFinite(durationMs) ? { durationMs } : {}),
  }
}
/* v8 ignore stop */

// Surface tool schema — canonical home. Handler lives in senses/surface-tool.ts.
export const surfaceToolDef: OpenAI.ChatCompletionFunctionTool = {
  type: "function",
  function: {
    name: "surface",
    description:
      "return a ready thought to a friend or active session; content carrying internal markers is refused. pass delegationId to address a held thought (see your attention queue above): it goes back to the session that asked. pass friendId for spontaneous outreach: to a person it sends now on their newest iMessage, Telegram or Teams chat active in the last 30 days, trying the next if one does not send, and skipping MCP, CLI and agent sessions, which they don't read; to an agent friend it goes to that agent's newest session. if a send fails partway it comes back unconfirmed: it may have reached them, so don't send it again. if none sends, it comes back deferred: not sent, saved for their next message, and the result says why and what else reaches them. set channel=voice only when you intentionally want a live phone call; content becomes the call reason/opening context. set channel=teams to tell a friend on Teams now (it sends at once where your Teams sense runs, otherwise waits in their Teams chat). does not end your turn. Ask a person only for what needs their body: a number or prompt to approve on their own phone, their card, an irreversible call that is theirs. Sign-ins (password from your vault), codes in their mail, prompts, terminals and machines are yours under standing authority; check a 'you need to sign in' claim (gh auth status) before passing it on.",
    parameters: {
      type: "object",
      properties: {
        content: {
          type: "string",
          description: "the message to deliver",
        },
        delegationId: {
          type: "string",
          description: "ID from your attention queue — addresses a specific held thought",
        },
        friendId: {
          type: "string",
          description: "friend to reach out to spontaneously (when not addressing a held thought); sends now on their newest active iMessage, Telegram or Teams chat, otherwise comes back deferred (not sent, saved)",
        },
        channel: {
          type: "string",
          enum: ["auto", "voice", "teams"],
          description: "optional delivery channel; use voice for a live phone call to a trusted friend, teams to reach them on Teams now, otherwise omit",
        },
        imagePath: {
          type: "string",
          description: "optional absolute path of a local image (png or jpg) to send with content on iMessage; only for spontaneous outreach (friendId) to a person. content becomes its caption. if the image can't go on iMessage, nothing is sent",
        },
        phoneNumber: {
          type: "string",
          description: "optional E.164 phone override for channel=voice when the trusted friend's record has no usable phone handle",
        },
        voiceAudioSource: {
          type: "string",
          enum: ["tone", "url", "file"],
          description: "optional initial non-speech audio to play after the opening greeting when channel=voice",
        },
        voiceAudioUrl: {
          type: "string",
          description: "short audio URL for voiceAudioSource=url",
        },
        voiceAudioPath: {
          type: "string",
          description: "local audio file path for voiceAudioSource=file",
        },
        voiceAudioLabel: {
          type: "string",
          description: "short label for the initial voice audio",
        },
        voiceAudioToneHz: {
          type: "number",
          description: "tone frequency for voiceAudioSource=tone",
        },
        voiceAudioDurationMs: {
          type: "number",
          description: "initial audio duration in milliseconds",
        },
      },
      required: ["content"],
    },
  },
}

/** A chat surface sends on unprompted is used only while the friend has been active in it this recently. */
export const SPONTANEOUS_OUTREACH_FRESH_DAYS = 30
const DAY_MS = 24 * 60 * 60 * 1000

/** The senses surface sends on at once when it reaches out to a friend unprompted, as a person would name them. */
const PUSH_CHANNEL_LABELS: Record<string, string> = { bluebubbles: "iMessage", telegram: "Telegram", teams: "Teams" }

interface OutreachSession { friendId: string; friendName?: string; channel: string; key: string; lastActivityMs: number }
/**
 * unconfirmed: the send failed partway, so it may have gone out; trying another chat or saving a copy could send it twice.
 * refused: the sense's content guard refused the text itself, so no other chat may carry it either.
 */
type OutreachAttempt =
  | { status: "delivered" | "forwarded" | "unconfirmed"; detail: string }
  | { status: "unsent"; why: string }
  | { status: "refused"; why: string; imageProblem?: boolean }
type OutreachSenders = Record<"bluebubbles" | "telegram" | "teams", (target: OutreachSession) => Promise<OutreachAttempt>>

/**
 * Spontaneous outreach: send now on the friend's chats that reach a person (iMessage, Telegram, Teams), newest first,
 * skipping group chats and chats quiet for more than SPONTANEOUS_OUTREACH_FRESH_DAYS, until one sends. It never
 * picks an MCP session (the next connecting agent would read it) or a CLI session (they see it only when they reopen
 * it). A send that failed partway stops the search, since it may have reached them, and so does a content guard's
 * refusal, since no other chat should carry that text. When none sends it returns the
 * detail for a deferred return: why, and a call only if the friend takes calls.
 */
export async function sendSpontaneousOutreach(
  friendId: string,
  sessions: OutreachSession[],
  senders: OutreachSenders,
  nowMs: number,
): Promise<{ sent: SurfaceRouteResult } | { unsentDetail: string }> {
  const isGroup = (session: OutreachSession): boolean => session.channel === "bluebubbles" && session.key.includes(";+;")
  const isPush = (session: OutreachSession): boolean => session.channel in PUSH_CHANNEL_LABELS && !isGroup(session)
  const quietDays = (session: OutreachSession): number => Math.floor((nowMs - session.lastActivityMs) / DAY_MS)
  const failures: string[] = []
  for (const target of sessions.filter((session) => isPush(session) && quietDays(session) < SPONTANEOUS_OUTREACH_FRESH_DAYS)) {
    let attempt: OutreachAttempt
    try {
      attempt = await senders[target.channel as keyof OutreachSenders](target)
    } catch (error) {
      attempt = { status: "unsent", why: error instanceof Error ? error.message : String(error) }
    }
    if (attempt.status === "refused" && attempt.imageProblem) {
      return { sent: { status: "failed", detail: withCode(`the image was not sent, so nothing was sent: ${attempt.why}. Fix the imagePath or send the text without it.`, "image-unsendable") } }
    }
    if (attempt.status === "refused") {
      const detail = `blocked: ${PUSH_CHANNEL_LABELS[target.channel]} refused this text as internal (${attempt.why}), so no chat sends it; rewrite it as plain words for them`
      return { sent: { status: "failed", detail: withCode(detail, "delivery-blocked") } }
    }
    if (attempt.status !== "unsent") return { sent: { status: attempt.status, detail: attempt.detail } }
    const failure = `${PUSH_CHANNEL_LABELS[target.channel]} did not send (${attempt.why})`
    if (!failures.includes(failure)) failures.push(failure)
  }
  const name = sessions.find((session) => session.friendName)?.friendName ?? friendId
  const lead = "not sent now; saved for their next message."
  if (sessions.length === 0) return { unsentDetail: `${lead} ${name} has no chat session with you yet.` }
  const kind = (session: OutreachSession): string => isGroup(session) ? "group" : isPush(session) && quietDays(session) >= SPONTANEOUS_OUTREACH_FRESH_DAYS ? "quiet" : "other"
  const label = (session: OutreachSession): string => kind(session) === "group"
    ? `${session.channel} group chat (skipped)`
    : kind(session) === "quiet" ? `${session.channel} quiet for ${quietDays(session)} days` : session.channel
  const theirs = sessions
    .filter((session, index) => sessions.findIndex((other) => other.channel === session.channel && kind(other) === kind(session)) === index)
    .map(label)
    .join(", ")
  const why = failures.length > 0
    ? `${failures.join("; ")}.`
    : `${name} has no chat that surface can send on, active in the last ${SPONTANEOUS_OUTREACH_FRESH_DAYS} days (their sessions: ${theirs}).`
  const call = sessions.some((session) => session.channel === "voice")
    ? ` Only if it is urgent: surface friendId="${friendId}" channel="voice" calls them.`
    : ""
  return { unsentDetail: `${lead} ${why}${call}` }
}

/** Send outcomes where a sense's guard refused the text itself, not the chat. */
const CONTENT_REFUSALS: ReadonlySet<string> = new Set(["internal_content_blocked", "blocked_meta_content"])
const unconfirmedDetail = (sense: string): string =>
  `the ${sense} send failed partway, so it may have reached them; don't resend unless they say they didn't get it`
const teamsForwardedDetail = (machine: string): string => `handed to ${machine}, which runs Teams; it sends on its next sync`
/** A Teams send_error may have gone out unless Teams said it was not sent. */
const teamsSendMayHaveGoneOut = (sent: { reason?: string; delivery?: { state: string } }): boolean =>
  sent.delivery?.state === "unknown" || (sent.reason === "send_error" && sent.delivery?.state !== "not_sent")

/** How each push sense sends one spontaneous message, and what its outcome means. */
export function spontaneousOutreachSenders(agentName: string, agentRoot: string, content: string, queueItem?: AttentionItem, imagePath?: string): OutreachSenders {
  const noImage = (sense: string): OutreachAttempt | undefined => imagePath ? { status: "unsent", why: `${sense} does not take an image from surface` } : undefined
  return {
    bluebubbles: async (target) => {
      const { sendProactiveBlueBubblesMessageToSession } = await import("../senses/bluebubbles")
      const sent = await sendProactiveBlueBubblesMessageToSession({ friendId: target.friendId, sessionKey: target.key, text: content, intent: "generic_outreach", origin: "proactive", ...(imagePath ? { imagePath } : {}) })
      if (sent.reason === "image_unsendable") return { status: "refused", why: sent.detail ?? "the image could not be sent", imageProblem: true }
      if (sent.delivered) return { status: "delivered", detail: "texted them by iMessage now" }
      if (sent.delivery?.state === "unknown") return { status: "unconfirmed", detail: unconfirmedDetail("iMessage") }
      if (sent.reason && CONTENT_REFUSALS.has(sent.reason)) return { status: "refused", why: sent.reason }
      return { status: "unsent", why: sent.reason ?? "not delivered" }
    },
    telegram: async (target) => {
      const skipped = noImage("Telegram")
      if (skipped) return skipped
      const telegramKey = canonicalizeTelegramSessionKey(target.key)
      const hash = createHash("sha256").update(`${target.friendId}\0${telegramKey}\0${content}`).digest("hex")
      const { sendTelegramAwaitFollowUp } = await import("../senses/telegram")
      const delivered = await sendTelegramAwaitFollowUp(agentName, {
        friendId: target.friendId,
        channel: "telegram",
        key: telegramKey,
        content,
        requestId: queueItem?.obligationId ?? `surface:${hash}`,
        deliveryId: queueItem?.obligationId ? `surface:${queueItem.obligationId}:${hash}` : `surface:${hash}`,
        intent: "generic_outreach",
      })
      if (delivered.status === "delivered_now") return { status: "delivered", detail: "sent to Telegram now" }
      if (delivered.status === "forwarded") return { status: "forwarded", detail: `handed to the machine that runs Telegram: ${delivered.detail}` }
      return { status: "unsent", why: delivered.detail ?? delivered.status }
    },
    teams: async (target) => {
      const skipped = noImage("Teams")
      if (skipped) return skipped
      const { sendTeamsOffTurn } = await import("../senses/teams-off-turn")
      const sent = await sendTeamsOffTurn({ friendId: target.friendId, key: target.key, text: content, origin: "proactive", captureReceipt: true }, { agentRoot })
      if (sent?.forwardedTo) return { status: "forwarded", detail: teamsForwardedDetail(sent.forwardedTo) }
      if (sent?.delivered) return { status: "delivered", detail: "sent to Teams now" }
      if (sent && teamsSendMayHaveGoneOut(sent)) return { status: "unconfirmed", detail: unconfirmedDetail("Teams") }
      if (sent?.reason && CONTENT_REFUSALS.has(sent.reason)) return { status: "refused", why: sent.reason }
      return { status: "unsent", why: sent?.reason ?? "not available here" }
    },
  }
}

// Surface tool handler: routes content to friend's freshest session
/**
 * Delivers content to a friend the way surface does: the held-work origin or a
 * bridge first, then for spontaneous outreach the friend's newest active iMessage,
 * Telegram or Teams chat that sends (see sendSpontaneousOutreach), and otherwise
 * a deferred return for their next message, saying it was not sent. Also used for
 * an ordinary agent's external-event owner message.
 */
export async function routeSurfaceToFriend(agentName: string, friendId: string, content: string, queueItem?: AttentionItem, hint?: SurfaceDeliveryHint): Promise<SurfaceRouteResult> {
  if (containsInternalMetaMarkers(content)) return { status: "failed", detail: "blocked: contains internal meta markers" }
  const imageRefusal = surfaceImageRefusal(hint, { heldThought: Boolean(queueItem) })
  if (imageRefusal) return { status: "failed", detail: imageRefusal }
  /* v8 ignore start -- routing: integration path tested via private-runtime routing tests @preserve */
  try {
    const agentRoot = getAgentRoot()
    const sessionsDir = path.join(agentRoot, "state", "sessions")
    const friendsDir = path.join(agentRoot, "friends")
    const queueToSession = async (target: { friendId: string; channel: string; key: string }, detail: string): Promise<SurfaceRouteResult> => {
      const { queuePendingMessage, getPendingDir } = await import("../mind/pending")
      const pendingDir = getPendingDir(agentName, target.friendId, target.channel, target.key)
      queuePendingMessage(pendingDir, {
        from: agentName,
        friendId: target.friendId,
        channel: target.channel,
        key: target.key,
        content,
        timestamp: Date.now(),
      })
      // A held BlueBubbles return deliberately waits for the friend's next
      // iMessage instead of live-sending one. Say so, so the agent never reads
      // "queued" as "sent".
      return target.channel === "bluebubbles"
        ? { status: "queued", detail: `${detail}; it waits for their next iMessage` }
        : { status: "queued", detail }
    }
    const deliverTelegramOrQueue = async (target: { friendId: string; channel: string; key: string }, detail: string): Promise<SurfaceRouteResult> => {
      const telegramKey = canonicalizeTelegramSessionKey(target.key)
      const hash = createHash("sha256").update(`${target.friendId}\0${telegramKey}\0${content}`).digest("hex")
      const requestId = queueItem?.obligationId ?? `surface:${hash}`
      const deliveryId = queueItem?.obligationId ? `surface:${queueItem.obligationId}:${hash}` : `surface:${hash}`
      const { sendTelegramAwaitFollowUp } = await import("../senses/telegram")
      const delivered = await sendTelegramAwaitFollowUp(agentName, {
        friendId: target.friendId,
        channel: "telegram",
        key: telegramKey,
        content,
        requestId,
        deliveryId,
        intent: "generic_outreach",
      })
      if (delivered.status === "delivered_now") return { status: "delivered", detail: "sent to Telegram now" }
      if (delivered.status === "forwarded") return { status: "forwarded", detail: `handed to the machine that runs Telegram: ${delivered.detail}` }
      return queueToSession(target, detail)
    }

    const deliverTeamsOrQueue = async (target: { friendId: string; channel: string; key: string }, detail: string): Promise<SurfaceRouteResult> => {
      const { sendTeamsOffTurn } = await import("../senses/teams-off-turn")
      const sent = await sendTeamsOffTurn({ friendId: target.friendId, key: target.key, text: content, origin: "proactive", captureReceipt: true }, { agentRoot })
      if (sent?.forwardedTo) return { status: "forwarded", detail: teamsForwardedDetail(sent.forwardedTo) }
      if (sent?.delivered) return { status: "delivered", detail: "sent to Teams now" }
      if (sent && teamsSendMayHaveGoneOut(sent)) return { status: "unconfirmed", detail: unconfirmedDetail("Teams") }
      if (sent?.reason && CONTENT_REFUSALS.has(sent.reason)) {
        const held = getProactiveInternalContentBlockReason(content)
        const detail = isReturnToSenderReason(held)
          ? proactiveContentBlockGuidance(held)
          : `blocked: Teams refused this text as internal (${sent.reason}); rewrite it as plain words for them`
        return { status: "failed", detail: withCode(detail, "delivery-blocked") }
      }
      return queueToSession(target, detail)
    }
    const deliverOrQueue = (target: { friendId: string; channel: string; key: string }, detail: string): Promise<SurfaceRouteResult> =>
      target.channel === "telegram"
        ? deliverTelegramOrQueue(target, detail)
        : target.channel === "teams"
          ? deliverTeamsOrQueue(target, detail)
          : queueToSession(target, detail)

    // Resolve friend name → UUID if needed (agents may pass name instead of UUID)
    let resolvedFriendId = friendId
    if (!fs.existsSync(path.join(sessionsDir, friendId))) {
      try {
        const friendFiles = fs.readdirSync(friendsDir).filter((f) => f.endsWith(".json"))
        for (const file of friendFiles) {
          const raw = fs.readFileSync(path.join(friendsDir, file), "utf-8")
          const record = JSON.parse(raw) as { id?: string; name?: string }
          if (record.name?.toLowerCase() === friendId.toLowerCase() && record.id) {
            resolvedFriendId = record.id
            break
          }
        }
      } catch { /* friends dir unreadable — continue with original friendId */ }
    }
    friendId = resolvedFriendId

    if (hint?.channel === "voice") {
      const voiceResult = await placeTrustedFriendVoiceOutboundCall({
        agentName,
        agentRoot,
        friendId,
        reason: content,
        phoneNumber: hint.phoneNumber,
        ...(hint.initialAudio ? { initialAudio: hint.initialAudio } : {}),
      })
      return voiceResult.status === "placed"
        ? { status: "delivered", detail: voiceResult.detail }
        : { status: "failed", detail: voiceResult.detail }
    }

    if (hint?.channel === "teams") {
      // The friend's latest Teams chat, else a new 1:1 the bot opens by their AAD id.
      const teamsSession = listSessionActivity({ sessionsDir, friendsDir, agentName, activeThresholdMs: Number.MAX_SAFE_INTEGER })
        .find((activity) => activity.friendId === friendId && activity.channel === "teams")
      return deliverTeamsOrQueue(teamsSession ?? { friendId, channel: "teams", key: "proactive" }, "for their next Teams message")
    }

    // Priority 1: Bridge-preferred session (if queue item has a bridgeId)
    if (queueItem?.bridgeId) {
      const { createBridgeManager } = await import("../heart/bridges/manager")
      const bridge = createBridgeManager().getBridge(queueItem.bridgeId)
      if (bridge && bridge.lifecycle !== "completed" && bridge.lifecycle !== "cancelled") {
        const allSessions = listSessionActivity({ sessionsDir, friendsDir, agentName, activeThresholdMs: Number.MAX_SAFE_INTEGER })
        const bridgeTarget = allSessions.find((activity) =>
          activity.friendId === friendId
          && activity.channel !== "inner"
          && bridge.attachedSessions.some((s) =>
            s.friendId === activity.friendId && s.channel === activity.channel && s.key === activity.key
          ),
        )
        if (bridgeTarget) {
          const detail = `for next interaction via ${bridgeTarget.channel}`
          return deliverOrQueue(bridgeTarget, detail)
        }
      }
    }

    // Priority 1.5: exact held-work origin.
    // A delegated return has a concrete reply address. Preserve that
    // address before considering fresher sessions for the same friend,
    // especially MCP sessions where check_response drains this path.
    if (queueItem?.channel && queueItem.key && queueItem.channel !== "inner") {
      const target = { friendId, channel: queueItem.channel, key: queueItem.key }
      const detail = `for originating ${queueItem.channel} session`
      return deliverOrQueue(target, detail)
    }

    const allFriendSessions = listSessionActivity({ sessionsDir, friendsDir, agentName, activeThresholdMs: Number.MAX_SAFE_INTEGER })
      .filter((s) => s.friendId === friendId && s.channel !== "inner")

    // Priority 2a: an agent friend reads its MCP or a2a session, so outreach to
    // it still goes to its freshest session.
    const friendKind = (() => {
      try {
        return (JSON.parse(fs.readFileSync(path.join(friendsDir, `${friendId}.json`), "utf-8")) as { kind?: string }).kind
      } catch {
        return undefined
      }
    })()
    if (friendKind === "agent" && allFriendSessions[0]) {
      if (hint?.imagePath) return { status: "failed", detail: withCode(`${IMAGE_ONLY_ON_OUTREACH}, not to an agent; nothing was sent. Send the text without imagePath.`, "image-unsupported") }
      return deliverOrQueue(allFriendSessions[0], `for next interaction via ${allFriendSessions[0].channel}`)
    }

    // Priority 2b: spontaneous outreach to a person sends now where it reaches
    // them, never into a session only agents read (MCP) or one they must reopen (CLI).
    // Text the senses' content guard refuses goes nowhere, whichever chat is newest.
    const contentBlock = getProactiveInternalContentBlockReason(content)
    if (contentBlock) {
      return { status: "failed", detail: withCode(proactiveContentBlockGuidance(contentBlock), "delivery-blocked") }
    }
    const outreach = await sendSpontaneousOutreach(friendId, allFriendSessions, spontaneousOutreachSenders(agentName, agentRoot, content, queueItem, hint?.imagePath), Date.now())
    if ("sent" in outreach) return outreach.sent

    // Priority 3: Deferred — nothing sent now; their next message picks it up.
    const { getDeferredReturnDir } = await import("../mind/pending")
    const { queuePendingMessage: queueDeferred } = await import("../mind/pending")
    const deferredDir = getDeferredReturnDir(agentName, friendId)
    queueDeferred(deferredDir, {
      from: agentName,
      friendId,
      channel: "deferred",
      key: "return",
      content,
      timestamp: Date.now(),
    })
    return { status: "deferred", detail: outreach.unsentDetail }
  } catch {
    return { status: "failed" }
  }
  /* v8 ignore stop */
}

/** surface's Ouro AX card, which its definition carries and `toolCards` lists for the census. */
const surfaceCard: ToolDoorCard = {
  id: "tool:surface",
  group: "turn-sessions",
  when: "Pick this to hand a finished thought back to whoever is waiting on it, by delegationId, or to reach out to a friend unprompted.",
  effect: "write",
  errors: [
    { code: "delivery-blocked", means: "The content carries internal meta markers, so nothing was delivered.", fix: "Rewrite the content as plain words for the person and surface it again." },
    { code: "orientation-hold", means: "This turn is on a correction hold, so surfacing waits.", fix: "Call orientation_get, settle what the person meant, then surface the thought if it still answers them." },
    { code: "relative-path", means: "imagePath didn't start with /, so nothing was sent.", fix: "Call again with the image's absolute path." },
    { code: "image-unsupported", means: "An image goes only with spontaneous outreach to a person on iMessage, so nothing was sent.", fix: "Send the text without imagePath." },
    { code: "image-unsendable", means: "The image could not be read or sent on iMessage, so nothing was sent.", fix: "Fix imagePath (an existing png or jpg under the size cap) and surface again." },
    { code: "surface-not-sent", means: "No chat sent the message now, so it is saved for the friend's next message; the result says why.", fix: "If it cannot wait and the result offers a call, call them; otherwise let it wait." },
  ],
}

/* v8 ignore start -- surface handler wiring: core logic tested via surface-tool.test.ts; this wires identity/routing deps @preserve */
export const surfaceToolDefinition: ToolDefinition = {
  tool: surfaceToolDef,
  ax: surfaceCard,
  handler: async (args, ctx) => {
    const rawContent = args.content ?? ""
    const deliveryHint: SurfaceDeliveryHint = {
      channel: normalizeSurfaceDeliveryChannel(args.channel),
      phoneNumber: typeof args.phoneNumber === "string" ? args.phoneNumber : undefined,
      initialAudio: parseSurfaceVoiceInitialAudio(args),
      imagePath: typeof args.imagePath === "string" && args.imagePath ? args.imagePath : undefined,
    }
    if (containsInternalMetaMarkers(rawContent)) {
      emitNervesEvent({
        level: "warn",
        component: "repertoire",
        event: "tools.surface_meta_blocked",
        message: "surface tool blocked: internal meta markers in content",
        meta: {
          hasDelegationId: Boolean(args.delegationId),
          hasFriendId: Boolean(args.friendId),
          contentLength: rawContent.length,
        },
      })
      return withCode("failed — blocked: contains internal meta markers", "delivery-blocked")
    }

    const queue = ctx?.delegatedOrigins ?? []
    const agentName = (() => { try { return getAgentName() } catch { return "unknown" } })()

    const routeToFriend = (friendId: string, content: string, queueItem?: AttentionItem, hint?: SurfaceDeliveryHint): Promise<SurfaceRouteResult> =>
      routeSurfaceToFriend(agentName, friendId, content, queueItem, hint)

    const surfaced = await handleSurface({
      content: args.content ?? "",
      delegationId: args.delegationId,
      friendId: args.friendId,
      deliveryHint: deliveryHint.channel !== "auto" || deliveryHint.phoneNumber || deliveryHint.imagePath ? deliveryHint : undefined,
      queue,
      routeToFriend,
      advanceObligation: (obligationId, update) => {
        /* v8 ignore start -- obligation advance: tested via attention-queue tests @preserve */
        try {
          const name = (() => { try { return getAgentName() } catch { return "unknown" } })()
          advanceReturnObligation(name, obligationId, {
            status: update.status as any,
            ...(update.returnedAt !== undefined ? { returnedAt: update.returnedAt } : {}),
            ...(update.returnTarget !== undefined ? { returnTarget: update.returnTarget as any } : {}),
          })
        } catch {
          // swallowed — obligation advance must never break surface delivery
        }
        /* v8 ignore stop */
      },
      completePonderPacket: (packetId) => {
        /* v8 ignore start -- packet completion: tested via surface-tool and arc packet unit tests @preserve */
        try {
          completePonderPacket(getAgentRoot(), packetId)
        } catch {
          // swallowed — packet completion must never break surface delivery
        }
        /* v8 ignore stop */
      },
      fulfillHeartObligation: (origin) => {
        /* v8 ignore start -- heart obligation fulfillment: tested via surface-tool.test.ts @preserve */
        try {
          const agentRoot = getAgentRoot()
          const heartObligation = findPendingObligationForOrigin(agentRoot, origin)
          if (heartObligation) {
            fulfillObligation(agentRoot, heartObligation.id)
          }
        } catch {
          // swallowed — heart obligation fulfillment must never break surface delivery
        }
        /* v8 ignore stop */
      },
      onRouteResult: ({ targetFriendId, queueItem, result }) => {
        ctx?.habitSession?.recordSurfaceAttempt?.({
          recipient: targetFriendId,
          channel: queueItem?.channel ?? args.channel ?? "surface",
          reason: result.status === "failed" ? "blocked" : "answer",
          // forwarded and unconfirmed most likely reach them; deferred and queued wait for their next message.
          result: result.status === "forwarded" || result.status === "unconfirmed" ? "sent" : result.status,
          rawStatus: result.status,
          ...(queueItem ? { routeKind: "originator" } : {}),
          ...(result.status === "failed" ? { error: result.detail ?? "surface route failed" } : {}),
        })
      },
    })
    // A deferred surface was not sent now, so it carries the code rest checks for.
    return surfaced.startsWith("deferred") ? withCode(surfaced, "surface-not-sent") : surfaced
  },
  summaryKeys: ["content", "delegationId", "friendId", "channel"],
  riskProfile: {
    mutates: ["durable_state_write", "external_side_effect"] as const,
    risk: "high",
    reason: "queues or delivers surfaced responses and may fulfill obligations",
  },
}

/** surface's Ouro AX card. The bare schema above is exported first, so the census reads the card from this list. */
export const toolCards: ToolDoorCard[] = [surfaceCard]
/* v8 ignore stop */
