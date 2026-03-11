import type OpenAI from "openai"
import { emitNervesEvent } from "../nerves/runtime"

// A conservative, dependency-free token estimator.
// Goal: avoid context overflows without pulling in tokenizer deps.

const CHARS_PER_TOKEN = 4
const PER_MESSAGE_OVERHEAD_TOKENS = 10

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value)
  } catch {
    return ""
  }
}

function countCharsInContent(content: unknown): number {
  if (!content) return 0
  if (typeof content === "string") return content.length

  if (Array.isArray(content)) {
    let total = 0
    for (const part of content) {
      if (!part) continue
      if (typeof part === "string") {
        total += part.length
        continue
      }
      if (typeof part === "object") {
        // Common OpenAI content-part shapes: {type:"text", text:"..."}
        // Be defensive and only count obvious text-like fields.
        const p = part as Record<string, unknown>
        if (typeof p.text === "string") total += p.text.length
        if (typeof p.content === "string") total += p.content.length
        if (typeof p.name === "string") total += p.name.length
        // As a fallback, stringify small-ish objects. This is conservative.
        if (total === 0) total += safeStringify(p).length
      }
    }
    return total
  }

  if (typeof content === "object") {
    const c = content as Record<string, unknown>
    if (typeof c.text === "string") return c.text.length
    if (typeof c.content === "string") return c.content.length
    return safeStringify(c).length
  }

  return 0
}

function countCharsInToolCalls(toolCalls: unknown): number {
  if (!Array.isArray(toolCalls)) return 0
  let total = 0
  for (const tc of toolCalls) {
    if (!tc || typeof tc !== "object") continue
    const t = tc as Record<string, unknown>
    if (typeof t.id === "string") total += t.id.length
    if (typeof t.type === "string") total += t.type.length
    if (t.function && typeof t.function === "object") {
      const fn = t.function as Record<string, unknown>
      if (typeof fn.name === "string") total += fn.name.length
      if (typeof fn.arguments === "string") total += fn.arguments.length
      else if (fn.arguments != null) total += safeStringify(fn.arguments).length
    }
  }
  return total
}

export function estimateTokensForMessage(msg: OpenAI.ChatCompletionMessageParam): number {
  try {
    let chars = 0
    // role/name/tool_call_id count as metadata.
    const m = msg as unknown as Record<string, unknown>
    if (typeof m.role === "string") chars += m.role.length
    if (typeof m.name === "string") chars += m.name.length
    if (typeof m.tool_call_id === "string") chars += m.tool_call_id.length

    chars += countCharsInContent(m.content)
    chars += countCharsInToolCalls(m.tool_calls)

    return PER_MESSAGE_OVERHEAD_TOKENS + Math.ceil(chars / CHARS_PER_TOKEN)
  } catch (error) {
    emitNervesEvent({
      component: "mind",
      event: "mind.token_estimate_error",
      level: "warn",
      message: "token estimation failed; using overhead fallback",
      meta: { reason: error instanceof Error ? error.message : String(error) },
    })
    // estimator must never throw
    return PER_MESSAGE_OVERHEAD_TOKENS
  }
}

export function estimateTokensForMessages(msgs: OpenAI.ChatCompletionMessageParam[]): number {
  let total = 0
  for (const msg of msgs) total += estimateTokensForMessage(msg)
  return total
}
