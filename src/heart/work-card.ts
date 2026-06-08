import * as fs from "fs"
import * as path from "path"
import { emitNervesEvent } from "../nerves/runtime"
import { buildAgentProviderVisibility, type AgentProviderVisibility } from "./provider-visibility"
import { listOpenEvolutionCases, nextEvolutionActionForStatus, type EvolutionCaseStatus } from "../arc/evolution"
import {
  listActiveReturnObligationsForRoot,
  readPendingObligations,
  type ObligationStatus,
  type ReturnObligationStatus,
} from "../arc/obligations"
import { listPonderPackets } from "../arc/packets"
import type { TaskStatus } from "../arc/task-lifecycle"

export type WorkCardFreshness = "current" | "stale_risky" | "unknown" | "not_applicable"
export type WorkCardSourceKind = "obligation" | "return_obligation" | "ponder_packet" | "evolution_case" | "claim_store"
export type WorkCardRedaction = "none" | "summary" | "private_ref" | "secret_ref"
export type WorkCardHealthStatus = "ok" | "degraded"

export interface WorkCardSource {
  kind: WorkCardSourceKind
  locator: string
  freshness: WorkCardFreshness
  redaction: WorkCardRedaction
}

export interface WorkCardIssue {
  code: string
  severity: "warning" | "degraded" | "unavailable"
  source: WorkCardSource
  detail: string
}

export interface WorkCardItem {
  id: string
  title: string
  status: string
  source: WorkCardSource
  summary?: string
  nextAction?: string
  updatedAt?: string
}

export interface WorkCardClaimsSection {
  available: boolean
  unavailableReason?: string
  counts: {
    unverified: number | null
    partial: number | null
    failed: number | null
    unverifiable: number | null
    staleRisky: number | null
    verified: number | null
  }
  items: WorkCardItem[]
}

export interface WorkCard {
  schemaVersion: 1
  projection: {
    owner: "arc/work-card"
    scope: "durable-arc-work"
    relationToActiveWorkFrame: "complements-live-turn-frame"
  }
  agent: string
  generatedAt: string
  degraded: {
    status: WorkCardHealthStatus
    issues: WorkCardIssue[]
  }
  currentAsk: {
    available: boolean
    source: "not_tracked_yet"
    confidence: "unknown"
  }
  counts: {
    owed: number
    returnObligations: number
    activePackets: number
    evolutionCases: number
    waitingOnHuman: number
    unverifiedClaims: number | null
    staleRiskyClaims: number | null
  }
  owed: WorkCardItem[]
  returnObligations: WorkCardItem[]
  activeWork: WorkCardItem[]
  waitingOnOthers: WorkCardItem[]
  claims: WorkCardClaimsSection
  capabilityHealth: {
    available: boolean
    unavailableReason?: string
    providers?: AgentProviderVisibility
  }
  nextAction: {
    actor: "agent" | "human" | "tool" | "unknown"
    summary: string
    source?: WorkCardSource
  }
  sources: WorkCardSource[]
}

export interface BuildWorkCardOptions {
  now?: () => Date
  nowMs?: () => number
  homeDir?: string
}

const ACTIVE_PACKET_STATUSES: ReadonlySet<TaskStatus> = new Set([
  "drafting",
  "processing",
  "validating",
  "collaborating",
  "paused",
  "blocked",
])

function isoFromMs(ms: number | undefined): string | undefined {
  if (typeof ms !== "number" || Number.isNaN(ms)) return undefined
  return new Date(ms).toISOString()
}

function obligationLocator(id: string): string {
  return `arc/obligations/${id}.json`
}

function returnObligationLocator(id: string): string {
  return `arc/obligations/inner/${id}.json`
}

function packetLocator(id: string): string {
  return `arc/packets/${id}.json`
}

function evolutionLocator(id: string): string {
  return `arc/evolution/cases/${id}.json`
}

export function validateWorkCardAgentName(agentName: string): string {
  const trimmed = agentName.trim()
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(trimmed)) {
    throw new Error("work card requires a safe agent name (letters, numbers, dot, underscore, hyphen; no path separators)")
  }
  if (trimmed === "." || trimmed === "..") {
    throw new Error("work card requires a safe agent name")
  }
  return trimmed
}

function source(
  kind: WorkCardSourceKind,
  locator: string,
  freshness: WorkCardFreshness = "current",
  redaction: WorkCardRedaction = "summary",
): WorkCardSource {
  return { kind, locator, freshness, redaction }
}

