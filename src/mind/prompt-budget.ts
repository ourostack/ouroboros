import type OpenAI from "openai"
import { emitNervesEvent } from "../nerves/runtime"

export const PROMPT_BUDGET_POLICY_VERSION = "prompt-budget/v1" as const
export const PROMPT_BUDGET_FALLBACK_CONTEXT_WINDOW_TOKENS = 24_000

export type PromptBudgetStatus = "within_budget" | "trimmed" | "over_budget" | "required_evidence_over_budget"

export type PromptBudgetSource =
  | "system-prompt"
  | "required-current-turn-state"
  | "current-user-message"
  | "active-tool-result-context"
  | "recent-session-tail"
  | "sense-context-packet"
  | "kept-memory"
  | "habit-receipt"
  | "diagnostics"
  | "older-session-history"

export interface PromptBudgetTruncation {
  source: PromptBudgetSource
  reason: string
  beforeTokens: number
  afterTokens: number
  messageCount: number
}

export interface PromptBudgetInput {
  messages: OpenAI.ChatCompletionMessageParam[]
  requiredPromptEvidence?: RequiredPromptEvidence
  provider: string
  model: string
  contextWindowTokens?: number | null
  outputReserveRatio?: number
  protocolReserveRatio?: number
}

export interface RequiredPromptEvidence {
  readonly currentUserMessage: OpenAI.ChatCompletionMessageParam
  readonly verifiedPredecessorMessage?: OpenAI.ChatCompletionMessageParam
}

export interface PromptBudgetResult {
  policyVersion: typeof PROMPT_BUDGET_POLICY_VERSION
  status: PromptBudgetStatus
  messages: OpenAI.ChatCompletionMessageParam[]
  budget: {
    provider: string
    model: string
    contextWindowTokens: number
    outputReserveTokens: number
    protocolReserveTokens: number
    inputTokenLimit: number
  }
  stats: {
    estimatedBeforeTokens: number
    estimatedAfterTokens: number
    originalMessages: number
    finalMessages: number
    droppedMessages: number
    truncations: PromptBudgetTruncation[]
  }
}

export interface RequiredPromptEvidenceBudgetAssessment {
  status: "within_budget" | "required_evidence_over_budget"
  messages: OpenAI.ChatCompletionMessageParam[]
  estimatedTokens: number
  budget: PromptBudgetResult["budget"]
}

interface PromptBudgetItem {
  id: string
  priority: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8
  source: PromptBudgetSource
  messages: OpenAI.ChatCompletionMessageParam[]
  originalMessageCount: number
  compacted?: boolean
  required?: "current-user" | "verified-predecessor"
}

function contentCharacters(content: unknown): number {
  if (typeof content === "string") return content.length
  if (!content) return 0
  if (Array.isArray(content)) {
    return content.reduce((total, part) => {
      if (typeof part === "string") return total + part.length
      if (!part || typeof part !== "object") return total
      const record = part as Record<string, unknown>
      if (typeof record.text === "string") return total + record.text.length
      if (typeof record.content === "string") return total + record.content.length
      try {
        return total + JSON.stringify(record).length
      } catch {
        return total
      }
    }, 0)
  }
  if (typeof content === "object") {
    const record = content as Record<string, unknown>
    if (typeof record.text === "string") return record.text.length
    if (typeof record.content === "string") return record.content.length
    try {
      return JSON.stringify(record).length
    } catch {
      return 0
    }
  }
  return 0
}

function toolCallCharacters(toolCalls: unknown): number {
  if (!Array.isArray(toolCalls)) return 0
  let total = 0
  for (const call of toolCalls) {
    if (!call || typeof call !== "object") continue
    const record = call as Record<string, unknown>
    if (typeof record.id === "string") total += record.id.length
    const fn = record.function
    if (fn && typeof fn === "object") {
      const fnRecord = fn as Record<string, unknown>
      if (typeof fnRecord.name === "string") total += fnRecord.name.length
      if (typeof fnRecord.arguments === "string") total += fnRecord.arguments.length
    }
  }
  return total
}

