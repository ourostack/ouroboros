/**
 * The H arms' model endpoint inside the agent container: an OpenAI-wire server on the container's loopback that the
 * other harnesses (codex, openhands) are pointed at as a custom provider. Each request is turned into the harness's
 * own request and sent through the host's runtime, as every interview call is, so the host still rewrites, scans,
 * gates and meters it; the answer goes back in the wire's own shape. Nothing reaches a model any other way: the
 * container has no route out.
 *
 * The wire is also where H's trace comes from: each call the model makes, with the output the harness sent back for
 * it, and each reply, in order, as the case's assertions read them. The case's earlier conversation (its prefix) is
 * put before the harness's first user message, since neither harness can be given a conversation to start from.
 *
 * Anything the wire can't carry faithfully (another tool type, a custom tool's call, an image) is refused by name and
 * never sent, so a pilot finds it rather than a session being scored on a changed request.
 */
import http from "node:http"
import type { AddressInfo } from "node:net"
import type OpenAI from "openai"
import type { ProviderRuntime } from "../../../../heart/core"
import type { TurnResult } from "../../../../heart/streaming"
import { emitNervesEvent } from "../../../../nerves/runtime"
import type { TraceCall, TraceReply } from "../../../domain/case"
import { messageOf, NO_CALLBACKS } from "../loop"

type Message = OpenAI.ChatCompletionMessageParam
type Tool = OpenAI.ChatCompletionFunctionTool
type WireRequest = { messages: Message[]; activeTools: Tool[] }

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value)
const typeOf = (value: unknown): string => value === null ? "null" : isRecord(value) && typeof value.type === "string" ? value.type : typeof value

/** The text of a message's or an output's content: a string, or text parts. */
function textOf(content: unknown): string {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) throw new Error(`the H wire can't carry content of type ${typeOf(content)}`)
  return content.map((part) => {
    if (isRecord(part) && ["input_text", "output_text", "text"].includes(String(part.type)) && typeof part.text === "string") return part.text
    throw new Error(`the H wire can't carry content of type ${typeOf(part)}`)
  }).join("\n")
}

/**
 * A Responses body as the harness's request. The harness's instructions (its leading developer and system messages)
 * become the one system message; the case's conversation goes before the first user message; a call joins the
 * assistant message before it, and each output becomes its tool result. Reasoning items are not sent back.
 */
export function responsesRequest(body: unknown, prefix: Message[]): WireRequest {
  if (!isRecord(body) || !Array.isArray(body.input)) throw new Error("a Responses body needs an input list")
  const leading: string[] = []
  const rest: Message[] = []
  let prefixed = false
  for (const item of body.input as unknown[]) {
    const type = typeOf(item)
    const value = item as Record<string, unknown>
    if (type === "reasoning") continue
    if (type === "message") {
      const role = String(value.role)
      const text = textOf(value.content)
      if (role === "developer" || role === "system") {
        if (rest.length === 0) leading.push(text)
        else rest.push({ role: "system", content: text })
      } else if (role === "user") {
        if (!prefixed) rest.push(...prefix)
        prefixed = true
        rest.push({ role: "user", content: text })
      } else if (role === "assistant") {
        rest.push({ role: "assistant", content: text })
      } else {
        throw new Error(`the H wire can't carry a message from ${role}`)
      }
    } else if (type === "function_call") {
      const call = { id: String(value.call_id), type: "function" as const, function: { name: String(value.name), arguments: String(value.arguments) } }
      const last = rest[rest.length - 1]
      if (last?.role === "assistant") {
        last.tool_calls = [...last.tool_calls ?? [], call]
      } else {
        rest.push({ role: "assistant", content: null, tool_calls: [call] })
      }
    } else if (type === "function_call_output") {
      rest.push({ role: "tool", tool_call_id: String(value.call_id), content: textOf(value.output) })
    } else {
      throw new Error(`the H wire can't carry an input item of type ${type}`)
    }
  }
  const tools = Array.isArray(body.tools) ? body.tools as unknown[] : []
  const activeTools = tools.map((tool): Tool => {
    if (typeOf(tool) !== "function") throw new Error(`the H wire can't carry a tool of type ${typeOf(tool)}`)
    const { name, description, parameters } = tool as { name: string; description?: string; parameters?: Record<string, unknown> }
    return { type: "function", function: { name, ...(description !== undefined ? { description } : {}), ...(parameters !== undefined ? { parameters } : {}) } }
  })
  return { messages: [...(leading.length > 0 ? [{ role: "system" as const, content: leading.join("\n\n") }] : []), ...rest], activeTools }
}

