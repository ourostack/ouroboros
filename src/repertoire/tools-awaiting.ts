import * as fs from "fs"
import * as path from "path"
import { getAgentRoot, getAgentName } from "../heart/identity"
import { emitNervesEvent } from "../nerves/runtime"
import {
  parseAwaitFile,
  renderAwaitFile,
  type AwaitFile,
  type AwaitMode,
} from "../heart/awaiting/await-parser"
import {
  deliverAwaitAlert,
  type AwaitAlertResult,
} from "../heart/awaiting/await-alert"
import { getInnerDialogPendingDir } from "../mind/pending"
import type { PendingMessage } from "../mind/pending"
import type { ToolDefinition } from "./tools-base"
import type { CrossChatDeliveryDeps } from "../heart/cross-chat-delivery"

/**
 * Bundle-root-relative locations.
 * - `awaiting/<name>.md` — active awaits (status: pending)
 * - `awaiting/.done/<name>.md` — terminal awaits (resolved/expired/canceled)
 */
function awaitingDir(agentRoot: string): string {
  return path.join(agentRoot, "awaiting")
}

function awaitingDoneDir(agentRoot: string): string {
  return path.join(awaitingDir(agentRoot), ".done")
}

function awaitFilePath(agentRoot: string, name: string): string {
  return path.join(awaitingDir(agentRoot), `${name}.md`)
}

function awaitDoneFilePath(agentRoot: string, name: string): string {
  return path.join(awaitingDoneDir(agentRoot), `${name}.md`)
}

const VALID_NAME = /^[A-Za-z0-9_-]+$/

function validateName(name: string): string | null {
  if (!name) return "name is required"
  if (!VALID_NAME.test(name)) return "name must be alphanumeric, underscores, or hyphens"
  return null
}

function readAwaitDefinition(agentRoot: string, name: string): AwaitFile | null {
  const filePath = awaitFilePath(agentRoot, name)
  try {
    const content = fs.readFileSync(filePath, "utf-8")
    return parseAwaitFile(content, filePath)
  } catch {
    return null
  }
}

/**
 * Default delivery deps for the await alert path used from the tool.
 * Mirrors the proactive-outreach pattern: queue to the inner-dialog pending
 * dir when no live deliverer is registered.
 */
function defaultDeliveryDeps(agentName: string): CrossChatDeliveryDeps {
  const pendingDir = getInnerDialogPendingDir(agentName)
  return {
    agentName,
    queuePending: (message: PendingMessage) => {
      // Mirror the write-as-pending convention from tools-session.
      fs.mkdirSync(pendingDir, { recursive: true })
      const filename = `${message.timestamp}-${Math.random().toString(36).slice(2, 10)}.json`
      fs.writeFileSync(path.join(pendingDir, filename), JSON.stringify(message, null, 2), "utf-8")
    },
  }
}

/** Override hook for tests + daemon to inject real channel deliverers. */
export interface AwaitToolDeps {
  /** Override the delivery deps factory (testing or daemon-wired live deliverers). */
  buildDeliveryDeps?: (agentName: string) => CrossChatDeliveryDeps
}

let injected: AwaitToolDeps = {}

export function setAwaitToolDeps(deps: AwaitToolDeps): void {
  injected = deps
}

export function resetAwaitToolDeps(): void {
  injected = {}
}

function resolveDeliveryDeps(agentName: string): CrossChatDeliveryDeps {
  if (injected.buildDeliveryDeps) return injected.buildDeliveryDeps(agentName)
  return defaultDeliveryDeps(agentName)
}

interface FileAwaitArgs {
  name: string
  condition: string
  cadence: string
  alert?: string
  mode?: string
  max_age?: string
  body?: string
}

function fileAwait(args: FileAwaitArgs, agentRoot: string, agentName: string, sessionFriendId: string | null, sessionChannel: string | null): string {
  const nameError = validateName(args.name)
  if (nameError) return JSON.stringify({ error: nameError })

  if (!args.condition || !args.condition.trim()) {
    return JSON.stringify({ error: "condition is required" })
  }
  if (!args.cadence || !args.cadence.trim()) {
    return JSON.stringify({ error: "cadence is required" })
  }

  const filePath = awaitFilePath(agentRoot, args.name)
  if (fs.existsSync(filePath)) {
    return JSON.stringify({ error: `await "${args.name}" already exists` })
  }

  const mode: AwaitMode = args.mode === "quick" ? "quick" : "full"
  const alert = args.alert ?? sessionChannel ?? null

  const frontmatter: Record<string, unknown> = {
    condition: args.condition.trim(),
    cadence: args.cadence.trim(),
    alert,
    mode,
    max_age: args.max_age ?? null,
    status: "pending",
    created_at: new Date().toISOString(),
    filed_from: sessionChannel ?? "unknown",
    filed_for_friend_id: sessionFriendId ?? null,
  }

  const rendered = renderAwaitFile(frontmatter, args.body ?? "")
  fs.mkdirSync(awaitingDir(agentRoot), { recursive: true })
  fs.writeFileSync(filePath, rendered, "utf-8")

  emitNervesEvent({
    component: "repertoire",
    event: "repertoire.await_filed",
    message: "filed new await",
    meta: { agent: agentName, name: args.name, cadence: args.cadence, alert },
  })

  return JSON.stringify({ filed: args.name, path: filePath })
}

