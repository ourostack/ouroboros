import * as fs from "node:fs"
import * as path from "node:path"
import { getAgentName, getAgentRoot, loadAgentConfig } from "../heart/identity"
import { getExternalEventRoot, listExternalEventStatus, type ExternalEventStatus } from "../heart/external-events/router"
import { readRoutineActionReceipts, readStewardPolicy, type RoutineActionReceipt, type StewardPolicyRecord } from "../heart/steward-policy"
import { parseAwaitFile, type AwaitFile } from "../heart/awaiting/await-parser"
import { getDefaultHealthPath, readHealth, type DaemonHealthState } from "../heart/daemon/daemon-health"
import { readSenseStatusLines } from "../heart/turn-context"
import { FileTelegramEffectJournal, type TelegramEffectPartState } from "../senses/telegram-effect-adapter"
import { FileTelegramAdmissionStore, type TelegramAdmissionStatus } from "../senses/telegram-admission"
import { readSanctuaryHealthState, type HealthState } from "../senses/sanctuary-health"
import { readRunLedger, type RunLedgerRecord } from "../heart/run-ledger"
import { emitNervesEvent } from "../nerves/runtime"

// The Butler's operational status, which query_active_work adds after the live world-state for the Butler (J7): its
// house health, steward policy, routine actions, awaits, Telegram effects and admissions, events and provider lanes.
// The Butler's product loads this module when the tool is called, not with the product.

export interface ButlerOperationalVisibility {
  agentName: string
  externalEvents: ExternalEventStatus[]
  stewardPolicy: StewardPolicyRecord
  awaits: AwaitFile[]
  telegramEffects: Array<{ id: string; authorClass: string; targetKind: string; state: TelegramEffectPartState; acceptedAt?: string | null; sessionRecordedAt?: string | null; messageIds?: number[]; sessionEventIds?: string[]; updatedAt: string }>
  telegramAdmissions: Array<{ id: string; status: TelegramAdmissionStatus; displayCode: string; createdAt: number; expiresAt: number }>
  daemonHealth: DaemonHealthState | null
  healthState?: HealthState
  routineActions?: RoutineActionReceipt[]
  providerLanes?: { outward: { provider: string; model: string }; inner: { provider: string; model: string } } | null
  lastAutomatedEventRun?: RunLedgerRecord | null
  senseStatusLines: string[]
  sourceErrors: Partial<Record<"external_events" | "awaits" | "telegram_effects" | "telegram_admissions" | "daemon_health" | "health_state" | "routine_actions" | "run_ledger" | "provider" | "senses" | "steward_policy", string>>
}

function boundedStatusText(value: string, max = 180): string {
  const normalized = value.replace(/\s+/g, " ").trim()
  return normalized.length <= max ? normalized : `${normalized.slice(0, max - 3)}...`
}

