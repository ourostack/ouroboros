// Shared per-turn pipeline for all senses.
// Senses are thin transport adapters; this module owns the common lifecycle:
//   resolve friend -> trust gate -> load session -> drain pending -> runAgent -> postTurn -> token accumulation.
//
// Transport-level concerns (BB API calls, Teams cards, readline) stay in sense adapters.

import type { ChatCompletionMessageParam } from "openai/resources/chat/completions"
import type { ChannelCallbacks, CompletionMetadata, ProviderErrorClassification, RunAgentOptions, RunAgentOutcome } from "../heart/core"
import type { PostTurnHooks, SessionContinuityState, UsageData } from "../mind/context"
import type { Channel, ChannelCapabilities, IdentityProvider, ResolvedContext } from "../mind/friends/types"
import type { FriendStore } from "../mind/friends/store"
import type { TrustGateInput, TrustGateResult } from "./trust-gate"
import type { PendingMessage } from "../mind/pending"
import { emitNervesEvent } from "../nerves/runtime"
import { resolveMustResolveBeforeHandoff } from "./continuity"
import { createBridgeManager, formatBridgeContext } from "../heart/bridges/manager"
import { getAgentName, getAgentRoot, loadAgentConfig } from "../heart/identity"
import { getTaskModule } from "../repertoire/tasks"
import { getCodingSessionManager } from "../repertoire/coding"
import { listSessionActivity } from "../heart/session-activity"
import type { SessionActivityRecord } from "../heart/session-activity"
import { buildActiveWorkFrame, formatLiveWorldStateCheckpoint, type ActiveWorkFrame } from "../heart/active-work"
import { decideDelegation } from "../heart/delegation"
import { listTargetSessionCandidates } from "../heart/target-resolution"
import { readInnerDialogRawData, deriveInnerDialogStatus, deriveInnerJob, getInnerDialogSessionPath } from "../heart/daemon/thoughts"
import { getInnerDialogPendingDir } from "../mind/pending"
import { readPendingObligations } from "../heart/obligations"
import { listActiveObligations } from "../mind/obligations"
import type { BoardResult } from "../repertoire/tasks/types"
import { buildFailoverContext, handleFailoverReply, type FailoverContext } from "../heart/provider-failover"
import { runHealthInventory } from "../heart/provider-ping"
import { writeAgentProviderSelection, loadAgentSecrets } from "../heart/daemon/auth-flow"

export interface FailoverState {
  pending: FailoverContext | null
}


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
  drainDeferredReturns?: (friendId: string) => PendingMessage[]
  runAgent: (
    messages: ChatCompletionMessageParam[],
    callbacks: ChannelCallbacks,
    channel?: Channel,
    signal?: AbortSignal,
    options?: RunAgentOptions,
  ) => Promise<{ usage?: UsageData; outcome: RunAgentOutcome; completion?: CompletionMetadata; error?: Error; errorClassification?: ProviderErrorClassification }>
  /** In-memory failover state for this session. Channel owns this, pipeline reads/writes it. */
  failoverState?: FailoverState
  /** Set by the pipeline during failover switch — signals that a provider switch occurred this turn. */
  switchedProvider?: string
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
  /** Explicit completion metadata from runAgent when available. */
  completion?: CompletionMetadata
  /** Session file path. Undefined when gate rejects. */
  sessionPath?: string
  /** The final messages array after the turn. Undefined when gate rejects. */
  messages?: ChatCompletionMessageParam[]
  /** Pending envelopes drained at turn start, including deferred returns. */
  drainedPending?: PendingMessage[]
  /** If set, the turn errored and this message should be shown to the user for failover. */
  failoverMessage?: string
  /** If set, a provider switch was executed via failover reply. */
  switchedProvider?: string
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

function isLiveCodingSessionStatus(
  status: import("../repertoire/coding/types").CodingSessionStatus,
): boolean {
  return status === "spawning"
    || status === "running"
    || status === "waiting_input"
    || status === "stalled"
}

function prependTurnSections(
  message: ChatCompletionMessageParam,
  sections: string[],
): ChatCompletionMessageParam {
  if (message.role !== "user" || sections.length === 0) return message
  const prefix = sections.join("\n\n")

  if (typeof message.content === "string") {
    return {
      ...message,
      content: `${prefix}\n\n${message.content}`,
    }
  }

  return {
    ...message,
    content: [
      { type: "text" as const, text: `${prefix}\n\n` },
      ...message.content,
    ],
  }
}

