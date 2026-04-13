import type OpenAI from "openai"
import { getContextConfig } from "../heart/config"
import {
  annotateMessageTimestamps,
  appendSyntheticAssistantEvent,
  buildCanonicalSessionEnvelope,
  getIngressTime,
  loadSessionEnvelopeFile,
  projectProviderMessages,
  sanitizeProviderMessages,
  type SessionEnvelope,
  type SessionEvent,
} from "../heart/session-events"
import { emitNervesEvent } from "../nerves/runtime"
import * as fs from "fs"
import * as path from "path"
import { estimateTokensForMessages } from "./token-estimate"

export { migrateToolNames, repairSessionMessages, validateSessionMessages } from "../heart/session-events"

export interface UsageData {
  input_tokens: number
  output_tokens: number
  reasoning_tokens: number
  total_tokens: number
}

export interface SessionContinuityState {
  mustResolveBeforeHandoff?: boolean
  lastFriendActivityAt?: string
}

export interface SessionData {
  messages: OpenAI.ChatCompletionMessageParam[]
  events: SessionEvent[]
  lastUsage?: UsageData
  state?: SessionContinuityState
}

export interface PostTurnHooks {
  beforeTrim?: (messages: OpenAI.ChatCompletionMessageParam[]) => void
}

type MessageBlock = {
  indices: number[]
  estimatedTokens: number
}

function buildTrimmableBlocks(messages: OpenAI.ChatCompletionMessageParam[]): MessageBlock[] {
  const blocks: MessageBlock[] = []

  let i = 0
  while (i < messages.length) {
    const msg = messages[i]

    if (msg.role === "system") {
      i++
      continue
    }

    // Tool coherence block: assistant message with tool_calls + immediately following tool results
    if (msg.role === "assistant" && Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
      const indices = [i]
      i++
      while (i < messages.length) {
        const next = messages[i]
        if (next.role !== "tool") break
        indices.push(i)
        i++
      }

      const blockMsgs = indices.map((idx) => messages[idx])
      blocks.push({ indices, estimatedTokens: estimateTokensForMessages(blockMsgs) })
      continue
    }

    // Default: one message per block
    blocks.push({ indices: [i], estimatedTokens: estimateTokensForMessages([messages[i]]) })
    i++
  }

  return blocks
}

function getSystemMessageIndices(messages: OpenAI.ChatCompletionMessageParam[]): number[] {
  const indices: number[] = []
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role === "system") indices.push(i)
  }
  return indices
}

function buildTrimmedMessages(messages: OpenAI.ChatCompletionMessageParam[], kept: Set<number>): OpenAI.ChatCompletionMessageParam[] {
  return messages.filter((m, idx) => m.role === "system" || kept.has(idx))
}

export function trimMessages(
  messages: OpenAI.ChatCompletionMessageParam[],
  maxTokens: number,
  contextMargin: number,
  actualTokenCount?: number,
): OpenAI.ChatCompletionMessageParam[] {
  const targetTokens = Math.floor(maxTokens * (1 - contextMargin / 100))
  const estimatedBefore = estimateTokensForMessages(messages)

  emitNervesEvent({
    event: "mind.step_start",
    component: "mind",
    message: "trimMessages started",
    meta: {
      maxTokens,
      contextMargin,
      targetTokens,
      messageCount: messages.length,
      actualTokenCount: actualTokenCount ?? null,
      estimated_before: estimatedBefore,
    },
  })

  const coldStart = actualTokenCount == null || actualTokenCount === 0
  const overTokens = actualTokenCount != null && actualTokenCount > maxTokens

  // We only trim when the provider reported that we overflowed the model context.
  // If actualTokenCount is missing/0, we treat it as a cold start and do not trim.
  if (coldStart || !overTokens) {
    emitNervesEvent({
      event: "mind.step_end",
      component: "mind",
      message: "trimMessages completed without trimming",
      meta: {
        trimmed: false,
        messageCount: messages.length,
        targetTokens,
        actualTokenCount: actualTokenCount ?? null,
        estimated_before: estimatedBefore,
        estimated_after: estimatedBefore,
      },
    })
    return [...messages]
  }

  const systemIndices = getSystemMessageIndices(messages)
  const systemMsgs = systemIndices.map((i) => messages[i])
  const estimatedSystem = estimateTokensForMessages(systemMsgs)

  const blocks = buildTrimmableBlocks(messages)

  // Approximate token contribution uniformly across messages, per contract tests.
  // Note: this is intentionally simple and does not attempt token-accurate attribution.
  const perMessageCost = actualTokenCount / Math.max(1, messages.length)
  let remaining = actualTokenCount

  const kept = new Set<number>()
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role !== "system") kept.add(i)
  }

  // Drop oldest blocks until we fall under target.
  for (let b = 0; b < blocks.length && remaining > targetTokens; b++) {
    const block = blocks[b]
    for (const idx of block.indices) {
      kept.delete(idx)
      remaining -= perMessageCost
    }
  }

  let trimmed = buildTrimmedMessages(messages, kept)

  // If we're still above budget after dropping everything trimmable, preserve system only.
  if (remaining > targetTokens) {
    trimmed = messages.filter((m) => m.role === "system")
  }

  const estimatedAfter = estimateTokensForMessages(trimmed)

  emitNervesEvent({
    event: "mind.step_end",
    component: "mind",
    message: "trimMessages completed with trimming",
    meta: {
      trimmed: true,
      originalCount: messages.length,
      finalCount: trimmed.length,
      targetTokens,
      actualTokenCount,
      estimated_before: estimatedBefore,
      estimated_after: estimatedAfter,
      estimated_system: estimatedSystem,
      blockCount: blocks.length,
      forcedDrop: true,
    },
  })

  return trimmed
}


