import { createHash } from "node:crypto"
import { authorityArtifactDigest, canonicalAuthorityJson, verifyAuthorityPayload, type SignedAuthorityPayload } from "../heart/daemon/sanctuary-authority-codec"
import { validateHostProposalRequest, type FileSanctuaryHostAuthority, type HostProposalRequestV1 } from "../heart/daemon/sanctuary-host-authority"
import type { SanctuaryTelegramAuthorityProtocolClient, SanctuaryTelegramAuthorityVerification } from "./telegram-authority-transport"
import type { TelegramAuthorityTransportMetadata, TelegramUpdate } from "./telegram-client"

type Artifact = SignedAuthorityPayload<Record<string, unknown>>
export type RootHostCorrelation = Parameters<FileSanctuaryHostAuthority["issuePermit"]>[0]
export interface RootHostRegistration {
  registration: Artifact
  registrationId: string
  telegramMessageId: number
  expiresAt: string
}
export interface RootHostStatus {
  state: "prepared" | "orphaned" | "committed" | "approved" | "denied" | "expired" | "permitted" | "executed"
  execution: "running" | "reconciliation_required" | "terminal"
  statusDigest: string
  decision?: Artifact
  permit?: Artifact
  receipt?: Artifact
  executionError?: string
  maintenanceError?: string
}
export interface RootHostApprovalPort {
  readonly pins: Readonly<SanctuaryTelegramAuthorityVerification>
  refresh(): Promise<boolean>
  isHealthy(): boolean
  acceptsObservation(metadata: TelegramAuthorityTransportMetadata): boolean
  register(proposal: HostProposalRequestV1): Promise<RootHostRegistration>
  status(registration: RootHostRegistration): Promise<RootHostStatus>
  execute(correlation: RootHostCorrelation): Promise<void>
  callbackForUpdate(update: TelegramUpdate): { handled: boolean; registrationId?: string }
}

const IDENTITY_KEYS = ["targetHost", "botId", "ownerUserId", "ownerChatId", "publicKeyDigest"]
const REGISTRATION_KEYS = [
  ...IDENTITY_KEYS, "targetResource", "registrationId", "proposalDigest", "ownerObservationDigest", "ownerUpdateId", "ownerMessageId",
  "command", "workingDirectoryProfile", "environmentProfile", "timeoutMs", "verification", "prompt", "promptDigest", "displayedProposalDigest",
  "marker", "telegramMessageId", "approveHandleDigest", "denyHandleDigest", "registeredAt", "expiresAt", "nonce",
]
const DECISION_KEYS = ["targetHost", "publicKeyDigest", "registrationId", "registrationDigest", "decision", "callbackQueryId", "callbackObservationDigest", "decidedAt", "nonce"]
const CORRELATION_KEYS = ["registrationId", "residentFriendId", "relationshipProfileId", "relationshipProfileVersion", "requestId", "sessionKey", "sessionEventId", "residentApprovalId", "stewardPolicy"]
const PERMIT_KEYS = [
  "targetHost", "publicKeyDigest", "permitId", "registrationId", "registrationDigest", "ownerUserId", "ownerChatId", "ownerObservationDigest", "callbackObservationDigest",
  ...CORRELATION_KEYS.slice(1), "effectClass", "executionProfile", "targetResource", "command", "scriptDigest", "workingDirectoryProfile",
  "environmentProfile", "environmentProfileDigest", "timeoutMs", "verification", "issuedAt", "expiresAt", "nonce", "permitDigest",
]
const RECEIPT_KEYS = [
  "targetHost", "publicKeyDigest", "permitId", "permitDigest", "registrationId", "state", "startedAt", "completedAt", "exitCode", "signal", "timedOut", "cancelled",
  "outputOverflow", "stdoutDigest", "stderrDigest", "stdoutBytes", "stderrBytes", "stdoutExcerpt", "stderrExcerpt", "cleanup", "containment", "verificationBefore", "verificationAfter", "errorCategory",
]
const DIGEST = /^sha256:[a-f0-9]{64}$/u
const NONCE = /^[A-Za-z0-9_-]{43}$/u
const REGISTRATION_ID = /^hostreg-[A-Za-z0-9_-]{43}$/u
const PERMIT_ID = /^permit-[A-Za-z0-9_-]{43}$/u
const HEALTH_TTL = 30_000
const OBSERVATION_TTL = 300_000

