import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { afterEach, describe, expect, it, vi } from "vitest"

import {
  ActivationBarrierError,
  ActivationBarrierStore,
  applyBarrierCommand,
  createEmptyBarrierStore,
  deriveActionWindowId,
  deriveBarrierTargetKey,
  deriveRepairEligibilityId,
  parseBarrierStore,
  type ActionWindowV1,
  type BarrierCommandV1,
  type BarrierStoreV1,
  type RepairGenerationReconciliationV1,
  type ResourceKey,
} from "../../../heart/activation/barrier-core"
import type { ExactProcessState, ProcessIdentity } from "../../../heart/runtime/process-identity"

const T0 = "2026-07-24T12:00:00.000Z"
const T1 = "2026-07-24T12:01:00.000Z"
const T2 = "2026-07-24T12:02:00.000Z"
const T3 = "2026-07-24T12:03:00.000Z"
const resource = { resourceId: "resource-a", incarnationId: "incarnation-a" } as const
const schedule = { agent: "agent-a", habitId: "habit-a" } as const
const key: ResourceKey = { machineId: "machine-a", ownerUid: 501, serviceId: "service-a", incarnationId: "incarnation-a" }
const owner: ProcessIdentity = { uid: 501, pid: 9090, startIdentity: "darwin-proc:1770000000:000001", bootId: "boot-a" }
const roots: string[] = []

function empty(): BarrierStoreV1 {
  return createEmptyBarrierStore("epoch-1", T0)
}

function resourceBarrier(
  state = empty(),
  overrides: Partial<Extract<BarrierCommandV1, { kind: "barrier.acquire" }>> = {},
) {
  return applyBarrierCommand(state, {
    kind: "barrier.acquire",
    barrierId: "barrier-a",
    scope: "resource-repair",
    target: resource,
    holder: "holder-a",
    tokenHash: "a".repeat(64),
    releasePolicy: { kind: "one-shot-current", terminalTimeoutMs: 600_000 },
    writerEpoch: "epoch-1",
    at: T0,
    ...overrides,
  })
}

function scheduleBarrier(
  state = empty(),
  overrides: Partial<Extract<BarrierCommandV1, { kind: "barrier.acquire" }>> = {},
) {
  return applyBarrierCommand(state, {
    kind: "barrier.acquire",
    barrierId: "schedule-a",
    scope: "scheduled-dispatch",
    target: schedule,
    holder: "holder-a",
    tokenHash: "b".repeat(64),
    releasePolicy: { kind: "continuous" },
    writerEpoch: "epoch-1",
    at: T0,
    ...overrides,
  })
}

function deniedRepair(state = resourceBarrier().store, overrides: Partial<Extract<BarrierCommandV1, { kind: "admission.repair" }>> = {}) {
  return applyBarrierCommand(state, {
    kind: "admission.repair",
    deferredId: "deferred-a",
    target: resource,
    observationId: "observation-a",
    repairEligibilityId: "eligibility-a",
    repairGeneration: 1,
    writerEpoch: "epoch-1",
    at: T1,
    ...overrides,
  })
}

function armed(): { store: BarrierStoreV1; window: ActionWindowV1 } {
  const released = applyBarrierCommand(deniedRepair().store, {
    kind: "barrier.release",
    barrierId: "barrier-a",
    holder: "holder-a",
    tokenHash: "a".repeat(64),
    currentDedupeKey: "eligibility-a",
    writerEpoch: "epoch-2",
    at: T2,
  })
  if (released.result.kind !== "released" || released.result.actionWindow === null) throw new Error("fixture failed")
  return { store: released.store, window: released.result.actionWindow }
}

function consumed(): { store: BarrierStoreV1; window: ActionWindowV1 } {
  const fixture = armed()
  const result = applyBarrierCommand(fixture.store, {
    kind: "admission.repair",
    deferredId: "ignored",
    target: resource,
    observationId: "observation-a",
    repairEligibilityId: "eligibility-a",
    repairGeneration: 1,
    writerEpoch: "epoch-3",
    at: T3,
  })
  return { store: result.store, window: result.store.actionWindows[fixture.window.actionWindowId] }
}

