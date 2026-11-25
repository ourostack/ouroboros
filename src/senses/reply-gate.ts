// The reply gate: before a group-chat turn, a small decision model says whether a reply is worth sending.
//
// In a group chat most messages are people talking to each other, so most turns end with `observe`. Each of
// those still costs a full LLM turn (instructions, tools, memory) just to decide to stay quiet. With
// `replyGate` in agent.json, one call to Microsoft-Decision-1.1 on Foundry scores how valuable a reply would be
// first, and the full turn runs only when the score reaches `replyAtValue`. The idea and its first eval come from
// https://github.com/ourostack/chime-in (archived; it now lives in Microsoft's CIT playground).
//
// The gate only ever saves turns: when it is off, unsure, slow or failing, the turn runs as it would without it.

import type { ChatCompletionAssistantMessageParam, ChatCompletionMessageParam } from "openai/resources/chat/completions"
import { emitNervesEvent } from "../nerves/runtime"
import { getAzureConfig, type AzureProviderConfig } from "../heart/config"
import { createAzureTokenProvider } from "../heart/providers/azure"
import * as path from "path"
import { getAgentRoot, validateReplyGate, type ReplyGateConfig } from "../heart/identity"
import { readAgentConfigForAgent } from "../heart/auth/auth-flow"

/** The gate's one question: how valuable would a reply be right now? Scored 0 (the first level) to 3 (the last). */
export const HOW_VALUABLE = [
  "None: nothing to add; the chat is social, already answered, for someone else, "
    + "or the agent knows nothing useful about it",
  "Low: mildly helpful, people would not miss it",
  "Medium: saves someone real time or effort",
  "High: people need this now and would be worse off without it",
] as const

/** chime-in's threshold: 12 of 12 right calls on its labeled chats (its README, 2026-11-24). */
export const DEFAULT_REPLY_AT_VALUE = 1.5
/** chime-in's median gate call took 330 ms; past this the turn runs rather than keep people waiting. */
export const REPLY_GATE_TIMEOUT_MS = 4000
/** How much of the conversation the decision model reads. */
export const REPLY_GATE_RECENT_MESSAGES = 20

export type ReplyGateVerdict =
  | { reply: true; reason: "off" | "no-text" | "named" | "worth-it" | "failed"; value?: number }
  | { reply: false; reason: "not-worth-it"; value: number }

export interface ReplyGateInput {
  agentName: string
  config: ReplyGateConfig | undefined
  /** The session so far, the inbound messages included. */
  messages: ChatCompletionMessageParam[]
  signal?: AbortSignal
  fetchImpl?: typeof fetch
  azureConfig?: AzureProviderConfig
  getToken?: () => Promise<string>
}

interface GateLine {
  from: string
  text: string
}

function textOf(content: ChatCompletionMessageParam["content"]): string {
  if (!Array.isArray(content)) return content ?? ""
  return content
    .map((part) => (part && typeof part === "object" && "text" in part && typeof part.text === "string" ? part.text : ""))
    .filter((text) => text.length > 0)
    .join("\n")
}

/** The agent's own words live in its settle and speak calls, not in assistant content. */
function agentWords(message: ChatCompletionAssistantMessageParam): string {
  const said: string[] = []
  const content = textOf(message.content)
  if (content.trim()) said.push(content)
  for (const call of message.tool_calls ?? []) {
    if (call.type !== "function" || (call.function.name !== "settle" && call.function.name !== "speak")) continue
    try {
      const args = JSON.parse(call.function.arguments) as Record<string, unknown>
      const words = call.function.name === "settle" ? args.answer : args.message
      if (typeof words === "string" && words.trim()) said.push(words)
    } catch {
      // Arguments a provider streamed badly are not words anyone saw.
    }
  }
  return said.join("\n")
}

export function recentConversation(agentName: string, messages: ChatCompletionMessageParam[]): GateLine[] {
  const lines: GateLine[] = []
  for (const message of messages) {
    if (message.role === "user") {
      const text = textOf(message.content).trim()
      if (text) lines.push({ from: "group member", text })
    } else if (message.role === "assistant") {
      const text = agentWords(message).trim()
      if (text) lines.push({ from: agentName, text })
    }
  }
  return lines.slice(-REPLY_GATE_RECENT_MESSAGES)
}

/** Someone who names the agent is talking to it: that turn always runs. */
export function namesAgent(agentName: string, text: string): boolean {
  const escaped = agentName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  return new RegExp(`(^|[^\\p{L}\\p{N}])@?${escaped}($|[^\\p{L}\\p{N}])`, "iu").test(text)
}

/** The agent's `replyGate`, read fresh so a change to agent.json applies to the next message. */
export function readReplyGateConfig(agentName: string): ReplyGateConfig | undefined {
  const { config, configPath } = readAgentConfigForAgent(agentName, path.dirname(getAgentRoot(agentName)))
  return config.replyGate === undefined ? undefined : validateReplyGate(config.replyGate, configPath)
}