export function readButlerOperationalVisibility(agentRoot = getAgentRoot(), agentName = getAgentName()): ButlerOperationalVisibility {
  const sourceErrors: ButlerOperationalVisibility["sourceErrors"] = {}
  const read = <T>(source: keyof ButlerOperationalVisibility["sourceErrors"], operation: () => T, fallback: T): T => {
    try { return operation() } catch (error) {
      sourceErrors[source] = boundedStatusText(error instanceof Error ? error.message : String(error)) || "unknown read failure"
      return fallback
    }
  }
  const awaitsDir = path.join(agentRoot, "awaiting")
  const awaits = read("awaits", () => fs.existsSync(awaitsDir) ? fs.readdirSync(awaitsDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .map((entry) => {
      const filePath = path.join(awaitsDir, entry.name)
      return parseAwaitFile(fs.readFileSync(filePath, "utf8"), filePath)
    })
    .filter((entry) => entry.status === "pending") : [], [])
  const effectsRoot = path.join(agentRoot, "state", "telegram", "effects")
  const telegramEffects = read("telegram_effects", () => {
    if (!fs.existsSync(effectsRoot)) throw new Error("Telegram effect journal has not been created yet")
    const journal = new FileTelegramEffectJournal(effectsRoot)
    try {
      return journal.list().map((artifact) => ({
        id: artifact.id,
        authorClass: artifact.authorClass,
        targetKind: artifact.target.kind,
        state: artifact.parts.some((part) => part.state === "indeterminate") ? "indeterminate" as const
          : artifact.parts.some((part) => part.state === "attempting") ? "attempting" as const
            : artifact.parts.every((part) => part.state === "session_recorded") ? "session_recorded" as const
              : artifact.parts.some((part) => part.state === "accepted") ? "accepted" as const
                : "prepared" as const,
        acceptedAt: artifact.parts.flatMap((part) => part.acceptedAt ? [part.acceptedAt] : []).sort().at(-1) ?? null,
        sessionRecordedAt: artifact.parts.flatMap((part) => part.sessionRecordedAt ? [part.sessionRecordedAt] : []).sort().at(-1) ?? null,
        messageIds: artifact.parts.flatMap((part) => part.messageId ? [part.messageId] : []),
        sessionEventIds: artifact.parts.flatMap((part) => part.sessionEventId ? [part.sessionEventId] : []),
        updatedAt: artifact.updatedAt,
      }))
    } finally { journal.close() }
  }, [])
  const admissionsRoot = path.join(agentRoot, "state", "senses", "telegram", "admissions")
  const telegramAdmissions = read("telegram_admissions", () => {
    if (!fs.existsSync(admissionsRoot)) throw new Error("Telegram admission store has not been created yet")
    const store = new FileTelegramAdmissionStore(admissionsRoot)
    try {
      return store.list().map((record) => ({ id: record.id, status: record.status, displayCode: record.displayCode, createdAt: record.createdAt, expiresAt: record.expiresAt }))
    } finally { store.close() }
  }, [])
  const status: ButlerOperationalVisibility = {
    agentName,
    externalEvents: read("external_events", () => listExternalEventStatus(getExternalEventRoot()).filter((event) => event.agent === agentName), []),
    stewardPolicy: read("steward_policy", () => readStewardPolicy(agentRoot), { schemaVersion: 1, version: 0, desiredStates: {}, routineActionGrants: {}, updatedAt: null }),
    awaits,
    telegramEffects,
    telegramAdmissions,
    daemonHealth: read("daemon_health", () => {
      const health = readHealth(getDefaultHealthPath())
      if (!health) throw new Error("daemon health is missing or invalid")
      return health
    }, null),
    healthState: read("health_state", () => readSanctuaryHealthState(path.join(agentRoot, "state", "health", "sanctuary-health.json")), undefined),
    routineActions: read("routine_actions", () => readRoutineActionReceipts(agentRoot), []),
    providerLanes: read("provider", () => {
      const config = loadAgentConfig()
      if (!config.humanFacing || !config.agentFacing) throw new Error("provider lanes are unavailable")
      return { outward: config.humanFacing, inner: config.agentFacing }
    }, null),
    lastAutomatedEventRun: read("run_ledger", () => readRunLedger(agentRoot)
      .filter((row) => row.sourceKind === "private-runtime" && row.senseOrHabit === "external-event" && row.lifecycle === "completed")
      .sort((left, right) => (right.endedAt ?? right.recordedAt).localeCompare(left.endedAt ?? left.recordedAt))[0] ?? null, null),
    senseStatusLines: read("senses", () => readSenseStatusLines(), []),
    sourceErrors,
  }
  emitNervesEvent({ component: "tools", event: "tool.butler_status_read", message: "read the Butler's operational status", meta: { agentName, unavailable: Object.keys(sourceErrors) } })
  return status
}

export type ButlerVisibilitySection = "all" | "health" | "policy" | "awaits" | "telegram" | "events" | "actions" | "provider"

export function formatButlerOperationalVisibility(status: ButlerOperationalVisibility, options: { section?: ButlerVisibilitySection; offset?: number; limit?: number } = {}): string {
  const section = options.section ?? "all"
  const offset = Math.max(0, options.offset ?? 0)
  const limit = Math.min(20, Math.max(1, options.limit ?? 10))
  const show = (wanted: Exclude<ButlerVisibilitySection, "all">) => section === "all" || section === wanted
  const page = <T>(rows: T[]) => rows.slice(offset, offset + limit)
  const more = (label: string, total: number) => total > offset + limit ? `  - ${total - offset - limit} more ${label}; call query_active_work with section=${label}, offset=${offset + limit}, limit=${limit}` : null
  const daemon = status.daemonHealth
  const agentHealth = daemon?.agents[status.agentName]
  const lines = ["## butler operational visibility"]
  const error = (source: keyof ButlerOperationalVisibility["sourceErrors"]) => status.sourceErrors[source] ? `unavailable (${status.sourceErrors[source]})` : null
  if (show("health")) {
    lines.push(`- daemon: ${error("daemon_health") ?? daemon?.status ?? "unavailable"}${daemon ? `; mode ${daemon.mode}; pid ${daemon.pid}` : ""}`)
    lines.push(`- butler: ${agentHealth ? `${agentHealth.status}; pid ${agentHealth.pid ?? "none"}; crashes ${agentHealth.crashes}` : "unavailable"}`)
    lines.push("- senses:")
    lines.push(...(error("senses") ? [`  - ${error("senses")}`] : status.senseStatusLines.length > 0 ? status.senseStatusLines.map((line) => `  ${line}`) : ["  - unavailable"]))
    const health = status.healthState
    lines.push(`- health sweeps: ${error("health_state") ?? health?.sweepReceipts.length ?? 0}; delivered ${health?.deliveredReceipts.length ?? 0}; indeterminate ${health?.indeterminateDeliveries.length ?? 0}; outbox ${health?.outbox ? `${health.outbox.status}:${health.outbox.id}` : "clear"}; open incidents ${health ? Object.keys(health.incidents).length : 0}; updated ${health?.updatedAt ?? "unavailable"}`)
    const healthRows = [
      ...(health?.sweepReceipts ?? []).map((sweep) => ({ at: sweep.completedAt, text: `sweep ${sweep.sweepId}: opened ${sweep.opened}; recovered ${sweep.recovered}; completed ${sweep.completedAt}${sweep.deliveryId ? `; delivery ${sweep.deliveryId}` : ""}` })),
      ...(health?.deliveredReceipts ?? []).map((delivery) => ({ at: delivery.deliveredAt, text: `delivered ${delivery.deliveryId}: ${delivery.kind}; messages ${delivery.messageIds.join(",")}; at ${delivery.deliveredAt}` })),
      ...(health?.indeterminateDeliveries ?? []).map((delivery) => ({ at: delivery.createdAt, text: `indeterminate ${delivery.id}: ${delivery.kind}; ${delivery.status}; created ${delivery.createdAt}` })),
    ].sort((a, b) => b.at.localeCompare(a.at))
    for (const row of page(healthRows)) lines.push(`  - ${row.text}`)
    const overflow = more("health", healthRows.length); if (overflow) lines.push(overflow)
  }
  if (show("provider")) lines.push(`- provider lanes: ${error("provider") ?? (status.providerLanes ? `outward ${status.providerLanes.outward.provider}/${status.providerLanes.outward.model}; inner ${status.providerLanes.inner.provider}/${status.providerLanes.inner.model}` : "unavailable")}`)
  if (show("policy")) {
    lines.push(`- steward policy: ${error("steward_policy") ?? `version ${status.stewardPolicy.version}; ${Object.keys(status.stewardPolicy.desiredStates).length} desired states; ${Object.keys(status.stewardPolicy.routineActionGrants).length} routine grants`}`)
    const entries = [...Object.entries(status.stewardPolicy.desiredStates).map(([key, value]) => ({ key, kind: "desired" as const, value })), ...Object.entries(status.stewardPolicy.routineActionGrants).map(([key, value]) => ({ key, kind: "grant" as const, value }))]
    for (const entry of page(entries)) {
      const expiry = entry.value.expiresAt
      const active = !expiry || Date.parse(expiry) > Date.now()
      lines.push(entry.kind === "desired" ? `  - ${entry.key} = ${boundedStatusText(entry.value.value)}; ${active ? "active" : "expired"}; ${entry.value.provenance}; source ${boundedStatusText(entry.value.source)}; v${entry.value.version}${expiry ? `; expires ${expiry}` : ""}` : `  - ${entry.key}: ${entry.value.action} on ${entry.value.targets.join(", ")}; ${active ? "active" : "expired"}; max ${entry.value.maxCount}/${entry.value.windowMs}ms; ${entry.value.verificationRequired ? "verification required" : "no verification"}; v${entry.value.version}${expiry ? `; expires ${expiry}` : ""}`)
    }
    const overflow = more("policy", entries.length); if (overflow) lines.push(overflow)
  }
  if (show("actions")) {
    const actions = [...(status.routineActions ?? [])].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    lines.push(`- routine action receipts: ${error("routine_actions") ?? actions.length}`)
    for (const action of page(actions)) {
      const verification = action.state === "verified" ? `verified ${action.verifiedAfterState ?? "state unavailable"}` : action.state === "failed" ? "failed" : action.state === "indeterminate" ? "indeterminate; manual inspection required" : action.state === "recovered_no_effect" ? "no effect occurred" : "pending"
      lines.push(`  - ${action.id}: ${action.action} ${action.target}; ${action.state}; updated ${action.updatedAt}; verification ${verification}`)
    }
    const overflow = more("actions", actions.length); if (overflow) lines.push(overflow)
  }
  if (show("awaits")) {
    lines.push(`- pending awaits: ${status.awaits.length}`); if (error("awaits")) lines.push(`  - ${error("awaits")}`)
    for (const pending of page(status.awaits)) lines.push(`  - ${pending.name}: ${boundedStatusText(pending.condition ?? (pending.body || "condition unavailable"))}${pending.wake_at ? `; wake ${pending.wake_at}` : ""}`)
    const overflow = more("awaits", status.awaits.length); if (overflow) lines.push(overflow)
  }
  if (show("telegram")) {
    const acceptedTimes = status.telegramEffects.flatMap((effect) => effect.acceptedAt ? [effect.acceptedAt] : []).sort().reverse()
    const recordedTimes = status.telegramEffects.flatMap((effect) => effect.sessionRecordedAt ? [effect.sessionRecordedAt] : []).sort().reverse()
    const legacyAccepted = status.telegramEffects.some((effect) => !effect.acceptedAt && (effect.state === "accepted" || effect.state === "session_recorded"))
    const legacyRecorded = status.telegramEffects.some((effect) => !effect.sessionRecordedAt && effect.state === "session_recorded")
    lines.push(`- latest Telegram accepted: ${acceptedTimes[0] ?? (legacyAccepted ? "timestamp unavailable (legacy artifacts present)" : "none")}; latest session recorded: ${recordedTimes[0] ?? (legacyRecorded ? "timestamp unavailable (legacy artifacts present)" : "none")}`)
    lines.push(`- Telegram effects: ${error("telegram_effects") ?? status.telegramEffects.length}`)
    lines.push(`- Telegram admissions: ${error("telegram_admissions") ?? status.telegramAdmissions.length}`)
    const telegramRows = [
      ...status.telegramEffects.map((effect) => ({ at: effect.updatedAt, effect })),
      ...status.telegramAdmissions.map((admission) => ({ at: new Date(admission.createdAt).toISOString(), admission })),
    ].sort((a, b) => b.at.localeCompare(a.at))
    for (const row of page(telegramRows)) {
      if ("admission" in row) {
        const admission = row.admission
        lines.push(`  - admission ${admission.id}: ${admission.status}; code ${admission.displayCode}; expires ${new Date(admission.expiresAt).toISOString()}`)
        continue
      }
      const effect = row.effect
      const accepted = effect.acceptedAt ?? ((effect.state === "accepted" || effect.state === "session_recorded") ? "timestamp unavailable (legacy)" : "not accepted")
      const recorded = effect.sessionRecordedAt ?? (effect.state === "session_recorded" ? "timestamp unavailable (legacy)" : "not recorded")
      lines.push(`  - ${effect.id}: ${effect.state}; ${effect.authorClass}; ${effect.targetKind}; accepted ${accepted}; session recorded ${recorded}; message ids ${effect.messageIds?.join(",") || "none"}; session events ${effect.sessionEventIds?.join(",") || "none"}; updated ${effect.updatedAt}`)
    }
    const overflow = more("telegram", telegramRows.length); if (overflow) lines.push(overflow)
  }
  if (show("events")) {
    const events = [...status.externalEvents].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    const completedRun = status.lastAutomatedEventRun
    lines.push(`- external issues: ${events.length}; last successful automated event turn ${error("run_ledger") ?? (completedRun ? `${completedRun.endedAt ?? completedRun.recordedAt}; run ${completedRun.runId}; target ${completedRun.targetHash}` : "none")}`)
    if (error("external_events")) lines.push(`  - ${error("external_events")}`)
    for (const event of page(events)) {
      const policy = event.stewardPolicy?.kind === "current" ? `${event.stewardPolicy.key}@${event.stewardPolicy.version}` : "none"
      lines.push(`  - ${event.source}/${event.eventType}/${event.eventId}: ${event.executionState}; disposition ${event.classification ?? "pending"}/${event.decision ?? "pending"}; reason ${boundedStatusText(event.reason ?? event.lastError ?? "not yet recorded")}; silence/wake ${event.nextWake ? JSON.stringify(event.nextWake) : "pending"}; steward ${policy}${event.awaitId ? `; await ${event.awaitId}` : ""}${event.careId ? `; care ${event.careId}` : ""}`)
    }
    const overflow = more("events", events.length); if (overflow) lines.push(overflow)
  }
  return lines.join("\n")
}
