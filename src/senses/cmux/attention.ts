import { createHash } from "node:crypto"
import * as fs from "node:fs"
import * as path from "node:path"
import type { ExternalEventInput } from "../../heart/external-events/router"
import { emitNervesEvent } from "../../nerves/runtime"

/**
 * What the cmux sense remembers between events: the stream cursor, what each terminal's coding
 * agent was last doing (from Feed hook events), and which Feed requests it already escalated.
 * Feed and agent-hook stream events redact tool input, so this state never holds prompt or
 * command text; pending request content is read from `feed.list` only when needed.
 */
export type CmuxLifecycle = "working" | "idle" | "waiting" | "ended"

export interface CmuxSurfaceActivity {
  workspaceId: string | null
  agent: string
  sessionId: string | null
  cwd: string | null
  lifecycle: CmuxLifecycle
  lastHook: string
  lastTool: string | null
  at: string
}

export interface CmuxSenseState {
  schemaVersion: 1
  bootId: string | null
  seq: number | null
  surfaces: Record<string, CmuxSurfaceActivity>
  escalated: string[]
  /** Whether the sense currently holds a live `events.stream`, and the last connection error (with its repair hint). */
  connected: boolean
  lastError: string | null
  updatedAt: string
}

export interface CmuxPendingFeedItem {
  requestId: string
  kind: string
  source: string
  toolName: string | null
  cwd: string | null
  workstreamId: string | null
  createdAt: string | null
  toolInput: string | null
  toolInputTruncated: boolean
}

const MAX_SURFACES = 100
const MAX_ESCALATED = 500
const DECISION_KINDS = new Set(["permissionRequest", "question", "exitPlan"])
const BLOCKING_TOOLS = new Set(["AskUserQuestion", "ExitPlanMode"])

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null
}

export function emptyCmuxState(now: string): CmuxSenseState {
  return { schemaVersion: 1, bootId: null, seq: null, surfaces: {}, escalated: [], connected: false, lastError: null, updatedAt: now }
}

export function readCmuxState(file: string, now: string): CmuxSenseState {
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(file, "utf-8"))
    const value = isRecord(raw) ? raw : {}
    return {
      ...emptyCmuxState(now),
      bootId: str(value.bootId),
      seq: typeof value.seq === "number" ? value.seq : null,
      surfaces: isRecord(value.surfaces) ? value.surfaces as Record<string, CmuxSurfaceActivity> : {},
      escalated: Array.isArray(value.escalated) ? value.escalated.filter((id): id is string => typeof id === "string") : [],
      connected: value.connected === true,
      lastError: str(value.lastError),
    }
  } catch {
    return emptyCmuxState(now)
  }
}

/** Machine-local and private: the directory is 0700 and the file 0600, replaced atomically. */
export function writeCmuxState(file: string, state: CmuxSenseState): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  fs.chmodSync(path.dirname(file), 0o700)
  const temp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 })
  fs.renameSync(temp, file)
}

function lifecycleFor(hook: string, tool: string | null): CmuxLifecycle {
  if (hook === "SessionStart" || hook === "Stop") return "idle"
  if (hook === "SessionEnd") return "ended"
  if (hook === "PermissionRequest" || hook === "Notification") return "waiting"
  if (hook === "PreToolUse" && tool && BLOCKING_TOOLS.has(tool)) return "waiting"
  return "working"
}

/**
 * Folds one `events.stream` frame into the state. Returns `feedCheck: true` when an agent may now
 * be waiting on the human, so the caller re-reads `feed.list {"pending_only": true}`.
 */
export function applyEventFrame(state: CmuxSenseState, frame: Record<string, unknown>, now: string): { feedCheck: boolean } {
  if (frame.type !== "event" || typeof frame.seq !== "number") return { feedCheck: false }
  state.seq = frame.seq
  state.bootId = str(frame.boot_id) ?? state.bootId
  state.updatedAt = now
  const payload = isRecord(frame.payload) ? frame.payload : {}
  const surfaceId = str(payload.surface_id) ?? str(frame.surface_id)
  if (frame.name === "surface.closed") {
    if (surfaceId) delete state.surfaces[surfaceId]
    return { feedCheck: false }
  }
  if (frame.name === "feed.item.resolved") return { feedCheck: true }
  const hook = str(payload.hook_event_name)
  if (frame.name !== "feed.item.received" || !hook || !surfaceId) return { feedCheck: false }
  const tool = str(payload.tool_name)
  const previous = state.surfaces[surfaceId]
  const lifecycle = lifecycleFor(hook, tool)
  state.surfaces[surfaceId] = {
    workspaceId: str(payload.workspace_id) ?? str(frame.workspace_id),
    agent: str(payload._source) ?? str(frame.source) ?? "unknown",
    sessionId: str(payload.session_id),
    cwd: str(payload.cwd),
    lifecycle,
    lastHook: hook,
    lastTool: tool ?? previous?.lastTool ?? null,
    at: now,
  }
  const ids = Object.keys(state.surfaces)
  if (ids.length > MAX_SURFACES) {
    const stalest = ids.reduce((oldest, id) => state.surfaces[id]!.at < state.surfaces[oldest]!.at ? id : oldest)
    delete state.surfaces[stalest]
  }
  return { feedCheck: lifecycle === "waiting" }
}

