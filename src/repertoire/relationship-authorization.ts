import * as fs from "node:fs"
import * as path from "node:path"
import { createHash } from "node:crypto"
import type { FriendRecord, TrustLevel } from "@ouro.bot/friends"
import { emitNervesEvent } from "../nerves/runtime"

export interface RelationshipCapabilityProfile {
  id: string
  version: number
  contextScopes: string[]
  toolNames: string[]
  effectScopes: string[]
}

export interface RelationshipCapabilityRegistry {
  version: 2
  profiles: Record<string, RelationshipCapabilityProfile>
}

export interface RelationshipAuthorizationSubject {
  friendId: string
  trustLevel: TrustLevel
  admissionState: "unverified" | "active" | "revoked"
  initiativePolicy: "none" | "reactive_only" | "request_follow_up_only" | "proactive"
  capabilityProfileId?: string
}

export interface RelationshipAuthorizationEvaluator {
  readonly subject: RelationshipAuthorizationSubject
  readonly advertisedToolNames: readonly string[]
  readonly actor?: Readonly<{ friendId: string; trustLevel: TrustLevel; sessionEventId: string }>
  authorizeContext(scope: string): RelationshipAuthorizationResult
  authorizeTool(name: string, _args?: Record<string, string>): RelationshipAuthorizationResult
  authorizeEffect(scope: string): RelationshipAuthorizationResult
}

export type RelationshipAuthorizationRequest =
  | { kind: "context"; scope: string }
  | { kind: "tool"; name: string; requestId?: string; returnTargetFriendId?: string }
  | { kind: "effect"; scope: string; requestId?: string; returnTargetFriendId?: string }
  | { kind: "admission_gate"; admissionId: string; botId: string; userId: string; chatId: string; effect: "fixed_ack"; idempotencyKey: string; expiresAt: string }

export type RelationshipAuthorizationResult =
  | { allowed: true; authorizationKind: "relationship"; receiptId: string; friendId: string; profileId: string; profileVersion: number; requestId: string | null }
  | { allowed: true; authorizationKind: "admission_gate"; receiptId: string; admissionId: string; idempotencyKey: string; expiresAt: string }
  | { allowed: false; reason: string }

const deny = (reason: string): RelationshipAuthorizationResult => ({ allowed: false, reason })

function authorizationReceipt(value: unknown): string {
  return `relationship-${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`
}

function stringList(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || !entry.trim())) throw new Error(`${label} must be a string array`)
  return [...new Set(value)]
}

export function loadRelationshipCapabilityRegistry(agentRoot: string): RelationshipCapabilityRegistry {
  const filePath = path.join(agentRoot, "tool-profiles.json")
  const raw = JSON.parse(fs.readFileSync(filePath, "utf8")) as { version?: unknown; profiles?: unknown }
  if (raw.version !== 2 || !raw.profiles || typeof raw.profiles !== "object" || Array.isArray(raw.profiles)) throw new Error("relationship capability registry version 2 is required")
  const profiles: Record<string, RelationshipCapabilityProfile> = {}
  for (const [id, value] of Object.entries(raw.profiles)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`relationship capability profile ${id} is invalid`)
    const candidate = value as Record<string, unknown>
    if (!Number.isInteger(candidate.version) || Number(candidate.version) < 1) throw new Error(`relationship capability profile ${id} version is invalid`)
    profiles[id] = {
      id,
      version: Number(candidate.version),
      contextScopes: stringList(candidate.contextScopes, `${id}.contextScopes`),
      toolNames: stringList(candidate.toolNames, `${id}.toolNames`),
      effectScopes: stringList(candidate.effectScopes, `${id}.effectScopes`),
    }
  }
  return { version: 2, profiles }
}

export function relationshipSubjectFromFriend(friend: FriendRecord): RelationshipAuthorizationSubject {
  return {
    friendId: friend.id,
    trustLevel: friend.trustLevel ?? "stranger",
    admissionState: friend.admissionState ?? "unverified",
    initiativePolicy: friend.initiativePolicy ?? "none",
    ...(friend.capabilityProfileId ? { capabilityProfileId: friend.capabilityProfileId } : {}),
  }
}

