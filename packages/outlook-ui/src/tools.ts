/**
 * Tool classification for transcript display.
 *
 * The agent has 5 "mechanism" tools that control flow rather than perform actions.
 * These should be displayed differently from regular tool calls:
 *
 * - settle: Response delivery. The `answer` param IS the agent's message.
 * - rest: Inner dialog turn termination. Just means "done thinking."
 * - ponder: Delegation to inner dialog. `say` = interim response, `thought` = what goes inward.
 * - observe: Chose not to respond (group chats). `reason` = why.
 * - surface: Inner dialog delivering results outward. `content` = delivered message.
 *
 * These are also the tools exempt from the circuit breaker (settle, surface, ponder, rest)
 * because blocking them would trap the agent in an infinite loop.
 */

export type ToolKind = "response" | "delegation" | "rest" | "observe" | "surface" | "action"

export interface ClassifiedToolCall {
  kind: ToolKind
  name: string
  id: string
  /** For settle: the delivered answer. For ponder: the interim `say`. For surface: the delivered content. */
  deliveredText: string | null
  /** For ponder: the thought delegated to inner dialog. */
  delegatedThought: string | null
  /** For settle: the intent (complete/blocked/direct_reply). For observe: the reason. */
  metadata: string | null
  /** Raw arguments string for action tools. */
  rawArgs: string | null
}

const MECHANISM_TOOLS = new Set(["settle", "rest", "ponder", "observe", "surface"])

export function isMechanismTool(name: string): boolean {
  return MECHANISM_TOOLS.has(name)
}

export function classifyToolCall(call: { id: string; function: { name: string; arguments: string } }): ClassifiedToolCall {
  const name = call.function.name
  const args = safeParseArgs(call.function.arguments)

  if (name === "settle") {
    return {
      kind: "response",
      name,
      id: call.id,
      deliveredText: args.answer ?? null,
      delegatedThought: null,
      metadata: args.intent ?? null,
      rawArgs: null,
    }
  }

  if (name === "ponder") {
    return {
      kind: "delegation",
      name,
      id: call.id,
      deliveredText: args.say ?? null,
      delegatedThought: args.thought ?? null,
      metadata: null,
      rawArgs: null,
    }
  }

  if (name === "rest") {
    return {
      kind: "rest",
      name,
      id: call.id,
      deliveredText: null,
      delegatedThought: null,
      metadata: null,
      rawArgs: null,
    }
  }

  if (name === "observe") {
    return {
      kind: "observe",
      name,
      id: call.id,
      deliveredText: null,
      delegatedThought: null,
      metadata: args.reason ?? null,
      rawArgs: null,
    }
  }

  if (name === "surface") {
    return {
      kind: "surface",
      name,
      id: call.id,
      deliveredText: args.content ?? null,
      delegatedThought: null,
      metadata: args.delegationId ?? args.friendId ?? null,
      rawArgs: null,
    }
  }

  // Regular action tool
  return {
    kind: "action",
    name,
    id: call.id,
    deliveredText: null,
    delegatedThought: null,
    metadata: null,
    rawArgs: call.function.arguments,
  }
}

function safeParseArgs(raw: string): Record<string, string> {
  try {
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === "object") return parsed as Record<string, string>
  } catch { /* not JSON */ }
  return {}
}