function blocked(): { store: BarrierStoreV1; window: ActionWindowV1 } {
  const fixture = consumed()
  const result = applyBarrierCommand(fixture.store, {
    kind: "action-window.block",
    actionWindowId: fixture.window.actionWindowId,
    repairGeneration: 1,
    disposition: "outcome_unknown",
    terminalRef: "authority/unknown.json",
    terminalSha256: "c".repeat(64),
    writerEpoch: "epoch-4",
    at: "2026-07-24T12:04:00.000Z",
  })
  return { store: result.store, window: result.store.actionWindows[fixture.window.actionWindowId] }
}

function mutateStore(state: BarrierStoreV1, mutation: (value: BarrierStoreV1) => void): BarrierStoreV1 {
  const value = structuredClone(state)
  mutation(value)
  return value
}

function expectCorrupt(state: BarrierStoreV1, mutation: (value: BarrierStoreV1) => void): void {
  expect(() => parseBarrierStore(mutateStore(state, mutation))).toThrow(ActivationBarrierError)
}

function proof(window: ActionWindowV1, overrides: Partial<RepairGenerationReconciliationV1> = {}): RepairGenerationReconciliationV1 {
  return {
    schemaVersion: 1,
    resourceId: window.resourceId,
    resourceKey: key,
    repairGeneration: window.repairGeneration ?? 1,
    takeoverId: "takeover-a",
    disposition: "committed",
    requestRef: "authority/request.json",
    requestSha256: "1".repeat(64),
    ownerAuthorityRef: "authority/receipt.json",
    ownerAuthoritySha256: "2".repeat(64),
    inspectRef: "authority/inspect.json",
    inspectSha256: "3".repeat(64),
    observedAt: "2026-07-24T12:07:00.000Z",
    ...overrides,
  }
}

function rearmReady(): { store: BarrierStoreV1; window: ActionWindowV1 } {
  const prior = blocked()
  let state = resourceBarrier(prior.store, {
    barrierId: "barrier-b",
    tokenHash: "d".repeat(64),
    writerEpoch: "epoch-5",
    at: "2026-07-24T12:05:00.000Z",
  }).store
  state = deniedRepair(state, {
    deferredId: "deferred-b",
    observationId: "observation-b",
    repairEligibilityId: "eligibility-b",
    repairGeneration: 2,
    writerEpoch: "epoch-5",
    at: "2026-07-24T12:06:00.000Z",
  }).store
  return { store: state, window: prior.window }
}

function rearmCommand(window: ActionWindowV1, overrides: Partial<Extract<BarrierCommandV1, { kind: "barrier.rearm" }>> = {}): Extract<BarrierCommandV1, { kind: "barrier.rearm" }> {
  return {
    kind: "barrier.rearm",
    barrierId: "barrier-b",
    holder: "holder-a",
    tokenHash: "d".repeat(64),
    blockedActionWindowId: window.actionWindowId,
    currentDedupeKey: "eligibility-b",
    reconciliation: proof(window),
    remainingBudget: 1,
    cooldownUntil: null,
    writerEpoch: "epoch-6",
    at: "2026-07-24T12:08:00.000Z",
    ...overrides,
  }
}

afterEach(() => {
  vi.restoreAllMocks()
  while (roots.length > 0) fs.rmSync(roots.pop()!, { recursive: true, force: true })
})

