// Formats inner dialog session turns for human consumption.
// Used by `ouro thoughts` CLI command to show what the agent has been thinking.

import * as fs from "fs"
import * as path from "path"
import { emitNervesEvent } from "../../nerves/runtime"
import type { PendingMessage } from "../../mind/pending"

export interface ThoughtTurn {
  /** Turn type derived from user message content. */
  type: "boot" | "task" | "heartbeat"
  /** The user-role prompt that triggered this turn. */
  prompt: string
  /** The assistant's response text. */
  response: string
  /** Tool names called during this turn. */
  tools: string[]
  /** Task ID if this was a task-triggered turn. */
  taskId?: string
}

export interface InnerDialogStatus {
  queue: string
  wake: string
  processing: string
  surfaced: string
}

export interface InnerDialogRuntimeState {
  status: "idle" | "running"
  reason?: "boot" | "heartbeat" | "instinct"
  startedAt?: string
  lastCompletedAt?: string
}

function contentToText(content: unknown): string {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content
    .map((part) => {
      if (typeof part === "string") return part
      if (part && typeof part === "object" && "text" in part && typeof part.text === "string") {
        return part.text
      }
      return ""
    })
    .join("\n")
}

function extractToolFunction(
  toolCall: unknown,
): { name?: string; arguments?: string } | null {
  if (!toolCall || typeof toolCall !== "object" || !("function" in toolCall)) return null
  const maybeFunction = (toolCall as { function?: unknown }).function
  if (!maybeFunction || typeof maybeFunction !== "object") return null

  const name = "name" in maybeFunction && typeof maybeFunction.name === "string"
    ? maybeFunction.name
    : undefined
  const argumentsValue = "arguments" in maybeFunction && typeof maybeFunction.arguments === "string"
    ? maybeFunction.arguments
    : undefined

  return { name, arguments: argumentsValue }
}

function classifyTurn(userText: string): { type: ThoughtTurn["type"]; taskId?: string } {
  if (userText.includes("waking up.")) return { type: "boot" }
  const taskMatch = /## task: (.+)$/m.exec(userText)
  if (taskMatch) return { type: "task", taskId: taskMatch[1] }
  return { type: "heartbeat" }
}

function extractToolNames(messages: Array<{ role: string; tool_calls?: unknown[] }>): string[] {
  const names: string[] = []
  for (const msg of messages) {
    if (msg.role === "assistant" && Array.isArray(msg.tool_calls)) {
      for (const tc of msg.tool_calls) {
        const toolFunction = extractToolFunction(tc)
        if (toolFunction?.name && toolFunction.name !== "final_answer") names.push(toolFunction.name)
      }
    }
  }
  return names
}

function extractPendingPromptMessages(prompt: string): string[] {
  return prompt
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("[pending from "))
    .map((line) => {
      const separator = line.indexOf("]: ")
      return separator >= 0 ? line.slice(separator + 3).trim() : ""
    })
    .filter((line) => line.length > 0)
}

function readPendingMessagesForStatus(pendingDir: string): PendingMessage[] {
  if (!fs.existsSync(pendingDir)) return []

  let entries: string[]
  try {
    entries = fs.readdirSync(pendingDir)
  } catch {
    return []
  }

  const files = [
    ...entries.filter((entry) => entry.endsWith(".json.processing")),
    ...entries.filter((entry) => entry.endsWith(".json") && !entry.endsWith(".json.processing")),
  ].sort((a, b) => a.localeCompare(b))

  const messages: PendingMessage[] = []
  for (const file of files) {
    try {
      const raw = fs.readFileSync(path.join(pendingDir, file), "utf-8")
      const parsed = JSON.parse(raw) as PendingMessage
      if (typeof parsed.content === "string") {
        messages.push(parsed)
      }
    } catch {
      // unreadable pending files should not break status queries
    }
  }

  return messages
}

export function formatSurfacedValue(text: string, maxLength = 120): string {
  const firstLine = text
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0)

  if (!firstLine) return "no outward result"
  if (firstLine.length <= maxLength) return `"${firstLine}"`
  return `"${firstLine.slice(0, maxLength - 3)}..."`
}

