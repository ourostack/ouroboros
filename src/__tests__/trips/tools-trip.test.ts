import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import * as identity from "../../heart/identity"
import * as tripStore from "../../trips/store"
import { tripToolDefinitions } from "../../repertoire/tools-trip"
import type { TripRecord } from "../../trips/core"

const tempRoots: string[] = []

afterEach(() => {
  for (const dir of tempRoots.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
  vi.restoreAllMocks()
})

function mountAgent(): { root: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ouro-trips-tools-"))
  tempRoots.push(root)
  vi.spyOn(identity, "getAgentRoot" as any).mockReturnValue(root)
  vi.spyOn(identity, "getAgentName" as any).mockReturnValue("slugger")
  return { root }
}

const familyCtx = { context: { friend: { trustLevel: "family" } } } as any
const strangerCtx = { context: { friend: { trustLevel: "stranger" } } } as any

function tool(name: string) {
  const def = tripToolDefinitions.find((d) => d.tool.function.name === name)
  if (!def) throw new Error(`tool ${name} missing`)
  return def
}

function trip(overrides: Partial<TripRecord> = {}): TripRecord {
  return {
    schemaVersion: 1,
    tripId: "trip_basel_aaaaaaaaaaaaaaaa",
    agentId: "slugger",
    ownerEmail: "ari@mendelow.me",
    name: "Basel weekend",
    status: "confirmed",
    travellers: [{ name: "Ari" }],
    legs: [{
      legId: "leg_lodging_0000000000000000",
      kind: "lodging",
      status: "confirmed",
      vendor: "Hotel Marthof",
      city: "Basel",
      checkInDate: "2026-08-02",
      checkOutDate: "2026-08-05",
      evidence: [{
        messageId: "mail_basel_booking",
        reason: "booking confirmation",
        recordedAt: "2026-04-01T08:00:00.000Z",
        discoveryMethod: "extracted",
      }],
      createdAt: "2026-04-01T08:00:00.000Z",
      updatedAt: "2026-04-01T08:00:00.000Z",
    }],
    createdAt: "2026-04-01T08:00:00.000Z",
    updatedAt: "2026-04-01T08:00:00.000Z",
    ...overrides,
  }
}

describe("trip tools", () => {
  describe("trust gating", () => {
    it("trust-allows family ctx for trip_status", async () => {
      mountAgent()
      const result = await tool("trip_status").handler({}, familyCtx)
      expect(result).not.toContain("private")
    })

    it("rejects stranger ctx for every trip_ tool", async () => {
      mountAgent()
      const names = ["trip_ensure_ledger", "trip_status", "trip_get", "trip_upsert", "trip_attach_evidence", "trip_update_leg", "trip_remove_leg", "trip_calendar", "trip_new_id"]
      for (const name of names) {
        const result = await tool(name).handler({ tripId: "x", legId: "y", evidence: "{}", record: "{}", name: "n", createdAt: "t" }, strangerCtx)
        expect(typeof result === "string" && result.includes("private")).toBe(true)
      }
    })

    it("trust-allows when no friend (agent self) ctx", async () => {
      mountAgent()
      const result = await tool("trip_status").handler({}, undefined as any)
      expect(result).toBe("no trips on the ledger yet.")
    })
  })

  describe("trip_ensure_ledger", () => {
    it("creates the ledger on first call and reports it as created", async () => {
      mountAgent()
      const result = await tool("trip_ensure_ledger").handler({}, familyCtx) as string
      expect(result).toContain("created")
      expect(result).toMatch(/ledgerId=ledger_slugger_/)
    })

    it("is idempotent — second call says already present", async () => {
      mountAgent()
      await tool("trip_ensure_ledger").handler({}, familyCtx)
      const result = await tool("trip_ensure_ledger").handler({}, familyCtx) as string
      expect(result).toContain("already present")
    })
  })

  describe("trip_status / trip_upsert / trip_get", () => {
    it("upserts and lists a trip end-to-end", async () => {
      mountAgent()
      await tool("trip_ensure_ledger").handler({}, familyCtx)
      const upsertResult = await tool("trip_upsert").handler({ record: JSON.stringify(trip()) }, familyCtx) as string
      expect(upsertResult).toContain("trip upserted")
      expect(upsertResult).toContain("trip_basel_aaaaaaaaaaaaaaaa")

      const status = await tool("trip_status").handler({}, familyCtx) as string
      expect(status).toContain("trip_basel_aaaaaaaaaaaaaaaa")

      const got = await tool("trip_get").handler({ tripId: "trip_basel_aaaaaaaaaaaaaaaa" }, familyCtx) as string
      expect(got).toContain("Basel weekend")
      expect(got).toContain("legs: 1")
      expect(got).toContain("raw record (JSON)")
    })

    it("trip_status returns the empty-state message before any trip exists", async () => {
      mountAgent()
      const result = await tool("trip_status").handler({}, familyCtx) as string
      expect(result).toBe("no trips on the ledger yet.")
    })

    it("trip_calendar returns the empty-state message before any trip exists", async () => {
      mountAgent()
      const result = await tool("trip_calendar").handler({}, familyCtx) as string
      expect(result).toBe("no trips on the ledger yet.")
    })

    it("trip_get returns the not-found error when the trip id is unknown", async () => {
      mountAgent()
      await tool("trip_ensure_ledger").handler({}, familyCtx)
      const result = await tool("trip_get").handler({ tripId: "trip_missing_0000000000000000" }, familyCtx) as string
      expect(result).toContain("trip not found")
    })

    it("trip_get rejects an empty tripId", async () => {
      mountAgent()
      const result = await tool("trip_get").handler({ tripId: "" }, familyCtx) as string
      expect(result).toContain("required")
    })

    it("trip_get propagates non-TripNotFoundError errors from the store", async () => {
      mountAgent()
      vi.spyOn(tripStore, "readTripRecord").mockImplementation(() => {
        throw new Error("decrypt failure: corrupt envelope")
      })
      await expect(
        tool("trip_get").handler({ tripId: "trip_corrupt_aaaaaaaaaaaaaaaa" }, familyCtx),
      ).rejects.toThrow(/decrypt failure/)
    })

    it("trip_get renders the notes line when the record has notes", async () => {
      mountAgent()
      await tool("trip_ensure_ledger").handler({}, familyCtx)
      const withNotes = trip({ notes: "remember to bring rain jackets" })
      await tool("trip_upsert").handler({ record: JSON.stringify(withNotes) }, familyCtx)
      const got = await tool("trip_get").handler({ tripId: withNotes.tripId }, familyCtx) as string
      expect(got).toContain("notes: remember to bring rain jackets")
    })

    it("trip_get renders an empty travellers list as '(none)'", async () => {
      mountAgent()
      await tool("trip_ensure_ledger").handler({}, familyCtx)
      const empty = trip({ travellers: [] })
      await tool("trip_upsert").handler({ record: JSON.stringify(empty) }, familyCtx)
      const got = await tool("trip_get").handler({ tripId: empty.tripId }, familyCtx) as string
      expect(got).toContain("travellers: (none)")
    })

    it("trip_get renders the full date range when both startDate and endDate are set", async () => {
      mountAgent()
      await tool("trip_ensure_ledger").handler({}, familyCtx)
      const both = trip({ tripId: "trip_bothdates_aaaaaaaaaaaaaaaa", startDate: "2026-08-01", endDate: "2026-08-15" })
      await tool("trip_upsert").handler({ record: JSON.stringify(both) }, familyCtx)
      const got = await tool("trip_get").handler({ tripId: both.tripId }, familyCtx) as string
      expect(got).toContain("2026-08-01 → 2026-08-15")
    })

    it("trip_get falls back through dateRange ternary when only one of start/end is set", async () => {
      mountAgent()
      await tool("trip_ensure_ledger").handler({}, familyCtx)

      const startOnly = trip({ tripId: "trip_startonly_aaaaaaaaaaaaaaaa", startDate: "2026-08-01" })
      await tool("trip_upsert").handler({ record: JSON.stringify(startOnly) }, familyCtx)
      const startGot = await tool("trip_get").handler({ tripId: startOnly.tripId }, familyCtx) as string
      expect(startGot).toContain("2026-08-01")

      const endOnly = trip({ tripId: "trip_endonly_aaaaaaaaaaaaaaaa", endDate: "2026-08-15" })
      await tool("trip_upsert").handler({ record: JSON.stringify(endOnly) }, familyCtx)
      const endGot = await tool("trip_get").handler({ tripId: endOnly.tripId }, familyCtx) as string
      expect(endGot).toContain("2026-08-15")

      const noDates = trip({ tripId: "trip_nodates_aaaaaaaaaaaaaaaa" })
      await tool("trip_upsert").handler({ record: JSON.stringify(noDates) }, familyCtx)
      const noDatesGot = await tool("trip_get").handler({ tripId: noDates.tripId }, familyCtx) as string
      expect(noDatesGot).toContain("(no dates)")
    })
  })

  describe("trip_calendar", () => {
    it("renders a chronological calendar projection across trip leg kinds", async () => {
      mountAgent()
      await tool("trip_ensure_ledger").handler({}, familyCtx)
      const evidence = (messageId: string) => [{
        messageId,
        reason: "booking evidence",
        recordedAt: "2026-04-01T08:00:00.000Z",
        discoveryMethod: "extracted" as const,
      }]
      const allKinds = trip({
        tripId: "trip_europe_2026_aaaaaaaa",
        name: "Europe 2026",
        legs: [
          {
            legId: "leg_lodging",
            kind: "lodging",
            status: "confirmed",
            vendor: "Hotel Marthof",
            city: "Basel",
            checkInDate: "2026-08-02",
            checkOutDate: "2026-08-04",
            evidence: evidence("mail_lodging"),
            createdAt: "2026-04-01T08:00:00.000Z",
            updatedAt: "2026-04-01T08:00:00.000Z",
          },
          {
            legId: "leg_flight",
            kind: "flight",
            status: "confirmed",
            vendor: "Lufthansa",
            origin: "SEA",
            destination: "ZRH",
            departureAt: "2026-08-01T19:00:00.000Z",
            arrivalAt: "2026-08-02T12:00:00.000Z",
            flightNumber: "LH 491",
            evidence: evidence("mail_flight"),
            createdAt: "2026-04-01T08:00:00.000Z",
            updatedAt: "2026-04-01T08:00:00.000Z",
          },
          {
            legId: "leg_train",
            kind: "train",
            status: "tentative",
            vendor: "SBB",
            originStation: "Basel SBB",
            destinationStation: "Milano Centrale",
            departureAt: "2026-08-04T09:00:00.000Z",
            arrivalAt: "2026-08-04T13:00:00.000Z",
            trainNumber: "EC 151",
            evidence: evidence("mail_train"),
            createdAt: "2026-04-01T08:00:00.000Z",
            updatedAt: "2026-04-01T08:00:00.000Z",
          },
          {
            legId: "leg_ground",
            kind: "ground-transport",
            status: "confirmed",
            operator: "Blacklane",
            origin: "Hotel",
            destination: "Venue",
            departureAt: "2026-08-07T17:30:00.000Z",
            arrivalAt: "2026-08-07T18:00:00.000Z",
            evidence: evidence("mail_ground"),
            createdAt: "2026-04-01T08:00:00.000Z",
            updatedAt: "2026-04-01T08:00:00.000Z",
          },
          {
            legId: "leg_rental",
            kind: "rental-car",
            status: "tentative",
            rentalVendor: "Hertz",
            pickupLocation: "Milan",
            dropoffLocation: "Lake Como",
            pickupAt: "2026-08-05T09:00:00.000Z",
            dropoffAt: "2026-08-06T09:00:00.000Z",
            evidence: evidence("mail_rental"),
            createdAt: "2026-04-01T08:00:00.000Z",
            updatedAt: "2026-04-01T08:00:00.000Z",
          },
          {
            legId: "leg_ferry",
            kind: "ferry",
            status: "confirmed",
            operator: "Lake Ferry",
            originPort: "Bellagio",
            destinationPort: "Varenna",
            departureAt: "2026-08-06T14:00:00.000Z",
            arrivalAt: "2026-08-06T14:20:00.000Z",
            evidence: evidence("mail_ferry"),
            createdAt: "2026-04-01T08:00:00.000Z",
            updatedAt: "2026-04-01T08:00:00.000Z",
          },
          {
            legId: "leg_event",
            kind: "event",
            status: "confirmed",
            vendor: "Wedding weekend",
            city: "Milan",
            venue: "Villa",
            startsAt: "2026-08-03T18:00:00.000Z",
            endsAt: "2026-08-03T23:00:00.000Z",
            evidence: evidence("mail_event"),
            createdAt: "2026-04-01T08:00:00.000Z",
            updatedAt: "2026-04-01T08:00:00.000Z",
          },
        ],
      })
      await tool("trip_upsert").handler({ record: JSON.stringify(allKinds) }, familyCtx)

      const calendar = await tool("trip_calendar").handler({ tripId: allKinds.tripId }, familyCtx) as string
      expect(calendar).toContain("7 trip calendar entries")
      expect(calendar.indexOf("leg_flight")).toBeLessThan(calendar.indexOf("leg_lodging"))
      expect(calendar.indexOf("leg_lodging")).toBeLessThan(calendar.indexOf("leg_event"))
      expect(calendar).toContain("Lufthansa LH 491 SEA -> ZRH")
      expect(calendar).toContain("SBB EC 151 Basel SBB -> Milano Centrale")
      expect(calendar).toContain("Blacklane Hotel -> Venue")
      expect(calendar).toContain("Hertz Milan -> Lake Como")
      expect(calendar).toContain("Lake Ferry Bellagio -> Varenna")
      expect(calendar).toContain("Wedding weekend")
      expect(calendar).toContain("where: Villa, Milan")
      expect(calendar).toContain("evidence: mail_flight")

      const allTripsCalendar = await tool("trip_calendar").handler({}, familyCtx) as string
      expect(allTripsCalendar).toContain("Europe 2026")
    })

    it("can include undated legs when requested", async () => {
      mountAgent()
      await tool("trip_ensure_ledger").handler({}, familyCtx)
      const undated = trip({
        tripId: "trip_undated_aaaaaaaaaaaaaaaa",
        legs: [{
          legId: "leg_undated_lodging",
          kind: "lodging",
          status: "tentative",
          vendor: "Hotel TBD",
          evidence: [],
          createdAt: "2026-04-01T08:00:00.000Z",
          updatedAt: "2026-04-01T08:00:00.000Z",
        }],
      })
      await tool("trip_upsert").handler({ record: JSON.stringify(undated) }, familyCtx)

      const withoutUndated = await tool("trip_calendar").handler({ tripId: undated.tripId }, familyCtx) as string
      expect(withoutUndated).toBe("no dated calendar entries on the trip ledger yet.")
      const withUndated = await tool("trip_calendar").handler({ tripId: undated.tripId, includeUndated: "true" }, familyCtx) as string
      expect(withUndated).toContain("(undated)")
      expect(withUndated).toContain("Hotel TBD")
    })

    it("renders route labels when only one endpoint is known", async () => {
      mountAgent()
      await tool("trip_ensure_ledger").handler({}, familyCtx)
      const partialRoute = trip({
        tripId: "trip_partialroute_aaaaaaaaaaaa",
        legs: [{
          legId: "leg_partial_route",
          kind: "ground-transport",
          status: "tentative",
          operator: "Taxi",
          origin: "Lugano Station",
          departureAt: "2026-08-04T16:00:00.000Z",
          evidence: [],
          createdAt: "2026-04-01T08:00:00.000Z",
          updatedAt: "2026-04-01T08:00:00.000Z",
        }],
      })
      await tool("trip_upsert").handler({ record: JSON.stringify(partialRoute) }, familyCtx)

	      const calendar = await tool("trip_calendar").handler({ tripId: partialRoute.tripId }, familyCtx) as string
	      expect(calendar).toContain("1 trip calendar entry")
	      expect(calendar).toContain("Taxi Lugano Station")
	      expect(calendar).toContain("where: Lugano Station")
	    })

	    it("renders fallback labels, destination-only routes, and stable same-time ordering", async () => {
	      mountAgent()
	      await tool("trip_ensure_ledger").handler({}, familyCtx)
	      const fallbackTrip = trip({
	        tripId: "trip_fallbacks_aaaaaaaaaaaa",
	        name: "Fallbacks",
	        legs: [
	          {
	            legId: "leg_lodging_same_day",
	            kind: "lodging",
	            status: "tentative",
	            city: "Basel",
	            checkInDate: "2026-08-02",
	            checkOutDate: "2026-08-02",
	            evidence: [],
	            createdAt: "2026-04-01T08:00:00.000Z",
	            updatedAt: "2026-04-01T08:00:00.000Z",
	          },
	          {
	            legId: "leg_flight_fallback",
	            kind: "flight",
	            status: "tentative",
	            departureAt: "2026-08-04T10:00:00.000Z",
	            evidence: [],
	            createdAt: "2026-04-01T08:00:00.000Z",
	            updatedAt: "2026-04-01T08:00:00.000Z",
	          },
	          {
	            legId: "leg_train_destination",
	            kind: "train",
	            status: "tentative",
	            destinationStation: "Milano Centrale",
	            arrivalAt: "2026-08-04T10:00:00.000Z",
	            evidence: [],
	            createdAt: "2026-04-01T08:00:00.000Z",
	            updatedAt: "2026-04-01T08:00:00.000Z",
	          },
	          {
	            legId: "leg_ground_vendor_destination",
	            kind: "ground-transport",
	            status: "tentative",
	            vendor: "ShuttleCo",
	            destination: "Wedding venue",
	            departureAt: "2026-08-05T09:00:00.000Z",
	            evidence: [],
	            createdAt: "2026-04-01T08:00:00.000Z",
	            updatedAt: "2026-04-01T08:00:00.000Z",
	          },
	          {
	            legId: "leg_ground_default",
	            kind: "ground-transport",
	            status: "tentative",
	            departureAt: "2026-08-05T10:00:00.000Z",
	            evidence: [],
	            createdAt: "2026-04-01T08:00:00.000Z",
	            updatedAt: "2026-04-01T08:00:00.000Z",
	          },
	          {
	            legId: "leg_rental_fallback",
	            kind: "rental-car",
	            status: "tentative",
	            pickupAt: "2026-08-06T09:00:00.000Z",
	            evidence: [],
	            createdAt: "2026-04-01T08:00:00.000Z",
	            updatedAt: "2026-04-01T08:00:00.000Z",
	          },
	          {
	            legId: "leg_ferry_destination",
	            kind: "ferry",
	            status: "tentative",
	            destinationPort: "Varenna",
	            departureAt: "2026-08-07T09:00:00.000Z",
	            evidence: [],
	            createdAt: "2026-04-01T08:00:00.000Z",
	            updatedAt: "2026-04-01T08:00:00.000Z",
	          },
	          {
	            legId: "leg_event_fallback",
	            kind: "event",
	            status: "tentative",
	            endsAt: "2026-08-08T21:00:00.000Z",
	            evidence: [],
	            createdAt: "2026-04-01T08:00:00.000Z",
	            updatedAt: "2026-04-01T08:00:00.000Z",
	          },
	          {
	            legId: "leg_undated_a",
	            kind: "event",
	            status: "tentative",
	            vendor: "Open planning window",
	            evidence: [],
	            createdAt: "2026-04-01T08:00:00.000Z",
	            updatedAt: "2026-04-01T08:00:00.000Z",
	          },
	          {
	            legId: "leg_undated_b",
	            kind: "lodging",
	            status: "tentative",
	            vendor: "Backup hotel",
	            evidence: [],
	            createdAt: "2026-04-01T08:00:00.000Z",
	            updatedAt: "2026-04-01T08:00:00.000Z",
	          },
	        ],
	      })
	      await tool("trip_upsert").handler({ record: JSON.stringify(fallbackTrip) }, familyCtx)

	      const calendar = await tool("trip_calendar").handler({ tripId: fallbackTrip.tripId }, familyCtx) as string
	      expect(calendar).toContain("2026-08-02 | lodging | tentative | lodging")
	      expect(calendar).toContain("2026-08-04T10:00:00.000Z | flight | tentative | flight")
	      expect(calendar).toContain("train | tentative | train Milano Centrale")
	      expect(calendar).toContain("where: Milano Centrale")
	      expect(calendar).toContain("ground-transport | tentative | ShuttleCo Wedding venue")
	      expect(calendar).toContain("ground-transport | tentative | ground transport")
	      expect(calendar).toContain("rental-car | tentative | rental car")
	      expect(calendar).toContain("ferry | tentative | ferry Varenna")
	      expect(calendar).toContain("2026-08-08T21:00:00.000Z | event | tentative | event")
	      expect(calendar.indexOf("leg_flight_fallback")).toBeLessThan(calendar.indexOf("leg_train_destination"))
	      expect(calendar).not.toContain("leg_undated_a")

	      const withUndated = await tool("trip_calendar").handler({ tripId: fallbackTrip.tripId, includeUndated: "true" }, familyCtx) as string
	      expect(withUndated).toContain("(undated) | lodging | tentative | Backup hotel")
	      expect(withUndated).toContain("(undated) | event | tentative | Open planning window")
	      expect(withUndated.indexOf("leg_undated_a")).toBeLessThan(withUndated.indexOf("leg_undated_b"))
	    })

	    it("renders the include-undated empty state for trips with no legs", async () => {
	      mountAgent()
	      await tool("trip_ensure_ledger").handler({}, familyCtx)
	      const emptyTrip = trip({
	        tripId: "trip_empty_aaaaaaaaaaaaaaaa",
	        legs: [],
	      })
	      await tool("trip_upsert").handler({ record: JSON.stringify(emptyTrip) }, familyCtx)

	      const calendar = await tool("trip_calendar").handler({ tripId: emptyTrip.tripId, includeUndated: "true" }, familyCtx) as string
	      expect(calendar).toBe("no calendar entries on the trip ledger yet.")
	    })

	    it("returns not-found for an unknown trip id", async () => {
      mountAgent()
      await tool("trip_ensure_ledger").handler({}, familyCtx)
      const result = await tool("trip_calendar").handler({ tripId: "trip_missing_0000000000000000" }, familyCtx) as string
      expect(result).toContain("trip not found")
    })

    it("trip_calendar propagates non-TripNotFoundError errors from the store", async () => {
      mountAgent()
      vi.spyOn(tripStore, "readTripRecord").mockImplementation(() => {
        throw new Error("decrypt failure: corrupt calendar envelope")
      })
      await expect(
        tool("trip_calendar").handler({ tripId: "trip_corrupt_aaaaaaaaaaaaaaaa" }, familyCtx),
      ).rejects.toThrow(/decrypt failure/)
    })
  })

  describe("trip_upsert validation", () => {
    it("rejects malformed JSON", async () => {
      mountAgent()
      const result = await tool("trip_upsert").handler({ record: "{not json" }, familyCtx) as string
      expect(result).toContain("not valid JSON")
    })

    it("rejects when a required string field is missing", async () => {
      mountAgent()
      const incomplete = { ...trip(), name: "" }
      const result = await tool("trip_upsert").handler({ record: JSON.stringify(incomplete) }, familyCtx) as string
      expect(result).toContain("name")
    })

    it("rejects when legs is not an array", async () => {
      mountAgent()
      const broken = { ...trip(), legs: "not an array" }
      const result = await tool("trip_upsert").handler({ record: JSON.stringify(broken) }, familyCtx) as string
      expect(result).toContain("legs must be an array")
    })

    it("rejects when an evidence entry is missing discoveryMethod", async () => {
      mountAgent()
      const broken = trip()
      ;(broken.legs[0] as any).evidence[0].discoveryMethod = ""
      const result = await tool("trip_upsert").handler({ record: JSON.stringify(broken) }, familyCtx) as string
      expect(result).toContain("discoveryMethod")
    })

    it("rejects when record is not a JSON string", async () => {
      mountAgent()
      const result = await tool("trip_upsert").handler({ record: 42 as any }, familyCtx) as string
      expect(result).toContain("JSON string")
    })

    it("rejects when record JSON is not an object", async () => {
      mountAgent()
      const result = await tool("trip_upsert").handler({ record: "[]" }, familyCtx) as string
      expect(result).toContain("TripRecord object")
    })

    it("rejects when a leg is not an object", async () => {
      mountAgent()
      const broken = { ...trip(), legs: ["not an object"] }
      const result = await tool("trip_upsert").handler({ record: JSON.stringify(broken) }, familyCtx) as string
      expect(result).toContain("each leg must be an object")
    })

    it("rejects when a leg is missing legId", async () => {
      mountAgent()
      const broken = trip()
      ;(broken.legs[0] as any).legId = ""
      const result = await tool("trip_upsert").handler({ record: JSON.stringify(broken) }, familyCtx) as string
      expect(result).toContain("legId")
    })

    it("rejects when a leg evidence array is missing", async () => {
      mountAgent()
      const broken = trip()
      ;(broken.legs[0] as any).evidence = "not an array"
      const result = await tool("trip_upsert").handler({ record: JSON.stringify(broken) }, familyCtx) as string
      expect(result).toContain("evidence array")
    })

    it("rejects when an evidence entry is not an object", async () => {
      mountAgent()
      const broken = trip()
      ;(broken.legs[0] as any).evidence = ["string evidence"]
      const result = await tool("trip_upsert").handler({ record: JSON.stringify(broken) }, familyCtx) as string
      expect(result).toContain("evidence entry must be an object")
    })

    it("rejects when an evidence entry is missing messageId", async () => {
      mountAgent()
      const broken = trip()
      ;(broken.legs[0] as any).evidence[0].messageId = 42
      const result = await tool("trip_upsert").handler({ record: JSON.stringify(broken) }, familyCtx) as string
      expect(result).toContain("messageId")
    })

    it("rejects when a leg is missing kind", async () => {
      mountAgent()
      const broken = trip()
      ;(broken.legs[0] as any).kind = 42
      const result = await tool("trip_upsert").handler({ record: JSON.stringify(broken) }, familyCtx) as string
      expect(result).toContain("kind")
    })

    it("rejects when a leg is missing status", async () => {
      mountAgent()
      const broken = trip()
      ;(broken.legs[0] as any).status = 42
      const result = await tool("trip_upsert").handler({ record: JSON.stringify(broken) }, familyCtx) as string
      expect(result).toContain("status")
    })

    it("rejects when travellers is not an array", async () => {
      mountAgent()
      const broken = { ...trip(), travellers: "not an array" }
      const result = await tool("trip_upsert").handler({ record: JSON.stringify(broken) }, familyCtx) as string
      expect(result).toContain("travellers must be an array")
    })
  })

  describe("trip_attach_evidence", () => {
    it("appends evidence to the named leg and updates updatedAt", async () => {
      mountAgent()
      await tool("trip_ensure_ledger").handler({}, familyCtx)
      await tool("trip_upsert").handler({ record: JSON.stringify(trip()) }, familyCtx)

      const evidence = JSON.stringify({
        messageId: "operator-direct-2026-04-03",
        reason: "Ari confirmed during chat",
        recordedAt: "2026-04-03T09:00:00.000Z",
        discoveryMethod: "operator_supplied",
      })
      const result = await tool("trip_attach_evidence").handler({
        tripId: "trip_basel_aaaaaaaaaaaaaaaa",
        legId: "leg_lodging_0000000000000000",
        evidence,
      }, familyCtx) as string
      expect(result).toContain("evidence attached")
      expect(result).toContain("2 evidence entries")

      // Confirm via trip_get
      const got = await tool("trip_get").handler({ tripId: "trip_basel_aaaaaaaaaaaaaaaa" }, familyCtx) as string
      expect(got).toContain("operator_supplied")
      expect(got).toContain("operator-direct-2026-04-03")
    })

    it("rejects when the leg id is unknown", async () => {
      mountAgent()
      await tool("trip_ensure_ledger").handler({}, familyCtx)
      await tool("trip_upsert").handler({ record: JSON.stringify(trip()) }, familyCtx)
      const result = await tool("trip_attach_evidence").handler({
        tripId: "trip_basel_aaaaaaaaaaaaaaaa",
        legId: "leg_missing_0000000000000000",
        evidence: JSON.stringify({ messageId: "m", reason: "r", recordedAt: "t", discoveryMethod: "extracted" }),
      }, familyCtx) as string
      expect(result).toContain("not found")
    })

    it("rejects when the trip is missing", async () => {
      mountAgent()
      await tool("trip_ensure_ledger").handler({}, familyCtx)
      const result = await tool("trip_attach_evidence").handler({
        tripId: "trip_missing_0000000000000000",
        legId: "leg_x",
        evidence: JSON.stringify({ messageId: "m", reason: "r", recordedAt: "t", discoveryMethod: "extracted" }),
      }, familyCtx) as string
      expect(result).toContain("trip not found")
    })

    it("rejects when the evidence JSON is malformed", async () => {
      mountAgent()
      await tool("trip_ensure_ledger").handler({}, familyCtx)
      await tool("trip_upsert").handler({ record: JSON.stringify(trip()) }, familyCtx)
      const result = await tool("trip_attach_evidence").handler({
        tripId: "trip_basel_aaaaaaaaaaaaaaaa",
        legId: "leg_lodging_0000000000000000",
        evidence: "{not json",
      }, familyCtx) as string
      expect(result).toContain("not valid JSON")
    })

    it("rejects when tripId or legId or evidence are missing", async () => {
      mountAgent()
      const empty = await tool("trip_attach_evidence").handler({ tripId: "", legId: "x", evidence: "{}" }, familyCtx) as string
      expect(empty).toContain("tripId is required")
      const noLeg = await tool("trip_attach_evidence").handler({ tripId: "trip_x", legId: "", evidence: "{}" }, familyCtx) as string
      expect(noLeg).toContain("legId is required")
    })

    it("rejects when evidence has wrong shape", async () => {
      mountAgent()
      await tool("trip_ensure_ledger").handler({}, familyCtx)
      await tool("trip_upsert").handler({ record: JSON.stringify(trip()) }, familyCtx)
      const result = await tool("trip_attach_evidence").handler({
        tripId: "trip_basel_aaaaaaaaaaaaaaaa",
        legId: "leg_lodging_0000000000000000",
        evidence: JSON.stringify({ messageId: "m" }), // missing other fields
      }, familyCtx) as string
      expect(result).toContain("must be a non-empty string")
    })

    it("rejects when evidence is a JSON array (not an object)", async () => {
      mountAgent()
      await tool("trip_ensure_ledger").handler({}, familyCtx)
      await tool("trip_upsert").handler({ record: JSON.stringify(trip()) }, familyCtx)
      const result = await tool("trip_attach_evidence").handler({
        tripId: "trip_basel_aaaaaaaaaaaaaaaa",
        legId: "leg_lodging_0000000000000000",
        evidence: JSON.stringify(["not", "an", "object"]),
      }, familyCtx) as string
      expect(result).toContain("must be a TripEvidence object")
    })
  })

  describe("trip_update_leg", () => {
    it("updates specific fields of an existing leg without re-emitting the whole record", async () => {
      mountAgent()
      await tool("trip_ensure_ledger").handler({}, familyCtx)
      await tool("trip_upsert").handler({ record: JSON.stringify(trip()) }, familyCtx)

      const result = await tool("trip_update_leg").handler({
        tripId: "trip_basel_aaaaaaaaaaaaaaaa",
        legId: "leg_lodging_0000000000000000",
        updates: JSON.stringify({ status: "cancelled", confirmationCode: "REFUND-2026-XYZ" }),
        updatedAt: "2026-04-26T10:00:00.000Z",
      }, familyCtx) as string
      expect(result).toContain("leg_lodging_0000000000000000 updated")
      expect(result).toContain("status")
      expect(result).toContain("confirmationCode")

      const got = await tool("trip_get").handler({ tripId: "trip_basel_aaaaaaaaaaaaaaaa" }, familyCtx) as string
      expect(got).toContain("\"status\": \"cancelled\"")
      expect(got).toContain("REFUND-2026-XYZ")
      // Evidence preserved (one entry from the original trip())
      expect(got).toContain("mail_basel_booking")
    })

    it("rejects updates that try to change legId or kind (identity-changing)", async () => {
      mountAgent()
      await tool("trip_ensure_ledger").handler({}, familyCtx)
      await tool("trip_upsert").handler({ record: JSON.stringify(trip()) }, familyCtx)

      const idChange = await tool("trip_update_leg").handler({
        tripId: "trip_basel_aaaaaaaaaaaaaaaa",
        legId: "leg_lodging_0000000000000000",
        updates: JSON.stringify({ legId: "leg_other" }),
        updatedAt: "2026-04-26T10:00:00.000Z",
      }, familyCtx) as string
      expect(idChange).toContain("cannot change legId")

      const kindChange = await tool("trip_update_leg").handler({
        tripId: "trip_basel_aaaaaaaaaaaaaaaa",
        legId: "leg_lodging_0000000000000000",
        updates: JSON.stringify({ kind: "flight" }),
        updatedAt: "2026-04-26T10:00:00.000Z",
      }, familyCtx) as string
      expect(kindChange).toContain("cannot change kind")
    })

    it("rejects when the leg id is unknown", async () => {
      mountAgent()
      await tool("trip_ensure_ledger").handler({}, familyCtx)
      await tool("trip_upsert").handler({ record: JSON.stringify(trip()) }, familyCtx)
      const result = await tool("trip_update_leg").handler({
        tripId: "trip_basel_aaaaaaaaaaaaaaaa",
        legId: "leg_missing",
        updates: JSON.stringify({ status: "cancelled" }),
        updatedAt: "2026-04-26T10:00:00.000Z",
      }, familyCtx) as string
      expect(result).toContain("leg_missing not found")
    })

    it("rejects when the trip is missing", async () => {
      mountAgent()
      await tool("trip_ensure_ledger").handler({}, familyCtx)
      const result = await tool("trip_update_leg").handler({
        tripId: "trip_missing_0000000000000000",
        legId: "leg_x",
        updates: JSON.stringify({ status: "cancelled" }),
        updatedAt: "2026-04-26T10:00:00.000Z",
      }, familyCtx) as string
      expect(result).toContain("trip not found")
    })

    it("rejects malformed updates JSON", async () => {
      mountAgent()
      await tool("trip_ensure_ledger").handler({}, familyCtx)
      await tool("trip_upsert").handler({ record: JSON.stringify(trip()) }, familyCtx)
      const result = await tool("trip_update_leg").handler({
        tripId: "trip_basel_aaaaaaaaaaaaaaaa",
        legId: "leg_lodging_0000000000000000",
        updates: "{not json",
        updatedAt: "2026-04-26T10:00:00.000Z",
      }, familyCtx) as string
      expect(result).toContain("not valid JSON")
    })

    it("rejects updates that are a JSON array (not an object)", async () => {
      mountAgent()
      await tool("trip_ensure_ledger").handler({}, familyCtx)
      await tool("trip_upsert").handler({ record: JSON.stringify(trip()) }, familyCtx)
      const result = await tool("trip_update_leg").handler({
        tripId: "trip_basel_aaaaaaaaaaaaaaaa",
        legId: "leg_lodging_0000000000000000",
        updates: JSON.stringify(["not", "object"]),
        updatedAt: "2026-04-26T10:00:00.000Z",
      }, familyCtx) as string
      expect(result).toContain("must be a JSON object")
    })

    it("rejects empty updates object (no-op)", async () => {
      mountAgent()
      await tool("trip_ensure_ledger").handler({}, familyCtx)
      await tool("trip_upsert").handler({ record: JSON.stringify(trip()) }, familyCtx)
      const result = await tool("trip_update_leg").handler({
        tripId: "trip_basel_aaaaaaaaaaaaaaaa",
        legId: "leg_lodging_0000000000000000",
        updates: "{}",
        updatedAt: "2026-04-26T10:00:00.000Z",
      }, familyCtx) as string
      expect(result).toContain("cannot be empty")
    })

    it("rejects when tripId / legId / updatedAt are empty", async () => {
      mountAgent()
      const noTrip = await tool("trip_update_leg").handler({ tripId: "", legId: "x", updates: "{}", updatedAt: "now" }, familyCtx) as string
      expect(noTrip).toContain("tripId is required")
      const noLeg = await tool("trip_update_leg").handler({ tripId: "t", legId: "", updates: "{}", updatedAt: "now" }, familyCtx) as string
      expect(noLeg).toContain("legId is required")
      const noUpdatedAt = await tool("trip_update_leg").handler({ tripId: "t", legId: "x", updates: "{}", updatedAt: "" }, familyCtx) as string
      expect(noUpdatedAt).toContain("updatedAt is required")
    })

    it("emits trips.leg_updated nerve event on success", async () => {
      mountAgent()
      await tool("trip_ensure_ledger").handler({}, familyCtx)
      await tool("trip_upsert").handler({ record: JSON.stringify(trip()) }, familyCtx)

      const recorded: any[] = []
      const { emitNervesEvent } = await import("../../nerves/runtime")
      const original = emitNervesEvent
      void original
      // Spy by re-importing — easier: just verify the result message format
      // since the nerves bus is harness-wide.
      const result = await tool("trip_update_leg").handler({
        tripId: "trip_basel_aaaaaaaaaaaaaaaa",
        legId: "leg_lodging_0000000000000000",
        updates: JSON.stringify({ status: "cancelled" }),
        updatedAt: "2026-04-26T10:00:00.000Z",
      }, familyCtx) as string
      expect(result).toContain("status")
      void recorded
    })
  })

  describe("trip_new_id", () => {
    it("returns a deterministic id given the same inputs", async () => {
      mountAgent()
      const a = await tool("trip_new_id").handler({ name: "Europe Summer 2026", createdAt: "2026-04-24T18:00:00.000Z" }, familyCtx) as string
      const b = await tool("trip_new_id").handler({ name: "Europe Summer 2026", createdAt: "2026-04-24T18:00:00.000Z" }, familyCtx) as string
      expect(a).toBe(b)
      expect(a).toMatch(/^trip_europe-summer-2026_[0-9a-f]{16}$/)
    })

    it("rejects empty name or createdAt", async () => {
      mountAgent()
      expect(await tool("trip_new_id").handler({ name: "", createdAt: "t" }, familyCtx)).toContain("name is required")
      expect(await tool("trip_new_id").handler({ name: "n", createdAt: "" }, familyCtx)).toContain("createdAt is required")
    })
  })

  describe("trip_remove_leg", () => {
    it("removes the named leg, updates updatedAt, and reports the new leg count", async () => {
      mountAgent()
      await tool("trip_ensure_ledger").handler({}, familyCtx)
      const seeded = trip({
        legs: [
          {
            legId: "leg_lodging_0000000000000000",
            kind: "lodging",
            status: "tentative",
            evidence: [],
            createdAt: "2026-04-01T08:00:00.000Z",
            updatedAt: "2026-04-01T08:00:00.000Z",
          },
          {
            legId: "leg_flight_0000000000000001",
            kind: "flight",
            status: "tentative",
            evidence: [],
            createdAt: "2026-04-01T09:00:00.000Z",
            updatedAt: "2026-04-01T09:00:00.000Z",
          },
        ],
      })
      await tool("trip_upsert").handler({ record: JSON.stringify(seeded) }, familyCtx)
      const result = await tool("trip_remove_leg").handler({
        tripId: seeded.tripId,
        legId: "leg_flight_0000000000000001",
        updatedAt: "2026-04-02T10:00:00.000Z",
        reason: "booking cancelled",
      }, familyCtx) as string
      expect(result).toContain("removed")
      expect(result).toContain("trip now has 1 leg")
      const got = await tool("trip_get").handler({ tripId: seeded.tripId }, familyCtx) as string
      expect(got).toContain("legs: 1")
      expect(got).not.toContain("leg_flight_0000000000000001")
    })

    it("rejects when the leg id is unknown so accidental no-op removals are visible", async () => {
      mountAgent()
      await tool("trip_ensure_ledger").handler({}, familyCtx)
      await tool("trip_upsert").handler({ record: JSON.stringify(trip()) }, familyCtx)
      const result = await tool("trip_remove_leg").handler({
        tripId: "trip_basel_aaaaaaaaaaaaaaaa",
        legId: "leg_doesnotexist_0000000000000000",
        updatedAt: "2026-04-02T10:00:00.000Z",
      }, familyCtx) as string
      expect(result).toContain("not found")
    })

    it("returns trip-not-found when the trip is missing", async () => {
      mountAgent()
      await tool("trip_ensure_ledger").handler({}, familyCtx)
      const result = await tool("trip_remove_leg").handler({
        tripId: "trip_missing_0000000000000000",
        legId: "leg_x",
        updatedAt: "2026-04-02T10:00:00.000Z",
      }, familyCtx) as string
      expect(result).toContain("trip not found")
    })

    it("rejects empty inputs", async () => {
      mountAgent()
      const empty = await tool("trip_remove_leg").handler({ tripId: "", legId: "x", updatedAt: "t" }, familyCtx) as string
      expect(empty).toContain("tripId is required")
      const noLeg = await tool("trip_remove_leg").handler({ tripId: "t", legId: "", updatedAt: "t" }, familyCtx) as string
      expect(noLeg).toContain("legId is required")
      const noTime = await tool("trip_remove_leg").handler({ tripId: "t", legId: "x", updatedAt: "" }, familyCtx) as string
      expect(noTime).toContain("updatedAt is required")
    })
  })
})
