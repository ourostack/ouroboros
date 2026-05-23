import * as fs from "node:fs"
import * as path from "node:path"
import { emitNervesEvent } from "../nerves/runtime"
import { generateTimestampId, readJsonDir, readJsonFile, writeJsonFile } from "./json-store"

export type EvolutionCaseStatus =
  | "noticed"
  | "capturing"
  | "scoped"
  | "budgeted"
  | "delegating"
  | "verifying"
  | "waiting_for_merge"
  | "updating_runtime"
  | "ratifying"
  | "evaluating"
  | "closed"
  | "blocked"
  | "deferred"

export type EvolutionEvidenceKind =
  | "session_event"
  | "session_envelope"
  | "nerves_event"
  | "ponder_packet"
  | "obligation"
  | "return_obligation"
  | "coding_session"
  | "coding_artifact"
  | "desk_doc"
  | "desk_friction"
  | "git_commit"
  | "pull_request"
  | "ci_run"
  | "release"
  | "installed_runtime"
  | "diary_entry"
  | "journal_file"
  | "skill_file"
  | "sense_artifact"
  | "hosted_audit"
  | "human_message"
  | "external_doc"

export type EvolutionRedaction = "none" | "summary" | "private_ref" | "secret_ref"

export interface EvolutionEvidenceRef {
  kind: EvolutionEvidenceKind
  locator: string
  capturedAt: string
  redaction: EvolutionRedaction
  reason: string
}

export type EvolutionBudgetProfile = "capture" | "conservative" | "trusted-local"

export interface EvolutionBudget {
  profile: EvolutionBudgetProfile
  limits: {
    codingSessions: number
    codingRestarts: number
    prAttempts: number
    mergeAttempts: number
    releaseInstallAttempts: number
  }
  spent: {
    codingSessions: number
    codingRestarts: number
    prAttempts: number
    mergeAttempts: number
    releaseInstallAttempts: number
  }
  updatedAt: string
  reason: string
}

export type EvolutionActionClass =
  | "create_case"
  | "add_evidence"
  | "write_journal"
  | "write_desk"
  | "write_diary"
  | "spawn_coding"
  | "create_branch"
  | "commit"
  | "open_pr"
  | "merge_pr"
  | "release_publish"
  | "install_local"
  | "mutate_shared_skill"
  | "mutate_identity"
  | "mutate_voice"
  | "mutate_credentials"
  | "mutate_provider_config"
  | "send_external_message"
  | "change_hosted_infra"
  | "ratify"

export type EvolutionAuthorityMode = "allowed" | "ask_before_action" | "human_required" | "blocked"

export interface EvolutionAuthority {
  actions: Partial<Record<EvolutionActionClass, EvolutionAuthorityMode>>
  updatedAt: string
  reason: string
}

export interface EvolutionOrigin {
  kind: "session" | "mcp" | "sense" | "desk" | "habit" | "human" | "coding" | "runtime"
  label: string
  locator: string
}

export interface EvolutionDecision {
  decision: "ignore" | "defer" | "journal" | "ask" | "delegate" | "act" | "abandon"
  reason: string
  authorityMode: string
  decidedAt: string
}

export interface EvolutionVerification {
  status: "not-verified" | "partial" | "passed" | "failed"
  checkedAt: string
  objective: string
  commands: string[]
  evidenceRefs: string[]
  residualRisk: string | null
  missingChecks: string[]
}

export interface EvolutionDeliveryState {
  branchCreated?: { branch: string; createdAt: string } | null
  commits?: Array<{ sha: string; message: string }> | null
  pullRequest?: { url: string; openedAt: string } | null
  merged?: { url: string; mergedAt: string } | null
  released?: { version: string; releasedAt: string } | null
  published?: { package: string; version: string; publishedAt: string } | null
  installedLocal?: { version: string; installedAt: string } | null
  runtimeRefreshed?: { refreshedAt: string; command: string } | null
  verifiedOnCurrentMachine?: { verifiedAt: string; evidence: string } | null
}

