import * as fs from "fs"
import OpenAI from "openai"
import { App } from "@microsoft/teams.apps"
import { DevtoolsPlugin } from "@microsoft/teams.dev"
import { runAgent, ChannelCallbacks, RunAgentOptions, createSummarize, repairOrphanedToolCalls } from "../heart/core"
import type { ToolContext } from "../repertoire/tools"
import { getToolsForChannel, summarizeArgs } from "../repertoire/tools"
import { getChannelCapabilities } from "../mind/friends/channel"
import { getOAuthConfig, resolveOAuthForTenant, getTeamsSecondaryConfig } from "../heart/config"
import { buildSystem } from "../mind/prompt"
import { pickPhrase, getPhrases } from "../mind/phrases"
import { formatToolResult, formatKick, formatError } from "../mind/format"
import { sessionPath, getTeamsConfig, getTeamsChannelConfig } from "../heart/config"
import { loadSession, deleteSession, postTurn } from "../mind/context"
import { createCommandRegistry, registerDefaultCommands, parseSlashCommand } from "./commands"
import { createTraceId } from "../nerves"
import { emitNervesEvent } from "../nerves/runtime"
import { FileFriendStore } from "../mind/friends/store-file"
import { TRUSTED_LEVELS, type FriendRecord } from "../mind/friends/types"
import type { FriendStore } from "../mind/friends/store"
import { FriendResolver } from "../mind/friends/resolver"
import { accumulateFriendTokens } from "../mind/friends/tokens"
import { createTurnCoordinator } from "../heart/turn-coordinator"
import { getAgentRoot, getAgentName } from "../heart/identity"
import { getSharedMcpManager } from "../repertoire/mcp-manager"
import { buildProgressStory, renderProgressStory } from "../heart/progress-story"
import * as http from "http"
import * as path from "path"
import { enforceTrustGate } from "./trust-gate"
import { handleInboundTurn, type FailoverState } from "./pipeline"

const teamsFailoverStates = new Map<string, FailoverState>()
import { drainDeferredReturns, drainPending, getPendingDir } from "../mind/pending"
import { classifySteeringFollowUpEffect, type SteeringFollowUpEffect } from "./continuity"

// Stream interface matching IStreamer from @microsoft/teams.apps
// emit() accepts string or object with text+entities+channelData (matches SDK's
// IStreamer.emit(activity: Partial<IMessageActivity | ITypingActivity> | string))
interface TeamsStream {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  emit(activity: string | Record<string, any>): void
  update(text: string): void
  close(): void
}

// AIGeneratedContent entity and feedbackLoopEnabled channelData for all outbound
// Teams messages. Required by Teams AI UX best practices.
export function aiLabelEntities(): Array<{ type: string; "@type": string; "@context": string; additionalType: string[] }> {
  return [{
    type: "https://schema.org/Message",
    "@type": "Message",
    "@context": "https://schema.org",
    additionalType: ["AIGeneratedContent"],
  }]
}

// Strip @mention markup from incoming messages.
// Removes <at>...</at> tags and trims extra whitespace.
// Fallback safety net -- the SDK's activity.mentions.stripText should handle
// this automatically, but this utility is exported for testability.
export function stripMentions(text: string): string {
  if (!text) return ""
  return text.replace(/<at>[^<]*<\/at>/g, "").trim()
}

// Recovery chunk size for error-recovery splitting. When a full-text send fails
// (e.g. 413 from Teams), we split into chunks of this size and retry.
// Not used preemptively — the harness tries to send the full message first.
const RECOVERY_CHUNK_SIZE = 4000

// Default interval (ms) for the periodic flush timer in chunked streaming mode.
// Text is accumulated in textBuffer and flushed via safeEmit/safeSend at this
// interval. This replaces per-token streaming, which caused compounding latency:
//
// - Teams throttles streaming updates to 1 req/sec with exponential backoff
//   https://learn.microsoft.com/en-us/microsoftteams/platform/bots/streaming-ux
// - SDK debounces at 500ms internally and re-sends ALL cumulative text each chunk
// - Per-token streaming generates 100+ HTTP POSTs per response, each throttled
// - Copilot enforces a 15s timeout for the initial stream.emit()
//   https://learn.microsoft.com/en-us/answers/questions/2288017/m365-custom-engine-agents-timeout-message-after-15
//
// At 1000ms (1 req/sec), we stay at the Teams throttle floor while keeping the
// stream alive well within the 15s Copilot timeout. Tune up if 429s observed.
export const DEFAULT_FLUSH_INTERVAL_MS = 1_000

// Split text into chunks that fit within maxLen, breaking at paragraph
// boundaries (\n\n), then line boundaries (\n), then word boundaries.
// Never loses content — all text is preserved across chunks.
export function splitMessage(text: string, maxLen: number): string[] {
  if (text.length <= maxLen) return [text]
  const chunks: string[] = []
  let remaining = text
  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining)
      break
    }
    // Find best split point: paragraph > line > word > hard cut
    const slice = remaining.slice(0, maxLen)
    let splitAt = slice.lastIndexOf("\n\n")
    if (splitAt <= 0) splitAt = slice.lastIndexOf("\n")
    if (splitAt <= 0) splitAt = slice.lastIndexOf(" ")
    if (splitAt <= 0) splitAt = maxLen // hard cut as last resort
    chunks.push(remaining.slice(0, splitAt))
    remaining = remaining.slice(splitAt).replace(/^[\n ]+/, "") // trim leading whitespace from next chunk
  }
  return chunks
}

// Sanitize user-provided feedback comments: truncate, strip control chars and newlines.
export function sanitizeFeedbackComment(comment: string): string {
  const cleaned = comment.replace(/[\x00-\x1f\n\r]/g, "")
  return cleaned.length > 200 ? cleaned.slice(0, 200) : cleaned
}

// Build synthetic message text from a Teams feedback reaction.
export function buildFeedbackSyntheticText(reaction: string, comment?: string): string {
  const emoji = reaction === "like" ? "thumbs-up" : "thumbs-down"
  if (comment) {
    const sanitized = sanitizeFeedbackComment(comment)
    return `[reacted with ${emoji} to your message: "${sanitized}"]`
  }
  return `[reacted with ${emoji} to your message]`
}

// Options for createTeamsCallbacks controlling streaming behavior.
export interface TeamsCallbackOptions {
  flushIntervalMs?: number
  conversationId?: string
  /** When true, suppress the "(completed with tool calls only)" fallback in flush(). */
  suppressEmptyStreamMessage?: boolean
}

