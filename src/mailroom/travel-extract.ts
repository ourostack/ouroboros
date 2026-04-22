import { emitNervesEvent } from "../nerves/runtime"
import type { DecryptedMailMessage } from "./core"

export type MailTravelFactKind = "flight" | "lodging"

export interface MailTravelFact {
  kind: MailTravelFactKind
  messageId: string
  subject: string
  source: string | null
  ownerEmail: string | null
  summary: string
  fields: Record<string, string>
}

function firstMatch(text: string, pattern: RegExp): string | null {
  const match = pattern.exec(text)
  return match?.[1]?.trim() ?? null
}

function flightFact(message: DecryptedMailMessage): MailTravelFact | null {
  const text = `${message.private.subject}\n${message.private.text}`
  const flightNumber = firstMatch(text, /\bflight\s+([A-Z]{2}\s?\d{1,4})\b/i)
  const routeMatch = /\b([A-Z]{3})\s*(?:->|to)\s*([A-Z]{3})\b/.exec(text)
  const confirmationCode = firstMatch(text, /confirmation code:\s*([A-Z0-9-]+)/i)
  const departure = firstMatch(text, /departure:\s*([^\n]+)/i)
  if (!flightNumber && !routeMatch && !departure) return null
  const fields: Record<string, string> = {}
  if (flightNumber) fields.flightNumber = flightNumber.toUpperCase().replace(/\s+/, " ")
  if (routeMatch) fields.route = `${routeMatch[1]} -> ${routeMatch[2]}`
  if (departure) fields.departure = departure
  if (confirmationCode) fields.confirmationCode = confirmationCode
  return {
    kind: "flight",
    messageId: message.id,
    subject: message.private.subject,
    source: message.source ?? null,
    ownerEmail: message.ownerEmail ?? null,
    summary: [
      fields.flightNumber ? `flight ${fields.flightNumber}` : "flight",
      fields.route ? fields.route : null,
      fields.departure ? `departing ${fields.departure}` : null,
    ].filter(Boolean).join(" "),
    fields,
  }
}

function lodgingFact(message: DecryptedMailMessage): MailTravelFact | null {
  const text = `${message.private.subject}\n${message.private.text}`
  const hotel = firstMatch(text, /hotel:\s*([^\n]+)/i)
  const checkIn = firstMatch(text, /check-?in:\s*([^\n]+)/i)
  const checkOut = firstMatch(text, /check-?out:\s*([^\n]+)/i)
  const confirmationCode = firstMatch(text, /confirmation code:\s*([A-Z0-9-]+)/i)
  if (!hotel && !checkIn && !/hotel|lodging|booking/i.test(message.private.subject)) return null
  const fields: Record<string, string> = {}
  if (hotel) fields.hotel = hotel
  if (checkIn) fields.checkIn = checkIn
  if (checkOut) fields.checkOut = checkOut
  if (confirmationCode) fields.confirmationCode = confirmationCode
  return {
    kind: "lodging",
    messageId: message.id,
    subject: message.private.subject,
    source: message.source ?? null,
    ownerEmail: message.ownerEmail ?? null,
    summary: [
      hotel ?? "lodging",
      checkIn ? `check-in ${checkIn}` : null,
      checkOut ? `check-out ${checkOut}` : null,
    ].filter(Boolean).join(" "),
    fields,
  }
}

export function extractTravelFactsFromMail(messages: DecryptedMailMessage[]): MailTravelFact[] {
  const facts = messages.flatMap((message) => {
    const results: MailTravelFact[] = []
    const flight = flightFact(message)
    if (flight) results.push(flight)
    const lodging = lodgingFact(message)
    if (lodging) results.push(lodging)
    return results
  })

  emitNervesEvent({
    component: "senses",
    event: "senses.mail_travel_facts_extracted",
    message: "travel facts extracted from mail",
    meta: { messages: messages.length, facts: facts.length },
  })

  return facts
}