export function rememberEscalation(state: CmuxSenseState, requestId: string): void {
  if (state.escalated.includes(requestId)) return
  state.escalated.push(requestId)
  if (state.escalated.length > MAX_ESCALATED) state.escalated.splice(0, state.escalated.length - MAX_ESCALATED)
}

export function surfaceForSession(state: CmuxSenseState, sessionId: string | null): { surfaceId: string; activity: CmuxSurfaceActivity } | null {
  const match = Object.entries(state.surfaces).find(([, activity]) => sessionId !== null && activity.sessionId === sessionId)
  return match ? { surfaceId: match[0], activity: match[1] } : null
}

/** The decisions cmux is holding open for a human, from `feed.list {"pending_only": true}`. */
export function pendingFeedItems(result: Record<string, unknown>): CmuxPendingFeedItem[] {
  const items = Array.isArray(result.items) ? result.items : []
  return items.filter(isRecord).flatMap((item) => {
    const requestId = str(item.request_id)
    const kind = str(item.kind)
    if (!requestId || !kind || !DECISION_KINDS.has(kind) || item.status !== "pending") return []
    return [{
      requestId,
      kind,
      source: str(item.source) ?? "unknown",
      toolName: str(item.tool_name),
      cwd: str(item.cwd),
      workstreamId: str(item.workstream_id),
      createdAt: str(item.created_at),
      toolInput: str(item.tool_input),
      toolInputTruncated: item.tool_input_truncated === true,
    }]
  })
}

const AGENT_LABELS: Record<string, string> = { claude: "Claude Code", codex: "Codex", copilot: "Copilot" }
const KIND_LABELS: Record<string, string> = {
  permissionRequest: "a permission decision",
  question: "an answer to a question",
  exitPlan: "a plan approval",
}

function boundedEventId(requestId: string): string {
  const safe = requestId.replace(/[^A-Za-z0-9._:-]/g, "_")
  if (safe.length <= 150) return `feed:${safe}`
  return `feed:${safe.slice(0, 100)}:${createHash("sha256").update(requestId).digest("hex").slice(0, 32)}`
}

/**
 * One external event per Feed request id. The receipt names where the request is and what kind it
 * is, never the tool input: provider payloads are untrusted telemetry and may hold secrets.
 */
export function escalationInput(
  agent: string,
  item: CmuxPendingFeedItem,
  surface: { surfaceId: string; activity: CmuxSurfaceActivity } | null,
): ExternalEventInput {
  const who = AGENT_LABELS[item.source] ?? item.source
  const tool = item.toolName ? ` (${item.toolName})` : ""
  const where = item.cwd ? ` in ${path.basename(item.cwd)}` : ""
  emitNervesEvent({
    component: "senses",
    event: "senses.cmux_escalation_built",
    message: "built cmux Feed escalation receipt",
    meta: { agent, kind: item.kind, source: item.source },
  })
  return {
    agent,
    source: "cmux",
    eventType: `feed.${item.kind}`,
    eventId: boundedEventId(item.requestId),
    summary: `${who} is waiting for ${KIND_LABELS[item.kind]}${tool}${where}`,
    evidence: [
      `request_id: ${item.requestId}`,
      `workspace_id: ${surface?.activity.workspaceId ?? "unknown"}`,
      `surface_id: ${surface?.surfaceId ?? "unknown"}`,
      `cwd: ${item.cwd ?? "unknown"}`,
      `created_at: ${item.createdAt ?? "unknown"}`,
      "cmux waits about 120 seconds for a Feed answer, then the agent falls back to its own terminal prompt. Use cmux_overview and cmux_read to see it, and cmux_signal to tell the human.",
    ],
    priority: "high",
  }
}