// Extended callbacks type that includes flush() for chunked streaming.
// flush() is async (awaits sendMessage for content after the first emit).
export type TeamsCallbacksWithFlush = ChannelCallbacks & { flush(): void | Promise<void> }

// Create Teams-specific callbacks for the agent loop.
// The SDK handles cumulative text, debouncing (500ms), and the streaming
// protocol (streamSequence, streamId, informative/streaming/final types).
//
// Chunked streaming (unified mode):
// Text is always accumulated in textBuffer and flushed periodically (via a
// flush timer started on first onTextChunk) or at end-of-turn via flush().
// First flush goes to safeEmit (primary output), subsequent flushes go to
// safeSend (ctx.send). Tool results, kicks, and errors use safeUpdate
// (transient status) or safeSend (terminal errors). Reasoning is accumulated
// and periodically pushed via safeUpdate on the same flush timer tick.
export function createTeamsCallbacks(
  stream: TeamsStream,
  controller: AbortController,
  sendMessage?: (text: string) => Promise<void>,
  options?: TeamsCallbackOptions,
): TeamsCallbacksWithFlush {
  let stopped = false // set when stream signals cancellation (403)
  let hadToolRun = false
  let hadRealOutput = false // true once reasoning/tool output shown; suppresses phrases
  let reasoningBuf = "" // accumulated reasoning text for status display
  let textBuffer = "" // accumulated text output for chunked streaming
  let streamHasContent = false // tracks whether primary output has received content
  let phraseTimer: NodeJS.Timeout | null = null
  let lastPhrase = ""
  let flushTimer: NodeJS.Timeout | null = null
  const flushInterval = options?.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS

  // Track whether reasoning has changed since last flush (avoid redundant updates).
  let lastFlushedReasoningLen = 0

  // Periodic tick: flush text buffer and push reasoning updates.
  function flushTick(): void {
    flushTextBuffer()
    if (reasoningBuf.length > lastFlushedReasoningLen) {
      safeUpdate(reasoningBuf)
      lastFlushedReasoningLen = reasoningBuf.length
    }
  }

  // Start the periodic flush timer. Idempotent -- no-op if already running.
  function startFlushTimer(): void {
    if (flushTimer) return
    flushTimer = setInterval(flushTick, flushInterval)
  }

  // Stop the periodic flush timer. Idempotent.
  function stopFlushTimer(): void {
    if (flushTimer) { clearInterval(flushTimer); flushTimer = null }
  }

  // Mark stream as broken and abort the agent loop.
  function markStopped(): void {
    if (stopped) return
    stopped = true
    stopPhraseRotation()
    stopFlushTimer()
    controller.abort()
  }

  // Clean up timers when the controller is aborted externally
  controller.signal.addEventListener("abort", () => {
    stopPhraseRotation()
    stopFlushTimer()
  })

  // Handle the result of a stream call: if it returns a Promise (the Teams SDK
  // does async HTTP under the hood even though the interface types it as void),
  // catch its rejection so we detect a dead stream and abort the agent loop.
  function catchAsync(result: unknown): void {
    if (result && typeof (result as { catch?: Function }).catch === "function") {
      (result as Promise<unknown>).catch(() => markStopped())
    }
  }

  // Safely emit a text delta to the stream with AI labels.
  // On error (e.g. 403 from Teams stop button), abort the controller.
  function safeEmit(text: string): void {
    /* v8 ignore next -- defensive guard: stopped set by prior 403; tested via flush abort path @preserve */
    if (stopped) return
    try {
      catchAsync(stream.emit({ text, entities: aiLabelEntities(), channelData: { feedbackLoopEnabled: true } }))
      streamHasContent = true
    } catch {
      markStopped()
    }
  }

  // Awaitable emit — returns true if the emit succeeded, false if it failed.
  // Used by flush() so it can fall back to sendMessage on async 413/failure.
  async function tryEmit(text: string): Promise<boolean> {
    /* v8 ignore next -- defensive guard: stopped set by prior error; tested via flush abort path @preserve */
    if (stopped) return false
    try {
      // stream.emit() is typed as void but the Teams SDK returns a Promise
      // internally (async HTTP). Cast to capture the result for awaiting.
      const result: unknown = stream.emit({ text, entities: aiLabelEntities(), channelData: { feedbackLoopEnabled: true } })
      streamHasContent = true
      if (result && typeof (result as { then?: Function }).then === "function") {
        await (result as Promise<unknown>)
      }
      return true
    } catch {
      markStopped()
      return false
    }
  }

  // Safely send a status update to the stream.
  // On error (e.g. 403 from Teams stop button), abort the controller.
  function safeUpdate(text: string): void {
    if (stopped) return
    try {
      catchAsync(stream.update(text))
    } catch {
      markStopped()
    }
  }

  // Safely send a separate message via sendMessage (for content after first emit).
  // Serialized via promise chain -- concurrent calls execute sequentially.
  // If any send fails, the chain halts via markStopped().
  let sendChain = Promise.resolve()
  let sendChainBusy = false
  function safeSend(text: string): void {
    if (stopped || !sendMessage) return
    if (!sendChainBusy) {
      // Chain is idle -- start the send synchronously and mark busy
      sendChainBusy = true
      try {
        sendChain = sendMessage(text).catch(() => markStopped()).finally(() => { sendChainBusy = false })
      } catch {
        sendChainBusy = false
        markStopped()
      }
    } else {
      // Chain is busy -- queue onto the existing chain
      sendChain = sendChain.then(() => {
        if (stopped) return
        return sendMessage(text)
      }).catch(() => markStopped())
    }
  }

  // Flush accumulated text buffer via safeEmit. The Teams SDK accumulates
  // emitted text into a single streaming message (cumulative), so every
  // periodic flush appends to the same response — not separate messages.
  // No preemptive splitting — sends full text. Error recovery happens in flush().
  function flushTextBuffer(): void {
    if (!textBuffer) return
    safeEmit(textBuffer)
    textBuffer = ""
  }

  function startPhraseRotation(pool: readonly string[]): void {
    stopPhraseRotation()
    phraseTimer = setInterval(() => {
      const next = pickPhrase(pool, lastPhrase)
      lastPhrase = next
      safeUpdate(next + "...")
    }, 1500)
  }

  function stopPhraseRotation(): void {
    if (phraseTimer) { clearInterval(phraseTimer); phraseTimer = null }
  }

  return {
    onModelStart: () => {
      if (hadRealOutput) return // real output already shown; don't overwrite with phrases
      const phrases = getPhrases()
      const pool = hadToolRun ? phrases.followup : phrases.thinking
      const first = pickPhrase(pool)
      lastPhrase = first
      safeUpdate(first + "...")
      startPhraseRotation(pool)
    },
    onModelStreamStart: () => {
      // No-op: don't stop rotation here — keep cycling phrases through
      // the reasoning phase until actual content arrives.
    },
    onReasoningChunk: (text: string) => {
      /* v8 ignore next -- defensive guard: stopped set by prior error @preserve */
      if (stopped) return
      stopPhraseRotation()
      hadRealOutput = true
      reasoningBuf += text
      startFlushTimer()
    },
    onTextChunk: (text: string) => {
      if (stopped) return
      stopPhraseRotation()
      textBuffer += text
      startFlushTimer()
    },
    onClearText: () => {
      textBuffer = ""
    },
    onToolStart: (name: string, args: Record<string, string>) => {
      stopPhraseRotation()
      flushTextBuffer()
      // Emit a placeholder to satisfy the 15s Copilot timeout for initial
      // stream.emit(). Without this, long tool chains (e.g. ADO batch ops)
      // never emit before the timeout and the user sees "this response was
      // stopped". The placeholder is replaced by actual content on next emit.
      // https://learn.microsoft.com/en-us/answers/questions/2288017/m365-custom-engine-agents-timeout-message-after-15
      if (!streamHasContent) safeEmit("⏳")
      const argSummary = summarizeArgs(name, args) || Object.keys(args).join(", ")
      safeUpdate(renderProgressStory(buildProgressStory({
        scope: "shared-work",
        phase: "processing",
        objective: `running ${name} (${argSummary})...`,
      })))
      hadToolRun = true
    },
    onToolEnd: (name: string, summary: string, success: boolean) => {
      stopPhraseRotation()
      const msg = formatToolResult(name, summary, success)
      safeUpdate(renderProgressStory(buildProgressStory({
        scope: "shared-work",
        phase: "processing",
        objective: msg,
      })))
    },
    onKick: () => {
      stopPhraseRotation()
      const msg = formatKick()
      safeUpdate(msg)
    },
    onError: (error: Error, severity: "transient" | "terminal") => {
      stopPhraseRotation()
      if (stopped) return
      const msg = renderProgressStory(buildProgressStory({
        scope: "shared-work",
        phase: "errored",
        outcomeText: formatError(error),
      }))
      if (severity === "transient") {
        safeUpdate(msg)
      } else {
        safeSend(msg)
      }
    },
    onConfirmAction: options?.conversationId
      ? async (name: string, args: Record<string, string>) => {
          const convId = options.conversationId!
          const argsDesc = Object.entries(args).map(([k, v]) => `${k}: ${v}`).join(", ")
          safeUpdate(`Confirm action: ${name} (${argsDesc}) -- reply "yes" to confirm or "no" to cancel`)
          return new Promise<"confirmed" | "denied">((resolve) => {
            _pendingConfirmations.set(convId, resolve)
            // Auto-deny after 2 minutes to prevent indefinite blocking
            // (e.g. when the stream dies and the user never sees the prompt).
            setTimeout(() => {
              if (_pendingConfirmations.has(convId)) {
                _pendingConfirmations.delete(convId)
                resolve("denied")
              }
            }, 120_000)
          })
        }
      : undefined,
    flush: async () => {
      stopFlushTimer()
      if (textBuffer) {
        const text = textBuffer
        textBuffer = ""
        if (!stopped) {
          // Stream is alive — await the emit so we can catch async 413/failure
          // and fall through to sendMessage recovery.
          const ok = await tryEmit(text)
          if (!ok) markStopped()
        }
        if (stopped && sendMessage) {
          // Stream is dead — fall back to sendMessage; split on failure as recovery.
          try {
            await sendMessage(text)
          } catch {
            const chunks = splitMessage(text, RECOVERY_CHUNK_SIZE)
            for (const chunk of chunks) await sendMessage(chunk)
          }
        }
      } else if (!streamHasContent && !options?.suppressEmptyStreamMessage) {
        safeEmit("(completed with tool calls only — no text response)")
      }
    },
  }
}