export interface EvolutionRatification {
  destination:
    | "code"
    | "repo_doc"
    | "shared_skill"
    | "desk_lesson"
    | "desk_task"
    | "diary"
    | "journal"
    | "habit"
    | "policy"
    | "agent_config"
    | "hosted_substrate"
    | "none_needed"
  locator: string
  landedAt: string
  reason: string
}

export interface EvolutionCase {
  id: string
  agentId: string | null
  title: string
  status: EvolutionCaseStatus
  origin: EvolutionOrigin
  problemStatement: string
  desiredBehavior: string
  evidenceRefs: EvolutionEvidenceRef[]
  authority: EvolutionAuthority
  budget: EvolutionBudget
  decision: EvolutionDecision | null
  packetId?: string
  obligationId?: string
  frictionSignature?: string
  delegationRefs: string[]
  verification: EvolutionVerification | null
  delivery: EvolutionDeliveryState
  ratification: EvolutionRatification | null
  createdAt: string
  updatedAt: string
  closedAt: string | null
  latestNote: string | null
}

export type EvolutionTraceEventType =
  | "noticed"
  | "evidence_added"
  | "scoped"
  | "budget_set"
  | "authority_set"
  | "decision_recorded"
  | "delegated"
  | "delegation_blocked"
  | "verification_recorded"
  | "delivery_recorded"
  | "ratification_recorded"
  | "closed"
  | "blocked"
  | "deferred"

export interface EvolutionTraceEvent {
  id: string
  caseId: string
  type: EvolutionTraceEventType
  occurredAt: string
  reason: string
  evidenceRefs?: string[]
  target?: string
}

export interface EvolutionCaseSummary {
  id: string
  title: string
  status: EvolutionCaseStatus
  nextAction: string
  budgetProfile: EvolutionBudgetProfile
}

export interface CreateEvolutionCaseInput {
  title: string
  problemStatement: string
  desiredBehavior: string
  origin: EvolutionOrigin
  evidenceRefs?: EvolutionEvidenceRef[]
  frictionSignature?: string
  packetId?: string
  obligationId?: string
  agentId?: string | null
  budgetProfile?: EvolutionBudgetProfile
}

export interface EvolutionActionDecision {
  allowed: boolean
  code: "allowed" | "case_not_found" | "terminal_case" | "budget_exhausted" | EvolutionAuthorityMode
  reason: string
}

const TERMINAL_STATUSES: ReadonlySet<EvolutionCaseStatus> = new Set(["closed", "blocked", "deferred"])

const ALL_ACTIONS: readonly EvolutionActionClass[] = [
  "create_case",
  "add_evidence",
  "write_journal",
  "write_desk",
  "write_diary",
  "spawn_coding",
  "create_branch",
  "commit",
  "open_pr",
  "merge_pr",
  "release_publish",
  "install_local",
  "mutate_shared_skill",
  "mutate_identity",
  "mutate_voice",
  "mutate_credentials",
  "mutate_provider_config",
  "send_external_message",
  "change_hosted_infra",
  "ratify",
]

const HUMAN_REQUIRED_ACTIONS: ReadonlySet<EvolutionActionClass> = new Set([
  "release_publish",
  "mutate_identity",
  "mutate_voice",
  "mutate_credentials",
  "mutate_provider_config",
  "send_external_message",
  "change_hosted_infra",
])

const ASK_BEFORE_ACTIONS: ReadonlySet<EvolutionActionClass> = new Set([
  "merge_pr",
  "install_local",
  "mutate_shared_skill",
])

function nowIso(): string {
  return new Date().toISOString()
}

function evolutionDir(agentRoot: string): string {
  return path.join(agentRoot, "arc", "evolution")
}

function casesDir(agentRoot: string): string {
  return path.join(evolutionDir(agentRoot), "cases")
}

function tracesDir(agentRoot: string): string {
  return path.join(evolutionDir(agentRoot), "traces")
}

