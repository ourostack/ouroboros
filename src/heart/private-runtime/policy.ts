import * as crypto from "node:crypto"
import { getAgentBundlesRoot } from "../identity"
import { readAgentConfigForAgent } from "../auth/auth-flow"
import { emitNervesEvent } from "../../nerves/runtime"
import type { ProviderLane } from "../provider-lanes"
import { readCachedProviderCredentialRecord } from "../provider-credentials"
import { recordPrivateTurnDecision } from "./ledger"
import type {
  PrivateTurnDecision,
  PrivateTurnOriginRef,
  PrivateTurnPolicyDeps,
  PrivateTurnPolicyEvaluation,
  PrivateTurnProviderLaneMetadata,
  PrivateTurnRequest,
} from "./types"

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`
  }
  return JSON.stringify(value)
}

function normalizeOriginRefs(refs: PrivateTurnOriginRef[]): PrivateTurnOriginRef[] {
  return [...refs].sort((a, b) => stableJson(a).localeCompare(stableJson(b)))
}

function providerLaneSpendIdentity(providerLane: PrivateTurnProviderLaneMetadata): Record<string, unknown> {
  return {
    lane: providerLane.lane,
    provider: providerLane.provider,
    model: providerLane.model,
    source: providerLane.source,
    ...(providerLane.credentialRevision ? { credentialRevision: providerLane.credentialRevision } : {}),
  }
}

function spendIdentity(
  request: PrivateTurnRequest,
  options: { includeIdempotencyKey: boolean; providerLane?: PrivateTurnProviderLaneMetadata },
): Record<string, unknown> {
  return {
    agent: request.agent,
    origin: request.origin,
    reason: request.reason,
    providerLane: options.providerLane ? providerLaneSpendIdentity(options.providerLane) : request.providerLane,
    triggerSource: request.triggerSource,
    ...(options.includeIdempotencyKey ? { idempotencyKey: request.idempotencyKey ?? "" } : {}),
    budgetClass: request.budgetClass,
    originRefs: normalizeOriginRefs(request.originRefs ?? []),
  }
}

function sha256Prefix(prefix: string, value: unknown): string {
  const hash = crypto.createHash("sha256").update(stableJson(value)).digest("hex")
  return `${prefix}_${hash}`
}

function nowIso(deps: PrivateTurnPolicyDeps): string {
  const raw = deps.now?.() ?? new Date()
  return raw instanceof Date ? raw.toISOString() : raw
}

function emitPolicyEvaluated(
  deps: PrivateTurnPolicyDeps,
  input: { request: PrivateTurnRequest; result: "allow" | "deny"; requestFingerprint: string; idempotencyKey: string },
): void {
  const payload = {
    level: input.result === "allow" ? "info" : "debug",
    component: "private-runtime",
    event: "private_runtime.policy_evaluated",
    message: "private-runtime policy evaluated",
    meta: {
      agent: input.request.agent,
      origin: input.request.origin,
      result: input.result,
      idempotencyKey: input.idempotencyKey,
      requestFingerprint: input.requestFingerprint,
    },
  } as const
  if (deps.emitNervesEvent) {
    deps.emitNervesEvent(payload)
    return
  }
  emitNervesEvent({
    level: input.result === "allow" ? "info" : "debug",
    component: "private-runtime",
    event: "private_runtime.policy_evaluated",
    message: "private-runtime policy evaluated",
    meta: payload.meta,
  })
}

function hasOriginRef(refs: PrivateTurnOriginRef[], kind: string, id: string): boolean {
  return refs.some((ref) => ref.kind === kind && ref.id === id)
}

function hasNonEmptyOriginRef(refs: PrivateTurnOriginRef[], kind: string): boolean {
  return refs.some((ref) => ref.kind === kind && typeof ref.id === "string" && ref.id.trim().length > 0)
}

async function defaultResolveProviderLane(
  agent: string,
  lane: ProviderLane,
  deps: PrivateTurnPolicyDeps,
): Promise<PrivateTurnProviderLaneMetadata> {
  const bundlesRoot = deps.bundlesRoot ?? getAgentBundlesRoot()
  const { config } = readAgentConfigForAgent(agent, bundlesRoot)
  const facing = lane === "inner" ? config.agentFacing : config.humanFacing
  const credential = readCachedProviderCredentialRecord(agent, facing.provider)
  if (!credential.ok) {
    throw new Error(`${lane} provider ${facing.provider} (${facing.model}) credential revision unavailable: ${credential.error}`)
  }
  return {
    lane,
    provider: facing.provider,
    model: facing.model,
    source: "agent.json",
    credentialRevision: credential.record.revision,
  }
}

async function resolveProviderLaneMetadata(
  request: PrivateTurnRequest,
  deps: PrivateTurnPolicyDeps,
): Promise<PrivateTurnProviderLaneMetadata> {
  return deps.resolveProviderLane
    ? await deps.resolveProviderLane(request.agent, request.providerLane)
    : defaultResolveProviderLane(request.agent, request.providerLane, deps)
}

async function evaluatePolicy(
  request: PrivateTurnRequest,
  context: {
    requestFingerprint: string
    idempotencyKey: string
    providerLane: PrivateTurnProviderLaneMetadata
  },
  deps: PrivateTurnPolicyDeps,
): Promise<PrivateTurnPolicyEvaluation> {
  if (deps.evaluatePolicy) return deps.evaluatePolicy(request, context)
  const originRefs = request.originRefs ?? []
  if (
    request.triggerSource === "external-event"
    && hasNonEmptyOriginRef(originRefs, "external-event")
    && hasOriginRef(originRefs, "daemon-command", "external.event.submit")
  ) {
    return {
      result: "allow",
      reason: "verified daemon external event",
    }
  }
  if (
    request.triggerSource === "operator-cli"
    && hasOriginRef(originRefs, "cli-command", "ouro msg")
    && hasNonEmptyOriginRef(originRefs, "daemon-receipt")
  ) {
    return {
      result: "allow",
      reason: "verified operator CLI message",
    }
  }
  if (
    (request.triggerSource === "await-poke" || request.triggerSource === "await-scheduler" || request.triggerSource === "await-expiry")
    && hasNonEmptyOriginRef(originRefs, "await")
    && (
      hasOriginRef(originRefs, "daemon-command", "await.poke")
      || hasOriginRef(originRefs, "scheduler", "await-scheduler")
      || hasOriginRef(originRefs, "await-alert", "expired")
    )
  ) {
    return {
      result: "allow",
      reason: "verified daemon await check",
    }
  }
  return {
    result: "deny",
    reason: "private runtime policy denies by default",
    deniedReason: "default policy deny",
  }
}

function emptyReceiptId(): string {
  return ""
}

export function createPrivateTurnRequestFingerprint(
  request: PrivateTurnRequest,
  providerLane?: PrivateTurnProviderLaneMetadata,
): string {
  return sha256Prefix("ptr", spendIdentity(request, { includeIdempotencyKey: true, providerLane }))
}

export function createPrivateTurnIdempotencyKey(request: Omit<PrivateTurnRequest, "idempotencyKey"> | PrivateTurnRequest): string {
  return sha256Prefix("ptk", spendIdentity(request as PrivateTurnRequest, { includeIdempotencyKey: false }))
}

export async function requestPrivateTurnDecision(
  request: PrivateTurnRequest,
  deps: PrivateTurnPolicyDeps = {},
): Promise<PrivateTurnDecision> {
  const idempotencyKey = request.idempotencyKey ?? createPrivateTurnIdempotencyKey(request)
  const normalizedRequest: PrivateTurnRequest = { ...request, idempotencyKey }
  let providerLane: PrivateTurnProviderLaneMetadata
  let requestFingerprint: string
  let evaluation: PrivateTurnPolicyEvaluation | undefined
  try {
    providerLane = await resolveProviderLaneMetadata(normalizedRequest, deps)
  } catch (error) {
    providerLane = {
      lane: normalizedRequest.providerLane,
      provider: "unconfigured",
      model: "-",
      source: "agent.json",
    }
    evaluation = {
      result: "deny",
      reason: error instanceof Error ? error.message : String(error),
      deniedReason: "provider lane resolution failed",
      denialCode: "provider_lane_unavailable",
    }
  }
  requestFingerprint = createPrivateTurnRequestFingerprint(normalizedRequest, providerLane)
  if (evaluation === undefined) {
    try {
      evaluation = await evaluatePolicy(normalizedRequest, {
        requestFingerprint,
        idempotencyKey,
        providerLane,
      }, deps)
    } catch (error) {
      evaluation = {
        result: "deny",
        reason: error instanceof Error ? error.message : String(error),
        deniedReason: "private runtime policy evaluation failed",
      }
    }
  }
  const result = evaluation.result
  emitPolicyEvaluated(deps, { request: normalizedRequest, result, requestFingerprint, idempotencyKey })
  const reason = evaluation.reason ?? normalizedRequest.reason

  const decision: PrivateTurnDecision = {
    schemaVersion: 1,
    receiptId: emptyReceiptId(),
    agent: normalizedRequest.agent,
    origin: normalizedRequest.origin,
    requestReason: normalizedRequest.reason,
    reason,
    providerLane,
    triggerSource: normalizedRequest.triggerSource,
    idempotencyKey,
    budgetClass: normalizedRequest.budgetClass,
    originRefs: normalizeOriginRefs(normalizedRequest.originRefs ?? []),
    requestFingerprint,
    result,
    executable: result === "allow",
    decidedAt: nowIso(deps),
    ledgerLocator: { path: deps.ledgerPath ?? "" },
    ...(result === "deny" ? {
      deniedReason: evaluation.deniedReason ?? reason,
      ...(evaluation.denialCode ? { denialCode: evaluation.denialCode } : {}),
    } : {}),
  }

  return recordPrivateTurnDecision(decision, deps)
}
