import { emitNervesEvent } from "../../nerves/runtime"

export interface ProcessIdentity {
  uid: number
  pid: number
  startIdentity: string
  bootId: string
}

export interface ProcessProof {
  uid: number
  pid: number
  startIdentity: string
  executableRealpath: string
}

export interface ProcessIdentitySource {
  readBootId(): string
  readProcess(pid: number): ProcessProof | null
}

export type ExactProcessState =
  | { state: "alive"; observed: ProcessIdentity }
  | { state: "dead"; reason: "boot-changed" | "process-absent" }
  | { state: "dead"; reason: "process-replaced"; observed: ProcessIdentity }
  | { state: "unobservable"; reason: "boot-evidence-unavailable" | "process-evidence-unavailable" }

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function isSafeUnsignedInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0
}

export function parseProcessIdentity(value: unknown): ProcessIdentity {
  if (!isRecord(value) || Object.keys(value).sort().join(",") !== "bootId,pid,startIdentity,uid") {
    throw new Error("process identity must contain exactly uid, pid, startIdentity, and bootId")
  }
  const uid = value.uid
  const pid = value.pid
  if (!isSafeUnsignedInteger(uid)) throw new Error("process identity uid must be a non-negative safe integer")
  if (!Number.isSafeInteger(pid) || (pid as number) <= 0) {
    throw new Error("process identity pid must be a positive safe integer")
  }
  if (typeof value.startIdentity !== "string" || value.startIdentity.length === 0) {
    throw new Error("process identity startIdentity must be non-empty")
  }
  if (typeof value.bootId !== "string" || value.bootId.length === 0) {
    throw new Error("process identity bootId must be non-empty")
  }
  return {
    uid,
    pid: pid as number,
    startIdentity: value.startIdentity,
    bootId: value.bootId,
  }
}

function identityFromProof(pid: number, bootId: string, proof: ProcessProof): ProcessIdentity {
  if (proof.pid !== pid) throw new Error("process evidence PID does not match the requested PID")
  if (!isSafeUnsignedInteger(proof.uid)) throw new Error("process evidence UID is invalid")
  if (typeof proof.startIdentity !== "string" || proof.startIdentity.length === 0) {
    throw new Error("process start evidence is invalid")
  }
  if (typeof proof.executableRealpath !== "string" || !proof.executableRealpath.startsWith("/")) {
    throw new Error("process executable proof is invalid")
  }
  return parseProcessIdentity({ uid: proof.uid, pid, startIdentity: proof.startIdentity, bootId })
}

export function observeProcessIdentity(
  pid: number,
  source: ProcessIdentitySource,
  expected?: { expectedUid: number; expectedExecutableRealpath: string },
): ProcessIdentity {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("process PID must be a positive safe integer")
  const bootId = source.readBootId()
  if (typeof bootId !== "string" || bootId.length === 0) throw new Error("machine boot evidence is invalid")
  const proof = source.readProcess(pid)
  if (proof === null) throw new Error(`process ${pid} is absent`)
  if (expected) {
    if (proof.uid !== expected.expectedUid) throw new Error("process evidence does not match the expected UID")
    if (proof.executableRealpath !== expected.expectedExecutableRealpath) {
      throw new Error("process evidence does not match the expected executable realpath")
    }
  }
  const identity = identityFromProof(pid, bootId, proof)
  emitNervesEvent({
    component: "heart",
    event: "heart.runtime_process_identity_observed",
    message: "observed generation-safe process identity",
    meta: { uid: identity.uid, pid: identity.pid, bootId: identity.bootId },
  })
  return identity
}

export function processIdentityEquals(left: ProcessIdentity, right: ProcessIdentity): boolean {
  return left.uid === right.uid &&
    left.pid === right.pid &&
    left.startIdentity === right.startIdentity &&
    left.bootId === right.bootId
}

export function proveExactProcessState(expected: ProcessIdentity, source: ProcessIdentitySource): ExactProcessState {
  let currentBootId: string
  try {
    currentBootId = source.readBootId()
    if (typeof currentBootId !== "string" || currentBootId.length === 0) throw new Error("invalid boot ID")
  } catch {
    return { state: "unobservable", reason: "boot-evidence-unavailable" }
  }
  if (currentBootId !== expected.bootId) return { state: "dead", reason: "boot-changed" }

  let proof: ProcessProof | null
  try {
    proof = source.readProcess(expected.pid)
  } catch {
    return { state: "unobservable", reason: "process-evidence-unavailable" }
  }
  if (proof === null) return { state: "dead", reason: "process-absent" }

  let observed: ProcessIdentity
  try {
    observed = identityFromProof(expected.pid, currentBootId, proof)
  } catch {
    return { state: "unobservable", reason: "process-evidence-unavailable" }
  }
  return processIdentityEquals(expected, observed)
    ? { state: "alive", observed }
    : { state: "dead", reason: "process-replaced", observed }
}