function archiveAwait(agentRoot: string, name: string, updates: Record<string, unknown>): { ok: true; file: AwaitFile } | { ok: false; error: string } {
  const source = awaitFilePath(agentRoot, name)
  /* v8 ignore start -- defensive: callers (resolve/cancel) already verify the file exists via readAwaitDefinition; this guards the file-disappears-between-calls race @preserve */
  if (!fs.existsSync(source)) {
    return { ok: false, error: `await "${name}" not found in awaiting/` }
  }
  /* v8 ignore stop */

  const content = fs.readFileSync(source, "utf-8")
  const current = parseAwaitFile(content, source)

  // merge frontmatter from the parsed file with updates
  const merged: Record<string, unknown> = {
    condition: current.condition,
    cadence: current.cadence,
    alert: current.alert,
    mode: current.mode,
    max_age: current.max_age,
    status: current.status,
    created_at: current.created_at,
    filed_from: current.filed_from,
    filed_for_friend_id: current.filed_for_friend_id,
    ...updates,
  }

  const rendered = renderAwaitFile(merged, current.body)
  fs.mkdirSync(awaitingDoneDir(agentRoot), { recursive: true })
  fs.writeFileSync(awaitDoneFilePath(agentRoot, name), rendered, "utf-8")
  fs.unlinkSync(source)

  // re-parse the archived file so callers see merged fields (e.g. resolution_observation)
  const archivedContent = fs.readFileSync(awaitDoneFilePath(agentRoot, name), "utf-8")
  const archived = parseAwaitFile(archivedContent, awaitDoneFilePath(agentRoot, name))
  return { ok: true, file: archived }
}

async function resolveAwaitTool(name: string, verdict: string, observation: string, agentRoot: string, agentName: string): Promise<string> {
  const nameError = validateName(name)
  if (nameError) return JSON.stringify({ error: nameError })

  const existing = readAwaitDefinition(agentRoot, name)
  if (!existing) {
    return JSON.stringify({ error: `await "${name}" not found in awaiting/` })
  }
  if (existing.status !== "pending") {
    return JSON.stringify({ error: `await "${name}" is not pending (status: ${existing.status})` })
  }

  if (verdict !== "yes" && verdict !== "no") {
    return JSON.stringify({ error: "verdict must be 'yes' or 'no'" })
  }

  if (!observation || !observation.trim()) {
    return JSON.stringify({ error: "observation is required" })
  }

  if (verdict === "no") {
    // Update runtime state via recordAwaitCheck-style write
    const { recordAwaitCheck } = await import("../heart/awaiting/await-runtime-state")
    recordAwaitCheck(agentRoot, name, observation.trim(), new Date().toISOString())
    emitNervesEvent({
      component: "repertoire",
      event: "repertoire.await_check_no",
      message: "await checked, not yet ready",
      meta: { agent: agentName, name },
    })
    return JSON.stringify({ verdict: "no", recorded: true })
  }

  // verdict === "yes" — archive and alert
  const archive = archiveAwait(agentRoot, name, {
    status: "resolved",
    resolved_at: new Date().toISOString(),
    resolution_observation: observation.trim(),
  })
  /* v8 ignore next -- defensive: archiveAwait only fails on the file-disappears-mid-call race already covered by v8 ignore inside archiveAwait @preserve */
  if (!archive.ok) return JSON.stringify({ error: archive.error })

  emitNervesEvent({
    component: "repertoire",
    event: "repertoire.await_resolved",
    message: "await resolved",
    meta: { agent: agentName, name },
  })

  let alert: AwaitAlertResult | null = null
  try {
    alert = await deliverAwaitAlert({
      awaitFile: archive.file,
      reason: "resolved",
      observation: observation.trim(),
      agentRoot,
      agentName,
      deliveryDeps: resolveDeliveryDeps(agentName),
    })
  } catch (error) {
    emitNervesEvent({
      level: "error",
      component: "repertoire",
      event: "repertoire.await_alert_error",
      message: "await alert delivery threw",
      meta: { agent: agentName, name, error: error instanceof Error ? error.message : String(error) },
    })
  }

  return JSON.stringify({
    verdict: "yes",
    archived: awaitDoneFilePath(agentRoot, name),
    alert: alert ? { attempted: alert.attempted, status: alert.delivery?.status ?? null, skipped: alert.skipped ?? null } : null,
  })
}

