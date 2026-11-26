import type { Readable, Writable } from "stream"
import * as fs from "fs"
import * as path from "path"
import { sendDaemonCommand } from "../daemon/socket-client"
import type { DaemonCommand, DaemonResponse } from "../daemon/daemon"
import type { RuntimeMcpServers } from "../../repertoire/mcp-manager"
import * as agentService from "../daemon/agent-service"
import { getAgentRoot } from "../identity"
import { emitNervesEvent } from "../../nerves/runtime"
import { resolveSessionId } from "../daemon/session-id-resolver"
import { drainPending, getPendingDir } from "../../mind/pending"
import { resolveFeedbackOrigin } from "../../senses/shepherd/feedback-source"
import type { FeedbackCommand } from "../../senses/shepherd/feedback-submit"
import { redactSecrets } from "../../senses/shepherd/redact"
import { toolCandidates } from "../../repertoire/tool-candidates"
import { MailboxDoorError, mailboxMcpSchema, mailboxMcpSchemas, readMailboxDoors, runMailboxAction } from "../letters/doors"

/** The codes the mailbox doors answer a refusal with: the doors' own checks and the daemon's letters writer. */
export const MAILBOX_REFUSAL_CODES: ReadonlySet<string> = new Set([
  "daemon-down", "unknown-input", "bad-input", "no-agent", "not-found",
  "invalid-letter", "no-person", "not-sender", "not-waiting", "no-answering-handle", "chat-unavailable", "send-failed",
])

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
          const error = new SenseTurnTimeout(`MCP conversation turn for ${command.agent} timed out after ${timeoutMs}ms waiting for daemon response; command status is unknown.`)
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

/** What can go wrong at a tool, as the calling agent reads it: the census's `ErrorCard` (`scripts/ouro-census/types.mts`). */
export interface McpErrorCard {
  code: string
  means: string
  fix: string
}

/**
 * A tool's Ouro AX declaration: the census's `DoorCard`. `when` says when an agent should pick this tool over its
 * neighbours and leads the served description; `effect` is the consent class the served annotations come from;
 * `errors` are the texts of the tool's `isError` results.
 */
export interface McpDoorCard {
  id: string
  group: string
  when: string
  effect: "read" | "write" | "consequential" | "person-only"
  errors: readonly McpErrorCard[]
  destructive?: true
  idempotent?: true
  /** The door can reach entities outside this server even though its own effect is a write: a tool that runs an agent turn. */
  openWorld?: true
  confirm?: string
}

/** MCP `ToolAnnotations` (2025-11-25 schema), as ouro-actions' `annotationsOf` fills them. */
export interface McpToolAnnotations {
  readOnlyHint: boolean
  destructiveHint: boolean
  openWorldHint: boolean
  idempotentHint?: true
}

/**
 * MCP tool schema definition, with its Ouro AX card. `tools/list` serves `toListedTool(schema)`, never the card itself.
 */
export interface McpToolSchema {
  name: string
  description: string
  inputSchema: {
    type: "object"
    properties: Record<string, { type: string; description: string }>
    required?: string[]
    additionalProperties?: boolean
  }
  ax: McpDoorCard
}

/** A tool as `tools/list` serves it. */
export interface McpListedTool {
  name: string
  description: string
  inputSchema: McpToolSchema["inputSchema"]
  annotations: McpToolAnnotations
}

/**
 * ouro-actions' `annotationsOf` (`tools/ouro-actions/ouro-actions.mts`) over a card: only a consequential door reaches
 * other people, so only it is open-world and destructive by default. One addition: a card marked `openWorld` (a tool
 * that runs a full agent turn, which can use the agent's own tools) is open-world too. The vendored kit is an ES module
 * outside `src`, so this mirrors it, and a test holds the two equal for every card apart from that addition.
 */
export function mcpAnnotationsOf(card: McpDoorCard): McpToolAnnotations {
  const others = card.effect === "consequential"
  // A person-only card would need ouro-actions' `reaches`; mcp-serve has none, so the card type doesn't model it.
  const out: McpToolAnnotations = { readOnlyHint: card.effect === "read", destructiveHint: others || card.destructive === true, openWorldHint: others || card.openWorld === true }
  if (card.idempotent) out.idempotentHint = true
  return out
}

