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
  ignoreSenseHealth?: boolean
  spawnImpl?: SpawnImpl
  hostStallObserved?: boolean
}

export interface McpStatusCanaryResult {
  ok: boolean
  summary: string
  details: string[]
  classification?: McpBoundaryClassification
  evidence?: McpCanaryEvidence
  parsed?: ParsedMcpStatus
  repair?: McpBridgeRepairGuidance
}

export type McpBoundaryClassification =
  | "ouro-bridge-failed"
  | "ouro-bridge-healthy-at-capture"
  | "host-stall-unexplained"

export type McpCanaryPhase = "spawn" | "initialize" | "status" | "complete"

export interface McpCanaryEvidence {
  capturedAt: string
  durationMs: number
  childPid: number | null
  phase: McpCanaryPhase
  exitCode: number | null
  exitSignal: NodeJS.Signals | null
  stderr: string
}

export interface McpBridgeRepairGuidance {
  actor: "agent-runnable"
  commands: string[]
  reload: string
  verify: string
}

export interface McpDoctorNextSteps {
  actor: "agent-runnable"
  commands: string[]
  note: string
}

export const DEFAULT_CANARY_TIMEOUT_MS = 60_000
export const SETUP_CANARY_TIMEOUT_MS = 10_000
const MCP_PROTOCOL_VERSION = "2024-11-05"

export function classifyMcpBoundary(input: {
  bridgeHealthy: boolean
  hostStallObserved: boolean
}): McpBoundaryClassification {
  if (!input.bridgeHealthy) return "ouro-bridge-failed"
  return input.hostStallObserved ? "host-stall-unexplained" : "ouro-bridge-healthy-at-capture"
}