// Per-conversation pending confirmation resolvers.
// When a mutate tool needs confirmation, the resolver is stored here.
// The next message from the same conversation resolves it.
const _pendingConfirmations = new Map<string, (decision: "confirmed" | "denied") => void>()

// Confirmation response words (case-insensitive)
const CONFIRM_WORDS = new Set(["yes", "confirm", "go", "y", "ok", "approve", "proceed"])

export function resolvePendingConfirmation(convId: string, text: string): boolean {
  const resolver = _pendingConfirmations.get(convId)
  if (!resolver) return false
  _pendingConfirmations.delete(convId)
  const word = text.trim().toLowerCase()
  if (CONFIRM_WORDS.has(word)) {
    resolver("confirmed")
  } else {
    resolver("denied")
  }
  return true
}

const _turnCoordinator = createTurnCoordinator()

function teamsTurnKey(conversationId: string): string {
  return `teams:${conversationId}`
}

export async function withConversationLock(convId: string, fn: () => Promise<void>): Promise<void> {
  await _turnCoordinator.withTurnLock(teamsTurnKey(convId), fn)
}

// Create a fresh friend store per request so mkdirSync re-runs if directories
// are deleted while the process is alive.
function getFriendStore(): InstanceType<typeof FileFriendStore> {
  const friendsPath = path.join(getAgentRoot(), "friends")
  return new FileFriendStore(friendsPath)
}

// Context from the Teams activity that carries OAuth tokens and signin ability
export interface TeamsMessageContext {
  graphToken?: string
  adoToken?: string
  githubToken?: string
  signin: (connectionName: string) => Promise<string | undefined>
  // AAD identity fields (extracted from bot activity)
  aadObjectId?: string
  tenantId?: string
  displayName?: string
  // Resolved OAuth connection names for this tenant
  graphConnectionName?: string
  adoConnectionName?: string
  githubConnectionName?: string
  // Bot Framework API client for proactive messaging
  botApi?: ToolContext["botApi"]
}

