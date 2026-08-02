import { emitNervesEvent } from "../nerves/runtime"

export const RSVP_HABIT_POLICY_VERSION = "rsvp-habit/v1" as const
export const DEFAULT_RSVP_HABIT_NAME = "rsvp-updates" as const
export const RSVP_HABIT_ALLOWED_TOOLS = ["rsvp_query", "rsvp_summary"] as const

export type RsvpHabitMode = "shadow" | "live"
export type RsvpHabitSense = "bluebubbles"
export type RsvpHabitSource = "aisleplanner"

export interface RsvpHabitMetadata {
  policyVersion: typeof RSVP_HABIT_POLICY_VERSION
  mode: RsvpHabitMode
  sense: RsvpHabitSense
  source: RsvpHabitSource
  routeRef: string
  snapshotRef: string
  outboundStateRef: string
  budgetRef: string
  idempotencyRef: string
  liveSendEligible: boolean
  reportTitle?: string
  firstRunLabel?: string
  noChangesLabel?: string
  newRsvpsLabel?: string
  statusChangesLabel?: string
  newGuestsLabel?: string
  removedGuestsLabel?: string
}

export interface RsvpHabitRuntimePolicy extends RsvpHabitMetadata {
  sendAllowed: boolean
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function requiredString(record: Record<string, unknown>, key: string): string {
  const value = record[key]
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`RSVP habit metadata requires ${key}`)
  }
  return value.trim()
}

function requiredBoolean(record: Record<string, unknown>, key: string): boolean {
  const value = record[key]
  if (typeof value === "boolean") return value
  if (value === "true") return true
  if (value === "false") return false
  throw new Error(`RSVP habit metadata requires boolean ${key}`)
}

function optionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key]
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined
}

export function isRsvpHabitName(name: string): boolean {
  return name.startsWith("rsvp-")
}

export function rsvpHabitMetadataErrorDetail(error: unknown): string {
  if (error instanceof Error && error.message.startsWith("RSVP habit metadata ")) {
    return error.message
  }
  return "RSVP habit metadata is invalid"
}

export function parseRsvpHabitMetadata(raw: unknown): RsvpHabitMetadata | null {
  if (raw === undefined || raw === null) return null
  if (!isRecord(raw)) throw new Error("RSVP habit metadata must be an object")
  if (raw.channel !== undefined) {
    throw new Error("RSVP habit metadata requires sense, not channel")
  }

  const policyVersion = requiredString(raw, "policyVersion")
  if (policyVersion !== RSVP_HABIT_POLICY_VERSION) throw new Error("RSVP habit metadata has unsupported policyVersion")

  const mode = requiredString(raw, "mode")
  if (mode !== "shadow" && mode !== "live") throw new Error("RSVP habit metadata mode must be shadow or live")

  const sense = requiredString(raw, "sense")
  if (sense !== "bluebubbles") throw new Error("RSVP habit metadata sense must be bluebubbles")

  const source = requiredString(raw, "source")
  if (source !== "aisleplanner") throw new Error("RSVP habit metadata source must be aisleplanner")

  const parsed: RsvpHabitMetadata = {
    policyVersion: RSVP_HABIT_POLICY_VERSION,
    mode,
    sense,
    source,
    routeRef: requiredString(raw, "routeRef"),
    snapshotRef: requiredString(raw, "snapshotRef"),
    outboundStateRef: requiredString(raw, "outboundStateRef"),
    budgetRef: requiredString(raw, "budgetRef"),
    idempotencyRef: requiredString(raw, "idempotencyRef"),
    liveSendEligible: requiredBoolean(raw, "liveSendEligible"),
  }
  for (const key of [
    "reportTitle",
    "firstRunLabel",
    "noChangesLabel",
    "newRsvpsLabel",
    "statusChangesLabel",
    "newGuestsLabel",
    "removedGuestsLabel",
  ] as const) {
    const value = optionalString(raw, key)
    if (value) parsed[key] = value
  }
  return parsed
}

export function rsvpHabitRuntimePolicy(metadata: RsvpHabitMetadata): RsvpHabitRuntimePolicy {
  const policy = {
    ...metadata,
    sendAllowed: metadata.mode === "live" && metadata.liveSendEligible,
  }
  emitNervesEvent({
    component: "rsvp",
    event: "rsvp.habit_policy_resolved",
    message: "resolved RSVP habit runtime policy",
    meta: {
      mode: metadata.mode,
      sense: metadata.sense,
      source: metadata.source,
      sendAllowed: policy.sendAllowed,
      liveSendEligible: metadata.liveSendEligible,
    },
  })
  return policy
}
