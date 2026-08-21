import * as fs from "node:fs"
import * as path from "node:path"
import { AsyncLocalStorage } from "node:async_hooks"
import { randomUUID } from "node:crypto"
import { spawnSync } from "node:child_process"

import { getAgentRoot } from "../identity"
import { emitNervesEvent } from "../../nerves/runtime"

const SHA256 = /^[0-9a-f]{64}$/u
const acceptanceApproval = new AsyncLocalStorage<{ approvalId: string; argumentDigest: string }>()

export interface SanctuaryAcceptanceMarker {
  schemaVersion: "sanctuary-acceptance-marker-v1"
  label: string
  scenarioHandleDigest: string
  startedAt: string
}

export interface SanctuaryAcceptanceGateStatus {
  label: string
  gate: string
  phase: "waiting" | "complete"
  startedAt: string
}

const DEFAULT_GATE_STATUS_PATH = "/evidence/current-scenario-gate.json"
const SAFE_RENAME_HELPER = path.resolve(__dirname, "../../../deploy/unraid/sanctuary-safe-rename.py")

function requireBasename(name: string): void {
  if (name.length === 0 || name === "." || name === ".." || path.basename(name) !== name || name.includes("/") || name.includes("\0")) {
    throw new Error("acceptance quarantine coordinates must be basenames")
  }
}

export function boundDirectoryEntryPath(directoryHandle: number, directoryPath: string, name: string): string {
  requireBasename(name)
  return process.platform === "linux" ? `/proc/self/fd/${directoryHandle}/${name}` : path.join(directoryPath, name)
}

export function secureRenameBoundInodeSync(
  sourceDirectoryHandle: number,
  sourceName: string,
  destinationDirectoryHandle: number,
  destinationName: string,
  expected: Pick<fs.Stats, "dev" | "ino">,
): void {
  requireBasename(sourceName)
  requireBasename(destinationName)
  const result = spawnSync("/usr/bin/python3", [SAFE_RENAME_HELPER, sourceName, destinationName, String(expected.dev), String(expected.ino)], {
    cwd: "/", encoding: "utf8", timeout: 5_000, maxBuffer: 16 * 1024,
    env: { PATH: "/usr/bin:/bin" }, stdio: ["ignore", "ignore", "pipe", sourceDirectoryHandle, destinationDirectoryHandle],
  })
  if (result.error || result.status !== 0) throw new Error("acceptance quarantine bound rename failed")
}

function markerPath(agentName: string): string {
  return path.join(getAgentRoot(agentName), "state", "acceptance", "active-scenario.json")
}

function parseMarker(value: unknown): SanctuaryAcceptanceMarker {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("acceptance marker is corrupt")
  const marker = value as Record<string, unknown>
  if (JSON.stringify(Object.keys(marker).sort()) !== JSON.stringify(["label", "scenarioHandleDigest", "schemaVersion", "startedAt"])) {
    throw new Error("acceptance marker is corrupt")
  }
  if (marker.schemaVersion !== "sanctuary-acceptance-marker-v1"
    || typeof marker.label !== "string" || marker.label.length === 0
    || typeof marker.scenarioHandleDigest !== "string" || !SHA256.test(marker.scenarioHandleDigest)
    || typeof marker.startedAt !== "string" || new Date(marker.startedAt).toISOString() !== marker.startedAt) {
    throw new Error("acceptance marker is corrupt")
  }
  return marker as unknown as SanctuaryAcceptanceMarker
}

export function readSanctuaryAcceptanceMarker(agentName: string): SanctuaryAcceptanceMarker | null {
  if (agentName !== "sanctuary") return null
  const filePath = markerPath(agentName)
  let raw: string
  try {
    raw = fs.readFileSync(filePath, "utf8")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null
    throw error
  }
  return parseMarker(JSON.parse(raw) as unknown)
}