function createTeamsCommandRegistry() {
  const registry = createCommandRegistry()
  registerDefaultCommands(registry)
  return registry
}

function handleTeamsSlashCommand(
  text: string,
  registry: ReturnType<typeof createCommandRegistry>,
  friendId: string,
  conversationId: string,
  stream: TeamsStream,
  emitResponse = true,
): "new" | "response" | null {
  const parsed = parseSlashCommand(text)
  if (!parsed) return null

  const dispatchResult = registry.dispatch(parsed.command, { channel: "teams" })
  if (!dispatchResult.handled || !dispatchResult.result) {
    return null
  }

  if (dispatchResult.result.action === "new") {
    deleteSession(sessionPath(friendId, "teams", conversationId))
    if (emitResponse) {
      stream.emit("session cleared")
    }
    return "new"
  }

  if (dispatchResult.result.action === "response") {
    if (emitResponse) {
      stream.emit(dispatchResult.result.message || "")
    }
    return "response"
  }

  return null
}

// Handle an incoming Teams message
export async function handleTeamsMessage(text: string, stream: TeamsStream, conversationId: string, teamsContext?: TeamsMessageContext, sendMessage?: (text: string) => Promise<void>, reactionOverrides?: { isReactionSignal?: boolean; suppressEmptyStreamMessage?: boolean }): Promise<void> {
  const turnKey = teamsTurnKey(conversationId)
  // NOTE: Confirmation resolution is handled in the app.on("message") handler
  // BEFORE the conversation lock.  By the time we get here, any pending
  // confirmation has already been resolved and the reply consumed.

  // Send first thinking phrase immediately so the user sees feedback
  // before sync I/O (session load, trim) blocks the event loop.
  // Skip for reaction signals — they should be processed quietly.
  if (!reactionOverrides) {
    stream.update(pickPhrase(getPhrases().thinking) + "...")
  }
  await new Promise(r => setImmediate(r))

  // Resolve identity provider early for friend resolution + slash command session path
  const store = getFriendStore()
  const provider = teamsContext?.aadObjectId ? "aad" as const : "teams-conversation" as const
  const externalId = teamsContext?.aadObjectId || conversationId

  // Build FriendResolver for the pipeline
  const resolver = new FriendResolver(store, {
    provider,
    externalId,
    tenantId: teamsContext?.tenantId,
    displayName: teamsContext?.displayName || "Unknown",
    channel: "teams",
  })

  // Pre-resolve friend for session path + slash commands (pipeline will re-use the cached result)
  const resolvedContext = await resolver.resolve()
  const friendId = resolvedContext.friend.id

  const registry = createTeamsCommandRegistry()

  // Check for slash commands (before pipeline -- these are transport-level concerns)
  if (handleTeamsSlashCommand(text, registry, friendId, conversationId, stream)) {
    return
  }

  // ── Teams adapter concerns: controller, callbacks, session path ──────────
  const controller = new AbortController()
  const channelConfig = getTeamsChannelConfig()
  const callbacks = createTeamsCallbacks(stream, controller, sendMessage, { conversationId, flushIntervalMs: channelConfig.flushIntervalMs, ...(reactionOverrides?.suppressEmptyStreamMessage ? { suppressEmptyStreamMessage: true } : {}) })
  const traceId = createTraceId()
  const sessPath = sessionPath(friendId, "teams", conversationId)
  const teamsCapabilities = getChannelCapabilities("teams")
  const pendingDir = getPendingDir(getAgentName(), friendId, "teams", conversationId)

  // Build Teams-specific toolContext fields for injection into the pipeline
  const teamsToolContext: Partial<ToolContext> = teamsContext ? {
    graphToken: teamsContext.graphToken,
    adoToken: teamsContext.adoToken,
    githubToken: teamsContext.githubToken,
    signin: teamsContext.signin,
    summarize: createSummarize(),
    tenantId: teamsContext.tenantId,
    botApi: teamsContext.botApi,
  } : {}

  let currentText = text
  const mcpManager = await getSharedMcpManager() ?? undefined

  while (true) {
    let drainedSteeringFollowUps: Array<{ text: string; effect?: SteeringFollowUpEffect }> = []

    // Build runAgentOptions with Teams-specific fields
    const agentOptions: RunAgentOptions = {
      traceId,
      toolContext: teamsToolContext as ToolContext,
      mcpManager,
      drainSteeringFollowUps: () => {
        drainedSteeringFollowUps = _turnCoordinator.drainFollowUps(turnKey)
          .map(({ text: followUpText, effect }) => ({ text: followUpText, effect }))
        return drainedSteeringFollowUps
      },
      ...(reactionOverrides?.isReactionSignal ? { isReactionSignal: true } : {}),
    }
    if (channelConfig.skipConfirmation) agentOptions.skipConfirmation = true

    // ── Call shared pipeline ──────────────────────────────────────────

    // Capture terminal errors — failover message replaces the error card if it triggers
    let capturedTerminalError: Error | null = null
    const teamsFailoverState = (() => {
      if (!teamsFailoverStates.has(conversationId)) {
        teamsFailoverStates.set(conversationId, { pending: null })
      }
      return teamsFailoverStates.get(conversationId)!
    })()
    /* v8 ignore start -- failover-aware callback wrapper: tested via pipeline integration @preserve */
    const failoverAwareCallbacks: typeof callbacks = {
      ...callbacks,
      onError: (error: Error, severity: "transient" | "terminal") => {
        if (severity === "terminal" && teamsFailoverState) {
          capturedTerminalError = error
          return
        }
        callbacks.onError(error, severity)
      },
    }
    /* v8 ignore stop */

    const result = await handleInboundTurn({
      channel: "teams",
      sessionKey: conversationId,
      capabilities: teamsCapabilities,
      messages: [{ role: "user" as const, content: currentText }],
      continuityIngressTexts: [currentText],
      callbacks: failoverAwareCallbacks,
      friendResolver: { resolve: () => Promise.resolve(resolvedContext) },
      sessionLoader: {
        loadOrCreate: async () => {
          const existing = loadSession(sessPath)
          const messages: OpenAI.ChatCompletionMessageParam[] = existing?.messages && existing.messages.length > 0
            ? existing.messages
            : [{ role: "system", content: await buildSystem("teams", { mcpManager }, resolvedContext) }]
          repairOrphanedToolCalls(messages)
          return {
            messages,
            sessionPath: sessPath,
            state: existing?.state,
          }
        },
      },
      pendingDir,
      friendStore: store,
      provider,
      externalId,
      tenantId: teamsContext?.tenantId,
      isGroupChat: false,
      groupHasFamilyMember: false,
      hasExistingGroupWithFamily: false,
      enforceTrustGate,
      drainPending,
      drainDeferredReturns: (deferredFriendId) => drainDeferredReturns(getAgentName(), deferredFriendId),
      runAgent: (msgs, cb, channel, sig, opts) => runAgent(msgs, cb, channel, sig, {
        ...opts,
        toolContext: {
          /* v8 ignore next -- default no-op signin; pipeline provides the real one @preserve */
          signin: async () => undefined,
          ...opts?.toolContext,
          summarize: teamsToolContext.summarize,
        },
      }),
      postTurn,
      accumulateFriendTokens,
      signal: controller.signal,
      runAgentOptions: agentOptions,
      failoverState: teamsFailoverState,
    })

    /* v8 ignore start -- failover display: tested via pipeline integration tests @preserve */
    if (result.failoverMessage) {
      stream.emit(result.failoverMessage)
    } else if (capturedTerminalError) {
      callbacks.onError(capturedTerminalError, "terminal")
    }
    /* v8 ignore stop */

    // ── Handle gate result ────────────────────────────────────────
    if (!result.gateResult.allowed) {
      if ("autoReply" in result.gateResult && result.gateResult.autoReply) {
        stream.emit(result.gateResult.autoReply)
      }
      return
    }

    // Flush any remaining accumulated text at end of turn
    await callbacks.flush()

    // After the agent loop, check if any tool returned AUTH_REQUIRED and trigger signin.
    // This must happen after the stream is done so the OAuth card renders properly.
    if (teamsContext && result.messages) {
      const allContent = result.messages.map(m => typeof m.content === "string" ? m.content : "").join("\n")
      if (allContent.includes("AUTH_REQUIRED:graph") && teamsContext.graphConnectionName) await teamsContext.signin(teamsContext.graphConnectionName)
      if (allContent.includes("AUTH_REQUIRED:ado") && teamsContext.adoConnectionName) await teamsContext.signin(teamsContext.adoConnectionName)
      if (allContent.includes("AUTH_REQUIRED:github") && teamsContext.githubConnectionName) await teamsContext.signin(teamsContext.githubConnectionName)
    }

    if (result.turnOutcome !== "superseded") {
      return
    }

    const supersedingIndex = drainedSteeringFollowUps
      .map((followUp) => followUp.effect)
      .lastIndexOf("clear_and_supersede")
    if (supersedingIndex < 0) {
      return
    }
    const supersedingFollowUp = drainedSteeringFollowUps[supersedingIndex]
    const replayTail = drainedSteeringFollowUps
      .slice(supersedingIndex + 1)
      .map((followUp) => followUp.text.trim())
      .filter((followUpText) => followUpText.length > 0)
      .join("\n")

    if (replayTail) {
      currentText = replayTail
      continue
    }

    if (handleTeamsSlashCommand(supersedingFollowUp.text, registry, friendId, conversationId, stream, false)) {
      return
    }

    currentText = supersedingFollowUp.text
  }
}