function traceFile(agentRoot: string, caseId: string): string {
  return path.join(tracesDir(agentRoot), `${caseId}.jsonl`)
}

function budgetForProfile(profile: EvolutionBudgetProfile, updatedAt: string, reason: string): EvolutionBudget {
  const limits = profile === "capture"
    ? { codingSessions: 0, codingRestarts: 0, prAttempts: 0, mergeAttempts: 0, releaseInstallAttempts: 0 }
    : profile === "trusted-local"
      ? { codingSessions: 2, codingRestarts: 1, prAttempts: 1, mergeAttempts: 1, releaseInstallAttempts: 0 }
      : { codingSessions: 1, codingRestarts: 0, prAttempts: 1, mergeAttempts: 0, releaseInstallAttempts: 0 }
  return {
    profile,
    limits,
    spent: {
      codingSessions: 0,
      codingRestarts: 0,
      prAttempts: 0,
      mergeAttempts: 0,
      releaseInstallAttempts: 0,
    },
    updatedAt,
    reason,
  }
}

function defaultAuthority(updatedAt: string): EvolutionAuthority {
  const actions: Partial<Record<EvolutionActionClass, EvolutionAuthorityMode>> = {}
  for (const action of ALL_ACTIONS) {
    actions[action] = HUMAN_REQUIRED_ACTIONS.has(action)
      ? "human_required"
      : ASK_BEFORE_ACTIONS.has(action)
        ? "ask_before_action"
        : "allowed"
  }
  return {
    actions,
    updatedAt,
    reason: "default conservative evolution authority",
  }
}

function isEvolutionCase(value: EvolutionCase): boolean {
  return Boolean(value)
    && typeof value.id === "string"
    && typeof value.title === "string"
    && typeof value.status === "string"
    && typeof value.problemStatement === "string"
    && typeof value.desiredBehavior === "string"
}

function writeCase(agentRoot: string, item: EvolutionCase): EvolutionCase {
  writeJsonFile(casesDir(agentRoot), item.id, item)
  return item
}

function updateCase(agentRoot: string, caseId: string, update: (item: EvolutionCase) => EvolutionCase): EvolutionCase {
  const existing = readEvolutionCase(agentRoot, caseId)
  if (!existing) {
    throw new Error(`Evolution case not found: ${caseId}`)
  }
  const updated = update({ ...existing, updatedAt: nowIso() })
  writeCase(agentRoot, updated)
  emitNervesEvent({
    component: "engine",
    event: "engine.evolution_case_updated",
    message: "evolution case updated",
    meta: { caseId, status: updated.status },
  })
  return updated
}

function appendTrace(agentRoot: string, event: EvolutionTraceEvent): EvolutionTraceEvent {
  fs.mkdirSync(tracesDir(agentRoot), { recursive: true })
  fs.appendFileSync(traceFile(agentRoot, event.caseId), `${JSON.stringify(event)}\n`, "utf-8")
  emitNervesEvent({
    component: "engine",
    event: "engine.evolution_trace_appended",
    message: "evolution trace event appended",
    meta: { caseId: event.caseId, type: event.type },
  })
  return event
}

export function nextEvolutionActionForStatus(status: EvolutionCaseStatus): string {
  switch (status) {
    case "noticed":
    case "capturing":
      return "scope and budget the case"
    case "scoped":
      return "set authority and budget"
    case "budgeted":
      return "decide whether to delegate or ask"
    case "delegating":
      return "monitor delegated coding work"
    case "verifying":
      return "verify against the original objective"
    case "waiting_for_merge":
      return "review merge authority and PR state"
    case "updating_runtime":
      return "verify release or local install state"
    case "ratifying":
      return "land or record ratification"
    case "evaluating":
      return "record recurrence or improvement evidence"
    case "closed":
      return "no action"
    case "blocked":
      return "resolve blocker or authority gap"
    case "deferred":
      return "resume only when the deferral condition changes"
  }
}

