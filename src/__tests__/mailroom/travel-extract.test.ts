import { describe, expect, it } from "vitest"
import type { DecryptedMailMessage } from "../../mailroom/core"
import { extractTravelFactsFromMail } from "../../mailroom/travel-extract"

function message(input: {
  id: string
  subject: string
  text: string
  source?: string
  ownerEmail?: string
}): DecryptedMailMessage {
  return {
    schemaVersion: 1,
    id: input.id,
    agentId: "slugger",
    mailboxId: "mailbox_slugger",
    compartmentKind: input.ownerEmail ? "delegated" : "native",
    compartmentId: input.ownerEmail ? "grant_slugger_hey" : "mailbox_slugger",
    ...(input.ownerEmail ? { ownerEmail: input.ownerEmail } : {}),
    ...(input.source ? { source: input.source } : {}),
    recipient: "slugger@ouro.bot",
    envelope: { mailFrom: "travel@example.com", rcptTo: ["slugger@ouro.bot"] },
    placement: "imbox",
    trustReason: "test",
    rawObject: "raw/test.eml",
    rawSha256: "abc",
    rawSize: 1,
    bodyForm: "plaintext",
    ingest: { schemaVersion: 1, kind: "smtp" },
    receivedAt: "2026-04-21T00:00:00.000Z",
    private: {
      from: ["travel@example.com"],
      to: ["slugger@ouro.bot"],
      cc: [],
      subject: input.subject,
      text: input.text,
      snippet: input.text,
      attachments: [],
      untrustedContentWarning: "test",
    },
  }
}

describe("mail travel extraction", () => {
  it("extracts sparse travel facts and ignores unrelated mail", () => {
    const facts = extractTravelFactsFromMail([
      message({
        id: "mail_departure",
        subject: "Departure reminder",
        text: "Departure: 2026-05-01 09:00\nConfirmation code: AB-123",
        source: "hey",
        ownerEmail: "ari@mendelow.me",
      }),
      message({
        id: "mail_lodging",
        subject: "Hotel booking",
        text: "Check-in: 2026-05-02\nCheck-out: 2026-05-04",
      }),
      message({
        id: "mail_noise",
        subject: "Lunch",
        text: "No travel facts here.",
      }),
    ])

    expect(facts).toEqual([
      expect.objectContaining({
        kind: "flight",
        messageId: "mail_departure",
        source: "hey",
        ownerEmail: "ari@mendelow.me",
        summary: "flight departing 2026-05-01 09:00",
        fields: {
          departure: "2026-05-01 09:00",
          confirmationCode: "AB-123",
        },
      }),
      expect.objectContaining({
        kind: "lodging",
        messageId: "mail_lodging",
        source: null,
        ownerEmail: null,
        summary: "lodging check-in 2026-05-02 check-out 2026-05-04",
        fields: {
          checkIn: "2026-05-02",
          checkOut: "2026-05-04",
        },
      }),
    ])
  })

  it("summarizes route-heavy flights and named lodging reservations", () => {
    const facts = extractTravelFactsFromMail([
      message({
        id: "mail_route",
        subject: "Flight AA 42",
        text: "Flight AA42\nSFO -> JFK\nConfirmation code: ROUTE7",
      }),
      message({
        id: "mail_departure_only",
        subject: "Flight UA 5 update",
        text: "Flight UA5\nDeparture: 2026-05-03 11:00",
      }),
      message({
        id: "mail_hotel",
        subject: "Lodging receipt",
        text: "Hotel: Harbor House\nConfirmation code: STAY9",
      }),
    ])

    expect(facts).toEqual([
      expect.objectContaining({
        kind: "flight",
        messageId: "mail_route",
        summary: "flight AA 42 SFO -> JFK",
        fields: {
          flightNumber: "AA 42",
          route: "SFO -> JFK",
          confirmationCode: "ROUTE7",
        },
      }),
      expect.objectContaining({
        kind: "flight",
        messageId: "mail_departure_only",
        summary: "flight UA 5 departing 2026-05-03 11:00",
        fields: {
          flightNumber: "UA 5",
          departure: "2026-05-03 11:00",
        },
      }),
      expect.objectContaining({
        kind: "lodging",
        messageId: "mail_hotel",
        summary: "Harbor House",
        fields: {
          hotel: "Harbor House",
          confirmationCode: "STAY9",
        },
      }),
    ])
  })
})
