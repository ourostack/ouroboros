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
import type { JsonObject } from "../../../../heart/approval-store"
import type { McpToolInfo } from "../../../../repertoire/mcp-client"
import { mcpToolSchema } from "../../../../repertoire/mcp-tools"
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

/** A function tool the arm declares, as its request carries it. */
type ArmTool = { name: string; description?: string; parameters?: JsonObject; strict?: boolean }

/** The fields of an arm's function tool the wire carries; any other is refused, never dropped. */
const TOOL_FIELDS = new Set(["type", "name", "description", "parameters", "strict"])

/** Refuses a tool with a field the wire would otherwise drop. */
export function checkToolFields(tool: Record<string, unknown>): void {
  for (const key of Object.keys(tool)) if (!TOOL_FIELDS.has(key)) throw new Error(`the H wire can't carry a tool's ${key}`)
}

/**
 * The arm's own tools, passed to the host's runtime as a connected MCP server's tools are: through `mcpToolSchema`,
 * the census's passthrough (ax/census.config.json). They are the arm's doors, not the harness's: the arm runs each
 * call to one, and nothing in the harness does. Each reaches the model exactly as the arm sent it. Named as its own
 * server, a tool keeps its name, and its description and schema are the arm's objects. Where the arm sent no
 * description or schema, the passthrough's fill-in is taken out again, and `strict` is carried as sent.
 */
function wireTools(tools: ArmTool[]): Tool[] {
  const infos: McpToolInfo[] = tools.map((tool) => ({ name: tool.name, description: tool.description ?? "", inputSchema: tool.parameters ?? {} }))
  return infos.map((info, index) => {
    const schema: Tool = mcpToolSchema({ server: info.name }, info)
    const sent = tools[index]!
    if (sent.description === undefined) delete schema.function.description
    else schema.function.description = sent.description
    if (sent.parameters === undefined) delete schema.function.parameters
    if (sent.strict !== undefined) schema.function.strict = sent.strict
    return schema
  })
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
  for (const tool of tools) {
    if (typeOf(tool) !== "function") throw new Error(`the H wire can't carry a tool of type ${typeOf(tool)}`)
    checkToolFields(tool as Record<string, unknown>)
  }
  const activeTools = wireTools(tools as ArmTool[])
  return { messages: [...(leading.length > 0 ? [{ role: "system" as const, content: leading.join("\n\n") }] : []), ...rest], activeTools }
}

/**
 * A chat-completions body as the harness's request: its messages as they are, with text-only content made plain, a
 * developer message as a system message, and the case's conversation before the first user message. Streaming is
 * refused: the clients the wire serves this way (openhands) ask for one whole answer.
 */
export function chatRequest(body: unknown, prefix: Message[]): WireRequest {
  if (!isRecord(body) || !Array.isArray(body.messages)) throw new Error("a chat body needs a messages list")
  if (body.stream === true) throw new Error("the H wire answers chat completions only without streaming")
  const messages: Message[] = []
  let prefixed = false
  for (const item of body.messages as unknown[]) {
    const value = isRecord(item) ? item : {}
    const role = String(value.role)
    if (role === "system" || role === "developer") {
      messages.push({ role: "system", content: textOf(value.content) })
    } else if (role === "user") {
      if (!prefixed) messages.push(...prefix)
      prefixed = true
      messages.push({ role: "user", content: textOf(value.content) })
    } else if (role === "assistant") {
      const calls = Array.isArray(value.tool_calls) ? value.tool_calls as OpenAI.ChatCompletionMessageFunctionToolCall[] : []
      messages.push({
        role: "assistant", content: value.content === null || value.content === undefined ? null : textOf(value.content),
        ...(calls.length > 0 ? { tool_calls: calls.map((call) => ({ id: String(call.id), type: "function" as const, function: { name: String(call.function.name), arguments: String(call.function.arguments) } })) } : {}),
      })
    } else if (role === "tool") {
      messages.push({ role: "tool", tool_call_id: String(value.tool_call_id), content: textOf(value.content) })
    } else {
      throw new Error(`the H wire can't carry a message from ${role}`)
    }
  }
  const tools = Array.isArray(body.tools) ? body.tools as unknown[] : []
  for (const tool of tools) if (typeOf(tool) !== "function") throw new Error(`the H wire can't carry a tool of type ${typeOf(tool)}`)
  // A chat tool nests the same fields under `function`; they pass through as the Responses shape's do.
  const activeTools = (tools as Array<{ function: ArmTool }>).map((tool) => wireTool(tool.function))
  return { messages, activeTools }
}

/** One chat completion for an answer: the reply, its calls, why it stopped and the usage. */
export function chatAnswer(result: TurnResult, id: string): { id: string; object: string; created: number; model: string; choices: object[]; usage: object } {
  const usage = result.usage
  const message = {
    role: "assistant", content: result.content,
    ...(result.toolCalls.length > 0 ? { tool_calls: result.toolCalls.map((call) => ({ id: call.id, type: "function", function: { name: call.name, arguments: call.arguments } })) } : {}),
  }
  return {
    id, object: "chat.completion", created: 0, model: "model",
    choices: [{ index: 0, finish_reason: result.toolCalls.length > 0 ? "tool_calls" : "stop", message }],
    usage: {
      prompt_tokens: usage?.input_tokens ?? 0, completion_tokens: usage?.output_tokens ?? 0, total_tokens: usage?.total_tokens ?? 0,
      prompt_tokens_details: { cached_tokens: usage?.cached_input_tokens ?? 0 }, completion_tokens_details: { reasoning_tokens: usage?.reasoning_tokens ?? 0 },
    },
  }
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
      const chat = route === "/v1/chat/completions" || route === "/chat/completions"
      if (!chat && route !== "/v1/responses" && route !== "/responses") return errorAnswer(404, `no route ${route}`)
      let request: WireRequest
      try {
        request = chat ? chatRequest(body, input.prefix) : responsesRequest(body, input.prefix)
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
        // 400, never 500: codex retries a server error, and every retry would be another metered call. A failed or
        // refused call ends the conversation in every arm.
        return errorAnswer(400, failure)
      }
      for (const call of result.toolCalls) {
        const entry: TraceCall = { kind: "call", name: call.name, args: call.arguments, result: "" }
        timeline.push(entry)
        pending.set(call.id, entry)
      }
      if (result.toolCalls.length === 0) timeline.push({ kind: "reply", text: result.content })
      responses += 1
      if (chat) return { status: 200, contentType: "application/json", body: JSON.stringify(chatAnswer(result, `chat_${responses}`)) }
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
        let answer: WireAnswer
        try {
          let body: unknown
          try {
            body = JSON.parse(Buffer.concat(chunks).toString("utf8"))
          } catch {
            answer = errorAnswer(400, "the body is not JSON")
            return
          }
          answer = await wire.handle(new URL(request.url!, "http://wire").pathname, body)
        } catch (error) {
          // Anything else is answered too, so no request hangs and the guest never dies of one.
          answer = errorAnswer(400, messageOf(error))
        } finally {
          response.writeHead(answer!.status, { "content-type": answer!.contentType }).end(answer!.body)
        }
      })()
    })
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const { port } = server.address() as AddressInfo
  emitNervesEvent({ component: "eval", event: "eval.h_wire_listening", message: "the H wire is serving on the container's loopback", meta: { port } })
  return { url: `http://127.0.0.1:${port}/v1`, close: () => new Promise<void>((resolve) => server.close(() => resolve())) }
}