function requireValid(condition: unknown): asserts condition {
  if (!condition) throw new Error("Sanctuary root host authority response or request is invalid")
}
function object(value: unknown): asserts value is Record<string, unknown> {
  requireValid(typeof value === "object" && value !== null && !Array.isArray(value))
}
function shape(value: unknown, required: readonly string[], optional: readonly string[] = []): asserts value is Record<string, unknown> {
  object(value)
  requireValid(required.every((key) => Object.hasOwn(value, key)))
  requireValid(Object.keys(value).every((key) => required.includes(key) || optional.includes(key)))
}
function text(value: unknown, maximum: number): value is string {
  return typeof value === "string" && /^[\x20-\x7e]+$/u.test(value) && value.length <= maximum
}
function matches(value: unknown, pattern: RegExp): value is string {
  return typeof value === "string" && pattern.test(value)
}
function integer(value: unknown, minimum = 0): value is number {
  return Number.isSafeInteger(value) && (value as number) >= minimum
}
function time(value: unknown): number {
  requireValid(typeof value === "string")
  const instant = Date.parse(value)
  requireValid(Number.isFinite(instant))
  requireValid(new Date(instant).toISOString() === value)
  return instant
}
function fresh(value: number, ttl: number): boolean {
  const age = Date.now() - value
  return age >= 0 && age < ttl
}
function same(left: unknown, right: unknown): void {
  requireValid(canonicalAuthorityJson(left) === canonicalAuthorityJson(right))
}
function digest(text: string): string {
  return `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`
}
function artifactDigest(artifact: Artifact): string {
  return authorityArtifactDigest(artifact.domain, artifact.payload)
}
function freeze<T>(value: T): T {
  if (typeof value === "object" && value !== null) {
    for (const nested of Object.values(value)) freeze(nested)
    Object.freeze(value)
  }
  return value
}
function correlation(value: unknown): asserts value is RootHostCorrelation {
  shape(value, CORRELATION_KEYS)
  requireValid(matches(value.registrationId, REGISTRATION_ID))
  for (const [key, maximum] of [["residentFriendId", 512], ["relationshipProfileId", 256], ["requestId", 512], ["sessionKey", 1_024], ["sessionEventId", 512], ["residentApprovalId", 512]] as const) {
    requireValid(text(value[key], maximum))
  }
  requireValid(integer(value.relationshipProfileVersion, 1))
  if (value.stewardPolicy !== null) {
    shape(value.stewardPolicy, ["key", "version", "digest"])
    requireValid(text(value.stewardPolicy.key, 256))
    requireValid(integer(value.stewardPolicy.version, 1))
    requireValid(matches(value.stewardPolicy.digest, DIGEST))
  }
}