export function estimatePromptBudgetTokensForMessage(message: OpenAI.ChatCompletionMessageParam): number {
  const record = message as unknown as Record<string, unknown>
  let characters = 0
  if (typeof record.role === "string") characters += record.role.length
  if (typeof record.name === "string") characters += record.name.length
  if (typeof record.tool_call_id === "string") characters += record.tool_call_id.length
  characters += contentCharacters(record.content)
  characters += toolCallCharacters(record.tool_calls)
  return Math.ceil(characters / 4)
}

export function estimatePromptBudgetTokens(messages: OpenAI.ChatCompletionMessageParam[]): number {
  return messages.reduce((total, message) => total + estimatePromptBudgetTokensForMessage(message), 0)
}

function itemTokens(item: PromptBudgetItem): number {
  return estimatePromptBudgetTokens(item.messages)
}

function cloneMessage(message: OpenAI.ChatCompletionMessageParam): OpenAI.ChatCompletionMessageParam {
  return { ...(message as unknown as Record<string, unknown>) } as unknown as OpenAI.ChatCompletionMessageParam
}

function requiredMessagesByIdentity(input: PromptBudgetInput): OpenAI.ChatCompletionMessageParam[] {
  const evidence = input.requiredPromptEvidence
  if (!evidence) return []
  const current = evidence.currentUserMessage
  if (current.role !== "user") {
    throw new Error("required current user message must have role=user")
  }
  const currentMatches = input.messages.filter((message) => message === current)
  if (currentMatches.length !== 1) {
    throw new Error(currentMatches.length === 0
      ? "required current user message is not present by identity"
      : "required current user message must appear exactly once by identity")
  }
  const predecessor = evidence.verifiedPredecessorMessage
  if (predecessor) {
    if (predecessor === current) throw new Error("required predecessor and current user message must be distinct objects")
    if (predecessor.role !== "system") {
      throw new Error("required verified predecessor message must have role=system")
    }
    const predecessorMatches = input.messages.filter((message) => message === predecessor)
    if (predecessorMatches.length !== 1) {
      throw new Error(predecessorMatches.length === 0
        ? "required verified predecessor message is not present by identity"
        : "required verified predecessor message must appear exactly once by identity")
    }
    if (input.messages.indexOf(predecessor) !== input.messages.indexOf(current) - 1) {
      throw new Error("required verified predecessor message must be immediately before the current user message")
    }
  }
  return input.messages.filter((message) => message === current || message === predecessor)
}

function cloneUnlessRequired(
  message: OpenAI.ChatCompletionMessageParam,
  requiredMessages: ReadonlySet<OpenAI.ChatCompletionMessageParam>,
): OpenAI.ChatCompletionMessageParam {
  return requiredMessages.has(message) ? message : cloneMessage(message)
}

function messageText(message: OpenAI.ChatCompletionMessageParam): string {
  return typeof message.content === "string" ? message.content : ""
}

function isSenseContextPacketText(text: string): boolean {
  return /^Untrusted\s+\S+\s+context for this same thread\./.test(text)
}

function sourceRefsFrom(text: string): string[] {
  return [...new Set(text.match(/\bbbmsg:[^\]\s,]+/g) ?? [])]
}

function compactSenseContextItem(item: PromptBudgetItem): PromptBudgetItem {
  const message = item.messages[0]
  const text = messageText(message)
  const firstLine = text.split("\n").find((line) => line.trim().length > 0) as string
  const refs = sourceRefsFrom(text)
  const content = [
    firstLine,
    `[prompt budget compacted message excerpts; source refs retained: ${refs.length > 0 ? refs.join(", ") : "none"}]`,
  ].join("\n")
  return {
    ...item,
    compacted: true,
    messages: [{ ...cloneMessage(message), content }],
  }
}

interface SystemSegment {
  start: number
  end: number
  source: PromptBudgetSource
  priority: PromptBudgetItem["priority"]
}

const SYSTEM_MARKERS: Array<{ marker: string; source: PromptBudgetSource; priority: PromptBudgetItem["priority"] }> = [
  { marker: "## from my kept record", source: "kept-memory", priority: 5 },
  { marker: "## retrieved from my Desk record diary", source: "kept-memory", priority: 5 },
  { marker: "## habit receipt", source: "habit-receipt", priority: 6 },
  { marker: "## run ledger", source: "habit-receipt", priority: 6 },
  { marker: "## diagnostics", source: "diagnostics", priority: 7 },
  { marker: "## doctor", source: "diagnostics", priority: 7 },
  { marker: "## incident bundle", source: "diagnostics", priority: 7 },
  { marker: "## replay", source: "diagnostics", priority: 7 },
]

