import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import {
  consumeRoutineActionGrant,
  readStewardPolicy,
  updateStewardPolicy,
} from "../../heart/steward-policy"
import { acquireSessionTurnLease } from "../../mind/session-transaction"
import { resolveToolDefinition } from "../../repertoire/tools"

const roots: string[] = []

function root(): string {
  const value = fs.mkdtempSync(path.join(os.tmpdir(), "steward-policy-"))
  roots.push(value)
  return value
}

const ari = { friendId: "ari", trustLevel: "family" as const, sessionEventId: "evt-ari-1" }

afterEach(() => {
  for (const value of roots.splice(0)) fs.rmSync(value, { recursive: true, force: true })
})

describe("steward policy", () => {
  it("exposes one narrow relationship-bound management tool", async () => {
    const agentRoot = root()
    const definition = resolveToolDefinition("steward_policy_manage")!
    const relationshipAuthorization = { authorizedContextScopes: ["household.private"], advertisedToolNames: ["steward_policy_manage"], authorizeTool: () => ({ allowed: true as const, receiptId: "auth-1" }), actor: ari }
    expect(definition.riskProfile).toBeTypeOf("function")
    expect(() => definition.handler({ action: "read" }, { signin: async () => undefined, agentRoot })).toThrow("relationship authority")
    expect(await definition.handler({ action: "read" }, { signin: async () => undefined, agentRoot, relationshipAuthorization })).toContain('"version":0')
    expect(() => definition.handler({ action: "set_desired_state", expectedVersion: "0", key: "container:books", value: "off", provenance: "stated", source: "direct instruction" }, { signin: async () => undefined, agentRoot })).toThrow("relationship authority")
    const result = await definition.handler({ action: "set_desired_state", expectedVersion: "0", key: "container:books", value: "off", provenance: "stated", source: "direct instruction" }, {
      signin: async () => undefined,
      agentRoot,
      relationshipAuthorization,
    })
    expect(JSON.parse(String(result))).toMatchObject({ version: 1, desiredStates: { "container:books": { value: "off", provenance: "stated" } } })
  })

  it("starts fail-closed with no desired states or routine action grants", () => {
    expect(readStewardPolicy(root())).toMatchObject({ schemaVersion: 1, version: 0, desiredStates: {}, routineActionGrants: {} })
  })

  it("records an observed desired state without turning it into mutation authority", () => {
    const agentRoot = root()
    const updated = updateStewardPolicy(agentRoot, {
      expectedVersion: 0,
      actor: ari,
      mutation: { kind: "set_desired_state", key: "container:books", value: "intentionally_paused", provenance: "observed", source: "ari said he is not using it" },
    })
    expect(updated.desiredStates["container:books"]).toMatchObject({ value: "intentionally_paused", provenance: "observed", version: 1 })
    expect(updated.routineActionGrants).toEqual({})
  })

  it.each(["observed", "default"] as const)("rejects %s provenance for a routine mutation grant", (provenance) => {
    expect(() => updateStewardPolicy(root(), {
      expectedVersion: 0,
      actor: ari,
      mutation: {
        kind: "grant_routine_action",
        key: "unraid.restart:books",
        action: "unraid.restart",
        targets: ["books"],
        maxCount: 1,
        windowMs: 3_600_000,
        verificationRequired: true,
        exclusions: ["ouro-butler"],
        provenance,
      },
    })).toThrow("explicit authority")
  })

  it("requires verification and canonical future expiry for policy changes", () => {
    const agentRoot = root()
    expect(() => updateStewardPolicy(agentRoot, { expectedVersion: 0, actor: ari, now: "2026-08-29T16:00:00.000Z", mutation: { kind: "grant_routine_action", key: "restart", action: "unraid.restart", targets: ["books"], maxCount: 1, windowMs: 1_000, verificationRequired: false, exclusions: [], provenance: "stated" } })).toThrow("verification")
    expect(() => updateStewardPolicy(agentRoot, { expectedVersion: 0, actor: ari, now: "2026-08-29T16:00:00.000Z", mutation: { kind: "set_desired_state", key: "container:books", value: "off", provenance: "stated", source: "request", expiresAt: "not-a-time" } })).toThrow("canonical")
    expect(() => updateStewardPolicy(agentRoot, { expectedVersion: 0, actor: ari, now: "2026-08-29T16:00:00.000Z", mutation: { kind: "set_desired_state", key: "container:books", value: "off", provenance: "stated", source: "request", expiresAt: "2026-08-29T15:00:00.000Z" } })).toThrow("future")
  })

  it("requires family identity, a current authorizing session event, and fresh CAS", () => {
    const agentRoot = root()
    const mutation = { kind: "set_desired_state" as const, key: "container:books", value: "on_demand", provenance: "stated" as const, source: "direct instruction" }
    expect(() => updateStewardPolicy(agentRoot, { expectedVersion: 0, actor: { friendId: "relative", trustLevel: "friend", sessionEventId: "evt-1" }, mutation })).toThrow("family")
    expect(() => updateStewardPolicy(agentRoot, { expectedVersion: 0, actor: { friendId: "ari", trustLevel: "family", sessionEventId: "" }, mutation })).toThrow("session event")
    updateStewardPolicy(agentRoot, { expectedVersion: 0, actor: ari, mutation })
    expect(() => updateStewardPolicy(agentRoot, { expectedVersion: 0, actor: { ...ari, sessionEventId: "evt-ari-2" }, mutation })).toThrow("version")
  })

  it("atomically consumes a bounded action grant and preserves the rate window across reload", () => {
    const agentRoot = root()
    updateStewardPolicy(agentRoot, {
      expectedVersion: 0,
      actor: ari,
      mutation: {
        kind: "grant_routine_action",
        key: "unraid.restart:books",
        action: "unraid.restart",
        targets: ["books"],
        maxCount: 1,
        windowMs: 3_600_000,
        verificationRequired: true,
        exclusions: ["ouro-butler"],
        provenance: "stated",
      },
    })
    const first = consumeRoutineActionGrant(agentRoot, { key: "unraid.restart:books", target: "books", expectedPolicyVersion: 1, now: "2026-08-29T17:00:00.000Z" })
    expect(first).toMatchObject({ state: "reserved", target: "books", policyVersion: 1, expectedBeforeState: null, effectReceipt: null, verifiedAfterState: null, recoveryState: "not_needed" })
    expect(() => consumeRoutineActionGrant(agentRoot, { key: "unraid.restart:books", target: "books", expectedPolicyVersion: 1, now: "2026-08-29T17:30:00.000Z" })).toThrow("rate limit")
    expect(readStewardPolicy(agentRoot).version).toBe(1)
  })

  it("rejects excluded targets, target drift, and stale policy versions before reservation", () => {
    const agentRoot = root()
    updateStewardPolicy(agentRoot, {
      expectedVersion: 0,
      actor: ari,
      mutation: { kind: "grant_routine_action", key: "unraid.restart:books", action: "unraid.restart", targets: ["books"], maxCount: 1, windowMs: 1_000, verificationRequired: true, exclusions: ["ouro-butler"], provenance: "stated" },
    })
    expect(() => consumeRoutineActionGrant(agentRoot, { key: "unraid.restart:books", target: "ouro-butler", expectedPolicyVersion: 1 })).toThrow("target")
    expect(() => consumeRoutineActionGrant(agentRoot, { key: "unraid.restart:books", target: "photos", expectedPolicyVersion: 1 })).toThrow("target")
    expect(() => consumeRoutineActionGrant(agentRoot, { key: "unraid.restart:books", target: "books", expectedPolicyVersion: 0 })).toThrow("version")
  })

  it("rejects malformed policy, missing/expired grants, invalid bounds, and concurrent ledger claims", async () => {
    const malformedRoot = root()
    fs.mkdirSync(path.join(malformedRoot, "state", "policy"), { recursive: true })
    fs.writeFileSync(path.join(malformedRoot, "state", "policy", "steward.json"), "{}\n")
    expect(() => readStewardPolicy(malformedRoot)).toThrow("invalid")

    const agentRoot = root()
    expect(() => updateStewardPolicy(agentRoot, {
      expectedVersion: 0,
      actor: ari,
      mutation: { kind: "grant_routine_action", key: "bad", action: "unraid.restart", targets: [], maxCount: 0, windowMs: 0, verificationRequired: true, exclusions: [], provenance: "stated" },
    })).toThrow("bounds")
    expect(() => consumeRoutineActionGrant(agentRoot, { key: "missing", target: "books", expectedPolicyVersion: 0 })).toThrow("missing")

    updateStewardPolicy(agentRoot, {
      expectedVersion: 0,
      actor: ari,
      now: "2026-08-29T16:00:00.000Z",
      mutation: { kind: "grant_routine_action", key: "restart", action: "unraid.restart", targets: ["books"], maxCount: 1, windowMs: 1_000, verificationRequired: true, exclusions: [], provenance: "stated", expiresAt: "2026-08-29T17:00:00.000Z" },
    })
    expect(() => consumeRoutineActionGrant(agentRoot, { key: "restart", target: "books", expectedPolicyVersion: 1, now: "2026-08-29T17:00:00.000Z" })).toThrow("expired")
    const lease = await acquireSessionTurnLease(path.join(agentRoot, "state", "policy", "action-receipts.ndjson"), { timeoutMs: 10 })
    try {
      expect(() => consumeRoutineActionGrant(agentRoot, { key: "restart", target: "books", expectedPolicyVersion: 1, now: "2026-08-29T16:30:00.000Z" })).toThrow("busy")
    } finally {
      await lease.release()
    }
  })
})
