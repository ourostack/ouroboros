import type OpenAI from "openai"
import * as fs from "fs"
import * as path from "path"
import { sessionPath } from "../heart/config"
import { runAgent, type ChannelCallbacks, type CompletionMetadata } from "../heart/core"
import { getAgentName, getAgentRoot } from "../heart/identity"
import { loadSession, postTurn, type UsageData } from "../mind/context"
import { buildSystem } from "../mind/prompt"
import { getSharedMcpManager } from "../repertoire/mcp-manager"
import { findNonCanonicalBundlePaths } from "../mind/bundle-manifest"
import {
  drainPending,
  getInnerDialogPendingDir,
  getDeferredReturnDir,
  getPendingDir,
  INNER_DIALOG_PENDING,
  type PendingMessage,
  type DelegatedFrom,
} from "../mind/pending"
import { advanceObligation, listActiveObligations } from "../mind/obligations"
import { buildAttentionQueue, buildAttentionQueueSummary, type AttentionItem } from "./attention-queue"
import { getChannelCapabilities } from "../mind/friends/channel"
import { enforceTrustGate } from "./trust-gate"
import { accumulateFriendTokens } from "../mind/friends/tokens"
import { handleInboundTurn } from "./pipeline"
import { createTraceId } from "../nerves"
import { emitNervesEvent } from "../nerves/runtime"
import type { FriendRecord, ResolvedContext } from "../mind/friends/types"
import type { FriendStore } from "../mind/friends/store"
import { createBridgeManager } from "../heart/bridges/manager"
import { findFreshestFriendSession, listSessionActivity, type SessionActivityRecord } from "../heart/session-activity"
import { sendProactiveBlueBubblesMessageToSession } from "./bluebubbles"
import { findPendingObligationForOrigin, fulfillObligation } from "../heart/obligations"

export interface InnerDialogInstinct {
  id: string
  prompt: string
  enabled?: boolean
}

export interface InnerDialogState {
  cycleCount: number
  resting?: boolean
  lastHeartbeatAt?: string
  checkpoint?: string
}

export interface RunInnerDialogTurnOptions {
  reason?: "boot" | "heartbeat" | "instinct"
  taskId?: string
  instincts?: InnerDialogInstinct[]
  now?: () => Date
  signal?: AbortSignal
}

export interface InnerDialogTurnResult {
  messages: OpenAI.ChatCompletionMessageParam[]
  usage?: UsageData
  sessionPath: string
  completion?: CompletionMetadata
}

interface InnerDialogRuntimeState {
  status: "idle" | "running"
  reason?: "boot" | "heartbeat" | "instinct"
  startedAt?: string
  lastCompletedAt?: string
}

const DEFAULT_INNER_DIALOG_INSTINCTS: InnerDialogInstinct[] = [
  {
    id: "heartbeat_checkin",
    prompt: "...time passing. anything stirring?",
    enabled: true,
  },
]

function readAspirations(agentRoot: string): string {
  try {
    return fs.readFileSync(path.join(agentRoot, "psyche", "ASPIRATIONS.md"), "utf8").trim()
  } catch {
    return ""
  }
}

export function loadInnerDialogInstincts(): InnerDialogInstinct[] {
  return [...DEFAULT_INNER_DIALOG_INSTINCTS]
}

export function buildInnerDialogBootstrapMessage(aspirations: string, stateSummary: string): string {
  const lines = ["waking up."]
  if (aspirations) {
    lines.push("", "## what matters to me", aspirations)
  }
  if (stateSummary) {
    lines.push("", "## what i know so far", stateSummary)
  }
  lines.push("", "what needs my attention?")
  return lines.join("\n")
}

export function buildNonCanonicalCleanupNudge(nonCanonicalPaths: string[]): string {
  if (nonCanonicalPaths.length === 0) return ""
  const listed = nonCanonicalPaths.slice(0, 20).map((entry) => `- ${entry}`)
  if (nonCanonicalPaths.length > 20) {
    listed.push(`- ... (${nonCanonicalPaths.length - 20} more)`)
  }
  return [
    "## canonical cleanup nudge",
    "I found non-canonical files in my bundle. I should distill anything valuable into your memory system and remove these files.",
    ...listed,
  ].join("\n")
}

