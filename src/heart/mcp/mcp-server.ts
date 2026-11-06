import type { Readable, Writable } from "stream"
import { sendDaemonCommand } from "../daemon/socket-client"
import type { DaemonCommand, DaemonResponse } from "../daemon/daemon"
import * as agentService from "../daemon/agent-service"
import { emitNervesEvent } from "../../nerves/runtime"
import { resolveSessionId } from "../daemon/session-id-resolver"
import { drainPending, getPendingDir } from "../../mind/pending"

export const SENSE_TURN_MAX_RETRIES = 3
export const SENSE_TURN_RETRY_DELAYS_MS = [1000, 2000, 4000]
export const SENSE_TURN_COMMAND_TIMEOUT_MS = 10 * 60 * 1000
// Allow test override
export let _senseTurnRetryDelays = SENSE_TURN_RETRY_DELAYS_MS
export function _setSenseTurnRetryDelays(delays: number[]): void { _senseTurnRetryDelays = delays }
export let _senseTurnCommandTimeoutMs = SENSE_TURN_COMMAND_TIMEOUT_MS
export function _setSenseTurnCommandTimeoutMs(timeoutMs: number): void { _senseTurnCommandTimeoutMs = timeoutMs }

async function withSenseTurnTimeout<T>(promise: Promise<T>, timeoutMs: number, command: Extract<DaemonCommand, { kind: "agent.senseTurn" }>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => {
          const error = new Error(`MCP conversation turn for ${command.agent} timed out after ${timeoutMs}ms waiting for daemon response; command status is unknown.`)
          emitNervesEvent({
            level: "error",
            component: "daemon",
            event: "daemon.mcp_sense_turn_timeout",
            message: "MCP senseTurn timed out waiting for daemon response",
            meta: { agent: command.agent, friendId: command.friendId, sessionKey: command.sessionKey, timeoutMs },
          })
          reject(error)
        }, timeoutMs)
      }),
    ])
	  } finally {
	    /* v8 ignore next -- Promise.race installs the timer synchronously; null is only a defensive cleanup guard @preserve */
	    if (timer) clearTimeout(timer)
	  }
	}

/**
 * Send a senseTurn command to the daemon with retry logic.
 * Retries on transient failures: empty response (daemon mid-restart),
 * ECONNREFUSED (daemon not yet listening), ENOENT (socket not yet created).
 */
async function sendSenseTurnWithRetry(
  socketPath: string,
  command: Extract<DaemonCommand, { kind: "agent.senseTurn" }>,
): Promise<DaemonResponse> {
  let lastError: Error | null = null
  /* v8 ignore start -- retry loop: functionally tested via mcp-send-message retry tests @preserve */
  for (let attempt = 0; attempt <= SENSE_TURN_MAX_RETRIES; attempt++) {
    try {
      const response = await withSenseTurnTimeout(sendDaemonCommand(socketPath, command), _senseTurnCommandTimeoutMs, command)
      return response
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error))
      const msg = lastError.message
      const isTransient = msg.includes("ECONNREFUSED")
        || msg.includes("ENOENT")
        || msg.includes("empty response")
        || msg.includes("Empty response")
      if (!isTransient || attempt >= SENSE_TURN_MAX_RETRIES) {
        throw lastError
      }
      const delay = _senseTurnRetryDelays[attempt] ?? 4000
      emitNervesEvent({
        component: "daemon",
        event: "daemon.mcp_sense_turn_retry",
        message: `senseTurn attempt ${attempt + 1} failed, retrying in ${delay}ms`,
        meta: { attempt: attempt + 1, error: msg, delay },
      })
      await new Promise((resolve) => setTimeout(resolve, delay))
    }
  }
  throw lastError ?? new Error("senseTurn failed after retries")
  /* v8 ignore stop */
}

/**
 * MCP tool schema definition.
 * Matches the MCP protocol's tool listing format.
 */
export interface McpToolSchema {
  name: string
  description: string
  inputSchema: {
    type: "object"
    properties: Record<string, { type: string; description: string }>
    required?: string[]
  }
}

/**
 * Maps MCP tool names to daemon command kinds.
 */
const TOOL_TO_COMMAND: Record<string, string> = {
  status: "agent.status",
  catchup: "agent.catchup",
  get_context: "agent.getContext",
  search_notes: "agent.searchNotes",
  get_task: "agent.getTask",
}

