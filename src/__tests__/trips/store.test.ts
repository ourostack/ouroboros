import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import * as identity from "../../heart/identity"
import { createLogger, type LogEvent } from "../../nerves"
import { setRuntimeLogger } from "../../nerves/runtime"
import {
  ensureAgentTripLedger,
  listTripIds,
  readAgentTripKeypair,
  readTripRecord,
  TripNotFoundError,
  upsertTripRecord,
} from "../../trips/store"
import {
  encryptTripRecord,
  newTripLedgerRecord,
  type EncryptedTripPayload,
  type TripLedgerRecord,
  type TripRecord,
} from "../../trips/core"

const tempRoots: string[] = []

afterEach(() => {
  for (const dir of tempRoots.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
  vi.restoreAllMocks()
  setRuntimeLogger(null)
})

function mountAgentRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ouro-trips-store-"))
  tempRoots.push(dir)
  vi.spyOn(identity, "getAgentRoot" as any).mockReturnValue(dir)
  return dir
}

function tripRecord(overrides: Partial<TripRecord> = {}): TripRecord {
  return {
    schemaVersion: 1,
    tripId: "trip_test_0000000000000000",
    agentId: "slugger",
    ownerEmail: "ari@mendelow.me",
    name: "Europe summer 2026",
    status: "confirmed",
    travellers: [{ name: "Ari" }],
    legs: [],
    createdAt: "2026-04-01T08:00:00.000Z",
    updatedAt: "2026-04-01T08:00:00.000Z",
    ...overrides,
  }
}

interface LegacyStoreFixture {
  ledger: {
    schemaVersion: 1
    ledger: TripLedgerRecord
    privateKeyPem: string
  }
  payload: EncryptedTripPayload
  rawLedger: string
  rawRecord: string
}

function writeLegacyStore(root: string, trip: TripRecord = tripRecord()): LegacyStoreFixture {
  const created = newTripLedgerRecord({
    agentId: trip.agentId,
    now: () => "2026-04-24T18:00:00.000Z",
  })
  const ledger = {
    schemaVersion: 1 as const,
    ledger: created.ledger,
    privateKeyPem: created.keypair.privateKeyPem,
  }
  const payload = encryptTripRecord(trip, created.ledger.publicKeyPem, created.ledger.keyId)
  const legacyRecordsDir = path.join(root, "state", "trips", "records")
  fs.mkdirSync(legacyRecordsDir, { recursive: true })
  const rawLedger = `${JSON.stringify(ledger, null, 2)}\n`
  const rawRecord = `${JSON.stringify(payload, null, 2)}\n`
  fs.writeFileSync(path.join(root, "state", "trips", "ledger.json"), rawLedger, "utf-8")
  fs.writeFileSync(path.join(legacyRecordsDir, `${trip.tripId}.json`), rawRecord, "utf-8")
  return { ledger, payload, rawLedger, rawRecord }
}

function captureNervesEvents(): LogEvent[] {
  const events: LogEvent[] = []
  setRuntimeLogger(createLogger({ level: "debug", sinks: [(entry) => events.push(entry)] }))
  return events
}

