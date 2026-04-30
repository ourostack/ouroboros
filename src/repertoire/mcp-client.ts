import { spawn } from "child_process"
import type { ChildProcess } from "child_process"
import { createInterface } from "readline"
import { emitNervesEvent } from "../nerves/runtime"
import type { McpServerConfig } from "../heart/identity"

export interface McpToolInfo {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

interface PendingRequest {
  resolve: (value: unknown) => void
  reject: (reason: Error) => void
  timer?: ReturnType<typeof setTimeout>
}

interface JsonRpcRequest {
  jsonrpc: "2.0"
  id: number
  method: string
  params?: Record<string, unknown>
}

interface JsonRpcResponse {
  jsonrpc: "2.0"
  id?: number
  result?: unknown
  error?: { code: number; message: string; data?: unknown }
}

const MCP_PROTOCOL_VERSION = "2024-11-05"
const DEFAULT_REQUEST_TIMEOUT = 10_000
const DEFAULT_TOOL_CALL_TIMEOUT = 30_000

export function isMcpTransportError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  const normalized = message.toLowerCase()
  return normalized.includes("disconnected")
    || normalized.includes("transport")
    || normalized.includes("closed")
    || normalized.includes("econnreset")
    || normalized.includes("econnrefused")
    || normalized.includes("enoent")
    || normalized.includes("epipe")
    || normalized.includes("broken pipe")
    || normalized.includes("not writable")
}

export class McpClient {
  private config: McpServerConfig
  private process: ChildProcess | null = null
  private nextId = 1
  private pending = new Map<number, PendingRequest>()
  private connected = false
  private cachedTools: McpToolInfo[] | null = null
  private onCloseCallback: (() => void) | null = null

  constructor(config: McpServerConfig) {
    this.config = config
  }

  async connect(): Promise<void> {
    if (this.connected) return
    this.shutdownProcessOnly()

    emitNervesEvent({
      event: "mcp.connect_start",
      component: "repertoire",
      message: "starting MCP server connection",
      meta: { command: this.config.command },
    })

    const env = { ...process.env, ...this.config.env }
    this.process = spawn(this.config.command, this.config.args ?? [], {
      env,
      stdio: ["pipe", "pipe", "pipe"],
      cwd: this.config.cwd,
    })

    this.setupLineReader()
    this.setupProcessHandlers()

    try {
      await this.initialize()
      this.connected = true
      emitNervesEvent({
        event: "mcp.connect_end",
        component: "repertoire",
        message: "MCP server connected",
        meta: { command: this.config.command },
      })
    } catch (error) {
      this.connected = false
      this.shutdownProcessOnly()
      emitNervesEvent({
        level: "error",
        event: "mcp.connect_error",
        component: "repertoire",
        message: "MCP server connection failed",
        meta: {
          command: this.config.command,
          /* v8 ignore next -- defensive: spawn errors are always Error instances @preserve */
          reason: error instanceof Error ? error.message : String(error),
        },
      })
      throw error
    }
  }

  async listTools(): Promise<McpToolInfo[]> {
    if (this.cachedTools) {
      return this.cachedTools
    }

    const allTools: McpToolInfo[] = []
    let cursor: string | undefined

    do {
      const params: Record<string, unknown> = {}
      if (cursor) {
        params.cursor = cursor
      }

      const result = await this.sendRequest("tools/list", params) as {
        tools: McpToolInfo[]
        nextCursor?: string
      }

      allTools.push(...result.tools)
      cursor = result.nextCursor
    } while (cursor)

    this.cachedTools = allTools
    return allTools
  }

  async refreshTools(): Promise<McpToolInfo[]> {
    this.cachedTools = null
    return this.listTools()
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
    timeout: number = DEFAULT_TOOL_CALL_TIMEOUT,
  ): Promise<{ content: Array<{ type: string; text: string }> }> {
    emitNervesEvent({
      event: "mcp.tool_call_start",
      component: "repertoire",
      message: `calling MCP tool: ${name}`,
      meta: { tool: name },
    })

    try {
      const result = await this.sendRequest("tools/call", {
        name,
        arguments: args,
      }, timeout) as { content: Array<{ type: string; text: string }> }

      emitNervesEvent({
        event: "mcp.tool_call_end",
        component: "repertoire",
        message: `MCP tool call completed: ${name}`,
        meta: { tool: name },
      })

      return result
    } catch (error) {
      emitNervesEvent({
        level: "error",
        event: "mcp.tool_call_error",
        component: "repertoire",
        message: `MCP tool call failed: ${name}`,
        meta: {
          tool: name,
          /* v8 ignore next -- defensive: callTool errors are always Error instances @preserve */
          reason: error instanceof Error ? error.message : String(error),
        },
      })
      throw error
    }
  }

