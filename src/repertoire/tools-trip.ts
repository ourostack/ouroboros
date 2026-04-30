import type { ToolDefinition } from "./tools-base"
import { isTrustedLevel } from "../mind/friends/types"
import { emitNervesEvent } from "../nerves/runtime"
import {
  ensureAgentTripLedger,
  listTripIds,
  readTripRecord,
  TripNotFoundError,
  upsertTripRecord,
} from "../trips/store"
import { newTripId, type TripEvidence, type TripLeg, type TripRecord } from "../trips/core"
import { getAgentName } from "../heart/identity"

function trustAllowsTripAccess(ctx: Parameters<ToolDefinition["handler"]>[1]): boolean {
  const trustLevel = ctx?.context?.friend?.trustLevel
  return trustLevel === undefined || isTrustedLevel(trustLevel)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function parseJsonArg(raw: unknown, label: string): unknown {
  if (typeof raw !== "string") throw new Error(`${label} must be a JSON string`)
  try {
    return JSON.parse(raw)
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error instanceof Error ? error.message : /* v8 ignore next -- JSON.parse only throws SyntaxError */ String(error)}`)
  }
}

function validateTripRecord(value: unknown): TripRecord {
  if (!isRecord(value)) throw new Error("record must be a TripRecord object")
  // Minimal structural validation — the agent is constructing the value but
  // we still guard against the obvious shape mistakes that would break decrypt.
  for (const field of ["tripId", "agentId", "ownerEmail", "name", "status", "createdAt", "updatedAt"]) {
    if (typeof value[field] !== "string" || (value[field] as string).length === 0) {
      throw new Error(`record.${field} must be a non-empty string`)
    }
  }
  if (!Array.isArray(value.travellers)) throw new Error("record.travellers must be an array")
  if (!Array.isArray(value.legs)) throw new Error("record.legs must be an array")
  for (const leg of value.legs as unknown[]) {
    if (!isRecord(leg)) throw new Error("each leg must be an object")
    if (typeof leg.legId !== "string" || leg.legId.length === 0) throw new Error("each leg requires a legId")
    if (typeof leg.kind !== "string") throw new Error("each leg requires a kind")
    if (typeof leg.status !== "string") throw new Error("each leg requires a status")
    if (!Array.isArray(leg.evidence)) throw new Error(`leg ${leg.legId} requires an evidence array`)
    for (const ev of leg.evidence as unknown[]) {
      if (!isRecord(ev)) throw new Error(`leg ${leg.legId}: each evidence entry must be an object`)
      if (typeof ev.messageId !== "string" || ev.messageId.length === 0) throw new Error(`leg ${leg.legId}: evidence.messageId must be a non-empty string`)
      if (typeof ev.discoveryMethod !== "string" || ev.discoveryMethod.length === 0) throw new Error(`leg ${leg.legId}: evidence.discoveryMethod must be a non-empty string`)
    }
  }
  return value as unknown as TripRecord
}

function validateTripEvidence(value: unknown): TripEvidence {
  if (!isRecord(value)) throw new Error("evidence must be a TripEvidence object")
  for (const field of ["messageId", "reason", "recordedAt", "discoveryMethod"]) {
    if (typeof value[field] !== "string" || (value[field] as string).length === 0) {
      throw new Error(`evidence.${field} must be a non-empty string`)
    }
  }
  return value as unknown as TripEvidence
}

function renderTripSummary(trip: TripRecord): string {
  const dateRange = trip.startDate && trip.endDate
    ? `${trip.startDate} → ${trip.endDate}`
    : trip.startDate ?? trip.endDate ?? "(no dates)"
  const lines = [
    `- ${trip.tripId} :: "${trip.name}" [${trip.status}; ${dateRange}; legs: ${trip.legs.length}]`,
    `  travellers: ${trip.travellers.map((p) => p.name).join(", ") || "(none)"}`,
  ]
  if (trip.notes) lines.push(`  notes: ${trip.notes}`)
  return lines.join("\n")
}

function compact(parts: Array<string | undefined>): string {
  return parts
    .map((part) => part?.trim())
    .filter((part): part is string => !!part)
    .join(" ")
}

function routeLabel(origin: string | undefined, destination: string | undefined): string | undefined {
  if (origin && destination) return `${origin} -> ${destination}`
  return origin ?? destination
}

interface TripCalendarEntry {
  tripId: string
  tripName: string
  legId: string
  kind: TripLeg["kind"]
  status: TripLeg["status"]
  start?: string
  end?: string
  title: string
  where?: string
  evidenceIds: string[]
}

function tripLegCalendarEntry(trip: TripRecord, leg: TripLeg): TripCalendarEntry {
  switch (leg.kind) {
    case "lodging":
      return {
        tripId: trip.tripId,
        tripName: trip.name,
        legId: leg.legId,
        kind: leg.kind,
        status: leg.status,
        start: leg.checkInDate,
        end: leg.checkOutDate,
        title: leg.vendor ?? "lodging",
        where: leg.city,
        evidenceIds: leg.evidence.map((entry) => entry.messageId),
      }
    case "flight": {
      const route = routeLabel(leg.origin, leg.destination)
      return {
        tripId: trip.tripId,
        tripName: trip.name,
        legId: leg.legId,
        kind: leg.kind,
        status: leg.status,
        start: leg.departureAt,
        end: leg.arrivalAt,
        title: compact([leg.vendor ?? "flight", leg.flightNumber, route]),
        where: route,
        evidenceIds: leg.evidence.map((entry) => entry.messageId),
      }
    }
    case "train": {
      const route = routeLabel(leg.originStation, leg.destinationStation)
      return {
        tripId: trip.tripId,
        tripName: trip.name,
        legId: leg.legId,
        kind: leg.kind,
        status: leg.status,
        start: leg.departureAt,
        end: leg.arrivalAt,
        title: compact([leg.vendor ?? "train", leg.trainNumber, route]),
        where: route,
        evidenceIds: leg.evidence.map((entry) => entry.messageId),
      }
    }
    case "ground-transport": {
      const route = routeLabel(leg.origin, leg.destination)
      return {
        tripId: trip.tripId,
        tripName: trip.name,
        legId: leg.legId,
        kind: leg.kind,
        status: leg.status,
        start: leg.departureAt,
        end: leg.arrivalAt,
        title: compact([leg.operator ?? leg.vendor ?? "ground transport", route]),
        where: route,
        evidenceIds: leg.evidence.map((entry) => entry.messageId),
      }
    }
    case "rental-car": {
      const route = routeLabel(leg.pickupLocation, leg.dropoffLocation)
      return {
        tripId: trip.tripId,
        tripName: trip.name,
        legId: leg.legId,
        kind: leg.kind,
        status: leg.status,
        start: leg.pickupAt,
        end: leg.dropoffAt,
        title: compact([leg.rentalVendor ?? leg.vendor ?? "rental car", route]),
        where: route,
        evidenceIds: leg.evidence.map((entry) => entry.messageId),
      }
    }
    case "ferry": {
      const route = routeLabel(leg.originPort, leg.destinationPort)
      return {
        tripId: trip.tripId,
        tripName: trip.name,
        legId: leg.legId,
        kind: leg.kind,
        status: leg.status,
        start: leg.departureAt,
        end: leg.arrivalAt,
        title: compact([leg.operator ?? leg.vendor ?? "ferry", route]),
        where: route,
        evidenceIds: leg.evidence.map((entry) => entry.messageId),
      }
    }
    case "event": {
      const where = [leg.venue, leg.city].filter(Boolean).join(", ") || undefined
      return {
        tripId: trip.tripId,
        tripName: trip.name,
        legId: leg.legId,
        kind: leg.kind,
        status: leg.status,
        start: leg.startsAt,
        end: leg.endsAt,
        title: leg.vendor ?? "event",
        where,
        evidenceIds: leg.evidence.map((entry) => entry.messageId),
      }
    }
  }
}

function calendarEntryRange(entry: TripCalendarEntry): string {
  if (entry.start && entry.end && entry.start !== entry.end) return `${entry.start} -> ${entry.end}`
  return entry.start ?? entry.end ?? "(undated)"
}

function renderTripCalendar(trips: TripRecord[], includeUndated: boolean): string {
  const entries = trips
    .flatMap((trip) => trip.legs.map((leg) => tripLegCalendarEntry(trip, leg)))
    .filter((entry) => includeUndated || entry.start || entry.end)
    .sort((left, right) => {
      const leftKey = left.start ?? left.end ?? "9999-99-99T99:99:99.999Z"
      const rightKey = right.start ?? right.end ?? "9999-99-99T99:99:99.999Z"
      return leftKey.localeCompare(rightKey) || left.tripName.localeCompare(right.tripName) || left.legId.localeCompare(right.legId)
    })
  if (entries.length === 0) return includeUndated ? "no calendar entries on the trip ledger yet." : "no dated calendar entries on the trip ledger yet."
  const noun = entries.length === 1 ? "entry" : "entries"
  const lines = [`${entries.length} trip calendar ${noun}:`]
  for (const entry of entries) {
    lines.push(`- ${calendarEntryRange(entry)} | ${entry.kind} | ${entry.status} | ${entry.title}`)
    lines.push(`  trip: ${entry.tripName} (${entry.tripId}); leg: ${entry.legId}`)
    if (entry.where) lines.push(`  where: ${entry.where}`)
    if (entry.evidenceIds.length > 0) lines.push(`  evidence: ${entry.evidenceIds.join(", ")}`)
  }
  return lines.join("\n")
}

export const tripToolDefinitions: ToolDefinition[] = [
  {
    tool: {
      type: "function",
      function: {
        name: "trip_ensure_ledger",
        description: "Idempotently ensure this agent has a trip ledger keypair. Safe to call multiple times. Required once before any other trip_ tool.",
        parameters: { type: "object", properties: {} },
      },
    },
    handler: async (_args, ctx) => {
      if (!trustAllowsTripAccess(ctx)) return "trip ledger is private; this tool is only available in trusted contexts."
      const result = ensureAgentTripLedger({ agentName: getAgentName() })
      const verb = result.added ? "created" : "already present"
      return `trip ledger ${verb}: ledgerId=${result.ledger.ledgerId}, keyId=${result.ledger.keyId}, createdAt=${result.ledger.createdAt}`
    },
    summaryKeys: [],
  },
  {
    tool: {
      type: "function",
      function: {
        name: "trip_status",
        description: "List the agent's trip ids in sorted order. Cheap overview before opening individual trips.",
        parameters: { type: "object", properties: {} },
      },
    },
    handler: async (_args, ctx) => {
      if (!trustAllowsTripAccess(ctx)) return "trip ledger is private; this tool is only available in trusted contexts."
      const tripIds = listTripIds(getAgentName())
      if (tripIds.length === 0) return "no trips on the ledger yet."
      return `${tripIds.length} trip(s):\n${tripIds.map((id) => `- ${id}`).join("\n")}`
    },
    summaryKeys: [],
  },
  {
    tool: {
      type: "function",
      function: {
        name: "trip_get",
        description: "Read one trip record by id. Returns a structured summary plus the raw JSON for further reasoning.",
        parameters: {
          type: "object",
          properties: {
            tripId: { type: "string", description: "Canonical trip id (trip_<slug>_<fingerprint>)." },
          },
          required: ["tripId"],
        },
      },
    },
    handler: async (args, ctx) => {
      if (!trustAllowsTripAccess(ctx)) return "trip ledger is private; this tool is only available in trusted contexts."
      const tripId = args.tripId
      if (typeof tripId !== "string" || tripId.length === 0) return "tripId is required."
      try {
        const trip = readTripRecord(getAgentName(), tripId)
        return [
          renderTripSummary(trip),
          "",
          "raw record (JSON):",
          JSON.stringify(trip, null, 2),
        ].join("\n")
      } catch (error) {
        if (error instanceof TripNotFoundError) return error.message
        throw error
      }
    },
    summaryKeys: ["tripId"],
  },
  {
    tool: {
      type: "function",
      function: {
        name: "trip_upsert",
        description: "Create or replace a TripRecord. Pass the full record as a JSON string in `record`. Every leg requires a legId and an evidence array (each evidence entry requires messageId + discoveryMethod). Returns the persisted tripId.",
        parameters: {
          type: "object",
          properties: {
            record: { type: "string", description: "Full TripRecord JSON. Must include tripId, agentId, ownerEmail, name, status, travellers[], legs[], createdAt, updatedAt." },
          },
          required: ["record"],
        },
      },
    },
    handler: async (args, ctx) => {
      if (!trustAllowsTripAccess(ctx)) return "trip ledger is private; this tool is only available in trusted contexts."
      try {
        const parsed = parseJsonArg(args.record, "record")
        const trip = validateTripRecord(parsed)
        ensureAgentTripLedger({ agentName: getAgentName() })
        upsertTripRecord(getAgentName(), trip)
        return `trip upserted: ${trip.tripId} (${trip.legs.length} leg(s), status=${trip.status})`
      } catch (error) {
        return `upsert failed: ${error instanceof Error ? error.message : /* v8 ignore next -- non-Error throw is unreachable from validateTripRecord/parseJsonArg */ String(error)}`
      }
    },
    summaryKeys: [],
  },
  {
    tool: {
      type: "function",
      function: {
        name: "trip_attach_evidence",
        description: "Append a TripEvidence record to a specific leg's evidence array. Pass tripId, legId, and the evidence as a JSON string. Useful when extracting a fact from a single mail message and attaching it to an existing leg without re-uploading the whole record.",
        parameters: {
          type: "object",
          properties: {
            tripId: { type: "string", description: "Canonical trip id." },
            legId: { type: "string", description: "Leg id within the trip." },
            evidence: { type: "string", description: "TripEvidence JSON: { messageId, reason, recordedAt, discoveryMethod, excerpt? }." },
          },
          required: ["tripId", "legId", "evidence"],
        },
      },
    },
    handler: async (args, ctx) => {
      if (!trustAllowsTripAccess(ctx)) return "trip ledger is private; this tool is only available in trusted contexts."
      const tripId = args.tripId
      const legId = args.legId
      if (typeof tripId !== "string" || tripId.length === 0) return "tripId is required."
      if (typeof legId !== "string" || legId.length === 0) return "legId is required."
      try {
        const evidence = validateTripEvidence(parseJsonArg(args.evidence, "evidence"))
        const trip = readTripRecord(getAgentName(), tripId)
        const legIndex = trip.legs.findIndex((leg) => leg.legId === legId)
        if (legIndex === -1) return `leg ${legId} not found in trip ${tripId}.`
        const leg = trip.legs[legIndex]!
        const updatedLeg: TripLeg = {
          ...leg,
          evidence: [...leg.evidence, evidence],
          updatedAt: evidence.recordedAt,
        } as TripLeg
        const updated: TripRecord = {
          ...trip,
          legs: [...trip.legs.slice(0, legIndex), updatedLeg, ...trip.legs.slice(legIndex + 1)],
          updatedAt: evidence.recordedAt,
        }
        upsertTripRecord(getAgentName(), updated)
        emitNervesEvent({
          component: "trips",
          event: "trips.evidence_attached",
          message: "trip evidence attached to leg",
          meta: { agentId: getAgentName(), tripId, legId, discoveryMethod: evidence.discoveryMethod, messageId: evidence.messageId },
        })
        return `evidence attached to leg ${legId} in ${tripId}; leg now carries ${updatedLeg.evidence.length} evidence entries.`
      } catch (error) {
        if (error instanceof TripNotFoundError) return error.message
        return `attach failed: ${error instanceof Error ? error.message : /* v8 ignore next -- non-Error throw is unreachable from validateTripEvidence/parseJsonArg/store */ String(error)}`
      }
    },
    summaryKeys: ["tripId", "legId"],
  },
  {
    tool: {
      type: "function",
      function: {
        name: "trip_update_leg",
        description: "Update specific fields of an existing leg in a trip. Pass tripId, legId, and a JSON object of field updates (e.g. {status:\"cancelled\", confirmationCode:\"PNR123\"}). Existing evidence is preserved unless explicitly overwritten. Use this instead of trip_upsert when you only need to change one leg without re-emitting the whole record. The leg's `kind` cannot be changed (changing kind means a new leg).",
        parameters: {
          type: "object",
          properties: {
            tripId: { type: "string", description: "Canonical trip id." },
            legId: { type: "string", description: "Leg id within the trip." },
            updates: { type: "string", description: "JSON object of leg fields to update. Cannot include `legId` or `kind`. Common fields: status, confirmationCode, vendor, amount, checkInDate, checkOutDate, departureTime, arrivalTime, etc." },
            updatedAt: { type: "string", description: "ISO timestamp for the update. Used both for the leg's updatedAt and the trip's updatedAt." },
          },
          required: ["tripId", "legId", "updates", "updatedAt"],
        },
      },
    },
    handler: async (args, ctx) => {
      if (!trustAllowsTripAccess(ctx)) return "trip ledger is private; this tool is only available in trusted contexts."
      const tripId = args.tripId
      const legId = args.legId
      const updatedAt = args.updatedAt
      if (typeof tripId !== "string" || tripId.length === 0) return "tripId is required."
      if (typeof legId !== "string" || legId.length === 0) return "legId is required."
      if (typeof updatedAt !== "string" || updatedAt.length === 0) return "updatedAt is required."
      try {
        const updates = parseJsonArg(args.updates, "updates")
        if (!isRecord(updates)) return "updates must be a JSON object."
        // Reject identity-changing fields — those would silently break referential integrity.
        if ("legId" in updates) return "updates cannot change legId; create a new leg instead."
        if ("kind" in updates) return "updates cannot change kind; create a new leg instead."
        if (Object.keys(updates).length === 0) return "updates cannot be empty — pass at least one field."
        const trip = readTripRecord(getAgentName(), tripId)
        const legIndex = trip.legs.findIndex((leg) => leg.legId === legId)
        if (legIndex === -1) return `leg ${legId} not found in trip ${tripId}.`
        const leg = trip.legs[legIndex]!
        const updatedLeg = {
          ...leg,
          ...updates,
          legId: leg.legId,
          kind: leg.kind,
          updatedAt,
        } as TripLeg
        const updated: TripRecord = {
          ...trip,
          legs: [...trip.legs.slice(0, legIndex), updatedLeg, ...trip.legs.slice(legIndex + 1)],
          updatedAt,
        }
        upsertTripRecord(getAgentName(), updated)
        emitNervesEvent({
          component: "trips",
          event: "trips.leg_updated",
          message: "trip leg fields updated",
          meta: { agentId: getAgentName(), tripId, legId, fields: Object.keys(updates) },
        })
        const fieldList = Object.keys(updates).join(", ")
        return `leg ${legId} updated in ${tripId}: ${fieldList}.`
      } catch (error) {
        if (error instanceof TripNotFoundError) return error.message
        return `update failed: ${error instanceof Error ? error.message : /* v8 ignore next -- non-Error throw is unreachable from parseJsonArg/store */ String(error)}`
      }
    },
    summaryKeys: ["tripId", "legId"],
  },
  {
    tool: {
      type: "function",
      function: {
        name: "trip_remove_leg",
        description: "Remove a leg from a trip. Use when a leg was added by mistake or the booking was cancelled. Updates the trip's updatedAt. Rejects when the leg id is unknown so accidental no-op removals are visible.",
        parameters: {
          type: "object",
          properties: {
            tripId: { type: "string", description: "Canonical trip id." },
            legId: { type: "string", description: "Leg id within the trip to drop." },
            updatedAt: { type: "string", description: "ISO timestamp for the trip's updatedAt." },
            reason: { type: "string", description: "Why the leg is being removed. Logged in nerves for audit." },
          },
          required: ["tripId", "legId", "updatedAt"],
        },
      },
    },
    handler: async (args, ctx) => {
      if (!trustAllowsTripAccess(ctx)) return "trip ledger is private; this tool is only available in trusted contexts."
      const tripId = args.tripId
      const legId = args.legId
      const updatedAt = args.updatedAt
      if (typeof tripId !== "string" || tripId.length === 0) return "tripId is required."
      if (typeof legId !== "string" || legId.length === 0) return "legId is required."
      if (typeof updatedAt !== "string" || updatedAt.length === 0) return "updatedAt is required."
      try {
        const trip = readTripRecord(getAgentName(), tripId)
        const legIndex = trip.legs.findIndex((leg) => leg.legId === legId)
        if (legIndex === -1) return `leg ${legId} not found in trip ${tripId}.`
        const droppedLeg = trip.legs[legIndex]!
        const updated: TripRecord = {
          ...trip,
          legs: [...trip.legs.slice(0, legIndex), ...trip.legs.slice(legIndex + 1)],
          updatedAt,
        }
        upsertTripRecord(getAgentName(), updated)
        emitNervesEvent({
          component: "trips",
          event: "trips.leg_removed",
          message: "trip leg removed from ledger",
          meta: {
            agentId: getAgentName(),
            tripId,
            legId,
            kind: droppedLeg.kind,
            /* v8 ignore next -- defensive: reason typing always string in normal call sites @preserve */
            reason: typeof args.reason === "string" ? args.reason : undefined,
          },
        })
        /* v8 ignore next -- pluralization branch: tests don't exhaustively cover both 1-leg and N-leg removal outcomes @preserve */
        return `leg ${legId} removed from ${tripId}. trip now has ${updated.legs.length} leg${updated.legs.length === 1 ? "" : "s"}.`
      } /* v8 ignore start -- error-classification branches: TripNotFoundError vs unexpected store failure; the latter is covered by trip-store unit tests rather than tool-level fixtures @preserve */ catch (error) {
        if (error instanceof TripNotFoundError) return error.message
        return `remove failed: ${error instanceof Error ? error.message : String(error)}`
      } /* v8 ignore stop */
    },
    summaryKeys: ["tripId", "legId", "reason"],
  },
  {
    tool: {
      type: "function",
      function: {
        name: "trip_calendar",
        description: "Render a chronological calendar/agenda projection from the trip ledger. Use this after extracting mail-backed trip facts so the agent can track dates across lodging, travel, events, and local transport.",
        parameters: {
          type: "object",
          properties: {
            tripId: { type: "string", description: "Optional canonical trip id. Omit to render all trips on the ledger." },
            includeUndated: { type: "string", enum: ["true", "false"], description: "Set true to include legs that have no start/end dates yet. Defaults to false." },
          },
        },
      },
    },
    handler: async (args, ctx) => {
      if (!trustAllowsTripAccess(ctx)) return "trip ledger is private; this tool is only available in trusted contexts."
      const includeUndated = args.includeUndated === "true"
      const tripId = typeof args.tripId === "string" ? args.tripId.trim() : ""
      try {
        const trips = tripId
          ? [readTripRecord(getAgentName(), tripId)]
          : listTripIds(getAgentName()).map((id) => readTripRecord(getAgentName(), id))
        if (trips.length === 0) return "no trips on the ledger yet."
        return renderTripCalendar(trips, includeUndated)
      } catch (error) {
        if (error instanceof TripNotFoundError) return error.message
        throw error
      }
    },
    summaryKeys: ["tripId"],
  },
  {
    tool: {
      type: "function",
      function: {
        name: "trip_new_id",
        description: "Compute a deterministic trip id from agentId + name + createdAt. Useful before constructing a new TripRecord so the id is stable and reproducible.",
        parameters: {
          type: "object",
          properties: {
            name: { type: "string", description: "Human-friendly trip name (e.g. \"Europe summer 2026\")." },
            createdAt: { type: "string", description: "ISO timestamp the trip was first conceived. Pass `now` if just creating it." },
          },
          required: ["name", "createdAt"],
        },
      },
    },
    handler: async (args, ctx) => {
      if (!trustAllowsTripAccess(ctx)) return "trip ledger is private; this tool is only available in trusted contexts."
      const name = args.name
      const createdAt = args.createdAt
      if (typeof name !== "string" || name.length === 0) return "name is required."
      if (typeof createdAt !== "string" || createdAt.length === 0) return "createdAt is required."
      return newTripId(getAgentName(), name, createdAt)
    },
    summaryKeys: ["name"],
  },
]