function readInnerWorkState(): ActiveWorkFrame["inner"] {
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
    // Derive obligationPending from both the pending message field and the obligation store
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

// ── Pipeline ──────────────────────────────────────────────────────

export async function handleInboundTurn(input: InboundTurnInput): Promise<InboundTurnResult> {
  // Step 0: Check for pending failover reply
  if (input.failoverState?.pending) {
    const userText = input.messages
      .filter((m) => m.role === "user")
      .map((m) => typeof m.content === "string" ? m.content : /* v8 ignore next -- defensive: multipart content fallback @preserve */ "")
      .join(" ")
      .trim()
    const pendingContext = input.failoverState.pending
    const failoverAction = handleFailoverReply(userText, pendingContext)
    const failoverAgentName = pendingContext.agentName
    input.failoverState.pending = null // always clear before acting
    if (failoverAction.action === "switch") {
      let switchSucceeded = false
      try {
        writeAgentProviderSelection(failoverAgentName, failoverAction.provider)
        switchSucceeded = true
      /* v8 ignore start -- defensive: write failure during provider switch @preserve */
      } catch (switchError) {
        emitNervesEvent({
          level: "error",
          component: "senses",
          event: "senses.failover_switch_error",
          message: `failed to switch provider to ${failoverAction.provider}`,
          meta: { agentName: failoverAgentName, provider: failoverAction.provider, error: switchError instanceof Error ? switchError.message : String(switchError) },
        })
      }
      /* v8 ignore stop */
      /* v8 ignore next -- false branch: write-failure fallthrough @preserve */
      if (switchSucceeded) {
        emitNervesEvent({
          component: "senses",
          event: "senses.failover_switch",
          message: `switched provider to ${failoverAction.provider} via failover`,
          meta: { agentName: failoverAgentName, provider: failoverAction.provider },
        })
        // Replace "switch to <provider>" with a context message for the agent.
        // The session already has the user's original question from the failed turn.
        // The agent needs to know what happened so it can respond appropriately.
        const newProviderSecrets = (() => {
          try {
            const { secrets } = loadAgentSecrets(failoverAgentName)
            const cfg = secrets.providers[failoverAction.provider as keyof typeof secrets.providers] as Record<string, unknown> | undefined
            return cfg?.model ?? cfg?.modelName ?? ""
          /* v8 ignore next 2 -- defensive: secrets read failure @preserve */
          } catch { return "" }
        })()
        const newProviderLabel = newProviderSecrets ? `${failoverAction.provider} (${newProviderSecrets})` : failoverAction.provider
        input.messages = [{
          role: "user" as const,
          content: `[provider switch: ${pendingContext.errorSummary}. switched to ${newProviderLabel}. your conversation history is intact — respond to the user's last message.]`,
        }]
        input.switchedProvider = failoverAction.provider
      }
      // Switch failed OR succeeded — either way, fall through to normal processing.
    }
  }

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
  let targetCandidates = [] as Awaited<ReturnType<typeof listTargetSessionCandidates>>
  try {
    if (input.channel !== "inner") {
      const agentRoot = getAgentRoot()
      targetCandidates = await listTargetSessionCandidates({
        sessionsDir: `${agentRoot}/state/sessions`,
        friendsDir: `${agentRoot}/friends`,
        agentName: getAgentName(),
        currentSession: {
          friendId: currentSession.friendId,
          channel: currentSession.channel,
          key: currentSession.key,
        },
        friendStore: input.friendStore,
      })
    }
  } catch {
    targetCandidates = []
  }
  let pendingObligations: import("../heart/obligations").Obligation[] = []
  try {
    pendingObligations = readPendingObligations(getAgentRoot())
  } catch {
    pendingObligations = []
  }
  let codingSessions = [] as ReturnType<ReturnType<typeof getCodingSessionManager>["listSessions"]>
  let otherCodingSessions = [] as ReturnType<ReturnType<typeof getCodingSessionManager>["listSessions"]>
  try {
    const liveCodingSessions = getCodingSessionManager()
      .listSessions()
      .filter((session) => isLiveCodingSessionStatus(session.status) && Boolean(session.originSession))
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
  } catch {
    codingSessions = []
    otherCodingSessions = []
  }
  const activeWorkFrame = buildActiveWorkFrame({
    currentSession,
    currentObligation,
    mustResolveBeforeHandoff,
    inner: readInnerWorkState(),
    bridges: activeBridges,
    codingSessions,
    otherCodingSessions,
    pendingObligations,
    taskBoard: (() => {
      try {
        return getTaskModule().getBoard()
      } catch {
        return emptyTaskBoard()
      }
    })(),
    friendActivity: sessionActivity,
    targetCandidates,
    innerReturnObligations: (() => {
      try {
        return listActiveObligations(getAgentName())
      } catch {
        return []
      }
    })(),
  })
  const delegationDecision = decideDelegation({
    channel: input.channel,
    ingressTexts: input.continuityIngressTexts ?? [],
    activeWork: activeWorkFrame,
    mustResolveBeforeHandoff,
  })

  // Step 4: Drain deferred friend returns, then ordinary per-session pending.
  const deferredReturns = input.channel === "inner"
    ? []
    : (input.drainDeferredReturns?.(resolvedContext.friend.id) ?? [])
  const sessionPending = input.drainPending(input.pendingDir)
  const pending = [...deferredReturns, ...sessionPending]

  // Assemble messages: session messages + live world-state checkpoint + pending + inbound user messages
  const prefixSections = [formatLiveWorldStateCheckpoint(activeWorkFrame)]
  if (pending.length > 0) {
    const pendingSection = pending
      .map((msg) => `[pending from ${msg.from}]: ${msg.content}`)
      .join("\n")
    prefixSections.push(`## pending messages\n${pendingSection}`)
  }
  if (input.messages.length > 0) {
    input.messages[0] = prependTurnSections(input.messages[0], prefixSections)
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

  // Step 5b: Failover on terminal error
  if (result.outcome === "errored" && input.failoverState) {
    try {
      const agentName = getAgentName()
      const agentConfig = loadAgentConfig()
      const currentProvider = agentConfig.provider
      /* v8 ignore next -- defensive: errorClassification always set when errored @preserve */
      const classification = result.errorClassification ?? "unknown"
      const inventory = await runHealthInventory(agentName, currentProvider)
      const { secrets } = loadAgentSecrets(agentName)
      const providerModels: Partial<Record<string, string>> = {}
      for (const [p, cfg] of Object.entries(secrets.providers)) {
        const model = (cfg as Record<string, unknown>).model ?? (cfg as Record<string, unknown>).modelName
        if (typeof model === "string" && model) providerModels[p] = model
      }
      /* v8 ignore next -- defensive: current provider always in secrets @preserve */
      const currentModel = providerModels[currentProvider] ?? ""
      const failoverContext = buildFailoverContext(
        /* v8 ignore next -- defensive: error always set when errored @preserve */
        result.error?.message ?? "unknown error",
        classification,
        currentProvider,
        currentModel,
        agentName,
        inventory,
        providerModels,
      )
      input.failoverState.pending = failoverContext
      input.postTurn(sessionMessages, session.sessionPath, result.usage)
      return {
        resolvedContext,
        gateResult,
        usage: result.usage,
        turnOutcome: result.outcome,
        sessionPath: session.sessionPath,
        messages: sessionMessages,
        drainedPending: pending,
        failoverMessage: failoverContext.userMessage,
      }
    /* v8 ignore start -- failover catch: tested via pipeline failover sequence throws test but v8 under-reports catch coverage @preserve */
    } catch (failoverError) {
      emitNervesEvent({
        level: "warn",
        component: "senses",
        event: "senses.failover_error",
        message: "failover sequence failed, falling through",
        meta: { error: failoverError instanceof Error ? failoverError.message : String(failoverError) },
      })
    }
    /* v8 ignore stop */
  }

  // Step 6: postTurn
  const continuingState = {
    ...(mustResolveBeforeHandoff ? { mustResolveBeforeHandoff: true } : {}),
    ...(typeof lastFriendActivityAt === "string" ? { lastFriendActivityAt } : {}),
  }
  const nextState = result.outcome === "complete" || result.outcome === "blocked" || result.outcome === "superseded" || result.outcome === "no_response"
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
    completion: result.completion,
    sessionPath: session.sessionPath,
    messages: sessionMessages,
    drainedPending: pending,
    ...(input.switchedProvider ? { switchedProvider: input.switchedProvider } : {}),
  }
}