export function deriveInnerDialogStatus(
  pendingMessages: Array<Pick<PendingMessage, "content" | "timestamp" | "from">>,
  turns: ThoughtTurn[],
  runtimeState?: InnerDialogRuntimeState | null,
): InnerDialogStatus {
  if (runtimeState?.status === "running") {
    return {
      queue: pendingMessages.length > 0 ? "queued to inner/dialog" : "clear",
      wake: "in progress",
      processing: "started",
      surfaced: "nothing yet",
    }
  }

  if (pendingMessages.length > 0) {
    return {
      queue: "queued to inner/dialog",
      wake: "awaiting inner session",
      processing: "pending",
      surfaced: "nothing yet",
    }
  }

  const latestProcessedPendingTurn = [...turns]
    .reverse()
    .find((turn) => extractPendingPromptMessages(turn.prompt).length > 0)

  if (!latestProcessedPendingTurn) {
    return {
      queue: "clear",
      wake: "idle",
      processing: "idle",
      surfaced: "nothing recent",
    }
  }

  return {
    queue: "clear",
    wake: "completed",
    processing: "processed",
    surfaced: formatSurfacedValue(latestProcessedPendingTurn.response),
  }
}

export function formatInnerDialogStatus(status: InnerDialogStatus): string {
  return [
    `queue: ${status.queue}`,
    `wake: ${status.wake}`,
    `processing: ${status.processing}`,
    `surfaced: ${status.surfaced}`,
  ].join("\n")
}

/** Extract text from a final_answer tool call's arguments. */
function extractFinalAnswer(messages: Array<{ role: string; tool_calls?: unknown[] }>): string {
  for (let k = messages.length - 1; k >= 0; k--) {
    const msg = messages[k]
    if (msg.role !== "assistant" || !Array.isArray(msg.tool_calls)) continue
    for (const tc of msg.tool_calls) {
      const toolFunction = extractToolFunction(tc)
      if (toolFunction?.name !== "final_answer") continue
      try {
        const parsed = JSON.parse(toolFunction.arguments ?? "{}")
        if (typeof parsed.answer === "string" && parsed.answer.trim()) return parsed.answer.trim()
      } catch {
        // malformed arguments — skip
      }
    }
  }
  return ""
}

export function extractThoughtResponseFromMessages(
  messages: Array<{ role: string; content?: unknown; tool_calls?: unknown[] }>,
): string {
  const assistantMsgs = messages.filter((message) => message.role === "assistant")
  const lastAssistant = assistantMsgs.reverse().find((message) => contentToText(message.content).trim().length > 0)
  return lastAssistant
    ? contentToText(lastAssistant.content).trim()
    : extractFinalAnswer(messages)
}

export function parseInnerDialogSession(sessionPath: string): ThoughtTurn[] {
  emitNervesEvent({
    component: "daemon",
    event: "daemon.thoughts_parse",
    message: "parsing inner dialog session",
    meta: { sessionPath },
  })

  let raw: string
  try {
    raw = fs.readFileSync(sessionPath, "utf-8")
  } catch {
    return []
  }

  let data: { version: number; messages: Array<{ role: string; content?: unknown; tool_calls?: Array<{ function?: { name?: string } }> }> }
  try {
    data = JSON.parse(raw)
  } catch {
    return []
  }

  if (data.version !== 1 || !Array.isArray(data.messages)) return []

  const turns: ThoughtTurn[] = []
  const messages = data.messages

  // Walk messages, pairing user → (tool calls) → assistant sequences
  let i = 0
  while (i < messages.length) {
    const msg = messages[i]
    if (msg.role === "system") {
      i++
      continue
    }
    if (msg.role !== "user") {
      i++
      continue
    }

    const userText = contentToText(msg.content)
    const classification = classifyTurn(userText)

    // Collect all messages until the next user message (or end)
    const turnMessages: typeof messages = []
    let j = i + 1
    while (j < messages.length && messages[j].role !== "user") {
      turnMessages.push(messages[j])
      j++
    }

    // Find the last assistant text response in this turn.
    // With tool_choice="required", the response may be inside a final_answer tool call.
    const response = extractThoughtResponseFromMessages(turnMessages)
    const tools = extractToolNames(turnMessages)

    turns.push({
      type: classification.type,
      prompt: userText.trim(),
      response,
      tools,
      ...(classification.taskId ? { taskId: classification.taskId } : {}),
    })

    i = j
  }

  return turns
}

