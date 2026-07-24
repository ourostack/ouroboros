import * as fs from "fs"
import * as path from "path"

import type { HabitRunReceipt } from "../../arc/flight-recorder"
import { emitNervesEvent } from "../../nerves/runtime"
import { canonicalizeJson, sha256CanonicalJson } from "../runtime/canonical-json"

export interface HabitProjectionCandidateV1 {
  schemaVersion: 1
  occurrenceId: string
  attemptId: string
  receipt: HabitRunReceipt
}

export interface HabitProjectionCandidateWriteResult {
  candidate: HabitProjectionCandidateV1
  candidatePath: string
  candidateRef: string
  candidateSha256: string
}

export type HabitProjectionCandidateWriteIo = Pick<
  typeof fs,
  "mkdirSync" | "openSync" | "writeFileSync" | "fsyncSync" | "closeSync" | "renameSync" | "rmSync"
>

function fail(message: string): never {
  throw new Error(`Habit projection candidate corrupt: ${message}`)
}

function safeIdentity(value: string, label: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value) || value.includes("..")) {
    fail(`${label} must be path-safe`)
  }
  return value
}

function candidateRef(occurrenceId: string, attemptId: string): string {
  return path.posix.join(
    "state",
    "habits",
    "projection-candidates",
    safeIdentity(occurrenceId, "occurrenceId"),
    `${safeIdentity(attemptId, "attemptId")}.json`,
  )
}

function parseCandidate(value: unknown): HabitProjectionCandidateV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("record must be an object")
  const raw = value as Record<string, unknown>
  const keys = Object.keys(raw).sort()
  if (keys.join("\0") !== ["attemptId", "occurrenceId", "receipt", "schemaVersion"].sort().join("\0")) {
    fail("record fields are invalid")
  }
  if (raw.schemaVersion !== 1) fail("schemaVersion must be 1")
  if (typeof raw.occurrenceId !== "string" || typeof raw.attemptId !== "string") fail("correlation is invalid")
  safeIdentity(raw.occurrenceId, "occurrenceId")
  safeIdentity(raw.attemptId, "attemptId")
  if (!raw.receipt || typeof raw.receipt !== "object" || Array.isArray(raw.receipt)) fail("receipt must be an object")
  const receipt = raw.receipt as Partial<HabitRunReceipt>
  if (receipt.schemaVersion !== 2 || typeof receipt.runId !== "string" || typeof receipt.habitName !== "string") {
    fail("receipt identity is invalid")
  }
  return value as HabitProjectionCandidateV1
}

function readCandidateFile(candidatePath: string): HabitProjectionCandidateV1 {
  try {
    return parseCandidate(JSON.parse(fs.readFileSync(candidatePath, "utf8")) as unknown)
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Habit projection candidate corrupt:")) throw error
    fail(error instanceof Error ? error.message : String(error))
  }
}

function durableAtomicWrite(
  candidatePath: string,
  candidate: HabitProjectionCandidateV1,
  io: HabitProjectionCandidateWriteIo,
): void {
  const directory = path.dirname(candidatePath)
  io.mkdirSync(directory, { recursive: true, mode: 0o700 })
  const temporaryPath = `${candidatePath}.${process.pid}.${Date.now()}.tmp`
  let descriptor: number | null = null
  try {
    descriptor = io.openSync(temporaryPath, "wx", 0o600)
    io.writeFileSync(descriptor, `${canonicalizeJson(candidate)}\n`, "utf8")
    io.fsyncSync(descriptor)
    io.closeSync(descriptor)
    descriptor = null
    io.renameSync(temporaryPath, candidatePath)
    const directoryDescriptor = io.openSync(directory, "r")
    try {
      io.fsyncSync(directoryDescriptor)
    } finally {
      io.closeSync(directoryDescriptor)
    }
  } finally {
    if (descriptor !== null) io.closeSync(descriptor)
    io.rmSync(temporaryPath, { force: true })
  }
}

export function writeHabitProjectionCandidate(
  bundleRoot: string,
  occurrenceId: string,
  attemptId: string,
  receipt: HabitRunReceipt,
  io: HabitProjectionCandidateWriteIo = fs,
): HabitProjectionCandidateWriteResult {
  const candidate: HabitProjectionCandidateV1 = parseCandidate({
    schemaVersion: 1,
    occurrenceId,
    attemptId,
    receipt,
  })
  const ref = candidateRef(occurrenceId, attemptId)
  const candidatePath = path.join(bundleRoot, ref)
  if (fs.existsSync(candidatePath)) {
    const prior = readCandidateFile(candidatePath)
    if (canonicalizeJson(prior) !== canonicalizeJson(candidate)) {
      throw new Error("Habit projection candidate conflict: immutable evidence already exists")
    }
  } else {
    durableAtomicWrite(candidatePath, candidate, io)
  }
  emitNervesEvent({
    component: "heart",
    event: "heart.habit_projection_candidate_written",
    message: "staged immutable habit session evidence for occurrence settlement",
    meta: { occurrenceId, attemptId, runId: receipt.runId, habitName: receipt.habitName },
  })
  return {
    candidate,
    candidatePath,
    candidateRef: ref,
    candidateSha256: sha256CanonicalJson(candidate),
  }
}

export function readHabitProjectionCandidate(
  bundleRoot: string,
  occurrenceId: string,
  attemptId: string,
): HabitProjectionCandidateV1 | null {
  const candidatePath = path.join(bundleRoot, candidateRef(occurrenceId, attemptId))
  if (!fs.existsSync(candidatePath)) return null
  const candidate = readCandidateFile(candidatePath)
  if (candidate.occurrenceId !== occurrenceId || candidate.attemptId !== attemptId) fail("correlation does not match path")
  return candidate
}
