import type OpenAI from "openai"
import { emitNervesEvent } from "../nerves/runtime"

const MAX_GOAL_CHARS = 240
const MAX_LIST_ITEMS = 8

export interface SessionOrientation {
  updatedAt: string
  goal?: string
  constraints: string[]
  progress: string[]
  readFiles: string[]
  modifiedFiles: string[]
}

export interface BuildSessionOrientationOptions {
  now?: string
}

function clip(text: string, limit = MAX_GOAL_CHARS): string {
  const compact = text.replace(/\s+/g, " ").trim()
  if (compact.length <= limit) return compact
  return `${compact.slice(0, Math.max(0, limit - 1))}\u2026`
}

function normalizeContent(content: OpenAI.ChatCompletionMessageParam["content"]): string {
  if (typeof content === "string") return clip(content)
  if (!Array.isArray(content)) return ""

  return clip(
    content
      .map((part) => (
        part && typeof part === "object" && "type" in part && part.type === "text" && "text" in part
          ? String(part.text ?? "")
          : ""
      ))
      .filter(Boolean)
      .join(" "),
  )
}

function dedupe(items: string[], limit = MAX_LIST_ITEMS): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const item of items.map((entry) => entry.trim()).filter(Boolean)) {
    if (seen.has(item)) continue
    seen.add(item)
    result.push(item)
    if (result.length >= limit) break
  }
  return result
}

function splitConstraintCandidates(text: string): string[] {
  return text
    .split(/\n|;|(?<=[a-z0-9])\.\s+/gi)
    .map((part) => part.trim())
    .filter(Boolean)
}

function looksLikeConstraint(text: string): boolean {
  return /^(keep|do not|don't|prefer|avoid|must|should|only|remember|focus on)\b/i.test(text)
    || /\bwithout\b/i.test(text)
}

function extractConstraints(messages: OpenAI.ChatCompletionMessageParam[]): string[] {
  const results: string[] = []
  for (const message of messages) {
    if (message.role !== "user") continue
    const content = normalizeContent(message.content)
    for (const candidate of splitConstraintCandidates(content)) {
      if (looksLikeConstraint(candidate)) {
        results.push(clip(candidate.replace(/[.!]+$/g, "")))
      }
    }
  }
  return dedupe(results)
}

function parseToolArgs(argumentsText: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(argumentsText)
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {}
  } catch {
    return {}
  }
}

function firstString(record: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim()
    }
  }
  return null
}

function isReadTool(name: string): boolean {
  return /^(read|grep|glob|query)/i.test(name)
}

function isWriteTool(name: string): boolean {
  return /^(write|edit|delete|rename|move|patch)/i.test(name)
}

function extractToolSignal(messages: OpenAI.ChatCompletionMessageParam[]): Pick<SessionOrientation, "progress" | "readFiles" | "modifiedFiles"> {
  const progress: string[] = []
  const readFiles: string[] = []
  const modifiedFiles: string[] = []

  for (const message of messages) {
    if (message.role !== "assistant" || !Array.isArray(message.tool_calls)) continue
    for (const toolCall of message.tool_calls) {
      if (toolCall.type !== "function" || !("function" in toolCall)) continue
      const name = toolCall.function.name.trim()
      const args = parseToolArgs(toolCall.function.arguments)
      const pathValue = firstString(args, ["path", "file", "filePath", "target", "targetPath", "source", "sourcePath"])
      const commandValue = firstString(args, ["command", "cmd"])

      if (pathValue) {
        progress.push(`${name} ${pathValue}`)
        if (isReadTool(name)) readFiles.push(pathValue)
        if (isWriteTool(name)) modifiedFiles.push(pathValue)
        continue
      }

      if (commandValue) {
        progress.push(`${name} ${clip(commandValue, 120)}`)
        continue
      }

      progress.push(name)
    }
  }

  return {
    progress: dedupe(progress),
    readFiles: dedupe(readFiles),
    modifiedFiles: dedupe(modifiedFiles),
  }
}

function latestUserGoal(messages: OpenAI.ChatCompletionMessageParam[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message.role !== "user") continue
    const content = normalizeContent(message.content)
    if (content) return content
  }
  return undefined
}

