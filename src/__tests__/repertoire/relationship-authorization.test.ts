import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { describe, expect, it } from "vitest"
import {
  authorizeRelationshipAccess,
  createRelationshipAuthorizationEvaluator,
  loadRelationshipCapabilityRegistry,
  relationshipSubjectFromFriend,
  resolveProfileScopedRelationshipAuthorization,
  type RelationshipCapabilityProfile,
} from "../../repertoire/relationship-authorization"

const household: RelationshipCapabilityProfile = {
  id: "sanctuary-household",
  version: 1,
  contextScopes: ["household.status", "own_requests"],
  toolNames: ["unraid_get_system"],
  effectScopes: ["household.read", "telegram.reply"],
}

const member = {
  friendId: "brother",
  trustLevel: "friend" as const,
  admissionState: "active" as const,
  initiativePolicy: "request_follow_up_only" as const,
  capabilityProfileId: "sanctuary-household",
}

describe("relationship authorization", () => {
  it("loads the one typed registry and fails closed on legacy or malformed profiles", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "relationship-registry-"))
    try {
      fs.writeFileSync(path.join(root, "tool-profiles.json"), JSON.stringify({ version: 2, profiles: { "sanctuary-household": { version: 1, contextScopes: ["household.status"], toolNames: ["unraid_get_system"], effectScopes: ["telegram.request_return"] } } }))
      expect(loadRelationshipCapabilityRegistry(root).profiles["sanctuary-household"]).toEqual({ id: "sanctuary-household", version: 1, contextScopes: ["household.status"], toolNames: ["unraid_get_system"], effectScopes: ["telegram.request_return"] })
      fs.writeFileSync(path.join(root, "tool-profiles.json"), JSON.stringify({ version: 1, profiles: {} }))
      expect(() => loadRelationshipCapabilityRegistry(root)).toThrow("version 2")
      fs.writeFileSync(path.join(root, "tool-profiles.json"), JSON.stringify({ version: 2, profiles: { bad: { version: 0, contextScopes: [], toolNames: [], effectScopes: [] } } }))
      expect(() => loadRelationshipCapabilityRegistry(root)).toThrow("version")
    } finally { fs.rmSync(root, { recursive: true, force: true }) }
  })

  it("normalizes legacy Friends fields to fail-closed relationship defaults", () => {
    expect(relationshipSubjectFromFriend({ id: "legacy", name: "Legacy", externalIds: [], tenantMemberships: [], toolPreferences: {}, notes: {}, totalTokens: 0, createdAt: "", updatedAt: "", schemaVersion: 1 })).toEqual({ friendId: "legacy", trustLevel: "stranger", admissionState: "unverified", initiativePolicy: "none" })
  })

  it("builds one evaluator for prompt, advertisement, execution, and effects", () => {
    const evaluator = createRelationshipAuthorizationEvaluator({
      friend: { id: "brother", name: "Brother", trustLevel: "friend", admissionState: "active", initiativePolicy: "request_follow_up_only", capabilityProfileId: "sanctuary-household", externalIds: [], tenantMemberships: [], toolPreferences: {}, notes: {}, totalTokens: 0, createdAt: "", updatedAt: "", schemaVersion: 1 },
      registry: { version: 2, profiles: { "sanctuary-household": household } },
      requestId: "req-1",
      requestPhase: "inbound",
      sessionEventId: "evt-1",
    })
    expect(evaluator.advertisedToolNames).toEqual(["unraid_get_system"])
    expect(evaluator.authorizedContextScopes).toEqual(["household.status", "own_requests"])
    expect(evaluator.actor).toMatchObject({ friendId: "brother", sessionEventId: "evt-1" })
    expect(evaluator.authorizeContext("operator_private")).toMatchObject({ allowed: false })
    expect(evaluator.authorizeTool("unraid_get_system")).toMatchObject({ allowed: true, receiptId: expect.any(String) })
    expect(evaluator.authorizeEffect("telegram.reply")).toMatchObject({ allowed: true })
  })

  it("intersects an internal event-turn profile with the durable relationship profile", () => {
    const owner = { id: "ari", name: "Ari", trustLevel: "family" as const, admissionState: "active" as const, initiativePolicy: "proactive" as const, capabilityProfileId: "owner", externalIds: [], tenantMemberships: [], toolPreferences: {}, notes: {}, totalTokens: 0, createdAt: "", updatedAt: "", schemaVersion: 1 }
    const evaluator = createRelationshipAuthorizationEvaluator({
      friend: owner,
      registry: { version: 2, profiles: {
        owner: { id: "owner", version: 3, contextScopes: ["household.status", "household.private"], toolNames: ["unraid_get_system", "send_message"], effectScopes: ["telegram.proactive", "telegram.owner_event"] },
        event: { id: "event", version: 2, contextScopes: ["household.status", "household.policy"], toolNames: ["send_message", "shell"], effectScopes: ["telegram.owner_event"] },
      } },
      profileId: "event",
    })
    expect(evaluator.authorizedContextScopes).toEqual(["household.status"])
    expect(evaluator.advertisedToolNames).toEqual(["send_message"])
    expect(evaluator.authorizeTool("shell")).toMatchObject({ allowed: false })
    expect(evaluator.authorizeEffect("telegram.owner_event")).toMatchObject({ allowed: true, profileId: "event", profileVersion: 2 })
  })

  it("resolves exactly one durable relationship before applying an internal event reduction", async () => {
    const owner = { id: "ari", name: "Ari", trustLevel: "family" as const, admissionState: "active" as const, initiativePolicy: "proactive" as const, capabilityProfileId: "sanctuary-owner", externalIds: [], tenantMemberships: [], toolPreferences: {}, notes: {}, totalTokens: 0, createdAt: "", updatedAt: "", schemaVersion: 1 as const }
    const registry = { version: 2 as const, profiles: {
      "sanctuary-owner": { id: "sanctuary-owner", version: 3, contextScopes: ["household.status", "operator.private"], toolNames: ["external_event_disposition", "send_message"], effectScopes: ["telegram.owner_event"] },
      "sanctuary-event": { id: "sanctuary-event", version: 2, contextScopes: ["household.status"], toolNames: ["external_event_disposition"], effectScopes: [] },
    } }
    const store = { listAll: async () => [owner] } as any
    const evaluator = await resolveProfileScopedRelationshipAuthorization({ store, registry, relationshipProfileId: "sanctuary-owner", profileId: "sanctuary-event" })
    expect(evaluator.advertisedToolNames).toEqual(["external_event_disposition"])
    expect(evaluator.authorizeTool("external_event_disposition")).toMatchObject({ allowed: true, profileId: "sanctuary-event", profileVersion: 2 })
    await expect(resolveProfileScopedRelationshipAuthorization({ store: { listAll: async () => [] } as any, registry, relationshipProfileId: "sanctuary-owner", profileId: "sanctuary-event" })).rejects.toThrow("exactly one Friend")
    await expect(resolveProfileScopedRelationshipAuthorization({ store: { listAll: async () => [owner, { ...owner, id: "duplicate" }] } as any, registry, relationshipProfileId: "sanctuary-owner", profileId: "sanctuary-event" })).rejects.toThrow("exactly one Friend")
  })

  it("allows a household read within the active request and emits a versioned receipt", () => {
    expect(authorizeRelationshipAccess({
      relationship: member,
      profiles: [household],
      request: { kind: "tool", name: "unraid_get_system", requestId: "req-1", returnTargetFriendId: "brother" },
      activeRequestId: "req-1",
    })).toMatchObject({ allowed: true, receiptId: expect.stringMatching(/^relationship-[a-f0-9]{64}$/u), friendId: "brother", profileId: "sanctuary-household", profileVersion: 1, requestId: "req-1" })
  })

  it.each([
    { relationship: { ...member, admissionState: "revoked" as const }, reason: "admission" },
    { relationship: { ...member, capabilityProfileId: "missing" }, reason: "profile" },
    { relationship: { ...member, trustLevel: "stranger" as const }, reason: "trust" },
  ])("fails closed for $reason", ({ relationship, reason }) => {
    expect(authorizeRelationshipAccess({ relationship, profiles: [household], request: { kind: "tool", name: "unraid_get_system", requestId: "req-1", returnTargetFriendId: "brother" }, activeRequestId: "req-1" })).toMatchObject({ allowed: false, reason: expect.stringContaining(reason) })
  })

  it("denies private context, unlisted tools, cross-request returns, and unrelated outreach", () => {
    expect(authorizeRelationshipAccess({ relationship: member, profiles: [household], request: { kind: "context", scope: "operator_private" } })).toMatchObject({ allowed: false })
    expect(authorizeRelationshipAccess({ relationship: member, profiles: [household], request: { kind: "tool", name: "query_cares", requestId: "req-1", returnTargetFriendId: "brother" }, activeRequestId: "req-1" })).toMatchObject({ allowed: false })
    expect(authorizeRelationshipAccess({ relationship: member, profiles: [household], request: { kind: "effect", scope: "telegram.reply", requestId: "req-old", returnTargetFriendId: "brother" }, activeRequestId: "req-new" })).toMatchObject({ allowed: false, reason: expect.stringContaining("request") })
    expect(authorizeRelationshipAccess({ relationship: member, profiles: [household], request: { kind: "effect", scope: "telegram.reply", returnTargetFriendId: "brother" } })).toMatchObject({ allowed: false, reason: expect.stringContaining("initiative") })
  })

  it("allows only the fixed pending admission-gate effect without a relationship", () => {
    expect(authorizeRelationshipAccess({
      profiles: [household],
      request: { kind: "admission_gate", admissionId: "adm-1", botId: "100", userId: "200", chatId: "200", effect: "fixed_ack", idempotencyKey: "ack:adm-1", expiresAt: "2026-08-29T18:00:00.000Z" },
      pendingAdmission: { admissionId: "adm-1", botId: "100", userId: "200", chatId: "200", expiresAt: "2026-08-29T18:00:00.000Z" },
      now: "2026-08-29T17:00:00.000Z",
    })).toMatchObject({ allowed: true, authorizationKind: "admission_gate", admissionId: "adm-1" })
    expect(authorizeRelationshipAccess({
      profiles: [household],
      request: { kind: "admission_gate", admissionId: "adm-1", botId: "100", userId: "999", chatId: "200", effect: "fixed_ack", idempotencyKey: "ack:adm-1", expiresAt: "2026-08-29T18:00:00.000Z" },
      pendingAdmission: { admissionId: "adm-1", botId: "100", userId: "200", chatId: "200", expiresAt: "2026-08-29T18:00:00.000Z" },
      now: "2026-08-29T17:00:00.000Z",
    })).toMatchObject({ allowed: false })
  })

  it("denies missing, expired, replay-shaped, and wrong-effect admission receipts", () => {
    const pendingAdmission = { admissionId: "adm-1", botId: "100", userId: "200", chatId: "200", expiresAt: "2026-08-29T18:00:00.000Z" }
    const request = { kind: "admission_gate" as const, admissionId: "adm-1", botId: "100", userId: "200", chatId: "200", effect: "fixed_ack" as const, idempotencyKey: "wrong", expiresAt: pendingAdmission.expiresAt }
    expect(authorizeRelationshipAccess({ profiles: [], request, pendingAdmission, now: "2026-08-29T17:00:00.000Z" })).toMatchObject({ allowed: false })
    expect(authorizeRelationshipAccess({ profiles: [], request: { ...request, idempotencyKey: "ack:adm-1" }, pendingAdmission, now: "2026-08-29T18:00:00.000Z" })).toMatchObject({ allowed: false })
    expect(authorizeRelationshipAccess({ profiles: [], request: { ...request, idempotencyKey: "ack:adm-1" }, now: "2026-08-29T17:00:00.000Z" })).toMatchObject({ allowed: false })
  })

  it("enforces independent none/reactive/proactive initiative modes", () => {
    const tool = { kind: "tool" as const, name: "unraid_get_system", requestId: "req-1", returnTargetFriendId: "brother" }
    expect(authorizeRelationshipAccess({ relationship: { ...member, initiativePolicy: "none" }, profiles: [household], request: tool, activeRequestId: "req-1" })).toMatchObject({ allowed: false, reason: expect.stringContaining("initiative") })
    const reply = { kind: "effect" as const, scope: "telegram.reply", requestId: "req-1", returnTargetFriendId: "brother" }
    expect(authorizeRelationshipAccess({ relationship: { ...member, initiativePolicy: "reactive_only" }, profiles: [household], request: reply, activeRequestId: "req-1", requestPhase: "inbound" })).toMatchObject({ allowed: true })
    expect(authorizeRelationshipAccess({ relationship: { ...member, initiativePolicy: "reactive_only" }, profiles: [household], request: reply, activeRequestId: "req-1", requestPhase: "follow_up" })).toMatchObject({ allowed: false, reason: expect.stringContaining("reactive") })
    expect(authorizeRelationshipAccess({ relationship: { ...member, initiativePolicy: "request_follow_up_only" }, profiles: [household], request: reply, activeRequestId: "req-1", requestPhase: "follow_up" })).toMatchObject({ allowed: true })
    expect(authorizeRelationshipAccess({ relationship: { ...member, initiativePolicy: "proactive" }, profiles: [household], request: tool })).toMatchObject({ allowed: true, requestId: "req-1" })
  })
})
