import { spawn, type ChildProcess, type SpawnOptionsWithoutStdio } from "child_process"
import * as path from "path"
import { emitNervesEvent } from "../../nerves/runtime"
import type { SenseProbe } from "./health-monitor"

type SpawnImpl = (command: string, args: string[], options: SpawnOptionsWithoutStdio) => ChildProcess

interface PendingRequest {
  resolve: (value: Record<string, unknown>) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

export interface ParsedMcpStatus {
  daemon: Record<string, string>
  senses: Record<string, Record<string, string>>
  raw: string
}

export interface McpStatusCanaryOptions {
  agent: string
  socketPath?: string
  command?: string
  commandArgs?: string[]
  timeoutMs?: number
  requiredSenses?: string[]
  ignoreOverviewHealth?: boolean
  spawnImpl?: SpawnImpl
}

export interface McpStatusCanaryResult {
  ok: boolean
  summary: string
  details: string[]
  parsed?: ParsedMcpStatus
}

const DEFAULT_CANARY_TIMEOUT_MS = 10_000
const MCP_PROTOCOL_VERSION = "2024-11-05"

function defaultCommandArgs(agent: string, socketPath?: string): string[] {
  const entryPath = path.join(__dirname, "ouro-bot-entry.js")
  return [
    entryPath,
    "mcp-serve",
    "--agent",
    agent,
    ...(socketPath ? ["--socket", socketPath] : []),
  ]
}

function responseText(response: Record<string, unknown>): string {
  const result = response.result
  if (!result || typeof result !== "object" || Array.isArray(result)) return JSON.stringify(response)
  const content = (result as Record<string, unknown>).content
  if (!Array.isArray(content)) return JSON.stringify(response)
  const first = content[0]
  if (!first || typeof first !== "object" || Array.isArray(first)) return JSON.stringify(response)
  const text = (first as Record<string, unknown>).text
  return typeof text === "string" ? text : JSON.stringify(response)
}

function parseFields(line: string): Record<string, string> {
  const parsed: Record<string, string> = {}
  for (const segment of line.split("\t")) {
    const idx = segment.indexOf("=")
    if (idx <= 0) continue
    parsed[segment.slice(0, idx)] = segment.slice(idx + 1)
  }
  return parsed
}

export function parseMcpStatusText(text: string): ParsedMcpStatus {
  const daemon: Record<string, string> = {}
  const senses: Record<string, Record<string, string>> = {}

  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed) continue
    if (trimmed.startsWith("daemon=")) {
      Object.assign(daemon, parseFields(trimmed))
      continue
    }
    if (!trimmed.startsWith("sense=")) continue
    const fields = parseFields(trimmed)
    const sense = fields.sense
    if (!sense) continue
    const [name, status = "unknown"] = sense.split(":")
    senses[name] = { ...fields, name, status }
  }

  return { daemon, senses, raw: text }
}

function validateMcpStatus(
  parsed: ParsedMcpStatus,
  requiredSenses: string[],
  options: Pick<McpStatusCanaryOptions, "ignoreOverviewHealth"> = {},
): McpStatusCanaryResult {
  const failures: string[] = []
  if (parsed.daemon.daemon !== "running") {
    failures.push(`daemon=${parsed.daemon.daemon ?? "missing"}`)
  }
  if (!options.ignoreOverviewHealth && parsed.daemon.health !== "ok") {
    failures.push(`health=${parsed.daemon.health ?? "missing"}`)
  }
  if (
    parsed.daemon.daemonVersion &&
    parsed.daemon.mcpVersion &&
    parsed.daemon.daemonVersion !== parsed.daemon.mcpVersion
  ) {
    failures.push(`version mismatch daemon=${parsed.daemon.daemonVersion} mcp=${parsed.daemon.mcpVersion}`)
  }

  for (const [sense, row] of Object.entries(parsed.senses)) {
    if (row.status === "disabled") continue
    if (row.status === "running" || row.status === "interactive") continue
    failures.push(`sense=${sense}:${row.status}`)
  }

  for (const sense of requiredSenses) {
    const row = parsed.senses[sense]
    if (!row) {
      failures.push(`required sense missing: ${sense}`)
      continue
    }
    if (row.status !== "running" && row.status !== "interactive") {
      failures.push(`required sense unhealthy: ${sense}:${row.status}`)
    }
  }

  const senseSummary = Object.values(parsed.senses)
    .map((row) => `${row.name}:${row.status}`)
    .join(",")
  const summary = failures.length === 0
    ? `mcp canary ok: daemon=${parsed.daemon.daemon} health=${parsed.daemon.health}${options.ignoreOverviewHealth ? " (overview ignored)" : ""} senses=${senseSummary}`
    : `mcp canary failed: ${failures.join("; ")}`

  return {
    ok: failures.length === 0,
    summary,
    details: failures.length === 0 ? [parsed.raw] : [...failures, parsed.raw],
    parsed,
  }
}

