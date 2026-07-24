import { createHash } from "crypto"
import * as fs from "fs"
import * as path from "path"

import { emitNervesEvent } from "../../nerves/runtime"
import { canonicalizeJson, sha256CanonicalJson } from "../runtime/canonical-json"
import type { ExactProcessState, ProcessIdentity } from "../runtime/process-identity"
import {
  acquireProtectedLock,
  readProtectedJsonOptional,
  writeProtectedJsonUnderLock,
} from "../runtime/protected-json-store"
import type {
  HabitOccurrenceState,
  HabitOccurrenceStore,
  HabitOccurrenceV1,
} from "./habit-occurrence-store"

const OCCURRENCE_STATES = new Set<HabitOccurrenceState>([
  "running",
  "completed",
  "failed_retryable",
  "failed_terminal",
  "outcome_unknown",
])

export interface HabitProjectionReceiptV1 {
  schemaVersion: 1
  receiptId: string
  agent: string
  habitId: string
  occurrenceId: string
  attemptId: string
  recordVersion: number
  state: HabitOccurrenceState
  authorityRef: string
  authoritySha256: string
  resultRef: string | null
  projectedAt: string
}

export interface HabitProjectionStoreOptions {
  bundleRoot: string
  agent: string
  owner: ProcessIdentity & { daemonInstanceId: string }
  proveOwnerState(owner: ProcessIdentity): ExactProcessState
  occurrenceStore: HabitOccurrenceStore
}

export interface HabitProjectionResult {
  receipt: HabitProjectionReceiptV1
  receiptPath: string
  receiptRef: string
  receiptSha256: string
  occurrence: HabitOccurrenceV1
}

function fail(message: string): never {
  throw new Error(`Habit projection receipt: ${message}`)
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("record must be an object")
  return value as Record<string, unknown>
}

function exactKeys(value: Record<string, unknown>, allowed: string[]): void {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key))
  if (unknown.length > 0) fail(`record has unknown field ${unknown.sort()[0]}`)
}

function nonEmpty(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) fail(`${label} must be a non-empty string`)
  return value
}

function canonicalTimestamp(value: unknown): string {
  const text = nonEmpty(value, "projectedAt")
  const milliseconds = Date.parse(text)
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== text) fail("projectedAt must be canonical UTC time")
  return text
}

function receiptIdentity(input: Omit<HabitProjectionReceiptV1, "schemaVersion" | "receiptId" | "resultRef" | "projectedAt">): string {
  return `hpr_${createHash("sha256").update(Buffer.from(canonicalizeJson({
    agent: input.agent,
    habitId: input.habitId,
    occurrenceId: input.occurrenceId,
    attemptId: input.attemptId,
    recordVersion: input.recordVersion,
    state: input.state,
    authoritySha256: input.authoritySha256,
  }), "utf8")).digest("base64url")}`
}

function parseReceipt(value: unknown): HabitProjectionReceiptV1 {
  const raw = record(value)
  exactKeys(raw, [
    "schemaVersion", "receiptId", "agent", "habitId", "occurrenceId", "attemptId", "recordVersion",
    "state", "authorityRef", "authoritySha256", "resultRef", "projectedAt",
  ])
  if (raw.schemaVersion !== 1) fail("schemaVersion must be 1")
  if (!Number.isInteger(raw.recordVersion) || (raw.recordVersion as number) < 1) fail("recordVersion must be positive")
  if (typeof raw.state !== "string" || !OCCURRENCE_STATES.has(raw.state as HabitOccurrenceState)) fail("state is invalid")
  if (typeof raw.authoritySha256 !== "string" || !/^[0-9a-f]{64}$/.test(raw.authoritySha256)) fail("authoritySha256 is invalid")
  if (raw.resultRef !== null && (typeof raw.resultRef !== "string" || raw.resultRef.trim().length === 0)) fail("resultRef is invalid")
  const parsed: HabitProjectionReceiptV1 = {
    schemaVersion: 1,
    receiptId: nonEmpty(raw.receiptId, "receiptId"),
    agent: nonEmpty(raw.agent, "agent"),
    habitId: nonEmpty(raw.habitId, "habitId"),
    occurrenceId: nonEmpty(raw.occurrenceId, "occurrenceId"),
    attemptId: nonEmpty(raw.attemptId, "attemptId"),
    recordVersion: raw.recordVersion as number,
    state: raw.state as HabitOccurrenceState,
    authorityRef: nonEmpty(raw.authorityRef, "authorityRef"),
    authoritySha256: raw.authoritySha256,
    resultRef: raw.resultRef as string | null,
    projectedAt: canonicalTimestamp(raw.projectedAt),
  }
  const expectedId = receiptIdentity(parsed)
  if (parsed.receiptId !== expectedId) fail("receiptId does not match authority identity")
  return parsed
}