export function sanitizeMcpCanaryText(text: string): string {
  return text
    .replace(/(https?:\/\/[^\s?]+)\?[^\s]*/g, "$1?[redacted]")
    .replace(/("(?:password|token|secret|api[_-]?key)"\s*:\s*")[^"]*(")/gi, "$1[redacted]$2")
    .replace(/\bBearer\s+[^\s]+/gi, "Bearer [redacted]")
    .replace(/(--(?:password|token|secret|api[_-]?key))(\s+|=)[^\s]+/gi, "$1$2[redacted]")
    .replace(/\b(password|token|secret|api[_-]?key)=([^\s]+)/gi, "$1=[redacted]")
    .trim()
}

export function sanitizeMcpCanaryArgs(args: string[]): string[] {
  const sanitized: string[] = []
  let redactNext = false
  for (const arg of args) {
    if (redactNext) {
      sanitized.push("[redacted]")
      redactNext = false
      continue
    }
    if (/^--(?:password|token|secret|api[_-]?key)$/i.test(arg)) {
      sanitized.push(arg)
      redactNext = true
      continue
    }
    sanitized.push(sanitizeMcpCanaryText(arg))
  }
  return sanitized
}

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

function shellArg(value: string): string {
  return /^[A-Za-z0-9._/-]+$/.test(value)
    ? value
    : `'${value.replace(/'/g, "'\\''")}'`
}

export function buildMcpBridgeRepairGuidance(agent: string): McpBridgeRepairGuidance {
  const agentArg = shellArg(agent)
  return {
    actor: "agent-runnable",
    commands: [
      `ouro setup --tool codex --agent ${agentArg}`,
      `ouro setup --tool claude-code --agent ${agentArg}`,
    ],
    reload: "open a fresh dev-tool session after setup; existing MCP processes keep their old runtime",
    verify: `ouro mcp doctor --agent ${agentArg}`,
  }
}

export function formatMcpBridgeRepairDetails(repair: McpBridgeRepairGuidance): string[] {
  return [
    `repair actor=${repair.actor}`,
    ...repair.commands.map((command) => `repair command=${command}`),
    `reload required: ${repair.reload}`,
    `verify command=${repair.verify}`,
  ]
}

export function buildMcpDoctorNextSteps(result: Pick<McpStatusCanaryResult, "summary" | "details">, agent: string): McpDoctorNextSteps {
  const agentArg = shellArg(agent)
  const text = [result.summary, ...result.details].join("\n")
  const daemonUnreachable = text.includes("daemon=unreachable")
    || text.includes("ECONNREFUSED")
    || text.includes("ENOENT")
  if (daemonUnreachable) {
    return {
      actor: "agent-runnable",
      commands: [
        "ouro up",
        `ouro mcp doctor --agent ${agentArg}`,
      ],
      note: "start or refresh the daemon before trusting bridge status",
    }
  }
  return {
    actor: "agent-runnable",
    commands: [
      "ouro doctor",
      `ouro status --agent ${agentArg}`,
      `ouro repair --agent ${agentArg}`,
      `ouro mcp doctor --agent ${agentArg}`,
    ],
    note: "fix reported daemon or sense health before rerunning bridge registration repair",
  }
}

export function formatMcpDoctorNextStepDetails(nextSteps: McpDoctorNextSteps): string[] {
  return [
    `next actor=${nextSteps.actor}`,
    ...nextSteps.commands.map((command) => `next command=${command}`),
    `next note=${nextSteps.note}`,
  ]
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
  options: Partial<Pick<McpStatusCanaryOptions, "ignoreOverviewHealth" | "ignoreSenseHealth" | "agent">> = {},
): McpStatusCanaryResult {
  const failures: string[] = []
  if (parsed.daemon.daemon !== "running") {
    failures.push(`daemon=${parsed.daemon.daemon ?? "missing"}`)
  }
  if (!options.ignoreOverviewHealth && parsed.daemon.health !== "ok") {
    failures.push(`health=${parsed.daemon.health ?? "missing"}`)
  }
  const hasVersionMismatch = !!(
    parsed.daemon.daemonVersion &&
    parsed.daemon.mcpVersion &&
    parsed.daemon.daemonVersion !== parsed.daemon.mcpVersion
  )
  if (hasVersionMismatch) {
    failures.push(`version mismatch daemon=${parsed.daemon.daemonVersion} mcp=${parsed.daemon.mcpVersion}`)
  }

  if (!options.ignoreSenseHealth) {
    for (const [sense, row] of Object.entries(parsed.senses)) {
      if (row.status === "disabled") continue
      if (row.status === "running" || row.status === "interactive") continue
      failures.push(`sense=${sense}:${row.status}`)
    }
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
    ? `mcp canary ok: daemon=${parsed.daemon.daemon} health=${parsed.daemon.health}${options.ignoreOverviewHealth ? " (overview ignored)" : ""} senses=${senseSummary}${options.ignoreSenseHealth ? " (sense health reported, not gated)" : ""}`
    : `mcp canary failed: ${failures.join("; ")}`
  const repair = hasVersionMismatch && options.agent
    ? buildMcpBridgeRepairGuidance(options.agent)
    : undefined
  const repairDetails = repair ? formatMcpBridgeRepairDetails(repair) : []

  return {
    ok: failures.length === 0,
    summary,
    details: failures.length === 0 ? [parsed.raw] : [...failures, ...repairDetails, parsed.raw],
    parsed,
    ...(repair ? { repair } : {}),
  }
}

export async function runMcpStatusCanary(options: McpStatusCanaryOptions): Promise<McpStatusCanaryResult> {
  const startedAt = Date.now()
  const timeoutMs = options.timeoutMs ?? DEFAULT_CANARY_TIMEOUT_MS
  const deadlineAt = startedAt + timeoutMs
  const evidence: McpCanaryEvidence = {
    capturedAt: new Date(startedAt).toISOString(),
    durationMs: 0,
    childPid: null,
    phase: "spawn",
    exitCode: null,
    exitSignal: null,
    stderr: "",
  }
  const decorate = (result: McpStatusCanaryResult, bridgeHealthy = false): McpStatusCanaryResult => ({
    ...result,
    classification: classifyMcpBoundary({ bridgeHealthy, hostStallObserved: options.hostStallObserved === true }),
    evidence,
  })
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
      commandArgs: sanitizeMcpCanaryArgs(commandArgs),
      timeoutMs,
      requiredSenses,
      ignoreOverviewHealth: options.ignoreOverviewHealth === true,
      ignoreSenseHealth: options.ignoreSenseHealth === true,
    },
  })

  let child: ChildProcess
  try {
    child = spawnImpl(command, commandArgs, { stdio: ["pipe", "pipe", "pipe"] })
    evidence.childPid = child.pid ?? null
  } catch (error) {
    const reason = sanitizeMcpCanaryText(error instanceof Error ? error.message : String(error))
    evidence.durationMs = Date.now() - startedAt
    emitNervesEvent({
      component: "daemon",
      event: "daemon.mcp_canary_error",
      level: "error",
      message: "MCP status canary failed to spawn",
      meta: { agent: options.agent, reason },
    })
    return decorate({ ok: false, summary: `mcp canary failed: ${reason}`, details: [reason] })
  }
  let buffer = ""
  let stderr = ""
  const pending = new Map<number, PendingRequest>()
  let resolveExit!: () => void
  const exitObserved = new Promise<void>((resolve) => { resolveExit = resolve })

  function safeStderr(): string {
    return sanitizeMcpCanaryText(stderr)
  }

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
    evidence.exitCode = code
    evidence.exitSignal = signal
    resolveExit()
    if (pending.size === 0) return
    failAll(new Error(`MCP canary process closed before response code=${code} signal=${signal ?? "none"} stderr=${safeStderr()}`))
  })

  let nextId = 1
  function request(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      if (!child.stdin?.writable) {
        reject(new Error("MCP canary stdin is not writable"))
        return
      }
      const remainingMs = deadlineAt - Date.now()
      if (remainingMs <= 0) {
        reject(new Error(`MCP canary timed out waiting for ${method}; stderr=${safeStderr()}`))
        return
      }
      const id = nextId++
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error(`MCP canary timed out waiting for ${method}; stderr=${safeStderr()}`))
      }, remainingMs)
      pending.set(id, { resolve, reject, timer })
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n")
    })
  }

  try {
    evidence.phase = "initialize"
    await request("initialize", {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "ouro-mcp-canary", version: "1.0" },
    })
    child.stdin?.write(JSON.stringify({ jsonrpc: "2.0", method: "initialized" }) + "\n")
    evidence.phase = "status"
    const statusResponse = await request("tools/call", {
      name: "status",
      arguments: {},
    })
    const result = statusResponse.result
    if (result && typeof result === "object" && !Array.isArray(result) && (result as Record<string, unknown>).isError === true) {
      throw new Error(responseText(statusResponse))
    }
    const bridgeHealthy = true
    const parsed = parseMcpStatusText(responseText(statusResponse))
    const canary = validateMcpStatus(parsed, requiredSenses, {
      agent: options.agent,
      ignoreOverviewHealth: options.ignoreOverviewHealth,
      ignoreSenseHealth: options.ignoreSenseHealth,
    })
    evidence.phase = "complete"
    emitNervesEvent({
      component: "daemon",
      event: canary.ok ? "daemon.mcp_canary_end" : "daemon.mcp_canary_error",
      level: canary.ok ? "info" : "error",
      message: canary.summary,
      meta: { agent: options.agent, ok: canary.ok },
    })
    return decorate(canary, bridgeHealthy)
  } catch (error) {
    const reason = sanitizeMcpCanaryText(error instanceof Error ? error.message : String(error))
    emitNervesEvent({
      component: "daemon",
      event: "daemon.mcp_canary_error",
      level: "error",
      message: "MCP status canary failed",
      meta: { agent: options.agent, reason },
    })
    return decorate({ ok: false, summary: `mcp canary failed: ${reason}`, details: [reason] })
  } finally {
    child.stdin?.end()
    cleanup()
    let exitTimer!: ReturnType<typeof setTimeout>
    const remainingExitWaitMs = Math.min(100, Math.max(0, deadlineAt - Date.now()))
    await Promise.race([
      exitObserved,
      new Promise<void>((resolve) => { exitTimer = setTimeout(resolve, remainingExitWaitMs) }),
    ])
    clearTimeout(exitTimer)
    evidence.stderr = safeStderr()
    evidence.durationMs = Date.now() - startedAt
  }
}