function isTerminal(item: EvolutionCase): boolean {
  return TERMINAL_STATUSES.has(item.status)
}

function budgetExhausted(item: EvolutionCase, action: EvolutionActionClass): boolean {
  if (action === "spawn_coding") return item.budget.spent.codingSessions >= item.budget.limits.codingSessions
  if (action === "open_pr") return item.budget.spent.prAttempts >= item.budget.limits.prAttempts
  if (action === "merge_pr") return item.budget.spent.mergeAttempts >= item.budget.limits.mergeAttempts
  if (action === "release_publish" || action === "install_local") {
    return item.budget.spent.releaseInstallAttempts >= item.budget.limits.releaseInstallAttempts
  }
  return false
}

function spendBudget(item: EvolutionCase, action: EvolutionActionClass): EvolutionBudget {
  const budget: EvolutionBudget = {
    ...item.budget,
    spent: { ...item.budget.spent },
    updatedAt: nowIso(),
  }
  if (action === "spawn_coding") budget.spent.codingSessions += 1
  if (action === "open_pr") budget.spent.prAttempts += 1
  if (action === "merge_pr") budget.spent.mergeAttempts += 1
  if (action === "release_publish" || action === "install_local") budget.spent.releaseInstallAttempts += 1
  return budget
}

export function createEvolutionCase(agentRoot: string, input: CreateEvolutionCaseInput): EvolutionCase {
  const timestamp = nowIso()
  const item: EvolutionCase = {
    id: generateTimestampId("evo"),
    agentId: input.agentId ?? null,
    title: input.title,
    status: "noticed",
    origin: input.origin,
    problemStatement: input.problemStatement,
    desiredBehavior: input.desiredBehavior,
    evidenceRefs: input.evidenceRefs ?? [],
    authority: defaultAuthority(timestamp),
    budget: budgetForProfile(input.budgetProfile ?? "conservative", timestamp, "default budget"),
    decision: null,
    ...(input.packetId ? { packetId: input.packetId } : {}),
    ...(input.obligationId ? { obligationId: input.obligationId } : {}),
    ...(input.frictionSignature ? { frictionSignature: input.frictionSignature } : {}),
    delegationRefs: [],
    verification: null,
    delivery: {},
    ratification: null,
    createdAt: timestamp,
    updatedAt: timestamp,
    closedAt: null,
    latestNote: null,
  }
  writeCase(agentRoot, item)
  emitNervesEvent({
    component: "engine",
    event: "engine.evolution_case_created",
    message: "evolution case created",
    meta: { caseId: item.id, status: item.status },
  })
  appendEvolutionTraceEvent(agentRoot, item.id, { type: "noticed", reason: "case created" })
  return item
}

export function readEvolutionCase(agentRoot: string, caseId: string): EvolutionCase | null {
  const item = readJsonFile<EvolutionCase>(casesDir(agentRoot), caseId)
  return item && isEvolutionCase(item) ? item : null
}

export function listEvolutionCases(agentRoot: string): EvolutionCase[] {
  return readJsonDir<EvolutionCase>(casesDir(agentRoot))
    .filter(isEvolutionCase)
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
}

export function listOpenEvolutionCases(agentRoot: string): EvolutionCase[] {
  return listEvolutionCases(agentRoot).filter((item) => !isTerminal(item))
}

export function summarizeOpenEvolutionCases(agentRoot: string): EvolutionCaseSummary[] {
  return listOpenEvolutionCases(agentRoot).map((item) => ({
    id: item.id,
    title: item.title,
    status: item.status,
    nextAction: nextEvolutionActionForStatus(item.status),
    budgetProfile: item.budget.profile,
  }))
}

export function readEvolutionTrace(agentRoot: string, caseId: string): EvolutionTraceEvent[] {
  try {
    const raw = fs.readFileSync(traceFile(agentRoot, caseId), "utf-8")
    return raw
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .flatMap((line) => {
        try {
          const parsed = JSON.parse(line) as EvolutionTraceEvent
          return parsed.caseId === caseId && typeof parsed.type === "string" ? [parsed] : []
        } catch {
          return []
        }
      })
  } catch {
    return []
  }
}

