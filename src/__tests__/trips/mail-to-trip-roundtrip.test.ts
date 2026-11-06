import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import * as identity from "../../heart/identity"
import {
  buildPlaintextStoredMailMessage,
  provisionMailboxRegistry,
  resolveMailAddress,
  type ResolvedMailAddress,
} from "../../mailroom/core"
import { extractTravelFactsFromMail } from "../../mailroom/travel-extract"
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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ouro-trip-mail-rt-"))
  tempRoots.push(root)
  vi.spyOn(identity, "getAgentRoot" as any).mockReturnValue(root)
  vi.spyOn(identity, "getAgentName" as any).mockReturnValue("slugger")
  return { root }
}

const familyCtx = { context: { friend: { trustLevel: "family" } } } as any

function tool(name: string) {
  const def = tripToolDefinitions.find((d) => d.tool.function.name === name)
  if (!def) throw new Error(`tool ${name} missing`)
  return def
}

function flightBookingMime(): Buffer {
  return Buffer.from([
    "From: Acme Air <noreply@acme-air.example>",
    "To: ari@mendelow.me",
    "Subject: Confirmation — flight LX 38 ZRH -> JFK",
    "Message-ID: <flight-zrh-jfk@acme-air.example>",
    "Date: Wed, 01 Apr 2026 09:00:00 -0700",
    "",
    "Your booking is confirmed.",
    "Flight LX 38 from ZRH to JFK.",
    "Departure: 2026-08-05 10:30 CET",
    "Confirmation Code: ABC-123",
  ].join("\r\n"))
}

function lodgingBookingMime(): Buffer {
  return Buffer.from([
    "From: Hotel Marthof <reservations@marthof.example>",
    "To: ari@mendelow.me",
    "Subject: Hotel booking confirmation",
    "Message-ID: <lodging-marthof@marthof.example>",
    "Date: Wed, 01 Apr 2026 09:30:00 -0700",
    "",
    "Hotel: Hotel Marthof Basel",
    "Check-in: 2026-08-02",
    "Check-out: 2026-08-05",
    "Confirmation code: ZZZZ-77",
  ].join("\r\n"))
}

async function ingestBoth(resolved: ResolvedMailAddress) {
  const flight = await buildPlaintextStoredMailMessage({
    resolved,
    envelope: { mailFrom: "noreply@acme-air.example", rcptTo: ["slugger@ouro.bot"] },
    rawMime: flightBookingMime(),
    receivedAt: new Date("2026-04-01T16:00:00.000Z"),
  })
  const lodging = await buildPlaintextStoredMailMessage({
    resolved,
    envelope: { mailFrom: "reservations@marthof.example", rcptTo: ["slugger@ouro.bot"] },
    rawMime: lodgingBookingMime(),
    receivedAt: new Date("2026-04-01T16:30:00.000Z"),
  })
  return { flight, lodging }
}