describe("activation schema adversarial matrix", () => {
  it("rejects non-records, empty identifiers, unsafe integers, empty probe sets, zero generations, and malformed hashes", () => {
    expect(() => parseBarrierStore(null)).toThrow(/object/i)
    expect(() => createEmptyBarrierStore("", T0)).toThrow(/non-empty/i)
    expect(() => createEmptyBarrierStore("epoch", "2026-07-24")).toThrow(/ISO/i)
    expect(() => deriveRepairEligibilityId(key, [])).toThrow(/non-empty/i)
    expect(() => deriveRepairEligibilityId({ ...key, ownerUid: -1 }, [1])).toThrow(/non-negative/i)
    expect(() => deniedRepair(empty(), { repairGeneration: 0 })).toThrow(/positive/i)
    expect(() => resourceBarrier(empty(), { tokenHash: "not-a-hash" })).toThrow(/SHA-256/i)
  })

  it("rejects every barrier identity/status/policy corruption branch", () => {
    const resourceState = resourceBarrier().store
    const scheduleState = scheduleBarrier().store
    const resourceMutations: Array<(value: BarrierStoreV1) => void> = [
      (value) => { value.barriers["barrier-a"].barrierId = "other" },
      (value) => { (value.barriers["barrier-a"] as { scope: string }).scope = "invalid" },
      (value) => { value.barriers["barrier-a"].target = { agent: "a", habitId: "h" } },
      (value) => { value.barriers["barrier-a"].targetKey = "wrong" },
      (value) => { (value.barriers["barrier-a"] as { status: string }).status = "invalid" },
      (value) => { value.barriers["barrier-a"].releasedEpoch = "epoch" },
      (value) => { (value.barriers["barrier-a"].releasePolicy as { terminalTimeoutMs: number }).terminalTimeoutMs = 1 },
    ]
    for (const mutation of resourceMutations) expectCorrupt(resourceState, mutation)
    expectCorrupt(scheduleState, (value) => {
      value.barriers["schedule-a"].releasePolicy = { kind: "one-shot-current", terminalTimeoutMs: 600_000 }
    })
    expectCorrupt(scheduleState, (value) => {
      value.barriers["schedule-a"].releasePolicy = { kind: "invalid" } as never
    })
  })

  it("rejects every deferred identity, blocker, state, and timestamp corruption branch", () => {
    const pending = deniedRepair().store
    const mutations: Array<(value: BarrierStoreV1) => void> = [
      (value) => { value.deferredIntents["deferred-a"].deferredId = "other" },
      (value) => { (value.deferredIntents["deferred-a"] as { kind: string }).kind = "invalid" },
      (value) => { value.deferredIntents["deferred-a"].targetKey = "wrong" },
      (value) => { value.deferredIntents["deferred-a"].payload = null as never },
      (value) => { value.deferredIntents["deferred-a"].dedupeKey = "wrong" },
      (value) => { value.deferredIntents["deferred-a"].blockedBy = null as never },
      (value) => { value.deferredIntents["deferred-a"].blockedBy = ["barrier-a", "barrier-a"] },
      (value) => { (value.deferredIntents["deferred-a"] as { state: string }).state = "invalid" },
      (value) => { value.deferredIntents["deferred-a"].readyAt = T2 },
      (value) => { value.deferredIntents["deferred-a"].blockedBy = ["missing"] },
    ]
    for (const mutation of mutations) expectCorrupt(pending, mutation)

    const ready = armed().store
    expectCorrupt(ready, (value) => { value.deferredIntents["deferred-a"].readyAt = null })

    const settled = mutateStore(ready, (value) => {
      Object.assign(value.deferredIntents["deferred-a"], { state: "settled", settledAt: T3, deliveryRef: "delivery-a" })
    })
    expect(parseBarrierStore(settled).deferredIntents["deferred-a"].state).toBe("settled")
    expectCorrupt(settled, (value) => { value.deferredIntents["deferred-a"].deliveryRef = null })

    const discarded = mutateStore(pending, (value) => {
      Object.assign(value.deferredIntents["deferred-a"], { state: "discarded", settledAt: T3 })
    })
    expect(parseBarrierStore(discarded).deferredIntents["deferred-a"].state).toBe("discarded")
    expectCorrupt(discarded, (value) => { value.deferredIntents["deferred-a"].deliveryRef = "unexpected" })
  })

  it("rejects action-window identity, state-nullability, and reference corruption branches", () => {
    const armedState = armed().store
    const windowId = Object.keys(armedState.actionWindows)[0]
    const mutations: Array<(value: BarrierStoreV1) => void> = [
      (value) => { value.actionWindows[windowId].schemaVersion = 2 as 1 },
      (value) => { (value.actionWindows[windowId] as { state: string }).state = "invalid" },
      (value) => { value.actionWindows[windowId].repairGeneration = 1 },
      (value) => { value.actionWindows[windowId].consumedAt = T3 },
      (value) => { value.actionWindows[windowId].terminalAt = T3 },
      (value) => { value.actionWindows[windowId].terminalRef = "authority/ref" },
      (value) => { value.actionWindows[windowId].terminalSha256 = "4".repeat(64) },
      (value) => { value.actionWindows[windowId].supersededBy = "other" },
      (value) => { delete value.barriers[value.actionWindows[windowId].barrierId] },
      (value) => { value.barriers[value.actionWindows[windowId].barrierId].status = "held"; value.barriers[value.actionWindows[windowId].barrierId].releasedAt = null; value.barriers[value.actionWindows[windowId].barrierId].releasedEpoch = null },
      (value) => { delete value.deferredIntents[value.actionWindows[windowId].deferredId] },
      (value) => { value.actionWindows[windowId].repairEligibilityId = "other" },
    ]
    for (const mutation of mutations) expectCorrupt(armedState, mutation)

    const consumedState = consumed().store
    expectCorrupt(consumedState, (value) => { value.actionWindows[windowId].repairGeneration = null })
    expectCorrupt(consumedState, (value) => { value.actionWindows[windowId].consumedAt = null })
    expectCorrupt(consumedState, (value) => { value.actionWindows[windowId].terminalRef = "unexpected" })

    const blockedState = blocked().store
    expectCorrupt(blockedState, (value) => { value.actionWindows[windowId].terminalAt = null })
    expectCorrupt(blockedState, (value) => { value.actionWindows[windowId].supersededBy = "unexpected" })
    expectCorrupt(blockedState, (value) => { value.actionWindows[windowId].terminalSha256 = null })

    const success = applyBarrierCommand(consumedState, {
      kind: "action-window.succeed", actionWindowId: windowId, repairGeneration: 1,
      terminalRef: "authority/success.json", terminalSha256: "5".repeat(64), writerEpoch: "epoch-4", at: T3,
    }).store
    expectCorrupt(success, (value) => { value.actionWindows[windowId].terminalRef = null })

    const superseded = rearmReady()
    const rearmed = applyBarrierCommand(superseded.store, rearmCommand(superseded.window)).store
    expectCorrupt(rearmed, (value) => { value.actionWindows[superseded.window.actionWindowId].supersededBy = null })
  })

  it("rejects mismatched deferred/barrier cross-references for both scope and target", () => {
    const pending = deniedRepair().store
    expectCorrupt(pending, (value) => {
      value.deferredIntents["deferred-a"].blockedBy = ["schedule-a"]
      value.barriers["schedule-a"] = scheduleBarrier().store.barriers["schedule-a"]
    })
    expectCorrupt(pending, (value) => {
      value.barriers["barrier-a"].target = { resourceId: "other", incarnationId: "incarnation-a" }
      value.barriers["barrier-a"].targetKey = deriveBarrierTargetKey("resource-repair", value.barriers["barrier-a"].target)
    })
  })
})