// Internal port for the secondary bot App (not exposed externally).
// The primary app proxies /api/messages-secondary → localhost:SECONDARY_PORT/api/messages.
const SECONDARY_INTERNAL_PORT = 3979

// Collect all unique OAuth connection names across top-level config and tenant overrides.
/* v8 ignore start -- runtime Teams SDK config; no unit-testable surface @preserve */
function allOAuthConnectionNames(): string[] {
  const oauthConfig = getOAuthConfig()
  const names = new Set<string>()
  if (oauthConfig.graphConnectionName) names.add(oauthConfig.graphConnectionName)
  if (oauthConfig.adoConnectionName) names.add(oauthConfig.adoConnectionName)
  if (oauthConfig.githubConnectionName) names.add(oauthConfig.githubConnectionName)
  if (oauthConfig.tenantOverrides) {
    for (const ov of Object.values(oauthConfig.tenantOverrides)) {
      if (ov.graphConnectionName) names.add(ov.graphConnectionName)
      if (ov.adoConnectionName) names.add(ov.adoConnectionName)
      if (ov.githubConnectionName) names.add(ov.githubConnectionName)
    }
  }
  return [...names]
}

// Create an App instance from a TeamsConfig. Returns { app, mode }.
function createBotApp(teamsConfig: { clientId: string, clientSecret: string, tenantId: string, managedIdentityClientId: string }): { app: InstanceType<typeof App>, mode: string } {
  const mentionStripping = { activity: { mentions: { stripText: true as const } } }
  const oauthConfig = getOAuthConfig()

  if (teamsConfig.clientId && teamsConfig.clientSecret) {
    return {
      app: new App({
        clientId: teamsConfig.clientId,
        clientSecret: teamsConfig.clientSecret,
        tenantId: teamsConfig.tenantId,
        oauth: { defaultConnectionName: oauthConfig.graphConnectionName },
        ...mentionStripping,
      }),
      mode: "Bot Service (client secret)",
    }
  } else if (teamsConfig.clientId) {
    return {
      app: new App({
        clientId: teamsConfig.clientId,
        tenantId: teamsConfig.tenantId,
        ...(teamsConfig.managedIdentityClientId ? { managedIdentityClientId: teamsConfig.managedIdentityClientId } : {}),
        oauth: { defaultConnectionName: oauthConfig.graphConnectionName },
        ...mentionStripping,
      }),
      mode: "Bot Service (managed identity)",
    }
  } else {
    return {
      app: new App({
        plugins: [new DevtoolsPlugin()],
        ...mentionStripping,
      }),
      mode: "DevtoolsPlugin",
    }
  }
}
/* v8 ignore stop */