export function createRelationshipAuthorizationEvaluator(input: {
  friend: FriendRecord
  registry: RelationshipCapabilityRegistry
  requestId?: string
  requestPhase?: "inbound" | "follow_up"
  sessionEventId?: string
}): RelationshipAuthorizationEvaluator {
  const subject = relationshipSubjectFromFriend(input.friend)
  const profile = subject.capabilityProfileId ? input.registry.profiles[subject.capabilityProfileId] : undefined
  const profiles = Object.values(input.registry.profiles)
  const evaluate = (request: RelationshipAuthorizationRequest) => authorizeRelationshipAccess({
    relationship: subject,
    profiles,
    request,
    activeRequestId: input.requestId,
    requestPhase: input.requestPhase,
  })
  const advertisedToolNames = profile?.toolNames.filter((name) => evaluate({ kind: "tool", name, ...(input.requestId ? { requestId: input.requestId, returnTargetFriendId: subject.friendId } : {}) }).allowed) ?? []
  return {
    subject,
    advertisedToolNames,
    ...(input.sessionEventId ? { actor: { friendId: subject.friendId, trustLevel: subject.trustLevel, sessionEventId: input.sessionEventId } } : {}),
    authorizeContext: (scope) => evaluate({ kind: "context", scope }),
    authorizeTool: (name) => evaluate({ kind: "tool", name, ...(input.requestId ? { requestId: input.requestId, returnTargetFriendId: subject.friendId } : {}) }),
    authorizeEffect: (scope) => evaluate({ kind: "effect", scope, ...(input.requestId ? { requestId: input.requestId, returnTargetFriendId: subject.friendId } : {}) }),
  }
}

export function authorizeRelationshipAccess(input: {
  relationship?: RelationshipAuthorizationSubject
  profiles: RelationshipCapabilityProfile[]
  request: RelationshipAuthorizationRequest
  activeRequestId?: string
  requestPhase?: "inbound" | "follow_up"
  pendingAdmission?: { admissionId: string; botId: string; userId: string; chatId: string; expiresAt: string }
  now?: string
}): RelationshipAuthorizationResult {
  if (input.request.kind === "admission_gate") {
    const pending = input.pendingAdmission
    const now = Date.parse(input.now ?? new Date().toISOString())
    if (!pending || pending.admissionId !== input.request.admissionId || pending.botId !== input.request.botId || pending.userId !== input.request.userId || pending.chatId !== input.request.chatId || pending.expiresAt !== input.request.expiresAt || now >= Date.parse(input.request.expiresAt) || input.request.idempotencyKey !== `ack:${input.request.admissionId}`) {
      return deny("admission gate authorization does not match a current pending admission")
    }
    emitNervesEvent({ component: "repertoire", event: "repertoire.relationship_authorized", message: "authorized fixed admission gate acknowledgement", meta: { authorizationKind: "admission_gate", admissionId: input.request.admissionId } })
    return { allowed: true, authorizationKind: "admission_gate", receiptId: authorizationReceipt(input.request), admissionId: input.request.admissionId, idempotencyKey: input.request.idempotencyKey, expiresAt: input.request.expiresAt }
  }

  const relationship = input.relationship
  if (!relationship || relationship.admissionState !== "active") return deny("relationship admission is not active")
  if (relationship.trustLevel !== "friend" && relationship.trustLevel !== "family") return deny("relationship trust is insufficient")
  const profile = input.profiles.find((candidate) => candidate.id === relationship.capabilityProfileId)
  if (!profile || !Number.isInteger(profile.version) || profile.version < 1) return deny("relationship capability profile is missing or stale")
  if (input.request.kind === "context" && !profile.contextScopes.includes(input.request.scope)) return deny("context scope is not authorized by the relationship profile")
  if (input.request.kind === "tool" && !profile.toolNames.includes(input.request.name)) return deny("tool is not authorized by the relationship profile")
  if (input.request.kind === "effect" && !profile.effectScopes.includes(input.request.scope)) return deny("effect is not authorized by the relationship profile")

  const requestId = input.request.kind === "context" ? undefined : input.request.requestId
  const returnTarget = input.request.kind === "context" ? undefined : input.request.returnTargetFriendId
  if (relationship.initiativePolicy === "none") return deny("initiative policy denies contact")
  if (relationship.initiativePolicy === "reactive_only" && input.request.kind !== "context") {
    if (input.requestPhase !== "inbound" || !requestId || requestId !== input.activeRequestId || returnTarget !== relationship.friendId) return deny("initiative policy is reactive only")
  }
  if (relationship.initiativePolicy === "request_follow_up_only" && input.request.kind !== "context") {
    if (!requestId || requestId !== input.activeRequestId || returnTarget !== relationship.friendId) return deny("initiative policy requires the matching active request and return target")
  }

  emitNervesEvent({ component: "repertoire", event: "repertoire.relationship_authorized", message: "authorized relationship access", meta: { authorizationKind: "relationship", friendId: relationship.friendId, profileId: profile.id, profileVersion: profile.version, requestKind: input.request.kind } })
  return { allowed: true, authorizationKind: "relationship", receiptId: authorizationReceipt({ relationship, request: input.request, activeRequestId: input.activeRequestId, requestPhase: input.requestPhase, profile }), friendId: relationship.friendId, profileId: profile.id, profileVersion: profile.version, requestId: requestId ?? null }
}