describe("activation transition and replay matrix", () => {
  it("sorts multiple matching blockers and rejects dedupe-payload or deferred-id conflicts", () => {
    let state = scheduleBarrier().store
    state = scheduleBarrier(state, { barrierId: "schedule-b", tokenHash: "c".repeat(64) }).store
    const denied = applyBarrierCommand(state, {
      kind: "admission.scheduled", deferredId: "deferred-slot", target: schedule,
      scheduleRevision: "revision-a", slotKey: "slot-a", scheduledAtUtc: T2, writerEpoch: "epoch-2", at: T1,
    })
    expect(denied.store.deferredIntents["deferred-slot"].blockedBy).toEqual(["schedule-a", "schedule-b"])
    expect(() => applyBarrierCommand(denied.store, {
      kind: "admission.scheduled", deferredId: "different", target: schedule,
      scheduleRevision: "revision-b", slotKey: "slot-a", scheduledAtUtc: T2, writerEpoch: "epoch-2", at: T2,
    })).toThrow(/dedupe identity/i)

    let conflict = scheduleBarrier().store
    conflict = applyBarrierCommand(conflict, {
      kind: "admission.scheduled", deferredId: "shared", target: schedule,
      scheduleRevision: "revision-a", slotKey: "slot-a", scheduledAtUtc: T2, writerEpoch: "epoch-2", at: T1,
    }).store
    conflict = scheduleBarrier(conflict, {
      barrierId: "schedule-other", target: { agent: "agent-b", habitId: "habit-b" }, tokenHash: "d".repeat(64),
    }).store
    expect(() => applyBarrierCommand(conflict, {
      kind: "admission.scheduled", deferredId: "shared", target: { agent: "agent-b", habitId: "habit-b" },
      scheduleRevision: "revision-b", slotKey: "slot-b", scheduledAtUtc: T2, writerEpoch: "epoch-2", at: T2,
    })).toThrow(/deferredId conflicts/i)

    const ready = armed().store
    const heldAgain = resourceBarrier(ready, {
      barrierId: "barrier-b", tokenHash: "d".repeat(64), writerEpoch: "epoch-3", at: T3,
    }).store
    const deferredAgain = deniedRepair(heldAgain, { at: T3 })
    expect(deferredAgain.store.deferredIntents["deferred-a"]).toMatchObject({ state: "pending", readyAt: null })
  })

  it("rejects repair admission for incarnation, eligibility, and consumed-generation drift", () => {
    const fixture = armed()
    expect(() => applyBarrierCommand(fixture.store, {
      kind: "admission.repair", deferredId: "x", target: { ...resource, incarnationId: "other" },
      observationId: "o", repairEligibilityId: "eligibility-a", repairGeneration: 1, writerEpoch: "e", at: T3,
    })).toThrow(/incarnation/i)
    expect(() => applyBarrierCommand(fixture.store, {
      kind: "admission.repair", deferredId: "x", target: resource,
      observationId: "o", repairEligibilityId: "other", repairGeneration: 1, writerEpoch: "e", at: T3,
    })).toThrow(/eligibility/i)
    const used = consumed()
    expect(() => applyBarrierCommand(used.store, {
      kind: "admission.repair", deferredId: "x", target: resource,
      observationId: "o", repairEligibilityId: "eligibility-a", repairGeneration: 2, writerEpoch: "e", at: T3,
    })).toThrow(/different generation/i)
  })

  it("covers missing barriers, active-window release rejection, continuous empty release, and continuous replay", () => {
    expect(() => applyBarrierCommand(empty(), {
      kind: "barrier.release", barrierId: "missing", holder: "h", tokenHash: "a".repeat(64),
      currentDedupeKey: "x", writerEpoch: "e", at: T1,
    })).toThrow(/missing/i)
    const existingWindow = armed()
    const second = resourceBarrier(existingWindow.store, { barrierId: "barrier-b", tokenHash: "d".repeat(64) }).store
    const denied = deniedRepair(second, { deferredId: "deferred-b", repairEligibilityId: "eligibility-b" }).store
    expect(() => applyBarrierCommand(denied, {
      kind: "barrier.release", barrierId: "barrier-b", holder: "holder-a", tokenHash: "d".repeat(64),
      currentDedupeKey: "eligibility-b", writerEpoch: "e", at: T3,
    })).toThrow(/active action window/i)

    const scheduled = scheduleBarrier().store
    const command: BarrierCommandV1 = {
      kind: "barrier.release", barrierId: "schedule-a", holder: "holder-a", tokenHash: "b".repeat(64),
      currentDedupeKey: "no-slot", writerEpoch: "epoch-2", at: T1,
    }
    const released = applyBarrierCommand(scheduled, command)
    expect(released.result).toMatchObject({ kind: "released", readyDeferredIds: [], discardedDeferredIds: [] })
    expect(applyBarrierCommand(released.store, command).result).toMatchObject({ kind: "released", replayed: true, actionWindow: null })

    let withSlots = scheduleBarrier().store
    withSlots = applyBarrierCommand(withSlots, {
      kind: "admission.scheduled", deferredId: "slot-current", target: schedule,
      scheduleRevision: "revision-a", slotKey: "current", scheduledAtUtc: T2, writerEpoch: "epoch-1", at: T1,
    }).store
    withSlots = applyBarrierCommand(withSlots, {
      kind: "admission.scheduled", deferredId: "slot-stale", target: schedule,
      scheduleRevision: "revision-b", slotKey: "stale", scheduledAtUtc: T2, writerEpoch: "epoch-1", at: T1,
    }).store
    const slotRelease: BarrierCommandV1 = {
      kind: "barrier.release", barrierId: "schedule-a", holder: "holder-a", tokenHash: "b".repeat(64),
      currentDedupeKey: "current", writerEpoch: "epoch-2", at: T2,
    }
    const slotsReleased = applyBarrierCommand(withSlots, slotRelease)
    expect(applyBarrierCommand(slotsReleased.store, slotRelease).result).toMatchObject({
      readyDeferredIds: ["slot-current"], discardedDeferredIds: ["slot-stale"], replayed: true,
    })
    expect(() => applyBarrierCommand(slotsReleased.store, { ...slotRelease, currentDedupeKey: "drift" })).toThrow(/dedupe key/i)
    const historicalDiscard = mutateStore(slotsReleased.store, (value) => {
      value.deferredIntents["slot-stale"].settledAt = T1
    })
    expect(applyBarrierCommand(historicalDiscard, slotRelease).result).toMatchObject({ discardedDeferredIds: [] })
  })

  it("rejects release replay when a corrupt history contains multiple windows for one barrier", () => {
    const fixture = armed()
    const corrupt = mutateStore(fixture.store, (value) => {
      const deferred = value.deferredIntents["deferred-a"]
      value.deferredIntents["deferred-extra"] = {
        ...structuredClone(deferred),
        deferredId: "deferred-extra",
        dedupeKey: "eligibility-extra",
        payload: { observationId: "observation-extra", repairEligibilityId: "eligibility-extra" },
        state: "settled",
        settledAt: T3,
        deliveryRef: "delivery-extra",
      }
      const actionWindowId = deriveActionWindowId("barrier-a", "deferred-extra", "eligibility-extra")
      value.actionWindows[actionWindowId] = {
        ...structuredClone(fixture.window),
        actionWindowId,
        deferredId: "deferred-extra",
        repairEligibilityId: "eligibility-extra",
        state: "succeeded",
        repairGeneration: 2,
        consumedAt: T2,
        terminalAt: T3,
        terminalRef: "authority/extra.json",
        terminalSha256: "8".repeat(64),
      }
    })
    expect(() => applyBarrierCommand(corrupt, {
      kind: "barrier.release", barrierId: "barrier-a", holder: "holder-a", tokenHash: "a".repeat(64),
      currentDedupeKey: "eligibility-a", writerEpoch: "epoch-2", at: T2,
    })).toThrow(/multiple action windows/i)
  })

  it("covers success, block, and expiry replay and rejection rows", () => {
    const fixture = consumed()
    const id = fixture.window.actionWindowId
    const successCommand: BarrierCommandV1 = {
      kind: "action-window.succeed", actionWindowId: id, repairGeneration: 1,
      terminalRef: "authority/success.json", terminalSha256: "5".repeat(64), writerEpoch: "epoch-4", at: T3,
    }
    const success = applyBarrierCommand(fixture.store, successCommand)
    expect(applyBarrierCommand(success.store, successCommand).result).toMatchObject({ replayed: true })
    expect(() => applyBarrierCommand(success.store, { ...successCommand, terminalSha256: "6".repeat(64) })).toThrow(/cannot change/i)
    expect(() => applyBarrierCommand(armed().store, successCommand)).toThrow(/success-eligible/i)
    expect(() => applyBarrierCommand(fixture.store, { ...successCommand, repairGeneration: 2 })).toThrow(/generation/i)
    expect(() => applyBarrierCommand(fixture.store, { ...successCommand, actionWindowId: "missing" })).toThrow(/missing/i)

    const blockCommand: BarrierCommandV1 = {
      kind: "action-window.block", actionWindowId: id, repairGeneration: 1, disposition: "failed_terminal",
      terminalRef: "authority/failure.json", terminalSha256: "7".repeat(64), writerEpoch: "epoch-4", at: T3,
    }
    const blockedResult = applyBarrierCommand(fixture.store, blockCommand)
    expect(applyBarrierCommand(blockedResult.store, blockCommand).result).toMatchObject({ replayed: true })
    expect(() => applyBarrierCommand(blockedResult.store, { ...blockCommand, terminalRef: "other" })).toThrow(/cannot change/i)
    expect(() => applyBarrierCommand(armed().store, blockCommand)).toThrow(/block-eligible/i)
    expect(() => applyBarrierCommand(fixture.store, { ...blockCommand, repairGeneration: 2 })).toThrow(/block-eligible/i)
    expect(() => applyBarrierCommand(fixture.store, { ...blockCommand, actionWindowId: "missing" })).toThrow(/missing/i)
    expect(() => applyBarrierCommand(fixture.store, { ...blockCommand, disposition: "invalid" as never })).toThrow(/disposition/i)

    expect(() => applyBarrierCommand(success.store, {
      kind: "action-window.expire", actionWindowId: id, writerEpoch: "e", at: "2026-07-24T12:20:00.000Z",
    })).toThrow(/deadline-eligible/i)
    expect(() => applyBarrierCommand(fixture.store, {
      kind: "action-window.expire", actionWindowId: "missing", writerEpoch: "e", at: T3,
    })).toThrow(/missing/i)
  })

  it("covers rearm structural, authority, budget, cooldown, freshness, and candidate rejection rows", () => {
    const fixture = rearmReady()
    const base = rearmCommand(fixture.window)
    const cases: Array<BarrierCommandV1> = [
      { ...base, blockedActionWindowId: "missing" },
      { ...base, barrierId: "missing" },
      { ...base, holder: "other" },
      { ...base, tokenHash: "e".repeat(64) },
      { ...base, remainingBudget: 0 },
      { ...base, cooldownUntil: "2026-07-24T12:09:00.000Z" },
      { ...base, reconciliation: proof(fixture.window, { observedAt: "2026-07-24T12:09:00.000Z" }) },
      { ...base, currentDedupeKey: "missing" },
      { ...base, reconciliation: { ...base.reconciliation, schemaVersion: 2 as 1 } },
    ]
    for (const command of cases) expect(() => applyBarrierCommand(fixture.store, command)).toThrow(ActivationBarrierError)

    const nullGeneration = mutateStore(fixture.store, (value) => {
      const window = value.actionWindows[fixture.window.actionWindowId]
      window.repairGeneration = null
      window.consumedAt = null
      window.terminalRef = null
      window.terminalSha256 = null
    })
    expect(() => applyBarrierCommand(nullGeneration, base)).toThrow(/consumed repair generation/i)

    const wrongTarget = mutateStore(fixture.store, (value) => {
      const barrier = value.barriers["barrier-b"]
      barrier.target = { resourceId: "other", incarnationId: "incarnation-a" }
      barrier.targetKey = deriveBarrierTargetKey("resource-repair", barrier.target)
      const deferred = value.deferredIntents["deferred-b"]
      deferred.target = barrier.target
      deferred.targetKey = barrier.targetKey
    })
    expect(() => applyBarrierCommand(wrongTarget, base)).toThrow(/target/i)

    const duplicate = structuredClone(fixture.store)
    duplicate.deferredIntents["deferred-c"] = {
      ...structuredClone(duplicate.deferredIntents["deferred-b"]), deferredId: "deferred-c",
    }
    expect(() => applyBarrierCommand(duplicate, base)).toThrow(/exactly one/i)
  })

  it("discards stale repair intents during rearm and rejects a second CAS", () => {
    const fixture = rearmReady()
    const extraBarrier = resourceBarrier(fixture.store, {
      barrierId: "barrier-c", tokenHash: "e".repeat(64), writerEpoch: "epoch-5", at: T3,
    }).store
    const withStale = deniedRepair(extraBarrier, {
      deferredId: "deferred-stale", observationId: "stale", repairEligibilityId: "eligibility-stale", at: T3,
    }).store
    const rearmed = applyBarrierCommand(withStale, rearmCommand(fixture.window))
    expect(rearmed.store.deferredIntents["deferred-stale"].state).toBe("discarded")
    expect(() => applyBarrierCommand(rearmed.store, rearmCommand(fixture.window))).toThrow(/blocked action window/i)
  })
})