// Register message, verify-state, and error handlers on an App instance.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function registerBotHandlers(app: InstanceType<typeof App> & { id?: string; api?: any }, label: string): void {
  const connectionNames = allOAuthConnectionNames()

  // Override default OAuth verify-state handler.  The SDK's built-in handler
  // uses a single defaultConnectionName, which breaks multi-connection setups
  // (graph + ado + github).  The verifyState activity only carries a `state`
  // code with no connectionName, so we try each configured connection until
  // one succeeds.
  app.on("signin.verify-state", async (ctx) => {
    const { api, activity } = ctx
    if (!activity.value?.state) return { status: 404 }
    for (const cn of connectionNames) {
      try {
        await api.users.token.get({
          channelId: activity.channelId,
          userId: activity.from.id,
          connectionName: cn,
          code: activity.value.state,
        })
        emitNervesEvent({ level: "info", event: "channel.verify_state", component: "channels", message: `[${label}] verify-state succeeded for connection "${cn}"`, meta: { connectionName: cn } })
        return { status: 200 }
      } catch { /* try next */ }
    }
    emitNervesEvent({ level: "warn", event: "channel.verify_state", component: "channels", message: `[${label}] verify-state failed for all connections`, meta: {} })
    return { status: 412 }
  })

  app.on("message", async (ctx) => {
    const { stream, activity, api, signin } = ctx
    const text = activity.text || ""
    const convId = activity.conversation?.id || "unknown"
    const turnKey = teamsTurnKey(convId)
    const userId = activity.from?.id || ""
    const channelId = activity.channelId || "msteams"

    emitNervesEvent({ level: "info", event: "channel.message_received", component: "channels", message: `[${label}] incoming teams message`, meta: { userId: userId.slice(0, 12), conversationId: convId.slice(0, 20) } })

    // Resolve pending confirmations IMMEDIATELY — before token fetches or
    // the conversation lock.  The original message holds the lock while
    // awaiting confirmation, so acquiring it here would deadlock.  Token
    // fetches are also unnecessary (and slow) for a simple yes/no reply.
    if (resolvePendingConfirmation(convId, text)) {
      return
    }

    const commandRegistry = createTeamsCommandRegistry()
    const parsedSlashCommand = parseSlashCommand(text)
    if (parsedSlashCommand) {
      const dispatchResult = commandRegistry.dispatch(parsedSlashCommand.command, { channel: "teams" })
      if (dispatchResult.handled && dispatchResult.result) {
        if (dispatchResult.result.action === "response") {
          stream.emit(dispatchResult.result.message || "")
          return
        }
        if (dispatchResult.result.action === "new") {
          const commandStore = getFriendStore()
          const commandProvider = activity.from?.aadObjectId ? "aad" as const : "teams-conversation" as const
          const commandExternalId = activity.from?.aadObjectId || convId
          const commandResolver = new FriendResolver(commandStore, {
            provider: commandProvider,
            externalId: commandExternalId,
            tenantId: activity.conversation?.tenantId,
            displayName: activity.from?.name || "Unknown",
            channel: "teams",
          })
          const commandContext = await commandResolver.resolve()
          deleteSession(sessionPath(commandContext.friend.id, "teams", convId))
          stream.emit("session cleared")
          if (_turnCoordinator.isTurnActive(turnKey)) {
            _turnCoordinator.enqueueFollowUp(turnKey, {
              conversationId: convId,
              text,
              receivedAt: Date.now(),
              effect: "clear_and_supersede",
            })
          }
          return
        }
      }
    }

    // If this conversation already has an active turn, steer follow-up input
    // into that turn and avoid starting a second concurrent turn.
    if (!_turnCoordinator.tryBeginTurn(turnKey)) {
      _turnCoordinator.enqueueFollowUp(turnKey, {
        conversationId: convId,
        text,
        receivedAt: Date.now(),
        effect: classifySteeringFollowUpEffect(text),
      })
      return
    }

    try {
      // Resolve OAuth connection names for this user's tenant (supports per-tenant overrides).
      const tenantId = activity.conversation?.tenantId
      const tenantOAuth = resolveOAuthForTenant(tenantId)

      // Fetch tokens for both OAuth connections independently.
      // Failures are silently caught -- the tool handler will request signin if needed.
      let graphToken: string | undefined
      let adoToken: string | undefined
      let githubToken: string | undefined
      try {
        const graphRes = await api.users.token.get({ userId, connectionName: tenantOAuth.graphConnectionName, channelId })
        graphToken = graphRes?.token
      } catch { /* no token yet — tool handler will trigger signin */ }
      try {
        const adoRes = await api.users.token.get({ userId, connectionName: tenantOAuth.adoConnectionName, channelId })
        adoToken = adoRes?.token
      } catch { /* no token yet — tool handler will trigger signin */ }
      try {
        const githubRes = await api.users.token.get({ userId, connectionName: tenantOAuth.githubConnectionName, channelId })
        githubToken = githubRes?.token
      } catch { /* no token yet — tool handler will trigger signin */ }
      emitNervesEvent({ level: "info", event: "channel.token_status", component: "channels", message: "oauth token availability", meta: { graph: !!graphToken, ado: !!adoToken, github: !!githubToken, tenantId } })

      const teamsContext: TeamsMessageContext = {
        graphToken,
        adoToken,
        githubToken,
        signin: async (cn: string) => {
          try {
            const result = await signin({ connectionName: cn })
            emitNervesEvent({ level: "info", event: "channel.signin_result", component: "channels", message: `signin(${cn}): ${result ? "token received" : "no token"}`, meta: { connectionName: cn, hasToken: !!result } })
            return result
          } catch (e: unknown) {
            const msg = e instanceof Error ? e.message : String(e)
            emitNervesEvent({ level: "error", event: "channel.signin_error", component: "channels", message: `signin(${cn}) failed`, meta: { connectionName: cn, reason: msg.slice(0, 100) } })
            return undefined
          }
        },
        aadObjectId: activity.from?.aadObjectId,
        tenantId: activity.conversation?.tenantId,
        displayName: activity.from?.name,
        graphConnectionName: tenantOAuth.graphConnectionName,
        adoConnectionName: tenantOAuth.adoConnectionName,
        githubConnectionName: tenantOAuth.githubConnectionName,
        /* v8 ignore next -- bot API availability branch; requires live SDK context @preserve */
        botApi: app.id && api ? { id: app.id, conversations: api.conversations } : undefined,
      }

      /* v8 ignore next 5 -- bot-framework integration callback; tested via handleTeamsMessage sendMessage path @preserve */
      const ctxSend = async (t: string) => {
        // Use send with replyToId (not reply, which adds a blockquote).
        // replyToId anchors the message after the user's message in Copilot Chat.
        await ctx.send({ type: "message", text: t, replyToId: activity.id, entities: aiLabelEntities() as unknown as import("@microsoft/teams.api").Entity[], channelData: { feedbackLoopEnabled: true } })
      }
      await handleTeamsMessage(text, stream, convId, teamsContext, ctxSend)
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      emitNervesEvent({ level: "error", event: "channel.handler_error", component: "channels", message: msg.slice(0, 200), meta: {} })
    } finally {
      _turnCoordinator.endTurn(turnKey)
    }
  })

  app.event("error", ({ error }) => {
    const msg = error instanceof Error ? error.message : String(error)
    emitNervesEvent({ level: "error", event: "channel.app_error", component: "channels", message: `[${label}] ${msg}`, meta: {} })
  })
}

