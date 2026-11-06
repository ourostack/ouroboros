import { createHash, randomUUID } from "node:crypto"
import type { ToolDefinition } from "./tools-base"
import { isTrustedLevel } from "@ouro.bot/friends"
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

type TripMutationPreviewKind = "replace_trip" | "update_leg" | "remove_leg"

interface PendingTripMutationPreview {
  kind: TripMutationPreviewKind
  agentName: string
  tripId: string
  legId?: string
  digest: string
  createdAtMs: number
}

const TRIP_PREVIEW_TOKEN_TTL_MS = 15 * 60 * 1000
const pendingTripMutationPreviews = new Map<string, PendingTripMutationPreview>()

function stableJson(value: unknown): string {
  if (value === undefined) return "undefined"
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`
  }
  return JSON.stringify(value)
}

function previewDigest(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex")
}

function pruneExpiredPreviews(nowMs = Date.now()): void {
  for (const [token, preview] of pendingTripMutationPreviews.entries()) {
    if (nowMs - preview.createdAtMs > TRIP_PREVIEW_TOKEN_TTL_MS) {
      pendingTripMutationPreviews.delete(token)
    }
  }
}

function rememberPreview(input: Omit<PendingTripMutationPreview, "createdAtMs">): string {
  pruneExpiredPreviews()
  const token = `trip_preview_${randomUUID()}`
  pendingTripMutationPreviews.set(token, { ...input, createdAtMs: Date.now() })
  return token
}

function consumePreview(input: {
  token: unknown
  kind: TripMutationPreviewKind
  agentName: string
  tripId: string
  legId?: string
  digest: string
  previewToolName: string
  attemptSummary: string
}): string | null {
  const token = typeof input.token === "string" ? input.token.trim() : ""
  if (!token) {
    const guidance = `previewToken is required. Call ${input.previewToolName} first, inspect the diff, then retry with its previewToken.`
    return `${guidance}\nAttempted change:\n${input.attemptSummary}`
  }
  pruneExpiredPreviews()
  const preview = pendingTripMutationPreviews.get(token)
  if (!preview) return `previewToken is invalid or expired. Call ${input.previewToolName} again.`
  const matches = preview.kind === input.kind
    && preview.agentName === input.agentName
    && preview.tripId === input.tripId
    && preview.legId === input.legId
    && preview.digest === input.digest
  if (!matches) return `previewToken does not match the current trip state or requested change. Call ${input.previewToolName} again.`
  pendingTripMutationPreviews.delete(token)
  return null
}

function formatPreviewValue(value: unknown): string {
  return value === undefined ? "(unset)" : stableJson(value)
}

function previewAttemptSummary(renderedPreview: string): string {
  return renderedPreview.replace(/^previewToken: .*\n/, "")
}

function changedRecordKeys(before: Record<string, unknown>, after: Record<string, unknown>, omit = new Set<string>()): string[] {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)])
  return [...keys]
    .filter((key) => !omit.has(key))
    .filter((key) => stableJson(before[key]) !== stableJson(after[key]))
    .sort()
}

function legPreviewLabel(trip: TripRecord, leg: TripLeg): string {
  const entry = tripLegCalendarEntry(trip, leg)
  return `${entry.title} [${entry.kind}; ${entry.status}; ${calendarEntryRange(entry)}; leg=${entry.legId}]`
}

function updateLegPreviewDigest(input: {
  agentName: string
  trip: TripRecord
  leg: TripLeg
  updates: Record<string, unknown>
}): string {
  return previewDigest({
    kind: "update_leg",
    agentName: input.agentName,
    tripId: input.trip.tripId,
    tripUpdatedAt: input.trip.updatedAt,
    leg: input.leg,
    updates: input.updates,
  })
}

function removeLegPreviewDigest(input: {
  agentName: string
  trip: TripRecord
  leg: TripLeg
}): string {
  return previewDigest({
    kind: "remove_leg",
    agentName: input.agentName,
    trip: input.trip,
    leg: input.leg,
  })
}

function replaceTripPreviewDigest(input: {
  agentName: string
  currentTrip: TripRecord
  replacementTrip: TripRecord
}): string {
  return previewDigest({
    kind: "replace_trip",
    agentName: input.agentName,
    currentTrip: input.currentTrip,
    replacementTrip: input.replacementTrip,
  })
}

function renderUpdateLegPreview(input: {
  trip: TripRecord
  leg: TripLeg
  updates: Record<string, unknown>
  token: string
}): string {
  const legRecord = input.leg as unknown as Record<string, unknown>
  const lines = [
    `previewToken: ${input.token}`,
    `trip: ${input.trip.name} (${input.trip.tripId})`,
    `leg: ${legPreviewLabel(input.trip, input.leg)}`,
    "changes:",
  ]
  for (const key of Object.keys(input.updates).sort()) {
    lines.push(`- ${key}: ${formatPreviewValue(legRecord[key])} -> ${formatPreviewValue(input.updates[key])}`)
  }
  return lines.join("\n")
}

function renderRemoveLegPreview(input: {
  trip: TripRecord
  leg: TripLeg
  token: string
}): string {
  return [
    `previewToken: ${input.token}`,
    `trip: ${input.trip.name} (${input.trip.tripId})`,
    `will remove: ${legPreviewLabel(input.trip, input.leg)}`,
    `trip legs: ${input.trip.legs.length} -> ${input.trip.legs.length - 1}`,
    `evidence on removed leg: ${input.leg.evidence.length}`,
    "removed leg (JSON):",
    JSON.stringify(input.leg, null, 2),
  ].join("\n")
}

function renderReplaceTripPreview(input: {
  currentTrip: TripRecord
  replacementTrip: TripRecord
  token: string
}): string {
  const currentLegs = new Map(input.currentTrip.legs.map((leg) => [leg.legId, leg]))
  const replacementLegs = new Map(input.replacementTrip.legs.map((leg) => [leg.legId, leg]))
  const currentLegIds = new Set(currentLegs.keys())
  const replacementLegIds = new Set(replacementLegs.keys())
  const removed = [...currentLegIds].filter((id) => !replacementLegIds.has(id)).sort()
  const added = [...replacementLegIds].filter((id) => !currentLegIds.has(id)).sort()
  const kept = [...replacementLegIds].filter((id) => currentLegIds.has(id)).sort()
  const lines = [
    `previewToken: ${input.token}`,
    `replace trip: ${input.currentTrip.name} (${input.currentTrip.tripId})`,
    `legs: ${input.currentTrip.legs.length} -> ${input.replacementTrip.legs.length}`,
    "top-level changes:",
  ]
  const topLevelChanges = changedRecordKeys(
    input.currentTrip as unknown as Record<string, unknown>,
    input.replacementTrip as unknown as Record<string, unknown>,
    new Set(["legs"]),
  )
  if (topLevelChanges.length === 0) {
    lines.push("- (none)")
  } else {
    for (const key of topLevelChanges) {
      const before = input.currentTrip as unknown as Record<string, unknown>
      const after = input.replacementTrip as unknown as Record<string, unknown>
      lines.push(`- ${key}: ${formatPreviewValue(before[key])} -> ${formatPreviewValue(after[key])}`)
    }
  }
  lines.push("leg changes:")
  let legChangeCount = 0
  for (const legId of removed) {
    const leg = currentLegs.get(legId)!
    lines.push(`- removed ${legId}: ${legPreviewLabel(input.currentTrip, leg)}`)
    legChangeCount += 1
  }
  for (const legId of added) {
    const leg = replacementLegs.get(legId)!
    lines.push(`- added ${legId}: ${legPreviewLabel(input.replacementTrip, leg)}`)
    legChangeCount += 1
  }
  for (const legId of kept) {
    const before = currentLegs.get(legId)! as unknown as Record<string, unknown>
    const after = replacementLegs.get(legId)! as unknown as Record<string, unknown>
    const fieldChanges = changedRecordKeys(before, after)
    for (const field of fieldChanges) {
      lines.push(`- changed ${legId}.${field}: ${formatPreviewValue(before[field])} -> ${formatPreviewValue(after[field])}`)
      legChangeCount += 1
    }
  }
  if (legChangeCount === 0) lines.push("- (none)")
  return lines.join("\n")
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
    riskProfile: { mutates: "durable_state_write", risk: "high", reason: "creates trip ledger state" },
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
        name: "trip_replace_preview",
        description: "Preview replacing an existing trip record before calling trip_upsert. Returns a short-lived previewToken that trip_upsert requires when the record already exists.",
        parameters: {
          type: "object",
          properties: {
            record: { type: "string", description: "Full replacement TripRecord JSON, same shape accepted by trip_upsert." },
          },
          required: ["record"],
        },
      },
    },
    handler: async (args, ctx) => {
      if (!trustAllowsTripAccess(ctx)) return "trip ledger is private; this tool is only available in trusted contexts."
      try {
        const parsed = parseJsonArg(args.record, "record")
        const replacementTrip = validateTripRecord(parsed)
        const agentName = getAgentName()
        const currentTrip = readTripRecord(agentName, replacementTrip.tripId)
        const digest = replaceTripPreviewDigest({ agentName, currentTrip, replacementTrip })
        const token = rememberPreview({ kind: "replace_trip", agentName, tripId: replacementTrip.tripId, digest })
        return renderReplaceTripPreview({ currentTrip, replacementTrip, token })
      } catch (error) {
        if (error instanceof TripNotFoundError) return "no existing trip record found; new trip creation does not require trip_replace_preview."
        return `replace preview failed: ${error instanceof Error ? error.message : /* v8 ignore next -- non-Error throw is unreachable from validateTripRecord/parseJsonArg */ String(error)}`
      }
    },
    summaryKeys: [],
  },
  {
    tool: {
      type: "function",
      function: {
        name: "trip_upsert",
        description: "Create or replace a TripRecord. Pass the full record as a JSON string in `record`. Every leg requires a legId and an evidence array (each evidence entry requires messageId + discoveryMethod). Replacing an existing record requires trip_replace_preview first and its previewToken. Returns the persisted tripId.",
        parameters: {
          type: "object",
          properties: {
            record: { type: "string", description: "Full TripRecord JSON. Must include tripId, agentId, ownerEmail, name, status, travellers[], legs[], createdAt, updatedAt." },
            writeReason: { type: "string", description: "Required when replacing an existing trip record. One-line source or reason that makes the whole-record replacement correct." },
            previewToken: { type: "string", description: "Required when replacing an existing trip record. Get it from trip_replace_preview after inspecting the replacement diff." },
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
        const agentName = getAgentName()
        ensureAgentTripLedger({ agentName })
        let replacesExisting = false
        let currentTrip: TripRecord | undefined
        try {
          currentTrip = readTripRecord(agentName, trip.tripId)
          replacesExisting = true
        } catch (error) {
          if (!(error instanceof TripNotFoundError)) throw error
        }
        const writeReason = typeof args.writeReason === "string" ? args.writeReason.trim() : ""
        if (replacesExisting && writeReason.length === 0) {
          return "writeReason is required when replacing an existing trip record."
        }
        if (replacesExisting && currentTrip) {
          const digest = replaceTripPreviewDigest({ agentName, currentTrip, replacementTrip: trip })
          const previewError = consumePreview({
            token: args.previewToken,
            kind: "replace_trip",
            agentName,
            tripId: trip.tripId,
            digest,
            previewToolName: "trip_replace_preview",
            attemptSummary: previewAttemptSummary(renderReplaceTripPreview({ currentTrip, replacementTrip: trip, token: "" })),
          })
          if (previewError) return previewError
        }
        upsertTripRecord(agentName, trip)
        if (replacesExisting) {
          emitNervesEvent({
            component: "trips",
            event: "trips.record_replaced",
            message: "trip record replaced with write reason",
            meta: { agentId: agentName, tripId: trip.tripId, legCount: trip.legs.length, status: trip.status, writeReason: writeReason.slice(0, 240) },
          })
          return `trip replaced: ${trip.tripId} (${trip.legs.length} leg(s), status=${trip.status}). reason: ${writeReason}`
        }
        return `trip upserted: ${trip.tripId} (${trip.legs.length} leg(s), status=${trip.status})`
      } catch (error) {
        return `upsert failed: ${error instanceof Error ? error.message : /* v8 ignore next -- non-Error throw is unreachable from validateTripRecord/parseJsonArg */ String(error)}`
      }
    },
    summaryKeys: [],
    riskProfile: { mutates: "durable_state_write", risk: "high", reason: "creates or replaces trip records" },
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
    riskProfile: { mutates: "durable_state_write", risk: "high", reason: "appends trip evidence" },
  },
  {
    tool: {
      type: "function",
      function: {
        name: "trip_update_leg_preview",
        description: "Preview a trip_update_leg mutation before committing it. Returns a diff plus a short-lived previewToken that trip_update_leg requires.",
        parameters: {
          type: "object",
          properties: {
            tripId: { type: "string", description: "Canonical trip id." },
            legId: { type: "string", description: "Leg id within the trip." },
            updates: { type: "string", description: "JSON object of leg fields to update. Cannot include `legId` or `kind`." },
          },
          required: ["tripId", "legId", "updates"],
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
        const updates = parseJsonArg(args.updates, "updates")
        if (!isRecord(updates)) return "updates must be a JSON object."
        if ("legId" in updates) return "updates cannot change legId; create a new leg instead."
        if ("kind" in updates) return "updates cannot change kind; create a new leg instead."
        if (Object.keys(updates).length === 0) return "updates cannot be empty — pass at least one field."
        const agentName = getAgentName()
        const trip = readTripRecord(agentName, tripId)
        const leg = trip.legs.find((candidate) => candidate.legId === legId)
        if (!leg) return `leg ${legId} not found in trip ${tripId}.`
        const digest = updateLegPreviewDigest({ agentName, trip, leg, updates })
        const token = rememberPreview({ kind: "update_leg", agentName, tripId, legId, digest })
        return renderUpdateLegPreview({ trip, leg, updates, token })
      } catch (error) {
        if (error instanceof TripNotFoundError) return error.message
        return `update preview failed: ${error instanceof Error ? error.message : /* v8 ignore next -- non-Error throw is unreachable from parseJsonArg/store */ String(error)}`
      }
    },
    summaryKeys: ["tripId", "legId"],
  },
  {
    tool: {
      type: "function",
      function: {
        name: "trip_update_leg",
        description: "Update specific fields of an existing leg in a trip. Pass tripId, legId, and a JSON object of field updates (e.g. {status:\"cancelled\", confirmationCode:\"PNR123\"}). Existing evidence is preserved unless explicitly overwritten. Use this instead of trip_upsert when you only need to change one leg without re-emitting the whole record. The leg's `kind` cannot be changed (changing kind means a new leg). Requires trip_update_leg_preview first and its previewToken.",
        parameters: {
          type: "object",
          properties: {
            tripId: { type: "string", description: "Canonical trip id." },
            legId: { type: "string", description: "Leg id within the trip." },
            updates: { type: "string", description: "JSON object of leg fields to update. Cannot include `legId` or `kind`. Common fields: status, confirmationCode, vendor, amount, checkInDate, checkOutDate, departureTime, arrivalTime, etc." },
            updatedAt: { type: "string", description: "ISO timestamp for the update. Used both for the leg's updatedAt and the trip's updatedAt." },
            updateReason: { type: "string", description: "One-line source or reason that makes this update correct. Required so semantic trip writes remain auditable." },
            previewToken: { type: "string", description: "Required. Get it from trip_update_leg_preview after inspecting the diff." },
          },
          required: ["tripId", "legId", "updates", "updatedAt", "updateReason", "previewToken"],
        },
      },
    },
    handler: async (args, ctx) => {
      if (!trustAllowsTripAccess(ctx)) return "trip ledger is private; this tool is only available in trusted contexts."
      const tripId = args.tripId
      const legId = args.legId
      const updatedAt = args.updatedAt
      const updateReason = typeof args.updateReason === "string" ? args.updateReason.trim() : ""
      if (typeof tripId !== "string" || tripId.length === 0) return "tripId is required."
      if (typeof legId !== "string" || legId.length === 0) return "legId is required."
      if (typeof updatedAt !== "string" || updatedAt.length === 0) return "updatedAt is required."
      if (updateReason.length === 0) return "updateReason is required."
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
        const agentName = getAgentName()
        const digest = updateLegPreviewDigest({ agentName, trip, leg, updates })
        const previewError = consumePreview({
          token: args.previewToken,
          kind: "update_leg",
          agentName,
          tripId,
          legId,
          digest,
          previewToolName: "trip_update_leg_preview",
          attemptSummary: previewAttemptSummary(renderUpdateLegPreview({ trip, leg, updates, token: "" })),
        })
        if (previewError) return previewError
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
        upsertTripRecord(agentName, updated)
        emitNervesEvent({
          component: "trips",
          event: "trips.leg_updated",
          message: "trip leg fields updated",
          meta: { agentId: agentName, tripId, legId, fields: Object.keys(updates), updateReason: updateReason.slice(0, 240) },
        })
        const fieldList = Object.keys(updates).join(", ")
        return `leg ${legId} updated in ${tripId}: ${fieldList}. reason: ${updateReason}`
      } catch (error) {
        if (error instanceof TripNotFoundError) return error.message
        return `update failed: ${error instanceof Error ? error.message : /* v8 ignore next -- non-Error throw is unreachable from parseJsonArg/store */ String(error)}`
      }
    },
    summaryKeys: ["tripId", "legId"],
    riskProfile: { mutates: "durable_state_write", risk: "high", reason: "updates trip leg fields" },
  },
  {
    tool: {
      type: "function",
      function: {
        name: "trip_remove_leg_preview",
        description: "Preview removing a leg from a trip before committing it. Returns the leg summary plus a short-lived previewToken that trip_remove_leg requires.",
        parameters: {
          type: "object",
          properties: {
            tripId: { type: "string", description: "Canonical trip id." },
            legId: { type: "string", description: "Leg id within the trip to drop." },
          },
          required: ["tripId", "legId"],
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
        const agentName = getAgentName()
        const trip = readTripRecord(agentName, tripId)
        const leg = trip.legs.find((candidate) => candidate.legId === legId)
        if (!leg) return `leg ${legId} not found in trip ${tripId}.`
        const digest = removeLegPreviewDigest({ agentName, trip, leg })
        const token = rememberPreview({ kind: "remove_leg", agentName, tripId, legId, digest })
        return renderRemoveLegPreview({ trip, leg, token })
      } catch (error) {
        if (error instanceof TripNotFoundError) return error.message
        return `remove preview failed: ${error instanceof Error ? error.message : String(error)}`
      }
    },
    summaryKeys: ["tripId", "legId"],
  },
  {
    tool: {
      type: "function",
      function: {
        name: "trip_remove_leg",
        description: "Remove a leg from a trip. Use when a leg was added by mistake or the booking was cancelled. Updates the trip's updatedAt. Rejects when the leg id is unknown so accidental no-op removals are visible. Requires trip_remove_leg_preview first and its previewToken.",
        parameters: {
          type: "object",
          properties: {
            tripId: { type: "string", description: "Canonical trip id." },
            legId: { type: "string", description: "Leg id within the trip to drop." },
            updatedAt: { type: "string", description: "ISO timestamp for the trip's updatedAt." },
            reason: { type: "string", description: "Why the leg is being removed. Logged in nerves for audit." },
            previewToken: { type: "string", description: "Required. Get it from trip_remove_leg_preview after inspecting the leg removal preview." },
          },
          required: ["tripId", "legId", "updatedAt", "reason", "previewToken"],
        },
      },
    },
    handler: async (args, ctx) => {
      if (!trustAllowsTripAccess(ctx)) return "trip ledger is private; this tool is only available in trusted contexts."
      const tripId = args.tripId
      const legId = args.legId
      const updatedAt = args.updatedAt
      const reason = typeof args.reason === "string" ? args.reason.trim() : ""
      if (typeof tripId !== "string" || tripId.length === 0) return "tripId is required."
      if (typeof legId !== "string" || legId.length === 0) return "legId is required."
      if (typeof updatedAt !== "string" || updatedAt.length === 0) return "updatedAt is required."
      if (reason.length === 0) return "reason is required."
      try {
        const trip = readTripRecord(getAgentName(), tripId)
        const legIndex = trip.legs.findIndex((leg) => leg.legId === legId)
        if (legIndex === -1) return `leg ${legId} not found in trip ${tripId}.`
        const droppedLeg = trip.legs[legIndex]!
        const agentName = getAgentName()
        const digest = removeLegPreviewDigest({ agentName, trip, leg: droppedLeg })
        const previewError = consumePreview({
          token: args.previewToken,
          kind: "remove_leg",
          agentName,
          tripId,
          legId,
          digest,
          previewToolName: "trip_remove_leg_preview",
          attemptSummary: previewAttemptSummary(renderRemoveLegPreview({ trip, leg: droppedLeg, token: "" })),
        })
        if (previewError) return previewError
        const updated: TripRecord = {
          ...trip,
          legs: [...trip.legs.slice(0, legIndex), ...trip.legs.slice(legIndex + 1)],
          updatedAt,
        }
        upsertTripRecord(agentName, updated)
        emitNervesEvent({
          component: "trips",
          event: "trips.leg_removed",
          message: "trip leg removed from ledger",
          meta: {
            agentId: agentName,
            tripId,
            legId,
            kind: droppedLeg.kind,
            reason,
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
    riskProfile: { mutates: "durable_state_write", risk: "high", reason: "removes trip legs" },
  },
  {
    tool: {
      type: "function",
      function: {
        name: "trip_calendar",
        description: "Render a chronological calendar/agenda projection from the trip ledger. Use this before answering current itinerary, travel gap, or what-changed questions; friend notes and old handoffs may be stale. Also use this after extracting mail-backed trip facts so the agent can track dates across lodging, travel, events, and local transport.",
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