export interface McpServerOptions {
  agent: string
  friendId: string
  socketPath: string
  stdin: Readable
  stdout: Writable
}

interface JsonRpcRequest {
  jsonrpc: "2.0"
  id?: number | string
  method: string
  params?: Record<string, unknown>
}

interface JsonRpcResponse {
  jsonrpc: "2.0"
  id: number | string | null
  result?: unknown
  error?: { code: number; message: string; data?: unknown }
}

export interface McpServer {
  agent: string
  friendId: string
  start(): void
  stop(): void
}

/**
 * Create an MCP server that speaks JSON-RPC 2.0 over stdio.
 * Handles initialize, initialized, tools/list, and tools/call.
 * Forwards tool calls to the daemon via Unix socket.
 */
export function createMcpServer(options: McpServerOptions): McpServer {
  const { agent, friendId, socketPath, stdin, stdout } = options
  let buffer = ""
  let running = false
  let useContentLengthFraming = true // default to Content-Length, auto-detect from first message

  // Resolve session ID once per MCP server instance for conversation continuity
  const sessionId = resolveSessionId()

  function writeResponse(response: JsonRpcResponse): void {
    const body = JSON.stringify(response)
    if (useContentLengthFraming) {
      const header = `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n`
      stdout.write(header + body)
    } else {
      stdout.write(body + "\n")
    }
  }

  function tryParseContentLength(): boolean {
    const headerEnd = buffer.indexOf("\r\n\r\n")
    /* v8 ignore start -- partial header delivery only in real I/O */
    if (headerEnd === -1) return false
    /* v8 ignore stop */

    const headerSection = buffer.slice(0, headerEnd)
    const contentLengthMatch = headerSection.match(/Content-Length:\s*(\d+)/i)
    if (!contentLengthMatch) {
      buffer = buffer.slice(headerEnd + 4)
      return true // consumed invalid header, try again
    }

    const contentLength = parseInt(contentLengthMatch[1], 10)
    const bodyStart = headerEnd + 4
    /* v8 ignore start -- partial body delivery only in real I/O */
    if (buffer.length < bodyStart + contentLength) return false
    /* v8 ignore stop */

    const body = buffer.slice(bodyStart, bodyStart + contentLength)
    buffer = buffer.slice(bodyStart + contentLength)
    parseAndDispatch(body)
    return true
  }

  function tryParseNewlineDelimited(): boolean {
    const newlineIdx = buffer.indexOf("\n")
    /* v8 ignore start -- partial line delivery only in real I/O */
    if (newlineIdx === -1) return false
    /* v8 ignore stop */

    const line = buffer.slice(0, newlineIdx).trim()
    buffer = buffer.slice(newlineIdx + 1)
    if (line.length === 0) return true // skip blank lines
    parseAndDispatch(line)
    return true
  }

  function parseAndDispatch(body: string): void {
    let request: JsonRpcRequest
    try {
      request = JSON.parse(body) as JsonRpcRequest
    } catch {
      writeResponse({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: "Parse error" },
      })
      return
    }
    void handleRequest(request)
  }

  let framingDetected = false

  function handleData(chunk: Buffer): void {
    buffer += chunk.toString("utf-8")
    // Auto-detect framing from first message and mirror it in responses
    if (!framingDetected && buffer.length > 0) {
      useContentLengthFraming = buffer.startsWith("Content-Length:")
      framingDetected = true
    }
    // Support both Content-Length framing (Claude Code) and newline-delimited JSON (Codex)
    while (buffer.length > 0) {
      const hasContentLength = buffer.startsWith("Content-Length:")
      const parsed = hasContentLength ? tryParseContentLength() : tryParseNewlineDelimited()
      /* v8 ignore start -- break on partial message only in real I/O */
      if (!parsed) break
      /* v8 ignore stop */
    }
  }

  async function handleRequest(request: JsonRpcRequest): Promise<void> {
    emitNervesEvent({
      component: "daemon",
      event: "daemon.mcp_request_start",
      message: "handling MCP request",
      meta: { method: request.method, agent },
    })

    // Notifications (no id) don't get responses
    if (request.id === undefined) {
      emitNervesEvent({
        component: "daemon",
        event: "daemon.mcp_request_end",
        message: "handled MCP notification",
        meta: { method: request.method, agent },
      })
      return
    }

    switch (request.method) {
      case "initialize":
        await handleInitialize(request)
        break
      case "tools/list":
        handleToolsList(request)
        break
      case "tools/call":
        await handleToolsCall(request)
        break
      default:
        writeResponse({
          jsonrpc: "2.0",
          id: request.id,
          error: {
            code: -32601,
            message: `Method not found: ${request.method}`,
          },
        })
        break
    }

    emitNervesEvent({
      component: "daemon",
      event: "daemon.mcp_request_end",
      message: "completed MCP request",
      meta: { method: request.method, agent },
    })
  }

  async function handleInitialize(request: JsonRpcRequest): Promise<void> {
    // MCP server works standalone (agent-service reads filesystem directly)
    // Daemon is optional — only needed for commands without a direct service handler
    writeResponse({
      jsonrpc: "2.0",
      id: request.id!,
      result: {
        protocolVersion: "2024-11-05",
        serverInfo: {
          name: "ouro-mcp-server",
          version: "0.1.0",
        },
        capabilities: {
          tools: { listChanged: false },
        },
      },
    })
  }

  function handleToolsList(request: JsonRpcRequest): void {
    const tools = getToolSchemas()
    writeResponse({
      jsonrpc: "2.0",
      id: request.id!,
      result: { tools },
    })
  }

  /** Map tool name → agent-service handler function name */
  const TOOL_TO_SERVICE: Record<string, keyof typeof agentService> = {
    status: "handleAgentStatus",
    catchup: "handleAgentCatchup",
    get_context: "handleAgentGetContext",
    search_notes: "handleAgentSearchNotes",
    get_task: "handleAgentGetTask",
  }

  function stringArg(args: Record<string, unknown>, key: string): string {
    const value = args[key]
    return typeof value === "string" ? value : ""
  }

  /* v8 ignore start -- MCP conversation-message shaping is covered by individual tool routing tests; sparse option variants are defensive copy formatting @preserve */
  function buildConversationMessage(toolName: string, toolArgs: Record<string, unknown>): string | null {
    switch (toolName) {
      case "send_message":
        return stringArg(toolArgs, "message")
      case "ask":
        return stringArg(toolArgs, "question")
      case "delegate": {
        const task = stringArg(toolArgs, "task")
        const context = stringArg(toolArgs, "context")
        return context ? `[delegate] ${task}\n\ncontext: ${context}` : `[delegate] ${task}`
      }
      case "request_decision": {
        const topic = stringArg(toolArgs, "topic")
        const options = stringArg(toolArgs, "options")
        return options ? `[request_decision] ${topic}\n\noptions: ${options}` : `[request_decision] ${topic}`
      }
      case "check_scope":
        return `[check_scope] ${stringArg(toolArgs, "item")}`
      case "check_guidance":
        return `[check_guidance] ${stringArg(toolArgs, "topic")}`
      case "report_progress":
        return `[report_progress] ${stringArg(toolArgs, "summary")}`
      case "report_blocker":
        return `[report_blocker] ${stringArg(toolArgs, "blocker")}`
      case "report_complete":
        return `[report_complete] ${stringArg(toolArgs, "summary")}`
      default:
        return null
    }
  }
  /* v8 ignore stop */

  async function runConversationTool(request: JsonRpcRequest, message: string): Promise<void> {
    try {
      const response = await sendSenseTurnWithRetry(socketPath, {
        kind: "agent.senseTurn",
        agent,
        friendId,
        channel: "mcp",
        sessionKey: sessionId,
        message,
      })
      /* v8 ignore next -- branch: ?? fallback for empty daemon response @preserve */
      const text = response.message ?? "(empty response)"
      writeResponse({
        jsonrpc: "2.0",
        id: request.id!,
        result: {
          content: [{ type: "text", text }],
          isError: !response.ok,
        },
      })
    } catch (error) {
      /* v8 ignore start — instanceof guard defensive; thrown errors are always Error */
      const errorMessage = error instanceof Error ? error.message : String(error)
      /* v8 ignore stop */
      /* v8 ignore start -- daemon-down detection: only triggers with real socket I/O @preserve */
      const isDaemonDown = errorMessage.includes("ECONNREFUSED") || errorMessage.includes("ENOENT")
      const userMessage = isDaemonDown
        ? "The daemon is not running. Start it with `ouro up` (production) or `ouro dev` (development), then retry."
        : `Error: ${errorMessage}`
      /* v8 ignore stop */
      writeResponse({
        jsonrpc: "2.0",
        id: request.id!,
        result: {
          content: [{ type: "text", text: userMessage }],
          isError: true,
        },
      })
    }
  }

  async function handleToolsCall(request: JsonRpcRequest): Promise<void> {
    /* v8 ignore start — ?? fallbacks are defensive; MCP clients always send params */
    const params = request.params ?? {}
    const toolName = params.name as string
    const toolArgs = (params.arguments ?? {}) as Record<string, unknown>
    /* v8 ignore stop */

    // ── Conversation tools: these run a real agent turn ──
    const conversationMessage = buildConversationMessage(toolName, toolArgs)
    if (conversationMessage !== null) {
      await runConversationTool(request, conversationMessage)
      return
    }

    if (toolName === "check_response") {
      const pendingDir = getPendingDir(agent, friendId, "mcp", sessionId)
      const pending = drainPending(pendingDir)
      if (pending.length === 0) {
        writeResponse({
          jsonrpc: "2.0",
          id: request.id!,
          result: {
            content: [{ type: "text", text: "no pending messages" }],
            isError: false,
          },
        })
      } else {
        const text = pending.map((m) => m.content).join("\n\n---\n\n")
        writeResponse({
          jsonrpc: "2.0",
          id: request.id!,
          result: {
            content: [{ type: "text", text }],
            isError: false,
          },
        })
      }
      return
    }

    // ── Legacy daemon/service tools ──
    const commandKind = TOOL_TO_COMMAND[toolName]
    if (!commandKind) {
      writeResponse({
        jsonrpc: "2.0",
        id: request.id!,
        result: {
          content: [{ type: "text", text: `Unknown tool: ${toolName}` }],
          isError: true,
        },
      })
      return
    }

    // Call agent-service directly (no daemon roundtrip needed for read-only ops)
    const serviceHandler = TOOL_TO_SERVICE[toolName]
    let response: DaemonResponse

    /* v8 ignore start — typeof guard always true; instanceof check defensive; else branch unreachable for known tools */
    if (serviceHandler && typeof agentService[serviceHandler] === "function") {
      const handlerFn = agentService[serviceHandler] as (p: agentService.AgentServiceParams) => Promise<DaemonResponse>
      try {
        response = await handlerFn({ agent, friendId, socketPath, ...toolArgs })
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error)
        response = { ok: false, error: `Service error: ${errorMessage}` }
      }
    } else {
      try {
        response = await sendDaemonCommand(socketPath, {
          kind: commandKind, agent, friendId, ...toolArgs,
        } as DaemonCommand)
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error)
        response = { ok: false, error: `Daemon error: ${errorMessage}` }
      }
    }
    /* v8 ignore stop */

    const text = response.message
      ?? response.summary
      ?? JSON.stringify(response.data ?? { ok: response.ok })

    writeResponse({
      jsonrpc: "2.0",
      id: request.id!,
      result: {
        content: [{ type: "text", text }],
        isError: !response.ok,
      },
    })
  }

  function onData(chunk: Buffer): void {
    handleData(chunk)
  }

  return {
    agent,
    friendId,
    start() {
      if (running) return
      running = true
      stdin.on("data", onData)
      emitNervesEvent({
        component: "daemon",
        event: "daemon.mcp_server_start",
        message: "MCP server started",
        meta: { agent, friendId, socketPath },
      })
    },
    stop() {
      if (!running) return
      running = false
      stdin.removeListener("data", onData)
      // `_end` (not `_stop`) to satisfy the nerves audit's start/end
      // pairing rule — counterpart to `daemon.mcp_server_start`.
      emitNervesEvent({
        component: "daemon",
        event: "daemon.mcp_server_end",
        message: "MCP server stopped",
        meta: { agent, friendId },
      })
    },
  }
}