describe("mail booking → trip ledger end-to-end roundtrip", () => {
  it("extracts facts from real MIME bookings, seeds a trip, and round-trips through the trip tools", async () => {
    mountAgent()
    const { registry } = provisionMailboxRegistry({
      agentId: "slugger",
      ownerEmail: "ari@mendelow.me",
      source: "hey",
    })
    const native = resolveMailAddress(registry, "slugger@ouro.bot")
    if (!native) throw new Error("expected native mailbox")
    const ingested = await ingestBoth(native)
    const flightDecrypted = ingested.flight.message
    const lodgingDecrypted = ingested.lodging.message

    const facts = extractTravelFactsFromMail([flightDecrypted, lodgingDecrypted])
    const flightFact = facts.find((fact) => fact.kind === "flight")
    const lodgingFact = facts.find((fact) => fact.kind === "lodging")
    expect(flightFact?.fields.flightNumber).toBe("LX 38")
    expect(flightFact?.fields.route).toBe("ZRH -> JFK")
    expect(flightFact?.fields.confirmationCode).toBe("ABC-123")
    expect(lodgingFact?.fields.hotel).toContain("Hotel Marthof")
    expect(lodgingFact?.fields.checkIn).toBe("2026-08-02")
    expect(lodgingFact?.fields.checkOut).toBe("2026-08-05")

    await tool("trip_ensure_ledger").handler({}, familyCtx)

    const seeded: TripRecord = {
      schemaVersion: 1,
      tripId: "trip_basel_aaaaaaaaaaaaaaaa",
      agentId: "slugger",
      ownerEmail: "ari@mendelow.me",
      name: "Basel weekend",
      status: "tentative",
      travellers: [{ name: "Ari" }],
      legs: [
        {
          legId: "leg_lodging_0000000000000001",
          kind: "lodging",
          status: "tentative",
          vendor: lodgingFact?.fields.hotel ?? "(unknown)",
          city: "Basel",
          checkInDate: lodgingFact?.fields.checkIn,
          checkOutDate: lodgingFact?.fields.checkOut,
          confirmationCode: lodgingFact?.fields.confirmationCode,
          evidence: [{
            messageId: lodgingDecrypted.id,
            reason: "lodging confirmation extracted from booking email",
            recordedAt: "2026-04-01T16:30:00.000Z",
            discoveryMethod: "extracted",
          }],
          createdAt: "2026-04-01T16:30:00.000Z",
          updatedAt: "2026-04-01T16:30:00.000Z",
        },
      ],
      createdAt: "2026-04-01T16:30:00.000Z",
      updatedAt: "2026-04-01T16:30:00.000Z",
    }
    const upsertResult = await tool("trip_upsert").handler({ record: JSON.stringify(seeded) }, familyCtx) as string
    expect(upsertResult).toContain("trip upserted")

    const newLeg = {
      legId: "leg_flight_aaaaaaaaaaaaaaaa",
      kind: "flight" as const,
      status: "tentative" as const,
      vendor: "Acme Air",
      origin: "ZRH",
      destination: "JFK",
      flightNumber: flightFact?.fields.flightNumber,
      confirmationCode: flightFact?.fields.confirmationCode,
      evidence: [{
        messageId: flightDecrypted.id,
        reason: "flight confirmation extracted from booking email",
        recordedAt: "2026-04-01T16:00:00.000Z",
        discoveryMethod: "extracted" as const,
      }],
      createdAt: "2026-04-01T16:00:00.000Z",
      updatedAt: "2026-04-01T16:00:00.000Z",
    }
    const withFlight: TripRecord = {
      ...seeded,
      legs: [...seeded.legs, newLeg],
      updatedAt: "2026-04-01T17:00:00.000Z",
    }
    await tool("trip_upsert").handler({ record: JSON.stringify(withFlight) }, familyCtx)

    const operatorEvidence = JSON.stringify({
      messageId: "operator-conversation-2026-04-02",
      reason: "Ari verbally confirmed during chat that the dates are firm",
      recordedAt: "2026-04-02T19:00:00.000Z",
      discoveryMethod: "operator_supplied",
    })
    const attachResult = await tool("trip_attach_evidence").handler({
      tripId: seeded.tripId,
      legId: "leg_flight_aaaaaaaaaaaaaaaa",
      evidence: operatorEvidence,
    }, familyCtx) as string
    expect(attachResult).toContain("evidence attached")

    const updateLegResult = await tool("trip_update_leg").handler({
      tripId: seeded.tripId,
      legId: "leg_flight_aaaaaaaaaaaaaaaa",
      updates: JSON.stringify({ status: "confirmed", departureAt: "2026-08-05T08:30:00.000Z" }),
      updatedAt: "2026-04-02T19:30:00.000Z",
    }, familyCtx) as string
    expect(updateLegResult).toMatch(/leg leg_flight_aaaaaaaaaaaaaaaa updated/)

    const got = await tool("trip_get").handler({ tripId: seeded.tripId }, familyCtx) as string
    expect(got).toContain("Basel weekend")
    expect(got).toContain("legs: 2")
    expect(got).toContain(lodgingDecrypted.id)
    expect(got).toContain(flightDecrypted.id)
    expect(got).toContain("operator_supplied")
    expect(got).toContain("operator-conversation-2026-04-02")
    expect(got).toContain("departureAt")
    expect(got).toMatch(/"status":\s*"confirmed"/)
  })
})
