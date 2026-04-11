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
import * as fs from "fs"
import * as path from "path"
import { emitNervesEvent } from "../nerves/runtime"
import { parseSlashCommand, getSharedCommandRegistry } from "./commands"
import { resolveMustResolveBeforeHandoff } from "./continuity"
import { formatBridgeContext } from "../heart/bridges/manager"
import { getAgentName, getAgentRoot, loadAgentConfig } from "../heart/identity"
import { requestInnerWake } from "../heart/daemon/socket-client"
import { buildActiveWorkFrame } from "../heart/active-work"
import { decideDelegation } from "../heart/delegation"
import { readPendingObligations } from "../arc/obligations"
import { buildFailoverContext, handleFailoverReply, type FailoverContext } from "../heart/provider-failover"
import { runHealthInventory } from "../heart/provider-ping"
import { writeAgentProviderSelection, loadAgentSecrets } from "../heart/auth/auth-flow"
import { resolveModelForProviderDisplay } from "../heart/provider-models"
import { deriveTempo } from "../heart/tempo"
import { buildTemporalView } from "../heart/temporal-view"
import { buildStartOfTurnPacket, renderStartOfTurnPacket, buildCapabilitiesSection } from "../heart/start-of-turn-packet"
import { detectBundleState } from "../heart/bundle-state"
import { preTurnPull, postTurnPush } from "../heart/sync"
import { getSyncConfig } from "../heart/config"
import { describeCurrentSessionTiming, stampIngressTime, type SessionEvent } from "../heart/session-events"
import { derivePresence, writePresence } from "../arc/presence"
import { emitEpisode } from "../arc/episodes"
import { buildTurnContext } from "../heart/turn-context"

export interface FailoverState {
  pending: FailoverContext | null
}

/**
 * Emit episodes for obligation state transitions detected during a turn.
 * Exported for direct testability (avoids v8 coverage merge issues in multi-file test suites).
 */
export function emitObligationTransitionEpisodes(
  agentRoot: string,
  preTurnObligationIds: Set<string>,
  postTurnObligations: import("../arc/obligations").Obligation[],
  preTurnObligations: import("../arc/obligations").Obligation[],
): void {
  const postTurnObligationIds = new Set(postTurnObligations.map((ob) => `${ob.id}:${ob.status}`))
  for (const key of preTurnObligationIds) {
    if (!postTurnObligationIds.has(key)) {
      const [obId] = key.split(":")
      const matchedOb = postTurnObligations.find((ob) => ob.id === obId) ?? preTurnObligations.find((ob) => ob.id === obId)
      emitEpisode(agentRoot, {
        kind: "obligation_shift",
        summary: `obligation "${matchedOb?.content ?? obId}" status changed`,
        whyItMattered: "obligation state transition detected during turn",
        relatedEntities: [`obligation:${obId}`],
        salience: "medium",
      })
    }
  }
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
  sessionLoader: { loadOrCreate(): Promise<{ messages: ChatCompletionMessageParam[]; sessionPath: string; state?: SessionContinuityState; events?: SessionEvent[] }> }
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
  /** Optional callback invoked after pending messages are drained. Returns prefix sections to inject before pending. */
  onPendingDrained?: (drained: PendingMessage[]) => string[]
}

export interface InboundTurnResult {
  /** The resolved context (friend + channel capabilities). Always present. */
  resolvedContext: ResolvedContext
  /** Trust gate result. Always present. */
  gateResult: TrustGateResult
  /** Usage data from runAgent. Undefined when gate rejects. */
  usage?: UsageData
  /** Structured turn outcome from runAgent, or "command" for intercepted slash commands. Undefined when gate rejects. */
  turnOutcome?: RunAgentOutcome | "command"
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
  /** If turnOutcome is "command", the action from the dispatched command (exit, new, response). */
  commandAction?: "exit" | "new" | "response"
}

function prependTurnSections(
  message: ChatCompletionMessageParam,
  sections: string[],
): ChatCompletionMessageParam {
  /* v8 ignore next -- defensive: only user messages with non-empty sections reach here @preserve */
  if (message.role !== "user" || sections.length === 0) return message
  const prefix = sections.join("\n\n")

  /* v8 ignore start -- defensive: multipart content branch; non-string user messages are rare @preserve */
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
  /* v8 ignore stop */
}

