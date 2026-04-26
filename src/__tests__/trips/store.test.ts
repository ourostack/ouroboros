import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import * as identity from "../../heart/identity"
import {
  ensureAgentTripLedger,
  listTripIds,
  readAgentTripKeypair,
  readTripRecord,
  TripNotFoundError,
  upsertTripRecord,
} from "../../trips/store"
import type { TripRecord } from "../../trips/core"

const tempRoots: string[] = []

afterEach(() => {
  for (const dir of tempRoots.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
  vi.restoreAllMocks()
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

describe("trips store", () => {
  describe("ensureAgentTripLedger", () => {
    it("creates a ledger on first call and persists it to disk", () => {
      const root = mountAgentRoot()
      const result = ensureAgentTripLedger({ agentName: "slugger", now: () => "2026-04-24T18:00:00.000Z" })
      expect(result.added).toBe(true)
      expect(result.ledger.agentId).toBe("slugger")
      expect(fs.existsSync(path.join(root, "state", "trips", "ledger.json"))).toBe(true)
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
      mountAgentRoot()
      ensureAgentTripLedger({ agentName: "slugger" })
      const trip = tripRecord()
      upsertTripRecord("slugger", trip)
      const got = readTripRecord("slugger", trip.tripId)
      expect(got).toEqual(trip)
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
      fs.writeFileSync(path.join(root, "state", "trips", "records", "notes.txt"), "ignore me", "utf-8")
      expect(listTripIds("slugger")).toEqual(["trip_a_0000000000000000", "trip_b_0000000000000000"])
    })

    it("returns an empty list when the records dir does not exist yet", () => {
      mountAgentRoot()
      // No ensureAgentTripLedger and no upsert — directory not created.
      expect(listTripIds("slugger")).toEqual([])
    })
  })
})
