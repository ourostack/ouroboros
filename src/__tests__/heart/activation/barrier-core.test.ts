import { describe, expect, it } from "vitest"

import {
  ActivationBarrierError,
  applyBarrierCommand,
  createEmptyBarrierStore,
  deriveActionWindowId,
  deriveBarrierTargetKey,
  deriveRepairEligibilityId,
  parseBarrierStore,
  type ActionWindowV1,
  type BarrierCommandV1,
  type BarrierStoreV1,
  type BarrierV1,
  type DeferredV1,
  type RepairGenerationReconciliationV1,
  type ResourceKey,
} from "../../../heart/activation/barrier-core"

const EPOCH = "epoch-7"
const ACQUIRED_AT = "2026-07-24T12:00:00.000Z"
const RELEASED_AT = "2026-07-24T12:01:00.000Z"
const DEADLINE_AT = "2026-07-24T12:11:00.000Z"

const resourceTarget = { resourceId: "resource-a", incarnationId: "incarnation-a" } as const
const scheduledTarget = { agent: "agent-a", habitId: "habit-a" } as const
const resourceKey: ResourceKey = {
  machineId: "machine-a",
  ownerUid: 501,
  serviceId: "service-a",
  incarnationId: resourceTarget.incarnationId,
}

function empty(): BarrierStoreV1 {
  return createEmptyBarrierStore(EPOCH, ACQUIRED_AT)
}

function acquireResource(
  state: BarrierStoreV1 = empty(),
  overrides: Partial<Extract<BarrierCommandV1, { kind: "barrier.acquire" }>> = {},
) {
  return applyBarrierCommand(state, {
    kind: "barrier.acquire",
    barrierId: "barrier-resource",
    scope: "resource-repair",
    target: resourceTarget,
    holder: "rollout-owner",
    tokenHash: "a".repeat(64),
    releasePolicy: { kind: "one-shot-current", terminalTimeoutMs: 600_000 },
    writerEpoch: EPOCH,
    at: ACQUIRED_AT,
    ...overrides,
  })
}

function acquireSchedule(state: BarrierStoreV1 = empty()) {
  return applyBarrierCommand(state, {
    kind: "barrier.acquire",
    barrierId: "barrier-schedule",
    scope: "scheduled-dispatch",
    target: scheduledTarget,
    holder: "rollout-owner",
    tokenHash: "b".repeat(64),
    releasePolicy: { kind: "continuous" },
    writerEpoch: EPOCH,
    at: ACQUIRED_AT,
  })
}

function deferRepair(state: BarrierStoreV1, eligibility = "eligibility-a", deferredId = "deferred-repair") {
  return applyBarrierCommand(state, {
    kind: "admission.repair",
    deferredId,
    target: resourceTarget,
    observationId: "observation-a",
    repairEligibilityId: eligibility,
    repairGeneration: 1,
    writerEpoch: EPOCH,
    at: "2026-07-24T12:00:30.000Z",
  })
}

function armedWindow(): { state: BarrierStoreV1; window: ActionWindowV1 } {
  const acquired = acquireResource()
  const denied = deferRepair(acquired.store)
  const released = applyBarrierCommand(denied.store, {
    kind: "barrier.release",
    barrierId: "barrier-resource",
    holder: "rollout-owner",
    tokenHash: "a".repeat(64),
    currentDedupeKey: "eligibility-a",
    writerEpoch: "epoch-8",
    at: RELEASED_AT,
  })
  if (released.result.kind !== "released" || released.result.actionWindow === null) {
    throw new Error("fixture did not arm an action window")
  }
  return { state: released.store, window: released.result.actionWindow }
}

function reconciliation(window: ActionWindowV1): RepairGenerationReconciliationV1 {
  return {
    schemaVersion: 1,
    resourceId: window.resourceId,
    resourceKey,
    repairGeneration: window.repairGeneration ?? 1,
    takeoverId: "takeover-a",
    disposition: "rolled_back",
    requestRef: "authority/request.json",
    requestSha256: "1".repeat(64),
    ownerAuthorityRef: "authority/receipt.json",
    ownerAuthoritySha256: "2".repeat(64),
    inspectRef: "authority/inspect.json",
    inspectSha256: "3".repeat(64),
    observedAt: "2026-07-24T12:12:00.000Z",
  }
}

