import { spawn, type ChildProcessWithoutNullStreams } from "child_process"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"

import { emitNervesEvent } from "../../nerves/runtime"

export type WorkbenchSessionStatus =
  | "configured"
  | "running"
  | "exited"
  | "waitingForInput"
  | "needsRecovery"
  | "manualActionNeeded"

export interface WorkbenchSession {
  id: string
  name: string
  group?: string
  owner?: { kind?: string; name?: string }
  kind?: string
  status?: WorkbenchSessionStatus
  attention?: string
  attentionReason?: string
  attentionPrompt?: string
  needsHuman?: boolean
  trust?: string
  autoResume?: boolean
  isArchived?: boolean
  isPinned?: boolean
  pid?: number
  exitCode?: number
  workingDirectory?: string
  transcriptPath?: string
  startedAt?: string
  lastOutputAt?: string
}

export interface WorkbenchCreateSessionAck {
  queued?: boolean
  name?: string
  group?: string
  owner?: string
  requestId?: string
  createGroupRequestId?: string
  message?: string
}

export interface WorkbenchActionAck {
  ok?: boolean
  message?: string
  requestId?: string
}

export interface WorkbenchActionResult {
  requestId: string
  state: "queued" | "applied" | "failed" | "appliedUnconfirmed" | "unknown"
  result?: string
  succeeded?: boolean
}

interface JsonRpcResponse {
  id?: string | number
  result?: {
    content?: Array<{ text?: string }>
    isError?: boolean
  }
  error?: { message?: string }
}

type SpawnFn = (command: string, args: string[], options: Record<string, unknown>) => ChildProcessWithoutNullStreams

export interface WorkbenchMcpClientOptions {
  executablePath?: string
  homeDir?: string
  existsSync?: (target: string) => boolean
  spawnFn?: SpawnFn
  timeoutMs?: number
  pollIntervalMs?: number
  createTimeoutMs?: number
  actionTimeoutMs?: number
}

export interface WorkbenchCreateCodingSessionRequest {
  owner: string
  name: string
  command: string
  workingDirectory: string
  prompt: string
  group?: string
  trust?: "trusted" | "untrusted"
  autoResume?: boolean
  source?: string
}

export interface WorkbenchCreateCodingSessionResult {
  session: WorkbenchSession
  createAck: WorkbenchCreateSessionAck
  promptAck: WorkbenchActionAck
  promptResult?: WorkbenchActionResult
}

export function defaultWorkbenchMcpCandidates(homeDir = os.homedir()): string[] {
  return [
    path.join(homeDir, "Applications", "Ouro Workbench.app", "Contents", "MacOS", "OuroWorkbenchMCP"),
    path.join("/Applications", "Ouro Workbench.app", "Contents", "MacOS", "OuroWorkbenchMCP"),
  ]
}

