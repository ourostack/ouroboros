/**
 * CLI output formatting and rendering helpers.
 *
 * Pure functions that transform data into human-readable CLI output.
 * No side effects — callers handle writing to stdout.
 */

import * as path from "path"
import type { DaemonResponse } from "./daemon"
import { getRuntimeMetadata } from "./runtime-metadata"
import { detectRuntimeMode } from "./runtime-mode"
import { getRepoRoot } from "../identity"
import { readDaemonTombstone } from "./daemon-tombstone"
import { readHealth, getDefaultHealthPath } from "./daemon-health"
import type { McpListCliCommand, McpCallCliCommand } from "./cli-types"

// ── Status payload types ──

interface StatusOverviewRow {
  daemon: string
  health: string
  socketPath: string
  outlookUrl: string
  version: string
  lastUpdated: string
  repoRoot: string
  configFingerprint: string
  workerCount: number
  senseCount: number
  entryPath: string
  mode: string
}

interface StatusSenseRow {
  agent: string
  sense: string
  label?: string
  enabled: boolean
  status: string
  detail: string
}

interface StatusWorkerRow {
  agent: string
  worker: string
  status: string
  pid: number | null
  restartCount: number
  lastExitCode: number | null
  lastSignal: string | null
}

export interface StatusPayload {
  overview: StatusOverviewRow
  senses: StatusSenseRow[]
  workers: StatusWorkerRow[]
}

// ── Field extractors ──

function stringField(value: unknown): string | null {
  return typeof value === "string" ? value : null
}

function numberField(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null
}

function booleanField(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null
}

// ── Parsers ──

export function parseStatusPayload(data: unknown): StatusPayload | null {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null
  const raw = data as Record<string, unknown>
  const overview = raw.overview
  const senses = raw.senses
  const workers = raw.workers
  if (!overview || typeof overview !== "object" || Array.isArray(overview)) return null
  if (!Array.isArray(senses) || !Array.isArray(workers)) return null

  const parsedOverview: StatusOverviewRow = {
    daemon: stringField((overview as Record<string, unknown>).daemon) ?? "unknown",
    health: stringField((overview as Record<string, unknown>).health) ?? "unknown",
    socketPath: stringField((overview as Record<string, unknown>).socketPath) ?? "unknown",
    outlookUrl: stringField((overview as Record<string, unknown>).outlookUrl) ?? "unavailable",
    version: stringField((overview as Record<string, unknown>).version) ?? "unknown",
    lastUpdated: stringField((overview as Record<string, unknown>).lastUpdated) ?? "unknown",
    repoRoot: stringField((overview as Record<string, unknown>).repoRoot) ?? "unknown",
    configFingerprint: stringField((overview as Record<string, unknown>).configFingerprint) ?? "unknown",
    workerCount: numberField((overview as Record<string, unknown>).workerCount) ?? 0,
    senseCount: numberField((overview as Record<string, unknown>).senseCount) ?? 0,
    entryPath: stringField((overview as Record<string, unknown>).entryPath) ?? "unknown",
    mode: stringField((overview as Record<string, unknown>).mode) ?? "unknown",
  }

  const parsedSenses = senses.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null
    const row = entry as Record<string, unknown>
    const agent = stringField(row.agent)
    const sense = stringField(row.sense)
    const status = stringField(row.status)
    const detail = stringField(row.detail)
    const enabled = booleanField(row.enabled)
    if (!agent || !sense || !status || detail === null || enabled === null) return null
    return {
      agent,
      sense,
      label: stringField(row.label) ?? undefined,
      enabled,
      status,
      detail,
    } satisfies StatusSenseRow
  })

  const parsedWorkers = workers.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null
    const row = entry as Record<string, unknown>
    const agent = stringField(row.agent)
    const worker = stringField(row.worker)
    const status = stringField(row.status)
    const restartCount = numberField(row.restartCount)
    const hasPid = Object.prototype.hasOwnProperty.call(row, "pid")
    const pid = row.pid === null ? null : numberField(row.pid)
    const pidInvalid = !hasPid || (row.pid !== null && pid === null)
    if (!agent || !worker || !status || restartCount === null || pidInvalid) return null
    return {
      agent,
      worker,
      status,
      pid,
      restartCount,
      lastExitCode: numberField(row.lastExitCode) ?? null,
      lastSignal: stringField(row.lastSignal) ?? null,
    } satisfies StatusWorkerRow
  })

  if (parsedSenses.some((row) => row === null) || parsedWorkers.some((row) => row === null)) return null

  return {
    overview: parsedOverview,
    senses: parsedSenses as StatusSenseRow[],
    workers: parsedWorkers as StatusWorkerRow[],
  }
}

// ── Formatters ──

export function humanizeSenseName(sense: string, label?: string): string {
  if (label) return label
  if (sense === "cli") return "CLI"
  if (sense === "bluebubbles") return "BlueBubbles"
  if (sense === "teams") return "Teams"
  return sense
}

export function formatTable(headers: string[], rows: string[][]): string {
  const widths = headers.map((header, index) =>
    Math.max(header.length, ...rows.map((row) => row[index]!.length)),
  )
  const renderRow = (row: string[]) => `| ${row.map((cell, index) => (
    index === row.length - 1
      ? cell
      : cell.padEnd(widths[index])
  )).join(" | ")} |`
  const divider = `|-${widths.map((width) => "-".repeat(width)).join("-|-")}-|`
  return [
    renderRow(headers),
    divider,
    ...rows.map(renderRow),
  ].join("\n")
}