export async function runMcpStatusCanary(options: McpStatusCanaryOptions): Promise<McpStatusCanaryResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_CANARY_TIMEOUT_MS
  /* v8 ignore next -- default spawn is exercised by live canaries, while unit tests inject a fake child @preserve */
  const spawnImpl = options.spawnImpl ?? spawn
  const command = options.command ?? process.execPath
  const commandArgs = options.commandArgs ?? defaultCommandArgs(options.agent, options.socketPath)
  const requiredSenses = options.requiredSenses ?? []

  emitNervesEvent({
    component: "daemon",
    event: "daemon.mcp_canary_start",
    message: "starting MCP status canary",
    meta: {
      agent: options.agent,
      command,
      commandArgs,
      timeoutMs,
      requiredSenses,
      ignoreOverviewHealth: options.ignoreOverviewHealth === true,
    },
  })

  const child = spawnImpl(command, commandArgs, { stdio: ["pipe", "pipe", "pipe"] })
  let buffer = ""
  let stderr = ""
  const pending = new Map<number, PendingRequest>()

  function cleanup(): void {
    for (const [, request] of pending) {
      clearTimeout(request.timer)
    }
    pending.clear()
    if (!child.killed) child.kill()
  }

  function failAll(error: Error): void {
    for (const [, request] of pending) {
      clearTimeout(request.timer)
      request.reject(error)
    }
    pending.clear()
  }

  child.stderr?.setEncoding("utf8")
  child.stderr?.on("data", (chunk: string | Buffer) => {
    stderr += chunk.toString()
  })
  child.stdout?.setEncoding("utf8")
  child.stdout?.on("data", (chunk: string | Buffer) => {
    buffer += chunk.toString()
    for (;;) {
      const idx = buffer.indexOf("\n")
      if (idx === -1) break
      const line = buffer.slice(0, idx).trim()
      buffer = buffer.slice(idx + 1)
      if (!line) continue
      let response: Record<string, unknown>
      try {
        response = JSON.parse(line) as Record<string, unknown>
      } catch {
        failAll(new Error(`MCP canary received malformed JSON: ${line}`))
        return
      }
      const id = typeof response.id === "number" ? response.id : null
      if (id === null) continue
      const request = pending.get(id)
      if (!request) continue
      pending.delete(id)
      clearTimeout(request.timer)
      request.resolve(response)
    }
  })
  child.on("error", (error: Error) => failAll(error))
  child.on("close", (code: number | null, signal: NodeJS.Signals | null) => {
    if (pending.size === 0) return
    failAll(new Error(`MCP canary process closed before response code=${code} signal=${signal ?? "none"} stderr=${stderr.trim()}`))
  })

  let nextId = 1
  function request(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      if (!child.stdin?.writable) {
        reject(new Error("MCP canary stdin is not writable"))
        return
      }
      const id = nextId++
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error(`MCP canary timed out waiting for ${method}; stderr=${stderr.trim()}`))
      }, timeoutMs)
      pending.set(id, { resolve, reject, timer })
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n")
    })
  }

  try {
    await request("initialize", {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "ouro-mcp-canary", version: "1.0" },
    })
    child.stdin?.write(JSON.stringify({ jsonrpc: "2.0", method: "initialized" }) + "\n")
    const statusResponse = await request("tools/call", {
      name: "status",
      arguments: {},
    })
    const result = statusResponse.result
    if (result && typeof result === "object" && !Array.isArray(result) && (result as Record<string, unknown>).isError === true) {
      throw new Error(responseText(statusResponse))
    }
    const parsed = parseMcpStatusText(responseText(statusResponse))
    const canary = validateMcpStatus(parsed, requiredSenses, {
      ignoreOverviewHealth: options.ignoreOverviewHealth,
    })
    emitNervesEvent({
      component: "daemon",
      event: canary.ok ? "daemon.mcp_canary_end" : "daemon.mcp_canary_error",
      level: canary.ok ? "info" : "error",
      message: canary.summary,
      meta: { agent: options.agent, ok: canary.ok },
    })
    return canary
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    emitNervesEvent({
      component: "daemon",
      event: "daemon.mcp_canary_error",
      level: "error",
      message: "MCP status canary failed",
      meta: { agent: options.agent, reason },
    })
    return { ok: false, summary: `mcp canary failed: ${reason}`, details: [reason] }
  } finally {
    child.stdin?.end()
    cleanup()
  }
}

export function formatMcpStatusCanaryResult(result: McpStatusCanaryResult): string {
  return [
    result.ok ? "mcp canary: ok" : "mcp canary: failed",
    result.summary,
    ...result.details.map((line) => `  ${line}`),
  ].join("\n")
}

export function createMcpStatusCanaryProbe(options: Omit<McpStatusCanaryOptions, "spawnImpl">): SenseProbe {
  return {
    name: `mcp-canary:${options.agent}`,
    check: async () => {
      const result = await runMcpStatusCanary(options)
      return { ok: result.ok, detail: result.summary }
    },
  }
}