export function resolveWorkbenchMcpPath(options: Pick<WorkbenchMcpClientOptions, "executablePath" | "homeDir" | "existsSync"> = {}): string | null {
  const existsSync = options.existsSync ?? fs.existsSync
  const candidates = [
    ...(options.executablePath ? [options.executablePath] : []),
    ...defaultWorkbenchMcpCandidates(options.homeDir),
  ]
  return candidates.find((candidate) => existsSync(candidate)) ?? null
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function parseJson<T>(text: string, toolName: string): T {
  try {
    return JSON.parse(text) as T
  } catch (error) {
    throw new Error(`Workbench MCP ${toolName} returned non-JSON text: ${String(error)}`)
  }
}

function responseIdMatches(response: JsonRpcResponse, id: number): boolean {
  return response.id === id || response.id === String(id)
}

function responseText(response: JsonRpcResponse, toolName: string): string {
  if (response.error) {
    throw new Error(response.error.message ?? `Workbench MCP ${toolName} returned an RPC error`)
  }
  const text = response.result?.content?.map((item) => item.text ?? "").join("\n") ?? ""
  if (response.result?.isError) {
    throw new Error(text.trim() || `Workbench MCP ${toolName} returned an error`)
  }
  return text
}

export class WorkbenchMcpClient {
  private readonly executablePath: string
  private readonly spawnFn: SpawnFn
  private readonly timeoutMs: number
  private readonly pollIntervalMs: number
  private readonly createTimeoutMs: number
  private readonly actionTimeoutMs: number

  constructor(options: WorkbenchMcpClientOptions = {}) {
    const executablePath = resolveWorkbenchMcpPath(options)
    if (!executablePath) {
      throw new Error("OuroWorkbenchMCP not found in ~/Applications or /Applications")
    }
    this.executablePath = executablePath
    this.spawnFn = options.spawnFn ?? ((command, args, spawnOptions) => spawn(command, args, spawnOptions))
    this.timeoutMs = options.timeoutMs ?? 10_000
    this.pollIntervalMs = options.pollIntervalMs ?? 250
    this.createTimeoutMs = options.createTimeoutMs ?? 10_000
    this.actionTimeoutMs = options.actionTimeoutMs ?? 10_000
  }

  get commandPath(): string {
    return this.executablePath
  }

  async callToolText(name: string, args: Record<string, unknown>): Promise<string> {
    emitNervesEvent({
      component: "repertoire",
      event: "repertoire.workbench_mcp_call_start",
      message: "calling Workbench MCP tool",
      meta: { name },
    })

    const child = this.spawnFn(this.executablePath, [], {
      stdio: ["pipe", "pipe", "pipe"],
    })
    const stderrChunks: Buffer[] = []
    const stdoutChunks: Buffer[] = []

    child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk))

    const result = await new Promise<string>((resolve, reject) => {
      let settled = false
      let timer: NodeJS.Timeout

      const settle = (fn: () => void): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        fn()
      }

      timer = setTimeout(() => {
        settle(() => {
          child.kill("SIGTERM")
          reject(new Error(`Workbench MCP ${name} timed out after ${this.timeoutMs}ms`))
        })
      }, this.timeoutMs)

      child.on("error", (error) => {
        settle(() => reject(error))
      })
      child.on("exit", () => {
        const stderr = Buffer.concat(stderrChunks).toString("utf-8").trim()
        const stdout = Buffer.concat(stdoutChunks).toString("utf-8")
        if (!settled && stderr.length > 0 && stdout.trim().length === 0) {
          settle(() => reject(new Error(stderr)))
        }
      })
      child.stdout.on("data", (chunk: Buffer) => {
        stdoutChunks.push(chunk)
        for (const line of Buffer.concat(stdoutChunks).toString("utf-8").split(/\r?\n/)) {
          if (!line.trim()) continue
          let response: JsonRpcResponse
          try {
            response = JSON.parse(line) as JsonRpcResponse
          } catch {
            continue
          }
          if (!responseIdMatches(response, 2)) continue
          settle(() => {
            try {
              resolve(responseText(response, name))
            } catch (error) {
              reject(error)
            }
          })
        }
      })

      const initialize = { jsonrpc: "2.0", id: 1, method: "initialize", params: {} }
      const toolCall = { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: args } }
      child.stdin.write(`${JSON.stringify(initialize)}\n`)
      child.stdin.write(`${JSON.stringify(toolCall)}\n`)
      child.stdin.end()
    }).finally(() => {
      if (!child.killed) {
        child.kill("SIGTERM")
      }
    })

    emitNervesEvent({
      component: "repertoire",
      event: "repertoire.workbench_mcp_call_end",
      message: "Workbench MCP tool returned",
      meta: { name },
    })
    return result
  }

  async callToolJson<T>(name: string, args: Record<string, unknown>): Promise<T> {
    return parseJson<T>(await this.callToolText(name, args), name)
  }

  async createSession(args: Record<string, unknown>): Promise<WorkbenchCreateSessionAck> {
    return this.callToolJson<WorkbenchCreateSessionAck>("workbench_create_session", { ...args, format: "json" })
  }

  async listSessions(args: Record<string, unknown> = {}): Promise<WorkbenchSession[]> {
    const result = await this.callToolJson<{ sessions?: WorkbenchSession[] }>("workbench_sessions", args)
    return Array.isArray(result.sessions) ? result.sessions : []
  }

  async transcriptTail(entry: string, maxBytes = 64_000): Promise<string> {
    return this.callToolText("workbench_transcript_tail", { entry, maxBytes })
  }

  async requestAction(args: Record<string, unknown>): Promise<WorkbenchActionAck> {
    return this.callToolJson<WorkbenchActionAck>("workbench_request_action", { ...args, format: "json" })
  }

  async actionResult(requestId: string): Promise<WorkbenchActionResult> {
    return this.callToolJson<WorkbenchActionResult>("workbench_action_result", { requestId })
  }

  async createCodingSession(request: WorkbenchCreateCodingSessionRequest): Promise<WorkbenchCreateCodingSessionResult> {
    const source = request.source ?? "ouro-coding"
    const group = request.group ?? path.basename(request.workingDirectory)
    const createAck = await this.createSession({
      owner: request.owner,
      name: request.name,
      command: request.command,
      workingDirectory: request.workingDirectory,
      group,
      createGroupIfMissing: true,
      trust: request.trust ?? "trusted",
      autoResume: request.autoResume ?? true,
      source,
    })

    const session = await this.waitForSession({
      owner: request.owner,
      name: request.name,
      timeoutMs: this.createTimeoutMs,
    })
    const promptAck = await this.requestAction({
      source,
      action: "sendInput",
      entry: session.id,
      text: request.prompt,
      appendNewline: true,
    })
    const promptResult = promptAck.requestId
      ? await this.waitForAction(promptAck.requestId, this.actionTimeoutMs)
      : undefined

    return { session, createAck, promptAck, promptResult }
  }

  async waitForSession(input: { owner: string; name: string; timeoutMs?: number }): Promise<WorkbenchSession> {
    const deadline = Date.now() + (input.timeoutMs ?? this.createTimeoutMs)
    let lastSessions: WorkbenchSession[] = []
    while (Date.now() <= deadline) {
      lastSessions = await this.listSessions({ owner: input.owner, name: input.name, includeArchived: true })
      const match = lastSessions.find((session) =>
        session.name.toLowerCase() === input.name.toLowerCase()
        && (session.owner?.name === input.owner || !session.owner?.name)
      )
      if (match) return match
      await sleep(this.pollIntervalMs)
    }
    throw new Error(`Workbench did not create session "${input.name}" for ${input.owner}; last matches=${lastSessions.length}`)
  }

  async waitForAction(requestId: string, timeoutMs = this.actionTimeoutMs): Promise<WorkbenchActionResult> {
    const deadline = Date.now() + timeoutMs
    let latest: WorkbenchActionResult | null = null
    while (Date.now() <= deadline) {
      latest = await this.actionResult(requestId)
      if (latest.state !== "queued") return latest
      await sleep(this.pollIntervalMs)
    }
    return latest ?? { requestId, state: "queued" }
  }
}
