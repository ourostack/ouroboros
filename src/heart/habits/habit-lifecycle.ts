import { createHash, randomUUID as createRandomUuid } from "node:crypto"
import { execFileSync } from "node:child_process"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

import Database from "better-sqlite3"

import { emitNervesEvent } from "../../nerves/runtime"

export const HABIT_LIFECYCLE_POLL_MS = 50
export const HABIT_LIFECYCLE_TIMEOUT_MS = 5_000

const HASH_PATTERN = /^[a-f0-9]{64}$/
const UUID_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i
const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
const OWNER_KEYS = [
  "schemaVersion",
  "operationId",
  "pid",
  "bootIdentity",
  "processStartedAt",
  "acquiredAt",
] as const
const JOURNAL_KEYS = [
  "schemaVersion",
  "habitId",
  "operationId",
  "operationKind",
  "state",
  "updatedAt",
  "generation",
  "evidenceKeyHash",
  "cancellationPreparation",
  "intentAt",
  "transportInvokedAt",
  "classifiedAt",
  "boundaryState",
  "transportResult",
] as const
const RECEIPT_KEYS = [
  "schemaVersion",
  "habitId",
  "operationId",
  "evidenceKeyHash",
  "evidenceLocator",
  "actor",
  "request",
  "transition",
  "acknowledgement",
  "createdAt",
] as const

export type HabitLifecycleOwnerStatus = "live" | "recoverable" | "unknown"
export type HabitProcessLiveness = "alive" | "missing" | "unknown"
export type HabitBoundaryState = "not_crossed" | "crossing_unknown" | "crossed"
export type HabitLifecycleOperationKind = "cancel" | "send"
export type HabitLifecycleJournalState =
  | "lock_acquired"
  | "cancellation_intent"
  | "definition_cancelled"
  | "cancellation_receipt_committed"
  | "send_intent"
  | HabitBoundaryState

export interface HabitLifecycleOwner {
  schemaVersion: 1
  operationId: string
  pid: number
  bootIdentity: string
  processStartedAt: string
  acquiredAt: string
}

export interface HabitTransportResult {
  httpStatus: number | null
  messageGuid: string | null
  errorCode: string | null
}

export interface HabitLifecycleJournal {
  schemaVersion: 1
  habitId: string
  operationId: string
  operationKind: HabitLifecycleOperationKind
  state: HabitLifecycleJournalState
  updatedAt: string
  generation: number
  evidenceKeyHash: string | null
  cancellationPreparation: HabitCancellationPreparation | null
  intentAt: string | null
  transportInvokedAt: string | null
  classifiedAt: string | null
  boundaryState: HabitBoundaryState | null
  transportResult: HabitTransportResult | null
}

export interface HabitCancellationReceipt {
  schemaVersion: 1
  habitId: string
  operationId: string
  evidenceKeyHash: string
  evidenceLocator: {
    kind: "bridge" | "capture"
    id: string
  }
  actor: {
    displayName: string
    provider: string | null
    externalId: string | null
  }
  request: {
    text: string
    sha256: string
    observedAt: string
  }
  transition: {
    fromStatus: "active" | "paused"
    toStatus: "cancelled"
    cancelledAt: string
    boundaryState: HabitBoundaryState
  }
  acknowledgement: string
  createdAt: string
}

export interface HabitCancellationPreparation {
  receipt: HabitCancellationReceipt
  definitionBeforeSha256: string
  definitionCancelledSha256: string
}

export interface HabitLifecyclePaths {
  root: string
  coordination: string
  owner: string
  journalDirectory: string
  journal?: string
  receiptsDirectory: string
  receipt?: string
}

export interface HabitLifecycleFileIdentity {
  dev: number
  ino: number
}

export interface HabitLifecycleLease {
  agentRoot: string
  habitId: string
  operationId: string
  ownerPath: string
  owner: HabitLifecycleOwner
  ownerBytes: string
  ownerIdentity: HabitLifecycleFileIdentity
}

export interface HabitLifecycleDeps {
  fs?: typeof fs
  now?: () => Date
  pid?: () => number
  bootIdentity?: () => string
  processStartedAt?: (pid: number) => string | null
  processLiveness?: (pid: number) => HabitProcessLiveness
  randomUUID?: () => string
  sleep?: (milliseconds: number) => Promise<void>
  platform?: NodeJS.Platform
  execFileSync?: typeof execFileSync
  kill?: typeof process.kill
  uptime?: () => number
  beforeOwnerRecovery?: () => void
}

export type HabitLifecycleLockResult =
  | { status: "acquired"; lease: HabitLifecycleLease }
  | { status: "timeout"; error: "lifecycle_lock_timeout" }

export class HabitLifecycleError extends Error {
  readonly code: string
  readonly durabilityUnknown: boolean

  constructor(code: string, options: { durabilityUnknown?: boolean; cause?: unknown } = {}) {
    super(code)
    if (options.cause !== undefined) {
      Object.defineProperty(this, "cause", {
        value: options.cause,
        configurable: true,
        writable: true,
      })
    }
    this.name = "HabitLifecycleError"
    this.code = code
    this.durabilityUnknown = options.durabilityUnknown ?? false
  }
}

interface OwnerSnapshot {
  status: "missing" | "invalid" | "valid"
  bytes?: string
  identity?: HabitLifecycleFileIdentity
  owner?: HabitLifecycleOwner
}

interface OwnerClassification {
  status: HabitLifecycleOwnerStatus
  probeError: boolean
}

type CoordinationAttempt<T> =
  | { status: "completed"; value: T }
  | { status: "busy" }

type AcquireAttempt =
  | { status: "acquired"; lease: HabitLifecycleLease; recoveredOwner: boolean }
  | { status: "wait"; ownerStatus: HabitLifecycleOwnerStatus; probeError: boolean }