describe("activation barrier schema", () => {
  it("creates the exact empty Section 7 store", () => {
    expect(empty()).toEqual({
      schemaVersion: 1,
      revision: 0,
      lastWriterEpoch: EPOCH,
      barriers: {},
      deferredIntents: {},
      actionWindows: {},
      updatedAt: ACQUIRED_AT,
    })
  })

  it("round-trips a canonical store with exact normative field shapes", () => {
    const acquired = acquireResource()
    const parsed = parseBarrierStore(JSON.parse(JSON.stringify(acquired.store)))

    expect(parsed).toEqual(acquired.store)
    expect(Object.keys(parsed.barriers["barrier-resource"]).sort()).toEqual([
      "acquiredAt", "acquiredEpoch", "barrierId", "holder", "releasePolicy", "releasedAt",
      "releasedEpoch", "scope", "status", "target", "targetKey", "tokenHash",
    ])
  })

  it.each([
    ["unknown top-level field", (value: Record<string, unknown>) => { value.extra = true }],
    ["unsupported schema", (value: Record<string, unknown>) => { value.schemaVersion = 2 }],
    ["negative revision", (value: Record<string, unknown>) => { value.revision = -1 }],
    ["noncanonical time", (value: Record<string, unknown>) => { value.updatedAt = "tomorrow" }],
    ["unsafe map key", (value: Record<string, unknown>) => { value.barriers = { constructor: {} } }],
  ])("rejects %s", (_name, mutate) => {
    const value = JSON.parse(JSON.stringify(empty())) as Record<string, unknown>
    mutate(value)
    expect(() => parseBarrierStore(value)).toThrow(ActivationBarrierError)
  })

  it("rejects mismatched scope, target, target key, policy, and timeout", () => {
    const acquired = acquireResource().store
    const variants = [
      { scope: "scheduled-dispatch" },
      { target: scheduledTarget },
      { targetKey: "forged" },
      { releasePolicy: { kind: "continuous" } },
      { releasePolicy: { kind: "one-shot-current", terminalTimeoutMs: 599_999 } },
    ]

    for (const variant of variants) {
      const value = structuredClone(acquired)
      Object.assign(value.barriers["barrier-resource"], variant)
      expect(() => parseBarrierStore(value)).toThrow(ActivationBarrierError)
    }
  })

  it("rejects barrier tombstones whose release fields disagree with status", () => {
    const value = acquireResource().store
    value.barriers["barrier-resource"].releasedAt = RELEASED_AT
    expect(() => parseBarrierStore(value)).toThrow(ActivationBarrierError)
  })

  it("rejects deferred payload/target mismatches and invalid state timestamps", () => {
    const denied = deferRepair(acquireResource().store).store
    const wrongPayload = structuredClone(denied)
    wrongPayload.deferredIntents["deferred-repair"].payload = {
      scheduleRevision: "revision-a",
      slotKey: "slot-a",
      scheduledAtUtc: ACQUIRED_AT,
    }
    expect(() => parseBarrierStore(wrongPayload)).toThrow(ActivationBarrierError)

    const wrongReady = structuredClone(denied)
    wrongReady.deferredIntents["deferred-repair"].readyAt = RELEASED_AT
    expect(() => parseBarrierStore(wrongReady)).toThrow(ActivationBarrierError)
  })

  it("rejects map-key identity drift, dangling references, and two active windows for one resource", () => {
    const { state, window } = armedWindow()
    const mismatchedMapKey = structuredClone(state)
    mismatchedMapKey.actionWindows.other = mismatchedMapKey.actionWindows[window.actionWindowId]
    delete mismatchedMapKey.actionWindows[window.actionWindowId]
    expect(() => parseBarrierStore(mismatchedMapKey)).toThrow(ActivationBarrierError)

    const dangling = structuredClone(state)
    dangling.actionWindows[window.actionWindowId].deferredId = "missing"
    expect(() => parseBarrierStore(dangling)).toThrow(ActivationBarrierError)

    const duplicate = structuredClone(state)
    const secondBarrierId = "barrier-second"
    const secondDeferredId = "deferred-second"
    const secondEligibilityId = "eligibility-second"
    const secondWindowId = deriveActionWindowId(secondBarrierId, secondDeferredId, secondEligibilityId)
    duplicate.barriers[secondBarrierId] = {
      ...structuredClone(duplicate.barriers[window.barrierId]),
      barrierId: secondBarrierId,
      tokenHash: "e".repeat(64),
    }
    duplicate.deferredIntents[secondDeferredId] = {
      ...structuredClone(duplicate.deferredIntents[window.deferredId]),
      deferredId: secondDeferredId,
      dedupeKey: secondEligibilityId,
      payload: { observationId: "observation-second", repairEligibilityId: secondEligibilityId },
      blockedBy: [secondBarrierId],
    }
    duplicate.actionWindows[secondWindowId] = {
      ...window,
      actionWindowId: secondWindowId,
      barrierId: secondBarrierId,
      deferredId: secondDeferredId,
      repairEligibilityId: secondEligibilityId,
    }
    expect(() => parseBarrierStore(duplicate)).toThrow(/active window|corrupt/i)
  })
})

