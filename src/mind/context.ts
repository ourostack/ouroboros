import type OpenAI from "openai"
import { getContextConfig } from "../heart/config"
import { emitNervesEvent } from "../nerves/runtime"
import * as fs from "fs"
import * as path from "path"
import { estimateTokensForMessages } from "./token-estimate"

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
export function validateSessionMessages(messages: OpenAI.ChatCompletionMessageParam[]): string[] {
  const violations: string[] = []
  let prevNonToolRole: string | null = null
  let prevAssistantHadToolCalls = false
  let sawToolResultSincePrevAssistant = false

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]
    if (msg.role === "system") continue

    if (msg.role === "tool") {
      sawToolResultSincePrevAssistant = true
      continue
    }

    if (msg.role === "assistant" && prevNonToolRole === "assistant") {
      // assistant → tool(s) → assistant is valid (tool call flow)
      if (!(prevAssistantHadToolCalls && sawToolResultSincePrevAssistant)) {
        violations.push(`back-to-back assistant at index ${i}`)
      }
    }

    prevAssistantHadToolCalls = msg.role === "assistant" && Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0
    sawToolResultSincePrevAssistant = false
    prevNonToolRole = msg.role
  }

  return violations
}

/**
 * Repairs session invariant violations by merging consecutive assistant messages.
 */
export function repairSessionMessages(messages: OpenAI.ChatCompletionMessageParam[]): OpenAI.ChatCompletionMessageParam[] {
  const violations = validateSessionMessages(messages)
  if (violations.length === 0) return messages

  const result: OpenAI.ChatCompletionMessageParam[] = []
  for (const msg of messages) {
    if (msg.role === "assistant" && result.length > 0) {
      const prev = result[result.length - 1]
      if (prev.role === "assistant" && !("tool_calls" in prev)) {
        const prevContent = typeof prev.content === "string" ? prev.content : ""
        const curContent = typeof msg.content === "string" ? msg.content : ""
        ;(prev as OpenAI.ChatCompletionAssistantMessageParam).content = `${prevContent}\n\n${curContent}`
        continue
      }
    }
    result.push(msg)
  }

  emitNervesEvent({
    level: "info",
    event: "mind.session_invariant_repair",
    component: "mind",
    message: "repaired session invariant violations",
    meta: { violations },
  })

  return result
}

function stripOrphanedToolResults(messages: OpenAI.ChatCompletionMessageParam[]): OpenAI.ChatCompletionMessageParam[] {
  const validCallIds = new Set<string>()
  for (const msg of messages) {
    if (msg.role !== "assistant" || !Array.isArray(msg.tool_calls)) continue
    for (const toolCall of msg.tool_calls) validCallIds.add(toolCall.id)
  }

  let removed = 0
  const repaired = messages.filter((msg) => {
    if (msg.role !== "tool") return true
    const keep = validCallIds.has(msg.tool_call_id)
    if (!keep) removed++
    return keep
  })

  if (removed > 0) {
    emitNervesEvent({
      level: "info",
      event: "mind.session_orphan_tool_result_repair",
      component: "mind",
      message: "removed orphaned tool results from session history",
      meta: { removed },
    })
  }

  return repaired
}

// Tool renames that have shipped. Old names in session history confuse the
// model into calling tools that no longer exist. Applied on session load so
// the transcript uses the current vocabulary.
const TOOL_NAME_MIGRATIONS: Record<string, string> = {
  final_answer: "settle",
  no_response: "observe",
  go_inward: "descend",
  memory_save: "diary_write",
  memory_search: "recall",
}

export function migrateToolNames(messages: OpenAI.ChatCompletionMessageParam[]): OpenAI.ChatCompletionMessageParam[] {
  let migrated = 0
  const result = messages.map((msg) => {
    if (msg.role !== "assistant" || !Array.isArray(msg.tool_calls) || msg.tool_calls.length === 0) return msg
    let changed = false
    const updatedCalls = msg.tool_calls.map((tc) => {
      if (tc.type !== "function") return tc
      const newName = TOOL_NAME_MIGRATIONS[tc.function.name]
      if (!newName) return tc
      changed = true
      migrated++
      return { ...tc, function: { ...tc.function, name: newName } }
    })
    return changed ? { ...msg, tool_calls: updatedCalls } : msg
  })

  if (migrated > 0) {
    emitNervesEvent({
      level: "info",
      event: "mind.session_tool_name_migration",
      component: "mind",
      message: "migrated deprecated tool names in session history",
      meta: { migrated },
    })
  }

  return result
}

