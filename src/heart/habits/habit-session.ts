import * as fs from "fs"
import * as path from "path"
import type { AttentionItem } from "../../arc/attention-types"
import {
  decisionsFromHabitRunTraceSteps,
  isSafeHabitRunId as isSafeFlightRecorderHabitRunId,
  listHabitRunReceipts,
  writeHabitRunReceipt,
  type FlightRecorderProducedRef,
  type HabitPermissionEnvelope,
  type HabitRunSummarySnapshot,
  type HabitReturnRoute,
  type HabitReturnRouteKind,
  type HabitRunOutcome,
  type HabitRunReceipt,
  type HabitRunTraceStep,
  type HabitRunTrigger,
  type HabitSurfaceAttempt,
  type HabitToolPolicy,
} from "../../arc/flight-recorder"
import type { FriendStore, FriendRecord } from "@ouro.bot/friends"
import { emitNervesEvent } from "../../nerves/runtime"
import type { ToolDefinition, ToolRiskProfile } from "../../repertoire/tools-base"
import { nextCadenceRunAt } from "../daemon/cadence"
import type { HabitFile } from "./habit-parser"
import { recordHabitRun } from "./habit-runtime-state"

export { isSafeHabitRunId } from "../../arc/flight-recorder"

export interface HabitSessionPaths {
  runDir: string
  sessionPath: string
  pendingDir: string
  runtimeStatePath: string
  receiptPath: string
  sessionLocator: string
  pendingLocator: string
  runtimeStateLocator: string
  receiptLocator: string
}

export interface NormalizeHabitPermissionOptions {
  agentRoot: string
  friendStore?: FriendStore
}

export type HabitReturnRouteResolution =
  | {
    allowed: true
    routeKind: HabitReturnRouteKind
    friendId: string
    channel: string
    key: string
  }
  | {
    allowed: false
    reason: string
  }

export interface ResolveHabitReturnRouteInput extends NormalizeHabitPermissionOptions {
  envelope: HabitPermissionEnvelope
  toolName: string
  args: Record<string, string>
  delegatedOrigins?: AttentionItem[]
}

export interface BuildHabitRunReceiptInput {
  agentRoot: string
  habit: HabitFile
  runId: string
  trigger: HabitRunTrigger
  startedAt: string
  endedAt: string
  outcome: HabitRunOutcome
  operationId?: string | null
  permissionEnvelope: HabitPermissionEnvelope
  toolPolicy: HabitToolPolicy
  producedRefs?: FlightRecorderProducedRef[]
  surfaceAttempts?: HabitSurfaceAttempt[]
  traceSteps?: HabitRunTraceStep[]
  errors?: string[]
  nextRunAt?: string | null
  summarySnapshot?: HabitRunSummarySnapshot
}

export type CompleteHabitRunInput = Omit<BuildHabitRunReceiptInput, "outcome" | "nextRunAt">

export interface CompleteHabitRunResult {
  outcome: HabitRunOutcome
  producedRefs: FlightRecorderProducedRef[]
  receiptWritten: boolean
  runtimeStateRecorded: boolean
}

export interface HabitRuntimeStateSnapshot {
  schemaVersion: 1
  name: string
  lastRun: string
  updatedAt: string
  activeOperationId: string | null
  latestRunId: string | null
  latestReceiptLocator: string | null
}

export interface HabitSessionRecoveryState {
  receipt: HabitRunReceipt
  runtimeState: HabitRuntimeStateSnapshot | null
}

interface ResolvedFriend {
  id: string
  name: string
  trustLevel?: FriendRecord["trustLevel"]
  isSelf: boolean
}

interface RouteTarget {
  friendId: string
  channel: string
  key: string
}

function habitSessionRoot(agentRoot: string): string {
  return path.join(agentRoot, "state", "habit-sessions")
}

