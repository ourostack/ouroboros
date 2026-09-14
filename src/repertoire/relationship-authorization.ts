import * as fs from "node:fs"
import * as path from "node:path"
import { createHash } from "node:crypto"
import { isDeepStrictEqual } from "node:util"
import type { FriendRecord, FriendStore, RelationshipPolicyProvenance, TrustLevel } from "@ouro.bot/friends"
import type { RoutineActionRequester } from "../heart/steward-policy"
import type { ApprovalOwnerBinding } from "../heart/approval-store"
import { readExternalEventRecord } from "../heart/external-events/router"
import { emitNervesEvent } from "../nerves/runtime"
import type { ToolContext } from "./tools-base"

export function routineActionRequester(ctx?: ToolContext, eventTarget?: { friendId: string; target: { id: string; name: string } }): RoutineActionRequester | null {
  const relationship = ctx?.relationshipAuthorization
  if (!relationship) return null
  if (ctx?.currentExternalEvent) {
    if (!eventTarget || relationship.profileId !== "sanctuary-event") return null
    const events = [ctx.currentExternalEvent, ...(ctx.currentExternalEvent.relatedEvents ?? [])].filter((event) =>
      event.schemaVersion === 1 && event.source === "sanctuary-health" && event.eventId === `container:${eventTarget.target.id}:availability`)
    if (events.length !== 1) return null
    const event = events[0]!
    return {
      kind: "owner_event", friendId: eventTarget.friendId, profileId: relationship.profileId,
      event: { schemaVersion: 1, recordPath: event.recordPath, agent: event.agent, source: event.source, eventId: event.eventId, generation: event.generation, observationRevision: event.observationRevision, claimOwner: event.claimOwner },
      target: { ...eventTarget.target },
    }
  }
  const actor = relationship.actor
  const session = ctx?.currentSession
  if (!actor || !session || session.channel !== "telegram" || session.friendId !== actor.friendId
    || [actor.friendId, actor.sessionEventId, relationship.requestId, session.key].some((value) => typeof value !== "string" || !value.trim())) return null
  const kind = actor.trustLevel === "family" && relationship.profileId === "sanctuary-owner" ? "owner"
    : actor.trustLevel === "friend" && relationship.profileId === "sanctuary-household" ? "household_request" : null
  if (!kind) return null
  return { kind, friendId: actor.friendId, profileId: relationship.profileId!, requestId: relationship.requestId!, sessionEventId: actor.sessionEventId, origin: { friendId: session.friendId, channel: session.channel, key: session.key } }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

export function authorizeRestartApprovalRequester(ctx: ToolContext | undefined, args: Record<string, unknown>, binding: ApprovalOwnerBinding) {
  return authorizeRoutineActionRequester(ctx, args, {
    requester: {
      kind: "owner", friendId: binding.friendId, profileId: "sanctuary-owner", requestId: binding.requestId,
      sessionEventId: binding.sessionEventId, origin: { friendId: binding.friendId, channel: "telegram", key: binding.sessionKey },
    },
    profileVersion: binding.profileVersion,
  })
}

export async function authorizeRoutineActionRequester(ctx: ToolContext | undefined, args: Record<string, unknown>, expected?: { requester: RoutineActionRequester; profileVersion: number }): Promise<
  | { allowed: true; requester: RoutineActionRequester; receiptId: string; profileVersion: number }
  | { allowed: false; reason: string }
> {
  if (!isRecord(args) || Object.keys(args).length !== 1 || typeof args.container !== "string"
    || !args.container || args.container !== args.container.trim() || Buffer.byteLength(args.container) > 128 || args.container.includes("\uFFFD")
    || !ctx?.agentRoot || !ctx.relationshipAuthorization) return { allowed: false, reason: "routine action requires one exact target and current relationship" }
  const target = args.container
  const agentRoot = ctx.agentRoot
  const relationship = ctx.relationshipAuthorization
  const sanctuary = ctx.sanctuary
  const initialRequester = routineActionRequester(ctx)
  const event = ctx.currentExternalEvent && structuredClone(ctx.currentExternalEvent)
  if (!initialRequester && (!event || event.source !== "sanctuary-health" || relationship.profileId !== "sanctuary-event")) return { allowed: false, reason: "routine action requires a current human request or health event" }
  const unchanged = () => ctx.agentRoot === agentRoot && ctx.relationshipAuthorization === relationship && ctx.sanctuary === sanctuary
    && args.container === target && Object.keys(args).length === 1
    && isDeepStrictEqual(initialRequester, routineActionRequester(ctx)) && isDeepStrictEqual(event, ctx.currentExternalEvent)
  let authorization: Awaited<ReturnType<NonNullable<ToolContext["relationshipAuthorization"]>["authorizeTool"]>>
  try { authorization = await relationship.authorizeTool("unraid_restart_container", { container: target }) }
  catch { return { allowed: false, reason: "routine relationship authorization is unavailable" } }
  if (!authorization?.allowed) return { allowed: false, reason: authorization?.allowed === false ? authorization.reason : "routine relationship authorization is unavailable" }
  if (typeof authorization.profileVersion !== "number" || !Number.isSafeInteger(authorization.profileVersion) || authorization.profileVersion < 1
    || typeof authorization.receiptId !== "string" || !authorization.receiptId.trim()) return { allowed: false, reason: "routine relationship authorization is not versioned" }
  if (expected && authorization.profileVersion !== expected.profileVersion) return { allowed: false, reason: "routine relationship profile version changed" }
  if (!unchanged() || (authorization.profileId !== undefined && authorization.profileId !== relationship.profileId)) return { allowed: false, reason: "routine request binding changed during authorization" }
  if (!event) {
    if (!initialRequester || initialRequester.kind === "owner_event"
      || (authorization.friendId !== undefined && authorization.friendId !== initialRequester.friendId)
      || (authorization.requestId !== undefined && authorization.requestId !== initialRequester.requestId)
      || (expected && !isDeepStrictEqual(expected.requester, initialRequester))) return { allowed: false, reason: "routine request binding does not match live authorization" }
    return { allowed: true, requester: initialRequester, receiptId: authorization.receiptId, profileVersion: authorization.profileVersion }
  }
  if (!sanctuary || authorization.profileId !== "sanctuary-event" || typeof authorization.friendId !== "string" || !authorization.friendId.trim()) return { allowed: false, reason: "current health event authorization is unavailable" }
  let eventTarget: { id: string; name: string }
  if (expected) {
    if (expected.requester.kind !== "owner_event" || expected.requester.target.name !== target) return { allowed: false, reason: "current health event target binding changed" }
    eventTarget = expected.requester.target
  } else {
    let listed: unknown
    try { listed = await sanctuary.listContainers() }
    catch { return { allowed: false, reason: "current health event container status is unavailable" } }
    if (!isRecord(listed) || listed.ok !== true || !isRecord(listed.data) || listed.data.truncated !== false || !Array.isArray(listed.data.containers)) return { allowed: false, reason: "current health event container status is invalid" }
    const matches = listed.data.containers.filter((value): value is Record<string, unknown> => isRecord(value) && value.name === target)
    const container = matches[0]
    if (matches.length !== 1 || !container || typeof container.id !== "string" || !container.id.trim()
      || container.state !== "exited" || container.degraded !== false) return { allowed: false, reason: "current health event target is not exactly stopped" }
    eventTarget = { id: container.id, name: target }
  }
  const requester = routineActionRequester(ctx, { friendId: authorization.friendId, target: eventTarget })
  if (!requester || requester.kind !== "owner_event" || !unchanged() || (expected && !isDeepStrictEqual(expected.requester, requester))) return { allowed: false, reason: "current health event target or request binding changed" }
  let current: ReturnType<typeof readExternalEventRecord>
  try { current = readExternalEventRecord(requester.event.recordPath) }
  catch { return { allowed: false, reason: "current health event record is unavailable" } }
  const lease = requester.event
  if (current.agent !== lease.agent || current.source !== lease.source || current.eventId !== lease.eventId || current.eventType !== "health.observed"
    || current.generation !== lease.generation || current.observationRevision !== lease.observationRevision || current.claimOwner !== lease.claimOwner
    || current.executionState !== "running" || !(Date.parse(current.claimExpiresAt ?? "") > Date.now())
    || current.transition === "recovered" || current.pendingObservation !== null) return { allowed: false, reason: "current health event claim or observation changed" }
  return { allowed: true, requester, receiptId: authorization.receiptId, profileVersion: authorization.profileVersion }
}

export function renderRelationshipPreferences(friend: Pick<FriendRecord, "relationshipPolicy">): string[] {
  const now = Date.now()
  return Object.entries(friend.relationshipPolicy?.preferences ?? {})
    .filter(([, preference]) => !preference.expiresAt || Date.parse(preference.expiresAt) > now)
    .slice(0, 20)
    .map(([category, preference]) =>
      `- source=${preference.source}; provenance=${preference.provenance}; category=${category}; value=${String(preference.value).replace(/\s+/gu, " ").trim().slice(0, 500)}; version=${preference.version}; precedence=current${preference.expiresAt ? `; expires=${preference.expiresAt}` : ""}`,
    )
}

export function withRelationshipPreference(friend: FriendRecord, input: { category: string; value: string; provenance: RelationshipPolicyProvenance; source: string }): FriendRecord {
  const current = friend.relationshipPolicy ?? { schemaVersion: 1 as const, version: 0, preferences: {} }
  const previous = current.preferences[input.category]
  return {
    ...friend,
    relationshipPolicy: {
      schemaVersion: 1,
      version: current.version + 1,
      preferences: { ...current.preferences, [input.category]: { value: input.value, provenance: input.provenance, source: input.source, version: (previous?.version ?? 0) + 1 } },
    },
    updatedAt: new Date().toISOString(),
  }
}

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
  readonly profileId?: string
  readonly authorizedContextScopes: readonly string[]
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
  /** Optional internal turn profile; it can only reduce the Friend's durable relationship profile. */
  profileId?: string
  requestId?: string
  requestPhase?: "inbound" | "follow_up"
  sessionEventId?: string
}): RelationshipAuthorizationEvaluator {
  const subject = relationshipSubjectFromFriend(input.friend)
  const relationshipProfile = subject.capabilityProfileId ? input.registry.profiles[subject.capabilityProfileId] : undefined
  const turnProfile = input.profileId ? input.registry.profiles[input.profileId] : relationshipProfile
  const profile = relationshipProfile && turnProfile
    ? {
        id: turnProfile.id,
        version: turnProfile.version,
        contextScopes: turnProfile.contextScopes.filter((scope) => relationshipProfile.contextScopes.includes(scope)),
        toolNames: turnProfile.toolNames.filter((name) => relationshipProfile.toolNames.includes(name)),
        effectScopes: turnProfile.effectScopes.filter((scope) => relationshipProfile.effectScopes.includes(scope)),
      }
    : undefined
  const effectiveSubject = { ...subject, ...(profile ? { capabilityProfileId: profile.id } : {}) }
  const profiles = profile ? [profile] : []
  const evaluate = (request: RelationshipAuthorizationRequest) => authorizeRelationshipAccess({
    relationship: effectiveSubject,
    profiles,
    request,
    activeRequestId: input.requestId,
    requestPhase: input.requestPhase,
  })
  const advertisedToolNames = profile?.toolNames.filter((name) => evaluate({ kind: "tool", name, ...(input.requestId ? { requestId: input.requestId, returnTargetFriendId: subject.friendId } : {}) }).allowed) ?? []
  const authorizedContextScopes = profile?.contextScopes.filter((scope) => evaluate({ kind: "context", scope }).allowed) ?? []
  return {
    subject,
    ...(profile ? { profileId: profile.id } : {}),
    authorizedContextScopes,
    advertisedToolNames,
    ...(input.sessionEventId ? { actor: { friendId: subject.friendId, trustLevel: subject.trustLevel, sessionEventId: input.sessionEventId } } : {}),
    authorizeContext: (scope) => evaluate({ kind: "context", scope }),
    authorizeTool: (name) => evaluate({ kind: "tool", name, ...(input.requestId ? { requestId: input.requestId, returnTargetFriendId: subject.friendId } : {}) }),
    authorizeEffect: (scope) => evaluate({ kind: "effect", scope, ...(input.requestId ? { requestId: input.requestId, returnTargetFriendId: subject.friendId } : {}) }),
  }
}

export async function resolveProfileScopedRelationshipAuthorization(input: {
  store: FriendStore
  registry: RelationshipCapabilityRegistry
  relationshipProfileId: string
  profileId?: string
  requestId?: string
  requestPhase?: "inbound" | "follow_up"
  sessionEventId?: string
}): Promise<RelationshipAuthorizationEvaluator> {
  const friends = await input.store.listAll?.() ?? []
  const matches = friends.filter((friend) => friend.capabilityProfileId === input.relationshipProfileId)
  if (matches.length !== 1) throw new Error(`relationship profile ${input.relationshipProfileId} must resolve to exactly one Friend`)
  return createRelationshipAuthorizationEvaluator({
    friend: matches[0]!,
    registry: input.registry,
    ...(input.profileId ? { profileId: input.profileId } : {}),
    ...(input.requestId ? { requestId: input.requestId } : {}),
    ...(input.requestPhase ? { requestPhase: input.requestPhase } : {}),
    ...(input.sessionEventId ? { sessionEventId: input.sessionEventId } : {}),
  })
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