export function appendEvolutionTraceEvent(
  agentRoot: string,
  caseId: string,
  input: Omit<EvolutionTraceEvent, "id" | "caseId" | "occurredAt">,
): EvolutionTraceEvent {
  return appendTrace(agentRoot, {
    id: generateTimestampId("evt"),
    caseId,
    occurredAt: nowIso(),
    ...input,
  })
}

export function findOpenEvolutionCaseByFrictionSignature(agentRoot: string, signature: string): EvolutionCase | null {
  return listOpenEvolutionCases(agentRoot).find((item) => item.frictionSignature === signature) ?? null
}

export function addEvolutionEvidence(
  agentRoot: string,
  caseId: string,
  evidence: EvolutionEvidenceRef,
): EvolutionCase {
  const updated = updateCase(agentRoot, caseId, (item) => ({
    ...item,
    evidenceRefs: [...item.evidenceRefs, evidence],
  }))
  appendEvolutionTraceEvent(agentRoot, caseId, {
    type: "evidence_added",
    reason: evidence.reason,
    evidenceRefs: [evidence.locator],
  })
  return updated
}

export function setEvolutionBudget(
  agentRoot: string,
  caseId: string,
  input: { profile: EvolutionBudgetProfile; reason: string },
): EvolutionCase {
  const updated = updateCase(agentRoot, caseId, (item) => ({
    ...item,
    status: item.status === "noticed" || item.status === "capturing" || item.status === "scoped" ? "budgeted" : item.status,
    budget: budgetForProfile(input.profile, nowIso(), input.reason),
  }))
  appendEvolutionTraceEvent(agentRoot, caseId, { type: "budget_set", reason: input.reason })
  return updated
}

export function setEvolutionAuthority(
  agentRoot: string,
  caseId: string,
  input: { actions: Partial<Record<EvolutionActionClass, EvolutionAuthorityMode>>; reason: string },
): EvolutionCase {
  const updated = updateCase(agentRoot, caseId, (item) => ({
    ...item,
    authority: {
      actions: { ...item.authority.actions, ...input.actions },
      updatedAt: nowIso(),
      reason: input.reason,
    },
  }))
  appendEvolutionTraceEvent(agentRoot, caseId, { type: "authority_set", reason: input.reason })
  return updated
}

export function evaluateEvolutionAction(
  agentRoot: string,
  caseId: string,
  action: EvolutionActionClass,
): EvolutionActionDecision {
  const item = readEvolutionCase(agentRoot, caseId)
  if (!item) return { allowed: false, code: "case_not_found", reason: `Evolution case not found: ${caseId}` }
  if (isTerminal(item)) return { allowed: false, code: "terminal_case", reason: `Evolution case is ${item.status}` }
  const authority = item.authority.actions[action] ?? "human_required"
  if (authority !== "allowed") return { allowed: false, code: authority, reason: `${action} is ${authority}` }
  if (budgetExhausted(item, action)) return { allowed: false, code: "budget_exhausted", reason: `${action} budget is exhausted` }
  return { allowed: true, code: "allowed", reason: `${action} allowed` }
}

export function consumeEvolutionBudget(
  agentRoot: string,
  caseId: string,
  action: EvolutionActionClass,
  input: { target?: string; reason: string },
): EvolutionCase {
  const decision = evaluateEvolutionAction(agentRoot, caseId, action)
  if (!decision.allowed) {
    appendEvolutionTraceEvent(agentRoot, caseId, {
      type: "delegation_blocked",
      reason: decision.reason,
      ...(input.target ? { target: input.target } : {}),
    })
    emitNervesEvent({
      component: "engine",
      event: "engine.evolution_budget_blocked",
      message: "evolution budget or authority blocked action",
      meta: { caseId, action, code: decision.code },
    })
    throw new Error(`Evolution ${action} blocked: ${decision.reason}`)
  }
  const updated = updateCase(agentRoot, caseId, (item) => ({
    ...item,
    budget: spendBudget(item, action),
  }))
  appendEvolutionTraceEvent(agentRoot, caseId, {
    type: action === "spawn_coding" ? "delegated" : "budget_set",
    reason: input.reason,
    ...(input.target ? { target: input.target } : {}),
  })
  return updated
}

