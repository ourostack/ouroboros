import * as fs from "node:fs"
import * as path from "node:path"
import { getAgentRoot } from "../heart/identity"
import { emitNervesEvent } from "../nerves/runtime"
import {
  decryptTripRecord,
  encryptTripRecord,
  newTripLedgerRecord,
  type EncryptedTripPayload,
  type TripKeyPair,
  type TripLedgerRecord,
  type TripRecord,
} from "./core"

// Durable agent-bundle storage:
//   trips/ledger.json            — TripLedgerRecord + privateKeyPem
//   trips/records/<tripId>.json  — EncryptedTripPayload
//
// Legacy `state/trips/` stores are copied into `trips/` only when durable
// storage is absent. Once `trips/` exists, it is authoritative.

interface StoredLedger {
  schemaVersion: 1
  ledger: TripLedgerRecord
  privateKeyPem: string
}

function tripsRoot(agentName: string): string {
  return path.join(getAgentRoot(agentName), "trips")
}

function legacyTripsRoot(agentName: string): string {
  return path.join(getAgentRoot(agentName), "state", "trips")
}

function ledgerPath(agentName: string): string {
  return path.join(tripsRoot(agentName), "ledger.json")
}

function recordsDir(agentName: string): string {
  return path.join(tripsRoot(agentName), "records")
}

function recordPath(agentName: string, tripId: string): string {
  return path.join(recordsDir(agentName), `${tripId}.json`)
}

function ledgerPathFor(root: string): string {
  return path.join(root, "ledger.json")
}

function recordsDirFor(root: string): string {
  return path.join(root, "records")
}

function copyLegacyTripsIfNeeded(agentName: string): void {
  const durableRoot = tripsRoot(agentName)
  const legacyRoot = legacyTripsRoot(agentName)
  if (fs.existsSync(durableRoot) || !fs.existsSync(ledgerPathFor(legacyRoot))) {
    return
  }

  const tmpRoot = `${durableRoot}.tmp-${process.pid}-${Date.now()}`
  fs.rmSync(tmpRoot, { recursive: true, force: true })
  try {
    fs.mkdirSync(recordsDirFor(tmpRoot), { recursive: true })
    fs.copyFileSync(ledgerPathFor(legacyRoot), ledgerPathFor(tmpRoot))

    const legacyRecordsDir = recordsDirFor(legacyRoot)
    if (fs.existsSync(legacyRecordsDir)) {
      for (const entry of fs.readdirSync(legacyRecordsDir)) {
        if (entry.endsWith(".json")) {
          fs.copyFileSync(path.join(legacyRecordsDir, entry), path.join(recordsDirFor(tmpRoot), entry))
        }
      }
    }

    fs.renameSync(tmpRoot, durableRoot)
  } catch (error) {
    fs.rmSync(tmpRoot, { recursive: true, force: true })
    throw error
  }
}

function collectStoreFiles(root: string): string[] {
  const files: string[] = []
  if (fs.existsSync(ledgerPathFor(root))) {
    files.push("ledger.json")
  }
  const records = recordsDirFor(root)
  if (fs.existsSync(records)) {
    for (const entry of fs.readdirSync(records)) {
      if (entry.endsWith(".json")) {
        files.push(`records/${entry}`)
      }
    }
  }
  return files.sort()
}

function fileAt(root: string, relativePath: string): string {
  return path.join(root, ...relativePath.split("/"))
}

function findLegacyDifferences(durableRoot: string, legacyRoot: string): string[] {
  const paths = new Set([...collectStoreFiles(durableRoot), ...collectStoreFiles(legacyRoot)])
  const differences: string[] = []
  for (const relativePath of [...paths].sort()) {
    const durablePath = fileAt(durableRoot, relativePath)
    const legacyPath = fileAt(legacyRoot, relativePath)
    const durableExists = fs.existsSync(durablePath)
    const legacyExists = fs.existsSync(legacyPath)
    if (durableExists !== legacyExists) {
      differences.push(relativePath)
      continue
    }
    if (durableExists && !fs.readFileSync(durablePath).equals(fs.readFileSync(legacyPath))) {
      differences.push(relativePath)
    }
  }
  return differences
}

