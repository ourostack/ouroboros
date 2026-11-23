/**
 * The fourth conversation of a session (pre-registration section 4), run on the host with no sandbox and no household:
 * the final system prompt, Q3 with the model's own three Q1 answers under their labels, then Q4. Its tools are
 * `choose({ first, second, reason })`, whose `first` and `second` take only the session's labels, and
 * `identify({ guesses })`. A Q3 answer without a `choose` call naming one of the three labels gets the nudge once.
 */
import type OpenAI from "openai"
import type { ProviderRuntime } from "../../heart/core"
import { emitNervesEvent } from "../../nerves/runtime"
import { messageOf, NO_CALLBACKS, withoutThinking } from "./guest/loop"
import { CHOOSE_NUDGE, FINAL_SYSTEM_PROMPT, IDENTIFY_QUESTION, choiceQuestion, type Note, type Product } from "./protocol"

export type Choice = { first: string; second: string | null; reason: string }
export type FinalResult = {
  choice: Choice | null
  nudged: boolean
  guesses: Record<string, string> | null
  /** Why the conversation ended early: a refused call or a provider error; null when both questions were answered. */
  ended: string | null
  replies: string[]
}


export function finalTools(labels: readonly string[]): OpenAI.ChatCompletionFunctionTool[] {
  return [
    {
      type: "function",
      function: {
        name: "choose",
        description: "Your first and second choice of the three, and one sentence on what decided it.",
        parameters: {
          type: "object",
          properties: { first: { type: "string", enum: [...labels] }, second: { type: "string", enum: [...labels] }, reason: { type: "string" } },
          required: ["first", "second", "reason"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "identify",
        description: "For each label, the product you think it is, or \"no idea\".",
        parameters: {
          type: "object",
          properties: { guesses: { type: "object", properties: Object.fromEntries(labels.map((label) => [label, { type: "string" }])), additionalProperties: { type: "string" } } },
          required: ["guesses"],
        },
      },
    },
  ]
}

const parse = (text: string): Record<string, unknown> | null => {
  try {
    const value: unknown = JSON.parse(text || "{}")
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null
  } catch {
    return null
  }
}

export function readChoice(args: string, labels: readonly string[]): Choice | null {
  const value = parse(args)
  if (!value || typeof value.first !== "string" || !labels.includes(value.first)) return null
  const second = typeof value.second === "string" && labels.includes(value.second) ? value.second : null
  return { first: value.first, second, reason: typeof value.reason === "string" ? value.reason : "" }
}

export function readGuesses(args: string): Record<string, string> | null {
  const guesses = parse(args)?.guesses
  if (!guesses || typeof guesses !== "object" || Array.isArray(guesses)) return null
  return Object.fromEntries(Object.entries(guesses as Record<string, unknown>).map(([label, guess]) => [label, typeof guess === "string" ? guess : JSON.stringify(guess)]))
}

/** Runs Q3 (with its one nudge) then Q4. `allowNudge` lets the choice's gate take the nudge's call. */
export async function runFinalConversation(input: { runtime: ProviderRuntime; product: Product; notes: readonly [Note, Note, Note]; allowNudge(): void }): Promise<FinalResult> {
  const labels = input.notes.map((note) => note.label)
  const tools = finalTools(labels)
  const messages: OpenAI.ChatCompletionMessageParam[] = [{ role: "system", content: FINAL_SYSTEM_PROMPT }, { role: "user", content: choiceQuestion(input.product, input.notes) }]
  const result: FinalResult = { choice: null, nudged: false, guesses: null, ended: null, replies: [] }
  emitNervesEvent({ component: "eval", event: "eval.interview_final_start", message: "asking an interview session's choice", meta: { labels: labels.join("") } })
  const call = async (): Promise<Awaited<ReturnType<ProviderRuntime["streamTurn"]>> | null> => {
    input.runtime.resetTurnState(messages)
    try {
      const turn = await input.runtime.streamTurn({ messages, activeTools: tools, callbacks: NO_CALLBACKS })
      const content = withoutThinking(turn.content)
      result.replies.push(content)
      messages.push({ role: "assistant", ...(content ? { content } : {}), ...(turn.toolCalls.length ? { tool_calls: turn.toolCalls.map((c) => ({ id: c.id, type: "function" as const, function: { name: c.name, arguments: c.arguments } })) } : {}) })
      return turn
    } catch (error) {
      result.ended = messageOf(error)
      return null
    }
  }
  const answerCalls = (turn: Awaited<ReturnType<ProviderRuntime["streamTurn"]>>, accepted: (name: string, args: string) => boolean): void => {
    for (const toolCall of turn.toolCalls) {
      const ok = accepted(toolCall.name, toolCall.arguments)
      const content = ok ? "Recorded." : "Not recorded."
      messages.push({ role: "tool", tool_call_id: toolCall.id, content })
      input.runtime.appendToolOutput(toolCall.id, content)
    }
  }
  const takeChoice = (name: string, args: string): boolean => {
    if (name !== "choose" || result.choice) return false
    result.choice = readChoice(args, labels)
    return result.choice !== null
  }

  let turn = await call()
  if (!turn) return result
  answerCalls(turn, takeChoice)
  if (!result.choice) {
    result.nudged = true
    input.allowNudge()
    messages.push({ role: "user", content: CHOOSE_NUDGE })
    turn = await call()
    if (!turn) return result
    answerCalls(turn, takeChoice)
  }
  if (!result.choice) {
    emitNervesEvent({ component: "eval", level: "warn", event: "eval.interview_no_choice", message: "the session's model never called choose", meta: {} })
  }
  messages.push({ role: "user", content: IDENTIFY_QUESTION })
  turn = await call()
  if (!turn) return result
  answerCalls(turn, (name, args) => {
    if (name !== "identify" || result.guesses) return false
    result.guesses = readGuesses(args)
    return result.guesses !== null
  })
  emitNervesEvent({ component: "eval", event: "eval.interview_final_end", message: "finished an interview session's choice", meta: { chosen: result.choice !== null, nudged: result.nudged } })
  return result
}
