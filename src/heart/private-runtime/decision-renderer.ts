import { emitNervesEvent } from "../../nerves/runtime"
import type { PrivateTurnDecision, PrivateTurnLedgerLocator, PrivateTurnOriginRef, PrivateTurnProviderLaneMetadata } from "./types"

export interface PrivateDecisionReadRecord {
  schemaVersion: 1
  receiptId: string
  agent: string
  origin: string
  reason: string
  providerLane: PrivateTurnProviderLaneMetadata
  triggerSource: string
  idempotencyKey: string
  budgetClass: string
  originRefs: PrivateTurnOriginRef[]
  requestFingerprint: string
  result: PrivateTurnDecision["result"]
  executable: boolean
  decidedAt: string
  ledgerLocator: PrivateTurnLedgerLocator
  deniedReason?: string
  duplicateOf?: string
  error?: string
}

export interface PrivateDecisionReadPayload {
  agent: string
  ledgerPath?: string
  decisions: PrivateDecisionReadRecord[]
  guidance?: string
}

function stringField(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback
}

function booleanField(value: unknown): boolean {
  return typeof value === "boolean" ? value : false
}

function originRefsField(value: unknown): PrivateTurnOriginRef[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((entry): PrivateTurnOriginRef[] => {
    if (!entry
      || typeof entry !== "object"
      || Array.isArray(entry)
      || typeof (entry as Record<string, unknown>).kind !== "string"
      || typeof (entry as Record<string, unknown>).id !== "string"
    ) {
      return []
    }
    const row = entry as Record<string, unknown>
    return [{ kind: row.kind as string, id: row.id as string }]
  })
}

function providerLaneField(value: unknown): PrivateTurnProviderLaneMetadata {
  const row = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
  return {
    lane: stringField(row.lane, "inner") as PrivateTurnProviderLaneMetadata["lane"],
    provider: stringField(row.provider, "unknown"),
    model: stringField(row.model, "unknown"),
    source: "agent.json",
    ...(typeof row.credentialRevision === "string" ? { credentialRevision: row.credentialRevision } : {}),
  }
}

function ledgerLocatorField(value: unknown, ledgerPath?: string): PrivateTurnLedgerLocator {
  const row = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
  return {
    path: stringField(row.path, ledgerPath ?? ""),
    ...(typeof row.line === "number" ? { line: row.line } : {}),
  }
}

function resultField(value: unknown): PrivateTurnDecision["result"] {
  return value === "allow" ? "allow" : "deny"
}

export function sanitizePrivateDecision(row: unknown, ledgerPath?: string): PrivateDecisionReadRecord {
  const record = row && typeof row === "object" && !Array.isArray(row)
    ? row as Record<string, unknown>
    : {}
  const deniedReason = stringField(record.deniedReason)
  const duplicateOf = stringField(record.duplicateOf)
  const error = stringField(record.error)
  return {
    schemaVersion: 1,
    receiptId: stringField(record.receiptId),
    agent: stringField(record.agent),
    origin: stringField(record.origin),
    reason: stringField(record.reason),
    providerLane: providerLaneField(record.providerLane),
    triggerSource: stringField(record.triggerSource),
    idempotencyKey: stringField(record.idempotencyKey),
    budgetClass: stringField(record.budgetClass),
    originRefs: originRefsField(record.originRefs),
    requestFingerprint: stringField(record.requestFingerprint),
    result: resultField(record.result),
    executable: booleanField(record.executable),
    decidedAt: stringField(record.decidedAt),
    ledgerLocator: ledgerLocatorField(record.ledgerLocator, ledgerPath),
    ...(deniedReason ? { deniedReason } : {}),
    ...(duplicateOf ? { duplicateOf } : {}),
    ...(error ? { error } : {}),
  }
}

function decisionSortKey(decision: PrivateDecisionReadRecord): string {
  return decision.decidedAt || `${decision.ledgerLocator.line ?? 0}`.padStart(12, "0")
}

function sortedRecentDecisions(decisions: PrivateDecisionReadRecord[], limit: number): PrivateDecisionReadRecord[] {
  return [...decisions]
    .sort((a, b) => decisionSortKey(b).localeCompare(decisionSortKey(a)))
    .slice(0, limit)
}

export function buildPrivateDecisionReadPayload(input: {
  agent: string
  ledgerPath?: string
  decisions: unknown[]
  limit?: number
  guidance?: string
}): PrivateDecisionReadPayload {
  const limit = Number.isInteger(input.limit) && input.limit && input.limit > 0 ? input.limit : input.decisions.length
  const decisions = sortedRecentDecisions(
    input.decisions.map((row) => sanitizePrivateDecision(row, input.ledgerPath)),
    limit,
  )
  emitNervesEvent({
    component: "private-runtime",
    event: "private_runtime.decision_read_payload_built",
    message: "private-runtime decision read payload built",
    meta: { agent: input.agent, count: decisions.length, hasLedgerPath: !!input.ledgerPath },
  })
  return {
    agent: input.agent,
    ...(input.ledgerPath ? { ledgerPath: input.ledgerPath } : {}),
    decisions,
    ...(input.guidance ? { guidance: input.guidance } : {}),
  }
}

export function privateDecisionReadPayloadFromDaemonData(data: unknown, fallbackAgent: string): PrivateDecisionReadPayload {
  const record = data && typeof data === "object" && !Array.isArray(data)
    ? data as Record<string, unknown>
    : {}
  const ledgerPath = stringField(record.ledgerPath)
  const guidance = stringField(record.guidance)
  return buildPrivateDecisionReadPayload({
    agent: stringField(record.agent, fallbackAgent),
    decisions: Array.isArray(record.decisions) ? record.decisions : [],
    ...(ledgerPath ? { ledgerPath } : {}),
    ...(guidance ? { guidance } : {}),
  })
}

export function privateDecisionCountSummary(count: number): string {
  return `${count} private-runtime ${count === 1 ? "decision" : "decisions"}`
}

function decisionReason(decision: PrivateDecisionReadRecord): string {
  return decision.deniedReason || decision.reason || "(no reason recorded)"
}

function formatLocator(locator: PrivateTurnLedgerLocator): string {
  const line = locator.line === undefined ? "" : `:${locator.line}`
  return `${locator.path}${line}`
}

export function formatPrivateDecisionReadText(payload: PrivateDecisionReadPayload): string {
  const lines = [`private decisions: ${payload.agent}`]
  if (payload.ledgerPath) lines.push(`ledger: ${payload.ledgerPath}`)
  if (payload.guidance) lines.push(`guidance: ${payload.guidance}`)
  if (payload.decisions.length === 0) {
    lines.push("no private-runtime decisions found")
    return lines.join("\n")
  }
  for (const decision of payload.decisions) {
    lines.push([
      `- ${decision.decidedAt || "undated"}`,
      decision.result,
      decision.origin,
      `key=${decision.idempotencyKey}`,
      `lane=${decision.providerLane.lane}`,
      `receipt=${decision.receiptId}`,
      `reason=${decisionReason(decision)}`,
      `locator=${formatLocator(decision.ledgerLocator)}`,
    ].join(" "))
  }
  return lines.join("\n")
}

export function formatPrivateDecisionReadJson(payload: PrivateDecisionReadPayload): string {
  return JSON.stringify(payload, null, 2)
}