export function saveSession(
  filePath: string,
  messages: OpenAI.ChatCompletionMessageParam[],
  lastUsage?: UsageData,
  state?: SessionContinuityState,
): void {
  const violations = validateSessionMessages(messages)
  if (violations.length > 0) {
    emitNervesEvent({
      level: "info",
      event: "mind.session_invariant_violation",
      component: "mind",
      message: "session invariant violated on save",
      meta: { path: filePath, violations },
    })
    messages = repairSessionMessages(messages)
  }
  messages = stripOrphanedToolResults(messages)
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  const envelope: {
    version: number
    messages: OpenAI.ChatCompletionMessageParam[]
    lastUsage?: UsageData
    state?: SessionContinuityState
  } = { version: 1, messages }
  if (lastUsage) envelope.lastUsage = lastUsage
  if (state?.mustResolveBeforeHandoff === true || typeof state?.lastFriendActivityAt === "string") {
    envelope.state = {
      ...(state?.mustResolveBeforeHandoff === true ? { mustResolveBeforeHandoff: true } : {}),
      ...(typeof state?.lastFriendActivityAt === "string" ? { lastFriendActivityAt: state.lastFriendActivityAt } : {}),
    }
  }
  fs.writeFileSync(filePath, JSON.stringify(envelope, null, 2))
}

export function appendSyntheticAssistantMessage(filePath: string, content: string): boolean {
  try {
    if (!fs.existsSync(filePath)) return false
    const raw = fs.readFileSync(filePath, "utf-8")
    const data = JSON.parse(raw)
    if (data.version !== 1 || !Array.isArray(data.messages)) return false
    data.messages.push({ role: "assistant", content })
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2))
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
    const raw = fs.readFileSync(filePath, "utf-8")
    const data = JSON.parse(raw)
    if (data.version !== 1) return null
    let messages: OpenAI.ChatCompletionMessageParam[] = data.messages
    const violations = validateSessionMessages(messages)
    if (violations.length > 0) {
      emitNervesEvent({
        level: "info",
        event: "mind.session_invariant_violation",
        component: "mind",
        message: "session invariant violated on load",
        meta: { path: filePath, violations },
      })
      messages = repairSessionMessages(messages)
    }
    messages = stripOrphanedToolResults(messages)
    messages = migrateToolNames(messages)
    const rawState = data?.state && typeof data.state === "object" && data.state !== null
      ? data.state as { mustResolveBeforeHandoff?: unknown; lastFriendActivityAt?: unknown }
      : undefined
    const state = rawState && (
      rawState.mustResolveBeforeHandoff === true
      || typeof rawState.lastFriendActivityAt === "string"
    )
      ? {
        ...(rawState.mustResolveBeforeHandoff === true ? { mustResolveBeforeHandoff: true } : {}),
        ...(typeof rawState.lastFriendActivityAt === "string" ? { lastFriendActivityAt: rawState.lastFriendActivityAt } : {}),
      }
      : undefined
    return { messages, lastUsage: data.lastUsage, state }
  } catch {
    return null
  }
}

export function postTurn(
  messages: OpenAI.ChatCompletionMessageParam[],
  sessPath: string,
  usage?: UsageData,
  hooks?: PostTurnHooks,
  state?: SessionContinuityState,
): void {
  if (hooks?.beforeTrim) {
    try {
      hooks.beforeTrim([...messages])
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
  const trimmed = trimMessages(messages, maxTokens, contextMargin, usage?.input_tokens)
  messages.splice(0, messages.length, ...trimmed)
  saveSession(sessPath, messages, usage, state)
}

export function deleteSession(filePath: string): void {
  try {
    fs.unlinkSync(filePath)
  } catch (e: unknown) {
    if (e instanceof Error && (e as NodeJS.ErrnoException).code !== "ENOENT") throw e
  }
}
