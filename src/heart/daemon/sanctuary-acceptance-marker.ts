import * as fs from "node:fs"
import * as path from "node:path"
import { AsyncLocalStorage } from "node:async_hooks"
import { randomUUID } from "node:crypto"

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
    if (markerPathMetadata.isFile()) markerHandle = fs.openSync(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
    if (markerHandle !== null) {
      const markerMetadata = fs.fstatSync(markerHandle)
      markerPathMetadata = fs.lstatSync(filePath)
      if (!markerMetadata.isFile() || !markerPathMetadata.isFile() || markerMetadata.dev !== markerPathMetadata.dev || markerMetadata.ino !== markerPathMetadata.ino) throw new Error("acceptance marker changed during quarantine")
    }
    let quarantineExists = false
    try {
      const existing = fs.lstatSync(quarantineRoot)
      if (!existing.isDirectory()) {
        fs.renameSync(quarantineRoot, rejectedPath)
        const rejected = fs.lstatSync(rejectedPath)
        if (rejected.dev !== existing.dev || rejected.ino !== existing.ino) throw new Error("acceptance marker quarantine rejection changed during move")
      } else quarantineExists = true
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error }
    if (!quarantineExists) fs.mkdirSync(quarantineRoot, { mode: 0o700 })
    quarantineHandle = fs.openSync(quarantineRoot, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW)
    const quarantineMetadata = fs.fstatSync(quarantineHandle)
    const quarantinePathMetadata = fs.lstatSync(quarantineRoot)
    if (!quarantineMetadata.isDirectory() || !quarantinePathMetadata.isDirectory()
      || quarantineMetadata.dev !== quarantinePathMetadata.dev || quarantineMetadata.ino !== quarantinePathMetadata.ino) throw new Error("acceptance marker quarantine root changed")
    fs.fchmodSync(quarantineHandle, 0o700)
    if (fs.existsSync(rejectedPath)) fs.renameSync(rejectedPath, path.join(quarantineRoot, path.basename(rejectedPath).slice(1)))
    const finalMarkerPathMetadata = fs.lstatSync(filePath)
    if (finalMarkerPathMetadata.dev !== markerPathMetadata.dev || finalMarkerPathMetadata.ino !== markerPathMetadata.ino) throw new Error("acceptance marker changed before quarantine move")
    fs.renameSync(filePath, quarantinePath)
    const movedMarkerMetadata = fs.lstatSync(quarantinePath)
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
