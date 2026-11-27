import * as fs from "fs";
import * as path from "path";
import { createHash } from "crypto";
import { canonicalizeTelegramSessionKey, InvalidSessionPathError, isValidSessionCoordinate, resolveSessionPath } from "../heart/config";
import { getAgentRoot, getAgentName } from "../heart/identity";
import { productActiveWorkSections } from "../heart/product/active";
import { capStructuredRecordString } from "../heart/session-events";
import { emitNervesEvent } from "../nerves/runtime";
import { requestPrivateWake } from "../heart/daemon/socket-client";
import {
  derivePrivateRuntimeStatus,
  deriveInnerJob,
  getPrivateRuntimeSessionPath,
  readPrivateRuntimeRawData,
  readPrivateRuntimeStatus,
} from "../heart/daemon/thoughts";
import { createBridgeManager } from "../heart/bridges/manager";
import {
  summarizeSessionTail,
  type SessionTailOptions,
  type SessionTailResult,
} from "../heart/session-transcript";
import { listSessionActivity } from "../heart/session-activity";
import { buildActiveWorkFrame, formatActiveWorkFrame, type ActiveWorkFrame } from "../heart/active-work";
import { getCodingSessionManager, type CodingSessionStatus } from "./coding";
import { getPendingDir, getPrivateRuntimePendingDir } from "../mind/pending";
import type { PendingMessage } from "../mind/pending";
import { createReturnObligation, generateObligationId, createObligation, readPendingObligations } from "../arc/obligations";
import { buildProgressStory, renderProgressStory } from "../heart/progress-story";
import {
  readHabitSessionSummary,
  type HabitSessionSummary,
  type HabitSessionSummarySelector,
  type HabitSummaryWhich,
} from "../heart/habits/habit-session-summary";
import {
  deliverCrossChatMessage,
  type CrossChatDeliveryRequest,
  type CrossChatDeliveryResult,
  type CrossChatDirectDeliveryResult,
} from "../heart/cross-chat-delivery";
import type { ToolContext, ToolDefinition, VoiceCallAudioRequest } from "./tools-base";
import { withCode } from "./tool-error-code";
import { assertRelationshipToolOwner } from "./tool-arguments";
import { listVisibleBackgroundOperations } from "../heart/mail-import-discovery";
import { placeTrustedFriendVoiceOutboundCall } from "../senses/voice/outbound";

const NO_SESSION_FOUND_MESSAGE = "no session found for that friend/channel/key combination."
const EMPTY_SESSION_MESSAGE = "session exists but has no non-system messages."
const VALID_HABIT_SUMMARY_WHICH = new Set<HabitSummaryWhich>(["latest", "previous", "latest-success", "latest-failure"])

type SessionSummarySelectorValidation =
  | { ok: true; selector: HabitSessionSummarySelector }
  | { ok: false; code: "run_id_exclusive" | "selector_required" | "invalid_which"; message: string }

async function summarizeSessionTailSafely(options: SessionTailOptions): Promise<SessionTailResult | { kind: "missing" }> {
  try {
    return await summarizeSessionTail(options)
  } catch (error) {
    if (options.summarize) {
      emitNervesEvent({
        component: "daemon",
        event: "daemon.session_tail_summary_summary_fallback",
        message: "session tail summarization failed; using raw transcript",
        meta: {
          friendId: options.friendId,
          channel: options.channel,
          key: options.key,
          error: error instanceof Error ? error.message : String(error),
        },
      })
      try {
        return await summarizeSessionTail({
          ...options,
          summarize: undefined,
        })
      /* v8 ignore start -- defensive: session tail fallback @preserve */
      } catch {
        return { kind: "missing" }
      }
      /* v8 ignore stop */
    }
    return { kind: "missing" }
  }
}

function optionalArg(args: Record<string, unknown>, key: string): string | undefined | null {
  const value = args[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== "string") return null
  const trimmed = value.trim()
  return trimmed ? trimmed : undefined
}

function validateSessionSummarySelector(args: Record<string, unknown>): SessionSummarySelectorValidation {
  const runId = optionalArg(args, "runId")
  const habitName = optionalArg(args, "habitName")
  const operationId = optionalArg(args, "operationId")
  const which = optionalArg(args, "which")

  if (runId === null || habitName === null || operationId === null || which === null) {
    return {
      ok: false,
      code: which === null ? "invalid_which" : "selector_required",
      message: which === null
        ? "which must be latest, previous, latest-success, or latest-failure"
        : "selector fields must be strings",
    }
  }

  if (runId !== undefined) {
    if (habitName !== undefined || operationId !== undefined || which !== undefined) {
      return {
        ok: false,
        code: "run_id_exclusive",
        message: "runId cannot be combined with habitName, operationId, or which",
      }
    }
    return { ok: true, selector: { runId } }
  }

  if (habitName === undefined && operationId === undefined) {
    return {
      ok: false,
      code: "selector_required",
      message: "provide runId, habitName, or operationId",
    }
  }

  if (which !== undefined && !VALID_HABIT_SUMMARY_WHICH.has(which as HabitSummaryWhich)) {
    return {
      ok: false,
      code: "invalid_which",
      message: "which must be latest, previous, latest-success, or latest-failure",
    }
  }

  return {
    ok: true,
    selector: {
      ...(habitName !== undefined ? { habitName } : {}),
      ...(operationId !== undefined ? { operationId } : {}),
      ...(which !== undefined ? { which } : {}),
    },
  }
}