describe("protected repository verification", () => {
  function tempPath(): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ouro-barrier-verify-"))
    roots.push(root)
    return path.join(root, "barriers.json")
  }

  function alive(candidate: ProcessIdentity): ExactProcessState {
    return { state: "alive", observed: candidate }
  }

  it("rejects raw rearm even through an unsafe runtime cast", () => {
    const repo = new ActivationBarrierStore({ targetPath: tempPath(), owner, proveOwnerState: alive })
    const fixture = rearmReady()
    expect(() => repo.apply(rearmCommand(fixture.window) as never)).toThrow(/raw rearm/i)
  })

  it("runs continuous repair admission under the store lock and leaves no action window", () => {
    const targetPath = tempPath()
    const repo = new ActivationBarrierStore({ targetPath, owner, proveOwnerState: alive })
    repo.apply({
      kind: "barrier.acquire", barrierId: "other", scope: "resource-repair",
      target: { resourceId: "resource-other", incarnationId: "incarnation-other" }, holder: "h",
      tokenHash: "f".repeat(64), releasePolicy: { kind: "one-shot-current", terminalTimeoutMs: 600_000 },
      writerEpoch: "e", at: T0,
    })
    const attempt = vi.fn(() => "started")
    const result = repo.withRepairAdmission({
      kind: "admission.repair", deferredId: "d", target: resource, observationId: "o",
      repairEligibilityId: "eligibility", repairGeneration: 1, writerEpoch: "e", at: T1,
    }, attempt)
    expect(result).toEqual({ admission: { kind: "admitted", actionWindow: null }, attempt: "started" })
    expect(attempt).toHaveBeenCalledOnce()
  })

  it("validates reconciliation reference/hash before invoking the authority resolver", () => {
    const resolve = vi.fn()
    const repo = new ActivationBarrierStore({
      targetPath: tempPath(), owner, proveOwnerState: alive, reconciliationAuthority: { resolve },
    })
    const fixture = rearmReady()
    expect(() => repo.rearm({
      ...rearmCommand(fixture.window), reconciliationRef: "", reconciliationSha256: "bad",
    })).toThrow(ActivationBarrierError)
    expect(resolve).not.toHaveBeenCalled()
  })
})