describe("activation barrier derivations", () => {
  it("derives collision-resistant keys for each exact target kind", () => {
    expect(deriveBarrierTargetKey("resource-repair", resourceTarget)).toMatch(/^resource-repair:sha256:[a-f0-9]{64}$/)
    expect(deriveBarrierTargetKey("scheduled-dispatch", scheduledTarget)).toMatch(/^scheduled-dispatch:sha256:[a-f0-9]{64}$/)
    expect(deriveBarrierTargetKey("resource-repair", resourceTarget)).not.toBe(
      deriveBarrierTargetKey("scheduled-dispatch", scheduledTarget),
    )
  })

  it("derives repair eligibility from the exact resource key and qualifying sequence set", () => {
    const first = deriveRepairEligibilityId(resourceKey, [11, 12, 13])
    expect(first).toMatch(/^[a-f0-9]{64}$/)
    expect(deriveRepairEligibilityId(resourceKey, [11, 12, 13])).toBe(first)
    expect(deriveRepairEligibilityId(resourceKey, [11, 12, 14])).not.toBe(first)
    expect(() => deriveRepairEligibilityId(resourceKey, [11, 11, 12])).toThrow(ActivationBarrierError)
  })

  it("derives the normative action-window id from only barrier, deferred, and eligibility identity", () => {
    const id = deriveActionWindowId("barrier-a", "deferred-a", "eligibility-a")
    expect(id).toMatch(/^aw_[A-Za-z0-9_-]{43}$/)
    expect(deriveActionWindowId("barrier-a", "deferred-a", "eligibility-a")).toBe(id)
    expect(deriveActionWindowId("barrier-a", "deferred-b", "eligibility-a")).not.toBe(id)
  })
})