// Only the transport supplies these closures; caller-created metadata never enters their registry.
export function createRootHostApprovalPort(
  client: SanctuaryTelegramAuthorityProtocolClient,
  verification: SanctuaryTelegramAuthorityVerification,
  observations: {
    current(): TelegramAuthorityTransportMetadata | null
    lookup(update: TelegramUpdate): { metadata: TelegramAuthorityTransportMetadata; hostCallback: unknown } | null
    stopped(): boolean
  },
): RootHostApprovalPort {
  const pins = Object.freeze({ ...verification })
  let healthyAt = Number.NEGATIVE_INFINITY
  function verify(value: unknown, domain: string, keys: readonly string[]): Artifact {
    const payload = verifyAuthorityPayload<Record<string, unknown>>({
      artifact: value, expectedDomain: `ouro.sanctuary.host-${domain}.v1`, expectedKeyId: pins.expectedKeyId, publicKey: pins.publicKey,
    })
    shape(payload, keys)
    requireValid(payload.targetHost === pins.expectedTargetHost)
    requireValid(payload.publicKeyDigest === pins.expectedPublicKeyDigest)
    return value as Artifact
  }
  function identity(payload: Record<string, unknown>): void {
    requireValid(payload.botId === pins.expectedBotId)
    requireValid(payload.ownerUserId === pins.expectedOwnerUserId)
    requireValid(payload.ownerChatId === pins.expectedOwnerChatId)
  }
  function registration(value: unknown): RootHostRegistration {
    shape(value, ["registration", "registrationId", "telegramMessageId", "expiresAt"])
    const signed = verify(value.registration, "registration", REGISTRATION_KEYS)
    const p = signed.payload
    identity(p)
    requireValid(matches(p.registrationId, REGISTRATION_ID))
    requireValid(integer(p.telegramMessageId, 1))
    requireValid(matches(p.nonce, NONCE))
    for (const field of ["proposalDigest", "ownerObservationDigest", "promptDigest", "approveHandleDigest", "denyHandleDigest"]) requireValid(matches(p[field], DIGEST))
    same(p.displayedProposalDigest, p.proposalDigest)
    same(p.marker, "<b>OURO ROOT HOST APPROVAL</b>")
    requireValid(typeof p.prompt === "string" && p.prompt.length <= 4_096)
    same(digest(p.prompt), p.promptDigest)
    requireValid(p.prompt.startsWith(String(p.marker)))
    requireValid(p.prompt.includes(String(p.proposalDigest)))
    requireValid(time(p.expiresAt) >= time(p.registeredAt))
    requireValid(time(p.expiresAt) <= time(p.registeredAt) + OBSERVATION_TTL)
    const proposal = {
      targetHost: p.targetHost, targetResource: p.targetResource, command: p.command, workingDirectoryProfile: p.workingDirectoryProfile,
      environmentProfile: p.environmentProfile, timeoutMs: p.timeoutMs, verification: p.verification,
      ownerObservation: { digest: p.ownerObservationDigest, updateId: p.ownerUpdateId, userId: p.ownerUserId, chatId: p.ownerChatId, messageId: p.ownerMessageId },
    }
    validateHostProposalRequest(proposal, pins.expectedTargetHost)
    same(authorityArtifactDigest("ouro.sanctuary.host-proposal.v1", { ...proposal, expiresAt: p.expiresAt }), p.proposalDigest)
    same({ registrationId: p.registrationId, telegramMessageId: p.telegramMessageId, expiresAt: p.expiresAt },
      { registrationId: value.registrationId, telegramMessageId: value.telegramMessageId, expiresAt: value.expiresAt })
    return freeze(value as unknown as RootHostRegistration)
  }
  function verifyDecision(value: unknown): Artifact {
    const result = verify(value, "decision", DECISION_KEYS)
    const p = result.payload
    requireValid(matches(p.registrationId, REGISTRATION_ID))
    requireValid(matches(p.registrationDigest, DIGEST))
    requireValid(p.decision === "approve" || p.decision === "deny")
    requireValid(text(p.callbackQueryId, 256))
    requireValid(matches(p.callbackObservationDigest, DIGEST))
    requireValid(matches(p.nonce, NONCE))
    time(p.decidedAt)
    return result
  }
  function decision(value: unknown, reg: RootHostRegistration): Artifact {
    const result = verifyDecision(value)
    const p = result.payload
    same(p.registrationId, reg.registrationId)
    same(p.registrationDigest, artifactDigest(reg.registration))
    requireValid(time(p.decidedAt) >= time(reg.registration.payload.registeredAt))
    requireValid(time(p.decidedAt) <= time(reg.expiresAt))
    return result
  }
  function permit(value: unknown, reg: RootHostRegistration, approved: Artifact): Artifact {
    const result = verify(value, "attempt", PERMIT_KEYS)
    const p = result.payload
    requireValid(matches(p.permitDigest, DIGEST))
    correlation(Object.fromEntries(CORRELATION_KEYS.map((key) => [key, p[key]])))
    const r = reg.registration.payload
    for (const key of ["registrationId", "targetResource", "ownerUserId", "ownerChatId", "ownerObservationDigest", "command", "workingDirectoryProfile", "environmentProfile", "timeoutMs", "verification"]) same(p[key], r[key])
    same(p.registrationDigest, artifactDigest(reg.registration))
    same(approved.payload.decision, "approve")
    same(p.callbackObservationDigest, approved.payload.callbackObservationDigest)
    same(p.effectClass, "owner_approved_arbitrary_host")
    same(p.executionProfile, "host.owner_approved.v1")
    requireValid(matches(p.permitId, PERMIT_ID))
    requireValid(matches(p.nonce, /^[a-f0-9]{64}$/u))
    const command = r.command as Record<string, unknown>
    same(p.scriptDigest, command.kind === "script" ? digest(command.script as string) : null)
    same(p.environmentProfileDigest, digest(r.environmentProfile as string))
    requireValid(time(p.issuedAt) >= time(approved.payload.decidedAt))
    requireValid(time(p.issuedAt) <= time(approved.payload.decidedAt) + 120_000)
    requireValid(time(p.expiresAt) > time(p.issuedAt))
    requireValid(time(p.expiresAt) <= time(p.issuedAt) + 120_000)
    return result
  }
  function receipt(value: unknown, reg: RootHostRegistration, permitted: Artifact): Artifact {
    const result = verify(value, "receipt", RECEIPT_KEYS)
    const p = result.payload
    same(p.registrationId, reg.registrationId)
    same(p.permitId, permitted.payload.permitId)
    same(p.permitDigest, permitted.payload.permitDigest)
    requireValid(typeof p.state === "string" && ["verified", "failed", "ambiguous"].includes(p.state))
    requireValid(time(p.startedAt) >= time(permitted.payload.issuedAt))
    requireValid(time(p.completedAt) >= time(p.startedAt))
    requireValid(p.exitCode === null || integer(p.exitCode))
    requireValid(p.signal === null || text(p.signal, 128))
    for (const key of ["timedOut", "cancelled", "outputOverflow"]) requireValid(typeof p[key] === "boolean")
    for (const stream of ["stdout", "stderr"]) {
      requireValid(matches(p[`${stream}Digest`], DIGEST))
      requireValid(integer(p[`${stream}Bytes`]))
      const excerpt = p[`${stream}Excerpt`]
      requireValid(typeof excerpt === "string" && excerpt.length <= 4_096)
    }
    requireValid(typeof p.cleanup === "string" && ["cgroup_empty", "cleanup_unproven"].includes(p.cleanup))
    requireValid(typeof p.containment === "string" && ["approved_root_may_escape", "unprovable_after_approved_root_migration"].includes(p.containment))
    requireValid(p.errorCategory === null || text(p.errorCategory, 256))
    if (p.verificationBefore !== null) {
      shape(p.verificationBefore, ["digest"])
      requireValid(matches(p.verificationBefore.digest, DIGEST))
    }
    if (p.verificationAfter !== null) {
      shape(p.verificationAfter, ["matches", "digest"])
      requireValid(p.verificationAfter.matches === null || typeof p.verificationAfter.matches === "boolean")
      requireValid(matches(p.verificationAfter.digest, DIGEST))
    }
    return result
  }
  const port: RootHostApprovalPort = {
    pins,
    async refresh() {
      healthyAt = Number.NEGATIVE_INFINITY
      try {
        requireValid(!observations.stopped())
        const response = await client.request("host.status", { registrationId: null })
        shape(response, ["health"])
        const p = verify(response.health, "health", [...IDENTITY_KEYS, "observedAt", "healthy"]).payload
        identity(p)
        requireValid(p.healthy === true)
        const observedAt = time(p.observedAt)
        requireValid(fresh(observedAt, HEALTH_TTL))
        healthyAt = observedAt
        return port.isHealthy()
      } catch {
        return false
      }
    },
    isHealthy() {
      return !observations.stopped() && fresh(healthyAt, HEALTH_TTL)
    },
    acceptsObservation(metadata) {
      return port.isHealthy()
        && metadata === observations.current()
        && metadata.ownerEligible
        && metadata.updateClass === "message"
        && fresh(time(metadata.observedAt), OBSERVATION_TTL)
    },
    async register(proposal) {
      const metadata = observations.current()
      requireValid(metadata && port.acceptsObservation(metadata))
      validateHostProposalRequest(proposal, pins.expectedTargetHost)
      same(proposal.ownerObservation, { digest: metadata.observationDigest, updateId: metadata.updateId, userId: metadata.userId, chatId: metadata.chatId, messageId: metadata.messageId })
      const result = registration(await client.request("host.approval", { proposal }))
      same(result.registration.payload.proposalDigest, authorityArtifactDigest("ouro.sanctuary.host-proposal.v1", { ...proposal, expiresAt: result.expiresAt }))
      requireValid(fresh(time(result.registration.payload.registeredAt), OBSERVATION_TTL))
      requireValid(Date.now() < time(result.expiresAt))
      return result
    },
    async status(value) {
      const reg = registration(value)
      requireValid(!observations.stopped())
      const response = await client.request("host.status", { registrationId: reg.registrationId })
      object(response)
      const envelope = verify(response.authority, "status", [...IDENTITY_KEYS, "observedAt", "status"])
      identity(envelope.payload)
      requireValid(fresh(time(envelope.payload.observedAt), HEALTH_TTL))
      const status = envelope.payload.status
      shape(status, ["registrationId", "state", "proposalDigest", "expiresAt", "telegramMessageId", "cardPending", "execution"], ["decision", "permit", "receipt", "executionError", "maintenanceError"])
      const { authority: _authority, ...legacy } = response
      same(status, legacy)
      same(status.registrationId, reg.registrationId)
      same(status.proposalDigest, reg.registration.payload.proposalDigest)
      same(status.expiresAt, reg.expiresAt)
      same(status.telegramMessageId, reg.telegramMessageId)
      requireValid(typeof status.cardPending === "boolean")
      requireValid(typeof status.state === "string" && ["committed", "approved", "denied", "expired", "permitted", "executed"].includes(status.state))
      requireValid(typeof status.execution === "string" && ["running", "reconciliation_required", "terminal"].includes(status.execution))
      for (const key of ["executionError", "maintenanceError"]) if (key in status) requireValid(text(status[key], 512))
      let decided: Artifact | undefined
      let permitted: Artifact | undefined
      let received: Artifact | undefined
      if ("decision" in status) decided = decision(status.decision, reg)
      if (["approved", "denied", "permitted", "executed"].includes(String(status.state))) {
        requireValid(decided)
        same(decided.payload.decision, status.state === "denied" ? "deny" : "approve")
      }
      if (status.state === "committed") requireValid(!decided)
      if ("permit" in status) {
        requireValid(decided)
        requireValid(["permitted", "executed"].includes(String(status.state)))
        permitted = permit(status.permit, reg, decided)
      }
      if (["permitted", "executed"].includes(String(status.state))) requireValid(permitted)
      if ("receipt" in status) {
        requireValid(permitted)
        same(status.state, "executed")
        received = receipt(status.receipt, reg, permitted)
      }
      if (status.state === "executed") requireValid(received)
      if (status.execution !== "terminal") requireValid(["permitted", "executed"].includes(String(status.state)))
      return freeze({
        ...status,
        statusDigest: artifactDigest(envelope),
      } as unknown as RootHostStatus)
    },
    async execute(value) {
      requireValid(port.isHealthy())
      correlation(value)
      const response = await client.request("host.execute", { correlation: value })
      shape(response, ["registrationId", "permitId", "state"])
      same(response.registrationId, value.registrationId)
      requireValid(matches(response.permitId, PERMIT_ID))
      same(response.state, "executing")
    },
    callbackForUpdate(update) {
      const observation = observations.lookup(update)
      if (!observation || observation.hostCallback === undefined) return { handled: false }
      const p = verify(observation.hostCallback, "callback", [...IDENTITY_KEYS, "handled", "registrationId", "callbackQueryId", "observationDigest", "decision"]).payload
      identity(p)
      same(p.handled, true)
      same(observation.metadata.updateClass, "callback")
      same(p.observationDigest, observation.metadata.observationDigest)
      same(p.callbackQueryId, observation.metadata.callbackQueryId)
      requireValid(matches(p.registrationId, REGISTRATION_ID))
      if (p.decision !== null) {
        const d = verifyDecision(p.decision).payload
        same(d.registrationId, p.registrationId)
        same(d.callbackQueryId, p.callbackQueryId)
        same(d.callbackObservationDigest, p.observationDigest)
        requireValid(observation.metadata.ownerEligible)
      }
      return { handled: true, registrationId: p.registrationId as string }
    },
  }
  return Object.freeze(port)
}