function isHabitRuntimeStateSnapshot(value: unknown, habitName: string): value is HabitRuntimeStateSnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const record = value as Partial<HabitRuntimeStateSnapshot>
  return record.schemaVersion === 1
    && record.name === habitName
    && typeof record.lastRun === "string"
    && typeof record.updatedAt === "string"
    && (record.activeOperationId === undefined || record.activeOperationId === null || typeof record.activeOperationId === "string")
    && (record.latestRunId === undefined || record.latestRunId === null || typeof record.latestRunId === "string")
    && (record.latestReceiptLocator === undefined || record.latestReceiptLocator === null || typeof record.latestReceiptLocator === "string")
}

function runtimeCursorValue(value: string | null | undefined): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null
}

function readHabitRuntimeStateSnapshot(agentRoot: string, habitName: string): HabitRuntimeStateSnapshot | null {
  const runtimeStatePath = path.join(agentRoot, "state", "habits", `${habitName}.json`)
  try {
    const parsed = JSON.parse(fs.readFileSync(runtimeStatePath, "utf-8")) as unknown
    if (isHabitRuntimeStateSnapshot(parsed, habitName)) {
      return {
        schemaVersion: 1,
        name: parsed.name,
        lastRun: parsed.lastRun,
        updatedAt: parsed.updatedAt,
        activeOperationId: runtimeCursorValue(parsed.activeOperationId),
        latestRunId: runtimeCursorValue(parsed.latestRunId),
        latestReceiptLocator: runtimeCursorValue(parsed.latestReceiptLocator),
      }
    }
    emitNervesEvent({
      level: "warn",
      component: "daemon",
      event: "daemon.habit_runtime_state_malformed",
      message: "habit runtime state could not be used for recovery",
      meta: { agentRoot, habitName, runtimeStatePath },
    })
    return null
  } catch {
    return null
  }
}

export function readLatestHabitSessionState(
  agentRoot: string,
  options: { habitName?: string } = {},
): HabitSessionRecoveryState | null {
  const receipt = listHabitRunReceipts(agentRoot)
    .find((entry) => options.habitName === undefined || entry.habitName === options.habitName)
  if (!receipt) {
    emitNervesEvent({
      component: "daemon",
      event: "daemon.habit_session_recovery_state_empty",
      message: "no habit session receipt available for recovery",
      meta: { agentRoot, habitName: options.habitName ?? null },
    })
    return null
  }
  const state = {
    receipt,
    runtimeState: readHabitRuntimeStateSnapshot(agentRoot, receipt.habitName),
  }
  emitNervesEvent({
    component: "daemon",
    event: "daemon.habit_session_recovery_state_read",
    message: "habit session recovery state read",
    meta: { agentRoot, habitName: receipt.habitName, runId: receipt.runId, hasRuntimeState: state.runtimeState !== null },
  })
  return state
}

export function createHabitSessionPaths(agentRoot: string, runId: string, habitName = "heartbeat"): HabitSessionPaths {
  if (!isSafeFlightRecorderHabitRunId(runId)) {
    emitNervesEvent({
      level: "warn",
      component: "daemon",
      event: "daemon.habit_session_unsafe_run_id",
      message: "unsafe habit session run id rejected",
      meta: { agentRoot, runId },
    })
    throw new Error(`unsafe habit run id: ${runId}`)
  }
  const sessionLocator = `state/habit-sessions/${runId}/session.json`
  const pendingLocator = `state/habit-sessions/${runId}/pending`
  const runtimeStateLocator = `state/habits/${habitName}.json`
  const receiptLocator = `arc/flight-recorder/habit-receipts/${runId}.json`
  return {
    runDir: path.join(habitSessionRoot(agentRoot), runId),
    sessionPath: path.join(habitSessionRoot(agentRoot), runId, "session.json"),
    pendingDir: path.join(habitSessionRoot(agentRoot), runId, "pending"),
    runtimeStatePath: path.join(agentRoot, "state", "habits", `${habitName}.json`),
    receiptPath: path.join(agentRoot, "arc", "flight-recorder", "habit-receipts", `${runId}.json`),
    sessionLocator,
    pendingLocator,
    runtimeStateLocator,
    receiptLocator,
  }
}

function normalizeIdentifier(value: string): string {
  return value.trim().toLowerCase()
}