/** The events a Responses client reads for one answer: created, each output item done, then completed with usage. */
export function responsesEvents(result: TurnResult, id: string): object[] {
  const usage = result.usage
  return [
    { type: "response.created", response: { id } },
    ...(result.content ? [{ type: "response.output_item.done", item: { type: "message", role: "assistant", id: `${id}_msg`, content: [{ type: "output_text", text: result.content }] } }] : []),
    ...result.toolCalls.map((call, index) => ({ type: "response.output_item.done", item: { type: "function_call", id: `${id}_fc_${index}`, call_id: call.id, name: call.name, arguments: call.arguments } })),
    { type: "response.completed", response: { id, usage: {
      input_tokens: usage?.input_tokens ?? 0, input_tokens_details: { cached_tokens: usage?.cached_input_tokens ?? 0 },
      output_tokens: usage?.output_tokens ?? 0, output_tokens_details: { reasoning_tokens: usage?.reasoning_tokens ?? 0 },
      total_tokens: usage?.total_tokens ?? 0,
    } } },
  ]
}

/** Server-sent events, one per object, named by its type. */
export function sse(events: object[]): string {
  return events.map((event) => `event: ${(event as { type: string }).type}\ndata: ${JSON.stringify(event)}\n\n`).join("")
}

export type WireAnswer = { status: number; contentType: string; body: string }

export type Wire = {
  handle(route: string, body: unknown): Promise<WireAnswer>
  /** The calls and replies so far, each call with the output the client sent back for it. */
  timeline(): Array<TraceCall | TraceReply>
  /** Requests sent to the host's runtime, answered or not. */
  calls(): number
  /** Why the last request failed or was refused; null while none has. */
  error(): string | null
}

const errorAnswer = (status: number, message: string): WireAnswer => ({ status, contentType: "application/json", body: JSON.stringify({ error: { message } }) })

export function createWire(input: { runtime: ProviderRuntime; prefix: Message[] }): Wire {
  const timeline: Array<TraceCall | TraceReply> = []
  const pending = new Map<string, TraceCall>()
  let calls = 0
  let failure: string | null = null
  let responses = 0
  return {
    timeline: () => [...timeline],
    calls: () => calls,
    error: () => failure,
    async handle(route, body) {
      if (route !== "/v1/responses" && route !== "/responses") return errorAnswer(404, `no route ${route}`)
      let request: WireRequest
      try {
        request = responsesRequest(body, input.prefix)
      } catch (error) {
        failure = messageOf(error)
        emitNervesEvent({ component: "eval", level: "warn", event: "eval.h_wire_refused", message: "the H wire refused a request it can't carry", meta: { reason: failure } })
        return errorAnswer(400, failure)
      }
      // The outputs the client sent back are the results of the calls it was given.
      for (const message of request.messages) {
        if (message.role !== "tool") continue
        const call = pending.get(message.tool_call_id)
        if (call) {
          call.result = String(message.content)
          pending.delete(message.tool_call_id)
        }
      }
      calls += 1
      let result: TurnResult
      try {
        input.runtime.resetTurnState(request.messages)
        result = await input.runtime.streamTurn({ messages: request.messages, activeTools: request.activeTools, callbacks: NO_CALLBACKS })
      } catch (error) {
        failure = messageOf(error)
        emitNervesEvent({ component: "eval", level: "warn", event: "eval.h_wire_failed", message: "a call through the H wire failed", meta: { reason: failure } })
        return errorAnswer(500, failure)
      }
      for (const call of result.toolCalls) {
        const entry: TraceCall = { kind: "call", name: call.name, args: call.arguments, result: "" }
        timeline.push(entry)
        pending.set(call.id, entry)
      }
      if (result.toolCalls.length === 0) timeline.push({ kind: "reply", text: result.content })
      responses += 1
      return { status: 200, contentType: "text/event-stream", body: sse(responsesEvents(result, `resp_${responses}`)) }
    },
  }
}

/** Serves the wire on the container's loopback; `url` is the base a client's provider is given. */
export async function serveWire(wire: Wire): Promise<{ url: string; close(): Promise<void> }> {
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on("data", (chunk: Buffer) => chunks.push(chunk))
    request.on("end", () => {
      void (async () => {
        let body: unknown
        try {
          body = JSON.parse(Buffer.concat(chunks).toString("utf8"))
        } catch {
          const bad = errorAnswer(400, "the body is not JSON")
          response.writeHead(bad.status, { "content-type": bad.contentType }).end(bad.body)
          return
        }
        const answer = await wire.handle(new URL(request.url!, "http://wire").pathname, body)
        response.writeHead(answer.status, { "content-type": answer.contentType }).end(answer.body)
      })()
    })
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const { port } = server.address() as AddressInfo
  emitNervesEvent({ component: "eval", event: "eval.h_wire_listening", message: "the H wire is serving on the container's loopback", meta: { port } })
  return { url: `http://127.0.0.1:${port}/v1`, close: () => new Promise<void>((resolve) => server.close(() => resolve())) }
}