export function formatThoughtTurns(turns: ThoughtTurn[], lastN: number): string {
  if (turns.length === 0) return "no inner dialog activity"

  const selected = lastN > 0 ? turns.slice(-lastN) : turns
  /* v8 ignore next -- unreachable: turns.length > 0 checked above, slice always returns ≥1 @preserve */
  if (selected.length === 0) return "no inner dialog activity"

  const lines: string[] = []

  for (const turn of selected) {
    const typeLabel = turn.type === "task" && turn.taskId
      ? `task: ${turn.taskId}`
      : turn.type

    lines.push(`--- ${typeLabel} ---`)

    if (turn.tools.length > 0) {
      lines.push(`tools: ${turn.tools.join(", ")}`)
    }

    if (turn.response) {
      lines.push(turn.response)
    } else {
      lines.push("(no response)")
    }

    lines.push("")
  }

  return lines.join("\n").trim()
}

export function getInnerDialogSessionPath(agentRoot: string): string {
  return path.join(agentRoot, "state", "sessions", "self", "inner", "dialog.json")
}

function getInnerDialogRuntimeStatePath(sessionPath: string): string {
  return path.join(path.dirname(sessionPath), "runtime.json")
}

function readInnerDialogRuntimeState(runtimePath: string): InnerDialogRuntimeState | null {
  try {
    const raw = fs.readFileSync(runtimePath, "utf-8")
    const parsed = JSON.parse(raw) as Partial<InnerDialogRuntimeState>
    if (parsed.status !== "running" && parsed.status !== "idle") return null
    return {
      status: parsed.status,
      reason: parsed.reason === "boot" || parsed.reason === "heartbeat" || parsed.reason === "instinct"
        ? parsed.reason
        : undefined,
      startedAt: typeof parsed.startedAt === "string" ? parsed.startedAt : undefined,
      lastCompletedAt: typeof parsed.lastCompletedAt === "string" ? parsed.lastCompletedAt : undefined,
    }
  } catch {
    return null
  }
}

export function readInnerDialogStatus(sessionPath: string, pendingDir: string, runtimePath = getInnerDialogRuntimeStatePath(sessionPath)): InnerDialogStatus {
  const pendingMessages = readPendingMessagesForStatus(pendingDir)
  const turns = parseInnerDialogSession(sessionPath)
  const runtimeState = readInnerDialogRuntimeState(runtimePath)
  return deriveInnerDialogStatus(pendingMessages, turns, runtimeState)
}

/**
 * Watch a session file and emit new turns as they appear.
 * Returns a cleanup function that stops the watcher.
 */
export function followThoughts(
  sessionPath: string,
  onNewTurns: (formatted: string) => void,
  pollIntervalMs = 1000,
): () => void {
  let displayedCount = parseInnerDialogSession(sessionPath).length

  emitNervesEvent({
    component: "daemon",
    event: "daemon.thoughts_follow_start",
    message: "started following inner dialog session",
    meta: { sessionPath, initialTurns: displayedCount },
  })

  fs.watchFile(sessionPath, { interval: pollIntervalMs }, () => {
    const turns = parseInnerDialogSession(sessionPath)
    if (turns.length > displayedCount) {
      const newTurns = turns.slice(displayedCount)
      onNewTurns(formatThoughtTurns(newTurns, 0))
      displayedCount = turns.length
    }
  })

  return () => {
    fs.unwatchFile(sessionPath)
    emitNervesEvent({
      component: "daemon",
      event: "daemon.thoughts_follow_stop",
      message: "stopped following inner dialog session",
      meta: { sessionPath, totalTurns: displayedCount },
    })
  }
}
