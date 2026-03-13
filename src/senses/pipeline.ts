// Shared per-turn pipeline for all senses.
// Senses are thin transport adapters; this module owns the common lifecycle:
//   resolve friend -> trust gate -> load session -> drain pending -> runAgent -> postTurn -> token accumulation.
//
// Transport-level concerns (BB API calls, Teams cards, readline) stay in sense adapters.

import type { ChatCompletionMessageParam } from "openai/resources/chat/completions"
import type { ChannelCallbacks, RunAgentOptions, RunAgentOutcome } from "../heart/core"
import type { PostTurnHooks, SessionContinuityState, UsageData } from "../mind/context"
import type { Channel, ChannelCapabilities, IdentityProvider, ResolvedContext } from "../mind/friends/types"
import type { FriendStore } from "../mind/friends/store"
import type { TrustGateInput, TrustGateResult } from "./trust-gate"
import type { PendingMessage } from "../mind/pending"
import { emitNervesEvent } from "../nerves/runtime"
import { resolveMustResolveBeforeHandoff } from "./continuity"
import { createBridgeManager, formatBridgeContext } from "../heart/bridges/manager"
import { getAgentName, getAgentRoot } from "../heart/identity"
import { getTaskModule } from "../repertoire/tasks"
import { listSessionActivity } from "../heart/session-activity"
import type { SessionActivityRecord } from "../heart/session-activity"
import { buildActiveWorkFrame } from "../heart/active-work"
import { decideDelegation } from "../heart/delegation"
import { readInnerDialogStatus, getInnerDialogSessionPath } from "../heart/daemon/thoughts"
import { getInnerDialogPendingDir } from "../mind/pending"
import type { BoardResult } from "../repertoire/tasks/types"

// ── Input / Output types ──────────────────────────────────────────

export interface InboundTurnInput {
  /** Which channel this turn arrives on (used for runAgent channel param). */
  channel: Channel
  /** Canonical session key for this inbound turn (defaults to "session"). */
  sessionKey?: string
  /** Capabilities of the channel (carries senseType). */
  capabilities: ChannelCapabilities
  /** The inbound user message(s) to append to the session. */
  messages: ChatCompletionMessageParam[]
  /** Raw external-user-authored text used for continuity classification before wrappers are applied. */
  continuityIngressTexts?: string[]
  /** Streaming / display callbacks for the channel adapter. */
  callbacks: ChannelCallbacks
  /** Resolves external identity into a FriendRecord + channel capabilities. */
  friendResolver: { resolve(): Promise<ResolvedContext> }
  /** Loads an existing session or creates a fresh one. */
  sessionLoader: { loadOrCreate(): Promise<{ messages: ChatCompletionMessageParam[]; sessionPath: string; state?: SessionContinuityState }> }
  /** Directory to drain pending messages from. */
  pendingDir: string
  /** Friend store used for token accumulation. */
  friendStore: FriendStore
  /** Optional abort signal forwarded to runAgent. */
  signal?: AbortSignal
  /** Optional runAgent options (traceId, toolContext overrides, etc). */
  runAgentOptions?: RunAgentOptions

  // ── Trust gate context (optional, defaults to safe values) ──
  /** Identity provider for trust gate. Defaults to "local". */
  provider?: IdentityProvider
  /** External ID for trust gate. Defaults to "". */
  externalId?: string
  /** Tenant ID for trust gate. */
  tenantId?: string
  /** Whether this message is from a group chat. Defaults to false. */
  isGroupChat?: boolean
  /** Whether a family member is present in the group. Defaults to false. */
  groupHasFamilyMember?: boolean
  /** Whether the sender has an existing group with family. Defaults to false. */
  hasExistingGroupWithFamily?: boolean

  // ── Dependency injection for testability ──
  enforceTrustGate: (input: TrustGateInput) => TrustGateResult
  drainPending: (pendingDir: string) => PendingMessage[]
  runAgent: (
    messages: ChatCompletionMessageParam[],
    callbacks: ChannelCallbacks,
    channel?: Channel,
    signal?: AbortSignal,
    options?: RunAgentOptions,
  ) => Promise<{ usage?: UsageData; outcome: RunAgentOutcome }>
  postTurn: (
    messages: ChatCompletionMessageParam[],
    sessPath: string,
    usage?: UsageData,
    hooks?: PostTurnHooks,
    state?: SessionContinuityState,
  ) => void
  accumulateFriendTokens: (
    store: FriendStore,
    friendId: string,
    usage?: UsageData,
  ) => Promise<void>
}