function issue(code: string, sourceRef: WorkCardSource, detail: string, severity: WorkCardIssue["severity"] = "degraded"): WorkCardIssue {
  return { code, severity, source: sourceRef, detail }
}

function readJsonDiagnostic(filePath: string): { ok: true; parsed: unknown } | { ok: false; detail: string } {
  try {
    return { ok: true, parsed: JSON.parse(fs.readFileSync(filePath, "utf-8")) as unknown }
  } catch (error) {
    return {
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
    }
  }
}

function scanJsonDir(
  dir: string,
  sourceKind: WorkCardSourceKind,
  locatorForFile: (basename: string) => string,
  isValid: (value: unknown) => boolean,
): WorkCardIssue[] {
  let entries: string[]
  try {
    entries = fs.readdirSync(dir)
  } catch {
    return []
  }

  return entries
    .filter((entry) => entry.endsWith(".json"))
    .flatMap((entry): WorkCardIssue[] => {
      const filePath = path.join(dir, entry)
      const sourceRef = source(sourceKind, locatorForFile(path.basename(entry, ".json")), "unknown")
      const read = readJsonDiagnostic(filePath)
      if (!read.ok) {
        return [issue("arc_json_unreadable", sourceRef, `${sourceRef.locator} could not be parsed: ${read.detail}`)]
      }
      if (!isValid(read.parsed)) {
        return [issue("arc_json_invalid_shape", sourceRef, `${sourceRef.locator} does not match the expected Work Card source shape`)]
      }
      return []
    })
}

function hasStringRecordFields(value: unknown, fields: string[]): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return fields.every((field) => typeof record[field] === "string")
}

function scanArcSourceIssues(agentRoot: string): WorkCardIssue[] {
  return [
    ...scanJsonDir(
      path.join(agentRoot, "arc", "obligations"),
      "obligation",
      obligationLocator,
      (value) => hasStringRecordFields(value, ["id", "content", "status"]),
    ),
    ...scanJsonDir(
      path.join(agentRoot, "arc", "obligations", "inner"),
      "return_obligation",
      returnObligationLocator,
      (value) => hasStringRecordFields(value, ["id", "status", "delegatedContent"])
        && typeof (value as Record<string, unknown>).createdAt === "number",
    ),
    ...scanJsonDir(
      path.join(agentRoot, "arc", "packets"),
      "ponder_packet",
      packetLocator,
      (value) => hasStringRecordFields(value, ["id", "kind", "status", "objective"]),
    ),
    ...scanJsonDir(
      path.join(agentRoot, "arc", "evolution", "cases"),
      "evolution_case",
      evolutionLocator,
      (value) => hasStringRecordFields(value, ["id", "title", "status"]),
    ),
  ]
}

function obligationItem(obligation: {
  id: string
  content: string
  status: ObligationStatus
  updatedAt?: string
  createdAt: string
  nextAction?: string
  latestNote?: string
  meaning?: { waitingOn?: { kind: string; target: string; detail: string } | null; stalenessClass?: string }
}): WorkCardItem {
  const freshness = obligation.meaning?.stalenessClass === "at-risk" ? "stale_risky" : "current"
  return {
    id: obligation.id,
    title: obligation.content,
    status: obligation.status,
    source: source("obligation", obligationLocator(obligation.id), freshness),
    ...(obligation.latestNote ? { summary: obligation.latestNote } : {}),
    ...(obligation.nextAction ? { nextAction: obligation.nextAction } : {}),
    updatedAt: obligation.updatedAt ?? obligation.createdAt,
  }
}

function returnObligationItem(obligation: {
  id: string
  status: ReturnObligationStatus
  delegatedContent: string
  createdAt: number
  startedAt?: number
  packetId?: string
}): WorkCardItem {
  return {
    id: obligation.id,
    title: obligation.delegatedContent,
    status: obligation.status,
    source: source("return_obligation", returnObligationLocator(obligation.id)),
    ...(obligation.packetId ? { summary: `packet: ${obligation.packetId}` } : {}),
    nextAction: obligation.status === "queued" ? "start private work and preserve the return route" : "finish and surface the delegated result",
    updatedAt: isoFromMs(obligation.startedAt ?? obligation.createdAt),
  }
}

