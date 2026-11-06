import { randomUUID } from "node:crypto"
import * as readline from "node:readline"
import type { Readable, Writable } from "node:stream"

import {
  InlinePromptImageRejection,
  prepareInlinePromptImages,
  type InlinePromptImage,
  type InlinePromptImageTransaction,
} from "../heart/attachments/inline-image"
import { imageValidationAvailable } from "../heart/attachments/image-normalize"
import { renderAttachmentBlock } from "../heart/attachments/render"
import { FrontendRequestError, SocketFrontendClient, type FrontendProtocolClient } from "../heart/frontend-socket-client"
import type { RuntimeMcpServers } from "../repertoire/mcp-manager"
import { emitNervesEvent } from "../nerves/runtime"

interface JsonRpcRequest {
  jsonrpc?: unknown
  id?: number | string
  method?: unknown
  params?: unknown
  result?: unknown
  error?: unknown
}

const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/

class AcpProtocolError extends Error {
  constructor(readonly code: number, message: string) {
    super(message)
    this.name = "AcpProtocolError"
  }
}

export interface AcpServer {
  start(): void
  stop(): void
}

export interface AcpServerOptions {
  agent: string
  friendId: string
  frontendSocketPath: string
  stdin: Readable
  stdout: Writable
  runtimeMcpServers?: RuntimeMcpServers
  disableTools?: boolean
  createFrontendClient?: () => Promise<FrontendProtocolClient>
}