export interface TeamsDrainAndSendResult {
  sent: number
  skipped: number
  failed: number
}

export interface TeamsBotApi {
  id: string
  conversations: unknown
}

export interface ProactiveTeamsSessionSendParams {
  friendId: string
  sessionKey: string
  text: string
  intent?: "generic_outreach" | "explicit_cross_chat"
  authorizingSession?: {
    friendId: string
    channel: string
    key: string
    trustLevel?: string
  }
}

export interface ProactiveTeamsSessionSendResult {
  delivered: boolean
  reason?: "friend_not_found" | "trust_skip" | "missing_target" | "send_error"
}

interface ProactiveTeamsSessionSendDeps {
  botApi: TeamsBotApi
  store?: FriendStore
  createFriendStore?: () => FriendStore
}

function findAadObjectId(friend: FriendRecord): { aadObjectId: string; tenantId?: string } | undefined {
  for (const ext of friend.externalIds) {
    if (ext.provider === "aad" && !ext.externalId.startsWith("group:")) {
      return { aadObjectId: ext.externalId, tenantId: ext.tenantId }
    }
  }
  return undefined
}

function resolveTeamsFriendStore(deps: ProactiveTeamsSessionSendDeps): FriendStore {
  return deps.store
    ?? deps.createFriendStore?.()
    ?? new FileFriendStore(path.join(getAgentRoot(), "friends"))
}

function getTeamsConversations(botApi: TeamsBotApi): {
  create(params: Record<string, unknown>): Promise<{ id: string }>
  activities(conversationId: string): { create(params: Record<string, unknown>): Promise<unknown> }
} {
  return botApi.conversations as {
    create(params: Record<string, unknown>): Promise<{ id: string }>
    activities(conversationId: string): { create(params: Record<string, unknown>): Promise<unknown> }
  }
}

function hasExplicitCrossChatAuthorization(params: ProactiveTeamsSessionSendParams): boolean {
  return params.intent === "explicit_cross_chat"
    && TRUSTED_LEVELS.has((params.authorizingSession?.trustLevel as any) ?? "stranger")
}

export async function sendProactiveTeamsMessageToSession(
  params: ProactiveTeamsSessionSendParams,
  deps: ProactiveTeamsSessionSendDeps,
): Promise<ProactiveTeamsSessionSendResult> {
  const store = resolveTeamsFriendStore(deps)
  const conversations = getTeamsConversations(deps.botApi)

  let friend: FriendRecord | null
  try {
    friend = await store.get(params.friendId)
  } catch {
    friend = null
  }

  if (!friend) {
    emitNervesEvent({
      level: "warn",
      component: "senses",
      event: "senses.teams_proactive_no_friend",
      message: "proactive send skipped: friend not found",
      meta: { friendId: params.friendId, sessionKey: params.sessionKey },
    })
    return { delivered: false, reason: "friend_not_found" }
  }

  if (!hasExplicitCrossChatAuthorization(params) && !TRUSTED_LEVELS.has(friend.trustLevel ?? "stranger")) {
    emitNervesEvent({
      component: "senses",
      event: "senses.teams_proactive_trust_skip",
      message: "proactive send skipped: trust level not allowed",
      meta: {
        friendId: params.friendId,
        trustLevel: friend.trustLevel ?? "unknown",
        intent: params.intent ?? "generic_outreach",
        authorizingTrustLevel: params.authorizingSession?.trustLevel ?? null,
      },
    })
    return { delivered: false, reason: "trust_skip" }
  }

  const aadInfo = findAadObjectId(friend)
  if (!aadInfo) {
    emitNervesEvent({
      level: "warn",
      component: "senses",
      event: "senses.teams_proactive_no_aad_id",
      message: "proactive send skipped: no AAD object ID found",
      meta: { friendId: params.friendId, sessionKey: params.sessionKey },
    })
    return { delivered: false, reason: "missing_target" }
  }

  try {
    const conversation = await conversations.create({
      bot: { id: deps.botApi.id },
      members: [{ id: aadInfo.aadObjectId, role: "user", name: friend.name || aadInfo.aadObjectId }],
      tenantId: aadInfo.tenantId,
      isGroup: false,
    })
    await conversations.activities(conversation.id).create({
      type: "message",
      text: params.text,
    })

    emitNervesEvent({
      component: "senses",
      event: "senses.teams_proactive_sent",
      message: "proactive teams message sent",
      meta: { friendId: params.friendId, aadObjectId: aadInfo.aadObjectId, sessionKey: params.sessionKey },
    })
    return { delivered: true }
  } catch (error) {
    emitNervesEvent({
      level: "error",
      component: "senses",
      event: "senses.teams_proactive_send_error",
      message: "proactive teams send failed",
      meta: {
        friendId: params.friendId,
        aadObjectId: aadInfo.aadObjectId,
        sessionKey: params.sessionKey,
        reason: error instanceof Error ? error.message : String(error),
      },
    })
    return { delivered: false, reason: "send_error" }
  }
}

function scanPendingTeamsFiles(pendingRoot: string): Array<{
  friendId: string
  key: string
  filePath: string
  content: string
}> {
  const results: Array<{ friendId: string; key: string; filePath: string; content: string }> = []

  let friendIds: string[]
  try {
    friendIds = fs.readdirSync(pendingRoot)
  } catch {
    return results
  }

  for (const friendId of friendIds) {
    const teamsDir = path.join(pendingRoot, friendId, "teams")
    let keys: string[]
    try {
      keys = fs.readdirSync(teamsDir)
    } catch {
      continue
    }

    for (const key of keys) {
      const keyDir = path.join(teamsDir, key)
      let files: string[]
      try {
        files = fs.readdirSync(keyDir)
      } catch {
        continue
      }

      for (const file of files.filter((f) => f.endsWith(".json")).sort()) {
        const filePath = path.join(keyDir, file)
        try {
          const content = fs.readFileSync(filePath, "utf-8")
          results.push({ friendId, key, filePath, content })
        } catch {
          // skip unreadable files
        }
      }
    }
  }

  return results
}