function packetItem(packet: {
  id: string
  objective: string
  summary: string
  status: TaskStatus
  updatedAt: number
}): WorkCardItem {
  return {
    id: packet.id,
    title: packet.objective,
    status: packet.status,
    source: source("ponder_packet", packetLocator(packet.id)),
    summary: packet.summary,
    nextAction: packet.status === "blocked" ? "resolve blocker or mark waiting" : "advance packet toward validation and return",
    updatedAt: isoFromMs(packet.updatedAt),
  }
}

function evolutionItem(item: {
  id: string
  title: string
  status: EvolutionCaseStatus
  problemStatement: string
  updatedAt: string
}): WorkCardItem {
  return {
    id: item.id,
    title: item.title,
    status: item.status,
    source: source("evolution_case", evolutionLocator(item.id)),
    summary: item.problemStatement,
    nextAction: nextEvolutionActionForStatus(item.status),
    updatedAt: item.updatedAt,
  }
}

function waitingOnHuman(items: WorkCardItem[]): WorkCardItem[] {
  return items.filter((item) => {
    const lowerStatus = item.status.toLowerCase()
    return lowerStatus.includes("waiting")
      || lowerStatus.includes("blocked")
  })
}

function chooseNextAction(input: {
  owed: WorkCardItem[]
  returnObligations: WorkCardItem[]
  activeWork: WorkCardItem[]
  waiting: WorkCardItem[]
  claims: WorkCardClaimsSection
}): WorkCard["nextAction"] {
  if (input.waiting.length > 0) {
    return {
      actor: "human",
      summary: input.waiting[0].nextAction ?? input.waiting[0].title,
      source: input.waiting[0].source,
    }
  }
  if (input.claims.available && (input.claims.counts.unverified ?? 0) > 0 && input.claims.items[0]) {
    return {
      actor: "agent",
      summary: "verify or downgrade the oldest unverified claim",
      source: input.claims.items[0].source,
    }
  }
  if (input.returnObligations[0]) {
    return {
      actor: "agent",
      summary: input.returnObligations[0].nextAction ?? input.returnObligations[0].title,
      source: input.returnObligations[0].source,
    }
  }
  if (input.owed[0]) {
    return {
      actor: "agent",
      summary: input.owed[0].nextAction ?? input.owed[0].title,
      source: input.owed[0].source,
    }
  }
  if (input.activeWork[0]) {
    return {
      actor: "agent",
      summary: input.activeWork[0].nextAction ?? input.activeWork[0].title,
      source: input.activeWork[0].source,
    }
  }
  return {
    actor: "unknown",
    summary: "no open work found in arc; verify against current session context before claiming clear state",
  }
}

export function buildWorkCard(agentName: string, agentRoot: string, options: BuildWorkCardOptions = {}): WorkCard {
  const safeAgentName = validateWorkCardAgentName(agentName)
  const generatedAt = (options.now ?? (() => new Date()))().toISOString()
  const sourceIssues = scanArcSourceIssues(agentRoot)
  const owed = readPendingObligations(agentRoot).map(obligationItem)
  const returnObligations = listActiveReturnObligationsForRoot(agentRoot, { now: options.nowMs }).map(returnObligationItem)
  const activePackets = listPonderPackets(agentRoot)
    .filter((packet) => ACTIVE_PACKET_STATUSES.has(packet.status))
    .map(packetItem)
  const evolutionCases = listOpenEvolutionCases(agentRoot).map(evolutionItem)
  const activeWork = [...activePackets, ...evolutionCases]
  const waiting = waitingOnHuman([...owed, ...returnObligations, ...activeWork])
  const claims: WorkCardClaimsSection = {
    available: false,
    unavailableReason: "WorkClaim store is not implemented yet; unverified claim counts are unknown, not zero.",
    counts: {
      unverified: null,
      partial: null,
      failed: null,
      unverifiable: null,
      staleRisky: null,
      verified: null,
    },
    items: [],
  }
  const claimsUnavailableReason = claims.unavailableReason ?? "WorkClaim store is unavailable."
  const claimIssue = issue(
    "claims_unavailable",
    source("claim_store", "arc/claims", "unknown"),
    claimsUnavailableReason,
    "unavailable",
  )
  const providers = buildAgentProviderVisibility({ agentName: safeAgentName, agentRoot, homeDir: options.homeDir })
  const nextAction = chooseNextAction({ owed, returnObligations, activeWork, waiting, claims })
  const sources = [...owed, ...returnObligations, ...activeWork, ...claims.items].map((item) => item.source)
  sources.push(source("claim_store", "arc/claims", "unknown"))
  const issues = [...sourceIssues, claimIssue]

  const card: WorkCard = {
    schemaVersion: 1,
    projection: {
      owner: "arc/work-card",
      scope: "durable-arc-work",
      relationToActiveWorkFrame: "complements-live-turn-frame",
    },
    agent: safeAgentName,
    generatedAt,
    degraded: {
      status: issues.some((issue) => issue.severity === "degraded" || issue.severity === "unavailable") ? "degraded" : "ok",
      issues,
    },
    currentAsk: {
      available: false,
      source: "not_tracked_yet",
      confidence: "unknown",
    },
    counts: {
      owed: owed.length,
      returnObligations: returnObligations.length,
      activePackets: activePackets.length,
      evolutionCases: evolutionCases.length,
      waitingOnHuman: waiting.length,
      unverifiedClaims: null,
      staleRiskyClaims: null,
    },
    owed,
    returnObligations,
    activeWork,
    waitingOnOthers: waiting,
    claims,
    capabilityHealth: {
      available: true,
      providers,
    },
    nextAction,
    sources,
  }

  emitNervesEvent({
    component: "engine",
    event: "engine.work_card_compiled",
    message: "work card compiled from arc records",
    meta: {
      agent: agentName,
      owedCount: card.counts.owed,
      returnObligationCount: card.counts.returnObligations,
      activeWorkCount: card.counts.activePackets + card.counts.evolutionCases,
      waitingOnHumanCount: card.counts.waitingOnHuman,
      claimsAvailable: card.claims.available,
      sourceIssueCount: sourceIssues.length,
    },
  })

  return card
}

