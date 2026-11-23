/**
 * The approval relay: Ari answers a tool approval by replying to his primary agent (the owner route's peer) instead of
 * tapping the Telegram card, and that agent's harness sends the answer back as a signed `approvalAnswer`.
 *
 * This file holds the pieces that do no I/O beyond reading the operator's switch:
 * - the relay token, which binds an answer to one approval and one route DID;
 * - the trust-folder switch, which turns the relay on;
 * - the v1 rule that only `deny` is relayed.
 *
 * Design: desk sanctuary-server/butler-productionization/ouroboros/2026-11-23-signed-relay-design-v3.md.
 */
import { createHmac, timingSafeEqual } from "node:crypto"

import { emitNervesEvent } from "../nerves/runtime"
import { operatorTrustFile } from "./operator-trust"
import { inspectTrustedJson } from "./trusted-files"

/** The Butler's switch, in its operator trust folder. Root-owned, so neither the agent nor its shell can turn it on. */
export const APPROVAL_RELAY_FILE = "approval-relay.json"

const DOMAIN = "ouro.approval-relay.v1\0"
/** A decision token is 32 random bytes in base64url (43 characters); anything under 32 characters isn't one. */
export const MIN_RELAY_KEY_LENGTH = 32
const DID = /^did:[a-z0-9]+:[A-Za-z0-9._:%-]{1,512}$/
const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z$/

/**
 * `HMAC-SHA256(decisionToken, "ouro.approval-relay.v1\0" || approvalId || "\0" || routeDid)`, base64url. The decision
 * token is the approval's own secret, so only the Butler can compute it, and the route DID means an outstanding token
 * stops matching once the route rotates. It refuses to compute with an empty or short key (a settled approval has no
 * token, and a short one isn't a decision token).
 * Never log it.
 */
export function approvalRelayToken(input: { decisionToken: string; approvalId: string; routeDid: string }): string {
  const parts = [input.decisionToken, input.approvalId, input.routeDid]
  if (parts.some((part) => typeof part !== "string" || part.length === 0 || part.includes("\0"))
    || input.decisionToken.length < MIN_RELAY_KEY_LENGTH) {
    emitNervesEvent({ level: "warn", component: "senses", event: "senses.approval_relay_token_refused", message: "refused to compute an approval relay token without a decision token, approval id and route DID", meta: { reason: "missing_input" } })
    throw new Error("approval relay token needs a decision token, an approval id and a route DID")
  }
  return createHmac("sha256", input.decisionToken).update(`${DOMAIN}${input.approvalId}\0${input.routeDid}`).digest("base64url")
}

/** Constant-time comparison of two relay tokens. Empty or non-string never matches. */
export function relayTokensEqual(a: string, b: string): boolean {
  if (typeof a !== "string" || typeof b !== "string" || a.length === 0) return false
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  return left.length === right.length && timingSafeEqual(left, right)
}

export type RelayedDecisionCheck = { ok: true; decision: "deny" } | { ok: false; reason: "approve_not_in_v1" | "unknown_decision" }

/**
 * v1 relays `deny` only. Approve is refused here in code, before any switch or list is read, so allowing it later means
 * changing code (and friends, whose `approvalAnswer` also takes deny only), not editing a file.
 */
export function checkRelayedDecision(decision: unknown): RelayedDecisionCheck {
  if (decision === "deny") return { ok: true, decision: "deny" }
  const reason = decision === "approve" ? "approve_not_in_v1" : "unknown_decision"
  emitNervesEvent({ level: "warn", component: "senses", event: "senses.approval_relay_decision_refused", message: "refused a relayed approval decision v1 does not relay", meta: { reason } })
  return { ok: false, reason }
}

export type ApprovalRelaySwitch =
  | { on: true; did: string; expiresAt: string; source: string }
  | { on: false; reason: "missing" | "untrusted" | "malformed" | "expired"; detail?: string }

/**
 * Reads `{ schemaVersion: 1, did, expiresAt, approveTools, source }` from the operator trust folder. Missing,
 * untrusted, malformed or expired is off. `approveTools` must be a list of names but is never returned: v1 relays deny
 * only, whatever it lists. A copy anywhere under the bundle is never read.
 */
export function readApprovalRelaySwitch(agentRoot: string, now: Date = new Date()): ApprovalRelaySwitch {
  const raw = inspectTrustedJson(operatorTrustFile(agentRoot, APPROVAL_RELAY_FILE))
  if (raw.state === "missing") return { on: false, reason: "missing" }
  if (raw.state === "untrusted") return off("untrusted", raw.reason)
  const value = raw.value
  if (!value || typeof value !== "object" || Array.isArray(value)) return off("malformed")
  const v = value as Record<string, unknown>
  const valid = Object.keys(v).sort().join(",") === "approveTools,did,expiresAt,schemaVersion,source"
    && v.schemaVersion === 1
    && typeof v.did === "string" && DID.test(v.did)
    && typeof v.expiresAt === "string" && ISO.test(v.expiresAt) && Number.isFinite(Date.parse(v.expiresAt))
    && Array.isArray(v.approveTools) && v.approveTools.every((tool) => typeof tool === "string")
    && typeof v.source === "string" && v.source.trim().length > 0
  if (!valid) return off("malformed")
  if (now.getTime() >= Date.parse(v.expiresAt as string)) return off("expired")
  return { on: true, did: v.did as string, expiresAt: v.expiresAt as string, source: v.source as string }
}

function off(reason: "untrusted" | "malformed" | "expired", detail?: string): ApprovalRelaySwitch {
  emitNervesEvent({ level: "warn", component: "senses", event: "senses.approval_relay_switch_off", message: "the approval relay switch is off because its trust-folder file can't be used", meta: { reason, ...(detail ? { detail } : {}) } })
  return { on: false, reason, ...(detail ? { detail } : {}) }
}
