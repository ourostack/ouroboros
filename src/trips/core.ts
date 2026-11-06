// Harness-side trip ledger primitive.
//
// Mirrors the substrate's @ouro/work-protocol/src/trip.ts contract (vendored
// the same way mailroom/core.ts vendors mail). Slugger's framing: today,
// doc-edits-from-mail keep falling back on freeform parsing because there is
// no structured object between "mail body" and "travel doc". TripRecord +
// TripLeg are that object — every leg fact carries non-optional provenance
// (TripEvidence with discoveryMethod) so the ledger can be audited cleanly
// and reasoned about under conflict.
//
// Per-agent ledger keypair design: in v1 each agent has ONE ledger keypair.
// All TripRecord blobs are encrypted with that key. Cross-trip sharing
// (handing one trip's facts to another party without their owning the whole
// ledger) is a follow-on; it would shard to per-trip keys, which the
// substrate's TripLedgerRegistry can already represent.

import * as crypto from "node:crypto"

// ── Status + leg taxonomy ──────────────────────────────────────────

export type TripStatus = "planned" | "confirmed" | "in-progress" | "completed" | "cancelled"

export type LegKind = "lodging" | "flight" | "train" | "ground-transport" | "rental-car" | "ferry" | "event"

export type LegStatus = "tentative" | "confirmed" | "changed" | "cancelled" | "refunded"

export type EvidenceDiscoveryMethod = "extracted" | "inferred" | "operator_supplied"

// ── Shared types ───────────────────────────────────────────────────

export interface TripParty {
  name: string
  externalId?: string
}

export interface TripMoney {
  value: number
  currency: string
}

export interface TripEvidence {
  messageId: string
  reason: string
  recordedAt: string
  discoveryMethod: EvidenceDiscoveryMethod
  excerpt?: string
}

interface TripLegBase {
  legId: string
  kind: LegKind
  status: LegStatus
  vendor?: string
  confirmationCode?: string
  amount?: TripMoney
  passengers?: TripParty[]
  notes?: string
  evidence: TripEvidence[]
  createdAt: string
  updatedAt: string
}

export interface LodgingLeg extends TripLegBase {
  kind: "lodging"
  city?: string
  checkInDate?: string
  checkOutDate?: string
}

export interface FlightLeg extends TripLegBase {
  kind: "flight"
  origin?: string
  destination?: string
  departureAt?: string
  arrivalAt?: string
  flightNumber?: string
}

export interface TrainLeg extends TripLegBase {
  kind: "train"
  originStation?: string
  destinationStation?: string
  departureAt?: string
  arrivalAt?: string
  trainNumber?: string
}

export interface GroundTransportLeg extends TripLegBase {
  kind: "ground-transport"
  origin?: string
  destination?: string
  departureAt?: string
  arrivalAt?: string
  operator?: string
}

export interface RentalCarLeg extends TripLegBase {
  kind: "rental-car"
  rentalVendor?: string
  pickupLocation?: string
  dropoffLocation?: string
  pickupAt?: string
  dropoffAt?: string
}

export interface FerryLeg extends TripLegBase {
  kind: "ferry"
  originPort?: string
  destinationPort?: string
  departureAt?: string
  arrivalAt?: string
  operator?: string
}

export interface EventLeg extends TripLegBase {
  kind: "event"
  city?: string
  venue?: string
  startsAt?: string
  endsAt?: string
}

export type TripLeg = LodgingLeg | FlightLeg | TrainLeg | GroundTransportLeg | RentalCarLeg | FerryLeg | EventLeg

// ── Trip + ledger records ──────────────────────────────────────────

export interface TripRecord {
  schemaVersion: 1
  tripId: string
  agentId: string
  ownerEmail: string
  name: string
  status: TripStatus
  startDate?: string
  endDate?: string
  travellers: TripParty[]
  legs: TripLeg[]
  notes?: string
  createdAt: string
  updatedAt: string
}

export interface TripLedgerRecord {
  schemaVersion: 1
  agentId: string
  ledgerId: string
  keyId: string
  publicKeyPem: string
  createdAt: string
}