describe("trips store", () => {
  describe("ensureAgentTripLedger", () => {
    it("creates a ledger on first call and persists it to disk", () => {
      const root = mountAgentRoot()
      const result = ensureAgentTripLedger({ agentName: "slugger", now: () => "2026-04-24T18:00:00.000Z" })
      expect(result.added).toBe(true)
      expect(result.ledger.agentId).toBe("slugger")
      expect(fs.existsSync(path.join(root, "trips", "ledger.json"))).toBe(true)
      expect(fs.existsSync(path.join(root, "state", "trips", "ledger.json"))).toBe(false)
    })

    it("is idempotent — second call returns the existing ledger without rewriting", () => {
      mountAgentRoot()
      const first = ensureAgentTripLedger({ agentName: "slugger" })
      const second = ensureAgentTripLedger({ agentName: "slugger" })
      expect(second.added).toBe(false)
      expect(second.ledger).toEqual(first.ledger)
    })

    it("uses the agent name as default label when no label is provided", () => {
      mountAgentRoot()
      const result = ensureAgentTripLedger({ agentName: "slugger" })
      expect(result.ledger.keyId.startsWith("trip_slugger_")).toBe(true)
    })

    it("threads an explicit label into the keyId when provided", () => {
      mountAgentRoot()
      const result = ensureAgentTripLedger({ agentName: "slugger", label: "primary" })
      expect(result.ledger.keyId.startsWith("trip_primary_")).toBe(true)
    })
  })

  describe("readAgentTripKeypair", () => {
    it("returns the persisted keypair after ensureAgentTripLedger", () => {
      mountAgentRoot()
      ensureAgentTripLedger({ agentName: "slugger" })
      const keypair = readAgentTripKeypair("slugger")
      expect(keypair.publicKeyPem).toContain("BEGIN PUBLIC KEY")
      expect(keypair.privateKeyPem).toContain("BEGIN PRIVATE KEY")
    })

    it("throws when no ledger exists yet", () => {
      mountAgentRoot()
      expect(() => readAgentTripKeypair("slugger")).toThrow(/no trip ledger/)
    })
  })

  describe("upsertTripRecord / readTripRecord", () => {
    it("round-trips an encrypted trip record through disk", () => {
      const root = mountAgentRoot()
      ensureAgentTripLedger({ agentName: "slugger" })
      const trip = tripRecord()
      upsertTripRecord("slugger", trip)
      expect(fs.existsSync(path.join(root, "trips", "records", `${trip.tripId}.json`))).toBe(true)
      expect(fs.existsSync(path.join(root, "state", "trips", "records", `${trip.tripId}.json`))).toBe(false)
      const got = readTripRecord("slugger", trip.tripId)
      expect(got).toEqual(trip)
    })

    it("copies a legacy state/trips ledger into durable trips storage without deleting legacy files", () => {
      const root = mountAgentRoot()
      const trip = tripRecord({ tripId: "trip_legacy_0000000000000000" })
      const legacy = writeLegacyStore(root, trip)
      fs.writeFileSync(path.join(root, "state", "trips", "records", "notes.txt"), "ignore me", "utf-8")

      expect(listTripIds("slugger")).toEqual([trip.tripId])
      expect(readTripRecord("slugger", trip.tripId)).toEqual(trip)
      expect(fs.readFileSync(path.join(root, "trips", "ledger.json"), "utf-8")).toBe(legacy.rawLedger)
      expect(fs.readFileSync(path.join(root, "trips", "records", `${trip.tripId}.json`), "utf-8")).toBe(legacy.rawRecord)
      expect(fs.existsSync(path.join(root, "trips", "records", "notes.txt"))).toBe(false)
      expect(fs.existsSync(path.join(root, "state", "trips", "ledger.json"))).toBe(true)
    })

    it("migrates a legacy ledger even when the legacy records directory is absent", () => {
      const root = mountAgentRoot()
      const legacy = writeLegacyStore(root)
      fs.rmSync(path.join(root, "state", "trips", "records"), { recursive: true, force: true })

      expect(listTripIds("slugger")).toEqual([])
      expect(fs.readFileSync(path.join(root, "trips", "ledger.json"), "utf-8")).toBe(legacy.rawLedger)
    })

    it("prefers durable trips storage and reports legacy divergence without merging", () => {
      const root = mountAgentRoot()
      const events = captureNervesEvents()
      const durableTrip = tripRecord({ tripId: "trip_durable_0000000000000000", name: "Durable" })
      ensureAgentTripLedger({ agentName: "slugger" })
      upsertTripRecord("slugger", durableTrip)
      fs.writeFileSync(path.join(root, "trips", "records", "notes.txt"), "ignore me", "utf-8")
      const legacyTrip = tripRecord({ tripId: "trip_legacy_0000000000000000", name: "Legacy" })
      writeLegacyStore(root, legacyTrip)
      fs.writeFileSync(path.join(root, "state", "trips", "records", "notes.txt"), "ignore me", "utf-8")
      events.splice(0)

      expect(listTripIds("slugger")).toEqual([durableTrip.tripId])
      expect(() => readTripRecord("slugger", legacyTrip.tripId)).toThrow(TripNotFoundError)
      expect(fs.existsSync(path.join(root, "trips", "records", `${legacyTrip.tripId}.json`))).toBe(false)
      expect(events.some((event) => event.event === "trips.legacy_diverged" && event.level === "warn")).toBe(true)
    })

    it("does not report divergence when durable and legacy ledger-only stores match", () => {
      const root = mountAgentRoot()
      const legacy = writeLegacyStore(root)
      fs.rmSync(path.join(root, "state", "trips", "records"), { recursive: true, force: true })
      fs.mkdirSync(path.join(root, "trips"), { recursive: true })
      fs.writeFileSync(path.join(root, "trips", "ledger.json"), legacy.rawLedger, "utf-8")
      const events = captureNervesEvents()

      const result = ensureAgentTripLedger({ agentName: "slugger" })

      expect(result.added).toBe(false)
      expect(events.some((event) => event.event === "trips.legacy_diverged")).toBe(false)
    })

    it("reports divergence when legacy state has records but no ledger", () => {
      const root = mountAgentRoot()
      const durableTrip = tripRecord({ tripId: "trip_durable_0000000000000000" })
      ensureAgentTripLedger({ agentName: "slugger" })
      upsertTripRecord("slugger", durableTrip)
      fs.mkdirSync(path.join(root, "state", "trips", "records"), { recursive: true })
      fs.writeFileSync(path.join(root, "state", "trips", "records", "trip_legacy.json"), "{}", "utf-8")
      const events = captureNervesEvents()

      expect(listTripIds("slugger")).toEqual([durableTrip.tripId])
      expect(events.some((event) => event.event === "trips.legacy_diverged")).toBe(true)
    })

    it("cleans temporary durable migration directories when legacy copy fails", () => {
      const root = mountAgentRoot()
      writeLegacyStore(root, tripRecord({ tripId: "trip_legacy_0000000000000000" }))

      fs.chmodSync(root, 0o500)
      try {
        expect(() => listTripIds("slugger")).toThrow()
      } finally {
        fs.chmodSync(root, 0o700)
      }
      expect(fs.existsSync(path.join(root, "trips"))).toBe(false)
      expect(fs.readdirSync(root).filter((entry) => entry.startsWith("trips.tmp-"))).toEqual([])
      expect(fs.existsSync(path.join(root, "state", "trips", "ledger.json"))).toBe(true)
    })

    it("overwrites the prior record on a second upsert with the same tripId", () => {
      mountAgentRoot()
      ensureAgentTripLedger({ agentName: "slugger" })
      const original = tripRecord()
      const updated = tripRecord({ name: "Renamed", updatedAt: "2026-04-02T08:00:00.000Z" })
      upsertTripRecord("slugger", original)
      upsertTripRecord("slugger", updated)
      const got = readTripRecord("slugger", original.tripId)
      expect(got.name).toBe("Renamed")
    })

    it("throws TripNotFoundError when the trip is absent on disk", () => {
      mountAgentRoot()
      ensureAgentTripLedger({ agentName: "slugger" })
      expect(() => readTripRecord("slugger", "trip_missing_0000000000000000"))
        .toThrow(TripNotFoundError)
    })

    it("upsertTripRecord throws when no ledger exists yet", () => {
      mountAgentRoot()
      expect(() => upsertTripRecord("slugger", tripRecord())).toThrow(/no trip ledger/)
    })
  })

  describe("listTripIds", () => {
    it("returns an empty list when no records have been written", () => {
      mountAgentRoot()
      ensureAgentTripLedger({ agentName: "slugger" })
      expect(listTripIds("slugger")).toEqual([])
    })

    it("returns trip ids sorted, ignoring non-json entries", () => {
      const root = mountAgentRoot()
      ensureAgentTripLedger({ agentName: "slugger" })
      upsertTripRecord("slugger", tripRecord({ tripId: "trip_b_0000000000000000" }))
      upsertTripRecord("slugger", tripRecord({ tripId: "trip_a_0000000000000000" }))
      // Drop a stray non-json file in the records dir.
      fs.writeFileSync(path.join(root, "trips", "records", "notes.txt"), "ignore me", "utf-8")
      expect(listTripIds("slugger")).toEqual(["trip_a_0000000000000000", "trip_b_0000000000000000"])
    })

    it("returns an empty list when the records dir does not exist yet", () => {
      mountAgentRoot()
      // No ensureAgentTripLedger and no upsert — directory not created.
      expect(listTripIds("slugger")).toEqual([])
    })
  })
})