describe("barrier admission and release reducer", () => {
  it("acquires a held barrier and rejects conflicting identity or idempotency drift", () => {
    const first = acquireResource()
    expect(first.result).toMatchObject({ kind: "acquired", replayed: false })
    expect(first.store.revision).toBe(1)

    const replay = acquireResource(first.store)
    expect(replay.result).toMatchObject({ kind: "acquired", replayed: true })
    expect(replay.store).toEqual(first.store)

    expect(() => acquireResource(first.store, { tokenHash: "c".repeat(64) })).toThrow(/conflict/i)
  })

  it("blocks schedule admission before claim and deduplicates the exact slot", () => {
    const held = acquireSchedule().store
    const command: BarrierCommandV1 = {
      kind: "admission.scheduled",
      deferredId: "deferred-slot",
      target: scheduledTarget,
      scheduleRevision: "revision-a",
      slotKey: "slot-a",
      scheduledAtUtc: "2026-07-24T13:00:00.000Z",
      writerEpoch: EPOCH,
      at: "2026-07-24T12:00:20.000Z",
    }
    const denied = applyBarrierCommand(held, command)
    expect(denied.result).toMatchObject({ kind: "deferred", deferredId: "deferred-slot" })
    expect(denied.store.deferredIntents["deferred-slot"].blockedBy).toEqual(["barrier-schedule"])

    const replay = applyBarrierCommand(denied.store, { ...command, at: "2026-07-24T12:00:40.000Z" })
    expect(Object.keys(replay.store.deferredIntents)).toEqual(["deferred-slot"])
    expect(replay.store.deferredIntents["deferred-slot"].firstDeniedAt).toBe("2026-07-24T12:00:20.000Z")
    expect(replay.store.deferredIntents["deferred-slot"].lastDeniedAt).toBe("2026-07-24T12:00:40.000Z")
  })

  it("blocks repair only at attempt admission while preserving observation and eligibility identity", () => {
    const denied = deferRepair(acquireResource().store)
    expect(denied.result).toMatchObject({ kind: "deferred", deferredId: "deferred-repair" })
    expect(denied.store.deferredIntents["deferred-repair"]).toMatchObject({
      kind: "resource-repair",
      payload: { observationId: "observation-a", repairEligibilityId: "eligibility-a" },
      state: "pending",
    })
  })

  it("admits unrelated targets without mutating claims, samples, or budgets", () => {
    const held = acquireResource().store
    const before = structuredClone(held)
    const admitted = applyBarrierCommand(held, {
      kind: "admission.repair",
      deferredId: "unrelated-deferred",
      target: { resourceId: "resource-b", incarnationId: "incarnation-b" },
      observationId: "observation-b",
      repairEligibilityId: "eligibility-b",
      repairGeneration: 9,
      writerEpoch: EPOCH,
      at: RELEASED_AT,
    })

    expect(admitted.result).toEqual({ kind: "admitted", actionWindow: null })
    expect(admitted.store).toEqual(before)
  })

  it("continuously releases, tombstones, readies the exact current intent, and discards stale work", () => {
    let state = acquireSchedule().store
    for (const [id, revision, slot] of [
      ["deferred-old", "revision-a", "slot-old"],
      ["deferred-current", "revision-b", "slot-current"],
    ] as const) {
      state = applyBarrierCommand(state, {
        kind: "admission.scheduled",
        deferredId: id,
        target: scheduledTarget,
        scheduleRevision: revision,
        slotKey: slot,
        scheduledAtUtc: "2026-07-24T13:00:00.000Z",
        writerEpoch: EPOCH,
        at: ACQUIRED_AT,
      }).store
    }

    const released = applyBarrierCommand(state, {
      kind: "barrier.release",
      barrierId: "barrier-schedule",
      holder: "rollout-owner",
      tokenHash: "b".repeat(64),
      currentDedupeKey: "slot-current",
      writerEpoch: "epoch-8",
      at: RELEASED_AT,
    })

    expect(released.store.barriers["barrier-schedule"]).toMatchObject({
      status: "released",
      releasedEpoch: "epoch-8",
      releasedAt: RELEASED_AT,
    })
    expect(released.store.deferredIntents["deferred-current"]).toMatchObject({ state: "ready", readyAt: RELEASED_AT })
    expect(released.store.deferredIntents["deferred-old"]).toMatchObject({ state: "discarded", settledAt: RELEASED_AT })
    expect(released.result).toMatchObject({ kind: "released", actionWindow: null })
  })

  it.each([
    ["wrong holder", { holder: "other" }],
    ["wrong token", { tokenHash: "f".repeat(64) }],
  ])("rejects release with %s", (_name, override) => {
    const state = deferRepair(acquireResource().store).store
    expect(() => applyBarrierCommand(state, {
      kind: "barrier.release",
      barrierId: "barrier-resource",
      holder: "rollout-owner",
      tokenHash: "a".repeat(64),
      currentDedupeKey: "eligibility-a",
      writerEpoch: "epoch-8",
      at: RELEASED_AT,
      ...override,
    })).toThrow(ActivationBarrierError)
  })

  it("rejects zero, stale, or multiple current one-shot deferred candidates without releasing", () => {
    const acquired = acquireResource().store
    expect(() => applyBarrierCommand(acquired, {
      kind: "barrier.release",
      barrierId: "barrier-resource",
      holder: "rollout-owner",
      tokenHash: "a".repeat(64),
      currentDedupeKey: "missing",
      writerEpoch: "epoch-8",
      at: RELEASED_AT,
    })).toThrow(/exactly one current deferred/i)

    const duplicated = deferRepair(acquired, "eligibility-a", "deferred-a").store
    duplicated.deferredIntents["deferred-b"] = {
      ...structuredClone(duplicated.deferredIntents["deferred-a"]),
      deferredId: "deferred-b",
    }
    expect(() => applyBarrierCommand(duplicated, {
      kind: "barrier.release",
      barrierId: "barrier-resource",
      holder: "rollout-owner",
      tokenHash: "a".repeat(64),
      currentDedupeKey: "eligibility-a",
      writerEpoch: "epoch-8",
      at: RELEASED_AT,
    })).toThrow(/exactly one current deferred/i)
    expect(duplicated.barriers["barrier-resource"].status).toBe("held")
  })

  it("replays an identical release but rejects a drifted release after tombstoning", () => {
    const denied = deferRepair(acquireResource().store).store
    const command: BarrierCommandV1 = {
      kind: "barrier.release",
      barrierId: "barrier-resource",
      holder: "rollout-owner",
      tokenHash: "a".repeat(64),
      currentDedupeKey: "eligibility-a",
      writerEpoch: "epoch-8",
      at: RELEASED_AT,
    }
    const released = applyBarrierCommand(denied, command)
    expect(applyBarrierCommand(released.store, command).store).toEqual(released.store)
    expect(() => applyBarrierCommand(released.store, { ...command, writerEpoch: "epoch-9" })).toThrow(/released|replay/i)
  })

  it("atomically arms exactly one deterministic one-shot action window", () => {
    const { state, window } = armedWindow()
    expect(window).toEqual({
      schemaVersion: 1,
      actionWindowId: deriveActionWindowId("barrier-resource", "deferred-repair", "eligibility-a"),
      barrierId: "barrier-resource",
      resourceId: resourceTarget.resourceId,
      incarnationId: resourceTarget.incarnationId,
      deferredId: "deferred-repair",
      repairEligibilityId: "eligibility-a",
      state: "armed",
      repairGeneration: null,
      releasedAt: RELEASED_AT,
      terminalDeadlineAt: DEADLINE_AT,
      consumedAt: null,
      terminalAt: null,
      terminalRef: null,
      terminalSha256: null,
      supersededBy: null,
    })
    expect(state.barriers["barrier-resource"].status).toBe("released")
  })
})

