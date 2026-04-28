import * as fs from "fs"
import type OpenAI from "openai"
import { emitNervesEvent } from "../nerves/runtime"

export interface SessionUsageData {
  input_tokens: number
  output_tokens: number
  reasoning_tokens: number
  total_tokens: number
}

export interface SessionContinuitySnapshot {
  mustResolveBeforeHandoff: boolean
  lastFriendActivityAt: string | null
}

export type SessionEventRole = "system" | "user" | "assistant" | "tool"
export type SessionEventTimeSource = "unknown" | "local" | "ingest" | "migration" | "save"
export type SessionEventCaptureKind = "live" | "synthetic" | "migration"

export interface SessionEventToolCall {
  id: string
  type: string
  function: {
    name: string
    arguments: string
  }
}

export interface SessionEventTime {
  authoredAt: string | null
  authoredAtSource: SessionEventTimeSource
  observedAt: string | null
  observedAtSource: SessionEventTimeSource
  recordedAt: string
  recordedAtSource: SessionEventTimeSource
}

export interface SessionEventRelations {
  replyToEventId: string | null
  threadRootEventId: string | null
  references: string[]
  toolCallId: string | null
  supersedesEventId: string | null
  redactsEventId: string | null
}

export interface SessionEventProvenance {
  captureKind: SessionEventCaptureKind
  legacyVersion: number | null
  sourceMessageIndex: number | null
}

export type SessionEventContentPart = Record<string, unknown>
export type SessionEventContent = string | SessionEventContentPart[] | null

export interface SessionEvent {
  id: string
  sequence: number
  role: SessionEventRole
  content: SessionEventContent
  name: string | null
  toolCallId: string | null
  toolCalls: SessionEventToolCall[]
  attachments: string[]
  time: SessionEventTime
  relations: SessionEventRelations
  provenance: SessionEventProvenance
}

export interface SessionProjection {
  eventIds: string[]
  trimmed: boolean
  maxTokens: number | null
  contextMargin: number | null
  inputTokens: number | null
  projectedAt: string | null
}

export interface SessionEnvelope {
  version: 2
  events: SessionEvent[]
  projection: SessionProjection
  lastUsage: SessionUsageData | null
  state: SessionContinuitySnapshot
}

interface SessionEnvelopeV1 {
  version?: 1
  messages?: unknown
  lastUsage?: unknown
  state?: unknown
}

export interface SessionEnvelopeBuildOptions {
  existing: SessionEnvelope | null
  /** Pre-sanitized previous messages (from projectProviderMessages). */
  previousMessages: OpenAI.ChatCompletionMessageParam[]
  /** Pre-sanitized current messages. */
  currentMessages: OpenAI.ChatCompletionMessageParam[]
  /** Pre-sanitized trimmed messages. */
  trimmedMessages: OpenAI.ChatCompletionMessageParam[]
  /** Pre-captured ingress times (index-aligned with currentMessages, before sanitization stripped _ingressAt). */
  currentIngressTimes?: (string | null)[]
  recordedAt: string
  lastUsage?: SessionUsageData | null
  state?: { mustResolveBeforeHandoff?: boolean; lastFriendActivityAt?: string } | null
  projectionBasis: {
    maxTokens: number | null
    contextMargin: number | null
    inputTokens: number | null
  }
}

export interface SessionEnvelopeParseOptions {
  recordedAt?: string
  fileMtimeAt?: string | null
}

export interface SessionChronology {
  lastInboundAt: string | null
  lastOutboundAt: string | null
  lastActivityAt: string | null
  unansweredInboundCount: number
}

interface NormalizedProviderMessage {
  role: SessionEventRole
  content: SessionEventContent
  name: string | null
  toolCallId: string | null
  toolCalls: SessionEventToolCall[]
  hadToolCallsField: boolean
}