export function createAcpServer(options: AcpServerOptions): AcpServer {
  // Observe-only passes run tool-free and ephemeral, so a stored attachment id
  // would be unresolvable for that turn. Image prompts belong to full turns.
  const toolsEnabled = options.disableTools !== true
  const sessions = new Set<string>()
  const activePrompts = new Map<string, {
    rpcId: number | string
    turnId: string
    resolve: (stopReason: string) => void
    reject: (error: Error) => void
    controller: AbortController
    cancelled: boolean
    submitted: boolean
    admitted: boolean
  }>()
  const pendingOutbound = new Map<string, {
    sessionId: string
    requestId: string
  }>()
  const createClient = options.createFrontendClient ?? (async () => new SocketFrontendClient(options.frontendSocketPath))
  let clientPromise: Promise<FrontendProtocolClient> | null = null
  let frontendClient: FrontendProtocolClient | null = null
  let removeEventListener: (() => void) | null = null
  let removeCloseListener: (() => void) | null = null
  let lines: readline.Interface | null = null
  let running = false

  function write(message: unknown): void {
    options.stdout.write(`${JSON.stringify(message)}\n`)
  }

  function result(id: number | string, value: unknown): void {
    write({ jsonrpc: "2.0", id, result: value })
  }

  function error(id: number | string | null, code: number, message: string): void {
    write({ jsonrpc: "2.0", id, error: { code, message } })
  }

  async function client(): Promise<FrontendProtocolClient> {
    if (!clientPromise) {
      clientPromise = createClient().then((value) => {
        frontendClient = value
        removeEventListener = value.onEvent(handleFrontendEvent)
        removeCloseListener = value.onClose((error) => {
          const failure = error ?? new Error("frontend provider disconnected")
          for (const prompt of activePrompts.values()) {
            prompt.controller.abort(failure)
            prompt.reject(failure)
          }
          pendingOutbound.clear()
        })
        return value
      })
    }
    return clientPromise
  }

  async function subscribe(sessionId: string): Promise<void> {
    await (await client()).request("session.subscribe", { sessionKey: sessionId })
    sessions.add(sessionId)
  }

  async function supportsImagePrompts(): Promise<boolean> {
    if (!toolsEnabled) return false
    try {
      const capabilities = await (await client()).request("agent.prompt-capabilities", { agent: options.agent, channel: "mcp" })
      return capabilities?.image === true && imageValidationAvailable()
    } catch {
      emitNervesEvent({
        level: "warn", component: "senses", event: "senses.acp_image_capability_unavailable",
        message: "daemon model capability is unavailable; image prompts remain disabled",
      })
      return false
    }
  }

  function sessionUpdate(sessionId: string, update: Record<string, unknown>): void {
    write({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update } })
  }

  function permissionRequest(sessionId: string, event: Record<string, any>): void {
    const requestId = typeof event.requestId === "string" ? event.requestId : ""
    if (!requestId || [...pendingOutbound.values()].some((pending) => pending.requestId === requestId)) return
    const rpcId = `ouro:${randomUUID()}`
    pendingOutbound.set(rpcId, { sessionId, requestId })
    write({
      jsonrpc: "2.0",
      id: rpcId,
      method: "session/request_permission",
      params: {
        sessionId,
        toolCall: {
          toolCallId: String(event.toolCallId ?? requestId),
          title: String(event.title ?? "Permission requested"),
        },
        options: Array.isArray(event.options) ? event.options : [],
      },
    })
  }

  function replayEvent(sessionId: string, event: Record<string, any>): void {
    const data = event.data ?? {}
    if (event.type === "user_message" && typeof data.text === "string") {
      sessionUpdate(sessionId, {
        sessionUpdate: "user_message_chunk",
        messageId: `${event.turnId}:user`,
        content: { type: "text", text: data.text },
      })
    } else if (event.type === "assistant_delivery" && typeof data.text === "string") {
      sessionUpdate(sessionId, {
        sessionUpdate: "agent_message_chunk",
        messageId: `${event.turnId}:agent`,
        content: { type: "text", text: data.text },
      })
    } else if (event.type === "tool_started") {
      sessionUpdate(sessionId, {
        sessionUpdate: "tool_call",
        toolCallId: `${event.turnId}:${String(data.name ?? "tool")}`,
        title: String(data.name ?? "tool"),
        status: "pending",
        rawInput: data.args ?? {},
      })
    } else if (event.type === "tool_completed") {
      sessionUpdate(sessionId, {
        sessionUpdate: "tool_call_update",
        toolCallId: `${event.turnId}:${String(data.name ?? "tool")}`,
        status: data.success === false ? "failed" : "completed",
        content: [{ type: "content", content: { type: "text", text: String(data.summary ?? "") } }],
      })
    } else if (event.type === "structured_output") {
      const output = data.output as { items?: Array<{ text?: unknown }> } | undefined
      sessionUpdate(sessionId, {
        sessionUpdate: "plan",
        entries: (output?.items ?? []).flatMap((item) =>
          typeof item.text === "string" && item.text.trim()
            ? [{ content: item.text.trim(), status: "pending" }]
            : []),
      })
    }
  }

  function handleFrontendEvent(event: Record<string, any>): void {
    const sessionId = typeof event.sessionKey === "string" ? event.sessionKey : ""
    if (!sessions.has(sessionId)) return
    const turnId = typeof event.turnId === "string" ? event.turnId : ""
    const active = activePrompts.get(sessionId)
    if (active?.turnId === turnId && ["turn.started", "turn.completed", "turn.cancelled", "turn.failed"].includes(event.event)) {
      active.admitted = true
    }
    if (event.event === "text.delta" && typeof event.text === "string") {
      sessionUpdate(sessionId, {
        sessionUpdate: "agent_message_chunk",
        messageId: `${turnId}:agent`,
        content: { type: "text", text: event.text },
      })
    } else if (event.event === "reasoning.delta" && typeof event.text === "string") {
      sessionUpdate(sessionId, {
        sessionUpdate: "agent_thought_chunk",
        messageId: `${turnId}:thought`,
        content: { type: "text", text: event.text },
      })
    } else if (event.event === "tool.started") {
      replayEvent(sessionId, { type: "tool_started", turnId, data: event })
    } else if (event.event === "tool.completed") {
      replayEvent(sessionId, { type: "tool_completed", turnId, data: event })
    } else if (event.event === "structured.output") {
      replayEvent(sessionId, { type: "structured_output", turnId, data: event })
    } else if (event.event === "permission.requested") {
      const requestId = typeof event.requestId === "string" ? event.requestId : ""
      if (!requestId || !active || active.turnId !== turnId) return
      permissionRequest(sessionId, event)
    } else if (active && active.turnId === turnId && event.event === "turn.completed") {
      active.resolve("end_turn")
    } else if (active && active.turnId === turnId && event.event === "turn.cancelled") {
      active.resolve("cancelled")
    } else if (active && active.turnId === turnId && event.event === "turn.failed") {
      active.reject(new Error(String(event.error ?? "frontend turn failed")))
    }
  }

  function params(value: unknown): Record<string, any> {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new AcpProtocolError(-32602, "params must be an object")
    return value as Record<string, any>
  }

  function requiredString(value: unknown, field: string): string {
    if (typeof value !== "string" || !value.trim()) throw new AcpProtocolError(-32602, `${field} must be a non-empty string`)
    return value.trim()
  }

  /**
   * Parse an ACP v1 `ContentBlock[]` deterministically.
   *
   * Text is required only when the prompt carries no accepted image. Unknown,
   * unsupported, or malformed blocks are rejected instead of being dropped, and
   * accepted images land in the attachment store before any turn can start.
   */
  async function promptContent(value: unknown, signal: AbortSignal): Promise<{ message: string; attachmentIds: string[]; transaction?: InlinePromptImageTransaction }> {
    if (!Array.isArray(value)) throw new AcpProtocolError(-32602, "prompt must be an array")
    const textParts: string[] = []
    const images: InlinePromptImage[] = []
    for (const part of value) {
      if (!part || typeof part !== "object" || Array.isArray(part)) {
        throw new AcpProtocolError(-32602, "prompt content block must be an object")
      }
      const block = part as Record<string, unknown>
      if (block.type === "text") {
        if (typeof block.text !== "string") throw new AcpProtocolError(-32602, "text content block must include text")
        textParts.push(block.text)
        continue
      }
      if (block.type === "image") {
        if (!toolsEnabled) {
          throw new AcpProtocolError(-32602, "image prompt content is unavailable in observe-only mode")
        }
        if (typeof block.data !== "string" || typeof block.mimeType !== "string") {
          throw new AcpProtocolError(-32602, "image content block must include data and mimeType")
        }
        images.push({
          data: block.data,
          mimeType: block.mimeType,
          ...(typeof block.name === "string" ? { name: block.name } : {}),
        })
        continue
      }
      throw new AcpProtocolError(
        -32602,
        `unsupported prompt content block: ${typeof block.type === "string" ? block.type : "missing type"}`,
      )
    }

    const text = textParts.join("")
    if (images.length === 0) {
      if (!text.trim()) throw new AcpProtocolError(-32602, "prompt must contain text")
      return { message: text, attachmentIds: [] }
    }

    try {
      if (!(await supportsImagePrompts())) {
        throw new InlinePromptImageRejection("active model and image decoder must support image prompts")
      }
      signal.throwIfAborted()
      const transaction = await prepareInlinePromptImages(options.agent, images, { signal })
      const attachments = transaction.attachments
      return {
        message: [text.trim(), renderAttachmentBlock(attachments)].filter(Boolean).join("\n\n"),
        attachmentIds: attachments.map((attachment) => attachment.id),
        transaction,
      }
    } catch (error) {
      if (error instanceof InlinePromptImageRejection) throw new AcpProtocolError(-32602, error.message)
      throw new AcpProtocolError(-32603, error instanceof Error ? error.message : String(error))
    }
  }

  async function handleResponse(response: JsonRpcRequest): Promise<void> {
    if (response.jsonrpc !== "2.0") throw new AcpProtocolError(-32600, "jsonrpc must be 2.0")
    if (typeof response.id !== "string") throw new AcpProtocolError(-32602, "response id must be a string")
    const pending = pendingOutbound.get(response.id)
    if (!pending) throw new AcpProtocolError(-32602, `unknown response id: ${response.id}`)
    pendingOutbound.delete(response.id)
    const outcome = (response.result as any)?.outcome
    const optionId = outcome?.outcome === "selected" && typeof outcome.optionId === "string"
      ? outcome.optionId
      : "cancelled"
    await (await client()).request("permission.resolve", { requestId: pending.requestId, optionId })
  }

  async function handle(request: JsonRpcRequest): Promise<void> {
    if (request.jsonrpc !== "2.0") throw new AcpProtocolError(-32600, "jsonrpc must be 2.0")
    const method = requiredString(request.method, "method")
    const requestParams = params(request.params ?? {})
    const id = request.id

    if (method === "initialize") {
      if (id === undefined) return
      if (requestParams.protocolVersion !== 1) throw new AcpProtocolError(-32602, "protocolVersion must be 1")
      result(id, {
        protocolVersion: 1,
        agentCapabilities: {
          loadSession: toolsEnabled,
          promptCapabilities: { image: await supportsImagePrompts() },
        },
      })
      return
    }

    if (method === "session/new") {
      if (id === undefined) return
      const sessionId = requestParams.sessionId === undefined
        ? randomUUID()
        : requiredString(requestParams.sessionId, "sessionId")
      if (!SESSION_ID.test(sessionId)) throw new AcpProtocolError(-32602, "sessionId must be a safe identifier")
      if (sessions.has(sessionId)) throw new AcpProtocolError(-32002, `session already exists: ${sessionId}`)
      await subscribe(sessionId)
      result(id, { sessionId, friendId: options.friendId })
      return
    }

    if (method === "session/load") {
      if (id === undefined) return
      if (options.disableTools) {
        throw new AcpProtocolError(-32601, "session/load is unavailable in observe-only mode")
      }
      const sessionId = requiredString(requestParams.sessionId, "sessionId")
      const frontend = await client()
      const replay = await frontend.request("session.load", {
        agent: options.agent,
        friendId: options.friendId,
        sessionKey: sessionId,
        afterSequence: 0,
      })
      if (!Array.isArray(replay?.events) || replay.events.length === 0) {
        throw new AcpProtocolError(-32001, "session not found")
      }
      for (const event of replay.events) replayEvent(sessionId, event)
      await subscribe(sessionId)
      for (const pending of replay.pendingPermissions ?? []) permissionRequest(sessionId, pending)
      result(id, {})
      return
    }

    if (method === "session/prompt") {
      if (id === undefined) return
      const sessionId = requiredString(requestParams.sessionId, "sessionId")
      if (!sessions.has(sessionId)) throw new AcpProtocolError(-32001, `unknown session: ${sessionId}`)
      if (activePrompts.has(sessionId)) throw new AcpProtocolError(-32002, "session already has an active prompt")
      const turnId = randomUUID()
      const completion = Promise.withResolvers<string>()
      // Disconnection can settle the event promise while admission itself is still pending.
      void completion.promise.catch(() => undefined)
      const active = {
        rpcId: id, turnId, resolve: completion.resolve, reject: completion.reject,
        controller: new AbortController(), cancelled: false, submitted: false, admitted: false,
      }
      activePrompts.set(sessionId, active)
      let transaction: InlinePromptImageTransaction | undefined
      try {
        const prompt = await promptContent(requestParams.prompt, active.controller.signal)
        transaction = prompt.transaction
        const frontend = await client()
        active.controller.signal.throwIfAborted()
        active.submitted = true
        const admission = await frontend.request(options.disableTools ? "turn.start.observe-only" : "turn.start", {
          turnId,
          agent: options.agent,
          friendId: options.friendId,
          channel: "mcp",
          sessionKey: sessionId,
          message: prompt.message,
          attachmentIds: prompt.attachmentIds,
          ...(prompt.attachmentIds.length > 0 ? { requireImageSupport: true } : {}),
          ...(options.runtimeMcpServers ? { runtimeMcpServers: options.runtimeMcpServers } : {}),
        })
        if (admission?.accepted !== true) throw new Error("frontend did not confirm turn admission")
        active.admitted = true
        await transaction?.commit()
        transaction = undefined
        result(id, { stopReason: await completion.promise })
      } catch (error) {
        if (!active.admitted && (!active.submitted || (error instanceof FrontendRequestError && error.admissionRejected))) {
          await transaction?.rollback()
        } else {
          // A transport failure is not evidence of rejection. Retain anything the daemon may have admitted.
          await transaction?.commit()
        }
        if (active.cancelled && !active.submitted) result(id, { stopReason: "cancelled" })
        else throw error
      } finally {
        activePrompts.delete(sessionId)
      }
      return
    }

    if (method === "session/cancel") {
      const sessionId = requiredString(requestParams.sessionId, "sessionId")
      const active = activePrompts.get(sessionId)
      if (active) {
        active.cancelled = true
        active.controller.abort()
        if (active.submitted) await (await client()).request("turn.cancel", { turnId: active.turnId })
      }
      return
    }

    throw new AcpProtocolError(-32601, `method not found: ${method}`)
  }

  async function dispatch(line: string): Promise<void> {
    let request: JsonRpcRequest
    try {
      request = JSON.parse(line)
    } catch {
      error(null, -32700, "parse error")
      return
    }
    try {
      if (request.method === undefined && (request.result !== undefined || request.error !== undefined)) {
        await handleResponse(request)
      } else {
        await handle(request)
      }
    } catch (caught) {
      const id = request.id ?? null
      const code = caught instanceof AcpProtocolError ? caught.code : -32000
      error(id, code, caught instanceof Error ? caught.message : String(caught))
    }
  }

  return {
    start(): void {
      if (running) return
      running = true
      emitNervesEvent({
        component: "senses",
        event: "senses.acp_server_started",
        message: "ACP server started",
      })
      lines = readline.createInterface({ input: options.stdin, crlfDelay: Infinity })
      lines.on("line", (line) => {
        if (line.trim()) void dispatch(line)
      })
    },
    stop(): void {
      if (!running) return
      running = false
      lines?.close()
      lines = null
      removeEventListener?.()
      removeEventListener = null
      removeCloseListener?.()
      removeCloseListener = null
      frontendClient?.close()
      frontendClient = null
      clientPromise = null
      for (const prompt of activePrompts.values()) {
        const failure = new Error("ACP server stopped")
        prompt.controller.abort(failure)
        prompt.reject(failure)
      }
      activePrompts.clear()
      pendingOutbound.clear()
      sessions.clear()
    },
  }
}