export function formatDaemonStatusOutput(response: DaemonResponse, fallback: string): string {
  const payload = parseStatusPayload(response.data)
  if (!payload) return fallback

  const overviewRows = [
    ["Daemon", payload.overview.daemon],
    ["Socket", payload.overview.socketPath],
    ["Version", payload.overview.version],
    ["Last Updated", payload.overview.lastUpdated],
    ["Outlook", payload.overview.outlookUrl],
    ["Entry Path", payload.overview.entryPath],
    ["Mode", payload.overview.mode],
    ["Workers", String(payload.overview.workerCount)],
    ["Senses", String(payload.overview.senseCount)],
    ["Health", payload.overview.health],
  ]
  const senseRows = payload.senses.map((row) => [
    row.agent,
    humanizeSenseName(row.sense, row.label),
    row.enabled ? "ON" : "OFF",
    row.status,
    row.detail,
  ])
  const workerRows = payload.workers.map((row) => {
    /* v8 ignore start — exit info branches tested via daemon-crash-context; v8 misreports conditional chains @preserve */
    let exitInfo = "n/a"
    if (row.lastExitCode !== null) exitInfo = `code=${row.lastExitCode}`
    if (row.lastSignal !== null) exitInfo = row.lastExitCode !== null ? `code=${row.lastExitCode} sig=${row.lastSignal}` : `sig=${row.lastSignal}`
    /* v8 ignore stop */
    return [
      row.agent,
      row.worker,
      row.status,
      row.pid === null ? "n/a" : String(row.pid),
      String(row.restartCount),
      exitInfo,
    ]
  })

  return [
    "Overview",
    formatTable(["Item", "Value"], overviewRows),
    "",
    "Senses",
    formatTable(["Agent", "Sense", "Enabled", "State", "Detail"], senseRows),
    "",
    "Workers",
    formatTable(["Agent", "Worker", "State", "PID", "Restarts", "Last Exit"], workerRows),
  ].join("\n")
}

export function formatVersionOutput(): string {
  const version = getRuntimeMetadata().version
  const mode = detectRuntimeMode(getRepoRoot())
  /* v8 ignore start — cosmetic display toggle; dev mode always true in test env */
  return mode === "dev" ? `${version} (dev)` : version
  /* v8 ignore stop */
}

export function buildStoppedStatusPayload(socketPath: string): StatusPayload {
  const metadata = getRuntimeMetadata()
  const repoRoot = getRepoRoot()
  return {
    overview: {
      daemon: "stopped",
      health: "warn",
      socketPath,
      outlookUrl: "unavailable",
      version: metadata.version,
      lastUpdated: metadata.lastUpdated,
      repoRoot: metadata.repoRoot,
      configFingerprint: metadata.configFingerprint,
      workerCount: 0,
      senseCount: 0,
      entryPath: path.join(repoRoot, "dist", "heart", "daemon", "daemon-entry.js"),
      mode: detectRuntimeMode(repoRoot),
    },
    senses: [],
    workers: [],
  }
}

export function daemonUnavailableStatusOutput(socketPath: string, healthFilePath?: string): string {
  /* v8 ignore start — tombstone read tested in daemon-status-tombstone.test; branch misreported @preserve */
  const tombstone = readDaemonTombstone()
  const deathLine = tombstone
    ? `Last death: ${tombstone.timestamp} -- ${tombstone.reason}: ${tombstone.message}`
    : null
  /* v8 ignore stop */

  const lines = [
    formatDaemonStatusOutput({
      ok: true,
      summary: "daemon not running",
      data: buildStoppedStatusPayload(socketPath),
    }, "daemon not running"),
    "",
  ]

  /* v8 ignore start — tombstone presence requires real daemon crash @preserve */
  if (deathLine) {
    lines.push(deathLine)
    lines.push("")
  /* v8 ignore stop */
  }

  // Read health file for last-known state (best-effort)
  const resolvedHealthPath = healthFilePath ?? getDefaultHealthPath()
  const health = readHealth(resolvedHealthPath)
  if (health) {
    lines.push(`Last known status: ${health.status} (pid ${health.pid}, uptime ${health.uptimeSeconds}s)`)

    if (health.safeMode?.active) {
      lines.push(`SAFE MODE: ${health.safeMode.reason}`)
    }

    if (health.degraded.length > 0) {
      lines.push("")
      lines.push("Degraded:")
      for (const d of health.degraded) {
        lines.push(`  ${d.component}: ${d.reason} (since ${d.since})`)
      }
    }

    lines.push("")
  }

  lines.push("daemon not running; run `ouro up`")

  return lines.join("\n")
}

export function isDaemonUnavailableError(error: unknown): boolean {
  const code = typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code ?? "")
    : ""
  return code === "ENOENT" || code === "ECONNREFUSED"
}

export function formatMcpResponse(command: McpListCliCommand | McpCallCliCommand, response: DaemonResponse): string {
  if (command.kind === "mcp.list") {
    const allTools = response.data as Array<{ server: string; tools: Array<{ name: string; description: string }> }> | undefined
    if (!allTools || allTools.length === 0) {
      return response.message ?? "no tools available from connected MCP servers"
    }
    const lines: string[] = []
    for (const entry of allTools) {
      lines.push(`[${entry.server}]`)
      for (const tool of entry.tools) {
        lines.push(`  ${tool.name}: ${tool.description}`)
      }
    }
    return lines.join("\n")
  }
  // mcp.call
  const result = response.data as { content: Array<{ type: string; text: string }> } | undefined
  if (!result) {
    return response.message ?? "no result"
  }
  return result.content.map((c) => c.text).join("\n")
}