function formatElapsed(ms: number): string {
  const minutes = Math.max(0, Math.floor(ms / 60000))
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

const LEGACY_WRITTEN_NOTE_PREFIX = "mem" + "ory"

const TOOL_NAME_MIGRATIONS: Record<string, string> = {
  final_answer: "settle",
  no_response: "observe",
  go_inward: "ponder",
  descend: "ponder",
  [`${LEGACY_WRITTEN_NOTE_PREFIX}_save`]: "diary_write",
  [`${LEGACY_WRITTEN_NOTE_PREFIX}_search`]: "search_notes",
}

function normalizeUsage(usage: unknown): SessionUsageData | null {
  if (!usage || typeof usage !== "object") return null
  const record = usage as Record<string, unknown>
  if (
    typeof record.input_tokens !== "number"
    || typeof record.output_tokens !== "number"
    || typeof record.reasoning_tokens !== "number"
    || typeof record.total_tokens !== "number"
  ) {
    return null
  }
  return {
    input_tokens: record.input_tokens,
    output_tokens: record.output_tokens,
    reasoning_tokens: record.reasoning_tokens,
    total_tokens: record.total_tokens,
  }
}

export function normalizeContinuityState(state: unknown): SessionContinuitySnapshot {
  const record = state && typeof state === "object"
    ? state as { mustResolveBeforeHandoff?: unknown; lastFriendActivityAt?: unknown }
    : null
  return {
    mustResolveBeforeHandoff: record?.mustResolveBeforeHandoff === true,
    lastFriendActivityAt: typeof record?.lastFriendActivityAt === "string" ? record.lastFriendActivityAt : null,
  }
}

function normalizeContent(content: unknown): SessionEventContent {
  if (content == null) return null
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return null
  return content
    .filter((part): part is Record<string, unknown> => part != null && typeof part === "object")
    .map((part) => ({ ...part }))
}

const SYNTHETIC_TIMESTAMP_PREFIX_RE = /^(?:(?:\[(?:just now|-\d+[mhd])\])\s*)+/i

function stripSyntheticTimestampPrefix(text: string): string {
  return text.replace(SYNTHETIC_TIMESTAMP_PREFIX_RE, "")
}

function sanitizeConversationContent(
  role: SessionEventRole,
  content: SessionEventContent,
): SessionEventContent {
  if (role !== "user" && role !== "assistant") return content
  if (typeof content === "string") return stripSyntheticTimestampPrefix(content)
  if (!Array.isArray(content)) return content
  return content.map((part) => {
    if (part.type === "text" && typeof part.text === "string") {
      return { ...part, text: stripSyntheticTimestampPrefix(part.text) }
    }
    return part
  })
}

function normalizeToolCalls(rawToolCalls: unknown): SessionEventToolCall[] {
  if (!Array.isArray(rawToolCalls)) return []
  return rawToolCalls
    .filter((call): call is Record<string, unknown> => call != null && typeof call === "object")
    .map((call) => {
      const fn = call.function as Record<string, unknown> | undefined
      const originalName = typeof fn?.name === "string" ? fn.name : "unknown"
      const migratedName = TOOL_NAME_MIGRATIONS[originalName] ?? originalName
      return {
        id: typeof call.id === "string" ? call.id : "",
        type: typeof call.type === "string" ? call.type : "function",
        function: {
          name: migratedName,
          arguments: typeof fn?.arguments === "string" ? fn.arguments : JSON.stringify(fn?.arguments ?? ""),
        },
      }
    })
}

function normalizeRole(role: unknown): SessionEventRole {
  if (role === "developer") return "system"
  return role === "system" || role === "user" || role === "assistant" || role === "tool"
    ? role
    : "user"
}

function normalizeMessage(message: OpenAI.ChatCompletionMessageParam): NormalizedProviderMessage {
  const record = message as {
    role?: unknown
    content?: unknown
    name?: unknown
    tool_call_id?: unknown
    tool_calls?: unknown
  }
  const role = normalizeRole(record.role)
  const normalizedContent = sanitizeConversationContent(role, normalizeContent(record.content))

  if (role === "assistant") {
    return {
      role,
      content: normalizedContent,
      name: typeof record.name === "string" ? record.name : null,
      toolCallId: null,
      toolCalls: normalizeToolCalls(record.tool_calls),
      hadToolCallsField: Array.isArray(record.tool_calls),
    }
  }

  if (role === "tool") {
    return {
      role,
      content: typeof record.content === "string" ? record.content : "",
      name: null,
      toolCallId: typeof record.tool_call_id === "string" ? record.tool_call_id : null,
      toolCalls: [],
      hadToolCallsField: false,
    }
  }

  return {
    role,
    content: normalizedContent ?? "",
    name: typeof record.name === "string" ? record.name : null,
    toolCallId: null,
    toolCalls: [],
    hadToolCallsField: false,
  }
}

function contentText(content: SessionEventContent): string {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content
    .map((part) => (
      part.type === "text" && typeof part.text === "string"
        ? part.text
        : ""
    ))
    .filter((text) => text.length > 0)
    .join("")
}

function toProviderMessage(message: NormalizedProviderMessage): OpenAI.ChatCompletionMessageParam {
  if (message.role === "assistant") {
    const assistant: {
      role: "assistant"
      content: OpenAI.ChatCompletionAssistantMessageParam["content"]
      tool_calls?: OpenAI.ChatCompletionAssistantMessageParam["tool_calls"]
      name?: string
    } = {
      role: "assistant",
      content: message.content as OpenAI.ChatCompletionAssistantMessageParam["content"],
    }
    if (message.name) assistant.name = message.name
    if (message.hadToolCallsField || message.toolCalls.length > 0) {
      assistant.tool_calls = message.toolCalls.map((call) => ({
        id: call.id,
        type: call.type as "function",
        function: {
          name: call.function.name,
          arguments: call.function.arguments,
        },
      }))
    }
    return assistant as OpenAI.ChatCompletionAssistantMessageParam & { name?: string }
  }

  if (message.role === "tool") {
    return {
      role: "tool",
      content: typeof message.content === "string" ? message.content : contentText(message.content),
      tool_call_id: message.toolCallId ?? "",
    } as OpenAI.ChatCompletionToolMessageParam
  }

  if (message.role === "system") {
    return {
      role: "system",
      content: typeof message.content === "string" ? message.content : contentText(message.content),
      ...(message.name ? { name: message.name } : {}),
    } as OpenAI.ChatCompletionSystemMessageParam & { name?: string }
  }

  return {
    role: "user",
    content: (typeof message.content === "string" || Array.isArray(message.content) ? message.content : "") as OpenAI.ChatCompletionUserMessageParam["content"],
    ...(message.name ? { name: message.name } : {}),
  } as OpenAI.ChatCompletionUserMessageParam & { name?: string }
}

function messageFingerprint(message: OpenAI.ChatCompletionMessageParam): string {
  const normalized = normalizeMessage(message)
  return JSON.stringify({
    role: normalized.role,
    content: normalized.content,
    name: normalized.name,
    tool_call_id: normalized.toolCallId,
    tool_calls: normalized.toolCalls,
  })
}

function makeEventId(sequence: number): string {
  return `evt-${String(sequence).padStart(6, "0")}`
}

/**
 * Collapse duplicate event ids to a single entry, last-occurrence-wins.
 *
 * Concurrent writers in older versions of postTurnPersist could each load the
 * envelope, compute `events.length + 1` for the next sequence, and both write
 * an event with the same id. The duplicates would persist in the saved JSON
 * and confuse downstream replay (the same outbound message could appear to
 * have been sent twice from the agent's perspective without the agent knowing
 * it sent it). We dedupe defensively on every load so corrupted sessions
 * self-heal on the next save and so any future race produces a consistent
 * view.
 */
function dedupeEventsByIdLastWins(events: SessionEvent[]): SessionEvent[] {
  // Index id → last position so we can preserve original order while
  // collapsing duplicates to their final occurrence.
  const lastIndexById = new Map<string, number>()
  for (let i = 0; i < events.length; i++) {
    lastIndexById.set(events[i]!.id, i)
  }
  return events.filter((event, index) => lastIndexById.get(event.id) === index)
}

/**
 * The next sequence to assign for a freshly-built event. Uses max(existing
 * sequences) + 1 rather than `events.length + 1` so that gaps from earlier
 * pruning, archive replay, or self-heal dedup never produce a colliding id.
 */
function nextEventSequence(existing: SessionEvent[]): number {
  return existing.reduce((max, event) => Math.max(max, event.sequence), 0) + 1
}

export function validateSessionMessages(messages: OpenAI.ChatCompletionMessageParam[]): string[] {
  const violations: string[] = []
  let prevNonToolRole: string | null = null
  let prevAssistantHadToolCalls = false
  let sawToolResultSincePrevAssistant = false

  for (let i = 0; i < messages.length; i++) {
    const msg = normalizeMessage(messages[i]!)
    if (msg.role === "system") continue

    if (msg.role === "tool") {
      sawToolResultSincePrevAssistant = true
      continue
    }

    if (msg.role === "assistant" && prevNonToolRole === "assistant") {
      if (!(prevAssistantHadToolCalls && sawToolResultSincePrevAssistant)) {
        violations.push(`back-to-back assistant at index ${i}`)
      }
    }

    prevAssistantHadToolCalls = msg.role === "assistant" && msg.toolCalls.length > 0
    sawToolResultSincePrevAssistant = false
    prevNonToolRole = msg.role
  }

  for (const collision of detectDuplicateToolCallIds(messages)) {
    violations.push(
      `duplicate tool_call_id '${collision.id}' across assistant messages at indices ${collision.indices.join(", ")} — provider may reject (MiniMax canonicalizes call_function_<hash>_<n> across turns)`,
    )
  }

  return violations
}

export interface ToolCallIdCollision {
  id: string
  indices: number[]
}

/**
 * Detect tool_call_ids that appear in more than one assistant message
 * within the conversation. MiniMax-M2.7 in particular emits canonical
 * ids of the form `call_function_<hash>_<n>` and reuses the same id
 * across turns when the same function is called — which causes provider
 * rejections on replay because tool_call_id is supposed to be unique
 * per request. We don't (yet) rewrite these here; this function exists
 * so the sanitize pipeline can surface the collision through nerves
 * (`mind.session_invariant_violation`) and operators can decide.
 *
 * Same-message duplicates (one assistant calling the same id twice)
 * are not collisions — they're a legitimate parallel call shape and
 * would be handled by the assistant's own emit logic. We only flag
 * cross-message reuse.
 */
export function detectDuplicateToolCallIds(
  messages: OpenAI.ChatCompletionMessageParam[],
): ToolCallIdCollision[] {
  const idsByFirstIndex = new Map<string, number[]>()
  for (let i = 0; i < messages.length; i++) {
    const msg = normalizeMessage(messages[i]!)
    if (msg.role !== "assistant") continue
    const seenInThisMessage = new Set<string>()
    for (const call of msg.toolCalls) {
      if (!call.id || seenInThisMessage.has(call.id)) continue
      seenInThisMessage.add(call.id)
      const indices = idsByFirstIndex.get(call.id) ?? []
      indices.push(i)
      idsByFirstIndex.set(call.id, indices)
    }
  }
  const collisions: ToolCallIdCollision[] = []
  for (const [id, indices] of idsByFirstIndex) {
    if (indices.length > 1) collisions.push({ id, indices })
  }
  return collisions
}

export function repairSessionMessages(messages: OpenAI.ChatCompletionMessageParam[]): OpenAI.ChatCompletionMessageParam[] {
  const normalized = messages.map(normalizeMessage)
  const violations = validateSessionMessages(messages)
  if (violations.length === 0) return normalized.map(toProviderMessage)

  const result: NormalizedProviderMessage[] = []
  for (const msg of normalized) {
    if (msg.role === "assistant" && result.length > 0) {
      const prev = result[result.length - 1]
      if (prev.role === "assistant" && prev.toolCalls.length === 0) {
        const prevContent = contentText(prev.content)
        const curContent = contentText(msg.content)
        prev.content = `${prevContent}\n\n${curContent}`
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

  return result.map(toProviderMessage)
}

function repairToolCallSequences(
  messages: OpenAI.ChatCompletionMessageParam[],
  inlineReasoningStrippedCallIds: Set<string> = new Set(),
): OpenAI.ChatCompletionMessageParam[] {
  const normalized = messages.map(normalizeMessage)

  // Position-aware orphan detection. A tool result is orphaned if there is
  // no preceding assistant message in the array whose tool_calls contain the
  // matching id. (The previous logic checked all assistant messages
  // globally, which kept tool results that appeared BEFORE their matching
  // assistant — invalid order — and triggered MiniMax error 2013 on replay.)
  let removed = 0
  const seenCallIds = new Set<string>()
  const repaired = normalized.filter((msg) => {
    if (msg.role === "assistant") {
      for (const tc of msg.toolCalls) seenCallIds.add(tc.id)
      return true
    }
    if (msg.role !== "tool") return true
    const keep = msg.toolCallId !== null && seenCallIds.has(msg.toolCallId)
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

  let injected = 0
  for (let i = 0; i < repaired.length; i++) {
    const msg = repaired[i]!
    if (msg.role !== "assistant" || msg.toolCalls.length === 0) continue

    const resultIds = new Set<string>()
    for (let j = i + 1; j < repaired.length; j++) {
      const following = repaired[j]!
      if (following.role === "tool" && following.toolCallId !== null) {
        resultIds.add(following.toolCallId)
        continue
      }
      if (following.role === "assistant" || following.role === "user") break
    }

    const missing = msg.toolCalls.filter((toolCall) => !resultIds.has(toolCall.id))
    if (missing.length === 0) continue

    const syntheticResults: NormalizedProviderMessage[] = missing.map((toolCall) => ({
      role: "tool",
      content: buildSyntheticToolResultMessage(toolCall.id, inlineReasoningStrippedCallIds),
      name: null,
      toolCallId: toolCall.id,
      toolCalls: [],
      hadToolCallsField: false,
    }))
    let insertAt = i + 1
    while (insertAt < repaired.length && repaired[insertAt]!.role === "tool") insertAt++
    repaired.splice(insertAt, 0, ...syntheticResults)
    injected += syntheticResults.length
  }

  if (injected > 0) {
    emitNervesEvent({
      level: "info",
      event: "mind.session_orphan_tool_call_repair",
      component: "mind",
      message: "injected synthetic tool results for orphaned tool calls",
      meta: { injected },
    })
  }

  return repaired.map(toProviderMessage)
}

function canonicalizeSystemMessageSequence(
  messages: OpenAI.ChatCompletionMessageParam[],
): OpenAI.ChatCompletionMessageParam[] {
  const normalized = messages.map(normalizeMessage)
  const firstSystemIndex = normalized.findIndex((msg) => msg.role === "system")
  if (firstSystemIndex === -1) return normalized.map(toProviderMessage)

  const extraSystemCount = normalized.filter((msg) => msg.role === "system").length - 1
  if (firstSystemIndex === 0 && extraSystemCount === 0) {
    return normalized.map(toProviderMessage)
  }

  const primarySystem = normalized[firstSystemIndex]!
  const nonSystemMessages = normalized.filter((msg) => msg.role !== "system")
  const repaired = [primarySystem, ...nonSystemMessages].map(toProviderMessage)

  emitNervesEvent({
    level: "info",
    event: "mind.session_system_prompt_repair",
    component: "mind",
    message: "canonicalized session system prompt sequence",
    meta: {
      firstSystemIndex,
      extraSystemCount,
      finalMessageCount: repaired.length,
    },
  })

  return repaired
}

export function migrateToolNames(messages: OpenAI.ChatCompletionMessageParam[]): OpenAI.ChatCompletionMessageParam[] {
  const safeMessages = messages.filter((message): message is OpenAI.ChatCompletionMessageParam => Boolean(message) && typeof message === "object")
  let migrated = 0
  for (const message of safeMessages) {
    const record = message as {
      role?: unknown
      tool_calls?: unknown
    }
    if (record.role !== "assistant" || !Array.isArray(record.tool_calls)) continue
    for (const toolCall of record.tool_calls) {
      if (!toolCall || typeof toolCall !== "object") continue
      const toolRecord = toolCall as {
        type?: unknown
        function?: { name?: unknown }
      }
      if (toolRecord.type !== "function") continue
      const originalName = toolRecord.function?.name
      if (typeof originalName !== "string") continue
      if (TOOL_NAME_MIGRATIONS[originalName]) migrated += 1
    }
  }

  if (migrated > 0) {
    emitNervesEvent({
      level: "info",
      event: "mind.session_tool_name_migration",
      component: "mind",
      message: "migrated deprecated tool names in session history",
      meta: { migrated },
    })
  }

  return safeMessages.map(normalizeMessage).map(toProviderMessage)
}

/**
 * Strip inline `<think>...</think>` blocks from a string. Mirrors the
 * helper at senses/shared-turn.ts (operator-facing) and core.ts
 * (live-turn) — kept inline here because session-events.ts is the load-
 * time repair path and needs its own copy to avoid sense/heart import
 * cycles. If the close tag is missing, drops everything from the open
 * tag onward.
 */
function stripInlineThinkBlocks(input: string): string {
  let out = input
  for (;;) {
    const open = out.indexOf("<think>")
    if (open === -1) break
    const close = out.indexOf("</think>", open + "<think>".length)
    if (close === -1) {
      out = out.slice(0, open)
      break
    }
    out = out.slice(0, open) + out.slice(close + "</think>".length)
  }
  return out.trim()
}

/**
 * Strip inline `<think>` content from any assistant message that ALSO has
 * tool_calls. MiniMax-style models persist think-content + tool_calls on
 * the same assistant turn; replaying that combination triggers MiniMax
 * error 2013 ("tool result's tool id not found") and stalls the session.
 *
 * AX requirement: the agent MUST see that this happened. We don't silently
 * paper over their previous turn — we strip for replay correctness AND
 * collect the affected tool_call_ids in `inlineReasoningStrippedCallIds`
 * so the downstream synthetic-tool-result repair can produce an
 * explanatory message addressed to those specific calls. The agent sees:
 * "your previous tool call's result was lost because the assistant message
 * had inline reasoning blocks the provider couldn't replay — here's what
 * happened, retry if needed." Full awareness, no silent corrections.
 *
 * This load-time repair self-heals existing sessions that were saved
 * before the persist-time strip in core.ts landed.
 */
function repairInlineReasoningOnReplay(
  messages: OpenAI.ChatCompletionMessageParam[],
  inlineReasoningStrippedCallIds: Set<string>,
): OpenAI.ChatCompletionMessageParam[] {
  let repaired = 0
  const result = messages.map((msg) => {
    if (msg.role !== "assistant") return msg
    const a = msg as OpenAI.ChatCompletionAssistantMessageParam
    if (!a.tool_calls || a.tool_calls.length === 0) return msg
    if (typeof a.content !== "string") return msg
    if (!a.content.includes("<think>")) return msg
    const stripped = stripInlineThinkBlocks(a.content)
    repaired++
    for (const tc of a.tool_calls) inlineReasoningStrippedCallIds.add(tc.id)
    return { ...a, content: stripped.length > 0 ? stripped : null } as OpenAI.ChatCompletionAssistantMessageParam
  })
  if (repaired > 0) {
    emitNervesEvent({
      level: "info",
      event: "mind.session_inline_reasoning_repair",
      component: "mind",
      message: "stripped inline <think> blocks from assistant messages with tool_calls so replay is valid; agent will see explanatory tool-result messages",
      meta: { repaired, affectedCallIds: inlineReasoningStrippedCallIds.size },
    })
  }
  return result
}

/**
 * Compose the synthetic tool-result message the agent sees when their
 * previous turn's tool call has no matching tool result. The default
 * message tells the agent what happened (turn ended early, result lost)
 * and what to do (retry if the work isn't done). When the parent
 * assistant message had inline `<think>` reasoning that the provider
 * rejected, the message is more specific so the agent can adjust.
 *
 * AX rule: every repair must produce a message the agent can read and
 * act on. Silent strips are never OK.
 */
function buildSyntheticToolResultMessage(
  toolCallId: string,
  inlineReasoningStrippedCallIds: Set<string>,
): string {
  if (inlineReasoningStrippedCallIds.has(toolCallId)) {
    return [
      "error: this tool call's result was lost.",
      "your previous assistant turn included inline `<think>...</think>` reasoning alongside tool_calls,",
      "and the provider (likely MiniMax) rejects that combination on replay (error 2013).",
      "the harness has stripped the inline reasoning from the persisted content so the next replay is valid;",
      "your reasoning trace itself is preserved out-of-band and not lost.",
      "if the underlying work still needs to be done, retry the tool call now —",
      "the call may not have run, or it ran but the result didn't reach you.",
    ].join(" ")
  }
  return [
    "error: this tool call's result was lost — the previous turn ended before the tool finished",
    "(provider rejection, daemon interrupt, or the tool itself errored).",
    "if the work needs to be done, retry the tool call now.",
  ].join(" ")
}

export function sanitizeProviderMessages(messages: OpenAI.ChatCompletionMessageParam[]): OpenAI.ChatCompletionMessageParam[] {
  const safeMessages = messages.filter((message): message is OpenAI.ChatCompletionMessageParam => Boolean(message) && typeof message === "object")
  const normalized = safeMessages.map(normalizeMessage)
  const violations = validateSessionMessages(safeMessages)
  if (violations.length > 0) {
    emitNervesEvent({
      level: "info",
      event: "mind.session_invariant_violation",
      component: "mind",
      message: "session invariant violated",
      meta: { violations },
    })
  }
  // Track which tool_call_ids belonged to assistant messages whose inline
  // reasoning we just stripped. The synthetic-tool-result repair downstream
  // uses this set to produce an explanatory message for those calls so the
  // agent has full awareness of what happened.
  const inlineReasoningStrippedCallIds = new Set<string>()
  return canonicalizeSystemMessageSequence(
    migrateToolNames(
      repairToolCallSequences(
        repairInlineReasoningOnReplay(
          repairSessionMessages(normalized.map(toProviderMessage)),
          inlineReasoningStrippedCallIds,
        ),
        inlineReasoningStrippedCallIds,
      ),
    ),
  )
}

export function stampIngressTime(msg: OpenAI.ChatCompletionMessageParam): void {
  (msg as unknown as Record<string, unknown>)._ingressAt = new Date().toISOString()
}

export function getIngressTime(msg: OpenAI.ChatCompletionMessageParam): string | null {
  const value = (msg as unknown as Record<string, unknown>)._ingressAt
  return typeof value === "string" ? value : null
}

function createEventTime(
  role: SessionEventRole,
  recordedAt: string,
  captureKind: SessionEventCaptureKind,
  ingressAt?: string | null,
): SessionEventTime {
  if (captureKind === "migration") {
    return {
      authoredAt: null,
      authoredAtSource: "migration",
      observedAt: null,
      observedAtSource: "migration",
      recordedAt,
      recordedAtSource: "migration",
    }
  }

  if (role === "user") {
    return {
      authoredAt: null,
      authoredAtSource: "unknown",
      observedAt: ingressAt ?? recordedAt,
      observedAtSource: "ingest",
      recordedAt,
      recordedAtSource: "save",
    }
  }

  return {
    authoredAt: recordedAt,
    authoredAtSource: "local",
    observedAt: recordedAt,
    observedAtSource: "local",
    recordedAt,
    recordedAtSource: "save",
  }
}

function buildEventFromMessage(
  message: OpenAI.ChatCompletionMessageParam,
  sequence: number,
  recordedAt: string,
  captureKind: SessionEventCaptureKind,
  sourceMessageIndex: number | null,
  legacyVersion: number | null,
  ingressAt?: string | null,
): SessionEvent {
  const normalized = normalizeMessage(message)
  const role = normalized.role

  return {
    id: makeEventId(sequence),
    sequence,
    role,
    content: normalized.content,
    name: normalized.name,
    toolCallId: role === "tool" ? normalized.toolCallId : null,
    toolCalls: role === "assistant" ? normalized.toolCalls : [],
    attachments: [],
    time: createEventTime(role, recordedAt, captureKind, ingressAt),
    relations: {
      replyToEventId: null,
      threadRootEventId: null,
      references: [],
      toolCallId: role === "tool" ? normalized.toolCallId : null,
      supersedesEventId: null,
      redactsEventId: null,
    },
    provenance: {
      captureKind,
      legacyVersion,
      sourceMessageIndex,
    },
  }
}

export function projectProviderMessages(envelope: SessionEnvelope): OpenAI.ChatCompletionMessageParam[] {
  const eventIds = envelope.projection.eventIds.length > 0
    ? envelope.projection.eventIds
    : envelope.events.map((event) => event.id)
  const byId = new Map(envelope.events.map((event) => [event.id, event] as const))

  return eventIds
    .map((id) => byId.get(id))
    .filter((event): event is SessionEvent => Boolean(event))
    .map((event) => toProviderMessage({
      role: event.role,
      content: event.content,
      name: event.name,
      toolCallId: event.toolCallId,
      toolCalls: event.toolCalls,
      hadToolCallsField: event.toolCalls.length > 0,
    }))
}

/**
 * Annotate user and assistant messages with a relative time offset tag.
 * System and tool messages are untouched.
 */
export function annotateMessageTimestamps(
  envelope: SessionEnvelope,
  messages: OpenAI.ChatCompletionMessageParam[],
  nowMs = Date.now(),
): OpenAI.ChatCompletionMessageParam[] {
  const eventIds = envelope.projection.eventIds.length > 0
    ? envelope.projection.eventIds
    : envelope.events.map((event) => event.id)
  const byId = new Map(envelope.events.map((event) => [event.id, event] as const))
  const events = eventIds
    .map((id) => byId.get(id))
    .filter((event): event is SessionEvent => Boolean(event))

  return messages.map((msg, i) => {
    const event = events[i]
    if (!event) return msg
    if (event.role !== "user" && event.role !== "assistant") return msg
    const ts = bestEventTimestamp(event)
    const elapsed = nowMs - Date.parse(ts)
    if (elapsed < 0) return msg
    const tag = elapsed < 60000 ? "[just now]" : `[-${formatElapsedCompact(elapsed)}]`
    if (typeof msg.content === "string" && msg.content.length > 0) {
      return { ...msg, content: `${tag} ${msg.content}` }
    }
    return msg
  })
}

/** Compact elapsed format for message annotations: "3m", "2h", "1d". */
function formatElapsedCompact(ms: number): string {
  const minutes = Math.max(1, Math.floor(ms / 60000))
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  const days = Math.floor(hours / 24)
  return `${days}d`
}

export function bestEventTimestamp(event: SessionEvent): string {
  return event.time.authoredAt ?? event.time.observedAt ?? event.time.recordedAt
}

export function formatSessionEventTimestamp(event: SessionEvent): string {
  const iso = bestEventTimestamp(event)
  const date = new Date(iso)
  const year = date.getUTCFullYear()
  const month = String(date.getUTCMonth() + 1).padStart(2, "0")
  const day = String(date.getUTCDate()).padStart(2, "0")
  const hour = String(date.getUTCHours()).padStart(2, "0")
  const minute = String(date.getUTCMinutes()).padStart(2, "0")
  return `${year}-${month}-${day} ${hour}:${minute}`
}

export function extractEventText(event: SessionEvent): string {
  return contentText(event.content)
}

export function deriveSessionChronology(events: SessionEvent[]): SessionChronology {
  let lastInboundAt: string | null = null
  let lastOutboundAt: string | null = null
  let lastActivityAt: string | null = null
  let lastAssistantSequence = -1

  for (const event of events) {
    if (event.role === "system") continue
    const at = bestEventTimestamp(event)
    lastActivityAt = at
    if (event.role === "user") {
      lastInboundAt = at
    }
    if (event.role === "assistant") {
      lastOutboundAt = at
      lastAssistantSequence = event.sequence
    }
  }

  const unansweredInboundCount = events.filter((event) => event.role === "user" && event.sequence > lastAssistantSequence).length

  return {
    lastInboundAt,
    lastOutboundAt,
    lastActivityAt,
    unansweredInboundCount,
  }
}

export function describeCurrentSessionTiming(events: SessionEvent[], nowMs = Date.now()): string {
  const chronology = deriveSessionChronology(events)
  const parts: string[] = []
  if (chronology.lastInboundAt) {
    parts.push(`last inbound ${formatElapsed(nowMs - Date.parse(chronology.lastInboundAt))}`)
  }
  if (chronology.lastOutboundAt) {
    parts.push(`i last replied ${formatElapsed(nowMs - Date.parse(chronology.lastOutboundAt))}`)
  }
  if (chronology.unansweredInboundCount > 0) {
    const count = chronology.unansweredInboundCount
    parts.push(`${count} unanswered inbound message${count === 1 ? "" : "s"}`)
  }
  return parts.length > 0 ? `current thread: ${parts.join("; ")}` : ""
}

export function migrateLegacySessionEnvelope(
  raw: unknown,
  options: Required<SessionEnvelopeParseOptions>,
): SessionEnvelope | null {
  if (!raw || typeof raw !== "object") return null
  const legacy = raw as SessionEnvelopeV1
  const looksLegacy = legacy.version === 1
    || (legacy.version == null && ("messages" in legacy || "lastUsage" in legacy || "state" in legacy))
  if (!looksLegacy) return null

  const messages = Array.isArray(legacy.messages)
    ? sanitizeProviderMessages(legacy.messages as OpenAI.ChatCompletionMessageParam[])
    : []
  const recordedAt = options.fileMtimeAt ?? options.recordedAt
  const events = messages.map((message, index) =>
    buildEventFromMessage(message, index + 1, recordedAt, "migration", index, 1),
  )

  return {
    version: 2,
    events,
    projection: {
      eventIds: events.map((event) => event.id),
      trimmed: false,
      maxTokens: null,
      contextMargin: null,
      inputTokens: null,
      projectedAt: recordedAt,
    },
    lastUsage: normalizeUsage(legacy.lastUsage),
    state: normalizeContinuityState(legacy.state),
  }
}

export function parseSessionEnvelope(raw: unknown, options: SessionEnvelopeParseOptions = {}): SessionEnvelope | null {
  const recordedAt = options.recordedAt ?? new Date().toISOString()
  const fileMtimeAt = options.fileMtimeAt ?? null
  const migrated = migrateLegacySessionEnvelope(raw, { recordedAt, fileMtimeAt })
  if (migrated) return migrated
  if (!raw || typeof raw !== "object") return null

  const record = raw as Record<string, unknown>
  if (record.version !== 2 || !Array.isArray(record.events) || !record.projection || typeof record.projection !== "object") {
    return null
  }

  const rawEvents = record.events
    .filter((event): event is Record<string, unknown> => event != null && typeof event === "object")
    .map((event, index) => {
      const role = normalizeRole(event.role)
      const time = event.time as Record<string, unknown> | undefined
      const relations = event.relations as Record<string, unknown> | undefined
      const provenance = event.provenance as Record<string, unknown> | undefined
      const content = sanitizeConversationContent(role, normalizeContent(event.content))
      return {
        id: typeof event.id === "string" ? event.id : makeEventId(index + 1),
        sequence: typeof event.sequence === "number" ? event.sequence : index + 1,
        role,
        content,
        name: typeof event.name === "string" ? event.name : null,
        toolCallId: typeof event.toolCallId === "string" ? event.toolCallId : null,
        toolCalls: normalizeToolCalls(event.toolCalls),
        attachments: Array.isArray(event.attachments) ? event.attachments.filter((item): item is string => typeof item === "string") : [],
        time: {
          authoredAt: typeof time?.authoredAt === "string" ? time.authoredAt : null,
          authoredAtSource: typeof time?.authoredAtSource === "string" ? time.authoredAtSource as SessionEventTimeSource : "unknown",
          observedAt: typeof time?.observedAt === "string" ? time.observedAt : null,
          observedAtSource: typeof time?.observedAtSource === "string" ? time.observedAtSource as SessionEventTimeSource : "unknown",
          recordedAt: typeof time?.recordedAt === "string" ? time.recordedAt : recordedAt,
          recordedAtSource: typeof time?.recordedAtSource === "string" ? time.recordedAtSource as SessionEventTimeSource : "save",
        },
        relations: {
          replyToEventId: typeof relations?.replyToEventId === "string" ? relations.replyToEventId : null,
          threadRootEventId: typeof relations?.threadRootEventId === "string" ? relations.threadRootEventId : null,
          references: Array.isArray(relations?.references) ? relations.references.filter((item): item is string => typeof item === "string") : [],
          toolCallId: typeof relations?.toolCallId === "string" ? relations.toolCallId : null,
          supersedesEventId: typeof relations?.supersedesEventId === "string" ? relations.supersedesEventId : null,
          redactsEventId: typeof relations?.redactsEventId === "string" ? relations.redactsEventId : null,
        },
        provenance: {
          captureKind: typeof provenance?.captureKind === "string" ? provenance.captureKind as SessionEventCaptureKind : "live",
          legacyVersion: typeof provenance?.legacyVersion === "number" ? provenance.legacyVersion : null,
          sourceMessageIndex: typeof provenance?.sourceMessageIndex === "number" ? provenance.sourceMessageIndex : null,
        },
      } satisfies SessionEvent
    })

  // Self-heal duplicate event ids that may have been written by concurrent
  // writers in older harness versions. Last-occurrence-wins by id (later
  // entries in the persisted file are the more recent state for that id).
  // We preserve the original document order otherwise, so projection.eventIds
  // still resolves predictably.
  const events = dedupeEventsByIdLastWins(rawEvents)

  const projection = record.projection as Record<string, unknown>

  return {
    version: 2,
    events,
    projection: {
      eventIds: Array.isArray(projection.eventIds) ? projection.eventIds.filter((item): item is string => typeof item === "string") : [],
      trimmed: projection.trimmed === true,
      maxTokens: typeof projection.maxTokens === "number" ? projection.maxTokens : null,
      contextMargin: typeof projection.contextMargin === "number" ? projection.contextMargin : null,
      inputTokens: typeof projection.inputTokens === "number" ? projection.inputTokens : null,
      projectedAt: typeof projection.projectedAt === "string" ? projection.projectedAt : null,
    },
    lastUsage: normalizeUsage(record.lastUsage),
    state: normalizeContinuityState(record.state),
  }
}

export function loadSessionEnvelopeFile(filePath: string): SessionEnvelope | null {
  try {
    const raw = fs.readFileSync(filePath, "utf-8")
    let mtime: string
    try {
      mtime = fs.statSync(filePath).mtime.toISOString()
    } catch {
      mtime = new Date().toISOString()
    }
    return parseSessionEnvelope(JSON.parse(raw), {
      recordedAt: mtime,
      fileMtimeAt: mtime,
    })
  } catch {
    return null
  }
}

function messageRole(msg: OpenAI.ChatCompletionMessageParam): SessionEventRole {
  return normalizeRole((msg as unknown as Record<string, unknown>).role)
}

function filterNonSystem(messages: OpenAI.ChatCompletionMessageParam[]): OpenAI.ChatCompletionMessageParam[] {
  return messages.filter((msg) => messageRole(msg) !== "system")
}

/**
 * Compare two message arrays by their non-system messages only.
 * Returns the number of matching non-system messages from the start.
 * System messages (whose content changes every turn due to live world-state)
 * are excluded so that prefix matching is not defeated by system prompt updates.
 */
function findCommonPrefixLength(a: OpenAI.ChatCompletionMessageParam[], b: OpenAI.ChatCompletionMessageParam[]): number {
  const aNonSys = filterNonSystem(a)
  const bNonSys = filterNonSystem(b)
  const max = Math.min(aNonSys.length, bNonSys.length)
  for (let i = 0; i < max; i++) {
    if (messageFingerprint(aNonSys[i]!) !== messageFingerprint(bNonSys[i]!)) return i
  }
  return max
}


function selectProjectedEventIds(
  currentMessages: OpenAI.ChatCompletionMessageParam[],
  currentEventIds: string[],
  trimmedMessages: OpenAI.ChatCompletionMessageParam[],
): string[] {
  if (trimmedMessages.length === 0) return []
  const trimmedFingerprints = trimmedMessages.map(messageFingerprint)
  const result: string[] = []
  let needle = 0

  for (let i = 0; i < currentMessages.length && needle < trimmedFingerprints.length; i++) {
    if (messageFingerprint(currentMessages[i]!) !== trimmedFingerprints[needle]) continue
    result.push(currentEventIds[i]!)
    needle++
  }

  return result
}

export interface SessionEnvelopeBuildResult {
  envelope: SessionEnvelope
  evictedEvents: SessionEvent[]
}

export function buildCanonicalSessionEnvelope(options: SessionEnvelopeBuildOptions): SessionEnvelopeBuildResult {
  const existing = options.existing
  // Callers pass pre-sanitized messages + pre-captured ingress times.
  const currentIngressTimes = options.currentIngressTimes ?? options.currentMessages.map(getIngressTime)
  const previousMessages = options.previousMessages
  const currentMessages = options.currentMessages
  const trimmedMessages = options.trimmedMessages
  const previousProjectionIds = existing?.projection.eventIds.length
    ? [...existing.projection.eventIds]
    : existing?.events.map((event) => event.id) ?? []

  // Compare only non-system messages to find the common prefix.
  // System messages change every turn (live world-state in system prompt)
  // and must not defeat prefix matching of the actual conversation.
  const nonSystemPrefix = findCommonPrefixLength(previousMessages, currentMessages)

  // Build a lookup of non-system previous projection IDs.
  const prevNonSystemIds: string[] = []
  for (let i = 0; i < previousMessages.length; i++) {
    if (messageRole(previousMessages[i]!) !== "system") {
      prevNonSystemIds.push(previousProjectionIds[i]!)
    }
  }

  // Walk currentMessages and build currentEventIds + new events.
  // Non-system messages within the prefix reuse old event IDs.
  // System messages and post-prefix messages get new events.
  const events = [...(existing?.events ?? [])]
  const currentEventIds: string[] = []
  let nonSystemSeen = 0

  for (let i = 0; i < currentMessages.length; i++) {
    const role = messageRole(currentMessages[i]!)
    const isSystem = role === "system"
    const inPrefix = !isSystem && nonSystemSeen < nonSystemPrefix

    if (inPrefix) {
      // Reuse existing event ID for this matched non-system message
      currentEventIds.push(prevNonSystemIds[nonSystemSeen]!)
      nonSystemSeen++
    } else if (isSystem && i < previousMessages.length
      && messageRole(previousMessages[i]!) === "system"
      && messageFingerprint(currentMessages[i]!) === messageFingerprint(previousMessages[i]!)) {
      // System message at same position with identical content -- reuse event ID
      currentEventIds.push(previousProjectionIds[i]!)
    } else {
      if (!isSystem) nonSystemSeen++
      // Create a new event. Use nextEventSequence(events) instead of
      // `events.length + 1` so that any gap (from pruning, archive replay,
      // or self-heal dedup) cannot collide with an existing id.
      const event = buildEventFromMessage(
        currentMessages[i]!,
        nextEventSequence(events),
        options.recordedAt,
        "live",
        null,
        null,
        currentIngressTimes[i],
      )
      events.push(event)
      currentEventIds.push(event.id)
    }
  }

  const projectionEventIds = selectProjectedEventIds(currentMessages, currentEventIds, trimmedMessages)

  // Prune events: only keep events whose IDs are in the projection.
  // Events not in projection are returned as evicted for archiving.
  const projectionIdSet = new Set(projectionEventIds)
  const prunedEvents = events.filter((event) => projectionIdSet.has(event.id))
  const evictedEvents = events.filter((event) => !projectionIdSet.has(event.id))

  return {
    envelope: {
      version: 2,
      events: prunedEvents,
      projection: {
        eventIds: projectionEventIds,
        trimmed: projectionEventIds.length < currentEventIds.length,
        maxTokens: options.projectionBasis.maxTokens,
        contextMargin: options.projectionBasis.contextMargin,
        inputTokens: options.projectionBasis.inputTokens,
        projectedAt: options.recordedAt,
      },
      lastUsage: normalizeUsage(options.lastUsage),
      state: normalizeContinuityState(options.state),
    },
    evictedEvents,
  }
}

/**
 * Load full event history from both the pruned envelope and the NDJSON archive.
 * Returns all events deduplicated by id and sorted by sequence.
 * Corrupted archive lines are silently skipped.
 */
export function loadFullEventHistory(sessPath: string): SessionEvent[] {
  const envelope = loadSessionEnvelopeFile(sessPath)
  if (!envelope) return []

  const envelopeEvents = envelope.events
  const archivePath = sessPath.replace(/\.json$/, ".archive.ndjson")
  let archiveEvents: SessionEvent[] = []

  try {
    const raw = fs.readFileSync(archivePath, "utf-8")
    const lines = raw.split("\n")
    for (const line of lines) {
      const trimmed = line.trim()
      if (trimmed.length === 0) continue
      try {
        const event = JSON.parse(trimmed) as SessionEvent
        if (event && typeof event.id === "string" && typeof event.sequence === "number") {
          archiveEvents.push(event)
        }
      } catch {
        // Skip corrupted lines
      }
    }
  } catch {
    // Archive file doesn't exist or can't be read -- that's fine
  }

  // Merge, deduplicate by id, sort by sequence
  const seen = new Set<string>()
  const merged: SessionEvent[] = []
  for (const event of [...archiveEvents, ...envelopeEvents]) {
    if (seen.has(event.id)) continue
    seen.add(event.id)
    merged.push(event)
  }
  merged.sort((a, b) => a.sequence - b.sequence)
  return merged
}

/**
 * Append evicted events to an NDJSON archive file.
 * The archive path is derived from the session path by replacing .json with .archive.ndjson.
 * Each event is written as a single JSON line. The file is appended to, not overwritten.
 * Failures are logged and swallowed -- archive write must never crash the persist path.
 */
export function appendEvictedToArchive(sessPath: string, evictedEvents: SessionEvent[]): void {
  if (evictedEvents.length === 0) return
  const archivePath = sessPath.replace(/\.json$/, ".archive.ndjson")
  try {
    const ndjson = evictedEvents.map((event) => JSON.stringify(event)).join("\n") + "\n"
    fs.appendFileSync(archivePath, ndjson)
  } catch (err) {
    emitNervesEvent({
      level: "warn",
      component: "heart",
      event: "heart.archive_write_error",
      message: "failed to write evicted events to archive",
      meta: {
        archivePath,
        eventCount: evictedEvents.length,
        /* v8 ignore next -- defensive: Node fs always throws Error instances @preserve */
        error: err instanceof Error ? err.message : String(err),
      },
    })
  }
}

export function appendSyntheticAssistantEvent(
  envelope: SessionEnvelope,
  content: string,
  recordedAt: string,
): SessionEnvelope {
  // Use nextEventSequence(events) instead of `events.length + 1` so any gap
  // (from pruning, archive replay, or self-heal dedup) cannot collide with
  // an existing event id. Same fix pattern as line 1046.
  const sequence = nextEventSequence(envelope.events)
  const event = buildEventFromMessage(
    { role: "assistant", content },
    sequence,
    recordedAt,
    "synthetic",
    null,
    null,
  )
  return {
    ...envelope,
    events: [...envelope.events, event],
    projection: {
      ...envelope.projection,
      eventIds: [...envelope.projection.eventIds, event.id],
      projectedAt: recordedAt,
      trimmed: false,
    },
  }
}