function displayCheckpoint(checkpoint?: string): string | undefined {
  const trimmed = checkpoint?.trim()
  if (!trimmed || trimmed === "no prior checkpoint recorded") {
    return undefined
  }
  return trimmed
}

export function buildInstinctUserMessage(
  instincts: InnerDialogInstinct[],
  _reason: "boot" | "heartbeat" | "instinct",
  state: InnerDialogState,
): string {
  const active = instincts.find((instinct) => instinct.enabled !== false) ?? DEFAULT_INNER_DIALOG_INSTINCTS[0]
  const checkpoint = displayCheckpoint(state.checkpoint)
  const lines = [active.prompt]
  if (checkpoint) {
    lines.push(`\nlast i remember: ${checkpoint}`)
  }
  return lines.join("\n")
}

export function readTaskFile(agentRoot: string, taskId: string): string {
  // Task files live in collection subdirectories (one-shots, ongoing, habits).
  // Try each collection, then fall back to root tasks/ for legacy layout.
  const collections = ["one-shots", "ongoing", "habits", ""]
  for (const collection of collections) {
    try {
      return fs.readFileSync(path.join(agentRoot, "tasks", collection, `${taskId}.md`), "utf8").trim()
    } catch {
      // not in this collection — try next
    }
  }
  return ""
}

export function buildTaskTriggeredMessage(taskId: string, taskContent: string, checkpoint?: string): string {
  const lines = ["a task needs my attention."]
  if (taskContent) {
    lines.push("", `## task: ${taskId}`, taskContent)
  } else {
    lines.push("", `## task: ${taskId}`, "(task file not found)")
  }
  const renderedCheckpoint = displayCheckpoint(checkpoint)
  if (renderedCheckpoint) {
    lines.push("", `last i remember: ${renderedCheckpoint}`)
  }
  return lines.join("\n")
}

function contentToText(content: unknown): string {
  if (typeof content === "string") return content.trim()
  if (!Array.isArray(content)) return ""
  const text = content
    .map((part) => {
      if (typeof part === "string") return part
      if (!part || typeof part !== "object") return ""
      if ("text" in part && typeof (part as { text?: unknown }).text === "string") {
        return (part as { text: string }).text
      }
      return ""
    })
    .join("\n")
  return text.trim()
}

export function deriveResumeCheckpoint(messages: OpenAI.ChatCompletionMessageParam[]): string {
  const lastAssistant = [...messages].reverse().find((message) => message.role === "assistant")
  if (!lastAssistant) return "no prior checkpoint recorded"
  const assistantText = contentToText(lastAssistant.content)
  if (!assistantText) return "no prior checkpoint recorded"

  const explicitCheckpoint = assistantText
    .split("\n")
    .map((line) => line.trim())
    .find((line) => /^checkpoint\s*:/i.test(line))
  if (explicitCheckpoint) {
    const parsed = explicitCheckpoint.replace(/^checkpoint\s*:\s*/i, "").trim()
    return parsed || "no prior checkpoint recorded"
  }

  const firstLine = assistantText
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0)
  /* v8 ignore next -- unreachable: contentToText().trim() guarantees a non-empty line @preserve */
  if (!firstLine) return "no prior checkpoint recorded"
  if (firstLine.length <= 220) return firstLine
  return `${firstLine.slice(0, 217)}...`
}

function extractAssistantPreview(messages: OpenAI.ChatCompletionMessageParam[], maxLength = 120): string {
  const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant")
  if (!lastAssistant) return ""
  const text = contentToText(lastAssistant.content)
  if (!text) return ""
  /* v8 ignore next -- unreachable: contentToText().trim() guarantees a non-empty line @preserve */
  const firstLine = text.split("\n").find((line) => line.trim().length > 0) ?? ""
  if (firstLine.length <= maxLength) return firstLine
  return `${firstLine.slice(0, maxLength - 3)}...`
}