/**
 * Checks session invariant: after system messages, sequence must be
 * user → assistant (with optional tool calls/results) → user → assistant...
 * Never assistant → assistant without a user in between.
 */
function denormalizeContinuityState(state: { mustResolveBeforeHandoff: boolean; lastFriendActivityAt: string | null }): SessionContinuityState | undefined {
  if (!state.mustResolveBeforeHandoff && typeof state.lastFriendActivityAt !== "string") return undefined
  return {
    ...(state.mustResolveBeforeHandoff ? { mustResolveBeforeHandoff: true } : {}),
    ...(typeof state.lastFriendActivityAt === "string" ? { lastFriendActivityAt: state.lastFriendActivityAt } : {}),
  }
}

function writeSessionEnvelope(filePath: string, envelope: SessionEnvelope): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, JSON.stringify(envelope, null, 2))
}

export function saveSession(
  filePath: string,
  messages: OpenAI.ChatCompletionMessageParam[],
  lastUsage?: UsageData,
  state?: SessionContinuityState,
): void {
  const existing = loadSessionEnvelopeFile(filePath)
  const previousMessages = existing ? projectProviderMessages(existing) : []
  const currentIngressTimes = messages.map(getIngressTime)
  const sanitized = sanitizeProviderMessages(messages)
  const envelope = buildCanonicalSessionEnvelope({
    existing,
    previousMessages,
    currentMessages: sanitized,
    trimmedMessages: sanitized,
    currentIngressTimes,
    recordedAt: new Date().toISOString(),
    lastUsage: lastUsage ?? null,
    state,
    projectionBasis: {
      maxTokens: null,
      contextMargin: null,
      inputTokens: lastUsage?.input_tokens ?? null,
    },
  })
  writeSessionEnvelope(filePath, envelope)
}

export function appendSyntheticAssistantMessage(filePath: string, content: string): boolean {
  try {
    if (!fs.existsSync(filePath)) return false
    const envelope = loadSessionEnvelopeFile(filePath)
    if (!envelope) return false
    const updated = appendSyntheticAssistantEvent(envelope, content, new Date().toISOString())
    writeSessionEnvelope(filePath, updated)
    emitNervesEvent({
      component: "mind",
      event: "mind.session_synthetic_message_appended",
      message: "appended synthetic assistant message to session",
      meta: { path: filePath, contentLength: content.length },
    })
    return true
  } catch {
    return false
  }
}

export function loadSession(filePath: string): SessionData | null {
  try {
    const envelope = loadSessionEnvelopeFile(filePath)
    if (!envelope) return null
    return {
      messages: annotateMessageTimestamps(envelope, projectProviderMessages(envelope)),
      events: envelope.events,
      lastUsage: envelope.lastUsage ?? undefined,
      state: denormalizeContinuityState(envelope.state),
    }
  } catch {
    return null
  }
}