function classifySystemSegment(text: string): Pick<SystemSegment, "source" | "priority"> {
  const lower = text.toLowerCase()
  if (lower.includes("habit receipt") || lower.includes("run ledger")) return { source: "habit-receipt", priority: 6 }
  if (lower.includes("diagnostics") || lower.includes("doctor") || lower.includes("incident bundle") || lower.includes("replay")) {
    return { source: "diagnostics", priority: 7 }
  }
  return { source: "system-prompt", priority: 1 }
}

function systemItems(message: OpenAI.ChatCompletionMessageParam, index: number): PromptBudgetItem[] {
  const text = messageText(message)
  if (isSenseContextPacketText(text)) {
    return [{
      id: `system:${index}:context`,
      priority: 4,
      source: "sense-context-packet",
      messages: [cloneMessage(message)],
      originalMessageCount: 1,
    }]
  }

  const markerPositions = SYSTEM_MARKERS
    .map((marker) => ({ ...marker, start: text.toLowerCase().indexOf(marker.marker.toLowerCase()) }))
    .filter((entry) => entry.start >= 0)
    .sort((left, right) => left.start - right.start)

  if (markerPositions.length === 0) {
    const classified = classifySystemSegment(text)
    return [{
      id: `system:${index}:0`,
      priority: classified.priority,
      source: classified.source,
      messages: [cloneMessage(message)],
      originalMessageCount: 1,
    }]
  }

  const segments: SystemSegment[] = []
  if (markerPositions[0].start > 0) {
    segments.push({ start: 0, end: markerPositions[0].start, source: "system-prompt", priority: 1 })
  }
  markerPositions.forEach((position, markerIndex) => {
    segments.push({
      start: position.start,
      end: markerPositions[markerIndex + 1]?.start ?? text.length,
      source: position.source,
      priority: position.priority,
    })
  })

  return segments
    .map((segment, segmentIndex): PromptBudgetItem | null => {
      const content = text.slice(segment.start, segment.end).trim()
      if (!content) return null
      return {
        id: `system:${index}:${segmentIndex}`,
        priority: segment.priority,
        source: segment.source,
        messages: [{ ...cloneMessage(message), content }],
        originalMessageCount: segmentIndex === 0 ? 1 : 0,
      }
    })
    .filter((item): item is PromptBudgetItem => item !== null)
}

function assistantHasToolCalls(message: OpenAI.ChatCompletionMessageParam): boolean {
  return message.role === "assistant"
    && Array.isArray((message as OpenAI.ChatCompletionAssistantMessageParam).tool_calls)
    && (message as OpenAI.ChatCompletionAssistantMessageParam).tool_calls!.length > 0
}

function nonSystemSourceFor(messages: OpenAI.ChatCompletionMessageParam[]): PromptBudgetSource {
  const text = messages.map(messageText).join("\n").toLowerCase()
  if (text.includes("habit receipt") || text.includes("run ledger")) return "habit-receipt"
  if (text.includes("diagnostics") || text.includes("doctor") || text.includes("incident bundle") || text.includes("replay")) return "diagnostics"
  return "recent-session-tail"
}