export function writeSanctuaryAcceptanceMarker(agentName: string, marker: SanctuaryAcceptanceMarker): void {
  if (agentName !== "sanctuary") throw new Error("acceptance markers are restricted to Sanctuary")
  const parsed = parseMarker(marker)
  const filePath = markerPath(agentName)
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 })
  const temporary = `${filePath}.${process.pid}.tmp`
  fs.writeFileSync(temporary, `${JSON.stringify(parsed)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" })
  fs.renameSync(temporary, filePath)
  fs.chmodSync(filePath, 0o600)
  emitNervesEvent({ component: "daemon", event: "daemon.sanctuary_acceptance_marker_written", message: "Sanctuary acceptance marker published", meta: { label: parsed.label, scenarioHandleDigest: parsed.scenarioHandleDigest } })
}

export function clearSanctuaryAcceptanceMarker(agentName: string, scenarioHandleDigest: string): void {
  if (!SHA256.test(scenarioHandleDigest)) throw new Error("scenario handle digest is invalid")
  const current = readSanctuaryAcceptanceMarker(agentName)
  if (!current) return
  if (current.scenarioHandleDigest !== scenarioHandleDigest) throw new Error("acceptance marker ownership mismatch")
  fs.unlinkSync(markerPath(agentName))
  emitNervesEvent({ component: "daemon", event: "daemon.sanctuary_acceptance_marker_cleared", message: "Sanctuary acceptance marker cleared", meta: { scenarioHandleDigest } })
}

export function quarantineSanctuaryAcceptanceMarker(agentName: string): string | null {
  if (agentName !== "sanctuary") throw new Error("acceptance markers are restricted to Sanctuary")
  const filePath = markerPath(agentName)
  const sourceParent = path.dirname(filePath)
  const quarantineRoot = path.join(sourceParent, "quarantine")
  let markerPathMetadata: fs.Stats
  try {
    markerPathMetadata = fs.lstatSync(filePath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null
    throw error
  }
  const sourceParentHandle = fs.openSync(sourceParent, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW)
  let markerHandle: number | null = null
  let quarantineHandle: number | null = null
  const rejectedPath = path.join(sourceParent, `.quarantine-rejected-${randomUUID()}`)
  const quarantinePath = path.join(quarantineRoot, `active-scenario-${randomUUID()}.json`)
  try {
    const sourceParentMetadata = fs.fstatSync(sourceParentHandle)
    const sourceParentPathMetadata = fs.lstatSync(sourceParent)
    if (!sourceParentMetadata.isDirectory() || !sourceParentPathMetadata.isDirectory()
      || sourceParentMetadata.dev !== sourceParentPathMetadata.dev || sourceParentMetadata.ino !== sourceParentPathMetadata.ino) throw new Error("acceptance marker parent changed during quarantine")
    const boundMarkerPath = boundDirectoryEntryPath(sourceParentHandle, sourceParent, path.basename(filePath))
    const boundQuarantineRoot = boundDirectoryEntryPath(sourceParentHandle, sourceParent, path.basename(quarantineRoot))
    const boundRejectedPath = boundDirectoryEntryPath(sourceParentHandle, sourceParent, path.basename(rejectedPath))
    if (markerPathMetadata.isFile()) markerHandle = fs.openSync(boundMarkerPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
    if (markerHandle !== null) {
      const markerMetadata = fs.fstatSync(markerHandle)
      markerPathMetadata = fs.lstatSync(boundMarkerPath)
      if (!markerMetadata.isFile() || !markerPathMetadata.isFile() || markerMetadata.dev !== markerPathMetadata.dev || markerMetadata.ino !== markerPathMetadata.ino) throw new Error("acceptance marker changed during quarantine")
    }
    let quarantineExists = false
    let rejectedMetadata: fs.Stats | null = null
    try {
      const existing = fs.lstatSync(boundQuarantineRoot)
      if (!existing.isDirectory()) {
        secureRenameBoundInodeSync(sourceParentHandle, path.basename(quarantineRoot), sourceParentHandle, path.basename(rejectedPath), existing)
        const rejected = fs.lstatSync(boundRejectedPath)
        if (rejected.dev !== existing.dev || rejected.ino !== existing.ino) throw new Error("acceptance marker quarantine rejection changed during move")
        rejectedMetadata = rejected
      } else quarantineExists = true
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error }
    if (!quarantineExists) fs.mkdirSync(boundQuarantineRoot, { mode: 0o700 })
    quarantineHandle = fs.openSync(boundQuarantineRoot, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW)
    const quarantineMetadata = fs.fstatSync(quarantineHandle)
    const quarantinePathMetadata = fs.lstatSync(boundQuarantineRoot)
    if (!quarantineMetadata.isDirectory() || !quarantinePathMetadata.isDirectory()
      || quarantineMetadata.dev !== quarantinePathMetadata.dev || quarantineMetadata.ino !== quarantinePathMetadata.ino) throw new Error("acceptance marker quarantine root changed")
    fs.fchmodSync(quarantineHandle, 0o700)
    if (rejectedMetadata) {
      secureRenameBoundInodeSync(sourceParentHandle, path.basename(rejectedPath), quarantineHandle, path.basename(rejectedPath).slice(1), rejectedMetadata)
    }
    const finalMarkerPathMetadata = fs.lstatSync(boundMarkerPath)
    if (finalMarkerPathMetadata.dev !== markerPathMetadata.dev || finalMarkerPathMetadata.ino !== markerPathMetadata.ino) throw new Error("acceptance marker changed before quarantine move")
    secureRenameBoundInodeSync(sourceParentHandle, path.basename(filePath), quarantineHandle, path.basename(quarantinePath), markerPathMetadata)
    const movedMarkerMetadata = fs.lstatSync(boundDirectoryEntryPath(quarantineHandle, quarantineRoot, path.basename(quarantinePath)))
    if (movedMarkerMetadata.dev !== markerPathMetadata.dev || movedMarkerMetadata.ino !== markerPathMetadata.ino) throw new Error("acceptance marker changed during quarantine move")
    if (markerHandle !== null) fs.fsyncSync(markerHandle)
    fs.fsyncSync(sourceParentHandle)
    fs.fsyncSync(quarantineHandle)
  } finally {
    if (quarantineHandle !== null) fs.closeSync(quarantineHandle)
    if (markerHandle !== null) fs.closeSync(markerHandle)
    fs.closeSync(sourceParentHandle)
  }
  emitNervesEvent({ component: "daemon", event: "daemon.sanctuary_acceptance_marker_quarantined", message: "Sanctuary acceptance marker was quarantined", meta: { quarantinePath } })
  return quarantinePath
}

export function sanctuaryAcceptanceEventMeta(agentName: string): { scenarioHandleDigest: string } | Record<string, never> {
  const marker = readSanctuaryAcceptanceMarker(agentName)
  return marker ? { scenarioHandleDigest: marker.scenarioHandleDigest } : {}
}

function parseGateStatus(value: unknown): SanctuaryAcceptanceGateStatus {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("acceptance gate status is invalid")
  const status = value as Record<string, unknown>
  if (JSON.stringify(Object.keys(status).sort()) !== JSON.stringify(["gate", "label", "phase", "startedAt"])) throw new Error("acceptance gate status is invalid")
  if (typeof status.label !== "string" || status.label.length === 0
    || typeof status.gate !== "string" || status.gate.length === 0
    || (status.phase !== "waiting" && status.phase !== "complete")
    || typeof status.startedAt !== "string" || new Date(status.startedAt).toISOString() !== status.startedAt) {
    throw new Error("acceptance gate status is invalid")
  }
  return status as unknown as SanctuaryAcceptanceGateStatus
}

export function publishSanctuaryAcceptanceGateStatus(
  status: SanctuaryAcceptanceGateStatus,
  filePath = DEFAULT_GATE_STATUS_PATH,
): void {
  const parsed = parseGateStatus(status)
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o755 })
  const temporary = `${filePath}.${process.pid}.tmp`
  fs.writeFileSync(temporary, `${JSON.stringify(parsed)}\n`, { encoding: "utf8", mode: 0o644, flag: "wx" })
  fs.renameSync(temporary, filePath)
  fs.chmodSync(filePath, 0o644)
  emitNervesEvent({ component: "daemon", event: "daemon.sanctuary_acceptance_gate_status_written", message: "Sanctuary acceptance gate status published", meta: { label: parsed.label, gate: parsed.gate, phase: parsed.phase } })
}

export function clearSanctuaryAcceptanceGateStatus(filePath = DEFAULT_GATE_STATUS_PATH): void {
  try {
    fs.unlinkSync(filePath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
  }
  emitNervesEvent({ component: "daemon", event: "daemon.sanctuary_acceptance_gate_status_cleared", message: "Sanctuary acceptance gate status cleared", meta: { path: filePath } })
}

export function runWithSanctuaryAcceptanceApproval<T>(
  value: { approvalId: string; argumentDigest: string },
  operation: () => T,
): T {
  if (!value.approvalId || !SHA256.test(value.argumentDigest)) throw new Error("acceptance approval context is invalid")
  return acceptanceApproval.run({ ...value }, operation)
}

export function readSanctuaryAcceptanceApproval(): { approvalId: string; argumentDigest: string } | null {
  const value = acceptanceApproval.getStore()
  return value ? { ...value } : null
}