function formatItems(items: WorkCardItem[], empty: string): string[] {
  if (items.length === 0) return [`  ${empty}`]
  return items.map((item) => {
    const suffixes = [
      item.nextAction ? `next: ${item.nextAction}` : null,
      `source: ${item.source.locator}`,
    ].filter(Boolean)
    return `  - [${item.status}] ${item.title} (${suffixes.join("; ")})`
  })
}

export function formatWorkCardText(card: WorkCard): string {
  return [
    `Work Card — ${card.agent}`,
    `generated: ${card.generatedAt}`,
    `health: ${card.degraded.status}${card.degraded.issues.length > 0 ? ` (${card.degraded.issues.length} issue${card.degraded.issues.length === 1 ? "" : "s"})` : ""}`,
    "",
    `counts: owed=${card.counts.owed} return_obligations=${card.counts.returnObligations} active_packets=${card.counts.activePackets} evolution_cases=${card.counts.evolutionCases} waiting_on_human=${card.counts.waitingOnHuman} unverified_claims=${card.counts.unverifiedClaims ?? "unknown"} stale_risky_claims=${card.counts.staleRiskyClaims ?? "unknown"}`,
    "",
    "Owed",
    ...formatItems(card.owed, "none found in arc/obligations"),
    "",
    "Return Obligations",
    ...formatItems(card.returnObligations, "none active"),
    "",
    "Active Work",
    ...formatItems(card.activeWork, "none found in packets or evolution cases"),
    "",
    "Waiting On Others",
    ...formatItems(card.waitingOnOthers, "none detected from durable records"),
    "",
    "Claims",
    card.claims.available
      ? `  unverified=${card.claims.counts.unverified} partial=${card.claims.counts.partial} stale_risky=${card.claims.counts.staleRisky}`
      : `  unavailable: ${card.claims.unavailableReason}`,
    "",
    "Source Issues",
    ...(card.degraded.issues.length === 0
      ? ["  none"]
      : card.degraded.issues.map((item) => `  - [${item.severity}] ${item.code}: ${item.detail} (source: ${item.source.locator})`)),
    "",
    "Capability Health",
    card.capabilityHealth.available
      ? `  provider lanes: ${card.capabilityHealth.providers?.lanes.map((lane) => `${lane.lane}:${lane.status}/${lane.readiness.status}`).join(", ") ?? "unknown"}`
      : `  unavailable: ${card.capabilityHealth.unavailableReason}`,
    "",
    "Next Action",
    `  ${card.nextAction.actor}: ${card.nextAction.summary}`,
    card.nextAction.source ? `  source: ${card.nextAction.source.locator}` : "",
  ].filter((line, index, lines) => line !== "" || lines[index - 1] !== "").join("\n").trim()
}