export interface TripKeyPair {
  keyId: string
  publicKeyPem: string
  privateKeyPem: string
}

export interface EncryptedTripPayload {
  algorithm: "RSA-OAEP-SHA256+A256GCM"
  keyId: string
  wrappedKey: string
  iv: string
  authTag: string
  ciphertext: string
}

// ── Helpers: keys + crypto ─────────────────────────────────────────

function safeLabel(label: string): string {
  return label.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "")
}

export function generateTripKeyPair(label: string): TripKeyPair {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  })
  const slug = safeLabel(label) || "ledger"
  const fingerprint = crypto.createHash("sha256").update(publicKey).digest("hex").slice(0, 16)
  return {
    keyId: `trip_${slug}_${fingerprint}`,
    publicKeyPem: publicKey,
    privateKeyPem: privateKey,
  }
}

export function encryptTripRecord(trip: TripRecord, publicKeyPem: string, keyId: string): EncryptedTripPayload {
  const contentKey = crypto.randomBytes(32)
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv("aes-256-gcm", contentKey, iv)
  const ciphertext = Buffer.concat([cipher.update(Buffer.from(JSON.stringify(trip), "utf-8")), cipher.final()])
  const authTag = cipher.getAuthTag()
  const wrappedKey = crypto.publicEncrypt({ key: publicKeyPem, oaepHash: "sha256" }, contentKey)
  return {
    algorithm: "RSA-OAEP-SHA256+A256GCM",
    keyId,
    wrappedKey: wrappedKey.toString("base64"),
    iv: iv.toString("base64"),
    authTag: authTag.toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  }
}

export function decryptTripRecord(payload: EncryptedTripPayload, privateKeyPem: string): TripRecord {
  const contentKey = crypto.privateDecrypt({
    key: privateKeyPem,
    oaepHash: "sha256",
  }, Buffer.from(payload.wrappedKey, "base64"))
  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    contentKey,
    Buffer.from(payload.iv, "base64"),
  )
  decipher.setAuthTag(Buffer.from(payload.authTag, "base64"))
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(payload.ciphertext, "base64")),
    decipher.final(),
  ])
  return JSON.parse(plaintext.toString("utf-8")) as TripRecord
}

// ── Helpers: deterministic ids ─────────────────────────────────────

export function newTripId(agentId: string, name: string, createdAt: string): string {
  const fingerprint = crypto.createHash("sha256")
    .update(`${agentId}\n${name}\n${createdAt}`)
    .digest("hex")
    .slice(0, 16)
  const slug = safeLabel(name) || "trip"
  return `trip_${slug}_${fingerprint}`
}

export function newLegId(input: {
  tripId: string
  kind: LegKind
  vendor?: string
  confirmationCode?: string
  createdAt: string
}): string {
  const distinguish = input.vendor || input.confirmationCode || crypto.randomUUID()
  const fingerprint = crypto.createHash("sha256")
    .update(`${input.tripId}\n${input.kind}\n${distinguish}\n${input.createdAt}`)
    .digest("hex")
    .slice(0, 16)
  return `leg_${input.kind}_${fingerprint}`
}

// ── Ledger record helpers ──────────────────────────────────────────

export function newTripLedgerRecord(input: { agentId: string; label?: string; now?: () => string }): {
  ledger: TripLedgerRecord
  keypair: TripKeyPair
} {
  const now = (input.now ?? (() => new Date().toISOString()))()
  const keypair = generateTripKeyPair(input.label ?? input.agentId)
  const ledgerId = `ledger_${safeLabel(input.agentId) || "agent"}_${crypto.createHash("sha256").update(`${input.agentId}\n${now}\n${keypair.keyId}`).digest("hex").slice(0, 16)}`
  return {
    ledger: {
      schemaVersion: 1,
      agentId: input.agentId,
      ledgerId,
      keyId: keypair.keyId,
      publicKeyPem: keypair.publicKeyPem,
      createdAt: now,
    },
    keypair,
  }
}
