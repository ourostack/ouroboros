import * as fs from "fs"
import * as path from "path"
import { getAgentRoot, getAgentName } from "../heart/identity"
import { capStructuredRecordString } from "../heart/session-events"
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
import { getPrivateRuntimePendingDir } from "../mind/pending"
import type { PendingMessage } from "../mind/pending"
import type { ToolDefinition } from "./tools-base"
import type { CrossChatDeliveryDeps } from "../heart/cross-chat-delivery"
import { advanceExternalEventFromAwait, getExternalEventRoot, listExternalEventStatus, readExternalEventRecord } from "../heart/external-events/router"
import { advanceObligation, createObligation, fulfillObligation, readVerifiedPendingObligations } from "../arc/obligations"
import { parseCadenceToMs } from "../heart/daemon/cadence"

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

export function readAwaitDefinition(agentRoot: string, name: string): AwaitFile | null {
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
 * Mirrors the proactive-outreach pattern: queue to the private-runtime pending
 * dir when no live deliverer is registered.
 */
function defaultDeliveryDeps(agentName: string): CrossChatDeliveryDeps {
  const pendingDir = getPrivateRuntimePendingDir(agentName)
  return {
    agentName,
    queuePending: (message: PendingMessage) => {
      // Mirror the write-as-pending convention from tools-session.
      fs.mkdirSync(pendingDir, { recursive: true })
      const filename = `${message.timestamp}-${Math.random().toString(36).slice(2, 10)}.json`
      fs.writeFileSync(
        path.join(pendingDir, filename),
        JSON.stringify({ ...message, content: capStructuredRecordString(message.content) }, null, 2),
        "utf-8",
      )
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
  wake_at?: string
  body?: string
}

function fileAwait(args: FileAwaitArgs, agentRoot: string, agentName: string, sessionFriendId: string | null, sessionChannel: string | null, sessionKey: string | null, requestId: string | null): string {
  const nameError = validateName(args.name)
  if (nameError) return JSON.stringify({ error: nameError })

  if (!args.condition || !args.condition.trim()) {
    return JSON.stringify({ error: "condition is required" })
  }
  if (!args.cadence || !args.cadence.trim()) {
    return JSON.stringify({ error: "cadence is required" })
  }
  if (args.wake_at && (!Number.isFinite(Date.parse(args.wake_at)) || new Date(args.wake_at).toISOString() !== args.wake_at)) {
    return JSON.stringify({ error: "wake_at must be a canonical ISO timestamp" })
  }

  const filePath = awaitFilePath(agentRoot, args.name)
  if (fs.existsSync(filePath)) {
    return JSON.stringify({ error: `await "${args.name}" already exists` })
  }

  const mode: AwaitMode = args.mode === "quick" ? "quick" : "full"
  const alert = sessionChannel === "external-event" ? null : args.alert ?? sessionChannel ?? null

  const frontmatter: Record<string, unknown> = {
    condition: capStructuredRecordString(args.condition.trim()),
    cadence: capStructuredRecordString(args.cadence.trim()),
    alert,
    mode,
    max_age: typeof args.max_age === "string" ? capStructuredRecordString(args.max_age) : null,
    wake_at: typeof args.wake_at === "string" ? capStructuredRecordString(args.wake_at) : null,
    status: "pending",
    created_at: new Date().toISOString(),
    filed_from: sessionChannel ?? "unknown",
    filed_for_friend_id: sessionFriendId ?? null,
    filed_from_key: sessionKey,
    request_id: requestId,
  }
  let obligationId: string | null = null
  if (requestId && sessionFriendId && sessionChannel && sessionKey) {
    const obligation = createObligation(agentRoot, {
      origin: { friendId: sessionFriendId, channel: sessionChannel, key: sessionKey },
      owedTo: { friendId: sessionFriendId, channel: sessionChannel, key: sessionKey },
      requestId,
      content: args.condition.trim(),
    })
    advanceObligation(agentRoot, obligation.id, {
      currentSurface: { kind: "session", label: `${sessionChannel}/${sessionKey}` },
      currentArtifact: `awaiting/${args.name}.md`,
      nextAction: args.condition.trim(),
    })
    obligationId = obligation.id
    frontmatter.obligation_id = obligation.id
  }
  const rendered = renderAwaitFile(frontmatter, capStructuredRecordString(args.body ?? ""))
  fs.mkdirSync(awaitingDir(agentRoot), { recursive: true })
  try {
    fs.writeFileSync(filePath, rendered, "utf-8")
  } catch (error) {
    if (obligationId) fulfillObligation(agentRoot, obligationId)
    throw error
  }

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
    wake_at: current.wake_at ?? null,
    status: current.status,
    created_at: current.created_at,
    filed_from: current.filed_from,
    filed_for_friend_id: current.filed_for_friend_id,
    filed_from_key: current.filed_from_key,
    request_id: current.request_id,
    obligation_id: current.obligation_id,
    ...updates,
  }

  const cappedMerged = Object.fromEntries(Object.entries(merged).map(([key, value]) => [
    key,
    typeof value === "string" ? capStructuredRecordString(value) : value,
  ]))
  const rendered = renderAwaitFile(cappedMerged, capStructuredRecordString(current.body))
  fs.mkdirSync(awaitingDoneDir(agentRoot), { recursive: true })
  fs.writeFileSync(awaitDoneFilePath(agentRoot, name), rendered, "utf-8")
  fs.unlinkSync(source)

  // re-parse the archived file so callers see merged fields (e.g. resolution_observation)
  const archivedContent = fs.readFileSync(awaitDoneFilePath(agentRoot, name), "utf-8")
  const archived = parseAwaitFile(archivedContent, awaitDoneFilePath(agentRoot, name))
  return { ok: true, file: archived }
}

function fulfillAwaitObligation(agentRoot: string, awaitFile: AwaitFile): void {
  if (awaitFile.obligation_id) fulfillObligation(agentRoot, awaitFile.obligation_id)
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

  // Request-bound returns stay active through Telegram prepare/send authorization.
  let alert: AwaitAlertResult | null = null
  if (existing.request_id && existing.filed_from !== "external-event") {
    try {
      alert = await deliverAwaitAlert({ awaitFile: existing, reason: "resolved", observation: observation.trim(), agentRoot, agentName, deliveryDeps: resolveDeliveryDeps(agentName) })
    } catch (error) {
      emitNervesEvent({ level: "error", component: "repertoire", event: "repertoire.await_alert_error", message: "await alert delivery threw", meta: { agent: agentName, name, error: error instanceof Error ? error.message : String(error) } })
    }
    if (alert?.delivery?.status !== "delivered_now") {
      return JSON.stringify({ verdict: "yes", archived: null, alert: alert ? { attempted: alert.attempted, status: alert.delivery?.status ?? null, skipped: alert.skipped ?? null } : null, advancedExternalEvents: [] })
    }
  }

  const advancedEvents = existing.filed_from === "external-event" && existing.filed_from_key && existing.wake_at
    ? (() => {
        if (!hasActiveExternalEventAwait(agentName, { recordPath: existing.filed_from_key!, awaitName: name, wakeAt: existing.wake_at! })) throw new Error("External event await authority changed before resolution")
        const record = readExternalEventRecord(existing.filed_from_key!)
        if (record.agent !== agentName || record.recordPath !== existing.filed_from_key || record.executionState !== "handled"
          || record.disposition?.awaitId !== name || record.disposition.nextWake.kind !== "at" || record.disposition.nextWake.at !== existing.wake_at) {
          throw new Error("External event await authority changed before resolution")
        }
        return [advanceExternalEventFromAwait(record.recordPath, { awaitId: name, expectedVersion: record.version, expectedGeneration: record.generation })]
      })()
    : []
  const archive = archiveAwait(agentRoot, name, {
    status: "resolved",
    resolved_at: new Date().toISOString(),
    resolution_observation: observation.trim(),
  })
  /* v8 ignore next -- defensive: archiveAwait only fails on the file-disappears-mid-call race already covered by v8 ignore inside archiveAwait @preserve */
  if (!archive.ok) return JSON.stringify({ error: archive.error })
  fulfillAwaitObligation(agentRoot, archive.file)

  emitNervesEvent({
    component: "repertoire",
    event: "repertoire.await_resolved",
    message: "await resolved",
    meta: { agent: agentName, name },
  })

  if (!existing.request_id) {
    try {
      alert = await deliverAwaitAlert({ awaitFile: archive.file, reason: "resolved", observation: observation.trim(), agentRoot, agentName, deliveryDeps: resolveDeliveryDeps(agentName) })
    } catch (error) {
      emitNervesEvent({ level: "error", component: "repertoire", event: "repertoire.await_alert_error", message: "await alert delivery threw", meta: { agent: agentName, name, error: error instanceof Error ? error.message : String(error) } })
    }
  }

  return JSON.stringify({
    verdict: "yes",
    archived: awaitDoneFilePath(agentRoot, name),
    alert: alert ? { attempted: alert.attempted, status: alert.delivery?.status ?? null, skipped: alert.skipped ?? null } : null,
    advancedExternalEvents: advancedEvents.map((event) => event.recordPath),
  })
}

export function cancelAwaitTool(name: string, reason: string | undefined, agentRoot: string, agentName: string): string {
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
  fulfillAwaitObligation(agentRoot, archive.file)

  emitNervesEvent({
    component: "repertoire",
    event: "repertoire.await_canceled",
    message: "await canceled",
    meta: { agent: agentName, name },
  })

  return JSON.stringify({ canceled: name, archived: awaitDoneFilePath(agentRoot, name) })
}

export function hasActiveRelationshipFollowUp(agentRoot: string, input: { friendId: string; channel: string; key: string; requestId: string; awaitName?: string; allowElapsed?: boolean; now?: number }): boolean {
  const obligation = readVerifiedPendingObligations(agentRoot).find((candidate) => candidate.requestId === input.requestId
    && candidate.origin.friendId === input.friendId && candidate.origin.channel === input.channel && candidate.origin.key === input.key
    && candidate.owedTo?.friendId === input.friendId && candidate.owedTo.channel === input.channel && candidate.owedTo.key === input.key
    && candidate.currentArtifact?.startsWith("awaiting/") && candidate.currentArtifact.endsWith(".md")
    && (!input.awaitName || candidate.currentArtifact === `awaiting/${input.awaitName}.md`))
  if (!obligation) return false
  const name = path.basename(obligation.currentArtifact!, ".md")
  if (!VALID_NAME.test(name) || obligation.currentArtifact !== `awaiting/${name}.md`) return false
  const awaiting = readAwaitDefinition(agentRoot, name)
  if (!awaiting || awaiting.status !== "pending" || awaiting.obligation_id !== obligation.id || awaiting.request_id !== input.requestId
    || awaiting.filed_for_friend_id !== input.friendId || awaiting.filed_from !== input.channel || awaiting.filed_from_key !== input.key) return false
  const maxAge = parseCadenceToMs(awaiting.max_age)
  return input.allowElapsed === true || maxAge === null || !awaiting.created_at || (input.now ?? Date.now()) < Date.parse(awaiting.created_at) + maxAge
}

export function hasActiveExternalEventAwait(agentName: string, input: { recordPath: string; awaitName: string; wakeAt: string }, root = getExternalEventRoot()): boolean {
  const matches = listExternalEventStatus(root).filter((status) => !status.corrupt
    && status.agent === agentName && status.executionState === "handled" && status.awaitId === input.awaitName)
  return matches.length === 1 && matches[0]!.recordPath === input.recordPath
    && matches[0]!.nextWake?.kind === "at" && matches[0]!.nextWake.at === input.wakeAt
}

export function cancelRelationshipFollowUps(agentRoot: string, agentName: string, input: { friendId: string; channel: string; key: string }): void {
  const obligations = readVerifiedPendingObligations(agentRoot).filter((candidate) => candidate.owedTo?.friendId === input.friendId
    && candidate.owedTo.channel === input.channel && candidate.owedTo.key === input.key)
  for (const obligation of obligations) {
    const artifact = obligation.currentArtifact
    const name = artifact?.startsWith("awaiting/") && artifact.endsWith(".md") ? path.basename(artifact, ".md") : null
    if (name && VALID_NAME.test(name) && artifact === `awaiting/${name}.md` && readAwaitDefinition(agentRoot, name)) {
      cancelAwaitTool(name, "relationship revoked", agentRoot, agentName)
    } else {
      fulfillObligation(agentRoot, obligation.id)
    }
  }
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
            wake_at: { type: "string", description: "Optional exact canonical ISO time this Await supports." },
            body: { type: "string", description: "Optional notes: why I filed this, what 'ready' looks like." },
          },
          required: ["name", "condition", "cadence"],
        },
      },
    },
    handler: (a, ctx) => {
      const agentRoot = getAgentRoot()
      const agentName = getAgentName()
      const event = ctx?.currentExternalEvent
      const eventFriendId = event ? ctx?.context?.friend.id ?? null : null
      if (event && !eventFriendId) return JSON.stringify({ error: "external event await authority has no exact owner relationship" })
      return fileAwait(
        {
          name: a.name,
          condition: a.condition,
          cadence: a.cadence,
          alert: a.alert,
          mode: a.mode,
          max_age: a.max_age,
          wake_at: a.wake_at,
          body: a.body,
        },
        agentRoot,
        agentName,
        eventFriendId ?? ctx?.currentSession?.friendId ?? null,
        event ? "external-event" : ctx?.currentSession?.channel ?? null,
        event ? event.recordPath : ctx?.currentSession?.key ?? null,
        event ? null : ctx?.relationshipAuthorization?.requestId ?? null,
      )
    },
    riskProfile: { mutates: "durable_state_write", risk: "high", reason: "files a durable await condition" },
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
    handler: async (a, ctx) => {
      const agentRoot = getAgentRoot()
      const agentName = getAgentName()
      if (ctx?.relationshipAuthorization) {
        const session = ctx.currentSession
        const requestId = ctx.relationshipAuthorization.requestId
        const existing = readAwaitDefinition(agentRoot, String(a.name ?? ""))
        const externalEventAuthorized = session?.channel === "external-event" && !!existing?.wake_at
          && hasActiveExternalEventAwait(agentName, { recordPath: session.key, awaitName: String(a.name ?? ""), wakeAt: existing.wake_at })
        if (!externalEventAuthorized && (!session || !requestId || !hasActiveRelationshipFollowUp(agentRoot, {
          friendId: session.friendId,
          channel: session.channel,
          key: session.key,
          requestId,
          awaitName: String(a.name ?? ""),
        }))) return JSON.stringify({ error: "resolve_await is limited to the current relationship request or bound external event" })
      }
      return resolveAwaitTool(a.name, a.verdict, a.observation, agentRoot, agentName)
    },
    riskProfile: {
      mutates: ["durable_state_write", "external_side_effect"] as const,
      risk: "high",
      reason: "records await observations and may deliver an alert",
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
    handler: (a, ctx) => {
      const agentRoot = getAgentRoot()
      const agentName = getAgentName()
      if (ctx?.relationshipAuthorization) {
        const session = ctx.currentSession
        const requestId = ctx.relationshipAuthorization.requestId
        if (!session || !requestId || !hasActiveRelationshipFollowUp(agentRoot, {
          friendId: session.friendId,
          channel: session.channel,
          key: session.key,
          requestId,
          awaitName: String(a.name ?? ""),
        })) return JSON.stringify({ error: "cancel_await is limited to the current relationship request" })
      }
      return cancelAwaitTool(a.name, a.reason, agentRoot, agentName)
    },
    riskProfile: { mutates: "durable_state_write", risk: "high", reason: "archives a durable await condition" },
  },
]
