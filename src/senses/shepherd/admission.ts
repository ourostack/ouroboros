import type { ShepherdMandateResolution } from "../../heart/shepherd/types"
import type { ShepherdHostCapabilities, ShepherdInspection } from "./host"
import type { Verdict } from "./judge"
import type { ShepherdActionBlockReason } from "./returns"

export const SHEPHERD_CONTINUATION_INTENT = "Continue the existing authorized task."

export interface ShepherdAdmissionInput {
  host: string
  capabilities: ShepherdHostCapabilities
  expected: ShepherdInspection
  current: ShepherdInspection
  nowMs: number
  observationAgeMs: number
  verdict: Verdict
  mandate: ShepherdMandateResolution
  mandateRevisions: { expected: number; current: number }
  guidance: { expected: string; current: string; paused: boolean }
  active: boolean
  sameGeneration: boolean
  focusHeld: boolean
  withinLimits: boolean
  custodyAvailable: boolean
  attribution: { sender: string; human: string }
  trigger: "immediate" | "network" | "periodic"
}

export type ShepherdAdmissionDecision =
  | { allowed: true; text: string }
  | { allowed: false; reason: ShepherdActionBlockReason; detail: string }

/** Decides text eligibility only; the caller must still acquire durable custody before dispatch. */
export function admitShepherdContinuation(_input: ShepherdAdmissionInput): ShepherdAdmissionDecision {
  return { allowed: false, reason: "host_unverified", detail: "unsupported_host" }
}