function extractToolCallNames(messages: OpenAI.ChatCompletionMessageParam[]): string[] {
  const names: string[] = []
  for (const msg of messages) {
    if (msg.role === "assistant" && "tool_calls" in msg && Array.isArray(msg.tool_calls)) {
      for (const tc of msg.tool_calls) {
        if ("function" in tc && tc.function?.name) names.push(tc.function.name)
      }
    }
  }
  return [...new Set(names)]
}

function createInnerDialogCallbacks(): ChannelCallbacks {
  return {
    onModelStart: () => {},
    onModelStreamStart: () => {},
    onTextChunk: () => {},
    onReasoningChunk: () => {},
    onToolStart: () => {},
    onToolEnd: () => {},
    onError: () => {},
  }
}

export function innerDialogSessionPath(): string {
  return sessionPath(INNER_DIALOG_PENDING.friendId, INNER_DIALOG_PENDING.channel, INNER_DIALOG_PENDING.key)
}

function innerDialogRuntimeStatePath(sessionFilePath: string): string {
  return path.join(path.dirname(sessionFilePath), "runtime.json")
}

function writeInnerDialogRuntimeState(sessionFilePath: string, state: InnerDialogRuntimeState): void {
  const filePath = innerDialogRuntimeStatePath(sessionFilePath)
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    fs.writeFileSync(filePath, JSON.stringify(state, null, 2) + "\n", "utf8")
  } catch (error) {
    emitNervesEvent({
      level: "warn",
      component: "senses",
      event: "senses.inner_dialog_runtime_state_error",
      message: "failed to write inner dialog runtime state",
      meta: {
        status: state.status,
        reason: state.reason ?? null,
        path: filePath,
        /* v8 ignore next -- Node fs APIs throw Error objects for mkdirSync/writeFileSync failures @preserve */
        error: error instanceof Error ? error.message : String(error),
      },
    })
  }
}

/* v8 ignore start -- routing helpers: called from routing functions which are integration paths @preserve */
function writePendingEnvelope(pendingDir: string, message: PendingMessage): void {
  fs.mkdirSync(pendingDir, { recursive: true })
  const fileName = `${message.timestamp}-${Math.random().toString(36).slice(2, 10)}.json`
  const filePath = path.join(pendingDir, fileName)
  fs.writeFileSync(filePath, JSON.stringify(message, null, 2), "utf8")
}

function sessionMatchesActivity(
  activity: SessionActivityRecord,
  session: { friendId: string; channel: string; key: string },
): boolean {
  return activity.friendId === session.friendId
    && activity.channel === session.channel
    && activity.key === session.key
}
/* v8 ignore stop */

/* v8 ignore start -- routing: delivery now inline via surface tool; routing functions preserved for reuse @preserve */
function resolveBridgePreferredSession(
  delegatedFrom: NonNullable<PendingMessage["delegatedFrom"]>,
  sessionActivity: SessionActivityRecord[],
): SessionActivityRecord | null {
  if (!delegatedFrom.bridgeId) return null
  const bridge = createBridgeManager().getBridge(delegatedFrom.bridgeId)
  if (!bridge || bridge.lifecycle === "completed" || bridge.lifecycle === "cancelled") {
    return null
  }
  return sessionActivity.find((activity) =>
    activity.friendId === delegatedFrom.friendId
    && activity.channel !== "inner"
    && bridge.attachedSessions.some((session) => sessionMatchesActivity(activity, session)),
  ) ?? null
}

async function tryDeliverDelegatedCompletion(
  target: SessionActivityRecord,
  outboundEnvelope: PendingMessage,
): Promise<boolean> {
  if (target.channel !== "bluebubbles") {
    return false
  }

  const result = await sendProactiveBlueBubblesMessageToSession({
    friendId: target.friendId,
    sessionKey: target.key,
    text: outboundEnvelope.content,
  })
  return result.delivered
}