function renderSessionSummaryText(summary: HabitSessionSummary): string {
  const lines = [
    `habit ${summary.habitName} run ${summary.runId} finished with ${summary.status}.`,
    summary.operationId ? `operation: ${summary.operationId}` : null,
    summary.summary,
    summary.nextLikelyStep ? `next: ${summary.nextLikelyStep}` : null,
    summary.decisions.length > 0 ? `decisions: ${summary.decisions.join("; ")}` : null,
    summary.pending.count > 0 ? `pending: ${summary.pending.count} file(s) (${summary.pending.files.join(", ")})` : "pending: none",
    summary.messagesSent.length > 0 ? `messages: ${summary.messagesSent.length}` : "messages: none",
    summary.toolsUsed.length > 0 ? `tools: ${summary.toolsUsed.join(", ")}` : "tools: none",
    summary.errors.length > 0 ? `errors: ${summary.errors.join("; ")}` : null,
    summary.warnings.length > 0 ? `warnings: ${summary.warnings.join("; ")}` : null,
    `receipt: ${summary.sources.receipt}`,
    `session: ${summary.sources.session}`,
  ]
  return lines.filter((line): line is string => Boolean(line)).join("\n")
}

function writePendingEnvelope(queueDir: string, message: PendingMessage): string {
  fs.mkdirSync(queueDir, { recursive: true })
  const fileName = `${message.timestamp}-${Math.random().toString(36).slice(2, 10)}.json`
  const filePath = path.join(queueDir, fileName)
  fs.writeFileSync(filePath, JSON.stringify({ ...message, content: capStructuredRecordString(message.content) }, null, 2))
  return fileName.replace(/\.json$/, "")
}

function renderCrossChatDeliveryStatus(
  target: string,
  result: CrossChatDeliveryResult,
): string {
  const phase = result.status === "delivered_now"
    ? "completed"
    : result.status === "queued_for_later"
      ? "queued"
      : result.status === "blocked"
        ? "blocked"
        : "errored"
  const lead = result.status === "delivered_now"
    ? "delivered now"
    : result.status === "queued_for_later"
      ? "queued for later"
      : result.status === "blocked"
        ? "blocked"
        : "failed"

  const story = renderProgressStory(buildProgressStory({
    scope: "shared-work",
    phase,
    objective: `message to ${target}`,
    outcomeText: `${lead}\n${result.detail}`,
  }))
  if (result.status === "blocked") return withCode(story, "delivery-blocked")
  if (result.status === "failed") return withCode(story, "delivery-failed")
  return story
}

function normalizeHabitSendStatus(status: CrossChatDeliveryResult["status"]): "delivered_now" | "queued" | "blocked" | "failed" | "unavailable" {
  return status === "queued_for_later" ? "queued" : status
}

function recordHabitSendAttempt(ctx: ToolContext | undefined, args: { friendId: string; channel: string; key: string }, result: CrossChatDeliveryResult): void {
  ctx?.habitSession?.recordSurfaceAttempt?.({
    recipient: args.friendId,
    channel: args.channel,
    reason: result.status === "blocked" ? "blocked" : result.status === "failed" ? "other" : "status",
    result: normalizeHabitSendStatus(result.status),
    rawStatus: result.rawStatus ?? result.status,
    ...(result.status === "blocked" || result.status === "failed" ? { error: result.detail } : {}),
  })
}

async function deliverVoiceChannelMessage(
  request: CrossChatDeliveryRequest,
  agentName: string,
  initialAudio?: VoiceCallAudioRequest,
): Promise<CrossChatDirectDeliveryResult> {
  const result = await placeTrustedFriendVoiceOutboundCall({
    agentName,
    agentRoot: getAgentRoot(),
    friendId: request.friendId,
    reason: request.content,
    ...(initialAudio ? { initialAudio } : {}),
  })
  if (result.status === "placed") {
    return {
      status: "delivered_now",
      detail: result.detail,
    }
  }
  return {
    status: result.status,
    detail: result.detail,
  }
}