// ── Pipeline ──────────────────────────────────────────────────────

let _lastSessionKey: string | null = null

export async function handleInboundTurn(input: InboundTurnInput): Promise<InboundTurnResult> {
  // Reset session-scoped state when the session changes
  const sessionKey = `${input.channel}/${input.sessionKey ?? "session"}`
  if (sessionKey !== _lastSessionKey) {
    _lastSessionKey = sessionKey
    // Reset file-state cache and scrutiny tracking for the new session
    const { fileStateCache } = await import("../mind/file-state")
    const { resetSessionModifiedFiles } = await import("../mind/scrutiny")
    fileStateCache.clear()
    resetSessionModifiedFiles()
  }

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
        writeAgentProviderSelection(failoverAgentName, "human", failoverAction.provider)
        writeAgentProviderSelection(failoverAgentName, "agent", failoverAction.provider)
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
            const hint = cfg?.model ?? cfg?.modelName
            return resolveModelForProviderDisplay(failoverAction.provider, typeof hint === "string" ? hint : "")
          /* v8 ignore next 2 -- defensive: secrets read failure @preserve */
          } catch { return resolveModelForProviderDisplay(failoverAction.provider) }
        })()
        const newProviderLabel = `${failoverAction.provider} (${newProviderSecrets})`
        input.messages = [{
          role: "user" as const,
          content: `[provider switch: ${pendingContext.errorSummary}. switched to ${newProviderLabel}. your conversation history is intact — respond to the user's last message.]`,
        }]
        input.switchedProvider = failoverAction.provider
      }
      // Switch failed OR succeeded — either way, fall through to normal processing.
    }
  }

  // Step 0b: Slash command interception (before friend resolution / agent turn)
  {
    const firstUserMsg = input.messages.find((m) => m.role === "user")
    const userText = firstUserMsg
      ? (typeof firstUserMsg.content === "string"
        ? firstUserMsg.content
        : Array.isArray(firstUserMsg.content)
          ? (firstUserMsg.content.find((p: any) => p.type === "text") as any)?.text ?? ""
          : /* v8 ignore next -- defensive: content is always string or array @preserve */ "")
      : ""
    const parsed = parseSlashCommand(userText)
    if (parsed) {
      const registry = getSharedCommandRegistry()
      const dispatchResult = registry.dispatch(parsed.command, { channel: input.channel })
      if (dispatchResult.handled && dispatchResult.result) {
        emitNervesEvent({
          component: "senses",
          event: "senses.pipeline_command",
          message: `slash command intercepted: /${parsed.command}`,
          meta: { command: parsed.command, channel: input.channel },
        })
        if (dispatchResult.result.message) {
          input.callbacks.onTextChunk(dispatchResult.result.message)
        }
        // Return a minimal result — no agent turn, no session write
        const resolvedContext = await input.friendResolver.resolve()
        return {
          resolvedContext,
          gateResult: { allowed: true },
          turnOutcome: "command",
          commandAction: dispatchResult.result.action,
        }
      }
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
  const sessionEvents = session.events ?? []
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
  const currentSessionTiming = describeCurrentSessionTiming(sessionEvents)

  // Step 3b: Pre-turn sync pull (opt-in) — MUST happen before any continuity state reads
  // so that obligations, episodes, cares, etc. reflect the latest remote state.
  let syncFailure: string | undefined
  let syncConfig: import("../heart/config").SyncConfig = { enabled: false, remote: "origin" }
  try { syncConfig = getSyncConfig() } catch { /* config not available */ }

  // Wrap the turn body in try/finally so postTurnPush always runs — even on
  // error or early-return failover paths.
  try {
  /* v8 ignore start -- sync-enabled branches tested in sync.test.ts, pipeline tests mock at module boundary @preserve */
  if (syncConfig.enabled) {
    const pullResult = preTurnPull(getAgentRoot(), syncConfig)
    if (!pullResult.ok) {
      syncFailure = pullResult.error
    }
    // Check for pending-sync from a prior failed push
    if (!syncFailure) {
      const pendingSyncPath = path.join(getAgentRoot(), "state", "pending-sync.json")
      try {
        if (fs.existsSync(pendingSyncPath)) {
          const pendingSync = JSON.parse(fs.readFileSync(pendingSyncPath, "utf-8"))
          syncFailure = `prior sync push failed: ${pendingSync.error ?? "unknown"}`
          fs.unlinkSync(pendingSyncPath)
        }
      } catch {
        // Ignore read errors for pending-sync
      }
    }
  }
  /* v8 ignore stop */

  // Build the turn context snapshot — centralizes all state reads
  const ctx = await buildTurnContext({
    currentSession,
    channel: input.channel,
    friendStore: input.friendStore,
  })
  // Propagate sync failure from pre-turn pull
  ctx.syncFailure = syncFailure
  const { activeBridges, sessionActivity, pendingObligations, codingSessions, otherCodingSessions } = ctx
  const bridgeContext = formatBridgeContext(activeBridges) || undefined
  const activeWorkFrame = buildActiveWorkFrame({
    currentSession,
    currentObligation,
    mustResolveBeforeHandoff,
    inner: ctx.innerWorkState,
    bridges: activeBridges,
    codingSessions,
    otherCodingSessions,
    pendingObligations,
    taskBoard: ctx.taskBoard,
    friendActivity: sessionActivity,
    targetCandidates: ctx.targetCandidates,
    innerReturnObligations: ctx.returnObligations,
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

  // Assemble messages: session messages + pending + inbound user messages
  // NOTE: live world-state checkpoint and pending messages are rendered via buildSystem (system prompt sections)
  const extraPrefixSections = input.onPendingDrained?.(pending) ?? []
  // extraPrefixSections from onPendingDrained still prepend to user message (e.g., inner dialog wakes)
  if (extraPrefixSections.length > 0 && input.messages.length > 0) {
    input.messages[0] = prependTurnSections(input.messages[0], extraPrefixSections)
  }

  // Append user messages from the inbound turn
  for (const msg of input.messages) {
    stampIngressTime(msg)
    sessionMessages.push(msg)
  }

  // Step 4b: Continuity pipeline — derive tempo, build start-of-turn packet, snapshot obligations
  let renderedStartOfTurnPacket: string | undefined
  const preTurnObligationIds = new Set(pendingObligations.map((ob) => `${ob.id}:${ob.status}`))
  try {
    const agentRoot = getAgentRoot()
    const agentName = getAgentName()
    const { recentEpisodes, activeCares } = ctx
    const tempoState = deriveTempo({
      activeSessions: sessionActivity.length + 1,
      openObligations: pendingObligations.length,
      recentEpisodeCount: recentEpisodes.length,
      lastActivityAgeMs: sessionActivity.length > 0
        ? Date.now() - new Date(sessionActivity[0].lastActivityAt).getTime()
        : 0,
      hasBlockers: false, // obligations use specific statuses, not "blocked"
      highSalienceEpisodes: recentEpisodes.filter((ep) => ep.salience === "high" || ep.salience === "critical").length,
      activeCareCount: activeCares.length,
      atRiskCareCount: activeCares.filter((c) => c.currentRisk != null).length,
    })
    const temporalView = buildTemporalView(agentRoot, {
      tempo: tempoState.mode,
      preloaded: {
        recentEpisodes,
        activeObligations: pendingObligations,
        activeCares,
      },
    })
    const startOfTurnPacket = buildStartOfTurnPacket(temporalView, {
      canonicalObligations: {
        primary: activeWorkFrame.primaryObligation,
        all: activeWorkFrame.pendingObligations,
      },
      currentSessionTiming,
    })
    /* v8 ignore next 3 -- syncFailure propagation tested in sync.test.ts @preserve */
    if (syncFailure) {
      startOfTurnPacket.syncFailure = syncFailure
    }
    // Structured bundle state detection — surfaces discrete issues the
    // agent can remediate via the bundle_* tools. Runs independently of
    // syncFailure so the two signals coexist during the transition away
    // from the legacy free-form syncFailure string. Always assigned; the
    // packet renderer's empty-filter handles the empty-array case without
    // a separate branch here.
    startOfTurnPacket.bundleState = detectBundleState(agentRoot)
    const capabilities = buildCapabilitiesSection(agentRoot)
    if (capabilities) {
      startOfTurnPacket.capabilities = capabilities
    }
    renderedStartOfTurnPacket = renderStartOfTurnPacket(startOfTurnPacket)
    if (!renderedStartOfTurnPacket) renderedStartOfTurnPacket = undefined

    // Update self-presence
    const presence = derivePresence(agentRoot, agentName, {
      activeSessions: sessionActivity.length + 1,
      openObligations: pendingObligations.length,
      activeBridges: activeBridges.length,
      codingLanes: codingSessions.length,
      currentTempo: tempoState.mode,
    })
    writePresence(agentRoot, agentName, presence)
  } catch (continuityError) {
    emitNervesEvent({
      level: "warn",
      component: "senses",
      event: "senses.continuity_error",
      message: "continuity pipeline failed, continuing without start-of-turn packet",
      meta: { error: continuityError instanceof Error ? continuityError.message : String(continuityError) },
    })
  }

  // Step 5: runAgent
  const existingToolContext = input.runAgentOptions?.toolContext
  const runAgentOptions: RunAgentOptions = {
    ...input.runAgentOptions,
    bridgeContext,
    activeWorkFrame,
    delegationDecision,
    startOfTurnPacket: renderedStartOfTurnPacket,
    pendingMessages: pending.length > 0 ? pending.map((msg) => ({ from: msg.from, content: msg.content })) : undefined,
    currentSessionKey: currentSession.key,
    currentObligation,
    mustResolveBeforeHandoff,
    setMustResolveBeforeHandoff: (value) => {
      mustResolveBeforeHandoff = value
    },
    // Pre-read state from TurnContext for prompt assembly
    daemonRunning: ctx.daemonRunning,
    senseStatusLines: ctx.senseStatusLines,
    bundleMeta: ctx.bundleMeta,
    daemonHealth: ctx.daemonHealth,
    journalFiles: ctx.journalFiles,
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
      const currentProvider = agentConfig.humanFacing.provider
      /* v8 ignore next -- defensive: errorClassification always set when errored @preserve */
      const classification = result.errorClassification ?? "unknown"
      const inventory = await runHealthInventory(agentName, currentProvider)
      const { secrets } = loadAgentSecrets(agentName)
      const providerModels: Partial<Record<string, string>> = {}
      for (const [p, cfg] of Object.entries(secrets.providers)) {
        const model = (cfg as Record<string, unknown>).model ?? (cfg as Record<string, unknown>).modelName
        if (typeof model === "string" && model) providerModels[p] = model
      }
      // Use agent.json model (source of truth), not secrets model (may be stale)
      const currentModel = agentConfig.humanFacing.model
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

  // Step 5c: Emit episodes for obligation state transitions
  try {
    const agentRoot = getAgentRoot()
    const postTurnObligations = readPendingObligations(agentRoot)
    emitObligationTransitionEpisodes(agentRoot, preTurnObligationIds, postTurnObligations, pendingObligations)
  } catch {
    // Episode emission is non-fatal
  }

  // Step 6: postTurn
  const continuingState = {
    ...(mustResolveBeforeHandoff ? { mustResolveBeforeHandoff: true } : {}),
    ...(typeof lastFriendActivityAt === "string" ? { lastFriendActivityAt } : {}),
  }
  const nextState = result.outcome === "settled" || result.outcome === "blocked" || result.outcome === "superseded" || result.outcome === "observed"
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

  // DRY cross-session awareness: notify inner dialog that activity happened on another channel
  // Inner dialog's next checkpoint will include this session's state
  if (input.channel !== "inner") {
    try {
      requestInnerWake(getAgentName()).catch(/* v8 ignore next */ () => { /* best effort — daemon may not be running */ })
    } catch { /* getAgentName may fail in test environments */ }
  }

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
  } finally {
    // Step 6b: Post-turn sync push (opt-in, git-status-based discovery).
    if (syncConfig.enabled) {
      postTurnPush(getAgentRoot(), syncConfig)
    }
  }
}