export interface InboundTurnResult {
  /** The resolved context (friend + channel capabilities). Always present. */
  resolvedContext: ResolvedContext
  /** Trust gate result. Always present. */
  gateResult: TrustGateResult
  /** Usage data from runAgent. Undefined when gate rejects. */
  usage?: UsageData
  /** Structured turn outcome from runAgent. Undefined when gate rejects. */
  turnOutcome?: RunAgentOutcome
  /** Session file path. Undefined when gate rejects. */
  sessionPath?: string
  /** The final messages array after the turn. Undefined when gate rejects. */
  messages?: ChatCompletionMessageParam[]
}

function emptyTaskBoard(): BoardResult {
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
    },
    actionRequired: [],
    unresolvedDependencies: [],
    activeSessions: [],
    activeBridges: [],
  }
}

function readInnerWorkState(): { status: "idle" | "running"; hasPending: boolean } {
  try {
    const agentRoot = getAgentRoot()
    const pendingDir = getInnerDialogPendingDir(getAgentName())
    const sessionPath = getInnerDialogSessionPath(agentRoot)
    const status = readInnerDialogStatus(sessionPath, pendingDir)
    return {
      status: status.processing === "started" ? "running" : "idle",
      hasPending: status.queue !== "clear",
    }
  } catch {
    return {
      status: "idle",
      hasPending: false,
    }
  }
}

// ── Pipeline ──────────────────────────────────────────────────────