/* v8 ignore start -- voice initial-audio parsing is exercised by voice transport tests; session tool keeps a thin argument adapter @preserve */
function parseVoiceInitialAudio(args: Record<string, string>): VoiceCallAudioRequest | undefined {
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

function isLiveCodingSessionStatus(status: CodingSessionStatus): boolean {
  return status === "spawning"
    || status === "running"
    || status === "waiting_input"
    || status === "stalled"
}

function readActiveWorkInnerState(): ActiveWorkFrame["inner"] {
  const defaultJob = {
    status: "idle" as const,
    content: null,
    origin: null,
    mode: "reflect" as const,
    obligationStatus: null,
    surfacedResult: null,
    queuedAt: null,
    startedAt: null,
    surfacedAt: null,
  }
  try {
    const agentRoot = getAgentRoot()
    const pendingDir = getPrivateRuntimePendingDir(getAgentName())
    const sessionPath = getPrivateRuntimeSessionPath(agentRoot)
    const { pendingMessages, turns, runtimeState } = readPrivateRuntimeRawData(sessionPath, pendingDir)
    const dialogStatus = derivePrivateRuntimeStatus(pendingMessages, turns, runtimeState)
    const job = deriveInnerJob(pendingMessages, turns, runtimeState)
    const storeObligationPending = readPendingObligations(agentRoot).length > 0
    return {
      status: dialogStatus.processing === "started" ? "running" : "idle",
      hasPending: dialogStatus.queue !== "clear",
      origin: dialogStatus.origin,
      contentSnippet: dialogStatus.contentSnippet,
      obligationPending: dialogStatus.obligationPending || storeObligationPending,
      job,
    }
  } catch {
    return {
      status: "idle",
      hasPending: false,
      job: defaultJob,
    }
  }
}

async function buildToolActiveWorkFrame(ctx?: ToolContext): Promise<ActiveWorkFrame> {
  const currentSession = ctx?.currentSession
    ? {
        friendId: ctx.currentSession.friendId,
        channel: ctx.currentSession.channel as import("@ouro.bot/friends").Channel,
        key: ctx.currentSession.key,
        sessionPath: resolveSessionPath(ctx.currentSession.friendId, ctx.currentSession.channel, ctx.currentSession.key),
      }
    : null

  const agentRoot = getAgentRoot()
  const bridges = currentSession
    ? createBridgeManager().findBridgesForSession({
        friendId: currentSession.friendId,
        channel: currentSession.channel,
        key: currentSession.key,
      })
    : []

  let friendActivity = [] as ReturnType<typeof listSessionActivity>
  try {
    friendActivity = listSessionActivity({
      sessionsDir: `${agentRoot}/state/sessions`,
      friendsDir: `${agentRoot}/friends`,
      agentName: getAgentName(),
      currentSession,
    })
  } catch {
    friendActivity = []
  }

  const pendingObligations = (() => {
    try {
      return readPendingObligations(agentRoot)
    } catch {
      return []
    }
  })()

  let codingSessions = [] as ReturnType<ReturnType<typeof getCodingSessionManager>["listSessions"]>
  let otherCodingSessions = [] as ReturnType<ReturnType<typeof getCodingSessionManager>["listSessions"]>
  try {
    const liveCodingSessions = getCodingSessionManager()
      .listSessions()
      .filter((session) => isLiveCodingSessionStatus(session.status) && Boolean(session.originSession))
    if (currentSession) {
      codingSessions = liveCodingSessions.filter((session) =>
        session.originSession?.friendId === currentSession.friendId
        && session.originSession.channel === currentSession.channel
        && session.originSession.key === currentSession.key,
      )
      otherCodingSessions = liveCodingSessions.filter((session) =>
        !(
          session.originSession?.friendId === currentSession.friendId
          && session.originSession.channel === currentSession.channel
          && session.originSession.key === currentSession.key
        ),
      )
    } else {
      codingSessions = []
      otherCodingSessions = liveCodingSessions
    }
  } catch {
    codingSessions = []
    otherCodingSessions = []
  }

  const currentObligation = currentSession
    ? pendingObligations.find((obligation) =>
      obligation.status !== "fulfilled"
      && obligation.origin.friendId === currentSession.friendId
      && obligation.origin.channel === currentSession.channel
      && obligation.origin.key === currentSession.key,
    )?.content ?? null
    : null
  const backgroundOperations = listVisibleBackgroundOperations({
    agentName: getAgentName(),
    agentRoot,
    repoRoot: process.cwd(),
    homeDir: process.env.HOME,
    nowMs: Date.now(),
    limit: 5,
  })

  return buildActiveWorkFrame({
    currentSession,
    currentObligation,
    mustResolveBeforeHandoff: false,
    inner: readActiveWorkInnerState(),
    bridges,
    codingSessions,
    backgroundOperations,
    otherCodingSessions,
    pendingObligations,
    friendActivity,
    targetCandidates: [],
  })
}

function findDelegatingBridgeId(ctx?: ToolContext): string | undefined {
  const currentSession = ctx?.currentSession
  if (!currentSession) return undefined
  return ctx?.activeBridges?.find((bridge) =>
    bridge.lifecycle === "active"
    && bridge.attachedSessions.some((session) =>
      session.friendId === currentSession.friendId
      && session.channel === currentSession.channel
      && session.key === currentSession.key,
    ),
  )?.id
}

function sendMessageRiskProfile(args: Record<string, string>) {
  if (args.friendId?.trim() === "self") {
    return {
      mutates: "private_attention_write",
      risk: "high",
      reason: "queues private-runtime attention without contacting an external session",
    } as const
  }
  return {
    mutates: ["durable_state_write", "external_side_effect"],
    risk: "high",
    reason: "queues or delivers messages across sessions/channels",
  } as const
}

export function renderInnerProgressStatus(
  status: { queue: string; wake: string; processing: string; surfaced: string },
): string {
  if (status.processing === "pending") {
    return "i've queued this thought for private attention. it'll come up when my private runtime is free."
  }

  if (status.processing === "started") {
    return "i'm working through this privately right now."
  }

  // processed / completed
  if (status.surfaced && status.surfaced !== "nothing recent" && status.surfaced !== "no outward result") {
    return `i thought about this privately and came to something: ${status.surfaced}`
  }

  return "i thought about this privately. i'll bring it back when the time is right."
}

export const sessionToolDefinitions: ToolDefinition[] = [
  {
    tool: {
      type: "function",
      function: {
        name: "query_active_work",
        description: "read the current live world-state across visible sessions, coding lanes, private-runtime work, and return obligations. Sanctuary operational details support bounded section/offset/limit paging.",
        parameters: {
          type: "object",
          properties: {
            section: { type: "string", enum: ["all", "health", "policy", "awaits", "telegram", "events", "actions", "provider"], description: "Sanctuary detail section; defaults to all" },
            offset: { type: "string", description: "zero-based detail offset; defaults to 0" },
            limit: { type: "string", description: "detail rows per section, 1-20; defaults to 10" },
          },
        },
      },
    },
    handler: async (args, ctx) => {
      const frame = await buildToolActiveWorkFrame(ctx)
      const activeWork = `this is my current top-level live world-state.\nanswer whole-self status questions from this before drilling into individual sessions.\n\n${formatActiveWorkFrame(frame)}`
      const numeric = (value: string | undefined, fallback: number, min: number, max: number) => value === undefined ? fallback : /^\d+$/u.test(value) ? Math.min(max, Math.max(min, Number(value))) : fallback
      // The agent's product adds its own sections, such as the Butler's house and Telegram status.
      const sections = await productActiveWorkSections({
        agentName: getAgentName(), section: args.section,
        offset: numeric(args.offset, 0, 0, 10_000), limit: numeric(args.limit, 10, 1, 20),
      })
      return sections === null ? activeWork : `${activeWork}\n\n${sections}`
    },
    riskProfile: { mutates: "none", risk: "low" },
    ax: { id: "tool:query_active_work", group: "turn-sessions", when: "Pick this first for any whole-self status question, to see every live session, coding lane and owed return at once.", effect: "read", idempotent: true, errors: [
      { code: "invalid-arguments", means: "section isn't one of the listed sections, or offset or limit isn't text.", fix: "Pass section as all, health, policy, awaits, telegram, events, actions or provider." },
    ] },
  },
  {
    tool: {
      type: "function",
      function: {
        name: "session_summary",
        description: "read-only orientation for habit runs. returns a structured live summary from habit receipts, session files, pending dirs, and runtime cursors without writing state.",
        parameters: {
          type: "object",
          properties: {
            runId: { type: "string", description: "exact habit run id; cannot be combined with habitName, operationId, or which" },
            habitName: { type: "string", description: "habit name to select from" },
            operationId: { type: "string", description: "operation id for stateful habit run groups, such as habit:heartbeat" },
            which: {
              type: "string",
              enum: ["latest", "previous", "latest-success", "latest-failure"],
              description: "which matching run to read; defaults to latest",
            },
          },
        },
      },
    },
    handler: (args, ctx) => {
      const validation = validateSessionSummarySelector(args)
      if (!validation.ok) {
        return JSON.stringify({
          kind: "invalid_selector",
          code: validation.code,
          message: validation.message,
        }, null, 2)
      }
      assertRelationshipToolOwner(ctx)
      const summary = readHabitSessionSummary(ctx?.agentRoot ?? getAgentRoot(ctx?.agentName), validation.selector)
      if (!summary) {
        return JSON.stringify({
          kind: "not_found",
          message: "no habit run matched selector",
          selector: validation.selector,
        }, null, 2)
      }
      return JSON.stringify({
        kind: "habit_session_summary",
        text: renderSessionSummaryText(summary),
        summary,
      }, null, 2)
    },
    riskProfile: {
      mutates: "none",
      risk: "low",
      reason: "reads habit run summaries from local receipts and session artifacts",
    },
    summaryKeys: ["runId", "habitName", "operationId", "which"],
    ax: { id: "tool:session_summary", group: "turn-sessions", when: "Pick this to learn how a habit run went, by exact runId or by habit name and which run, without opening session files.", effect: "read", idempotent: true, errors: [
      { code: "invalid-arguments", means: "A selector isn't text or which isn't allowed; runId mixed with other selectors comes back as invalid_selector JSON.", fix: "Pass runId alone, or habitName or operationId with an optional which such as latest." },
    ] },
  },
  {
    tool: {
      type: "function",
      function: {
        name: "query_session",
        description: "inspect another session. use transcript for recent context or status for self/private-runtime progress. mode=search is deprecated: use search_facts, consult_diary, or consult_notes instead.",
        parameters: {
          type: "object",
          properties: {
            friendId: { type: "string", description: "the friend UUID (or 'self')" },
            channel: { type: "string", description: "the channel: cli, teams, bluebubbles, voice, mcp, or legacy inner for private-runtime compatibility" },
            key: { type: "string", description: "session key (defaults to 'session')" },
            messageCount: { type: "string", description: "how many recent messages to return (default 20)" },
            mode: {
              type: "string",
              enum: ["transcript", "status", "search"],
              description: "transcript (default), status (self/private-runtime), or deprecated search",
            },
            query: { type: "string", description: "deprecated; only read with mode=search" },
          },
          required: ["friendId", "channel"],
        },
      },
    },
    handler: async (args, ctx) => {
      let friendId = args.friendId
      const channel = args.channel
      const key = args.key || "session"
      const count = parseInt(args.messageCount || "20", 10)
      const mode = args.mode || "transcript"

      if (!isValidSessionCoordinate(friendId) || !isValidSessionCoordinate(channel)) {
        emitNervesEvent({
          level: "warn", component: "tools", event: "tool.session_path_rejected",
          message: "session query rejected invalid coordinates", meta: { reason: "invalid friend or channel" },
        })
        return withCode(NO_SESSION_FOUND_MESSAGE, "session-not-found")
      }

      assertRelationshipToolOwner(ctx)
      // Resolve friend name -> UUID if not already a UUID or "self"
      if (friendId && friendId !== "self" && !/^[0-9a-f]{8}-[0-9a-f]{4}-/.test(friendId) && ctx?.friendStore?.listAll) {
        const allFriends = await ctx.friendStore.listAll()
        const match = allFriends.find(f => f.name.toLowerCase() === friendId.toLowerCase())
        if (match) {
          friendId = match.id
        }
      }

      if (mode === "status") {
        if (friendId !== "self" || channel !== "inner") {
          return withCode("status mode is only available for self/private runtime.", "status-self-only")
        }

        const agentRoot = ctx?.agentRoot ?? getAgentRoot(ctx?.agentName)
        const sessionPath = getPrivateRuntimeSessionPath(agentRoot)
        const pendingDir = getPrivateRuntimePendingDir(ctx?.agentName ?? getAgentName(), agentRoot)
        return renderInnerProgressStatus(readPrivateRuntimeStatus(sessionPath, pendingDir))
      }

      if (mode === "search") {
        return JSON.stringify({
          kind: "deprecated",
          message: "query_session mode=search is no longer available; use search_facts, consult_diary, or consult_notes instead.",
          removalCycle: "alpha.616",
        })
      }

      let sessFile: string
      try {
        sessFile = resolveSessionPath(friendId, channel, key, {
          agentRoot: ctx?.agentRoot ?? getAgentRoot(ctx?.agentName), confined: true,
        })
      } catch (error) {
        if (!(error instanceof InvalidSessionPathError)) throw error
        emitNervesEvent({
          level: "warn", component: "tools", event: "tool.session_path_rejected",
          message: "session query rejected an unconfined path", meta: { reason: error.message },
        })
        return withCode(NO_SESSION_FOUND_MESSAGE, "session-not-found")
      }
      const sessionTail = await summarizeSessionTailSafely({
        sessionPath: sessFile,
        friendId,
        channel,
        key,
        messageCount: count,
        trustLevel: ctx?.context?.friend?.trustLevel,
        summarize: ctx?.summarize,
      })

      if (sessionTail.kind === "missing") {
        return withCode(NO_SESSION_FOUND_MESSAGE, "session-not-found")
      }
      if (sessionTail.kind === "empty") {
        return EMPTY_SESSION_MESSAGE
      }

      return sessionTail.summary
    },
    riskProfile: { mutates: "none", risk: "low" },
    ax: { id: "tool:query_session", group: "turn-sessions", when: "Pick this to read the recent transcript of another chat by friend and channel, or your private runtime's progress with status mode.", effect: "read", idempotent: true, errors: [
      { code: "session-not-found", means: "No session exists for that friend, channel and key, or the coordinates aren't valid.", fix: "Check the friend's id with friend_list and the channel name, and leave key out unless you know it." },
      { code: "status-self-only", means: "mode status works only for friendId self on channel inner.", fix: "Use mode transcript for other chats, or friendId self with channel inner for status." },
    ] },
  },
  {
    tool: {
      type: "function",
      function: {
        name: "send_message",
        description: "send a message to a friend's session. Delivers at once when authorized from a trusted live chat; otherwise reports queued, blocked or failed. For user-requested private-return work use ponder, not friendId=self. Ask a person only for what needs their body: a number or prompt to approve on their own phone, their card, an irreversible call that is theirs. Sign-ins (password from your vault), codes in their mail, prompts, terminals and machines are yours under standing authority; check a 'you need to sign in' claim (gh auth status) before passing it on. Ask for what they can reach where it lands: iMessage or Telegram is their phone (tap, pay, decide; no terminal or desktop browser); Teams may be either, so assume phone; CLI is a keyboard on this machine; MCP may be an agent acting for them.",
        parameters: {
          type: "object",
          properties: {
            friendId: { type: "string", description: "the friend UUID (or 'self')" },
            channel: { type: "string", description: "cli, teams, bluebubbles, voice (starts a live phone call to a trusted friend), mcp, or legacy inner" },
            key: { type: "string", description: "session key (defaults to 'session')" },
            content: { type: "string", description: "the message content to send" },
            voiceAudioSource: { type: "string", enum: ["tone", "url", "file"], description: "voice only: non-speech audio after the greeting" },
            voiceAudioUrl: { type: "string", description: "for url" },
            voiceAudioPath: { type: "string", description: "for file" },
            voiceAudioLabel: { type: "string", description: "label" },
            voiceAudioToneHz: { type: "number", description: "for tone" },
            voiceAudioDurationMs: { type: "number", description: "milliseconds" },
          },
          required: ["friendId", "channel", "content"],
        },
      },
    },
    handler: async (args, ctx) => {
      let friendId = args.friendId
      const channel = args.channel
      const key = args.key || "session"
      const content = args.content
      const voiceInitialAudio = channel === "voice" ? parseVoiceInitialAudio(args) : undefined
      const now = Date.now()
      const agentName = getAgentName()

      // Resolve friend name → UUID if needed
      /* v8 ignore start -- name resolution: reads real filesystem, tested via live integration @preserve */
      if (friendId !== "self") {
        const originalFriendId = friendId
        try {
          const agentRoot = getAgentRoot()
          const sessionsDir = path.join(agentRoot, "state", "sessions")
          const friendsDir = path.join(agentRoot, "friends")
          const sessionDirExists = fs.existsSync(path.join(sessionsDir, friendId))
          if (!sessionDirExists) {
            const friendFiles = fs.readdirSync(friendsDir).filter((f) => f.endsWith(".json"))
            for (const file of friendFiles) {
              const raw = fs.readFileSync(path.join(friendsDir, file), "utf-8")
              const record = JSON.parse(raw) as { id?: string; name?: string }
              if (record.name?.toLowerCase() === friendId.toLowerCase() && record.id) {
                friendId = record.id
                break
              }
            }
            emitNervesEvent({
              component: "repertoire",
              event: "repertoire.send_message_name_resolve",
              message: friendId !== originalFriendId ? "resolved friend name to UUID" : "friend name resolution failed",
              meta: { original: originalFriendId, resolved: friendId, friendsDir, fileCount: friendFiles.length },
            })
          }
        } catch (err) {
          emitNervesEvent({
            level: "warn",
            component: "repertoire",
            event: "repertoire.send_message_name_resolve_error",
            message: "friend name resolution threw",
            meta: { friendId: originalFriendId, error: err instanceof Error ? err.message : String(err) },
          })
        }
      }
      /* v8 ignore stop */

      // Self-routing: messages to "self" always go to the private-runtime pending dir,
      // regardless of the channel or key the agent specified.
      const isSelf = friendId === "self"
      const pendingDir = isSelf
        ? getPrivateRuntimePendingDir(agentName)
        : getPendingDir(agentName, friendId, channel, key)
      const delegatingBridgeId = findDelegatingBridgeId(ctx)
      const delegatedFrom = isSelf
        && ctx?.currentSession
        && !(ctx.currentSession.friendId === "self" && ctx.currentSession.channel === "inner")
        ? {
            friendId: ctx.currentSession.friendId,
            channel: ctx.currentSession.channel,
            key: ctx.currentSession.key,
            ...(delegatingBridgeId ? { bridgeId: delegatingBridgeId } : {}),
          }
        : undefined
      const obligationId = delegatedFrom ? generateObligationId(now) : undefined
      const envelope: PendingMessage = {
        from: agentName,
        friendId,
        channel,
        key,
        content,
        timestamp: now,
        ...(delegatedFrom ? { delegatedFrom, obligationStatus: "pending" as const } : {}),
        ...(obligationId ? { obligationId } : {}),
      }

      if (isSelf) {
        const pendingMessageId = writePendingEnvelope(pendingDir, envelope)
        if (delegatedFrom) {
          try {
            createObligation(getAgentRoot(), {
              origin: {
                friendId: delegatedFrom.friendId,
                channel: delegatedFrom.channel,
                key: delegatedFrom.key,
              },
              ...(delegatedFrom.bridgeId ? { bridgeId: delegatedFrom.bridgeId } : {}),
              content,
            })
          } catch {
            /* v8 ignore next -- defensive: obligation store write failure should not break send_message @preserve */
          }
          /* v8 ignore next -- obligationId always set when delegatedFrom is set (see generateObligationId above) @preserve */
          if (obligationId) {
            createReturnObligation(agentName, {
              id: obligationId,
              origin: delegatedFrom,
              status: "queued",
              delegatedContent: content.length > 120 ? `${content.slice(0, 117)}...` : content,
              createdAt: now,
            })
          }
          emitNervesEvent({
            event: "repertoire.obligation_created",
            component: "repertoire",
            message: "obligation created for private-runtime delegation",
            meta: {
              friendId: delegatedFrom.friendId,
              channel: delegatedFrom.channel,
              key: delegatedFrom.key,
            },
          })
        }
        try {
          await requestPrivateWake(agentName, ctx?.daemonSocketPath, {
            reason: "send_message self-route private attention",
            triggerSource: "send-message-self-route",
            budgetClass: "interactive",
            idempotencyKey: `send-message-self-route:${agentName}:${pendingMessageId}`,
            originRefs: [
              { kind: "tool", id: "send_message" },
              { kind: "pending-queue", id: "self/inner/dialog" },
              { kind: "pending-message", id: pendingMessageId },
            ],
          })
        } catch {
          // Queue-first self routing must not inline-run private work when the daemon is unavailable.
        }

        return renderInnerProgressStatus({
          queue: "queued to private runtime",
          wake: "daemon requested",
          processing: "pending",
          surfaced: "nothing yet",
        })
      }

      // Resolve BB session key if using default — agents don't know the real session key
      /* v8 ignore start -- BB session key resolution: reads real filesystem @preserve */
      let resolvedKey = key
      if (channel === "bluebubbles" && key === "session") {
        try {
          const agentRoot = getAgentRoot()
          const bbDir = path.join(agentRoot, "state", "sessions", friendId, "bluebubbles")
          if (fs.existsSync(bbDir)) {
            const files = fs.readdirSync(bbDir).filter((f) => f.endsWith(".json"))
            // Only use DM sessions (;-;) for proactive delivery — never group chats (;+;)
            const dmFile = files.find((f) => f.includes(";-;"))
            if (dmFile) {
              resolvedKey = dmFile.replace(/\.json$/, "")
            }
          }
        } catch { /* continue with default key */ }
      }
      /* v8 ignore stop */

      const deliveryResult = await deliverCrossChatMessage({
        friendId,
        channel,
        key: resolvedKey,
        content,
        intent: ctx?.currentSession && ctx.currentSession.friendId !== "self"
          ? "explicit_cross_chat"
          : "generic_outreach",
        ...(ctx?.currentSession && ctx.currentSession.friendId !== "self"
          ? {
              authorizingSession: {
                friendId: ctx.currentSession.friendId,
                channel: ctx.currentSession.channel,
                key: ctx.currentSession.key,
                trustLevel: ctx?.context?.friend?.trustLevel,
              },
            }
          : {}),
      }, {
        agentName,
        queuePending: (message) => writePendingEnvelope(pendingDir, message),
        deliverers: {
          bluebubbles: async (request) => {
            const { sendProactiveBlueBubblesMessageToSession } = await import("../senses/bluebubbles")
            const result = await sendProactiveBlueBubblesMessageToSession({
              friendId: request.friendId,
              sessionKey: request.key,
              text: request.content,
              intent: request.intent,
              authorizingSession: request.authorizingSession,
              origin: "send_message",
            } as any)
            if (result.delivered) {
              return {
                status: "delivered_now",
                detail: "sent to the active bluebubbles chat now",
              } as const
            }
            if (result.reason === "missing_target") {
              return {
                status: "blocked",
                detail: "bluebubbles could not resolve a routable target for that session",
              } as const
            }
            if (result.reason === "blocked_meta_content") {
              return {
                status: "blocked",
                detail: "blocked: contains internal meta markers",
              } as const
            }
            if (result.reason === "internal_content_blocked") {
              const { getProactiveInternalContentBlockReason, proactiveContentBlockGuidance } = await import("../senses/proactive-content-guard")
              return { status: "blocked", detail: proactiveContentBlockGuidance(getProactiveInternalContentBlockReason(request.content)) } as const
            }
            if (result.reason === "letter_guard") return { status: "blocked", detail: result.detail! } as const
            if (result.reason === "send_error") {
              return {
                status: "failed",
                detail: "bluebubbles send failed",
              } as const
            }
            if (result.reason === "host_account_refused") {
              return {
                status: "failed",
                detail: "the BlueBubbles server is not signed in to this agent's account, so nothing was sent",
              } as const
            }
            return {
              status: "unavailable",
              detail: "live delivery unavailable right now; queued for the next active turn",
            } as const
          },
          teams: async (request) => {
            let result: import("../senses/teams-off-turn").OffTurnTeamsSendResult | null
            if (ctx?.botApi) {
              const { sendProactiveTeamsMessageToSession } = await import("../senses/teams")
              result = await sendProactiveTeamsMessageToSession({
                friendId: request.friendId,
                sessionKey: request.key,
                text: request.content,
                intent: request.intent,
                authorizingSession: request.authorizingSession,
                origin: "send_message",
              } as any, {
                botApi: ctx.botApi,
              })
            } else {
              // Not a Teams turn (ouro msg, a habit, a private-runtime turn): send now where the Teams sense runs.
              const { sendTeamsOffTurn } = await import("../senses/teams-off-turn")
              result = await sendTeamsOffTurn({
                friendId: request.friendId,
                key: request.key,
                text: request.content,
                intent: request.intent,
                authorizingSession: request.authorizingSession,
                origin: "send_message",
              } as any, { agentRoot: getAgentRoot() })
            }
            if (!result) {
              return {
                status: "unavailable",
                detail: "live delivery unavailable right now; queued for the next active turn",
              } as const
            }
            if (result.forwardedTo) {
              return {
                status: "forwarded",
                detail: `forwarded to ${result.forwardedTo}, which runs Teams; it sends on its next sync, usually within a couple of minutes`,
              } as const
            }
            if (result.delivered) {
              return {
                status: "delivered_now",
                detail: "sent to the active teams chat now",
              } as const
            }
            if (result.reason === "missing_target") {
              return {
                status: "blocked",
                detail: "teams could not resolve a routable target for that session",
              } as const
            }
            if (result.reason === "internal_content_blocked") {
              const { getProactiveInternalContentBlockReason, proactiveContentBlockGuidance } = await import("../senses/proactive-content-guard")
              return { status: "blocked", detail: proactiveContentBlockGuidance(getProactiveInternalContentBlockReason(request.content)) } as const
            }
            if (result.reason === "send_error") {
              return {
                status: "failed",
                detail: "teams send failed",
              } as const
            }
            return {
              status: "unavailable",
              detail: "live delivery unavailable right now; queued for the next active turn",
            } as const
          },
          telegram: async (request) => {
            const key = canonicalizeTelegramSessionKey(request.key)
            const hash = createHash("sha256").update(`${request.friendId}\0${key}\0${request.content}`).digest("hex")
            const { sendTelegramAwaitFollowUp } = await import("../senses/telegram")
            return sendTelegramAwaitFollowUp(agentName, {
              ...request,
              key,
              requestId: request.requestId ?? `send-message:${hash}`,
              deliveryId: request.deliveryId ?? `send-message:${hash}`,
            })
          },
          voice: async (request) => deliverVoiceChannelMessage(request, agentName, voiceInitialAudio),
        },
      })

      recordHabitSendAttempt(ctx, { friendId, channel, key }, deliveryResult)
      return renderCrossChatDeliveryStatus(`${friendId} on ${channel}/${key}`, deliveryResult)
    },
    riskProfile: sendMessageRiskProfile,
    ax: { id: "tool:send_message", eager: true, group: "turn-sessions", when: "Pick this to reach someone in a different chat or channel than this one, or a phone call by voice; to keep thinking privately, use ponder.", effect: "write", errors: [
      { code: "delivery-blocked", means: "The message wasn't sent: no routable chat exists for that session, or the text carries internal markers.", fix: "Check the friend and channel with query_session, and remove internal notes from the content." },
      { code: "delivery-failed", means: "The channel tried to send and failed, or the person can't be reached that way.", fix: "Try again once, or reach them on another channel they use." },
      { code: "orientation-hold", means: "This turn is on a correction hold, so messages to other chats wait.", fix: "Call orientation_get, settle what the person meant, then send if it still fits." },
    ] },
  },
  {
    tool: {
      type: "function",
      function: {
        name: "set_reasoning_effort",
        description:
          "adjust your own reasoning depth for subsequent turns. use higher effort for complex analysis, lower for simple tasks.",
        parameters: {
          type: "object",
          properties: {
            level: { type: "string", description: "the reasoning effort level to set" },
          },
          required: ["level"],
        },
      },
    },
    handler: (args, ctx) => {
      if (!ctx?.supportedReasoningEfforts || !ctx.setReasoningEffort) {
        return withCode("reasoning effort adjustment is not available in this context.", "effort-unavailable");
      }
      const level = (args.level || "").trim();
      if (!ctx.supportedReasoningEfforts.includes(level)) {
        return withCode(`invalid reasoning effort level "${level}". accepted levels: ${ctx.supportedReasoningEfforts.join(", ")}`, "invalid-effort-level");
      }
      ctx.setReasoningEffort(level);
      emitNervesEvent({
        component: "repertoire",
        event: "repertoire.reasoning_effort_changed",
        message: `reasoning effort set to ${level}`,
        meta: { level },
      });
      return `reasoning effort set to "${level}".`;
    },
    requiredCapability: "reasoning-effort" as const,
    summaryKeys: ["level"],
    riskProfile: { mutates: "none", risk: "low", reason: "changes only this session's reasoning effort for later turns" },
    ax: { id: "tool:set_reasoning_effort", group: "turn-sessions", when: "Pick this to think harder on a knotty problem or lighter on routine work in the turns that follow.", effect: "write", idempotent: true, errors: [
      { code: "effort-unavailable", means: "This model or context has no adjustable reasoning effort.", fix: "Carry on at the current effort." },
      { code: "invalid-effort-level", means: "That level isn't one this model accepts; the message lists the accepted ones.", fix: "Call again with one of the listed levels." },
    ] },
  },
]
