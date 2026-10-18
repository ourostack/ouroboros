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

const blocked = (reason: ShepherdActionBlockReason, detail: string): ShepherdAdmissionDecision => ({ allowed: false, reason, detail })
const counter = (value: number) => Number.isSafeInteger(value) && value >= 0
const unsafeText = /[`\\@;$|<>&\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u
const cues = {
  immediate: "Continue only this authorized task:",
  periodic: "Reassess and continue only this authorized task:",
  network: "Connectivity recovered. Reconcile uncertain effects, then continue only this authorized task:",
}

/** Decides text eligibility only; the caller must still acquire durable custody before dispatch. */
export function admitShepherdContinuation(input: ShepherdAdmissionInput): ShepherdAdmissionDecision {
  if (input.active !== true) return blocked("stopped", "sense_inactive")
  if (input.sameGeneration !== true) return blocked("state_changed", "event_generation_changed")
  if (input.guidance.paused !== false || !input.guidance.expected || input.guidance.expected !== input.guidance.current) {
    return blocked("guidance", "guidance_paused_or_changed")
  }
  if (input.withinLimits !== true) return blocked("loop_guard", "continuation_limit")
  if (input.custodyAvailable !== true) return blocked("custody", "custody_unavailable")
  if (!Number.isFinite(input.nowMs) || input.nowMs < 0 || !Number.isFinite(input.observationAgeMs)
    || input.observationAgeMs < 0 || input.observationAgeMs > 30_000) return blocked("state_changed", "stale_observation")
  if (input.verdict.kind !== "premature") return blocked("reply_invalid", "no_continuation_verdict")
  if (input.verdict.reply && "key" in input.verdict.reply) return blocked("menu_disallowed", "automatic_keys_forbidden")
  if (input.verdict.replyIssue || !input.verdict.reply || !("text" in input.verdict.reply)
    || input.verdict.reply.text !== SHEPHERD_CONTINUATION_INTENT) return blocked("reply_invalid", "reply_scope_unverified")
  if (input.capabilities.state !== "qualified" || input.capabilities.protocolVersion !== 1) {
    return blocked("host_unverified", "guarded_input_not_qualified")
  }
  const before = input.expected, current = input.current
  const first = before.guarded, fresh = current.guarded
  if (!first || !fresh || !first.token || !fresh.token || !before.instance || !current.instance
    || before.session.instance !== before.instance || current.session.instance !== current.instance
    || !before.session.agent || !current.session.agent
    || !input.capabilities.agents.includes(before.session.agent) || !input.capabilities.agents.includes(current.session.agent)
    || before.activity !== "idle" || current.activity !== "idle"
    || before.composer !== "empty" || current.composer !== "empty"
    || before.backgroundWork !== false || current.backgroundWork !== false
    || !before.session.cwd || !current.session.cwd
    || !/^[a-f0-9]{64}$/.test(before.screenFingerprint) || !/^[a-f0-9]{64}$/.test(current.screenFingerprint)) {
    return blocked("host_unverified", "native_observation_not_ready")
  }
  if (input.focusHeld !== false || before.session.focused !== false || current.session.focused !== false) {
    return blocked("focus", "human_focus_hold")
  }
  if (input.mandate.state !== "authorized") return blocked("mandate", input.mandate.reason)
  const mandate = input.mandate.mandate
  const expiry = Date.parse(mandate.expiresAt), created = Date.parse(mandate.createdAt)
  if (mandate.status !== "active" || mandate.action !== "continue_text"
    || !Number.isFinite(expiry) || expiry <= input.nowMs || !Number.isFinite(created) || created > input.nowMs
    || !counter(input.mandateRevisions.expected) || input.mandateRevisions.expected !== input.mandateRevisions.current
    || !counter(mandate.revision) || mandate.revision === 0 || mandate.revision > input.mandateRevisions.current
    || mandate.target.project !== before.session.cwd || mandate.target.project !== current.session.cwd
    || mandate.target.host !== undefined && mandate.target.host !== input.host
    || mandate.target.session !== undefined && mandate.target.session !== current.session.id
    || mandate.target.instance !== undefined && mandate.target.instance !== current.instance) {
    return blocked("mandate", "mandate_expired_changed_or_mismatched")
  }
  if (before.session.id !== current.session.id || before.instance !== current.instance
    || before.session.agent !== current.session.agent || before.session.cwd !== current.session.cwd
    || before.screenFingerprint !== current.screenFingerprint
    || first.workspaceId !== fresh.workspaceId || first.hostInstance !== fresh.hostInstance
    || first.surfaceGeneration !== fresh.surfaceGeneration || first.inputRevision !== fresh.inputRevision
    || first.focusRevision !== fresh.focusRevision
    || !first.workspaceId || !first.hostInstance
    || ![first.surfaceGeneration, first.inputRevision, first.focusRevision,
      fresh.surfaceGeneration, fresh.inputRevision, fresh.focusRevision].every(counter)) {
    return blocked("state_changed", "native_binding_changed")
  }
  if (fresh.expiresAtUnixMs === null || !Number.isFinite(fresh.expiresAtUnixMs)
    || fresh.expiresAtUnixMs <= input.nowMs || fresh.expiresAtUnixMs - input.nowMs > 2_000) {
    return blocked("state_changed", "native_token_expired_or_invalid")
  }
  const text = `[${input.attribution.sender} for ${input.attribution.human}] ${cues[input.trigger]} ${mandate.task} Respect human decisions and reconcile uncertain effects before retrying.`
  if (!mandate.task.trim() || !input.attribution.sender.trim() || !input.attribution.human.trim()
    || text !== text.trim() || text.length > 2_000 || Buffer.byteLength(text, "utf8") > 4_096
    || unsafeText.test(text) || /^[/!#]/.test(text)) return blocked("mandate", "mandate_text_not_suitable_for_input")
  return { allowed: true, text }
}