function isSelfTarget(friendId: string, channel?: string, key?: string): boolean {
  return normalizeIdentifier(friendId) === "self"
    || normalizeIdentifier(channel ?? "") === "inner"
    || `${normalizeIdentifier(friendId)}/${normalizeIdentifier(channel ?? "")}/${normalizeIdentifier(key ?? "")}` === "self/inner/dialog"
}

function decodedSegment(value: string): string | null {
  try {
    return decodeURIComponent(value)
  } catch {
    return null
  }
}

function isUnsafePathSegment(value: string): boolean {
  const raw = value.trim()
  const decoded = decodedSegment(raw)
  const decodedTrimmed = decoded === null ? null : decoded.trim()
  return raw.length === 0
    || decodedTrimmed === null
    || raw === "."
    || raw === ".."
    || decodedTrimmed === "."
    || decodedTrimmed === ".."
    || raw.includes("..")
    || decodedTrimmed.includes("..")
    || raw.includes("/")
    || raw.includes("\\")
    || decodedTrimmed.includes("/")
    || decodedTrimmed.includes("\\")
}

function unsafeRouteSegmentReason(friendId: string, channel: string, key: string): string | null {
  const segments = [
    ["friendId", friendId],
    ["channel", channel],
    ["key", key],
  ] as const
  for (const [name, value] of segments) {
    if (value.length > 0 && isUnsafePathSegment(value)) return `unsafe route ${name}: ${value}`
  }
  return null
}

async function resolveFriend(friendStore: FriendStore | undefined, rawFriendIdOrName: string): Promise<ResolvedFriend | null> {
  const raw = rawFriendIdOrName.trim()
  if (!raw) return null

  const direct = await friendStore?.get(raw)
  if (direct) {
    return { id: direct.id, name: direct.name, trustLevel: direct.trustLevel, isSelf: isSelfTarget(direct.id) }
  }

  const all = await friendStore?.listAll?.()
  const lowered = normalizeIdentifier(raw)
  const matched = all?.find((record) => normalizeIdentifier(record.id) === lowered || normalizeIdentifier(record.name) === lowered)
  if (matched) {
    return { id: matched.id, name: matched.name, trustLevel: matched.trustLevel, isSelf: isSelfTarget(matched.id) }
  }

  if (!friendStore) return { id: raw, name: raw, isSelf: false }
  return null
}

function unresolvedRoute(kind: HabitReturnRouteKind, recipient: string, reason: string): HabitReturnRoute {
  return { kind, recipient, status: "unresolved", reason }
}

function allowedRoute(kind: HabitReturnRouteKind, recipient: string, friendId?: string, channel?: string, key?: string): HabitReturnRoute {
  return {
    kind,
    recipient,
    status: "allowed",
    ...(friendId ? { friendId } : {}),
    ...(channel ? { channel } : {}),
    ...(key ? { key } : {}),
  }
}

async function resolveExactRoute(
  kind: "originator" | "extra",
  recipient: string,
  channel: string,
  key: string,
  options: NormalizeHabitPermissionOptions,
): Promise<{ route: HabitReturnRoute; warning?: string }> {
  const routeRecipient = `${recipient}/${channel}/${key}`
  const unsafeReason = unsafeRouteSegmentReason(recipient, channel, key)
  if (unsafeReason) {
    return { route: unresolvedRoute(kind, routeRecipient, unsafeReason), warning: unsafeReason }
  }
  if (isSelfTarget(recipient, channel, key)) {
    const warning = `${kind} route targets self/inner and cannot be used by a habit`
    return { route: unresolvedRoute(kind, routeRecipient, warning), warning }
  }
  const friend = await resolveFriend(options.friendStore, recipient)
  if (!friend) {
    const warning = `${kind} route recipient unresolved: ${recipient}`
    return { route: unresolvedRoute(kind, recipient, warning), warning }
  }
  const resolvedUnsafeReason = unsafeRouteSegmentReason(friend.id, channel, key)
  if (resolvedUnsafeReason) {
    return { route: unresolvedRoute(kind, routeRecipient, resolvedUnsafeReason), warning: resolvedUnsafeReason }
  }
  if (friend.isSelf || isSelfTarget(friend.id, channel, key)) {
    const warning = `${kind} route targets self/inner and cannot be used by a habit`
    return { route: unresolvedRoute(kind, routeRecipient, warning), warning }
  }
  return { route: allowedRoute(kind, recipient, friend.id, channel, key) }
}