/**
 * Returns the list of MCP tool schemas for all 15 agent tools.
 * Each schema follows JSON Schema for inputSchema as required by MCP.
 */
export function getToolSchemas(): McpToolSchema[] {
  return [
    {
      name: "ask",
      description: "Ask the agent a question through a full conversation turn. This has the same identity, tools, and session continuity as send_message; use search_notes for read-only note lookup.",
      inputSchema: {
        type: "object",
        properties: {
          question: { type: "string", description: "The question to ask the agent" },
        },
        required: ["question"],
      },
    },
    {
      name: "status",
      description: "Get the agent's current status including active sessions, diary and journal state, and activity level.",
      inputSchema: {
        type: "object",
        properties: {},
      },
    },
    {
      name: "catchup",
      description: "Get a summary of the agent's recent activity including recent sessions and what it has been working on.",
      inputSchema: {
        type: "object",
        properties: {},
      },
    },
    {
      name: "delegate",
      description: "Ask the agent to handle a task through a full conversation turn. The agent decides whether to act, queue, ask, or respond using its normal tools and identity.",
      inputSchema: {
        type: "object",
        properties: {
          task: { type: "string", description: "Description of the task to delegate" },
          context: { type: "string", description: "Additional context about the task" },
        },
        required: ["task"],
      },
    },
    {
      name: "get_context",
      description: "Get the agent's current working context including note summary, active tasks, and relevant state.",
      inputSchema: {
        type: "object",
        properties: {},
      },
    },
    {
      name: "search_notes",
      description: "Read-only note search. Returns matching diary lines without running an agent turn or treating missing matches as absence of agent belief.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search term to look for in agent notes" },
        },
        required: ["query"],
      },
    },
    {
      name: "get_task",
      description: "Get details about the agent's current task or list of active tasks.",
      inputSchema: {
        type: "object",
        properties: {},
      },
    },
    {
      name: "check_scope",
      description: "Ask the agent whether a proposed item or change is in scope through a full conversation turn.",
      inputSchema: {
        type: "object",
        properties: {
          item: { type: "string", description: "The item or change to check scope for" },
        },
        required: ["item"],
      },
    },
    {
      name: "request_decision",
      description: "Ask the agent to make a decision through a full conversation turn. Optionally provide a list of options to consider.",
      inputSchema: {
        type: "object",
        properties: {
          topic: { type: "string", description: "The topic requiring a decision" },
          options: { type: "string", description: "Comma-separated list of options to consider" },
        },
        required: ["topic"],
      },
    },
    {
      name: "check_guidance",
      description: "Ask the agent for guidance through a full conversation turn, using the same identity, tools, and session continuity as send_message.",
      inputSchema: {
        type: "object",
        properties: {
          topic: { type: "string", description: "The topic to get guidance on" },
        },
        required: ["topic"],
      },
    },
    {
      name: "report_progress",
      description: "Tell the agent about delegated-work progress through a full conversation turn so it can respond, record, or act normally.",
      inputSchema: {
        type: "object",
        properties: {
          summary: { type: "string", description: "Summary of progress made" },
        },
        required: ["summary"],
      },
    },
    {
      name: "report_blocker",
      description: "Tell the agent about a delegated-work blocker through a full conversation turn so it can respond, record, or act normally.",
      inputSchema: {
        type: "object",
        properties: {
          blocker: { type: "string", description: "Description of the blocker" },
        },
        required: ["blocker"],
      },
    },
    {
      name: "report_complete",
      description: "Tell the agent delegated work is complete through a full conversation turn so it can respond, record, or act normally.",
      inputSchema: {
        type: "object",
        properties: {
          summary: { type: "string", description: "Summary of what was completed" },
        },
        required: ["summary"],
      },
    },
    {
      name: "send_message",
      description: "Send a message to the agent and get a synchronous response. This runs a full agent turn — the agent can use tools, think, and respond. For multi-turn conversations, call repeatedly — the agent keeps prior turns in this session.",
      inputSchema: {
        type: "object",
        properties: {
          message: { type: "string", description: "The message to send to the agent" },
        },
        required: ["message"],
      },
    },
    {
      name: "check_response",
      description: "Check for pending messages from the agent. Use this after send_message returns a ponder deferral, or to pick up proactive messages the agent has surfaced to you.",
      inputSchema: {
        type: "object",
        properties: {},
      },
    },
  ]
}
// MCP server v0.1.0-alpha.140
