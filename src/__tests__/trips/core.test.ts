import { describe, expect, it } from "vitest"
import {
  decryptTripRecord,
  encryptTripRecord,
  generateTripKeyPair,
  newLegId,
  newTripId,
  newTripLedgerRecord,
  type TripRecord,
} from "../../trips/core"

function tripRecord(overrides: Partial<TripRecord> = {}): TripRecord {
  return {
    schemaVersion: 1,
    tripId: "trip_test_0000000000000000",
    agentId: "slugger",
    ownerEmail: "ari@mendelow.me",
    name: "Europe summer 2026",
    status: "confirmed",
    startDate: "2026-08-01",
    endDate: "2026-08-15",
    travellers: [{ name: "Ari" }],
    legs: [],
    createdAt: "2026-04-01T08:00:00.000Z",
    updatedAt: "2026-04-01T08:00:00.000Z",
    ...overrides,
  }
}

describe("trips core", () => {
  describe("generateTripKeyPair", () => {
    it("generates a fresh RSA keypair with a trip_-prefixed keyId", () => {
      const pair = generateTripKeyPair("slugger")
      expect(pair.keyId).toMatch(/^trip_slugger_[0-9a-f]{16}$/)
      expect(pair.publicKeyPem).toContain("BEGIN PUBLIC KEY")
      expect(pair.privateKeyPem).toContain("BEGIN PRIVATE KEY")
    })

    it("falls back to ledger when label has no safe characters", () => {
      const pair = generateTripKeyPair("!!!")
      expect(pair.keyId.startsWith("trip_ledger_")).toBe(true)
    })
  })

  describe("encryptTripRecord / decryptTripRecord", () => {
    it("round-trips a TripRecord through the keypair", () => {
      const keypair = generateTripKeyPair("slugger")
      const original = tripRecord({
        legs: [{
          legId: "leg_lodging_0000000000000000",
          kind: "lodging",
          status: "confirmed",
          vendor: "Hotel Marthof",
          confirmationCode: "BSL47291",
          city: "Basel",
          checkInDate: "2026-08-02",
          checkOutDate: "2026-08-05",
          amount: { value: 420, currency: "USD" },
          evidence: [{
            messageId: "mail_basel_booking",
            reason: "booking confirmation",
            recordedAt: "2026-04-01T08:00:00.000Z",
            discoveryMethod: "extracted",
            excerpt: "Confirmation: BSL47291",
          }],
          createdAt: "2026-04-01T08:00:00.000Z",
          updatedAt: "2026-04-01T08:00:00.000Z",
        }],
      })
      const payload = encryptTripRecord(original, keypair.publicKeyPem, keypair.keyId)
      expect(payload.algorithm).toBe("RSA-OAEP-SHA256+A256GCM")
      expect(payload.keyId).toBe(keypair.keyId)
      const decrypted = decryptTripRecord(payload, keypair.privateKeyPem)
      expect(decrypted).toEqual(original)
    })

    it("preserves discoveryMethod across all three values through encrypt/decrypt", () => {
      const keypair = generateTripKeyPair("slugger")
      const original = tripRecord({
        legs: [{
          legId: "leg_event_0000000000000000",
          kind: "event",
          status: "tentative",
          city: "Basel",
          venue: "Münster",
          evidence: [
            { messageId: "m1", reason: "extracted from confirmation", recordedAt: "2026-04-01T08:00:00.000Z", discoveryMethod: "extracted" },
            { messageId: "m2", reason: "inferred from itinerary gap", recordedAt: "2026-04-02T08:00:00.000Z", discoveryMethod: "inferred" },
            { messageId: "operator-direct", reason: "Ari mentioned in chat", recordedAt: "2026-04-03T08:00:00.000Z", discoveryMethod: "operator_supplied" },
          ],
          createdAt: "2026-04-01T08:00:00.000Z",
          updatedAt: "2026-04-03T08:00:00.000Z",
        }],
      })
      const decrypted = decryptTripRecord(encryptTripRecord(original, keypair.publicKeyPem, keypair.keyId), keypair.privateKeyPem)
      expect(decrypted.legs[0]!.evidence.map((e) => e.discoveryMethod)).toEqual(["extracted", "inferred", "operator_supplied"])
    })
  })

  describe("newTripId", () => {
    it("is deterministic across the same agentId+name+createdAt", () => {
      const a = newTripId("slugger", "Europe Summer 2026", "2026-04-24T18:00:00.000Z")
      const b = newTripId("slugger", "Europe Summer 2026", "2026-04-24T18:00:00.000Z")
      expect(a).toBe(b)
      expect(a).toMatch(/^trip_europe-summer-2026_[0-9a-f]{16}$/)
    })

    it("falls back to a generic trip slug when the name is unrepresentable", () => {
      const id = newTripId("slugger", "!!!", "2026-04-24T18:00:00.000Z")
      expect(id.startsWith("trip_trip_")).toBe(true)
    })

    it("differs when any input changes", () => {
      const base = newTripId("slugger", "Trip A", "2026-04-24T18:00:00.000Z")
      expect(newTripId("ouroboros", "Trip A", "2026-04-24T18:00:00.000Z")).not.toBe(base)
      expect(newTripId("slugger", "Trip B", "2026-04-24T18:00:00.000Z")).not.toBe(base)
      expect(newTripId("slugger", "Trip A", "2026-04-25T18:00:00.000Z")).not.toBe(base)
    })
  })

  describe("newLegId", () => {
    it("is deterministic when distinguished by vendor", () => {
      const input = {
        tripId: "trip_test_0000000000000000",
        kind: "lodging" as const,
        vendor: "Hotel Marthof",
        createdAt: "2026-04-01T08:00:00.000Z",
      }
      expect(newLegId(input)).toBe(newLegId(input))
    })

    it("falls back to a random distinguisher when vendor and confirmation are absent", () => {
      const input = {
        tripId: "trip_test_0000000000000000",
        kind: "ground-transport" as const,
        createdAt: "2026-04-01T08:00:00.000Z",
      }
      expect(newLegId(input)).not.toBe(newLegId(input))
    })

    it("encodes the kind in the id prefix", () => {
      const id = newLegId({
        tripId: "trip_test_0000000000000000",
        kind: "rental-car",
        vendor: "Sixt",
        createdAt: "2026-04-01T08:00:00.000Z",
      })
      expect(id.startsWith("leg_rental-car_")).toBe(true)
    })

    it("uses confirmationCode when vendor is absent", () => {
      const input = {
        tripId: "trip_test_0000000000000000",
        kind: "flight" as const,
        confirmationCode: "PNR123",
        createdAt: "2026-04-01T08:00:00.000Z",
      }
      expect(newLegId(input)).toBe(newLegId(input))
    })
  })

  describe("newTripLedgerRecord", () => {
    it("produces matched ledger record + keypair with deterministic-shaped ids", () => {
      const result = newTripLedgerRecord({
        agentId: "slugger",
        label: "slugger",
        now: () => "2026-04-24T18:00:00.000Z",
      })
      expect(result.ledger.agentId).toBe("slugger")
      expect(result.ledger.ledgerId).toMatch(/^ledger_slugger_[0-9a-f]{16}$/)
      expect(result.ledger.keyId).toBe(result.keypair.keyId)
      expect(result.ledger.publicKeyPem).toBe(result.keypair.publicKeyPem)
      expect(result.keypair.privateKeyPem).toContain("BEGIN PRIVATE KEY")
      expect(result.ledger.createdAt).toBe("2026-04-24T18:00:00.000Z")
    })

    it("uses agentId as label when label is omitted", () => {
      const result = newTripLedgerRecord({ agentId: "slugger", now: () => "2026-04-24T18:00:00.000Z" })
      expect(result.ledger.keyId.startsWith("trip_slugger_")).toBe(true)
    })

    it("uses the wall clock when now is omitted", () => {
      const result = newTripLedgerRecord({ agentId: "slugger" })
      expect(new Date(result.ledger.createdAt).toString()).not.toBe("Invalid Date")
    })

    it("falls back to agent slug when agentId has no safe characters", () => {
      const result = newTripLedgerRecord({ agentId: "!!!", now: () => "2026-04-24T18:00:00.000Z" })
      expect(result.ledger.ledgerId.startsWith("ledger_agent_")).toBe(true)
    })
  })
})