/**
 * Synchronous post-turn: sanitize, trim (mutates messages in place), and persist to disk.
 * For non-blocking persist, use postTurnTrim() + deferPostTurnPersist() instead.
 */
export function postTurn(
  messages: OpenAI.ChatCompletionMessageParam[],
  sessPath: string,
  usage?: UsageData,
  hooks?: PostTurnHooks,
  state?: SessionContinuityState,
): void {
  const prepared = postTurnTrim(messages, usage, hooks)
  postTurnPersist(sessPath, prepared, usage, state)
}

export interface PostTurnPrepared {
  currentMessages: OpenAI.ChatCompletionMessageParam[]
  trimmedMessages: OpenAI.ChatCompletionMessageParam[]
  currentIngressTimes: (string | null)[]
  maxTokens: number
  contextMargin: number
}

/**
 * Synchronous phase: run hooks, sanitize, trim, and mutate the messages array in place.
 * Returns the data needed by postTurnPersist / deferPostTurnPersist.
 */
export function postTurnTrim(
  messages: OpenAI.ChatCompletionMessageParam[],
  usage?: UsageData,
  hooks?: PostTurnHooks,
): PostTurnPrepared {
  const preTrimMessages = [...messages]
  if (hooks?.beforeTrim) {
    try {
      hooks.beforeTrim(preTrimMessages)
    } catch (error) {
      emitNervesEvent({
        level: "warn",
        event: "mind.post_turn_hook_error",
        component: "mind",
        message: "postTurn beforeTrim hook failed",
        meta: {
          reason: error instanceof Error ? error.message : String(error),
        },
      })
    }
  }
  const { maxTokens, contextMargin } = getContextConfig()
  const currentIngressTimes = messages.map(getIngressTime)
  const currentMessages = sanitizeProviderMessages(messages)
  const trimmedMessages = trimMessages(currentMessages, maxTokens, contextMargin, usage?.input_tokens)
  messages.splice(0, messages.length, ...trimmedMessages)
  return { currentMessages, trimmedMessages, currentIngressTimes, maxTokens, contextMargin }
}

/**
 * Synchronous persist: load existing envelope, build canonical envelope, write to disk.
 */
export function postTurnPersist(
  sessPath: string,
  prepared: PostTurnPrepared,
  usage?: UsageData,
  state?: SessionContinuityState,
): SessionEvent[] {
  const existing = loadSessionEnvelopeFile(sessPath)
  const previousMessages = existing ? projectProviderMessages(existing) : []
  const envelope = buildCanonicalSessionEnvelope({
    existing,
    previousMessages,
    currentMessages: prepared.currentMessages,
    trimmedMessages: prepared.trimmedMessages,
    currentIngressTimes: prepared.currentIngressTimes,
    recordedAt: new Date().toISOString(),
    lastUsage: usage ?? null,
    state,
    projectionBasis: {
      maxTokens: prepared.maxTokens,
      contextMargin: prepared.contextMargin,
      inputTokens: usage?.input_tokens ?? null,
    },
  })
  writeSessionEnvelope(sessPath, envelope)
  return envelope.events
}

/**
 * Deferred persist: same as postTurnPersist but runs on the next event loop tick.
 * Returns a promise that resolves when the persist completes.
 */
export function deferPostTurnPersist(
  sessPath: string,
  prepared: PostTurnPrepared,
  usage?: UsageData,
  state?: SessionContinuityState,
): Promise<SessionEvent[]> {
  return new Promise((resolve) => {
    setImmediate(() => {
      try {
        const events = postTurnPersist(sessPath, prepared, usage, state)
        resolve(events)
      } catch (err) {
        emitNervesEvent({
          level: "warn",
          component: "mind",
          event: "mind.deferred_persist_error",
          message: "deferred session persist failed",
          meta: { error: err instanceof Error ? err.message : String(err) },
        })
        resolve([])
      }
    })
  })
}

export function deleteSession(filePath: string): void {
  try {
    fs.unlinkSync(filePath)
  } catch (e: unknown) {
    if (e instanceof Error && (e as NodeJS.ErrnoException).code !== "ENOENT") throw e
  }
}