function reportLegacyDivergence(agentName: string): void {
  const durableRoot = tripsRoot(agentName)
  const legacyRoot = legacyTripsRoot(agentName)
  if (!fs.existsSync(durableRoot) || !fs.existsSync(legacyRoot)) {
    return
  }
  const differences = findLegacyDifferences(durableRoot, legacyRoot)
  if (differences.length === 0) {
    return
  }
  emitNervesEvent({
    level: "warn",
    component: "trips",
    event: "trips.legacy_diverged",
    message: "legacy trip store differs from durable trip store",
    meta: {
      agentId: agentName,
      durablePath: "trips",
      legacyPath: "state/trips",
      differenceCount: differences.length,
      differences: differences.slice(0, 10),
    },
  })
}

function prepareTripStorage(agentName: string): void {
  copyLegacyTripsIfNeeded(agentName)
  reportLegacyDivergence(agentName)
}

function readJsonFile<T>(filePath: string): T | null {
  if (!fs.existsSync(filePath)) return null
  return JSON.parse(fs.readFileSync(filePath, "utf-8")) as T
}

function writeJsonAtomic(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  const tmp = `${filePath}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), "utf-8")
  fs.renameSync(tmp, filePath)
}

export class TripNotFoundError extends Error {
  readonly statusCode = 404
  constructor(input: { agentName: string; tripId: string }) {
    super(`trip not found: agent=${input.agentName} trip=${input.tripId}`)
  }
}

export interface EnsureLedgerResult {
  ledger: TripLedgerRecord
  added: boolean
}

/**
 * Idempotent — if the agent already has a ledger on disk, return it; otherwise
 * generate a fresh keypair and persist both halves.
 */
export function ensureAgentTripLedger(input: {
  agentName: string
  label?: string
  now?: () => string
}): EnsureLedgerResult {
  prepareTripStorage(input.agentName)
  const existing = readJsonFile<StoredLedger>(ledgerPath(input.agentName))
  if (existing) {
    return { ledger: existing.ledger, added: false }
  }
  const created = newTripLedgerRecord({
    agentId: input.agentName,
    ...(input.label ? { label: input.label } : {}),
    ...(input.now ? { now: input.now } : {}),
  })
  const stored: StoredLedger = {
    schemaVersion: 1,
    ledger: created.ledger,
    privateKeyPem: created.keypair.privateKeyPem,
  }
  writeJsonAtomic(ledgerPath(input.agentName), stored)
  emitNervesEvent({
    component: "trips",
    event: "trips.ledger_created",
    message: "agent trip ledger keypair created",
    meta: { agentId: input.agentName, ledgerId: created.ledger.ledgerId, keyId: created.ledger.keyId },
  })
  return { ledger: created.ledger, added: true }
}

function readLedgerOrThrow(agentName: string): StoredLedger {
  prepareTripStorage(agentName)
  const stored = readJsonFile<StoredLedger>(ledgerPath(agentName))
  if (!stored) {
    throw new Error(`no trip ledger for agent ${agentName} — call ensureAgentTripLedger first`)
  }
  return stored
}

export function readAgentTripKeypair(agentName: string): TripKeyPair {
  const stored = readLedgerOrThrow(agentName)
  return {
    keyId: stored.ledger.keyId,
    publicKeyPem: stored.ledger.publicKeyPem,
    privateKeyPem: stored.privateKeyPem,
  }
}

export function upsertTripRecord(agentName: string, trip: TripRecord): void {
  const stored = readLedgerOrThrow(agentName)
  const payload = encryptTripRecord(trip, stored.ledger.publicKeyPem, stored.ledger.keyId)
  writeJsonAtomic(recordPath(agentName, trip.tripId), payload)
  emitNervesEvent({
    component: "trips",
    event: "trips.record_upserted",
    message: "trip record upserted",
    meta: { agentId: agentName, tripId: trip.tripId, legCount: trip.legs.length, status: trip.status },
  })
}

export function readTripRecord(agentName: string, tripId: string): TripRecord {
  prepareTripStorage(agentName)
  const payload = readJsonFile<EncryptedTripPayload>(recordPath(agentName, tripId))
  if (!payload) throw new TripNotFoundError({ agentName, tripId })
  const stored = readLedgerOrThrow(agentName)
  return decryptTripRecord(payload, stored.privateKeyPem)
}

export function listTripIds(agentName: string): string[] {
  prepareTripStorage(agentName)
  const dir = recordsDir(agentName)
  if (!fs.existsSync(dir)) return []
  return fs.readdirSync(dir)
    .filter((entry) => entry.endsWith(".json"))
    .map((entry) => entry.slice(0, -".json".length))
    .sort()
}