export function enrichDelegatedFromWithBridge(delegatedFrom: DelegatedFrom): DelegatedFrom {
  if (delegatedFrom.bridgeId) {
    return delegatedFrom
  }
  const bridgeManager = createBridgeManager()
  const originBridges = bridgeManager.findBridgesForSession({
    friendId: delegatedFrom.friendId,
    channel: delegatedFrom.channel,
    key: delegatedFrom.key,
  })
  const activeBridge = originBridges.find((b) => b.lifecycle === "active")
  if (activeBridge) {
    return { ...delegatedFrom, bridgeId: activeBridge.id }
  }
  return delegatedFrom
}

function advanceObligationQuietly(
  agentName: string,
  obligationId: string | undefined,
  update: Parameters<typeof advanceObligation>[2],
): void {
  if (!obligationId) return
  try {
    advanceObligation(agentName, obligationId, update)
  /* v8 ignore start -- best-effort: obligation fs errors must never block return routing @preserve */
  } catch {
    // swallowed
  }
  /* v8 ignore stop */
}

export async function routeDelegatedCompletion(
  agentRoot: string,
  agentName: string,
  completion: CompletionMetadata | undefined,
  drainedPending: PendingMessage[] | undefined,
  timestamp: number,
): Promise<void> {
  const delegated = (drainedPending ?? []).find((message) => message.delegatedFrom)
  if (!delegated?.delegatedFrom || !completion?.answer?.trim()) {
    return
  }

  const delegatedFrom = enrichDelegatedFromWithBridge(delegated.delegatedFrom)
  const obligationId = delegated.obligationId

  // Advance any inner return obligations from queued -> running (they were drained this turn).
  // drainedPending is guaranteed non-null here (we found delegated above).
  for (const msg of drainedPending!) {
    if (msg.obligationId) {
      advanceObligationQuietly(agentName, msg.obligationId, {
        status: "running",
        startedAt: timestamp,
      })
    }
  }

  if (delegated.obligationStatus === "pending") {
    // Fulfill the persistent obligation in the store
    try {
      const pending = findPendingObligationForOrigin(agentRoot, {
        friendId: delegatedFrom.friendId,
        channel: delegatedFrom.channel,
        key: delegatedFrom.key,
      })
      /* v8 ignore next 2 -- obligation fulfillment tested via obligations.test.ts; integration requires real disk state @preserve */
      if (pending) {
        fulfillObligation(agentRoot, pending.id)
      }
    } catch {
      /* v8 ignore next -- defensive: obligation store read failure should not break delivery @preserve */
    }
    emitNervesEvent({
      event: "senses.obligation_fulfilled",
      component: "senses",
      message: "obligation fulfilled via delegated completion",
      meta: {
        friendId: delegatedFrom.friendId,
        channel: delegatedFrom.channel,
        key: delegatedFrom.key,
      },
    })
  }
  const outboundEnvelope: PendingMessage = {
    from: agentName,
    friendId: delegatedFrom.friendId,
    channel: delegatedFrom.channel,
    key: delegatedFrom.key,
    content: completion.answer.trim(),
    timestamp,
    delegatedFrom,
    ...(obligationId ? { obligationId } : {}),
  }

  const sessionActivity = listSessionActivity({
    sessionsDir: path.join(agentRoot, "state", "sessions"),
    friendsDir: path.join(agentRoot, "friends"),
    agentName,
  })

  // Priority 1: Bridge-preferred session (if delegation was within a bridge).
  const bridgeTarget = resolveBridgePreferredSession(delegatedFrom, sessionActivity)
  if (bridgeTarget) {
    if (await tryDeliverDelegatedCompletion(bridgeTarget, outboundEnvelope)) {
      advanceObligationQuietly(agentName, obligationId, { status: "returned", returnedAt: timestamp, returnTarget: "bridge-session" })
      return
    }
    writePendingEnvelope(getPendingDir(agentName, bridgeTarget.friendId, bridgeTarget.channel, bridgeTarget.key), outboundEnvelope)
    advanceObligationQuietly(agentName, obligationId, { status: "returned", returnedAt: timestamp, returnTarget: "bridge-session" })
    return
  }

  // Priority 2: Freshest active friend session.
  const freshest = findFreshestFriendSession({
    sessionsDir: path.join(agentRoot, "state", "sessions"),
    friendsDir: path.join(agentRoot, "friends"),
    agentName,
    friendId: delegatedFrom.friendId,
    activeOnly: true,
  })
  if (freshest && freshest.channel !== "inner") {
    if (await tryDeliverDelegatedCompletion(freshest, outboundEnvelope)) {
      advanceObligationQuietly(agentName, obligationId, { status: "returned", returnedAt: timestamp, returnTarget: "freshest-session" })
      return
    }
    writePendingEnvelope(getPendingDir(agentName, freshest.friendId, freshest.channel, freshest.key), outboundEnvelope)
    advanceObligationQuietly(agentName, obligationId, { status: "returned", returnedAt: timestamp, returnTarget: "freshest-session" })
    return
  }

  // Priority 3: Deferred return queue.
  writePendingEnvelope(getDeferredReturnDir(agentName, delegatedFrom.friendId), outboundEnvelope)
  advanceObligationQuietly(agentName, obligationId, { status: "deferred", returnedAt: timestamp, returnTarget: "deferred" })
}
/* v8 ignore stop */