function parseExtraRouteSpec(spec: string): { recipient: string; channel: string; key: string } | null {
  const parts = spec.split("/").map((part) => part.trim())
  if (parts.length !== 3 || parts.some((part) => part.length === 0)) return null
  return { recipient: parts[0], channel: parts[1], key: parts[2] }
}

export async function normalizeHabitPermissionEnvelope(
  habit: HabitFile,
  options: NormalizeHabitPermissionOptions,
): Promise<HabitPermissionEnvelope> {
  if (habit.status !== "active") {
    const envelope: HabitPermissionEnvelope = {
      schemaVersion: 1,
      canMessageOutward: false,
      returnRoutes: [],
      deniedTools: ["send_message", "surface"],
      warnings: [`habit status ${habit.status} is non-executable`],
    }
    emitNervesEvent({
      component: "daemon",
      event: "daemon.habit_permission_envelope_normalized",
      message: "habit permission envelope normalized",
      meta: { agentRoot: options.agentRoot, habitName: habit.name, routes: 0, canMessageOutward: false },
    })
    return envelope
  }
  const returnRoutes: HabitReturnRoute[] = []
  const warnings: string[] = []

  if (habit.surface.family) {
    returnRoutes.push(allowedRoute("family", "family"))
  }

  if (habit.surface.originator) {
    if (habit.origin) {
      const resolved = await resolveExactRoute("originator", habit.origin.friendId, habit.origin.channel, habit.origin.key, options)
      returnRoutes.push(resolved.route)
      if (resolved.warning) warnings.push(resolved.warning)
    } else {
      const warning = "originator route requested but habit has no origin"
      returnRoutes.push(unresolvedRoute("originator", "originator", warning))
      warnings.push(warning)
    }
  }

  for (const spec of habit.surface.extra) {
    const parsed = parseExtraRouteSpec(spec)
    if (!parsed) {
      const warning = `malformed extra route: ${spec}`
      returnRoutes.push(unresolvedRoute("extra", spec, warning))
      warnings.push(warning)
      continue
    }
    const resolved = await resolveExactRoute("extra", parsed.recipient, parsed.channel, parsed.key, options)
    returnRoutes.push(resolved.route)
    if (resolved.warning) warnings.push(resolved.warning)
  }

  const canMessageOutward = returnRoutes.some((route) => route.status === "allowed")
  const envelope: HabitPermissionEnvelope = {
    schemaVersion: 1,
    canMessageOutward,
    returnRoutes,
    deniedTools: canMessageOutward ? [] : ["send_message", "surface"],
    warnings,
  }
  emitNervesEvent({
    component: "daemon",
    event: "daemon.habit_permission_envelope_normalized",
    message: "habit permission envelope normalized",
    meta: { agentRoot: options.agentRoot, habitName: habit.name, routes: returnRoutes.length, canMessageOutward },
  })
  return envelope
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null
}

function resolveRouteTarget(input: ResolveHabitReturnRouteInput): RouteTarget | null {
  if (input.toolName === "send_message") {
    const friendId = readString(input.args.friendId)
    const channel = readString(input.args.channel)
    const key = readString(input.args.key)
    if (!friendId || !channel || !key) return null
    return {
      friendId,
      channel,
      key,
    }
  }

  if (input.toolName !== "surface") return null

  const delegationId = readString(input.args.delegationId)
  if (delegationId) {
    const origin = input.delegatedOrigins?.find((item) => item.id === delegationId)
    return origin ? { friendId: origin.friendId, channel: origin.channel, key: origin.key } : null
  }

  const friendId = readString(input.args.friendId)
  if (friendId) {
    const channel = readString(input.args.channel)
    const key = readString(input.args.key)
    if (!channel || !key) return null
    return {
      friendId,
      channel,
      key,
    }
  }

  if (input.delegatedOrigins?.length === 1) {
    const [origin] = input.delegatedOrigins
    return { friendId: origin.friendId, channel: origin.channel, key: origin.key }
  }

  return null
}