function buildPromptBudgetItems(
  messages: OpenAI.ChatCompletionMessageParam[],
  requiredPromptEvidence?: RequiredPromptEvidence,
): PromptBudgetItem[] {
  const rawItems: PromptBudgetItem[] = []
  let index = 0
  while (index < messages.length) {
    const message = messages[index]
    if (message === requiredPromptEvidence?.currentUserMessage) {
      rawItems.push({
        id: `required:${index}:current`,
        priority: 1,
        source: "current-user-message",
        messages: [message],
        originalMessageCount: 1,
        required: "current-user",
      })
      index += 1
      continue
    }
    if (message === requiredPromptEvidence?.verifiedPredecessorMessage) {
      rawItems.push({
        id: `required:${index}:predecessor`,
        priority: 1,
        source: "required-current-turn-state",
        messages: [message],
        originalMessageCount: 1,
        required: "verified-predecessor",
      })
      index += 1
      continue
    }
    if (message.role === "system") {
      rawItems.push(...systemItems(message, index))
      index += 1
      continue
    }
    if (assistantHasToolCalls(message)) {
      const block = [cloneMessage(message)]
      let next = index + 1
      while (messages[next]?.role === "tool") {
        block.push(cloneMessage(messages[next]))
        next += 1
      }
      rawItems.push({
        id: `conversation:${index}`,
        priority: 3,
        source: nonSystemSourceFor(block),
        messages: block,
        originalMessageCount: block.length,
      })
      index = next
      continue
    }
    rawItems.push({
      id: `conversation:${index}`,
      priority: 3,
      source: nonSystemSourceFor([message]),
      messages: [cloneMessage(message)],
      originalMessageCount: 1,
    })
    index += 1
  }

  const lastUserItemIndex = rawItems.findLastIndex((item) => item.messages.some((message) => message.role === "user"))
  const latestToolItemIndex = rawItems.findLastIndex((item) =>
    item.messages.some((message) => message.role === "tool" || assistantHasToolCalls(message)),
  )
  return rawItems.map((item, itemIndex) => {
    if (item.required) return item
    if (itemIndex === lastUserItemIndex) {
      return { ...item, priority: 1, source: "current-user-message" }
    }
    if (itemIndex === latestToolItemIndex) {
      return { ...item, priority: 1, source: "active-tool-result-context" }
    }
    if (item.messages.every((message) => message.role === "system")) return item
    if (item.source === "habit-receipt") return { ...item, priority: 6 }
    if (item.source === "diagnostics") return { ...item, priority: 7 }
    if (lastUserItemIndex >= 0 && itemIndex < lastUserItemIndex) return { ...item, priority: 8, source: "older-session-history" }
    return { ...item, priority: 3, source: "recent-session-tail" }
  })
}

function flattenItems(items: PromptBudgetItem[]): OpenAI.ChatCompletionMessageParam[] {
  return items.flatMap((item) => item.messages.map((message) => item.required ? message : cloneMessage(message)))
}

function budgetFor(input: PromptBudgetInput): PromptBudgetResult["budget"] {
  const contextWindowTokens = typeof input.contextWindowTokens === "number" && Number.isFinite(input.contextWindowTokens) && input.contextWindowTokens > 0
    ? Math.floor(input.contextWindowTokens)
    : PROMPT_BUDGET_FALLBACK_CONTEXT_WINDOW_TOKENS
  const outputReserveRatio = input.outputReserveRatio ?? 0.2
  const protocolReserveRatio = input.protocolReserveRatio ?? 0.1
  const outputReserveTokens = Math.floor(contextWindowTokens * outputReserveRatio)
  const protocolReserveTokens = Math.floor(contextWindowTokens * protocolReserveRatio)
  return {
    provider: input.provider,
    model: input.model,
    contextWindowTokens,
    outputReserveTokens,
    protocolReserveTokens,
    inputTokenLimit: Math.max(0, contextWindowTokens - outputReserveTokens - protocolReserveTokens),
  }
}

export function assessRequiredPromptEvidenceBudget(
  input: PromptBudgetInput,
): RequiredPromptEvidenceBudgetAssessment {
  const budget = budgetFor(input)
  const messages = requiredMessagesByIdentity(input)
  const estimatedTokens = estimatePromptBudgetTokens(messages)
  return {
    status: messages.length > 0 && estimatedTokens > budget.inputTokenLimit
      ? "required_evidence_over_budget"
      : "within_budget",
    messages,
    estimatedTokens,
    budget,
  }
}

function totalItemTokens(items: PromptBudgetItem[]): number {
  return estimatePromptBudgetTokens(flattenItems(items))
}

function truncationFor(
  item: PromptBudgetItem,
  reason: string,
  beforeTokens: number,
  afterTokens: number,
): PromptBudgetTruncation {
  return {
    source: item.source,
    reason,
    beforeTokens,
    afterTokens,
    messageCount: item.originalMessageCount,
  }
}