export function normalizeSessionOrientation(value: unknown): SessionOrientation | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  if (typeof record.updatedAt !== "string") return undefined

  const constraints = Array.isArray(record.constraints)
    ? record.constraints.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : []
  const progress = Array.isArray(record.progress)
    ? record.progress.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : []
  const readFiles = Array.isArray(record.readFiles)
    ? record.readFiles.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : []
  const modifiedFiles = Array.isArray(record.modifiedFiles)
    ? record.modifiedFiles.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : []

  return {
    updatedAt: record.updatedAt,
    ...(typeof record.goal === "string" && record.goal.trim().length > 0 ? { goal: record.goal.trim() } : {}),
    constraints: dedupe(constraints),
    progress: dedupe(progress),
    readFiles: dedupe(readFiles),
    modifiedFiles: dedupe(modifiedFiles),
  }
}

export function buildSessionOrientation(
  messages: OpenAI.ChatCompletionMessageParam[],
  previous?: SessionOrientation,
  options?: BuildSessionOrientationOptions,
): SessionOrientation | undefined {
  const goal = latestUserGoal(messages) ?? previous?.goal
  const constraints = dedupe([...(previous?.constraints ?? []), ...extractConstraints(messages)])
  const toolSignal = extractToolSignal(messages)
  const progress = dedupe([...(previous?.progress ?? []), ...toolSignal.progress])
  const readFiles = dedupe([...(previous?.readFiles ?? []), ...toolSignal.readFiles])
  const modifiedFiles = dedupe([...(previous?.modifiedFiles ?? []), ...toolSignal.modifiedFiles])

  if (!goal && constraints.length === 0 && progress.length === 0 && readFiles.length === 0 && modifiedFiles.length === 0) {
    emitNervesEvent({
      event: "mind.session_orientation_built",
      component: "mind",
      message: "session orientation skipped",
      meta: { has_goal: false, constraint_count: 0, progress_count: 0 },
    })
    return undefined
  }

  const orientation: SessionOrientation = {
    updatedAt: options?.now ?? new Date().toISOString(),
    ...(goal ? { goal } : {}),
    constraints,
    progress,
    readFiles,
    modifiedFiles,
  }

  emitNervesEvent({
    event: "mind.session_orientation_built",
    component: "mind",
    message: "session orientation built",
    meta: {
      has_goal: Boolean(goal),
      constraint_count: constraints.length,
      progress_count: progress.length,
      read_file_count: readFiles.length,
      modified_file_count: modifiedFiles.length,
    },
  })

  return orientation
}

export function renderSessionOrientation(orientation?: SessionOrientation): string {
  if (!orientation) {
    emitNervesEvent({
      event: "mind.session_orientation_rendered",
      component: "mind",
      message: "session orientation rendering skipped",
      meta: { rendered: false },
    })
    return ""
  }

  const lines: string[] = ["## session orientation"]

  if (orientation.goal) {
    lines.push(`goal: ${orientation.goal}`)
  }
  if (orientation.constraints.length > 0) {
    lines.push("")
    lines.push("constraints:")
    for (const constraint of orientation.constraints) lines.push(`- ${constraint}`)
  }
  if (orientation.progress.length > 0) {
    lines.push("")
    lines.push("progress:")
    for (const item of orientation.progress) lines.push(`- ${item}`)
  }
  if (orientation.readFiles.length > 0) {
    lines.push("")
    lines.push("read files:")
    for (const file of orientation.readFiles) lines.push(`- ${file}`)
  }
  if (orientation.modifiedFiles.length > 0) {
    lines.push("")
    lines.push("modified files:")
    for (const file of orientation.modifiedFiles) lines.push(`- ${file}`)
  }

  const rendered = lines.length > 1 ? lines.join("\n") : ""

  emitNervesEvent({
    event: "mind.session_orientation_rendered",
    component: "mind",
    message: "session orientation rendered",
    meta: {
      rendered: rendered.length > 0,
      has_goal: Boolean(orientation.goal),
      constraint_count: orientation.constraints.length,
      progress_count: orientation.progress.length,
    },
  })

  return rendered
}