function isLiveVoiceAttempt(args: Record<string, string>, target: RouteTarget | null): boolean {
  const channel = normalizeIdentifier(readString(args.channel) ?? target?.channel ?? "")
  return channel === "voice"
    || readString(args.phoneNumber) !== null
    || Object.keys(args).some((key) => normalizeIdentifier(key).includes("voice") || normalizeIdentifier(key).includes("audio"))
}

function exactRouteMatches(route: HabitReturnRoute, target: RouteTarget): boolean {
  return route.status === "allowed"
    && route.kind !== "family"
    && route.friendId === target.friendId
    && route.channel === target.channel
    && route.key === target.key
}

function deniedRoute(reason: string): HabitReturnRouteResolution {
  return { allowed: false, reason }
}

export async function resolveHabitReturnRoute(input: ResolveHabitReturnRouteInput): Promise<HabitReturnRouteResolution> {
  const target = resolveRouteTarget(input)
  if (isLiveVoiceAttempt(input.args, target)) {
    return deniedRoute("live voice routes are not allowed from habit sessions")
  }
  if (!target) {
    return deniedRoute("habit tool call has no permitted return route target")
  }
  const unsafeReason = unsafeRouteSegmentReason(target.friendId, target.channel, target.key)
  if (unsafeReason) {
    return deniedRoute(`habit return route target is unsafe: ${unsafeReason}`)
  }
  if (isSelfTarget(target.friendId, target.channel, target.key)) {
    return deniedRoute("habit sessions cannot route messages to self/inner")
  }

  const friend = await resolveFriend(input.friendStore, target.friendId)
  if (!friend) return deniedRoute(`habit return route recipient unresolved: ${target.friendId}`)
  const resolvedUnsafeReason = unsafeRouteSegmentReason(friend.id, target.channel, target.key)
  if (resolvedUnsafeReason) {
    return deniedRoute(`habit return route target is unsafe: ${resolvedUnsafeReason}`)
  }
  if (friend.isSelf || isSelfTarget(friend.id, target.channel, target.key)) {
    return deniedRoute("habit sessions cannot route messages to self/inner")
  }

  const normalizedTarget = { ...target, friendId: friend.id }
  const exactRoute = input.envelope.returnRoutes.find((route) => exactRouteMatches(route, normalizedTarget))
  if (exactRoute) {
    return {
      allowed: true,
      routeKind: exactRoute.kind,
      friendId: friend.id,
      channel: target.channel,
      key: target.key,
    }
  }

  const familyRoute = input.envelope.returnRoutes.find((route) => route.kind === "family" && route.status === "allowed")
  if (familyRoute) {
    if (friend.trustLevel === "family") {
      return { allowed: true, routeKind: "family", friendId: friend.id, channel: target.channel, key: target.key }
    }
    return deniedRoute(`habit family route requires family trust for ${friend.id}`)
  }

  emitNervesEvent({
    level: "warn",
    component: "daemon",
    event: "daemon.habit_return_route_denied",
    message: "habit return route denied",
    meta: { agentRoot: input.agentRoot, toolName: input.toolName, friendId: friend.id },
  })
  return deniedRoute(`no habit return route allows ${friend.id}/${target.channel}/${target.key}`)
}

function toolName(definition: ToolDefinition): string {
  return definition.tool.function.name
}

function isOutwardMessagingTool(name: string): boolean {
  return name === "send_message" || name === "surface"
}

function isHighRisk(profile: ToolRiskProfile): boolean {
  return profile.risk === "high"
}