/** The served tool: the `when` line leads the description, so an agent choosing from the list reads it first. */
export function toListedTool(schema: McpToolSchema): McpListedTool {
  return { name: schema.name, description: `${schema.ax.when} ${schema.description}`, inputSchema: schema.inputSchema, annotations: mcpAnnotationsOf(schema.ax) }
}

/** The tools as `tools/list` serves them; the census reads its read-only evidence from these served annotations. */
export function listTools(): McpListedTool[] {
  return getToolSchemas().map(toListedTool)
}

/** The server-level card: what a tool name this server doesn't have answers (a JSON-RPC -32602 error). */
export const serverErrors: readonly McpErrorCard[] = [
  { code: "unknown-door", means: "This server has no tool by that name.", fix: "If a suggested tool is the one you meant, call it; otherwise call tools/list and pick by description." },
]

/** The required text argument each tool refuses to run without, and the error code it answers. */
const REQUIRED_TEXT: Record<string, { arg: string; code: string }> = {
  send_message: { arg: "message", code: "missing-message" },
  ask: { arg: "question", code: "missing-question" },
  delegate: { arg: "task", code: "missing-task" },
  check_scope: { arg: "item", code: "missing-item" },
  request_decision: { arg: "topic", code: "missing-topic" },
  check_guidance: { arg: "topic", code: "missing-topic" },
  report_progress: { arg: "summary", code: "missing-summary" },
  report_blocker: { arg: "blocker", code: "missing-blocker" },
  report_complete: { arg: "summary", code: "missing-summary" },
  search_facts: { arg: "query", code: "missing-query" },
}

/** The protocol revisions this server speaks, newest first. All of them define tool annotations except 2024-11-05. */
const PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"]

/** A senseTurn that ran past its timeout: the turn may still be running. */
class SenseTurnTimeout extends Error {}

/** An error a tool raises by its card's code. */
class ToolCardError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
  }
}