// Self-referencing friend record for inner dialog (agent talking to itself).
// No real friend to resolve -- this satisfies the pipeline's friend resolver contract.
function createSelfFriend(agentName: string): FriendRecord {
  return {
    id: "self",
    name: agentName,
    trustLevel: "family",
    externalIds: [],
    tenantMemberships: [],
    toolPreferences: {},
    notes: {},
    totalTokens: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    schemaVersion: 1,
  }
}

// No-op friend store for inner dialog. Inner dialog doesn't track token usage per-friend.
function createNoOpFriendStore(): FriendStore {
  return {
    get: async () => null,
    put: async () => {},
    delete: async () => {},
    findByExternalId: async () => null,
  }
}

export async function runInnerDialogTurn(options?: RunInnerDialogTurnOptions): Promise<InnerDialogTurnResult> {
  const now = options?.now ?? (() => new Date())
  const reason = options?.reason ?? "heartbeat"
  const sessionFilePath = innerDialogSessionPath()
  const agentName = getAgentName()
  writeInnerDialogRuntimeState(sessionFilePath, {
    status: "running",
    reason,
    startedAt: now().toISOString(),
  })

  try {
  const loaded = loadSession(sessionFilePath)
  const existingMessages = loaded?.messages ? [...loaded.messages] : []
  const instincts = options?.instincts ?? loadInnerDialogInstincts()
  const state: InnerDialogState = {
    cycleCount: 1,
    resting: false,
    lastHeartbeatAt: now().toISOString(),
  }

  // ── Adapter concern: build user message ──────────────────────────
  let userContent: string

  if (existingMessages.length === 0) {
    // Fresh session: bootstrap message with non-canonical cleanup nudge
    const aspirations = readAspirations(getAgentRoot())
    const nonCanonical = findNonCanonicalBundlePaths(getAgentRoot())
    const cleanupNudge = buildNonCanonicalCleanupNudge(nonCanonical)
    userContent = [
      buildInnerDialogBootstrapMessage(aspirations, "No prior inner dialog session found."),
      cleanupNudge,
    ].filter(Boolean).join("\n\n")
  } else {
    // Resumed session: task-triggered or instinct message with checkpoint context
    const assistantTurns = existingMessages.filter((message) => message.role === "assistant").length
    state.cycleCount = assistantTurns + 1
    state.checkpoint = deriveResumeCheckpoint(existingMessages)

    if (options?.taskId) {
      const taskContent = readTaskFile(getAgentRoot(), options.taskId)
      userContent = buildTaskTriggeredMessage(options.taskId, taskContent, state.checkpoint)
    } else {
      userContent = buildInstinctUserMessage(instincts, reason, state)
    }
  }

  const userMessage: OpenAI.ChatCompletionMessageParam = { role: "user", content: userContent }

  // ── Session loader: wraps existing session logic ──────────────────
  const innerCapabilities = getChannelCapabilities("inner")
  const pendingDir = getInnerDialogPendingDir(agentName)
  const selfFriend = createSelfFriend(agentName)
  const selfContext: ResolvedContext = { friend: selfFriend, channel: innerCapabilities }

  const mcpManager = await getSharedMcpManager() ?? undefined
  const sessionLoader = {
    loadOrCreate: async () => {
      if (existingMessages.length > 0) {
        return {
          messages: existingMessages,
          sessionPath: sessionFilePath,
        }
      }
      // Fresh session: build system prompt
      const systemPrompt = await buildSystem("inner", { toolChoiceRequired: true, mcpManager })
      return {
        messages: [{ role: "system" as const, content: systemPrompt }],
        sessionPath: sessionFilePath,
      }
    },
  }

  // ── Call shared pipeline ──────────────────────────────────────────
  const callbacks = createInnerDialogCallbacks()
  const traceId = createTraceId()

  // Attention queue: built when pending messages are drained, shared with tool context
  let attentionQueue: AttentionItem[] = []

  const result = await handleInboundTurn({
    channel: "inner",
    sessionKey: "dialog",
    capabilities: innerCapabilities,
    messages: [userMessage],
    continuityIngressTexts: [],
    callbacks,
    friendResolver: { resolve: () => Promise.resolve(selfContext) },
    sessionLoader,
    pendingDir,
    friendStore: createNoOpFriendStore(),
    enforceTrustGate,
    drainPending,
    runAgent,
    postTurn,
    accumulateFriendTokens,
    signal: options?.signal,
    /* v8 ignore start -- attention queue: callback invoked by pipeline during pending drain; tested via attention-queue unit tests @preserve */
    onPendingDrained: (drained) => {
      const outstandingObligations = listActiveObligations(agentName)
      attentionQueue = buildAttentionQueue({
        drainedPending: drained,
        outstandingObligations,
        friendNameResolver: (friendId) => {
          try {
            const raw = fs.readFileSync(path.join(getAgentRoot(agentName), "friends", friendId + ".json"), "utf-8")
            const parsed = JSON.parse(raw)
            return typeof parsed.name === "string" ? parsed.name : null
          } catch {
            return null
          }
        },
      })
      const summary = buildAttentionQueueSummary(attentionQueue)
      return summary ? [summary] : []
    },
    /* v8 ignore stop */
    runAgentOptions: {
      traceId,
      toolChoiceRequired: true,
      skipConfirmation: true,
      mcpManager,
      toolContext: {
        signin: async () => undefined,
        delegatedOrigins: attentionQueue,
      },
    },
  })
  // Post-turn routeDelegatedCompletion removed: delivery is now inline via surface tool.
  // settle in inner dialog produces no CompletionMetadata, so routeDelegatedCompletion
  // would be a no-op. The routing infrastructure is reused by the surface handler.

  const resultMessages = result.messages ?? []
  const assistantPreview = extractAssistantPreview(resultMessages)
  const toolCalls = extractToolCallNames(resultMessages)

  emitNervesEvent({
    component: "senses",
    event: "senses.inner_dialog_turn",
    message: "inner dialog turn completed",
    meta: {
      reason,
      session: sessionFilePath,
      ...(options?.taskId && { taskId: options.taskId }),
      ...(assistantPreview && { assistantPreview }),
      ...(toolCalls.length > 0 && { toolCalls }),
      ...(result.usage && {
        promptTokens: result.usage.input_tokens,
        completionTokens: result.usage.output_tokens,
        totalTokens: result.usage.total_tokens,
      }),
    },
  })

  return {
    messages: resultMessages,
    usage: result.usage,
    sessionPath: result.sessionPath ?? sessionFilePath,
    completion: result.completion,
  }
  } finally {
    writeInnerDialogRuntimeState(sessionFilePath, {
      status: "idle",
      lastCompletedAt: now().toISOString(),
    })
  }
}