export async function drainAndSendPendingTeams(
  store: FriendStore,
  botApi: TeamsBotApi,
  pendingRoot?: string,
): Promise<TeamsDrainAndSendResult> {
  const root = pendingRoot ?? path.join(getAgentRoot(), "state", "pending")

  const pendingFiles = scanPendingTeamsFiles(root)
  const result: TeamsDrainAndSendResult = { sent: 0, skipped: 0, failed: 0 }

  for (const { friendId, key, filePath, content } of pendingFiles) {
    let parsed: { content?: string }
    try {
      parsed = JSON.parse(content) as { content?: string }
    } catch {
      result.failed++
      try { fs.unlinkSync(filePath) } catch { /* ignore */ }
      continue
    }

    const messageText = typeof parsed.content === "string" ? parsed.content : ""
    if (!messageText.trim()) {
      result.skipped++
      try { fs.unlinkSync(filePath) } catch { /* ignore */ }
      continue
    }

    const sendResult = await sendProactiveTeamsMessageToSession({
      friendId,
      sessionKey: key,
      text: messageText,
      intent: "generic_outreach",
    }, {
      botApi,
      store,
    })

    if (sendResult.delivered) {
      result.sent++
      try { fs.unlinkSync(filePath) } catch { /* ignore */ }
      continue
    }

    if (sendResult.reason === "friend_not_found" || sendResult.reason === "trust_skip" || sendResult.reason === "missing_target") {
      result.skipped++
      try { fs.unlinkSync(filePath) } catch { /* ignore */ }
      continue
    }

    result.failed++
  }

  if (result.sent > 0 || result.skipped > 0 || result.failed > 0) {
    emitNervesEvent({
      component: "senses",
      event: "senses.teams_proactive_drain_complete",
      message: "teams proactive drain complete",
      meta: { sent: result.sent, skipped: result.skipped, failed: result.failed },
    })
  }

  return result
}

// Start the Teams app in DevtoolsPlugin mode (local dev) or Bot Service mode (real Teams).
// Mode is determined by getTeamsConfig().clientId.
// Text is always accumulated in textBuffer and flushed periodically (chunked streaming).
//
// Dual-bot support: if teamsSecondary is configured with a clientId, a second App
// instance starts on an internal port and the primary app proxies requests from
// /api/messages-secondary to it. This lets a single App Service serve two bot
// registrations (e.g. one per tenant) without SDK modifications.
export function startTeamsApp(): void {
  const teamsConfig = getTeamsConfig()
  const { app, mode } = createBotApp(teamsConfig)
  registerBotHandlers(app, "primary")

  // Prevent SDK internal stream errors (e.g. "Content stream is not allowed
  // on a already completed streamed message") from crashing the process.
  // Guard: only register once even if startTeamsApp is called multiple times.
  interface AgentHandler { (...args: unknown[]): void; __agentHandler?: boolean }
  if (!process.listeners("unhandledRejection").some((l) => (l as AgentHandler).__agentHandler)) {
    const handler: AgentHandler = (err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err)
      emitNervesEvent({ level: "error", event: "channel.unhandled_rejection", component: "channels", message: msg.slice(0, 200), meta: {} })
    }
    handler.__agentHandler = true
    process.on("unhandledRejection", handler)
  }

  /* v8 ignore next -- PORT env branch; runtime-only @preserve */
  const port = process.env.PORT ? Number(process.env.PORT) : getTeamsChannelConfig().port
  app.start(port)
  // Diagnostic: log tool count at startup to verify deploy
  const startupTools = getToolsForChannel(getChannelCapabilities("teams"))
  const toolNames = startupTools.map((t) => t.function.name)
  emitNervesEvent({ level: "info", event: "channel.app_started", component: "channels", message: `Teams bot started on port ${port} with ${mode} (chunked streaming)`, meta: { port, mode, toolCount: toolNames.length, hasProactive: toolNames.includes("teams_send_message") } })

  // --- Secondary bot (dual-bot support) ---
  // If teamsSecondary has a clientId, start a second App on an internal port
  // and proxy /api/messages-secondary on the primary app to it.
  /* v8 ignore start -- dual-bot proxy wiring; requires live Teams SDK + HTTP @preserve */
  const secondaryConfig = getTeamsSecondaryConfig()
  if (secondaryConfig.clientId) {
    const { app: secondaryApp, mode: secondaryMode } = createBotApp(secondaryConfig)
    registerBotHandlers(secondaryApp, "secondary")
    secondaryApp.start(SECONDARY_INTERNAL_PORT)
    emitNervesEvent({ level: "info", event: "channel.app_started", component: "channels", message: `Secondary bot started on internal port ${SECONDARY_INTERNAL_PORT} with ${secondaryMode}`, meta: { port: SECONDARY_INTERNAL_PORT, mode: secondaryMode } })

    // Proxy: forward /api/messages-secondary on the primary app's Express
    // to localhost:SECONDARY_INTERNAL_PORT/api/messages.
    // The SDK's HttpPlugin exposes .post() bound to its Express instance.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const httpPlugin = (app as any).http as { post: (...args: unknown[]) => void }
    httpPlugin.post("/api/messages-secondary", (req: { headers: Record<string, string>, body: unknown }, res: http.ServerResponse) => {
      const body = JSON.stringify(req.body)
      const proxyReq = http.request({
        hostname: "127.0.0.1",
        port: SECONDARY_INTERNAL_PORT,
        path: "/api/messages",
        method: "POST",
        headers: {
          ...req.headers,
          "content-length": Buffer.byteLength(body).toString(),
        },
      }, (proxyRes) => {
        res.writeHead(proxyRes.statusCode ?? 200, proxyRes.headers as Record<string, string | string[]>)
        proxyRes.pipe(res)
      })
      proxyReq.on("error", (err) => {
        emitNervesEvent({ level: "error", event: "channel.proxy_error", component: "channels", message: `secondary proxy error: ${err.message}`, meta: {} })
        if (!res.headersSent) {
          res.writeHead(502)
          res.end("Bad Gateway")
        }
      })
      proxyReq.write(body)
      proxyReq.end()
    })
    emitNervesEvent({ level: "info", event: "channel.proxy_ready", component: "channels", message: "proxy /api/messages-secondary → secondary bot ready", meta: {} })
  }
  /* v8 ignore stop */
}
