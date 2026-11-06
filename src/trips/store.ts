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

// Local agent-bundle storage:
//   state/trips/ledger.json          — TripLedgerRecord + privateKeyPem (gitignored, machine-local)
//   state/trips/records/<tripId>.json — EncryptedTripPayload (encrypted at rest)
//
// `state/` is gitignored on the agent bundle, so the private key never leaves
// the local machine. Cross-machine consumption goes through the substrate's
// trip-control HTTP service (substrate#35) which holds only ciphertext.

interface StoredLedger {
  schemaVersion: 1
  ledger: TripLedgerRecord
  privateKeyPem: string
}

function tripsRoot(agentName: string): string {
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
  const payload = readJsonFile<EncryptedTripPayload>(recordPath(agentName, tripId))
  if (!payload) throw new TripNotFoundError({ agentName, tripId })
  const stored = readLedgerOrThrow(agentName)
  return decryptTripRecord(payload, stored.privateKeyPem)
}

export function listTripIds(agentName: string): string[] {
  const dir = recordsDir(agentName)
  if (!fs.existsSync(dir)) return []
  return fs.readdirSync(dir)
    .filter((entry) => entry.endsWith(".json"))
    .map((entry) => entry.slice(0, -".json".length))
    .sort()
}