  shutdown(): void {
    this.connected = false
    this.rejectAllPending(new Error("Client shutdown"))
    /* v8 ignore next -- defensive: process always exists during normal shutdown @preserve */
    if (this.process && !this.process.killed) {
      this.process.kill()
    }
    this.process = null
  }

  isConnected(): boolean {
    return this.connected
  }

  onClose(callback: () => void): void {
    this.onCloseCallback = callback
  }

  private async initialize(): Promise<void> {
    const result = await this.sendRequest("initialize", {
      protocolVersion: MCP_PROTOCOL_VERSION,
      clientInfo: { name: "ouroboros", version: "1.0" },
      capabilities: {},
    })

    // Send initialized notification (no id, no response expected)
    this.writeMessage({
      jsonrpc: "2.0",
      method: "initialized",
    } as unknown as JsonRpcRequest)

    return result as unknown as void
  }

  private sendRequest(
    method: string,
    params?: Record<string, unknown>,
    timeout: number = DEFAULT_REQUEST_TIMEOUT,
  ): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!this.process || !this.connected && method !== "initialize") {
        reject(new Error("MCP client is disconnected"))
        return
      }

      const id = this.nextId++
      const pending: PendingRequest = { resolve, reject }

      if (timeout) {
        pending.timer = setTimeout(() => {
          this.pending.delete(id)
          reject(new Error(`MCP request timeout after ${timeout}ms: ${method}`))
        }, timeout)
      }

      this.pending.set(id, pending)

      const request: JsonRpcRequest = {
        jsonrpc: "2.0",
        id,
        method,
        params,
      }

      if (!this.writeMessage(request)) {
        this.pending.delete(id)
        if (pending.timer) {
          clearTimeout(pending.timer)
        }
        reject(new Error(`MCP transport is not writable for request: ${method}`))
      }
    })
  }

  private writeMessage(message: JsonRpcRequest): boolean {
    if (this.process?.stdin?.writable) {
      this.process.stdin.write(JSON.stringify(message) + "\n")
      return true
    }
    return false
  }

  private setupLineReader(): void {
    /* v8 ignore next -- defensive: stdout always exists after spawn @preserve */
    if (!this.process?.stdout) return

    const rl = createInterface({ input: this.process.stdout })
    rl.on("line", (line: string) => {
      this.handleLine(line)
    })
  }

  private handleLine(line: string): void {
    let response: JsonRpcResponse
    try {
      response = JSON.parse(line) as JsonRpcResponse
    } catch {
      emitNervesEvent({
        level: "warn",
        event: "mcp.connect_error",
        component: "repertoire",
        message: "received malformed JSON from MCP server",
        meta: { line },
      })
      return
    }

    if (response.id === undefined || response.id === null) {
      // Notification or invalid — ignore
      return
    }

    const pending = this.pending.get(response.id)
    if (!pending) return

    this.pending.delete(response.id)
    if (pending.timer) {
      clearTimeout(pending.timer)
    }

    if (response.error) {
      pending.reject(new Error(response.error.message))
    } else {
      pending.resolve(response.result)
    }
  }

  private setupProcessHandlers(): void {
    /* v8 ignore next -- defensive: process always exists after spawn @preserve */
    if (!this.process) return

    this.process.on("error", (error: Error) => {
      emitNervesEvent({
        level: "error",
        event: "mcp.connect_error",
        component: "repertoire",
        message: "MCP server process error",
        meta: { reason: error.message },
      })
    })

    this.process.on("close", (code: number | null) => {
      const wasConnected = this.connected
      this.connected = false
      this.rejectAllPending(new Error(`MCP server process closed with code ${code}`))

      if (wasConnected) {
        emitNervesEvent({
          level: "error",
          event: "mcp.connect_error",
          component: "repertoire",
          message: "MCP server process exited unexpectedly",
          meta: { exitCode: code },
        })
      }

      if (this.onCloseCallback) {
        this.onCloseCallback()
      }
    })
  }

  private rejectAllPending(error: Error): void {
    for (const [id, pending] of this.pending) {
      if (pending.timer) {
        clearTimeout(pending.timer)
      }
      pending.reject(error)
      this.pending.delete(id)
    }
  }

  private shutdownProcessOnly(): void {
    this.rejectAllPending(new Error("MCP transport closed during reconnect"))
    /* v8 ignore next -- defensive: process may already be absent @preserve */
    if (this.process && !this.process.killed) {
      this.process.kill()
    }
    this.process = null
  }
}