export function serializeHabitLifecycleJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`
}

export function getHabitLifecyclePaths(input: {
  agentRoot: string
  habitId: string
  operationId?: string
  evidenceKeyHash?: string
}): HabitLifecyclePaths {
  const agentRoot = requiredString(input.agentRoot, "agent_root_required")
  const habitId = validatedHabitId(input.habitId)
  if (input.operationId !== undefined) validatedOperationId(input.operationId)
  if (input.evidenceKeyHash !== undefined) validatedHash(input.evidenceKeyHash, "evidence_key_hash_invalid")
  const root = path.join(agentRoot, "state", "habits", "lifecycle", sha256(habitId))
  const journalDirectory = path.join(root, "journal")
  const receiptsDirectory = path.join(root, "receipts")
  return {
    root,
    coordination: path.join(root, "coordination.sqlite"),
    owner: path.join(root, "owner.lock"),
    journalDirectory,
    ...(input.operationId === undefined
      ? {}
      : { journal: path.join(journalDirectory, `${sha256(input.operationId)}.json`) }),
    receiptsDirectory,
    ...(input.evidenceKeyHash === undefined
      ? {}
      : { receipt: path.join(receiptsDirectory, `${input.evidenceKeyHash}.json`) }),
  }
}

export function buildHabitEvidenceIdentity(input: {
  habitId: string
  kind: "bridge" | "capture"
  id: string
}): { canonicalKey: string; evidenceKeyHash: string } {
  const habitId = validatedHabitId(input.habitId)
  if (input.kind !== "bridge" && input.kind !== "capture") {
    throw new HabitLifecycleError("evidence_kind_invalid")
  }
  const id = requiredString(input.id, "evidence_id_required")
  if (input.kind === "capture") validatedHash(id, "evidence_id_invalid")
  if (/[/\\\0\r\n]/.test(id)) throw new HabitLifecycleError("evidence_id_invalid")
  const canonicalKey = JSON.stringify(["habit-evidence-v1", habitId, input.kind, id])
  return { canonicalKey, evidenceKeyHash: sha256(canonicalKey) }
}

export function buildHabitCancellationOperation(evidenceKeyHash: string): {
  operationId: string
  operationIdHash: string
} {
  const hash = validatedHash(evidenceKeyHash, "evidence_key_hash_invalid")
  const operationId = `cancel:${hash}`
  return { operationId, operationIdHash: sha256(operationId) }
}

export function buildHabitSendOperation(input: {
  habitId: string
  outboundIdempotencyKey: string
}): { canonicalKey: string; operationHash: string; operationId: string } {
  const habitId = validatedHabitId(input.habitId)
  const outboundIdempotencyKey = requiredString(
    input.outboundIdempotencyKey,
    "outbound_idempotency_key_required",
  )
  const canonicalKey = JSON.stringify(["habit-send-v1", habitId, outboundIdempotencyKey])
  const operationHash = sha256(canonicalKey)
  return { canonicalKey, operationHash, operationId: `send:${operationHash}` }
}

export function buildHabitLifecycleOwner(input: {
  operationId: string
  pid: number
  bootIdentity: string
  processStartedAt: string
  acquiredAt: string
}): HabitLifecycleOwner {
  return {
    schemaVersion: 1,
    operationId: validatedOperationId(input.operationId),
    pid: validatedPid(input.pid),
    bootIdentity: requiredString(input.bootIdentity, "boot_identity_invalid"),
    processStartedAt: requiredString(input.processStartedAt, "process_started_at_invalid"),
    acquiredAt: validatedTimestamp(input.acquiredAt, "acquired_at_invalid"),
  }
}

export function probeHabitBootIdentity(deps: HabitLifecycleDeps = {}): string {
  if (deps.bootIdentity) return requiredString(deps.bootIdentity(), "boot_identity_invalid")
  const platform = deps.platform ?? process.platform
  const storeFs = deps.fs ?? fs
  const run = deps.execFileSync ?? execFileSync
  if (platform === "linux") {
    return requiredString(
      storeFs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim(),
      "boot_identity_invalid",
    )
  }
  if (platform === "darwin" || platform === "freebsd") {
    const output = run("/usr/sbin/sysctl", ["-n", "kern.boottime"], { encoding: "utf8" })
    return sha256(String(output))
  }
  if (platform === "win32") {
    const output = run(
      "powershell.exe",
      [
        "-NoProfile",
        "-Command",
        "(Get-CimInstance Win32_OperatingSystem).LastBootUpTime.ToUniversalTime().Ticks",
      ],
      { encoding: "utf8" },
    )
    return sha256(String(output))
  }
  const uptime = deps.uptime ?? os.uptime
  const now = lifecycleNow(deps).getTime()
  return sha256(`${platform}:${Math.round((now - (uptime() * 1_000)) / 1_000)}`)
}

export function probeHabitProcessStartedAt(pid: number, deps: HabitLifecycleDeps = {}): string | null {
  const validPid = validatedPid(pid)
  if (deps.processStartedAt) return deps.processStartedAt(validPid)
  const platform = deps.platform ?? process.platform
  const storeFs = deps.fs ?? fs
  const run = deps.execFileSync ?? execFileSync
  if (platform === "linux") {
    try {
      const stat = storeFs.readFileSync(`/proc/${validPid}/stat`, "utf8")
      const closeParen = stat.lastIndexOf(")")
      if (closeParen < 0) return null
      const fields = stat.slice(closeParen + 2).trim().split(/\s+/)
      return fields[19] ? `linux:${fields[19]}` : null
    } catch (error) {
      if (isNodeError(error, "ENOENT") || isNodeError(error, "ESRCH")) return null
      throw error
    }
  }
  if (platform === "win32") {
    try {
      const output = run(
        "powershell.exe",
        ["-NoProfile", "-Command", `(Get-Process -Id ${validPid}).StartTime.ToUniversalTime().Ticks`],
        { encoding: "utf8" },
      ).trim()
      return output ? `win32:${output}` : null
    } catch {
      return null
    }
  }
  try {
    const output = run("/bin/ps", ["-o", "lstart=", "-p", String(validPid)], {
      encoding: "utf8",
    }).trim()
    return output ? `${platform}:${output}` : null
  } catch {
    return null
  }
}

export function probeHabitProcessLiveness(pid: number, deps: HabitLifecycleDeps = {}): HabitProcessLiveness {
  const validPid = validatedPid(pid)
  if (deps.processLiveness) return deps.processLiveness(validPid)
  const kill = deps.kill ?? process.kill
  try {
    kill(validPid, 0)
    return "alive"
  } catch (error) {
    if (isNodeError(error, "ESRCH")) return "missing"
    return "unknown"
  }
}

export function classifyHabitLifecycleOwner(
  owner: HabitLifecycleOwner,
  deps: HabitLifecycleDeps = {},
): HabitLifecycleOwnerStatus {
  return classifyOwner(owner, deps).status
}

export async function acquireHabitLifecycleLock(
  input: { agentRoot: string; habitId: string; operationId: string },
  deps: HabitLifecycleDeps = {},
): Promise<HabitLifecycleLockResult> {
  const paths = getHabitLifecyclePaths(input)
  const habitId = validatedHabitId(input.habitId)
  const operationId = validatedOperationId(input.operationId)
  emitNervesEvent({
    component: "daemon",
    event: "daemon.habit_lifecycle_lock_start",
    message: "habit lifecycle lock acquisition started",
    meta: { habitId, operationId },
  })

  let candidate: HabitLifecycleOwner
  try {
    const pid = lifecyclePid(deps)
    const processStartedAt = probeHabitProcessStartedAt(pid, deps)
    if (processStartedAt === null || processStartedAt.length === 0) {
      throw new HabitLifecycleError("process_started_at_invalid")
    }
    candidate = buildHabitLifecycleOwner({
      operationId,
      pid,
      bootIdentity: probeHabitBootIdentity(deps),
      processStartedAt,
      acquiredAt: lifecycleNow(deps).toISOString(),
    })
  } catch (error) {
    const wrapped = asLifecycleError(error, "lifecycle_lock_failed")
    emitLockError(habitId, operationId, wrapped.code, "unknown", true)
    throw wrapped
  }

  const startedAt = lifecycleNow(deps).getTime()
  let lastOwnerStatus: HabitLifecycleOwnerStatus = "unknown"
  let lastProbeError = false
  while (true) {
    let coordinated: CoordinationAttempt<AcquireAttempt>
    try {
      coordinated = withCoordination(paths, 0, () => acquireUnderCoordination(
        paths,
        input.agentRoot,
        habitId,
        operationId,
        candidate,
        deps,
      ))
    } catch (error) {
      const wrapped = asLifecycleError(error, "lifecycle_lock_failed")
      emitLockError(habitId, operationId, wrapped.code, lastOwnerStatus, lastProbeError)
      throw wrapped
    }
    if (coordinated.status === "completed") {
      const attempt = coordinated.value
      if (attempt.status === "acquired") {
        emitNervesEvent({
          component: "daemon",
          event: "daemon.habit_lifecycle_lock_end",
          message: "habit lifecycle lock acquired",
          meta: {
            habitId,
            operationId,
            recoveredOwner: attempt.recoveredOwner,
            recoveredOwnerStatus: attempt.recoveredOwner ? "recoverable" : null,
          },
        })
        return { status: "acquired", lease: attempt.lease }
      }
      lastOwnerStatus = attempt.ownerStatus
      lastProbeError = attempt.probeError
    }

    if (lifecycleNow(deps).getTime() - startedAt >= HABIT_LIFECYCLE_TIMEOUT_MS) {
      emitLockError(
        habitId,
        operationId,
        "lifecycle_lock_timeout",
        lastOwnerStatus,
        lastProbeError,
      )
      return { status: "timeout", error: "lifecycle_lock_timeout" }
    }
    await lifecycleSleep(HABIT_LIFECYCLE_POLL_MS, deps)
  }
}

export function releaseHabitLifecycleLock(
  lease: HabitLifecycleLease,
  deps: HabitLifecycleDeps = {},
): boolean {
  const paths = getHabitLifecyclePaths({ agentRoot: lease.agentRoot, habitId: lease.habitId })
  const attempt = withCoordination(paths, 0, () => {
    const snapshot = inspectOwner(paths.owner, deps.fs ?? fs)
    if (!snapshotMatchesLease(snapshot, lease)) return false
    const storeFs = deps.fs ?? fs
    storeFs.unlinkSync(paths.owner)
    fsyncDirectory(paths.root, storeFs)
    return true
  })
  if (attempt.status === "busy") return false
  return attempt.value
}

export function habitLifecycleLeaseIsCurrent(
  lease: HabitLifecycleLease,
  deps: Pick<HabitLifecycleDeps, "fs"> = {},
): boolean {
  return snapshotMatchesLease(inspectOwner(lease.ownerPath, deps.fs ?? fs, true), lease)
}

export function confirmHabitLifecyclePathDurability(
  lease: HabitLifecycleLease,
  filePath: string,
  deps: HabitLifecycleDeps = {},
): void {
  const storeFs = deps.fs ?? fs
  let descriptor: number | null = null
  try {
    assertLease(lease, storeFs)
    const resolvedPath = path.resolve(requiredString(filePath, "definition_path_invalid"))
    const resolvedRoot = path.resolve(lease.agentRoot)
    if (!resolvedPath.startsWith(`${resolvedRoot}${path.sep}`)) {
      throw new HabitLifecycleError("definition_path_invalid")
    }
    descriptor = storeFs.openSync(resolvedPath, "r")
    storeFs.fsyncSync(descriptor)
    storeFs.closeSync(descriptor)
    descriptor = null
    fsyncDirectory(path.dirname(resolvedPath), storeFs)
  } catch (error) {
    if (descriptor !== null) bestEffortClose(descriptor, storeFs)
    const wrapped = error instanceof HabitLifecycleError && error.code === "lifecycle_lease_lost"
      ? error
      : new HabitLifecycleError("lifecycle_durability_unknown", {
        durabilityUnknown: true,
        cause: error,
      })
    emitWriteError(lease, wrapped)
    throw wrapped
  }
}

export function createHabitLifecycleJournal(input: {
  habitId: string
  operationId: string
  operationKind: HabitLifecycleOperationKind
  updatedAt: string
}): HabitLifecycleJournal {
  const habitId = validatedHabitId(input.habitId)
  const operationId = validatedOperationId(input.operationId)
  if (input.operationKind !== "cancel" && input.operationKind !== "send") {
    throw new HabitLifecycleError("lifecycle_operation_kind_invalid")
  }
  if (!operationId.startsWith(`${input.operationKind}:`)) {
    throw new HabitLifecycleError("lifecycle_operation_kind_invalid")
  }
  return {
    schemaVersion: 1,
    habitId,
    operationId,
    operationKind: input.operationKind,
    state: "lock_acquired",
    updatedAt: validatedTimestamp(input.updatedAt, "lifecycle_timestamp_invalid"),
    generation: 0,
    evidenceKeyHash: null,
    cancellationPreparation: null,
    intentAt: null,
    transportInvokedAt: null,
    classifiedAt: null,
    boundaryState: null,
    transportResult: null,
  }
}

export function transitionHabitLifecycleJournal(
  current: HabitLifecycleJournal,
  transition:
    | { state: "lock_acquired"; at: string }
    | {
      state: "cancellation_intent"
      at: string
      evidenceKeyHash: string
      cancellationPreparation: HabitCancellationPreparation
    }
    | { state: "definition_cancelled"; at: string; boundaryState: HabitBoundaryState }
    | { state: "cancellation_receipt_committed"; at: string }
    | { state: "send_intent"; at: string }
    | {
      state: HabitBoundaryState
      at: string
      transportInvokedAt: string | null
      transportResult: HabitTransportResult
    },
): HabitLifecycleJournal {
  if (!isValidJournal(current)) throw new HabitLifecycleError("lifecycle_journal_invalid")
  const edge = `${current.operationKind}:${current.state}->${transition.state}`
  const permitted = new Set([
    "cancel:lock_acquired->cancellation_intent",
    "cancel:cancellation_intent->definition_cancelled",
    "cancel:definition_cancelled->cancellation_receipt_committed",
    "send:lock_acquired->send_intent",
    "send:send_intent->not_crossed",
    "send:send_intent->crossing_unknown",
    "send:send_intent->crossed",
  ])
  if (!permitted.has(edge)) throw new HabitLifecycleError("lifecycle_transition_invalid")
  const at = validatedTimestamp(transition.at, "lifecycle_timestamp_invalid")
  const next: HabitLifecycleJournal = {
    schemaVersion: 1,
    habitId: current.habitId,
    operationId: current.operationId,
    operationKind: current.operationKind,
    state: transition.state,
    updatedAt: at,
    generation: current.generation + 1,
    evidenceKeyHash: current.evidenceKeyHash,
    cancellationPreparation: current.cancellationPreparation,
    intentAt: current.intentAt,
    transportInvokedAt: current.transportInvokedAt,
    classifiedAt: current.classifiedAt,
    boundaryState: current.boundaryState,
    transportResult: current.transportResult,
  }
  if (transition.state === "cancellation_intent") {
    next.evidenceKeyHash = validatedHash(transition.evidenceKeyHash, "evidence_key_hash_invalid")
    next.cancellationPreparation = validatedCancellationPreparation(
      transition.cancellationPreparation,
      current.habitId,
      current.operationId,
      next.evidenceKeyHash,
    )
    next.intentAt = at
  } else if (transition.state === "definition_cancelled") {
    next.classifiedAt = at
    next.boundaryState = validatedBoundaryState(transition.boundaryState)
    if (next.boundaryState !== current.cancellationPreparation?.receipt.transition.boundaryState) {
      throw new HabitLifecycleError("lifecycle_transition_invalid")
    }
  } else if (transition.state === "send_intent") {
    next.intentAt = at
  } else if (
    transition.state === "not_crossed"
    || transition.state === "crossing_unknown"
    || transition.state === "crossed"
  ) {
    next.transportInvokedAt = transition.transportInvokedAt === null
      ? null
      : validatedTimestamp(transition.transportInvokedAt, "lifecycle_timestamp_invalid")
    next.classifiedAt = at
    next.boundaryState = transition.state
    next.transportResult = validatedTransportResult(transition.transportResult)
  }
  if (!isValidJournal(next)) throw new HabitLifecycleError("lifecycle_transition_invalid")
  return next
}

export function writeHabitLifecycleJournal(
  lease: HabitLifecycleLease,
  journal: HabitLifecycleJournal,
  deps: HabitLifecycleDeps = {},
): void {
  try {
    if (
      !isValidJournal(journal)
      || journal.habitId !== lease.habitId
      || journal.operationId !== lease.operationId
    ) throw new HabitLifecycleError("lifecycle_journal_invalid")
    const paths = getHabitLifecyclePaths({
      agentRoot: lease.agentRoot,
      habitId: lease.habitId,
      operationId: lease.operationId,
    })
    writeMutableLifecycleFile(lease, paths.journal!, serializeHabitLifecycleJson(journal), deps)
  } catch (error) {
    emitWriteError(lease, error)
    throw error
  }
}

export function readHabitLifecycleJournal(input: {
  agentRoot: string
  habitId: string
  operationId: string
}, deps: Pick<HabitLifecycleDeps, "fs"> = {}): HabitLifecycleJournal | null {
  const paths = getHabitLifecyclePaths(input)
  const storeFs = deps.fs ?? fs
  let bytes: string
  try {
    bytes = storeFs.readFileSync(paths.journal!, "utf8")
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return null
    throw new HabitLifecycleError("lifecycle_journal_read_failed", { cause: error })
  }
  const value = parseJson(bytes, "lifecycle_journal_invalid")
  if (
    !isValidJournal(value)
    || value.habitId !== input.habitId
    || value.operationId !== input.operationId
    || serializeHabitLifecycleJson(value) !== bytes
  ) throw new HabitLifecycleError("lifecycle_journal_invalid")
  return value
}

export function listHabitLifecycleJournals(input: {
  agentRoot: string
  habitId: string
}, deps: Pick<HabitLifecycleDeps, "fs"> = {}): HabitLifecycleJournal[] {
  const paths = getHabitLifecyclePaths(input)
  const storeFs = deps.fs ?? fs
  let names: string[]
  try {
    names = storeFs.readdirSync(paths.journalDirectory)
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return []
    throw new HabitLifecycleError("lifecycle_journal_read_failed", { cause: error })
  }
  const journals: HabitLifecycleJournal[] = []
  for (const name of names.filter((entry) => HASH_PATTERN.test(entry.slice(0, -5)) && entry.endsWith(".json")).sort()) {
    const journalPath = path.join(paths.journalDirectory, name)
    let bytes: string
    try {
      bytes = storeFs.readFileSync(journalPath, "utf8")
    } catch (error) {
      throw new HabitLifecycleError("lifecycle_journal_read_failed", { cause: error })
    }
    const value = parseJson(bytes, "lifecycle_journal_invalid")
    if (
      !isValidJournal(value)
      || value.habitId !== input.habitId
      || sha256(value.operationId) !== name.slice(0, -5)
      || serializeHabitLifecycleJson(value) !== bytes
    ) throw new HabitLifecycleError("lifecycle_journal_invalid")
    journals.push(value)
  }
  return journals
}

export function writeHabitLifecycleDefinition(
  lease: HabitLifecycleLease,
  definitionPath: string,
  bytes: string,
  deps: HabitLifecycleDeps = {},
): void {
  try {
    const resolvedDefinition = path.resolve(requiredString(definitionPath, "definition_path_invalid"))
    const resolvedRoot = path.resolve(lease.agentRoot)
    if (!resolvedDefinition.startsWith(`${resolvedRoot}${path.sep}`)) {
      throw new HabitLifecycleError("definition_path_invalid")
    }
    if (typeof bytes !== "string") throw new HabitLifecycleError("definition_bytes_invalid")
    writeMutableLifecycleFile(lease, resolvedDefinition, bytes, deps)
  } catch (error) {
    emitWriteError(lease, error)
    throw error
  }
}

/** Publish a new habit definition without ever replacing an existing path.
 * This is the creation-side counterpart to lease-owned definition mutation:
 * concurrent creators race at link(2), while cancellation remains the sole
 * cooperative writer allowed to replace an existing definition. */
export function publishNewHabitDefinition(
  input: { agentRoot: string; habitId: string; bytes: string },
  deps: Pick<HabitLifecycleDeps, "fs" | "randomUUID"> = {},
): "published" | "exists" {
  const storeFs = deps.fs ?? fs
  const agentRoot = path.resolve(requiredString(input.agentRoot, "agent_root_required"))
  const habitId = validatedHabitId(input.habitId)
  if (typeof input.bytes !== "string") throw new HabitLifecycleError("definition_bytes_invalid")
  const definitionPath = path.join(agentRoot, "habits", `${habitId}.md`)
  const directoryPath = path.dirname(definitionPath)
  storeFs.mkdirSync(directoryPath, { recursive: true })
  const tempPath = lifecycleTempPath(definitionPath, deps)
  let tempFd: number | null = null
  let tempOwned = false
  let published = false
  try {
    tempFd = storeFs.openSync(tempPath, "wx", 0o600)
    tempOwned = true
    storeFs.writeFileSync(tempFd, input.bytes, "utf8")
    storeFs.fsyncSync(tempFd)
    storeFs.closeSync(tempFd)
    tempFd = null
    try {
      storeFs.linkSync(tempPath, definitionPath)
      published = true
    } catch (error) {
      if (!isNodeError(error, "EEXIST")) throw error
    }
    if (published) fsyncDirectory(directoryPath, storeFs)
  } catch (error) {
    if (tempFd !== null) bestEffortClose(tempFd, storeFs)
    if (tempOwned) bestEffortUnlink(tempPath, storeFs)
    throw new HabitLifecycleError(
      published ? "lifecycle_durability_unknown" : "lifecycle_write_failed",
      { durabilityUnknown: published, cause: error },
    )
  }
  if (tempOwned) bestEffortUnlink(tempPath, storeFs)
  return published ? "published" : "exists"
}

export function publishHabitLifecycleReceipt(
  lease: HabitLifecycleLease,
  evidenceKeyHash: string,
  receipt: HabitCancellationReceipt,
  deps: HabitLifecycleDeps = {},
): "published" | "duplicate" {
  try {
    assertLease(lease, deps.fs ?? fs)
    const hash = validatedHash(evidenceKeyHash, "evidence_key_hash_invalid")
    if (
      !isValidCancellationReceipt(receipt)
      || receipt.habitId !== lease.habitId
      || receipt.operationId !== lease.operationId
      || receipt.evidenceKeyHash !== hash
    ) throw new HabitLifecycleError("lifecycle_receipt_invalid")
    const paths = getHabitLifecyclePaths({
      agentRoot: lease.agentRoot,
      habitId: lease.habitId,
      evidenceKeyHash: hash,
    })
    const bytes = serializeHabitLifecycleJson(receipt)
    const publication = publishImmutableLifecycleFile(lease, paths.receipt!, bytes, deps)
    if (publication === "published") return "published"
    const existing = readHabitLifecycleReceipt({
      agentRoot: lease.agentRoot,
      habitId: lease.habitId,
      evidenceKeyHash: hash,
    }, deps)
    if (existing !== null && serializeHabitLifecycleJson(existing) === bytes) return "duplicate"
    throw new HabitLifecycleError("lifecycle_receipt_collision")
  } catch (error) {
    emitWriteError(lease, error)
    throw error
  }
}

export function readHabitLifecycleReceipt(input: {
  agentRoot: string
  habitId: string
  evidenceKeyHash: string
}, deps: Pick<HabitLifecycleDeps, "fs"> = {}): HabitCancellationReceipt | null {
  const paths = getHabitLifecyclePaths(input)
  const storeFs = deps.fs ?? fs
  let bytes: string
  try {
    bytes = storeFs.readFileSync(paths.receipt!, "utf8")
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return null
    throw new HabitLifecycleError("lifecycle_receipt_read_failed", { cause: error })
  }
  const value = parseJson(bytes, "lifecycle_receipt_invalid")
  if (
    !isValidCancellationReceipt(value)
    || value.habitId !== input.habitId
    || value.evidenceKeyHash !== input.evidenceKeyHash
    || serializeHabitLifecycleJson(value) !== bytes
  ) throw new HabitLifecycleError("lifecycle_receipt_invalid")
  return value
}

function acquireUnderCoordination(
  paths: HabitLifecyclePaths,
  agentRoot: string,
  habitId: string,
  operationId: string,
  candidate: HabitLifecycleOwner,
  deps: HabitLifecycleDeps,
): AcquireAttempt {
  const storeFs = deps.fs ?? fs
  const observed = inspectOwner(paths.owner, storeFs)
  if (observed.status === "missing") {
    const identity = publishOwner(paths, candidate, deps)
    return {
      status: "acquired",
      lease: buildLease(agentRoot, habitId, operationId, paths.owner, candidate, identity),
      recoveredOwner: false,
    }
  }
  if (observed.status === "invalid") {
    return { status: "wait", ownerStatus: "unknown", probeError: false }
  }
  const classification = classifyOwner(observed.owner!, deps)
  if (classification.status !== "recoverable") {
    return { status: "wait", ownerStatus: classification.status, probeError: classification.probeError }
  }

  deps.beforeOwnerRecovery?.()
  const revalidated = inspectOwner(paths.owner, storeFs)
  if (!sameOwnerSnapshot(observed, revalidated)) {
    if (revalidated.status !== "valid") {
      return { status: "wait", ownerStatus: "unknown", probeError: false }
    }
    const successor = classifyOwner(revalidated.owner!, deps)
    return { status: "wait", ownerStatus: successor.status, probeError: successor.probeError }
  }
  storeFs.unlinkSync(paths.owner)
  fsyncDirectory(paths.root, storeFs)
  const identity = publishOwner(paths, candidate, deps)
  return {
    status: "acquired",
    lease: buildLease(agentRoot, habitId, operationId, paths.owner, candidate, identity),
    recoveredOwner: true,
  }
}

function buildLease(
  agentRoot: string,
  habitId: string,
  operationId: string,
  ownerPath: string,
  owner: HabitLifecycleOwner,
  ownerIdentity: HabitLifecycleFileIdentity,
): HabitLifecycleLease {
  return {
    agentRoot,
    habitId,
    operationId,
    ownerPath,
    owner,
    ownerBytes: serializeHabitLifecycleJson(owner),
    ownerIdentity,
  }
}

function publishOwner(
  paths: HabitLifecyclePaths,
  owner: HabitLifecycleOwner,
  deps: HabitLifecycleDeps,
): HabitLifecycleFileIdentity {
  const storeFs = deps.fs ?? fs
  storeFs.mkdirSync(paths.root, { recursive: true })
  const tempPath = lifecycleTempPath(paths.owner, deps)
  const bytes = serializeHabitLifecycleJson(owner)
  let tempFd: number | null = null
  let tempOwned = false
  let published = false
  let publishedIdentity: HabitLifecycleFileIdentity | null = null
  try {
    tempFd = storeFs.openSync(tempPath, "wx", 0o600)
    tempOwned = true
    storeFs.writeFileSync(tempFd, bytes, "utf8")
    storeFs.fsyncSync(tempFd)
    storeFs.closeSync(tempFd)
    tempFd = null
    storeFs.linkSync(tempPath, paths.owner)
    published = true
    publishedIdentity = fileIdentity(storeFs.lstatSync(paths.owner))
    fsyncDirectory(paths.root, storeFs)
  } catch (error) {
    if (tempFd !== null) bestEffortClose(tempFd, storeFs)
    if (published) {
      try {
        const snapshot = inspectOwner(paths.owner, storeFs)
        if (
          snapshot.status === "valid"
          && snapshot.bytes === bytes
          && publishedIdentity !== null
          && sameIdentity(snapshot.identity!, publishedIdentity)
        ) {
          storeFs.unlinkSync(paths.owner)
          fsyncDirectory(paths.root, storeFs)
          published = false
        }
      } catch {
        throw new HabitLifecycleError("lifecycle_lock_durability_unknown", {
          durabilityUnknown: true,
          cause: error,
        })
      }
    }
    if (tempOwned) bestEffortUnlink(tempPath, storeFs)
    throw new HabitLifecycleError(
      published ? "lifecycle_lock_durability_unknown" : "lifecycle_lock_failed",
      { durabilityUnknown: published, cause: error },
    )
  }
  bestEffortUnlink(tempPath, storeFs)
  const snapshot = inspectOwner(paths.owner, storeFs)
  if (snapshot.status !== "valid" || snapshot.bytes !== bytes) {
    throw new HabitLifecycleError("lifecycle_lock_durability_unknown", { durabilityUnknown: true })
  }
  return snapshot.identity!
}

function writeMutableLifecycleFile(
  lease: HabitLifecycleLease,
  finalPath: string,
  bytes: string,
  deps: HabitLifecycleDeps,
): void {
  const storeFs = deps.fs ?? fs
  assertLease(lease, storeFs)
  const directoryPath = path.dirname(finalPath)
  storeFs.mkdirSync(directoryPath, { recursive: true })
  const tempPath = lifecycleTempPath(finalPath, deps)
  let tempFd: number | null = null
  let tempOwned = false
  let published = false
  try {
    tempFd = storeFs.openSync(tempPath, "wx", 0o600)
    tempOwned = true
    storeFs.writeFileSync(tempFd, bytes, "utf8")
    storeFs.fsyncSync(tempFd)
    storeFs.closeSync(tempFd)
    tempFd = null
    assertLease(lease, storeFs)
    storeFs.renameSync(tempPath, finalPath)
    tempOwned = false
    published = true
    fsyncDirectory(directoryPath, storeFs)
  } catch (error) {
    if (tempFd !== null) bestEffortClose(tempFd, storeFs)
    if (tempOwned) bestEffortUnlink(tempPath, storeFs)
    if (error instanceof HabitLifecycleError && error.code === "lifecycle_lease_lost") throw error
    throw new HabitLifecycleError(
      published ? "lifecycle_durability_unknown" : "lifecycle_write_failed",
      { durabilityUnknown: published, cause: error },
    )
  }
}

function publishImmutableLifecycleFile(
  lease: HabitLifecycleLease,
  finalPath: string,
  bytes: string,
  deps: HabitLifecycleDeps,
): "published" | "exists" {
  const storeFs = deps.fs ?? fs
  assertLease(lease, storeFs)
  const directoryPath = path.dirname(finalPath)
  storeFs.mkdirSync(directoryPath, { recursive: true })
  const tempPath = lifecycleTempPath(finalPath, deps)
  let tempFd: number | null = null
  let tempOwned = false
  let published = false
  let exists = false
  try {
    tempFd = storeFs.openSync(tempPath, "wx", 0o600)
    tempOwned = true
    storeFs.writeFileSync(tempFd, bytes, "utf8")
    storeFs.fsyncSync(tempFd)
    storeFs.closeSync(tempFd)
    tempFd = null
    assertLease(lease, storeFs)
    try {
      storeFs.linkSync(tempPath, finalPath)
      published = true
    } catch (error) {
      if (!isNodeError(error, "EEXIST")) throw error
      exists = true
    }
    fsyncDirectory(directoryPath, storeFs)
  } catch (error) {
    if (tempFd !== null) bestEffortClose(tempFd, storeFs)
    if (tempOwned) bestEffortUnlink(tempPath, storeFs)
    if (error instanceof HabitLifecycleError && error.code === "lifecycle_lease_lost") throw error
    throw new HabitLifecycleError(
      published || exists ? "lifecycle_durability_unknown" : "lifecycle_write_failed",
      { durabilityUnknown: published || exists, cause: error },
    )
  }
  bestEffortUnlink(tempPath, storeFs)
  return published ? "published" : "exists"
}

function assertLease(lease: HabitLifecycleLease, storeFs: typeof fs): void {
  const snapshot = inspectOwner(lease.ownerPath, storeFs)
  if (!snapshotMatchesLease(snapshot, lease)) {
    throw new HabitLifecycleError("lifecycle_lease_lost")
  }
}

function snapshotMatchesLease(snapshot: OwnerSnapshot, lease: HabitLifecycleLease): boolean {
  return snapshot.status === "valid"
    && snapshot.bytes === lease.ownerBytes
    && sameIdentity(snapshot.identity!, lease.ownerIdentity)
}

function inspectOwner(ownerPath: string, storeFs: typeof fs, failOnIo = false): OwnerSnapshot {
  let before: fs.Stats
  try {
    before = storeFs.lstatSync(ownerPath)
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return { status: "missing" }
    if (failOnIo) throw new HabitLifecycleError("lifecycle_owner_inspection_failed", { cause: error })
    return { status: "invalid" }
  }
  if (!before.isFile()) return { status: "invalid" }
  let bytes: string
  let after: fs.Stats
  try {
    bytes = storeFs.readFileSync(ownerPath, "utf8")
    after = storeFs.lstatSync(ownerPath)
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return { status: "missing" }
    if (failOnIo) throw new HabitLifecycleError("lifecycle_owner_inspection_failed", { cause: error })
    return { status: "invalid" }
  }
  const beforeIdentity = fileIdentity(before)
  const afterIdentity = fileIdentity(after)
  if (!after.isFile() || !sameIdentity(beforeIdentity, afterIdentity)) return { status: "invalid" }
  const parsed = parseOwner(bytes)
  if (parsed === null) return { status: "invalid", bytes, identity: afterIdentity }
  return { status: "valid", bytes, identity: afterIdentity, owner: parsed }
}

function parseOwner(bytes: string): HabitLifecycleOwner | null {
  let value: unknown
  try {
    value = JSON.parse(bytes)
  } catch {
    return null
  }
  if (!isRecord(value) || !hasExactKeys(value, OWNER_KEYS)) return null
  try {
    const owner = buildHabitLifecycleOwner({
      operationId: value.operationId as string,
      pid: value.pid as number,
      bootIdentity: value.bootIdentity as string,
      processStartedAt: value.processStartedAt as string,
      acquiredAt: value.acquiredAt as string,
    })
    if (value.schemaVersion !== 1 || serializeHabitLifecycleJson(owner) !== bytes) return null
    return owner
  } catch {
    return null
  }
}

function classifyOwner(owner: HabitLifecycleOwner, deps: HabitLifecycleDeps): OwnerClassification {
  try {
    if (probeHabitBootIdentity(deps) !== owner.bootIdentity) {
      return { status: "recoverable", probeError: false }
    }
    const liveness = probeHabitProcessLiveness(owner.pid, deps)
    if (liveness === "missing") return { status: "recoverable", probeError: false }
    if (liveness === "unknown") return { status: "unknown", probeError: false }
    const processStartedAt = probeHabitProcessStartedAt(owner.pid, deps)
    if (processStartedAt === null || processStartedAt.length === 0) {
      return { status: "unknown", probeError: false }
    }
    return processStartedAt === owner.processStartedAt
      ? { status: "live", probeError: false }
      : { status: "recoverable", probeError: false }
  } catch {
    return { status: "unknown", probeError: true }
  }
}

function sameOwnerSnapshot(left: OwnerSnapshot, right: OwnerSnapshot): boolean {
  return left.status === "valid"
    && right.status === "valid"
    && left.bytes === right.bytes
    && sameIdentity(left.identity!, right.identity!)
}

function withCoordination<T>(
  paths: HabitLifecyclePaths,
  busyTimeoutMs: number,
  operation: () => T,
): CoordinationAttempt<T> {
  fs.mkdirSync(paths.root, { recursive: true })
  let database: Database.Database
  try {
    database = new Database(paths.coordination)
    database.pragma(`busy_timeout = ${busyTimeoutMs}`)
  } catch (error) {
    throw new HabitLifecycleError("lifecycle_coordination_failed", { cause: error })
  }
  let operationStarted = false
  let operationCompleted = false
  let completedValue: T | undefined
  try {
    const transaction = database.transaction(() => {
      operationStarted = true
      const value = operation()
      completedValue = value
      operationCompleted = true
      return value
    })
    return { status: "completed", value: transaction.immediate() }
  } catch (error) {
    if (isSqliteBusy(error)) {
      if (!operationStarted) return { status: "busy" }
      if (operationCompleted) return { status: "completed", value: completedValue as T }
    }
    throw error
  } finally {
    database.close()
  }
}

function isValidJournal(value: unknown): value is HabitLifecycleJournal {
  if (!isRecord(value) || !hasExactKeys(value, JOURNAL_KEYS)) return false
  if (
    value.schemaVersion !== 1
    || !isValidHabitId(value.habitId)
    || !isValidOperationId(value.operationId)
    || (value.operationKind !== "cancel" && value.operationKind !== "send")
    || !value.operationId.startsWith(`${value.operationKind}:`)
    || !isJournalState(value.state)
    || !isCanonicalTimestamp(value.updatedAt)
    || !Number.isInteger(value.generation)
    || (value.generation as number) < 0
    || (value.evidenceKeyHash !== null && !isHash(value.evidenceKeyHash))
    || (value.cancellationPreparation !== null && !isValidCancellationPreparation(value.cancellationPreparation))
    || !isNullableTimestamp(value.intentAt)
    || !isNullableTimestamp(value.transportInvokedAt)
    || !isNullableTimestamp(value.classifiedAt)
    || (value.boundaryState !== null && !isBoundaryState(value.boundaryState))
    || (value.transportResult !== null && !isValidTransportResult(value.transportResult))
  ) return false

  if (value.state === "lock_acquired") {
    return value.generation === 0
      && value.evidenceKeyHash === null
      && value.cancellationPreparation === null
      && value.intentAt === null
      && value.transportInvokedAt === null
      && value.classifiedAt === null
      && value.boundaryState === null
      && value.transportResult === null
  }
  if (value.state === "cancellation_intent") {
    return value.operationKind === "cancel"
      && value.generation === 1
      && value.evidenceKeyHash !== null
      && cancellationPreparationMatchesJournal(value)
      && value.intentAt !== null
      && value.transportInvokedAt === null
      && value.classifiedAt === null
      && value.boundaryState === null
      && value.transportResult === null
  }
  if (value.state === "definition_cancelled" || value.state === "cancellation_receipt_committed") {
    return value.operationKind === "cancel"
      && value.generation === (value.state === "definition_cancelled" ? 2 : 3)
      && value.evidenceKeyHash !== null
      && cancellationPreparationMatchesJournal(value)
      && value.boundaryState === value.cancellationPreparation!.receipt.transition.boundaryState
      && value.intentAt !== null
      && value.transportInvokedAt === null
      && value.classifiedAt !== null
      && value.boundaryState !== null
      && value.transportResult === null
  }
  if (value.state === "send_intent") {
    return value.operationKind === "send"
      && value.generation === 1
      && value.evidenceKeyHash === null
      && value.cancellationPreparation === null
      && value.intentAt !== null
      && value.transportInvokedAt === null
      && value.classifiedAt === null
      && value.boundaryState === null
      && value.transportResult === null
  }
  return value.operationKind === "send"
    && value.generation === 2
    && value.evidenceKeyHash === null
    && value.cancellationPreparation === null
    && value.intentAt !== null
    && (value.state === "not_crossed" || value.transportInvokedAt !== null)
    && value.classifiedAt !== null
    && value.boundaryState === value.state
    && value.transportResult !== null
}

function isValidCancellationReceipt(value: unknown): value is HabitCancellationReceipt {
  if (!isRecord(value) || !hasExactKeys(value, RECEIPT_KEYS)) return false
  if (
    value.schemaVersion !== 1
    || !isValidHabitId(value.habitId)
    || !isHash(value.evidenceKeyHash)
    || value.operationId !== `cancel:${value.evidenceKeyHash}`
    || !isRecord(value.evidenceLocator)
    || !hasExactKeys(value.evidenceLocator, ["kind", "id"])
    || (value.evidenceLocator.kind !== "bridge" && value.evidenceLocator.kind !== "capture")
    || typeof value.evidenceLocator.id !== "string"
    || !isRecord(value.actor)
    || !hasExactKeys(value.actor, ["displayName", "provider", "externalId"])
    || typeof value.actor.displayName !== "string"
    || value.actor.displayName.trim().length === 0
    || (value.actor.provider !== null && typeof value.actor.provider !== "string")
    || (value.actor.externalId !== null && typeof value.actor.externalId !== "string")
    || !isRecord(value.request)
    || !hasExactKeys(value.request, ["text", "sha256", "observedAt"])
    || typeof value.request.text !== "string"
    || !isHash(value.request.sha256)
    || value.request.sha256 !== sha256(value.request.text)
    || !isCanonicalTimestamp(value.request.observedAt)
    || !isRecord(value.transition)
    || !hasExactKeys(value.transition, ["fromStatus", "toStatus", "cancelledAt", "boundaryState"])
    || (value.transition.fromStatus !== "active" && value.transition.fromStatus !== "paused")
    || value.transition.toStatus !== "cancelled"
    || !isCanonicalTimestamp(value.transition.cancelledAt)
    || !isBoundaryState(value.transition.boundaryState)
    || typeof value.acknowledgement !== "string"
    || !isCanonicalTimestamp(value.createdAt)
    || value.transition.cancelledAt !== value.createdAt
  ) return false
  try {
    const identity = buildHabitEvidenceIdentity({
      habitId: value.habitId,
      kind: value.evidenceLocator.kind,
      id: value.evidenceLocator.id,
    })
    if (identity.evidenceKeyHash !== value.evidenceKeyHash) return false
  } catch {
    return false
  }
  return value.acknowledgement === renderHabitCancellationAcknowledgement(
    value.habitId,
    value.actor.displayName,
    value.transition.boundaryState,
  )
}

export function renderHabitCancellationAcknowledgement(
  habitId: string,
  actorDisplayName: string,
  boundaryState: HabitBoundaryState,
): string {
  if (!isValidHabitId(habitId) || typeof actorDisplayName !== "string" || actorDisplayName.trim().length === 0) {
    throw new HabitLifecycleError("lifecycle_receipt_invalid")
  }
  const prefix = `Cancelled habit ${JSON.stringify(habitId)} from confirmed requester ${JSON.stringify(actorDisplayName)}.`
  if (boundaryState === "not_crossed") {
    return `${prefix} No concurrent send crossed the transport boundary.`
  }
  if (boundaryState === "crossing_unknown") {
    return `${prefix} A concurrent send may have crossed the transport boundary; delivery is unknown.`
  }
  return `${prefix} A concurrent send crossed the transport boundary before cancellation took effect.`
}

function isValidCancellationPreparation(value: unknown): value is HabitCancellationPreparation {
  return isRecord(value)
    && hasExactKeys(value, ["receipt", "definitionBeforeSha256", "definitionCancelledSha256"])
    && isValidCancellationReceipt(value.receipt)
    && isHash(value.definitionBeforeSha256)
    && isHash(value.definitionCancelledSha256)
}

function cancellationPreparationMatchesJournal(value: Record<string, unknown>): boolean {
  const preparation = value.cancellationPreparation
  return isValidCancellationPreparation(preparation)
    && preparation.receipt.habitId === value.habitId
    && preparation.receipt.operationId === value.operationId
    && preparation.receipt.evidenceKeyHash === value.evidenceKeyHash
}

function validatedCancellationPreparation(
  value: HabitCancellationPreparation,
  habitId: string,
  operationId: string,
  evidenceKeyHash: string,
): HabitCancellationPreparation {
  if (!isValidCancellationPreparation(value)) {
    throw new HabitLifecycleError("cancellation_preparation_invalid")
  }
  if (
    value.receipt.habitId !== habitId
    || value.receipt.operationId !== operationId
    || value.receipt.evidenceKeyHash !== evidenceKeyHash
  ) throw new HabitLifecycleError("cancellation_preparation_invalid")
  return {
    receipt: value.receipt,
    definitionBeforeSha256: value.definitionBeforeSha256,
    definitionCancelledSha256: value.definitionCancelledSha256,
  }
}

function validatedTransportResult(value: HabitTransportResult): HabitTransportResult {
  if (!isValidTransportResult(value)) throw new HabitLifecycleError("transport_result_invalid")
  return {
    httpStatus: value.httpStatus,
    messageGuid: value.messageGuid,
    errorCode: value.errorCode,
  }
}

function isValidTransportResult(value: unknown): value is HabitTransportResult {
  return isRecord(value)
    && hasExactKeys(value, ["httpStatus", "messageGuid", "errorCode"])
    && (value.httpStatus === null || (Number.isInteger(value.httpStatus) && (value.httpStatus as number) >= 100 && (value.httpStatus as number) <= 599))
    && (value.messageGuid === null || typeof value.messageGuid === "string")
    && (value.errorCode === null || typeof value.errorCode === "string")
}

function parseJson(bytes: string, code: string): unknown {
  try {
    return JSON.parse(bytes)
  } catch (error) {
    throw new HabitLifecycleError(code, { cause: error })
  }
}

function lifecycleTempPath(finalPath: string, deps: HabitLifecycleDeps): string {
  const uuid = (deps.randomUUID ?? createRandomUuid)()
  if (!UUID_PATTERN.test(uuid)) throw new HabitLifecycleError("lifecycle_uuid_invalid")
  return `${finalPath}.${uuid}.tmp`
}

function lifecyclePid(deps: HabitLifecycleDeps): number {
  return validatedPid((deps.pid ?? (() => process.pid))())
}

function lifecycleNow(deps: HabitLifecycleDeps): Date {
  const now = (deps.now ?? (() => new Date()))()
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new HabitLifecycleError("lifecycle_clock_invalid")
  }
  return now
}

async function lifecycleSleep(milliseconds: number, deps: HabitLifecycleDeps): Promise<void> {
  if (deps.sleep) {
    await deps.sleep(milliseconds)
    return
  }
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds))
}

function fsyncDirectory(directoryPath: string, storeFs: typeof fs): void {
  const directoryFd = storeFs.openSync(directoryPath, "r")
  try {
    storeFs.fsyncSync(directoryFd)
  } finally {
    storeFs.closeSync(directoryFd)
  }
}

function bestEffortClose(fd: number, storeFs: typeof fs): void {
  try { storeFs.closeSync(fd) } catch { /* preserve primary failure */ }
}

function bestEffortUnlink(filePath: string, storeFs: typeof fs): void {
  try {
    storeFs.unlinkSync(filePath)
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return
    try { storeFs.unlinkSync(filePath) } catch { /* recoverable orphan temp */ }
  }
}

function fileIdentity(stats: fs.Stats): HabitLifecycleFileIdentity {
  return { dev: stats.dev, ino: stats.ino }
}

function sameIdentity(left: HabitLifecycleFileIdentity, right: HabitLifecycleFileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex")
}

function validatedHabitId(value: unknown): string {
  if (!isValidHabitId(value)) throw new HabitLifecycleError("habit_id_invalid")
  return value
}

function isValidHabitId(value: unknown): value is string {
  return typeof value === "string"
    && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)
    && value !== "."
    && value !== ".."
}

function validatedOperationId(value: unknown): string {
  if (!isValidOperationId(value)) throw new HabitLifecycleError("operation_id_invalid")
  return value
}

function isValidOperationId(value: unknown): value is string {
  return typeof value === "string"
    && value.trim().length > 0
    && value === value.trim()
    && !/[\0\r\n]/.test(value)
}

function validatedPid(value: unknown): number {
  if (!Number.isInteger(value) || (value as number) <= 0) {
    throw new HabitLifecycleError("pid_invalid")
  }
  return value as number
}

function validatedHash(value: unknown, code: string): string {
  if (!isHash(value)) throw new HabitLifecycleError(code)
  return value
}

function isHash(value: unknown): value is string {
  return typeof value === "string" && HASH_PATTERN.test(value)
}

function validatedTimestamp(value: unknown, code: string): string {
  if (!isCanonicalTimestamp(value)) throw new HabitLifecycleError(code)
  return value
}

function isCanonicalTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || !TIMESTAMP_PATTERN.test(value)) return false
  const parsed = new Date(value)
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value
}

function isNullableTimestamp(value: unknown): value is string | null {
  return value === null || isCanonicalTimestamp(value)
}

function validatedBoundaryState(value: unknown): HabitBoundaryState {
  if (!isBoundaryState(value)) throw new HabitLifecycleError("boundary_state_invalid")
  return value
}

function isBoundaryState(value: unknown): value is HabitBoundaryState {
  return value === "not_crossed" || value === "crossing_unknown" || value === "crossed"
}

function isJournalState(value: unknown): value is HabitLifecycleJournalState {
  return value === "lock_acquired"
    || value === "cancellation_intent"
    || value === "definition_cancelled"
    || value === "cancellation_receipt_committed"
    || value === "send_intent"
    || isBoundaryState(value)
}

function requiredString(value: unknown, code: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new HabitLifecycleError(code)
  }
  return value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value)
  return actual.length === keys.length && actual.every((key, index) => key === keys[index])
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code
}

function isSqliteBusy(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "SQLITE_BUSY"
}

function asLifecycleError(error: unknown, fallbackCode: string): HabitLifecycleError {
  return error instanceof HabitLifecycleError
    ? error
    : new HabitLifecycleError(fallbackCode, { cause: error })
}

function emitLockError(
  habitId: string,
  operationId: string,
  errorCode: string,
  ownerStatus: HabitLifecycleOwnerStatus,
  probeError: boolean,
): void {
  emitNervesEvent({
    level: "error",
    component: "daemon",
    event: "daemon.habit_lifecycle_lock_error",
    message: "habit lifecycle lock acquisition failed",
    meta: { habitId, operationId, errorCode, ownerStatus, probeError },
  })
}

function emitWriteError(lease: HabitLifecycleLease, error: unknown): void {
  const errorCode = error instanceof HabitLifecycleError ? error.code : "lifecycle_write_failed"
  emitNervesEvent({
    level: "error",
    component: "daemon",
    event: "daemon.habit_lifecycle_write_error",
    message: "habit lifecycle durable write failed",
    meta: { habitId: lease.habitId, operationId: lease.operationId, errorCode },
  })
}