export function filterHabitToolsForEnvelope(
  definitions: ToolDefinition[],
  requestedTools: string[] | null,
  envelope: HabitPermissionEnvelope,
  riskClassifier: (definition: ToolDefinition, name: string) => ToolRiskProfile,
): HabitToolPolicy {
  const requested = requestedTools ? new Set(requestedTools) : null
  const grantedTools: string[] = []
  const deniedTools: string[] = []

  for (const definition of definitions) {
    const name = toolName(definition)
    if (requested && !requested.has(name)) continue

    const deniedByEnvelope = envelope.deniedTools.includes(name)
    const profile = riskClassifier(definition, name)
    const allowedOutward = isOutwardMessagingTool(name) && envelope.canMessageOutward && !deniedByEnvelope
    if (deniedByEnvelope || (isHighRisk(profile) && !allowedOutward)) {
      deniedTools.push(name)
      continue
    }
    grantedTools.push(name)
  }

  const policy: HabitToolPolicy = {
    requestedTools: requestedTools ? [...requestedTools] : null,
    grantedTools,
    deniedTools,
    outwardMessagingAllowed: envelope.canMessageOutward,
  }
  emitNervesEvent({
    component: "daemon",
    event: "daemon.habit_tool_policy_filtered",
    message: "habit tool policy filtered",
    meta: { requested: requestedTools?.length ?? null, granted: grantedTools.length, denied: deniedTools.length },
  })
  return policy
}

function computeNextRunAt(habit: HabitFile, endedAt: string): string | null {
  if (habit.status !== "active" || !habit.cadence) return null
  const endedMs = Date.parse(endedAt)
  if (!Number.isFinite(endedMs)) return null
  return nextCadenceRunAt(habit.cadence, endedMs)
}

function defaultSummarySnapshot(input: BuildHabitRunReceiptInput): HabitRunSummarySnapshot {
  const errors = input.errors ?? []
  const decisions = decisionsFromHabitRunTraceSteps(input.traceSteps)
  if (errors.length > 0) {
    return {
      summary: `Habit ${input.habit.name} finished with errors: ${errors.join("; ")}`,
      decisions,
      nextLikelyStep: null,
    }
  }
  const surfaced = (input.surfaceAttempts ?? []).find((attempt) =>
    attempt.result !== "blocked" && attempt.result !== "failed" && attempt.result !== "unavailable")
  if (surfaced) {
    return {
      summary: `Habit ${input.habit.name} surfaced via ${surfaced.recipient}/${surfaced.channel}.`,
      decisions,
      nextLikelyStep: null,
    }
  }
  const produced = (input.producedRefs ?? []).find((ref) => ref.kind !== "none")
  if (produced) {
    return {
      summary: `Habit ${input.habit.name} produced ${produced.kind}: ${produced.locator}.`,
      decisions,
      nextLikelyStep: null,
    }
  }
  return {
    summary: `Habit ${input.habit.name} finished with ${input.outcome}.`,
    decisions,
    nextLikelyStep: null,
  }
}

export function buildHabitRunReceipt(input: BuildHabitRunReceiptInput): HabitRunReceipt {
  const paths = createHabitSessionPaths(input.agentRoot, input.runId, input.habit.name)
  const receipt: HabitRunReceipt = {
    schemaVersion: 2,
    runId: input.runId,
    sessionId: input.runId,
    habitName: input.habit.name,
    trigger: input.trigger,
    startedAt: input.startedAt,
    endedAt: input.endedAt,
    outcome: input.outcome,
    definitionLocator: `habits/${input.habit.name}.md`,
    sessionLocator: paths.sessionLocator,
    pendingLocator: paths.pendingLocator,
    runtimeStateLocator: paths.runtimeStateLocator,
    receiptLocator: paths.receiptLocator,
    operationId: input.operationId ?? null,
    nextRunAt: input.nextRunAt ?? computeNextRunAt(input.habit, input.endedAt),
    permissionEnvelope: input.permissionEnvelope,
    toolPolicy: input.toolPolicy,
    summarySnapshot: input.summarySnapshot ?? defaultSummarySnapshot(input),
    producedRefs: input.producedRefs ?? [],
    surfaceAttempts: input.surfaceAttempts ?? [],
    traceSteps: input.traceSteps ?? [],
    errors: input.errors ?? [],
  }
  emitNervesEvent({
    component: "daemon",
    event: "daemon.habit_run_receipt_built",
    message: "habit run receipt built",
    meta: { agentRoot: input.agentRoot, habitName: input.habit.name, runId: input.runId, outcome: input.outcome },
  })
  return receipt
}

