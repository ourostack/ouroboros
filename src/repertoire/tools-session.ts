import * as fs from "fs";
import * as path from "path";
import { resolveSessionPath } from "../heart/config";
import { getAgentRoot, getAgentName } from "../heart/identity";
import { emitNervesEvent } from "../nerves/runtime";
import { requestInnerWake } from "../heart/daemon/socket-client";
import {
  deriveInnerDialogStatus,
  deriveInnerJob,
  extractThoughtResponseFromMessages,
  formatSurfacedValue,
  getInnerDialogSessionPath,
  readInnerDialogRawData,
  readInnerDialogStatus,
} from "../heart/daemon/thoughts";
import { createBridgeManager } from "../heart/bridges/manager";
import {
  summarizeSessionTail,
  searchSessionTranscript,
  type SessionTailOptions,
  type SessionTailResult,
  type SessionSearchOptions,
  type SessionSearchResult,
} from "../heart/session-transcript";
import { listSessionActivity } from "../heart/session-activity";
import { buildActiveWorkFrame, formatActiveWorkFrame, type ActiveWorkFrame } from "../heart/active-work";
import { getCodingSessionManager, type CodingSessionStatus } from "./coding";
import { getTaskModule } from "./tasks";
import { getPendingDir, getInnerDialogPendingDir } from "../mind/pending";
import type { PendingMessage } from "../mind/pending";
import { createReturnObligation, generateObligationId, createObligation, readPendingObligations } from "../arc/obligations";
import { buildProgressStory, renderProgressStory } from "../heart/progress-story";
import { deliverCrossChatMessage, type CrossChatDeliveryResult } from "../heart/cross-chat-delivery";
import type { ToolContext, ToolDefinition } from "./tools-base";
import { listVisibleBackgroundOperations } from "../heart/mail-import-discovery";

const NO_SESSION_FOUND_MESSAGE = "no session found for that friend/channel/key combination."
const EMPTY_SESSION_MESSAGE = "session exists but has no non-system messages."

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

async function searchSessionSafely(options: SessionSearchOptions): Promise<SessionSearchResult | { kind: "missing" }> {
  try {
    return await searchSessionTranscript(options)
  } catch {
    return { kind: "missing" }
  }
}

function normalizeProgressOutcome(text: string): string | null {
  const trimmed = text.trim()
  /* v8 ignore next -- defensive: normalizeProgressOutcome null branch @preserve */
  if (!trimmed || trimmed === "nothing yet" || trimmed === "nothing recent") {
    return null
  }
  if (trimmed.startsWith("\"") && trimmed.endsWith("\"") && trimmed.length >= 2) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}

function writePendingEnvelope(queueDir: string, message: PendingMessage): void {
  fs.mkdirSync(queueDir, { recursive: true })
  const fileName = `${message.timestamp}-${Math.random().toString(36).slice(2, 10)}.json`
  const filePath = path.join(queueDir, fileName)
  fs.writeFileSync(filePath, JSON.stringify(message, null, 2))
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

  return renderProgressStory(buildProgressStory({
    scope: "shared-work",
    phase,
    objective: `message to ${target}`,
    outcomeText: `${lead}\n${result.detail}`,
  }))
}

function emptyTaskBoard() {
  return {
    compact: "",
    full: "",
    byStatus: {
      drafting: [],
      processing: [],
      validating: [],
      collaborating: [],
      paused: [],
      blocked: [],
      done: [],
      cancelled: [],
    },
    issues: [],
    actionRequired: [],
    unresolvedDependencies: [],
    activeSessions: [],
    activeBridges: [],
  }
}

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
    const pendingDir = getInnerDialogPendingDir(getAgentName())
    const sessionPath = getInnerDialogSessionPath(agentRoot)
    const { pendingMessages, turns, runtimeState } = readInnerDialogRawData(sessionPath, pendingDir)
    const dialogStatus = deriveInnerDialogStatus(pendingMessages, turns, runtimeState)
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
        channel: ctx.currentSession.channel as import("../mind/friends/types").Channel,
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
    taskBoard: (() => {
      try {
        return getTaskModule().getBoard()
      } catch {
        return emptyTaskBoard()
      }
    })(),
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