export async function handleInboundTurn(input: InboundTurnInput): Promise<InboundTurnResult> {
  // Step 1: Resolve friend
  const resolvedContext = await input.friendResolver.resolve()

  emitNervesEvent({
    component: "senses",
    event: "senses.pipeline_start",
    message: "inbound turn pipeline started",
    meta: {
      channel: input.channel,
      friendId: resolvedContext.friend.id,
      senseType: input.capabilities.senseType,
    },
  })

  // Step 2: Trust gate
  const gateInput: TrustGateInput = {
    friend: resolvedContext.friend,
    provider: input.provider ?? "local",
    externalId: input.externalId ?? "",
    tenantId: input.tenantId,
    channel: input.channel,
    senseType: input.capabilities.senseType,
    isGroupChat: input.isGroupChat ?? false,
    groupHasFamilyMember: input.groupHasFamilyMember ?? false,
    hasExistingGroupWithFamily: input.hasExistingGroupWithFamily ?? false,
  }

  const gateResult = input.enforceTrustGate(gateInput)

  // Gate rejection: return early, no agent turn
  if (!gateResult.allowed) {
    emitNervesEvent({
      component: "senses",
      event: "senses.pipeline_gate_reject",
      message: "trust gate rejected inbound turn",
      meta: {
        channel: input.channel,
        friendId: resolvedContext.friend.id,
        reason: gateResult.reason,
      },
    })

    return {
      resolvedContext,
      gateResult,
    }
  }

  // Step 3: Load/create session
  const session = await input.sessionLoader.loadOrCreate()
  const sessionMessages = session.messages
  let mustResolveBeforeHandoff = resolveMustResolveBeforeHandoff(
    session.state?.mustResolveBeforeHandoff === true,
    input.continuityIngressTexts,
  )
  const lastFriendActivityAt = input.channel === "inner"
    ? session.state?.lastFriendActivityAt
    : new Date().toISOString()
  const currentObligation = input.continuityIngressTexts
    ?.map((text) => text.trim())
    .filter((text) => text.length > 0)
    .at(-1)
  const currentSession = {
    friendId: resolvedContext.friend.id,
    channel: input.channel,
    key: input.sessionKey ?? "session",
    sessionPath: session.sessionPath,
  }
  const activeBridges = createBridgeManager().findBridgesForSession({
    friendId: currentSession.friendId,
    channel: currentSession.channel,
    key: currentSession.key,
  })
  const bridgeContext = formatBridgeContext(activeBridges) || undefined
  let sessionActivity: SessionActivityRecord[] = []
  try {
    const agentRoot = getAgentRoot()
    sessionActivity = listSessionActivity({
      sessionsDir: `${agentRoot}/state/sessions`,
      friendsDir: `${agentRoot}/friends`,
      agentName: getAgentName(),
      currentSession: {
        friendId: currentSession.friendId,
        channel: currentSession.channel,
        key: currentSession.key,
      },
    })
  } catch {
    sessionActivity = []
  }
  const activeWorkFrame = buildActiveWorkFrame({
    currentSession,
    currentObligation,
    mustResolveBeforeHandoff,
    inner: readInnerWorkState(),
    bridges: activeBridges,
    taskBoard: (() => {
      try {
        return getTaskModule().getBoard()
      } catch {
        return emptyTaskBoard()
      }
    })(),
    friendActivity: sessionActivity,
  })
  const delegationDecision = decideDelegation({
    channel: input.channel,
    ingressTexts: input.continuityIngressTexts ?? [],
    activeWork: activeWorkFrame,
    mustResolveBeforeHandoff,
  })

  // Step 4: Drain pending messages
  const pending = input.drainPending(input.pendingDir)

  // Assemble messages: session messages + pending (formatted) + inbound user messages
  if (pending.length > 0) {
    // Format pending messages and prepend to the user content
    const pendingSection = pending
      .map((msg) => `[pending from ${msg.from}]: ${msg.content}`)
      .join("\n")

    // If there are inbound user messages, prepend pending to the first one
    if (input.messages.length > 0) {
      const firstMsg = input.messages[0]
      if (firstMsg.role === "user") {
        if (typeof firstMsg.content === "string") {
          input.messages[0] = {
            ...firstMsg,
            content: `## pending messages\n${pendingSection}\n\n${firstMsg.content}`,
          }
        } else {
          input.messages[0] = {
            ...firstMsg,
            content: [
              { type: "text" as const, text: `## pending messages\n${pendingSection}\n\n` },
              ...firstMsg.content,
            ],
          }
        }
      }
    }
  }

  // Append user messages from the inbound turn
  for (const msg of input.messages) {
    sessionMessages.push(msg)
  }

  // Step 5: runAgent
  const existingToolContext = input.runAgentOptions?.toolContext
  const runAgentOptions: RunAgentOptions = {
    ...input.runAgentOptions,
    bridgeContext,
    activeWorkFrame,
    delegationDecision,
    currentSessionKey: currentSession.key,
    currentObligation,
    mustResolveBeforeHandoff,
    setMustResolveBeforeHandoff: (value) => {
      mustResolveBeforeHandoff = value
    },
    toolContext: {
      /* v8 ignore next -- default no-op signin satisfies interface; real signin injected by sense adapter @preserve */
      signin: async () => undefined,
      ...existingToolContext,
      context: resolvedContext,
      friendStore: input.friendStore,
      currentSession,
      activeBridges,
    },
  }

  const result = await input.runAgent(
    sessionMessages,
    input.callbacks,
    input.channel,
    input.signal,
    runAgentOptions,
  )

  // Step 6: postTurn
  const continuingState = {
    ...(mustResolveBeforeHandoff ? { mustResolveBeforeHandoff: true } : {}),
    ...(typeof lastFriendActivityAt === "string" ? { lastFriendActivityAt } : {}),
  }
  const nextState = result.outcome === "complete" || result.outcome === "blocked" || result.outcome === "superseded"
    ? (typeof lastFriendActivityAt === "string"
      ? { lastFriendActivityAt }
      : undefined)
    : (Object.keys(continuingState).length > 0 ? continuingState : undefined)
  input.postTurn(sessionMessages, session.sessionPath, result.usage, undefined, nextState)

  // Step 7: Token accumulation
  await input.accumulateFriendTokens(input.friendStore, resolvedContext.friend.id, result.usage)

  emitNervesEvent({
    component: "senses",
    event: "senses.pipeline_end",
    message: "inbound turn pipeline completed",
    meta: {
      channel: input.channel,
      friendId: resolvedContext.friend.id,
    },
  })

  return {
    resolvedContext,
    gateResult,
    usage: result.usage,
    turnOutcome: result.outcome,
    sessionPath: session.sessionPath,
    messages: sessionMessages,
  }
}