function successfulSurfaceAttempt(attempt: HabitSurfaceAttempt): boolean {
  return attempt.result !== "blocked"
    && attempt.result !== "failed"
    && attempt.result !== "unavailable"
}

function surfaceRefsFromAttempts(attempts: HabitSurfaceAttempt[]): FlightRecorderProducedRef[] {
  return attempts
    .filter(successfulSurfaceAttempt)
    .map((attempt) => ({
      kind: "surface",
      locator: `surface/${attempt.recipient}/${attempt.channel}`,
    }))
}

function habitOutcomeForCompletion(input: CompleteHabitRunInput): { outcome: HabitRunOutcome; producedRefs: FlightRecorderProducedRef[] } {
  const attempts = input.surfaceAttempts ?? []
  const producedRefs = input.producedRefs && input.producedRefs.length > 0
    ? [...input.producedRefs]
    : surfaceRefsFromAttempts(attempts)
  if ((input.errors ?? []).length > 0) return { outcome: "error", producedRefs }
  if (producedRefs.some((ref) => ref.kind === "surface")) return { outcome: "surfaced", producedRefs }
  if (producedRefs.some((ref) => ref.kind === "desk_record")) return { outcome: "wrote_record", producedRefs }
  if (producedRefs.some((ref) => ref.kind === "desk_task")) return { outcome: "updated_desk", producedRefs }
  if (producedRefs.some((ref) => ref.kind === "arc" || ref.kind === "claim")) return { outcome: "wrote_arc", producedRefs }
  if (attempts.length > 0 && attempts.every((attempt) => !successfulSurfaceAttempt(attempt))) {
    return { outcome: "blocked", producedRefs }
  }
  return { outcome: "no_change", producedRefs }
}

export function completeHabitRun(input: CompleteHabitRunInput): CompleteHabitRunResult {
  const { outcome, producedRefs } = habitOutcomeForCompletion(input)
  let receipt: HabitRunReceipt
  try {
    receipt = buildHabitRunReceipt({
      agentRoot: input.agentRoot,
      habit: input.habit,
      runId: input.runId,
      trigger: input.trigger,
      startedAt: input.startedAt,
      endedAt: input.endedAt,
      outcome,
      operationId: input.operationId ?? null,
      permissionEnvelope: input.permissionEnvelope,
      toolPolicy: input.toolPolicy,
      producedRefs,
      surfaceAttempts: input.surfaceAttempts,
      traceSteps: input.traceSteps,
      errors: input.errors,
      summarySnapshot: input.summarySnapshot,
    })
    writeHabitRunReceipt(input.agentRoot, receipt)
  } catch (error) {
    emitNervesEvent({
      level: "error",
      component: "senses",
      event: "senses.habit_receipt_write_error",
      message: "habit receipt could not be written; runtime state was not advanced",
      meta: {
        habitName: input.habit.name,
        runId: input.runId,
        error: String(error),
      },
    })
    return { outcome, producedRefs, receiptWritten: false, runtimeStateRecorded: false }
  }
  try {
    recordHabitRun(input.agentRoot, input.habit.name, input.endedAt, {
      definitionPath: path.join(input.agentRoot, "habits", `${input.habit.name}.md`),
      activeOperationId: receipt.operationId ?? null,
      latestRunId: receipt.runId,
      latestReceiptLocator: receipt.receiptLocator,
    })
    return { outcome, producedRefs, receiptWritten: true, runtimeStateRecorded: true }
  } catch (error) {
    emitNervesEvent({
      level: "warn",
      component: "senses",
      event: "senses.habit_runtime_state_record_error",
      message: "habit runtime state could not be updated after receipt write",
      meta: {
        habitName: input.habit.name,
        runId: input.runId,
        error: String(error),
      },
    })
    return { outcome, producedRefs, receiptWritten: true, runtimeStateRecorded: false }
  }
}