/** Foundry serves the decision model at the resource's root, beside the OpenAI routes the azure provider uses. */
export function decisionModelUrl(endpoint: string): string {
  return `${endpoint.replace(/\/openai.*$/, "").replace(/\/+$/, "")}/providers/microsoft/v1/systemone`
}

export async function askReplyGate(input: ReplyGateInput): Promise<ReplyGateVerdict> {
  const config = input.config
  if (!config) return { reply: true, reason: "off" }

  const conversation = recentConversation(input.agentName, input.messages)
  const latest = conversation.at(-1)
  // A message with no words (a photo, a sticker) gives the decision model nothing to read, so the turn decides.
  if (!latest || latest.from === input.agentName) return { reply: true, reason: "no-text" }
  if (namesAgent(input.agentName, latest.text)) {
    emitNervesEvent({
      component: "senses",
      event: "senses.reply_gate_named",
      message: "reply gate let the turn run: the latest message names the agent",
      meta: { agentName: input.agentName },
    })
    return { reply: true, reason: "named" }
  }

  const replyAt = config.replyAtValue ?? DEFAULT_REPLY_AT_VALUE
  const started = Date.now()
  emitNervesEvent({
    component: "senses",
    event: "senses.reply_gate_start",
    message: "asking the decision model whether a group reply is worth sending",
    meta: { deployment: config.deployment, messages: conversation.length },
  })
  try {
    const azure = input.azureConfig ?? getAzureConfig()
    if (!azure.endpoint) {
      throw new Error("the azure provider has no endpoint in the agent vault; run `ouro auth --agent <agent> --provider azure`")
    }
    const auth: Record<string, string> = azure.apiKey
      ? { "api-key": azure.apiKey }
      : { Authorization: `Bearer ${await (input.getToken ?? createAzureTokenProvider(azure.managedIdentityClientId || undefined))()}` }
    const timeout = AbortSignal.timeout(REPLY_GATE_TIMEOUT_MS)
    const response = await (input.fetchImpl ?? fetch)(decisionModelUrl(azure.endpoint), {
      method: "POST",
      headers: { "Content-Type": "application/json", ...auth },
      signal: input.signal ? AbortSignal.any([input.signal, timeout]) : timeout,
      body: JSON.stringify({
        model: config.deployment,
        state: {
          agent: `${input.agentName}, a quiet member of this group chat`,
          agent_knows: "nothing beyond the conversation",
          conversation,
        },
        questions: {
          how_valuable: {
            type: "score",
            instructions: "The agent is a quiet member of this conversation. If it replied to the latest "
              + "messages now, how valuable would that reply be?",
            criteria: HOW_VALUABLE,
          },
        },
      }),
    })
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} from the decision model: ${(await response.text()).slice(0, 200)}`)
    }
    const body = await response.json() as { answers?: { how_valuable?: { score?: unknown } } }
    const value = body.answers?.how_valuable?.score
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new Error("the decision model's answer has no how_valuable score")
    }
    const reply = value >= replyAt
    emitNervesEvent({
      component: "senses",
      event: "senses.reply_gate_end",
      message: reply ? "reply gate: a reply is worth sending" : "reply gate: staying quiet without a model turn",
      meta: { value, replyAt, reply, ms: Date.now() - started },
    })
    return reply ? { reply: true, reason: "worth-it", value } : { reply: false, reason: "not-worth-it", value }
  } catch (error) {
    emitNervesEvent({
      level: "warn",
      component: "senses",
      event: "senses.reply_gate_error",
      message: "reply gate failed, so the turn runs as it would without it",
      meta: { deployment: config.deployment, error: error instanceof Error ? error.message : String(error), ms: Date.now() - started },
    })
    return { reply: true, reason: "failed" }
  }
}

/**
 * What a quiet turn leaves in the session: the same observe call and result an LLM turn that chose silence
 * writes (core.ts, "observe sole call"), so the next turn reads the conversation the same way either way.
 */
export function appendGatedObserve(messages: ChatCompletionMessageParam[], value: number): void {
  const id = `reply_gate_${Date.now().toString(36)}`
  messages.push({
    role: "assistant",
    content: null,
    tool_calls: [{
      id,
      type: "function",
      function: { name: "observe", arguments: JSON.stringify({ reason: `reply gate: a reply was worth ${value.toFixed(1)} of 3` }) },
    }],
  })
  messages.push({ role: "tool", tool_call_id: id, content: "(silenced)" })
  emitNervesEvent({
    component: "senses",
    event: "senses.reply_gate_observed",
    message: "recorded the gated turn as observe",
    meta: { value },
  })
}
