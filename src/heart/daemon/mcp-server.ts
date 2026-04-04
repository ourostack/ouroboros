import type { Readable, Writable } from "stream"
import { sendDaemonCommand } from "./socket-client"
import type { DaemonCommand, DaemonResponse } from "./daemon"
import * as agentService from "./agent-service"
import { emitNervesEvent } from "../../nerves/runtime"
import { resolveSessionId } from "./session-id-resolver"
import { drainPending, getPendingDir } from "../../mind/pending"

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
  ask: "agent.ask",
  status: "agent.status",
  catchup: "agent.catchup",
  delegate: "agent.delegate",
  get_context: "agent.getContext",
  search_memory: "agent.searchMemory",
  get_task: "agent.getTask",
  check_scope: "agent.checkScope",
  request_decision: "agent.requestDecision",
  check_guidance: "agent.checkGuidance",
  report_progress: "agent.reportProgress",
  report_blocker: "agent.reportBlocker",
  report_complete: "agent.reportComplete",
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
    ask: "handleAgentAsk",
    status: "handleAgentStatus",
    catchup: "handleAgentCatchup",
    delegate: "handleAgentDelegate",
    get_context: "handleAgentGetContext",
    search_memory: "handleAgentSearchMemory",
    get_task: "handleAgentGetTask",
    check_scope: "handleAgentCheckScope",
    request_decision: "handleAgentRequestDecision",
    check_guidance: "handleAgentCheckGuidance",
    report_progress: "handleAgentReportProgress",
    report_blocker: "handleAgentReportBlocker",
    report_complete: "handleAgentReportComplete",
  }

  async function handleToolsCall(request: JsonRpcRequest): Promise<void> {
    /* v8 ignore start — ?? fallbacks are defensive; MCP clients always send params */
    const params = request.params ?? {}
    const toolName = params.name as string
    const toolArgs = (params.arguments ?? {}) as Record<string, unknown>
    /* v8 ignore stop */

    // ── Conversation tools: send_message, check_response ──
    if (toolName === "send_message") {
      /* v8 ignore start — ?? fallback defensive; MCP clients always send message */
      const message = toolArgs.message as string ?? ""
      /* v8 ignore stop */
      try {
        const response = await sendDaemonCommand(socketPath, {
          kind: "agent.senseTurn",
          agent,
          friendId,
          channel: "mcp",
          sessionKey: sessionId,
          message,
        })
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
        writeResponse({
          jsonrpc: "2.0",
          id: request.id!,
          result: {
            content: [{ type: "text", text: `Error: ${errorMessage}` }],
            isError: true,
          },
        })
      }
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

    // ── delegate: full conversation turn via daemon ──
    if (toolName === "delegate") {
      /* v8 ignore start — ?? fallback defensive; MCP clients always send task */
      const task = toolArgs.task as string ?? ""
      /* v8 ignore stop */
      const context = toolArgs.context as string | undefined
      const delegateMessage = context ? `[delegate] ${task}\n\ncontext: ${context}` : `[delegate] ${task}`
      try {
        const response = await sendDaemonCommand(socketPath, {
          kind: "agent.senseTurn",
          agent,
          friendId,
          channel: "mcp",
          sessionKey: sessionId,
          message: delegateMessage,
        })
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
        writeResponse({
          jsonrpc: "2.0",
          id: request.id!,
          result: {
            content: [{ type: "text", text: `Error: ${errorMessage}` }],
            isError: true,
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
        response = await handlerFn({ agent, friendId, ...toolArgs })
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
      emitNervesEvent({
        component: "daemon",
        event: "daemon.mcp_server_stop",
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
      description: "Ask the agent a question. The agent uses its memory and recent session context to provide a useful answer.",
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
      description: "Get the agent's current status including active sessions, memory state, and activity level.",
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
      description: "Request the agent to handle a task. The agent queues the task and will work on it when available.",
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
      description: "Get the agent's current working context including memory summary, active tasks, and relevant state.",
      inputSchema: {
        type: "object",
        properties: {},
      },
    },
    {
      name: "search_memory",
      description: "Search the agent's memory for information about a specific topic. Returns matching lines from the agent's memory file.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search term to look for in agent memory" },
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
      description: "Check whether a proposed item or change is in scope for the agent's current work.",
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
      description: "Ask the agent to make a decision about a topic. Optionally provide a list of options to choose from.",
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
      description: "Get guidance from the agent on how to approach a topic. The agent searches its memory for relevant guidance.",
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
      description: "Report progress on delegated work back to the agent. The agent records the update.",
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
      description: "Report a blocker on delegated work to the agent. The agent records the blocker for review.",
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
      description: "Report completion of delegated work to the agent. The agent records the completion.",
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
      description: "Send a message to the agent and get a synchronous response. This runs a full agent turn — the agent can use tools, think, and respond. For multi-turn conversations, call repeatedly — the agent remembers prior messages in this session.",
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