function completedResultRef(occurrence: HabitOccurrenceV1): string | null {
  const result = occurrence.attempts.at(-1)!.result
  return result?.status === "completed" ? result.resultRef : null
}

export class HabitProjectionStore {
  readonly options: HabitProjectionStoreOptions
  private readonly receiptDir: string
  private readonly lockTarget: string

  constructor(options: HabitProjectionStoreOptions) {
    this.options = options
    this.receiptDir = path.join(options.bundleRoot, "arc", "flight-recorder", "habit-projection-receipts")
    this.lockTarget = path.join(options.bundleRoot, "state", "habits", "projection-authority.json")
    fs.mkdirSync(this.receiptDir, { recursive: true, mode: 0o700 })
    fs.mkdirSync(path.dirname(this.lockTarget), { recursive: true, mode: 0o700 })
  }

  project(occurrenceId: string, attemptId: string): HabitProjectionResult {
    const { uid, pid, startIdentity, bootId } = this.options.owner
    const lock = acquireProtectedLock(
      this.lockTarget,
      { uid, pid, startIdentity, bootId },
      this.options.proveOwnerState,
    )
    try {
      const occurrence = this.options.occurrenceStore.readOccurrence(occurrenceId)
      if (occurrence.agent !== this.options.agent) fail("occurrence belongs to another agent")
      if (occurrence.latestAttemptId !== attemptId) fail("attemptId is not the latest attempt")
      const authoritySha256 = sha256CanonicalJson(occurrence)
      const identity = {
        agent: occurrence.agent,
        habitId: occurrence.habitId,
        occurrenceId,
        attemptId,
        recordVersion: occurrence.recordVersion,
        state: occurrence.state,
        authorityRef: `state/habits/occurrences/${occurrenceId}.json`,
        authoritySha256,
      }
      const receipt: HabitProjectionReceiptV1 = {
        schemaVersion: 1,
        receiptId: receiptIdentity(identity),
        ...identity,
        resultRef: completedResultRef(occurrence),
        projectedAt: occurrence.updatedAt,
      }
      const receiptPath = path.join(this.receiptDir, `${receipt.receiptId}.json`)
      const prior = readProtectedJsonOptional(receiptPath, parseReceipt)
      if (prior && canonicalizeJson(prior) !== canonicalizeJson(receipt)) fail("receipt conflicts with existing projection")
      const persisted = prior ?? writeProtectedJsonUnderLock(receiptPath, receipt, parseReceipt, lock)
      const receiptRef = path.relative(this.options.bundleRoot, receiptPath)
      emitNervesEvent({
        component: "heart",
        event: "heart.habit_projection_receipt_written",
        message: "projected a habit occurrence from freshly read authority",
        meta: { agent: this.options.agent, habitId: occurrence.habitId, occurrenceId, attemptId, state: occurrence.state },
      })
      return {
        receipt: persisted,
        receiptPath,
        receiptRef,
        receiptSha256: sha256CanonicalJson(persisted),
        occurrence,
      }
    } finally {
      lock.release()
    }
  }
}