export function renderInnerProgressStatus(
  status: { queue: string; wake: string; processing: string; surfaced: string },
): string {
  if (status.processing === "pending") {
    return "i've queued this thought for private attention. it'll come up when my inner dialog is free."
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
        description: "read the current live world-state across visible sessions, coding lanes, inner work, and return obligations. use this instead of piecing status together from separate session and coding tools.",
        parameters: {
          type: "object",
          properties: {},
        },
      },
    },
    handler: async (_args, ctx) => {
      const frame = await buildToolActiveWorkFrame(ctx)
      return `this is my current top-level live world-state.\nanswer whole-self status questions from this before drilling into individual sessions.\n\n${formatActiveWorkFrame(frame)}`
    },
  },
  {
    tool: {
      type: "function",
      function: {
        name: "query_session",
        description: "inspect another session. use transcript for recent context, status for self/inner progress, or search to find older history by query.",
        parameters: {
          type: "object",
          properties: {
            friendId: { type: "string", description: "the friend UUID (or 'self')" },
            channel: { type: "string", description: "the channel: cli, teams, bluebubbles, inner, or mcp" },
            key: { type: "string", description: "session key (defaults to 'session')" },
            messageCount: { type: "string", description: "how many recent messages to return (default 20)" },
            mode: {
              type: "string",
              enum: ["transcript", "status", "search"],
              description: "transcript (default), lightweight status for self/inner checks, or search for older history",
            },
            query: { type: "string", description: "required when mode=search; search term for older session history" },
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
          return "status mode is only available for self/inner dialog."
        }

        const sessionPath = getInnerDialogSessionPath(getAgentRoot())
        const pendingDir = getInnerDialogPendingDir(getAgentName())
        return renderInnerProgressStatus(readInnerDialogStatus(sessionPath, pendingDir))
      }

      if (mode === "search") {
        const query = (args.query || "").trim()
        if (!query) {
          return "search mode requires a non-empty query."
        }

        const search = await searchSessionSafely({
          sessionPath: resolveSessionPath(friendId, channel, key),
          friendId,
          channel,
          key,
          query,
        })

        if (search.kind === "missing") {
          return NO_SESSION_FOUND_MESSAGE
        }
        if (search.kind === "empty") {
          return EMPTY_SESSION_MESSAGE
        }
        if (search.kind === "no_match") {
          return `no matches for "${search.query}" in that session.\n\n${search.snapshot}`
        }

        return [
          `history search: "${search.query}"`,
          search.snapshot,
          ...search.matches.map((match, index) => `match ${index + 1}\n${match}`),
        ].join("\n\n")
      }

      const sessFile = resolveSessionPath(friendId, channel, key)
      const sessionTail = await summarizeSessionTailSafely({
        sessionPath: sessFile,
        friendId,
        channel,
        key,
        messageCount: count,
        trustLevel: ctx?.context?.friend?.trustLevel,
        summarize: ctx?.summarize,
        archiveFallback: true,
      })

      if (sessionTail.kind === "missing") {
        return NO_SESSION_FOUND_MESSAGE
      }
      if (sessionTail.kind === "empty") {
        return EMPTY_SESSION_MESSAGE
      }

      return sessionTail.summary
    },
  },
  {
    tool: {
      type: "function",
      function: {
        name: "send_message",
        description: "send a message to a friend's session. when the request is explicitly authorized from a trusted live chat, the harness will try to deliver immediately; otherwise it reports truthful queued/block/failure state.",
        parameters: {
          type: "object",
          properties: {
            friendId: { type: "string", description: "the friend UUID (or 'self')" },
            channel: { type: "string", description: "the channel: cli, teams, bluebubbles, inner, or mcp" },
            key: { type: "string", description: "session key (defaults to 'session')" },
            content: { type: "string", description: "the message content to send" },
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

      // Self-routing: messages to "self" always go to inner dialog pending dir,
      // regardless of the channel or key the agent specified.
      const isSelf = friendId === "self"
      const pendingDir = isSelf
        ? getInnerDialogPendingDir(agentName)
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
        writePendingEnvelope(pendingDir, envelope)
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
            message: "obligation created for inner dialog delegation",
            meta: {
              friendId: delegatedFrom.friendId,
              channel: delegatedFrom.channel,
              key: delegatedFrom.key,
            },
          })
        }
        let wakeResponse: { ok: boolean } | null = null
        try {
          wakeResponse = await requestInnerWake(agentName)
        } catch {
          wakeResponse = null
        }

        if (!wakeResponse?.ok) {
          const { runInnerDialogTurn } = await import("../senses/inner-dialog")
          if (ctx?.context?.channel.channel === "inner") {
            queueMicrotask(() => {
              void runInnerDialogTurn({ reason: "instinct" })
            })
            return renderInnerProgressStatus({
              queue: "queued to inner/dialog",
              wake: "inline scheduled",
              processing: "pending",
              surfaced: "nothing yet",
            })
          } else {
            const turnResult = await runInnerDialogTurn({ reason: "instinct" })
            const surfacedPreview = normalizeProgressOutcome(
              formatSurfacedValue(extractThoughtResponseFromMessages(turnResult?.messages ?? [])),
            )
            return renderProgressStory(buildProgressStory({
              scope: "inner-delegation",
              phase: "completed",
              objective: "queued to inner/dialog",
              outcomeText: `wake: inline fallback\n${surfacedPreview}`,
            }))
          }
        }

        return renderInnerProgressStatus({
          queue: "queued to inner/dialog",
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
            if (result.reason === "send_error") {
              return {
                status: "failed",
                detail: "bluebubbles send failed",
              } as const
            }
            return {
              status: "unavailable",
              detail: "live delivery unavailable right now; queued for the next active turn",
            } as const
          },
          teams: async (request) => {
            if (!ctx?.botApi) {
              return {
                status: "unavailable",
                detail: "live delivery unavailable right now; queued for the next active turn",
              } as const
            }
            const { sendProactiveTeamsMessageToSession } = await import("../senses/teams")
            const result = await sendProactiveTeamsMessageToSession({
              friendId: request.friendId,
              sessionKey: request.key,
              text: request.content,
              intent: request.intent,
              authorizingSession: request.authorizingSession,
            } as any, {
              botApi: ctx.botApi,
            })
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
        },
      })

      return renderCrossChatDeliveryStatus(`${friendId} on ${channel}/${key}`, deliveryResult)
    },
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
        return "reasoning effort adjustment is not available in this context.";
      }
      const level = (args.level || "").trim();
      if (!ctx.supportedReasoningEfforts.includes(level)) {
        return `invalid reasoning effort level "${level}". accepted levels: ${ctx.supportedReasoningEfforts.join(", ")}`;
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
  },
]