export interface McpServerOptions {
  agent: string
  friendId: string
  socketPath: string
  stdin: Readable
  stdout: Writable
  /**
   * Optional per-turn runtime MCP override (e.g. Workbench's `ouro_workbench`),
   * already resolved to a concrete command/args by the caller. When present, the
   * bridge stamps it onto every `agent.senseTurn` it emits so the daemon merges
   * it into the agent's toolset for that turn. The bridge never runs the turn
   * itself — it only forwards the override on the wire.
   */
  runtimeMcp?: RuntimeMcpServers
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

const UUID_PREFIX_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-/i

function canonicalizeMcpFriendId(agent: string, rawFriendId: string): string {
  if (UUID_PREFIX_RE.test(rawFriendId)) return rawFriendId

  const localExternalId = rawFriendId.startsWith("local-")
    ? rawFriendId.slice("local-".length)
    : rawFriendId

  try {
    const friendsDir = path.join(getAgentRoot(agent), "friends")
    const friendFiles = fs.readdirSync(friendsDir).filter((entry) => entry.endsWith(".json"))
    for (const file of friendFiles) {
      const raw = fs.readFileSync(path.join(friendsDir, file), "utf-8")
      const record = JSON.parse(raw) as {
        id?: string
        name?: string
        externalIds?: Array<{ provider?: string; externalId?: string }>
      }
      if (!record.id) continue
      if (record.id === rawFriendId || record.name?.toLowerCase() === rawFriendId.toLowerCase()) {
        return record.id
      }
      const localMatch = record.externalIds?.some((externalId) =>
        externalId.provider === "local"
        && (
          externalId.externalId === rawFriendId
          || externalId.externalId === localExternalId
          || externalId.externalId?.startsWith(`${localExternalId}@`)
        ),
      )
      if (localMatch) return record.id
    }
  } catch {
    // Best effort only. If the bundle is unreadable, preserve the explicit id.
  }

  return rawFriendId
}

/**
 * Create an MCP server that speaks JSON-RPC 2.0 over stdio.
 * Handles initialize, initialized, tools/list, and tools/call.
 * Forwards tool calls to the daemon via Unix socket.
 */
export function createMcpServer(options: McpServerOptions): McpServer {
  const { agent, socketPath, stdin, stdout } = options
  const rawFriendId = options.friendId
  const runtimeMcp = options.runtimeMcp
  const friendId = canonicalizeMcpFriendId(agent, rawFriendId)
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
        protocolVersion: negotiatedVersion(request.params?.protocolVersion),
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

  /** The client's revision when this server speaks it, else the newest this server speaks. */
  function negotiatedVersion(requested: unknown): string {
    return typeof requested === "string" && PROTOCOL_VERSIONS.includes(requested) ? requested : PROTOCOL_VERSIONS[0]!
  }

  function handleToolsList(request: JsonRpcRequest): void {
    const tools = listTools()
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
    search_facts: "handleAgentSearchFacts",
    get_task: "handleAgentGetTask",
  }

  function stringArg(args: Record<string, unknown>, key: string): string {
    const value = args[key]
    return typeof value === "string" ? value : ""
  }

  /**
   * An `isError` result in the tool's own card's words: `[code] means`, the detail when there is one, then `Fix: fix`.
   * Every code a call path raises is on that tool's card; the census checks each card code is raised in this file.
   */
  /**
   * Whether a mailbox refusal's code is one this server answers as a refusal: one the mailbox doors raise (the daemon's
   * writer or the doors' own checks), and on the tool's card. Any other code is answered as a failure.
   */
  function mailboxRefusalCarded(toolName: string, code: string): boolean {
    return MAILBOX_REFUSAL_CODES.has(code) && getToolSchemas().find((schema) => schema.name === toolName)!.ax.errors.some((error) => error.code === code)
  }

  function writeToolError(request: JsonRpcRequest, toolName: string, code: string, detail?: string): void {
    const card = getToolSchemas().find((schema) => schema.name === toolName)!.ax.errors.find((error) => error.code === code)!
    const text = [`[${code}] ${card.means}`, ...(detail ? [detail] : []), `Fix: ${card.fix}`].join("\n")
    writeResponse({ jsonrpc: "2.0", id: request.id!, result: { content: [{ type: "text", text }], isError: true } })
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

  async function runConversationTool(request: JsonRpcRequest, toolName: string, message: string): Promise<void> {
    try {
      const response = await sendSenseTurnWithRetry(socketPath, {
        kind: "agent.senseTurn",
        agent,
        friendId,
        channel: "mcp",
        sessionKey: sessionId,
        message,
        // Forward the resolved runtime MCP override (if any) so the daemon merges
        // it into this agent's toolset for the turn. Per-turn parameter data only.
        ...(runtimeMcp ? { runtimeMcp } : {}),
      })
      /* v8 ignore next -- branch: ?? fallback for empty daemon response @preserve */
      const text = response.message ?? "(empty response)"
      if (!response.ok) {
        writeToolError(request, toolName, "turn-failed", text)
        return
      }
      writeResponse({
        jsonrpc: "2.0",
        id: request.id!,
        result: {
          content: [{ type: "text", text }],
          isError: false,
        },
      })
    } catch (error) {
      /* v8 ignore start — instanceof guard defensive; thrown errors are always Error */
      const errorMessage = error instanceof Error ? error.message : String(error)
      /* v8 ignore stop */
      if (error instanceof SenseTurnTimeout) writeToolError(request, toolName, "turn-timed-out", errorMessage)
      else if (errorMessage.includes("ECONNREFUSED") || errorMessage.includes("ENOENT")) writeToolError(request, toolName, "daemon-not-running")
      else writeToolError(request, toolName, "turn-failed", errorMessage)
    }
  }

  async function handleToolsCall(request: JsonRpcRequest): Promise<void> {
    /* v8 ignore start — ?? fallbacks are defensive; MCP clients always send params */
    const params = request.params ?? {}
    const toolName = params.name
    const toolArgs = (params.arguments ?? {}) as Record<string, unknown>
    /* v8 ignore stop */

    // A person-only action is no tool, but a call to it gets the person-only refusal ouro-actions generated for it.
    const { refusals } = readMailboxDoors()
    const personOnly = typeof toolName === "string" && Object.hasOwn(refusals, toolName) ? refusals[toolName] : undefined
    if (personOnly) {
      writeResponse({ jsonrpc: "2.0", id: request.id!, result: { content: [{ type: "text", text: `[person-only] ${personOnly.summary}` }], structuredContent: personOnly, isError: true } })
      return
    }

    // An error in finding the tool is a protocol error, not a tool result (MCP 2025-11-25, CallToolResult.isError).
    const names = getToolSchemas().map((schema) => schema.name)
    if (typeof toolName !== "string" || !names.includes(toolName)) {
      const unknown = serverErrors.find((card) => card.code === "unknown-door")!
      const named = typeof toolName === "string" && toolName.length > 0
      const candidates = named ? toolCandidates(toolName, names) : []
      const nearest = candidates.length === 1 ? candidates[0]! : null
      const quoted = candidates.map((candidate) => `"${candidate}"`).join(", ")
      const message = !named
        ? `tools/call needs params.name, the tool to call. tools/list has all ${names.length}.`
        : candidates.length === 0
          ? `Unknown tool "${toolName}". No tool has a name close to it; tools/list has all ${names.length}.`
          : `Unknown tool "${toolName}". Did you mean ${nearest ? quoted : `one of ${quoted}`}? tools/list has all ${names.length}.`
      writeResponse({
        jsonrpc: "2.0",
        id: request.id!,
        error: { code: -32602, message, data: { code: unknown.code, tool: typeof toolName === "string" ? toolName : null, nearest, candidates, means: unknown.means, fix: unknown.fix } },
      })
      return
    }

    const required = REQUIRED_TEXT[toolName]
    if (required && !stringArg(toolArgs, required.arg).trim()) {
      writeToolError(request, toolName, required.code)
      return
    }

    if (toolName === "shepherd_feedback" || toolName === "shepherd_feedback_status") {
      await runFeedbackTool(request, toolName, toolArgs)
      return
    }

    // ── Mailbox tools: generated doors; the daemon's single writer runs them over the socket ──
    if (mailboxMcpSchemas().some((schema) => schema.name === toolName)) {
      try {
        const result = await runMailboxAction(toolName, toolArgs, { agent, socketPath })
        writeResponse({ jsonrpc: "2.0", id: request.id!, result: { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result, isError: false } })
      } catch (error) {
        // A refusal answers with its card's code. Anything else is a failure, not bad input: it is answered as a
        // JSON-RPC internal error, since nothing above handleRequest catches a throw.
        if (error instanceof MailboxDoorError && mailboxRefusalCarded(toolName, error.code)) writeToolError(request, toolName, error.code, error.message)
        else writeResponse({ jsonrpc: "2.0", id: request.id!, error: { code: -32603, message: `${toolName} failed: ${(error as Error).message}` } })
      }
      return
    }

    // ── Conversation tools: these run a real agent turn ──
    const conversationMessage = buildConversationMessage(toolName, toolArgs)
    if (conversationMessage !== null) {
      await runConversationTool(request, toolName, conversationMessage)
      return
    }

    async function runFeedbackTool(request: JsonRpcRequest, toolName: string, args: Record<string, unknown>): Promise<void> {
      const requestId = stringArg(args, "request_id")
      const validRequestId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(requestId)
      try {
        const submitting = toolName === "shepherd_feedback"
        const allowed = submitting ? ["request_id", "feedback", "context"] : ["request_id"]
        if (!validRequestId || Object.keys(args).some(key => !allowed.includes(key))) {
          throw submitting
            ? new ToolCardError("invalid-feedback-request", "Invalid feedback request identity or routing arguments")
            : new ToolCardError("invalid-status-request", "Invalid feedback request identity or routing arguments")
        }
        const feedback = stringArg(args, "feedback")
        if (submitting && (!feedback.trim() || feedback.length > 2000 ||
          args.context !== undefined && (typeof args.context !== "string" || Buffer.byteLength(JSON.stringify(args.context)) > 8192))) {
          throw new ToolCardError("feedback-size", "Feedback must be 1–2000 characters with at most 8 KiB of context")
        }
        const command: FeedbackCommand = submitting
          ? { kind: "agent.shepherdFeedback", agent, friendId, origin: await resolveFeedbackOrigin(),
            submission: { requestId, feedback, ...(typeof args.context === "string" ? { context: args.context } : {}) } }
          : { kind: "agent.shepherdFeedbackStatus", agent, friendId, requestId }
        // The dedicated request ID owns reconciliation. Generic sense-turn retry may repeat model effects.
        const response = await sendDaemonCommand(socketPath, command)
        if (!response.ok) throw new Error(response.error ?? "Feedback has no confirmed result")
        const data = response.data
        if (!data || typeof data !== "object" || !("id" in data) || data.id !== `feedback:${requestId}`) {
          throw new Error("Feedback acknowledgement has no matching durable receipt")
        }
        if (submitting && (!("receipt" in data) || typeof data.receipt !== "string" || !data.receipt ||
          data.receipt !== response.message || !("state" in data) ||
          !["pending", "claimed", "complete", "uncertain"].includes(String(data.state)))) {
          throw new Error("Feedback acknowledgement is not authoritative")
        }
        writeResponse({ jsonrpc: "2.0", id: request.id!,
          result: { content: [{ type: "text", text: submitting ? response.message : JSON.stringify(data) }], isError: false } })
        emitNervesEvent({ component: "daemon", event: "daemon.mcp_feedback_result",
          message: "returned a native feedback receipt", meta: { operation: submitting ? "submit" : "status" } })
      } catch (error) {
        emitNervesEvent({ level: "warn", component: "daemon", event: "daemon.mcp_feedback_error",
          message: "native feedback request has no confirmed result", meta: { operation: toolName } })
        const code = error instanceof ToolCardError ? error.code : toolName === "shepherd_feedback" ? "feedback-unconfirmed" : "status-unconfirmed"
        writeToolError(request, toolName, code,
          redactSecrets(`${error instanceof Error ? error.message : String(error)}. Original request: ${validRequestId ? requestId : "(invalid)"}.`))
      }
    }

    if (toolName === "check_response") {
      const pendingDir = getPendingDir(agent, friendId, "mcp", sessionId)
      let pending: ReturnType<typeof drainPending>
      try {
        pending = drainPending(pendingDir)
      } catch (error) {
        /* v8 ignore next — instanceof guard defensive; thrown errors are always Error */
        writeToolError(request, toolName, "pending-unreadable", error instanceof Error ? error.message : String(error))
        return
      }
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

    // ── Read tools: agent-service reads the bundle directly, with no daemon roundtrip ──
    const handlerFn = agentService[TOOL_TO_SERVICE[toolName]!] as (p: agentService.AgentServiceParams) => Promise<DaemonResponse>
    let response: DaemonResponse
    try {
      response = await handlerFn({ agent, friendId, socketPath, ...toolArgs })
    } catch (error) {
      /* v8 ignore next — instanceof guard defensive; thrown errors are always Error */
      writeToolError(request, toolName, "agent-unreadable", error instanceof Error ? error.message : String(error))
      return
    }
    if (!response.ok) {
      /* v8 ignore next — the agent service always names its error */
      writeToolError(request, toolName, "agent-unreadable", response.error ?? response.message ?? "")
      return
    }

    const text = response.message
      ?? response.summary
      ?? JSON.stringify(response.data ?? { ok: response.ok })

    writeResponse({
      jsonrpc: "2.0",
      id: request.id!,
      result: {
        content: [{ type: "text", text }],
        isError: false,
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
        meta: { agent, friendId, rawFriendId, socketPath },
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

/** The errors of a tool that runs a full agent turn, in that tool's words. */
function turnErrors(tool: string, arg: string, argMeans: string): McpErrorCard[] {
  return [
    { code: `missing-${arg}`, means: `${arg} is empty or missing, so no turn ran.`, fix: `Call ${tool} again with ${arg} set to ${argMeans}.` },
    { code: "daemon-not-running", means: "The Ouro daemon isn't running, so the agent never got this.", fix: `Start it with \`ouro up\` (or \`ouro dev\` in a harness checkout), then call ${tool} again.` },
    { code: "turn-timed-out", means: "The agent's turn ran past 10 minutes; it may still be running and may already have acted.", fix: `Don't call ${tool} again with the same request; call send_message to ask whether it finished, since this session keeps its turns.` },
    { code: "turn-failed", means: "The agent's turn failed; the line below is the reason.", fix: `If the reason names a provider, credential or vault, the agent's human must fix it (\`ouro doctor\` shows what is wrong); otherwise call ${tool} again once.` },
  ]
}

/** The error of a read tool: the agent's bundle couldn't be read. */
function readErrors(tool: string, what: string): McpErrorCard[] {
  return [
    { code: "agent-unreadable", means: `${tool} couldn't read the agent's ${what}; the line below says why.`, fix: `The bundle for this server's --agent may be missing or unreadable: run \`ouro status\` and check ~/AgentBundles/<agent>.ouro; if it's missing, the MCP config names the wrong agent.` },
  ]
}

/**
 * Returns the list of MCP tool schemas for all 23 agent tools (17 written here, the mailbox group's 6 generated), each with its Ouro AX card (`ax`).
 * Each schema follows JSON Schema for inputSchema as required by MCP.
 */
export function getToolSchemas(): McpToolSchema[] {
  const mailboxSend = mailboxMcpSchema("mailbox_send")
  const mailboxList = mailboxMcpSchema("mailbox_list")
  const mailboxRead = mailboxMcpSchema("mailbox_read")
  const mailboxWait = mailboxMcpSchema("mailbox_wait")
  const mailboxWithdraw = mailboxMcpSchema("mailbox_withdraw")
  const mailboxDeliver = mailboxMcpSchema("mailbox_deliver")
  return [
    {
      name: "shepherd_feedback",
      description: "Relays the human's explicit feedback from this coding session ('you should have caught this') to the supervising agent served by this MCP connection. The caller makes one UUID request_id per request and reuses it only for that request's identical retry. The source terminal and recipient are bound automatically, so the human has nothing to reconstruct in Teams. feedback carries the human's own words; context is optional bounded background, not instructions. The result is the daemon's receipt, the exact text to quote back in this session; the supervising agent then sends its acknowledgement and any clarification questions to that human privately on Teams. The receipt says the feedback is filed, not that it was learned from or delivered on Teams. Relaying the feedback takes only this call, with no terminal input and no focus switch.",
      ax: { id: "mcp:shepherd_feedback", group: "ouro-agent", when: "Pick this when the human gives feedback on how this coding session went, so the supervisor who watches it learns from their exact words.", effect: "write", idempotent: true, errors: [
        { code: "invalid-feedback-request", means: "request_id isn't a UUID, or the call has arguments other than request_id, feedback and context.", fix: "Make one UUID for this feedback and call again with only request_id, feedback and context." },
        { code: "feedback-size", means: "feedback is empty or over 2000 characters, or context isn't text or is over 8 KiB.", fix: "Keep the human's words under 2000 characters, trim context, and call again with the same request_id." },
        { code: "feedback-unconfirmed", means: "The daemon returned no confirmed receipt, so the feedback may or may not be filed; the line below says why.", fix: "Call shepherd_feedback_status with the same request_id; a new ID could file the feedback twice." },
      ] },
      inputSchema: { type: "object", properties: {
        request_id: { type: "string", description: "Fresh UUID for this feedback; reuse only for its identical retry, never ask the human to enter it." },
        feedback: { type: "string", description: "The human's actual feedback, at most 2000 characters." },
        context: { type: "string", description: "Optional relevant background from this coding session, at most 8 KiB. Do not include secrets." },
      }, required: ["request_id", "feedback"], additionalProperties: false },
    },
    {
      name: "shepherd_feedback_status",
      description: "Reconcile this human's original feedback request after a lost receipt or to inspect review/Teams delivery state. Does not create another request, repeat model work, or require the source terminal still to exist.",
      ax: { id: "mcp:shepherd_feedback_status", group: "ouro-agent", when: "Pick this after shepherd_feedback lost its receipt or left you unsure, to learn whether that feedback was filed and delivered.", effect: "read", errors: [
        { code: "invalid-status-request", means: "request_id isn't a UUID, or the call has arguments other than request_id.", fix: "Call again with only request_id, set to the UUID you gave shepherd_feedback." },
        { code: "status-unconfirmed", means: "The daemon couldn't confirm what happened to that feedback; the line below says why.", fix: "Call shepherd_feedback_status again later with the same request_id; resending the feedback under a new ID could file it twice." },
      ] },
      inputSchema: { type: "object", properties: {
        request_id: { type: "string", description: "The original feedback UUID." },
      }, required: ["request_id"], additionalProperties: false },
    },
    {
      name: "ask",
      description: "Ask the agent a question through a full conversation turn. This has the same identity, tools, and session continuity as send_message; use search_facts for a read-only lookup of what it has written down.",
      ax: { id: "mcp:ask", group: "ouro-agent", when: "Pick this for one question the agent should answer, maybe using its own tools; for a lookup of its notes, search_facts is faster.", effect: "write", openWorld: true, errors: turnErrors("ask", "question", "the question as text") },
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
      description: "Get the agent's current status including active sessions, Desk record state, and activity level.",
      ax: { id: "mcp:status", group: "ouro-agent", when: "Pick this first to see whether the agent and its daemon are up, which version runs, and how busy it is.", effect: "read", errors: readErrors("status", "bundle or runtime state") },
      inputSchema: {
        type: "object",
        properties: {},
      },
    },
    {
      name: "catchup",
      description: "Get a summary of the agent's recent activity including recent sessions and what it has been working on.",
      ax: { id: "mcp:catchup", group: "ouro-agent", when: "Pick this to learn what the agent did lately: its five latest sessions and whether its background work is running, so you can pick up its thread.", effect: "read", errors: readErrors("catchup", "sessions") },
      inputSchema: {
        type: "object",
        properties: {},
      },
    },
    {
      name: "delegate",
      description: "Ask the agent to handle a task through a full conversation turn. The agent decides whether to act, queue, ask, or respond using its normal tools and identity.",
      ax: { id: "mcp:delegate", group: "ouro-agent", when: "Pick this to hand the agent work it should own and carry out itself; it replies whether it acted, queued it or needs more.", effect: "write", openWorld: true, errors: turnErrors("delegate", "task", "what you want done") },
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
      description: "Get the agent's current working context including Desk record summary, active tasks, and relevant state.",
      ax: { id: "mcp:get_context", group: "ouro-agent", when: "Pick this to orient before working with the agent: its newest diary lines plus task and session counts, in one snapshot.", effect: "read", errors: readErrors("get_context", "diary, tasks or sessions") },
      inputSchema: {
        type: "object",
        properties: {},
      },
    },
    {
      name: "search_facts",
      description: "Read-only fact search. Returns matching Desk record diary lines without running an agent turn or treating missing matches as absence of agent belief.",
      ax: { id: "mcp:search_facts", group: "ouro-agent", when: "Pick this to look up what the agent wrote down about a term; an empty result means nothing written, not that it doesn't know.", effect: "read", errors: [
        { code: "missing-query", means: "query is empty or missing, so nothing was searched.", fix: "Call search_facts again with query set to a word or phrase to find." },
        ...readErrors("search_facts", "diary"),
      ] },
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search term to look for in agent facts" },
        },
        required: ["query"],
      },
    },
    {
      name: "get_task",
      description: "Get details about the agent's current task or list of active tasks.",
      ax: { id: "mcp:get_task", group: "ouro-agent", when: "Pick this to list the agent's task files by name, in-progress ones when there are any, to see what work it owns now.", effect: "read", errors: readErrors("get_task", "tasks folder") },
      inputSchema: {
        type: "object",
        properties: {},
      },
    },
    {
      name: "check_scope",
      description: "Ask the agent whether a proposed item or change is in scope through a full conversation turn.",
      ax: { id: "mcp:check_scope", group: "ouro-agent", when: "Pick this before starting a change, to ask whether that item belongs in the current work, so nothing out of scope gets built.", effect: "write", openWorld: true, errors: turnErrors("check_scope", "item", "the change you're considering") },
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
      description: "Ask the agent to make a decision through a full conversation turn. Optionally provide a list of options to consider. When it needs the agent's human, put in it: urgency (now, today or batch), the ask in one line, why only the human can do it, exact steps, any deadline and a dedupe key that stays the same for the same ask.",
      ax: { id: "mcp:request_decision", group: "ouro-agent", when: "Pick this when you need a choice made that is the agent's or its human's to make, listing the options; for stuck work, use report_blocker.", effect: "write", openWorld: true, errors: turnErrors("request_decision", "topic", "the choice to be made") },
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
      ax: { id: "mcp:check_guidance", group: "ouro-agent", when: "Pick this to learn the agent's conventions or preferences on a subject before you act on it, rather than guessing.", effect: "write", openWorld: true, errors: turnErrors("check_guidance", "topic", "the subject you need direction on") },
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
      ax: { id: "mcp:report_progress", group: "ouro-agent", when: "Pick this midway through work the agent handed you, to say how far it has got so it can track or redirect it.", effect: "write", openWorld: true, errors: turnErrors("report_progress", "summary", "what is done so far") },
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
      description: "Tell the agent about a delegated-work blocker through a full conversation turn so it can respond, record, or act normally. When it needs the agent's human, put in it: urgency (now, today or batch), the ask in one line, why only the human can do it, exact steps, any deadline and a dedupe key that stays the same for the same ask.",
      ax: { id: "mcp:report_blocker", group: "ouro-agent", when: "Pick this when work the agent handed you is stuck, to say what stops it so the agent can unblock, decide or escalate.", effect: "write", openWorld: true, errors: turnErrors("report_blocker", "blocker", "what is stopping the work") },
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
      ax: { id: "mcp:report_complete", group: "ouro-agent", when: "Pick this when work the agent handed you is finished, with a summary, so it can check, record and close it.", effect: "write", openWorld: true, errors: turnErrors("report_complete", "summary", "what was finished") },
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
      ax: { id: "mcp:send_message", group: "ouro-agent", when: "Pick this for open conversation with the agent over several turns; the more specific tools fit asking, handing off and reporting.", effect: "write", openWorld: true, errors: turnErrors("send_message", "message", "what you want to say") },
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
      ax: { id: "mcp:check_response", group: "ouro-agent", when: "Pick this to collect replies the agent left for you, after send_message says it will answer later or when it wrote unprompted; each comes back once.", effect: "write", errors: [
        { code: "pending-unreadable", means: "The agent's pending-message folder for this session couldn't be read; the line below says why.", fix: "Call check_response again in a moment; if it keeps failing, call status to check the agent's bundle." },
      ] },
      inputSchema: {
        type: "object",
        properties: {},
      },
    },
    // The mailbox group's tools, generated by ouro-actions from actions/mailbox.actions.mts. Each is named here, where
    // the census places MCP doors; mailboxMcpSchema reads the rest from mcp.json and fails on a name it doesn't list.
    { ...mailboxSend, name: "mailbox_send", inputSchema: mailboxSend.inputSchema },
    { ...mailboxList, name: "mailbox_list", inputSchema: mailboxList.inputSchema },
    { ...mailboxRead, name: "mailbox_read", inputSchema: mailboxRead.inputSchema },
    { ...mailboxWait, name: "mailbox_wait", inputSchema: mailboxWait.inputSchema },
    { ...mailboxWithdraw, name: "mailbox_withdraw", inputSchema: mailboxWithdraw.inputSchema },
    { ...mailboxDeliver, name: "mailbox_deliver", inputSchema: mailboxDeliver.inputSchema },
  ]
}
// MCP server v0.1.0-alpha.140