export function formatMcpStatusCanaryResult(result: McpStatusCanaryResult): string {
  return [
    result.ok ? "mcp canary: ok" : "mcp canary: failed",
    ...(result.classification ? [`classification: ${result.classification}`] : []),
    ...(result.evidence ? [
      `captured=${result.evidence.capturedAt} durationMs=${result.evidence.durationMs} childPid=${result.evidence.childPid ?? "none"} phase=${result.evidence.phase} exitCode=${result.evidence.exitCode ?? "none"} exitSignal=${result.evidence.exitSignal ?? "none"}`,
      ...(result.evidence.stderr ? [`stderr=${result.evidence.stderr}`] : []),
    ] : []),
    result.summary,
    ...result.details.map((line) => `  ${line}`),
  ].join("\n")
}

export function formatMcpStatusDoctorResult(result: McpStatusCanaryResult, agent: string): string {
  const rawDetails = result.details.filter((line) =>
    !line.startsWith("repair ")
    && !line.startsWith("reload required:")
    && !line.startsWith("verify command="),
  )
  const lines = [
    result.ok ? "mcp doctor: ok" : "mcp doctor: failed",
    ...(result.classification ? [`classification: ${result.classification}`] : []),
    ...(result.evidence ? [
      `captured=${result.evidence.capturedAt} durationMs=${result.evidence.durationMs} childPid=${result.evidence.childPid ?? "none"} phase=${result.evidence.phase} exitCode=${result.evidence.exitCode ?? "none"} exitSignal=${result.evidence.exitSignal ?? "none"}`,
      ...(result.evidence.stderr ? [`stderr=${result.evidence.stderr}`] : []),
    ] : []),
    result.summary,
    ...rawDetails.map((line) => `  ${line}`),
  ]
  if (result.ok || result.repair) {
    const repair = result.repair ?? buildMcpBridgeRepairGuidance(agent)
    lines.push("bridge registration path:")
    lines.push(...formatMcpBridgeRepairDetails(repair).map((line) => `  ${line}`))
  } else {
    lines.push("next checks:")
    lines.push(...formatMcpDoctorNextStepDetails(buildMcpDoctorNextSteps(result, agent)).map((line) => `  ${line}`))
  }
  return lines.join("\n")
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