export function recordEvolutionDecision(
  agentRoot: string,
  caseId: string,
  input: Omit<EvolutionDecision, "decidedAt">,
): EvolutionCase {
  const decidedAt = nowIso()
  const updated = updateCase(agentRoot, caseId, (item) => ({
    ...item,
    decision: { ...input, decidedAt },
  }))
  appendEvolutionTraceEvent(agentRoot, caseId, { type: "decision_recorded", reason: input.reason })
  return updated
}

export function recordEvolutionVerification(
  agentRoot: string,
  caseId: string,
  input: EvolutionVerification,
): EvolutionCase {
  const updated = updateCase(agentRoot, caseId, (item) => ({
    ...item,
    status: input.status === "passed" ? "ratifying" : "verifying",
    verification: input,
  }))
  appendEvolutionTraceEvent(agentRoot, caseId, {
    type: "verification_recorded",
    reason: `verification ${input.status}`,
    evidenceRefs: input.evidenceRefs,
  })
  return updated
}

export function recordEvolutionDelivery(
  agentRoot: string,
  caseId: string,
  input: EvolutionDeliveryState,
): EvolutionCase {
  const updated = updateCase(agentRoot, caseId, (item) => ({
    ...item,
    delivery: { ...item.delivery, ...input },
  }))
  appendEvolutionTraceEvent(agentRoot, caseId, { type: "delivery_recorded", reason: "delivery state recorded" })
  return updated
}

export function recordEvolutionRatification(
  agentRoot: string,
  caseId: string,
  input: EvolutionRatification,
): EvolutionCase {
  const updated = updateCase(agentRoot, caseId, (item) => ({
    ...item,
    status: item.status === "closed" ? item.status : "ratifying",
    ratification: input,
  }))
  appendEvolutionTraceEvent(agentRoot, caseId, {
    type: "ratification_recorded",
    reason: input.reason,
    evidenceRefs: [input.locator],
  })
  return updated
}

export function closeEvolutionCase(
  agentRoot: string,
  caseId: string,
  input: { reason: string; ratification?: EvolutionRatification },
): EvolutionCase {
  const closedAt = nowIso()
  const updated = updateCase(agentRoot, caseId, (item) => {
    const ratification = input.ratification ?? item.ratification
    if (!ratification) {
      throw new Error("Evolution case closure requires ratification or none_needed")
    }
    return {
      ...item,
      status: "closed",
      ratification,
      closedAt,
      latestNote: input.reason,
    }
  })
  appendEvolutionTraceEvent(agentRoot, caseId, { type: "closed", reason: input.reason })
  return updated
}

export function blockEvolutionCase(agentRoot: string, caseId: string, input: { reason: string }): EvolutionCase {
  const updated = updateCase(agentRoot, caseId, (item) => ({
    ...item,
    status: "blocked",
    latestNote: input.reason,
    closedAt: nowIso(),
  }))
  appendEvolutionTraceEvent(agentRoot, caseId, { type: "blocked", reason: input.reason })
  return updated
}

export function deferEvolutionCase(agentRoot: string, caseId: string, input: { reason: string }): EvolutionCase {
  const updated = updateCase(agentRoot, caseId, (item) => ({
    ...item,
    status: "deferred",
    latestNote: input.reason,
    closedAt: nowIso(),
  }))
  appendEvolutionTraceEvent(agentRoot, caseId, { type: "deferred", reason: input.reason })
  return updated
}