describe("one-shot action window reducer", () => {
  it("consumes one generation before admission and idempotently replays only that generation", () => {
    const { state, window } = armedWindow()
    const command: BarrierCommandV1 = {
      kind: "admission.repair",
      deferredId: "later-deferred",
      target: resourceTarget,
      observationId: "observation-a",
      repairEligibilityId: "eligibility-a",
      repairGeneration: 41,
      writerEpoch: "epoch-9",
      at: "2026-07-24T12:02:00.000Z",
    }
    const consumed = applyBarrierCommand(state, command)
    expect(consumed.result).toMatchObject({ kind: "admitted", actionWindow: { state: "consumed", repairGeneration: 41 } })
    expect(consumed.store.actionWindows[window.actionWindowId].state).toBe("consumed")

    const replay = applyBarrierCommand(consumed.store, command)
    expect(replay.store).toEqual(consumed.store)
    expect(() => applyBarrierCommand(consumed.store, { ...command, repairGeneration: 42 })).toThrow(/generation|blocked/i)
  })

  it("marks matching success terminal and permits later continuous repair admission", () => {
    const { state, window } = armedWindow()
    const consumed = applyBarrierCommand(state, {
      kind: "admission.repair",
      deferredId: "unused",
      target: resourceTarget,
      observationId: "observation-a",
      repairEligibilityId: "eligibility-a",
      repairGeneration: 3,
      writerEpoch: "epoch-9",
      at: "2026-07-24T12:02:00.000Z",
    })
    const succeeded = applyBarrierCommand(consumed.store, {
      kind: "action-window.succeed",
      actionWindowId: window.actionWindowId,
      repairGeneration: 3,
      terminalRef: "authority/success.json",
      terminalSha256: "4".repeat(64),
      writerEpoch: "epoch-10",
      at: "2026-07-24T12:05:00.000Z",
    })
    expect(succeeded.store.actionWindows[window.actionWindowId]).toMatchObject({
      state: "succeeded",
      terminalAt: "2026-07-24T12:05:00.000Z",
    })

    const later = applyBarrierCommand(succeeded.store, {
      kind: "admission.repair",
      deferredId: "deferred-later",
      target: resourceTarget,
      observationId: "observation-later",
      repairEligibilityId: "eligibility-later",
      repairGeneration: 4,
      writerEpoch: "epoch-11",
      at: "2026-07-24T12:06:00.000Z",
    })
    expect(later.result).toEqual({ kind: "admitted", actionWindow: null })
  })

  it.each(["failed_terminal", "outcome_unknown"] as const)("blocks on %s and permanently fences generation two", (disposition) => {
    const { state, window } = armedWindow()
    const consumed = applyBarrierCommand(state, {
      kind: "admission.repair",
      deferredId: "unused",
      target: resourceTarget,
      observationId: "observation-a",
      repairEligibilityId: "eligibility-a",
      repairGeneration: 7,
      writerEpoch: "epoch-9",
      at: "2026-07-24T12:02:00.000Z",
    })
    const blocked = applyBarrierCommand(consumed.store, {
      kind: "action-window.block",
      actionWindowId: window.actionWindowId,
      repairGeneration: 7,
      disposition,
      terminalRef: "authority/terminal.json",
      terminalSha256: "5".repeat(64),
      writerEpoch: "epoch-10",
      at: "2026-07-24T12:05:00.000Z",
    })
    expect(blocked.store.actionWindows[window.actionWindowId].state).toBe("blocked")
    expect(() => applyBarrierCommand(blocked.store, {
      kind: "admission.repair",
      deferredId: "deferred-generation-two",
      target: resourceTarget,
      observationId: "observation-b",
      repairEligibilityId: "eligibility-b",
      repairGeneration: 8,
      writerEpoch: "epoch-11",
      at: "2026-07-24T12:06:00.000Z",
    })).toThrow(/blocked|reconciliation/i)
  })

  it("blocks on deadline, rejects early expiry, and accepts late success for the same generation", () => {
    const { state, window } = armedWindow()
    const consumed = applyBarrierCommand(state, {
      kind: "admission.repair",
      deferredId: "unused",
      target: resourceTarget,
      observationId: "observation-a",
      repairEligibilityId: "eligibility-a",
      repairGeneration: 2,
      writerEpoch: "epoch-9",
      at: "2026-07-24T12:02:00.000Z",
    })
    expect(() => applyBarrierCommand(consumed.store, {
      kind: "action-window.expire",
      actionWindowId: window.actionWindowId,
      writerEpoch: "epoch-10",
      at: "2026-07-24T12:10:59.999Z",
    })).toThrow(/deadline/i)

    const expired = applyBarrierCommand(consumed.store, {
      kind: "action-window.expire",
      actionWindowId: window.actionWindowId,
      writerEpoch: "epoch-10",
      at: DEADLINE_AT,
    })
    expect(expired.store.actionWindows[window.actionWindowId].state).toBe("blocked")

    const late = applyBarrierCommand(expired.store, {
      kind: "action-window.succeed",
      actionWindowId: window.actionWindowId,
      repairGeneration: 2,
      terminalRef: "authority/late-success.json",
      terminalSha256: "6".repeat(64),
      writerEpoch: "epoch-11",
      at: "2026-07-24T12:12:00.000Z",
    })
    expect(late.store.actionWindows[window.actionWindowId].state).toBe("succeeded")
  })

  it("rearms only a blocked generation with matching verified authority and current eligibility", () => {
    const { state, window } = armedWindow()
    const consumed = applyBarrierCommand(state, {
      kind: "admission.repair",
      deferredId: "unused",
      target: resourceTarget,
      observationId: "observation-a",
      repairEligibilityId: "eligibility-a",
      repairGeneration: 1,
      writerEpoch: "epoch-9",
      at: "2026-07-24T12:02:00.000Z",
    })
    let blocked = applyBarrierCommand(consumed.store, {
      kind: "action-window.block",
      actionWindowId: window.actionWindowId,
      repairGeneration: 1,
      disposition: "failed_terminal",
      terminalRef: "authority/failure.json",
      terminalSha256: "7".repeat(64),
      writerEpoch: "epoch-10",
      at: "2026-07-24T12:05:00.000Z",
    }).store
    blocked = acquireResource(blocked, {
      barrierId: "barrier-rearm",
      tokenHash: "8".repeat(64),
      at: "2026-07-24T12:11:00.000Z",
      writerEpoch: "epoch-11",
    }).store
    blocked = deferRepair(blocked, "eligibility-b", "deferred-rearm").store

    const rearmed = applyBarrierCommand(blocked, {
      kind: "barrier.rearm",
      barrierId: "barrier-rearm",
      holder: "rollout-owner",
      tokenHash: "8".repeat(64),
      blockedActionWindowId: window.actionWindowId,
      currentDedupeKey: "eligibility-b",
      reconciliation: reconciliation(window),
      remainingBudget: 1,
      cooldownUntil: null,
      writerEpoch: "epoch-12",
      at: "2026-07-24T12:12:00.000Z",
    })
    const nextId = deriveActionWindowId("barrier-rearm", "deferred-rearm", "eligibility-b")
    expect(rearmed.store.actionWindows[window.actionWindowId]).toMatchObject({ state: "superseded", supersededBy: nextId })
    expect(rearmed.store.actionWindows[nextId]).toMatchObject({ state: "armed", repairGeneration: null })
    expect(rearmed.store.barriers["barrier-rearm"].status).toBe("released")
  })

  it.each([
    ["unknown disposition", (proof: RepairGenerationReconciliationV1) => ({ ...proof, disposition: "outcome_unknown" })],
    ["wrong resource", (proof: RepairGenerationReconciliationV1) => ({ ...proof, resourceId: "resource-other" })],
    ["wrong generation", (proof: RepairGenerationReconciliationV1) => ({ ...proof, repairGeneration: 99 })],
    ["missing authority hash", (proof: RepairGenerationReconciliationV1) => ({ ...proof, ownerAuthoritySha256: "" })],
  ])("rejects rearm with %s", (_name, mutateProof) => {
    const { state, window } = armedWindow()
    const consumed = applyBarrierCommand(state, {
      kind: "admission.repair",
      deferredId: "unused",
      target: resourceTarget,
      observationId: "observation-a",
      repairEligibilityId: "eligibility-a",
      repairGeneration: 1,
      writerEpoch: "epoch-9",
      at: "2026-07-24T12:02:00.000Z",
    })
    let blocked = applyBarrierCommand(consumed.store, {
      kind: "action-window.block",
      actionWindowId: window.actionWindowId,
      repairGeneration: 1,
      disposition: "failed_terminal",
      terminalRef: "authority/failure.json",
      terminalSha256: "7".repeat(64),
      writerEpoch: "epoch-10",
      at: "2026-07-24T12:05:00.000Z",
    }).store
    blocked = acquireResource(blocked, {
      barrierId: "barrier-rearm",
      tokenHash: "8".repeat(64),
      at: "2026-07-24T12:11:00.000Z",
      writerEpoch: "epoch-11",
    }).store
    blocked = deferRepair(blocked, "eligibility-b", "deferred-rearm").store

    expect(() => applyBarrierCommand(blocked, {
      kind: "barrier.rearm",
      barrierId: "barrier-rearm",
      holder: "rollout-owner",
      tokenHash: "8".repeat(64),
      blockedActionWindowId: window.actionWindowId,
      currentDedupeKey: "eligibility-b",
      reconciliation: mutateProof(reconciliation({ ...window, repairGeneration: 1 })) as RepairGenerationReconciliationV1,
      remainingBudget: 1,
      cooldownUntil: null,
      writerEpoch: "epoch-12",
      at: "2026-07-24T12:12:00.000Z",
    })).toThrow(ActivationBarrierError)
  })

  it("rejects concurrent rearm CAS, exhausted budget, cooldown, armed replacement, and inferred no-effect", () => {
    const { state, window } = armedWindow()
    expect(() => applyBarrierCommand(state, {
      kind: "barrier.rearm",
      barrierId: "barrier-resource",
      holder: "rollout-owner",
      tokenHash: "a".repeat(64),
      blockedActionWindowId: window.actionWindowId,
      currentDedupeKey: "eligibility-a",
      reconciliation: reconciliation(window),
      remainingBudget: 0,
      cooldownUntil: "2026-07-24T12:20:00.000Z",
      writerEpoch: "epoch-9",
      at: "2026-07-24T12:12:00.000Z",
    })).toThrow(ActivationBarrierError)
  })
})

describe("genericity", () => {
  it("keeps personal workflow and service concepts out of the core fixtures", () => {
    const source = JSON.stringify({ resourceTarget, scheduledTarget, resourceKey })
    expect(source).not.toMatch(/bluebubbles|imessage|aisleplanner|rsvp|slugger|clawdbot|port/i)
  })
})
