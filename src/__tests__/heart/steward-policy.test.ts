import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  inspectRoutineActionGrant,
  readRoutineActionReceipts,
  recoverRoutineActionReceipts,
  transitionRoutineActionReceipt,
  consumeRoutineActionGrant,
  readStewardPolicy,
  updateStewardPolicy,
} from "../../heart/steward-policy"
import { acquireSessionTurnLease } from "../../mind/session-transaction"
import { resolveToolDefinition } from "../../repertoire/tools"
import { stewardPolicyToolDefinition } from "../../repertoire/tools-steward-policy"

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
  it("covers the direct tool contract, validation boundaries, and risk profiles", async () => {
    const agentRoot = root()
    const relationshipAuthorization = { authorizedContextScopes: [], advertisedToolNames: [], authorizeTool: () => ({ allowed: true as const, receiptId: "auth" }), actor: ari }
    const context = { signin: async () => undefined, agentRoot, relationshipAuthorization }
    expect(() => stewardPolicyToolDefinition.handler({ action: "read" }, undefined)).toThrow("runtime")
    expect(() => stewardPolicyToolDefinition.handler({ action: "read" }, { signin: async () => undefined, agentRoot } as any)).toThrow("relationship")
    expect(stewardPolicyToolDefinition.handler({ action: "read" }, context as any)).toContain('"version":0')
    expect(() => stewardPolicyToolDefinition.handler({ action: "set_desired_state", expectedVersion: 0 }, { ...context, relationshipAuthorization: { ...relationshipAuthorization, actor: undefined } } as any)).toThrow("mutation requires")
    expect(() => stewardPolicyToolDefinition.handler({ action: "set_desired_state", expectedVersion: "bad" }, context as any)).toThrow("nonnegative")
    expect(() => stewardPolicyToolDefinition.handler({ action: "set_desired_state", expectedVersion: 0, provenance: "bogus" }, context as any)).toThrow("provenance")
    expect(() => stewardPolicyToolDefinition.handler({ action: "set_desired_state", expectedVersion: 0, provenance: "stated" }, context as any)).toThrow("key must be nonempty")
    expect(() => stewardPolicyToolDefinition.handler({ action: "grant_routine_action", expectedVersion: 0, provenance: "observed" }, context as any)).toThrow("provenance")
    expect(() => stewardPolicyToolDefinition.handler({ action: "grant_routine_action", expectedVersion: 0, provenance: "stated" }, context as any)).toThrow("targetsJson is required")
    expect(() => stewardPolicyToolDefinition.handler({ action: "grant_routine_action", expectedVersion: 0, provenance: "stated", targetsJson: "{}" }, context as any)).toThrow("JSON string array")
    expect(() => stewardPolicyToolDefinition.handler({ action: "grant_routine_action", expectedVersion: 0, provenance: "stated", targetsJson: '["books",1]' }, context as any)).toThrow("JSON string array")
    expect(() => stewardPolicyToolDefinition.handler({ action: "unknown", expectedVersion: 0 }, context as any)).toThrow("action is invalid")
    expect(stewardPolicyToolDefinition.riskProfile!({ action: "read" } as any)).toMatchObject({ risk: "low" })
    expect(stewardPolicyToolDefinition.riskProfile!({ action: "set_desired_state" } as any)).toMatchObject({ risk: "high" })
    const granted = stewardPolicyToolDefinition.handler({ action: "grant_routine_action", expectedVersion: 0, provenance: "stated", key: "restart", routineAction: "unraid.container.restart", targetsJson: '["books"]', exclusionsJson: "[]", maxCount: 1, windowMs: 1000, verificationRequired: "true", expiresAt: "2099-01-01T00:00:00.000Z" }, context as any)
    expect(granted).toContain('"restart"')
    const desired = stewardPolicyToolDefinition.handler({ action: "set_desired_state", expectedVersion: 1, provenance: "default", key: "container:music", value: "on", source: "default" }, context as any)
    expect(desired).toContain("container:music")
    const expiring = stewardPolicyToolDefinition.handler({ action: "set_desired_state", expectedVersion: 2, provenance: "stated", key: "container:video", value: "on", source: "request", expiresAt: "2099-01-02T00:00:00.000Z" }, context as any)
    expect(expiring).toContain("2099-01-02")
    const secondGrant = stewardPolicyToolDefinition.handler({ action: "grant_routine_action", expectedVersion: 3, provenance: "installed_explicit_policy", key: "restart-video", routineAction: "restart", targetsJson: '["video"]', exclusionsJson: "[]", maxCount: 1, windowMs: 1000, verificationRequired: "true" }, context as any)
    expect(secondGrant).toContain("restart-video")
  })

  it("covers malformed policy, empty targets, expiry, and missing receipt boundaries", () => {
    const agentRoot = root()
    const policyDir = path.join(agentRoot, "state", "policy")
    fs.mkdirSync(policyDir, { recursive: true })
    for (const malformed of [null, [], { schemaVersion: 1, version: -1, desiredStates: {}, routineActionGrants: {} }]) {
      fs.writeFileSync(path.join(policyDir, "steward.json"), JSON.stringify(malformed))
      expect(() => readStewardPolicy(agentRoot)).toThrow("invalid")
    }
    fs.rmSync(path.join(policyDir, "steward.json"))
    expect(() => updateStewardPolicy(agentRoot, { expectedVersion: 0, actor: ari, mutation: { kind: "grant_routine_action", key: "restart", action: "restart", targets: [], maxCount: 1, windowMs: 1, verificationRequired: true, exclusions: [], provenance: "stated" } })).toThrow("requires a target")
    updateStewardPolicy(agentRoot, { expectedVersion: 0, actor: ari, now: "2026-01-01T00:00:00.000Z", mutation: { kind: "set_desired_state", key: "container:books", value: "off", provenance: "stated", source: "test", expiresAt: "2026-01-02T00:00:00.000Z" } })
    expect(readStewardPolicy(agentRoot).desiredStates["container:books"]?.expiresAt).toBe("2026-01-02T00:00:00.000Z")
    expect(() => transitionRoutineActionReceipt(agentRoot, { id: "missing", expectedState: "reserved", state: "attempting" })).toThrow("missing")
  })

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
    expect(first).toMatchObject({ state: "reserved", target: "books", policyVersion: 1, expectedBeforeState: null, effectReceipt: null, verifiedAfterState: null, recoveryState: { state: "not_needed", compensation: "none" } })
    transitionRoutineActionReceipt(agentRoot, { id: first.id, expectedState: "reserved", state: "attempting" })
    transitionRoutineActionReceipt(agentRoot, { id: first.id, expectedState: "attempting", state: "effect_acknowledged", effectReceipt: "ack" })
    transitionRoutineActionReceipt(agentRoot, { id: first.id, expectedState: "effect_acknowledged", state: "verified", verifiedAfterState: "running" })
    expect(() => consumeRoutineActionGrant(agentRoot, { key: "unraid.restart:books", target: "books", expectedPolicyVersion: 1, now: "2026-08-29T17:30:00.000Z" })).toThrow("rate limit")
    expect(readStewardPolicy(agentRoot).version).toBe(1)
  })

  it("serializes policy updates and action reservation under the same steward-authority lease", async () => {
    const agentRoot = root()
    updateStewardPolicy(agentRoot, {
      expectedVersion: 0,
      actor: ari,
      mutation: { kind: "grant_routine_action", key: "restart", action: "unraid.container.restart", targets: ["books"], maxCount: 2, windowMs: 3_600_000, verificationRequired: true, exclusions: [], provenance: "stated" },
    })
    const authorityPath = path.join(agentRoot, "state", "policy", "steward.json")
    const lease = await acquireSessionTurnLease(authorityPath, { timeoutMs: 10 })
    try {
      expect(() => consumeRoutineActionGrant(agentRoot, { key: "restart", action: "unraid.container.restart", target: "books", expectedPolicyVersion: 1 })).toThrow("busy")
    } finally {
      await lease.release()
    }
  })

  it.each(["reserved", "attempting", "effect_acknowledged", "recovery_pending", "indeterminate"] as const)("fences a later standing mutation while the same action and target has an unresolved %s receipt", (state) => {
    const agentRoot = root()
    updateStewardPolicy(agentRoot, {
      expectedVersion: 0,
      actor: ari,
      mutation: { kind: "grant_routine_action", key: "restart", action: "unraid.container.restart", targets: ["books", "music"], maxCount: 20, windowMs: 3_600_000, verificationRequired: true, exclusions: [], provenance: "stated" },
    })
    const receipt = consumeRoutineActionGrant(agentRoot, { key: "restart", action: "unraid.container.restart", target: "books", expectedPolicyVersion: 1, authorizationReceiptId: "relationship-1", authorizationVersion: 7 })
    if (state !== "reserved") transitionRoutineActionReceipt(agentRoot, { id: receipt.id, expectedState: "reserved", state: "attempting" })
    if (["effect_acknowledged", "recovery_pending", "indeterminate"].includes(state)) transitionRoutineActionReceipt(agentRoot, { id: receipt.id, expectedState: "attempting", state: state === "effect_acknowledged" ? "effect_acknowledged" : state, ...(state === "effect_acknowledged" || state === "recovery_pending" ? { effectReceipt: "ack" } : {}), ...(state === "indeterminate" ? { recoveryState: { state: "manual_inspection_required" as const, compensation: "none" as const } } : {}) })

    expect(inspectRoutineActionGrant(agentRoot, { key: "restart", action: "unraid.container.restart", target: "books", expectedPolicyVersion: 1 })).toMatchObject({ allowed: false, reason: expect.stringContaining("unresolved") })
    expect(() => consumeRoutineActionGrant(agentRoot, { key: "restart", action: "unraid.container.restart", target: "books", expectedPolicyVersion: 1 })).toThrow("unresolved")
    expect(inspectRoutineActionGrant(agentRoot, { key: "restart", action: "unraid.container.restart", target: "music", expectedPolicyVersion: 1 })).toMatchObject({ allowed: true })
  })

  it("fsyncs the steward directory when creating the first action receipt", () => {
    const agentRoot = root()
    updateStewardPolicy(agentRoot, { expectedVersion: 0, actor: ari, mutation: { kind: "grant_routine_action", key: "restart", action: "unraid.container.restart", targets: ["books"], maxCount: 2, windowMs: 3_600_000, verificationRequired: true, exclusions: [], provenance: "stated" } })
    consumeRoutineActionGrant(agentRoot, { key: "restart", action: "unraid.container.restart", target: "books", expectedPolicyVersion: 1 })
    expect(fs.readFileSync(path.join(agentRoot, "state", "policy", "action-receipts.ndjson"), "utf8")).toContain('"state":"reserved"')
    const source = fs.readFileSync(path.join(process.cwd(), "src", "heart", "steward-policy.ts"), "utf8")
    expect(source).toContain("if (creating)")
    expect(source).toContain("fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW")
    expect(source).toContain("fs.fsyncSync(directory)")
  })

  it("authorizes only the exact action, target, policy version, and non-off desired state", () => {
    const agentRoot = root()
    updateStewardPolicy(agentRoot, {
      expectedVersion: 0,
      actor: ari,
      now: "2026-08-29T16:00:00.000Z",
      mutation: { kind: "grant_routine_action", key: "unraid.restart:books", action: "unraid.container.restart", targets: ["books"], maxCount: 2, windowMs: 3_600_000, verificationRequired: true, exclusions: ["ouro-butler"], provenance: "stated" },
    })
    expect(inspectRoutineActionGrant(agentRoot, { key: "unraid.restart:books", action: "unraid.container.restart", target: "books", expectedPolicyVersion: 1, now: "2026-08-29T16:30:00.000Z" })).toMatchObject({ allowed: true, policyVersion: 1, grantVersion: 1 })
    expect(inspectRoutineActionGrant(agentRoot, { key: "unraid.restart:books", action: "wrong", target: "books", expectedPolicyVersion: 1 })).toMatchObject({ allowed: false, reason: expect.stringContaining("action") })
    expect(inspectRoutineActionGrant(agentRoot, { key: "unraid.restart:books", action: "unraid.container.restart", target: "ouro-butler", expectedPolicyVersion: 1 })).toMatchObject({ allowed: false, reason: expect.stringContaining("target") })
    expect(inspectRoutineActionGrant(agentRoot, { key: "unraid.restart:books", action: "unraid.container.restart", target: "books", expectedPolicyVersion: 0 })).toMatchObject({ allowed: false, reason: expect.stringContaining("version") })

    updateStewardPolicy(agentRoot, {
      expectedVersion: 1,
      actor: { ...ari, sessionEventId: "evt-ari-2" },
      mutation: { kind: "set_desired_state", key: "container:books", value: "off", provenance: "stated", source: "Ari asked for it to remain off" },
    })
    expect(inspectRoutineActionGrant(agentRoot, { key: "unraid.restart:books", action: "unraid.container.restart", target: "books", expectedPolicyVersion: 2 })).toMatchObject({ allowed: false, reason: expect.stringContaining("expected off") })
  })

  it("keeps an explicitly-on desired state eligible and treats expired off state as inactive", () => {
    const agentRoot = root()
    updateStewardPolicy(agentRoot, { expectedVersion: 0, actor: ari, now: "2026-01-01T00:00:00.000Z", mutation: { kind: "grant_routine_action", key: "restart", action: "restart", targets: ["books"], maxCount: 2, windowMs: 1000, verificationRequired: true, exclusions: [], provenance: "stated" } })
    updateStewardPolicy(agentRoot, { expectedVersion: 1, actor: { ...ari, sessionEventId: "evt-2" }, now: "2026-01-01T00:00:00.000Z", mutation: { kind: "set_desired_state", key: "container:books", value: "on", provenance: "stated", source: "test" } })
    expect(inspectRoutineActionGrant(agentRoot, { key: "restart", action: "restart", target: "books", expectedPolicyVersion: 2, now: "2026-01-01T00:00:00.500Z" })).toMatchObject({ allowed: true })
    updateStewardPolicy(agentRoot, { expectedVersion: 2, actor: { ...ari, sessionEventId: "evt-3" }, now: "2026-01-01T00:00:00.000Z", mutation: { kind: "set_desired_state", key: "container:books", value: "off", provenance: "stated", source: "test", expiresAt: "2026-01-01T00:00:01.000Z" } })
    expect(inspectRoutineActionGrant(agentRoot, { key: "restart", action: "restart", target: "books", expectedPolicyVersion: 3, now: "2026-01-01T00:00:02.000Z" })).toMatchObject({ allowed: true })
  })

  it("persists complete append-only mutation snapshots and rejects stale transitions", () => {
    const agentRoot = root()
    updateStewardPolicy(agentRoot, {
      expectedVersion: 0,
      actor: ari,
      mutation: { kind: "grant_routine_action", key: "unraid.restart:books", action: "unraid.container.restart", targets: ["books"], maxCount: 2, windowMs: 3_600_000, verificationRequired: true, exclusions: [], provenance: "stated" },
    })
    const reserved = consumeRoutineActionGrant(agentRoot, {
      key: "unraid.restart:books",
      action: "unraid.container.restart",
      target: "books",
      expectedPolicyVersion: 1,
      authorizationReceiptId: "relationship-abc",
      authorizationVersion: 7,
      attemptId: "attempt-1",
      expectedBeforeState: "running",
      resolvedTarget: { id: "Docker:abc", name: "books" },
      effect: { operation: "restart", targetId: "Docker:abc" },
      now: "2026-08-29T17:00:00.000Z",
    })
    expect(reserved).toMatchObject({ state: "reserved", attemptId: "attempt-1", expectedBeforeState: "running", resolvedTarget: { id: "Docker:abc", name: "books" }, authorizationReceiptId: "relationship-abc", authorizationVersion: 7, effectReceipt: null, verifiedAfterState: null, recoveryState: { state: "not_needed", compensation: "none" } })
    const attempting = transitionRoutineActionReceipt(agentRoot, { id: reserved.id, expectedState: "reserved", state: "attempting", at: "2026-08-29T17:00:01.000Z" })
    const indeterminate = transitionRoutineActionReceipt(agentRoot, { id: reserved.id, expectedState: "attempting", state: "indeterminate", effectReceipt: "transport-outcome-unknown", recoveryState: { state: "manual_inspection_required", compensation: "none" }, at: "2026-08-29T17:00:02.000Z" })
    expect(attempting.attempt).toBe(1)
    expect(indeterminate).toMatchObject({ state: "indeterminate", effectReceipt: "transport-outcome-unknown", recoveryState: { state: "manual_inspection_required" } })
    expect(() => transitionRoutineActionReceipt(agentRoot, { id: reserved.id, expectedState: "attempting", state: "verified", verifiedAfterState: "running" })).toThrow("state changed")
    expect(readRoutineActionReceipts(agentRoot)).toEqual([indeterminate])
    expect(fs.readFileSync(path.join(agentRoot, "state", "policy", "action-receipts.ndjson"), "utf8").trim().split("\n")).toHaveLength(3)
  })

  it("recovers every crash boundary by inspection and never replays the mutation", async () => {
    const agentRoot = root()
    updateStewardPolicy(agentRoot, {
      expectedVersion: 0,
      actor: ari,
      mutation: { kind: "grant_routine_action", key: "restart", action: "unraid.container.restart", targets: ["before", "during", "after", "recovery"], maxCount: 8, windowMs: 3_600_000, verificationRequired: true, exclusions: [], provenance: "stated" },
    })
    const reserve = (target: string, attemptId: string) => consumeRoutineActionGrant(agentRoot, { key: "restart", action: "unraid.container.restart", target, expectedPolicyVersion: 1, authorizationReceiptId: "relationship-1", authorizationVersion: 7, attemptId, expectedBeforeState: "running", resolvedTarget: { id: `Docker:${target}`, name: target }, effect: { operation: "restart", targetId: `Docker:${target}` } })
    const before = reserve("before", "attempt-before")
    const during = reserve("during", "attempt-during")
    transitionRoutineActionReceipt(agentRoot, { id: during.id, expectedState: "reserved", state: "attempting" })
    const after = reserve("after", "attempt-after")
    transitionRoutineActionReceipt(agentRoot, { id: after.id, expectedState: "reserved", state: "attempting" })
    transitionRoutineActionReceipt(agentRoot, { id: after.id, expectedState: "attempting", state: "effect_acknowledged", effectReceipt: "unraid-ack" })
    const interrupted = reserve("recovery", "attempt-recovery")
    transitionRoutineActionReceipt(agentRoot, { id: interrupted.id, expectedState: "reserved", state: "attempting" })
    transitionRoutineActionReceipt(agentRoot, { id: interrupted.id, expectedState: "attempting", state: "effect_acknowledged", effectReceipt: "unraid-ack" })

    const observeTarget = vi.fn(async ({ name }: { id: string; name: string }) => ({ id: `Docker:${name}`, name, state: "running" }))
    await expect(recoverRoutineActionReceipts(agentRoot, { observeTarget, afterRecoveryClaim: (receipt) => { if (receipt.id === interrupted.id) throw new Error("crash during recovery") } })).rejects.toThrow("crash during recovery")
    const interim = new Map(readRoutineActionReceipts(agentRoot).map((receipt) => [receipt.id, receipt]))
    expect(interim.get(before.id)?.state).toBe("recovered_no_effect")
    expect(interim.get(during.id)?.state).toBe("indeterminate")
    expect(interim.get(after.id)?.state).toBe("verified")
    expect(interim.get(interrupted.id)?.state).toBe("recovery_pending")

    await recoverRoutineActionReceipts(agentRoot, { observeTarget })
    expect(new Map(readRoutineActionReceipts(agentRoot).map((receipt) => [receipt.id, receipt])).get(interrupted.id)).toMatchObject({ state: "verified", verifiedAfterState: "running", recoveryState: { state: "completed", compensation: "none" } })
    expect(observeTarget).toHaveBeenCalledTimes(2)
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
    expect(inspectRoutineActionGrant(malformedRoot, { key: "restart", action: "unraid.container.restart", target: "books" })).toMatchObject({ allowed: false, reason: expect.stringContaining("invalid") })
    vi.spyOn(JSON, "parse").mockImplementationOnce(() => { throw "unavailable" })
    expect(inspectRoutineActionGrant(malformedRoot, { key: "restart", action: "unraid.container.restart", target: "books" })).toEqual({ allowed: false, reason: "routine action policy is unavailable" })

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
    const lease = await acquireSessionTurnLease(path.join(agentRoot, "state", "policy", "steward.json"), { timeoutMs: 10 })
    try {
      expect(() => consumeRoutineActionGrant(agentRoot, { key: "restart", target: "books", expectedPolicyVersion: 1, now: "2026-08-29T16:30:00.000Z" })).toThrow("busy")
    } finally {
      await lease.release()
    }
  })

  it("keeps a mismatched recovery observation indeterminate", async () => {
    const agentRoot = root()
    updateStewardPolicy(agentRoot, { expectedVersion: 0, actor: ari, mutation: { kind: "grant_routine_action", key: "restart", action: "unraid.container.restart", targets: ["books"], maxCount: 2, windowMs: 3_600_000, verificationRequired: true, exclusions: [], provenance: "stated" } })
    const receipt = consumeRoutineActionGrant(agentRoot, { key: "restart", action: "unraid.container.restart", target: "books", expectedPolicyVersion: 1, authorizationReceiptId: "relationship-1", authorizationVersion: 7, attemptId: "attempt", expectedBeforeState: "running", resolvedTarget: { id: "Docker:books", name: "books" }, effect: { operation: "restart", targetId: "Docker:books" } })
    transitionRoutineActionReceipt(agentRoot, { id: receipt.id, expectedState: "reserved", state: "attempting" })
    transitionRoutineActionReceipt(agentRoot, { id: receipt.id, expectedState: "attempting", state: "effect_acknowledged", effectReceipt: "ack" })
    await recoverRoutineActionReceipts(agentRoot, { observeTarget: async () => ({ id: "Docker:other", name: "books", state: "running" }) })
    expect(readRoutineActionReceipts(agentRoot)[0]).toMatchObject({ state: "indeterminate", recoveryState: { state: "manual_inspection_required" } })
  })
})