function cancelAwaitTool(name: string, reason: string | undefined, agentRoot: string, agentName: string): string {
  const nameError = validateName(name)
  if (nameError) return JSON.stringify({ error: nameError })

  const existing = readAwaitDefinition(agentRoot, name)
  if (!existing) {
    return JSON.stringify({ error: `await "${name}" not found in awaiting/` })
  }
  if (existing.status !== "pending") {
    return JSON.stringify({ error: `await "${name}" is not pending (status: ${existing.status})` })
  }

  const updates: Record<string, unknown> = {
    status: "canceled",
    canceled_at: new Date().toISOString(),
  }
  if (reason && reason.trim()) {
    updates.cancel_reason = reason.trim()
  }

  const archive = archiveAwait(agentRoot, name, updates)
  /* v8 ignore next -- defensive: archiveAwait only fails on the file-disappears-mid-call race already covered by v8 ignore inside archiveAwait @preserve */
  if (!archive.ok) return JSON.stringify({ error: archive.error })

  emitNervesEvent({
    component: "repertoire",
    event: "repertoire.await_canceled",
    message: "await canceled",
    meta: { agent: agentName, name },
  })

  return JSON.stringify({ canceled: name, archived: awaitDoneFilePath(agentRoot, name) })
}

export const awaitingToolDefinitions: ToolDefinition[] = [
  {
    tool: {
      type: "function",
      function: {
        name: "await_condition",
        description: "File a one-shot waiting condition. The daemon polls on cadence; on each tick I evaluate the condition and call resolve_await. When the condition becomes true, an alert fires via my outward channel.",
        parameters: {
          type: "object",
          properties: {
            name: { type: "string", description: "Filename stem (alphanumeric/underscore/hyphen). Must be unique." },
            condition: { type: "string", description: "Natural-language condition to watch for." },
            cadence: { type: "string", description: "Polling cadence (e.g. '5m', '1h')." },
            alert: { type: "string", description: "Channel to alert on (e.g. 'bluebubbles', 'teams'). Defaults to filing session's channel." },
            mode: { type: "string", description: "'full' or 'quick'. Defaults 'full'." },
            max_age: { type: "string", description: "Optional auto-expiry (e.g. '24h')." },
            body: { type: "string", description: "Optional notes: why I filed this, what 'ready' looks like." },
          },
          required: ["name", "condition", "cadence"],
        },
      },
    },
    handler: (a, ctx) => {
      const agentRoot = getAgentRoot()
      const agentName = getAgentName()
      return fileAwait(
        {
          name: a.name,
          condition: a.condition,
          cadence: a.cadence,
          alert: a.alert,
          mode: a.mode,
          max_age: a.max_age,
          body: a.body,
        },
        agentRoot,
        agentName,
        ctx?.currentSession?.friendId ?? null,
        ctx?.currentSession?.channel ?? null,
      )
    },
  },
  {
    tool: {
      type: "function",
      function: {
        name: "resolve_await",
        description: "Resolve a pending await with a verdict. verdict='yes' archives and fires the alert. verdict='no' records the observation and continues polling.",
        parameters: {
          type: "object",
          properties: {
            name: { type: "string", description: "Await name (filename stem)." },
            verdict: { type: "string", description: "'yes' if the condition is met, 'no' otherwise." },
            observation: { type: "string", description: "One-line summary of what I saw this tick." },
          },
          required: ["name", "verdict", "observation"],
        },
      },
    },
    handler: async (a) => {
      const agentRoot = getAgentRoot()
      const agentName = getAgentName()
      return resolveAwaitTool(a.name, a.verdict, a.observation, agentRoot, agentName)
    },
  },
  {
    tool: {
      type: "function",
      function: {
        name: "cancel_await",
        description: "Cancel a pending await without alerting. Archives with status: canceled.",
        parameters: {
          type: "object",
          properties: {
            name: { type: "string", description: "Await name (filename stem)." },
            reason: { type: "string", description: "Optional cancel reason." },
          },
          required: ["name"],
        },
      },
    },
    handler: (a) => {
      const agentRoot = getAgentRoot()
      const agentName = getAgentName()
      return cancelAwaitTool(a.name, a.reason, agentRoot, agentName)
    },
  },
]
