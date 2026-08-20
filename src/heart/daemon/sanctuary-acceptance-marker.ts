import * as fs from "node:fs"
import * as path from "node:path"
import { AsyncLocalStorage } from "node:async_hooks"

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