function emitPromptBudgetEvent(result: PromptBudgetResult): void {
  emitNervesEvent({
    component: "mind",
    event: "mind.prompt_budget_applied",
    message: "applied final prompt budget before provider turn",
    meta: {
      status: result.status,
      provider: result.budget.provider,
      model: result.budget.model,
      contextWindowTokens: result.budget.contextWindowTokens,
      inputTokenLimit: result.budget.inputTokenLimit,
      estimatedBeforeTokens: result.stats.estimatedBeforeTokens,
      estimatedAfterTokens: result.stats.estimatedAfterTokens,
      droppedMessages: result.stats.droppedMessages,
      truncationCount: result.stats.truncations.length,
    },
  })
}

export function applyPromptBudget(input: PromptBudgetInput): PromptBudgetResult {
  const requiredAssessment = assessRequiredPromptEvidenceBudget(input)
  const budget = requiredAssessment.budget
  const estimatedBeforeTokens = estimatePromptBudgetTokens(input.messages)
  const truncations: PromptBudgetTruncation[] = []
  const requiredMessages = requiredAssessment.messages
  const requiredMessageSet = new Set(requiredMessages)
  let droppedMessages = 0

  const requiredTokens = requiredAssessment.estimatedTokens
  if (requiredAssessment.status === "required_evidence_over_budget") {
    droppedMessages = input.messages.length - requiredMessages.length
    const result: PromptBudgetResult = {
      policyVersion: PROMPT_BUDGET_POLICY_VERSION,
      status: "required_evidence_over_budget",
      messages: requiredMessages,
      budget,
      stats: {
        estimatedBeforeTokens,
        estimatedAfterTokens: requiredTokens,
        originalMessages: input.messages.length,
        finalMessages: requiredMessages.length,
        droppedMessages,
        truncations,
      },
    }
    emitPromptBudgetEvent(result)
    return result
  }

  if (estimatedBeforeTokens <= budget.inputTokenLimit) {
    const result: PromptBudgetResult = {
      policyVersion: PROMPT_BUDGET_POLICY_VERSION,
      status: "within_budget",
      messages: input.messages.map((message) => cloneUnlessRequired(message, requiredMessageSet)),
      budget,
      stats: {
        estimatedBeforeTokens,
        estimatedAfterTokens: estimatedBeforeTokens,
        originalMessages: input.messages.length,
        finalMessages: input.messages.length,
        droppedMessages,
        truncations,
      },
    }
    emitPromptBudgetEvent(result)
    return result
  }

  let items = buildPromptBudgetItems(input.messages, input.requiredPromptEvidence)

  for (const priority of [8, 7, 6, 5, 4, 3] as const) {
    if (totalItemTokens(items) <= budget.inputTokenLimit) break
    if (priority === 4) {
      items = items.map((item) => {
        if (item.priority !== 4 || item.compacted) return item
        const beforeTokens = itemTokens(item)
        const compacted = compactSenseContextItem(item)
        const afterTokens = itemTokens(compacted)
        if (afterTokens < beforeTokens) {
          truncations.push(truncationFor(item, "compacted message excerpts to source refs", beforeTokens, afterTokens))
        }
        return compacted
      })
      if (totalItemTokens(items) <= budget.inputTokenLimit) break
    }

    for (let itemIndex = 0; itemIndex < items.length && totalItemTokens(items) > budget.inputTokenLimit; itemIndex += 1) {
      const item = items[itemIndex]
      if (item.priority !== priority) continue
      const beforeTokens = itemTokens(item)
      droppedMessages += item.originalMessageCount
      truncations.push(truncationFor(item, "dropped to fit prompt budget", beforeTokens, 0))
      items = items.filter((_, index) => index !== itemIndex)
      itemIndex -= 1
    }
  }

  const messages = flattenItems(items)
  const estimatedAfterTokens = estimatePromptBudgetTokens(messages)
  const status: PromptBudgetStatus = estimatedAfterTokens <= budget.inputTokenLimit
    ? "trimmed"
    : "over_budget"
  const result: PromptBudgetResult = {
    policyVersion: PROMPT_BUDGET_POLICY_VERSION,
    status,
    messages,
    budget,
    stats: {
      estimatedBeforeTokens,
      estimatedAfterTokens,
      originalMessages: input.messages.length,
      finalMessages: messages.length,
      droppedMessages,
      truncations,
    },
  }
  emitPromptBudgetEvent(result)
  return result
}
