/**
 * The neutral loop (pre-registration section 7, item 7): the same for every U and X arm, and not the harness's own
 * turn, so the harness favours no arm. It sends the system prompt, the conversation and the arm's tools; runs every
 * tool call the model makes, in order, and sends the results back; and ends a user turn when the model answers with
 * no tool call. One conversation can have several user turns (the job, then its debrief), each starting after the
 * last ended. A provider error, including a call the host refused, ends the whole conversation: no later turn is sent.
 *
 * A failed tool call's result starts `Error: ` in every arm. Every text the arm puts in front of the model (tool names,
 * descriptions, schemas and results) and the system prompt are brand-scrubbed here; the host scans every request again before it is sent. Reasoning the model returns inline (`<think>`) is not
 * sent back, as in the harness.
 */
import type OpenAI from "openai"
import type { ChannelCallbacks, ProviderRuntime } from "../../../heart/core"
import { emitNervesEvent } from "../../../nerves/runtime"
import type { TraceCall, TraceReply } from "../../domain/case"
import { scrubBrands, type Product } from "../protocol"
import type { JsonObject } from "../../../heart/approval-store"
import type { McpToolInfo } from "../../../repertoire/mcp-client"
import { mcpToolSchema } from "../../../repertoire/mcp-tools"
import type { Arm } from "./arms"

export type TurnRecord = {
  /** Index in the conversation's timeline where this user turn's entries start. */
  start: number
  finalReply: string
  /** `settled` when the model answered; otherwise why the conversation ended. */
  outcome: string
  calls: number
}

export type Conversation = { timeline: Array<TraceCall | TraceReply>; turns: TurnRecord[] }

/** The loop streams nothing to anyone: every callback does nothing. */
export const NO_CALLBACKS: ChannelCallbacks = {
  onModelStart: () => undefined, onModelStreamStart: () => undefined, onTextChunk: () => undefined, onReasoningChunk: () => undefined,
  onToolStart: () => undefined, onToolEnd: () => undefined, onError: () => undefined,
}


/** A caught value's message. */
export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Assistant text without the reasoning some models put inline. */
export function withoutThinking(text: string): string {
  return text.replace(/<think>[\s\S]*?(<\/think>|$)/g, "").trim()
}

export async function runConversation(input: {
  runtime: ProviderRuntime
  product: Product
  system: string
  prefix: OpenAI.ChatCompletionMessageParam[]
  /** The user messages, in order: the job's, then each follow-up. */
  userTexts: string[]
  arm: Arm
}): Promise<Conversation> {
  const scrub = (text: string): string => scrubBrands(text, input.product)
  const scrubbed: McpToolInfo[] = input.arm.tools.map((tool) => ({ name: scrub(tool.name), description: scrub(tool.description), inputSchema: JSON.parse(scrub(JSON.stringify(tool.parameters))) as JsonObject }))
  // Each arm's tools are the study's interfaces under test, not the harness's own, so they go to the model the way a
  // connected MCP server's tools do: `mcpToolSchema`, the census's passthrough (ax/census.config.json). A tool named
  // as its own server keeps its name, and every arm's tools have a description, so nothing is added to either.
  const activeTools: OpenAI.ChatCompletionFunctionTool[] = scrubbed.map((tool) => mcpToolSchema({ server: tool.name }, tool))
  const messages: OpenAI.ChatCompletionMessageParam[] = [{ role: "system", content: scrub(input.system) }, ...input.prefix]
  const timeline: Conversation["timeline"] = []
  const turns: TurnRecord[] = []
  emitNervesEvent({ component: "eval", event: "eval.interview_conversation_start", message: "starting a neutral-loop conversation", meta: { arm: input.arm.key, turns: input.userTexts.length } })
  for (const text of input.userTexts) {
    const turn: TurnRecord = { start: timeline.length, finalReply: "", outcome: "settled", calls: 0 }
    turns.push(turn)
    messages.push({ role: "user", content: text })
    input.runtime.resetTurnState(messages)
    for (;;) {
      let result: Awaited<ReturnType<ProviderRuntime["streamTurn"]>>
      try {
        turn.calls += 1
        result = await input.runtime.streamTurn({ messages, activeTools, callbacks: NO_CALLBACKS })
      } catch (error) {
        turn.outcome = `provider-error: ${messageOf(error)}`
        emitNervesEvent({ component: "eval", level: "warn", event: "eval.interview_conversation_ended", message: "a provider error ended the conversation", meta: { arm: input.arm.key, calls: turn.calls } })
        return { timeline, turns }
      }
      const content = withoutThinking(result.content)
      const assistant: OpenAI.ChatCompletionAssistantMessageParam = { role: "assistant", ...(content ? { content } : {}) }
      if (result.toolCalls.length > 0) assistant.tool_calls = result.toolCalls.map((call) => ({ id: call.id, type: "function" as const, function: { name: call.name, arguments: call.arguments } }))
      messages.push(assistant)
      if (result.toolCalls.length === 0) {
        turn.finalReply = content
        timeline.push({ kind: "reply", text: content })
        break
      }
      for (const call of result.toolCalls) {
        let answer: string
        try {
          const reply = await input.arm.call(call.name, call.arguments)
          // A failed call is marked the same way in every arm, as an MCP client shows `isError`.
          answer = scrub(reply.isError ? `Error: ${reply.text}` : reply.text)
        } catch (error) {
          answer = scrub(`error: ${messageOf(error)}`)
        }
        timeline.push({ kind: "call", name: call.name, args: call.arguments, result: answer })
        messages.push({ role: "tool", tool_call_id: call.id, content: answer })
        input.runtime.appendToolOutput(call.id, answer)
      }
    }
  }
  emitNervesEvent({ component: "eval", event: "eval.interview_conversation_end", message: "finished a neutral-loop conversation", meta: { arm: input.arm.key, turns: turns.length } })
  return { timeline, turns }
}
