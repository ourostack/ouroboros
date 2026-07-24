import * as fs from "fs"
import * as os from "os"
import * as path from "path"

import { describe, expect, it, vi } from "vitest"

import { ActivationBarrierStore } from "../../../heart/activation/barrier-core"
import {
  HabitDispatchCoordinator,
  type HabitDispatchDefinition,
} from "../../../heart/habits/habit-dispatch-coordinator"
import type { HabitExecutionAdapter, HabitExecutionEnvelopeV1 } from "../../../heart/habits/habit-execution"
import { HabitExecutionRegistry } from "../../../heart/habits/habit-execution-registry"
import { HabitAdapterInvocationError } from "../../../heart/habits/habit-execution-registry"
import { HabitOccurrenceStore } from "../../../heart/habits/habit-occurrence-store"
import { HabitScheduleStore } from "../../../heart/habits/habit-schedule-store"
import type { ExactProcessState, ProcessIdentity } from "../../../heart/runtime/process-identity"

const owner: ProcessIdentity & { daemonInstanceId: string } = {
  uid: 501,
  pid: 4242,
  startIdentity: "darwin-proc:1770000000:000123",
  bootId: "boot-a",
  daemonInstanceId: "daemon-a",
}

const execution: HabitExecutionEnvelopeV1 = {
  version: 1,
  adapter: "fake",
  config: {},
  policy: { maxOccurrenceAttempts: 3, unknownSlotFence: "none" },
}

function habit(overrides: Partial<HabitDispatchDefinition> = {}): HabitDispatchDefinition {
  return {
    id: "heartbeat",
    title: "Heartbeat",
    body: "Run it.",
    tools: [],
    continuity: { mode: "fresh" },
    cadence: "30m",
    cadenceTimezone: null,
    created: "2026-07-23T00:00:00.000Z",
    execution,
    ...overrides,
  }
}

function settledAdapter(invoke = vi.fn(async () => ({
  version: 1 as const,
  disposition: "settled" as const,
  result: { version: 1 as const, status: "completed" as const, resultRef: "receipt:done" },
}))): HabitExecutionAdapter<Record<string, never>> {
  return {
    id: "fake",
    version: 1,
    validateConfig(raw) {
      if (Object.keys(raw).length > 0) throw new Error("config must be empty")
      return {}
    },
    invoke,
  }
}

function registry(adapter: HabitExecutionAdapter<Record<string, never>>): HabitExecutionRegistry {
  const result = new HabitExecutionRegistry()
  result.register(adapter)
  return result
}

function alive(): ExactProcessState {
  return { state: "alive", observed: owner }
}

function realCoordinator(options: {
  root: string
  adapter: HabitExecutionAdapter<Record<string, never>>
  now?: string
}): HabitDispatchCoordinator {
  const now = options.now ?? "2026-07-23T10:00:00.000Z"
  const common = {
    bundleRoot: options.root,
    agent: "slugger",
    owner,
    now: () => now,
    proveOwnerState: () => alive(),
  }
  const lockOwner: ProcessIdentity = {
    uid: owner.uid,
    pid: owner.pid,
    startIdentity: owner.startIdentity,
    bootId: owner.bootId,
  }
  return new HabitDispatchCoordinator({
    agent: "slugger",
    bundleRoot: options.root,
    owner,
    now: () => now,
    randomUuid: () => "11111111-1111-4111-8111-111111111111",
    deadlineMs: 60_000,
    registry: registry(options.adapter),
    scheduleStore: new HabitScheduleStore({ ...common, machineTimezone: "UTC" }),
    occurrenceStore: new HabitOccurrenceStore(common),
    barrierStore: new ActivationBarrierStore({
      targetPath: path.join(options.root, "activation-barriers.json"),
      owner: lockOwner,
      proveOwnerState: () => alive(),
    }),
  })
}

describe("habit dispatch coordinator", () => {
  it("orders validation, fence admission, scheduled barrier, claim, adapter, settlement, then projection", async () => {
    const calls: string[] = []
    const outcome = {
      version: 1 as const,
      disposition: "settled" as const,
      result: { version: 1 as const, status: "completed" as const, resultRef: "receipt:done" },
    }
    const adapter = settledAdapter(vi.fn(async (input) => {
      calls.push("adapter")
      expect(input.occurrenceId).toBe("occ_slot")
      expect(input.attemptId).toBe("hat_attempt")
      expect(input.owner).toEqual(owner)
      expect(input.deadlineAt).toBe("2026-07-23T10:01:00.000Z")
      expect(input.trigger).toEqual({
        kind: "launchd",
        observedAt: "2026-07-23T10:00:00.000Z",
        scheduleProofRef: "habit-schedule:definition:slot",
      })
      return outcome
    }))
    const executionRegistry = registry(adapter)
    const originalResolve = executionRegistry.resolve.bind(executionRegistry)
    vi.spyOn(executionRegistry, "resolve").mockImplementation((envelope) => {
      calls.push("validate")
      return originalResolve(envelope)
    })

    const occurrence = {
      occurrenceId: "occ_slot",
      attemptId: "hat_attempt",
    }
    const coordinator = new HabitDispatchCoordinator({
      agent: "slugger",
      bundleRoot: "/bundle",
      owner,
      now: () => "2026-07-23T10:00:00.000Z",
      randomUuid: () => "11111111-1111-4111-8111-111111111111",
      deadlineMs: 60_000,
      registry: executionRegistry,
      scheduleStore: {
        reconcile: vi.fn(() => ({
          definitionSha256: "definition",
          scheduleRevision: "revision",
        })),
      } as never,
      slotAtOrBefore: () => ({
        kind: "scheduled",
        slotKey: "slot",
        scheduleRevision: "revision",
        scheduledAtUtc: "2026-07-23T10:00:00.000Z",
      }),
      occurrenceStore: {
        checkFenceAdmission: vi.fn(() => {
          calls.push("fence")
          return { kind: "admitted" }
        }),
        claimNext: vi.fn(() => {
          calls.push("claim")
          return {
            kind: "claimed",
            occurrence: { occurrenceId: occurrence.occurrenceId },
            attempt: {
              attemptId: occurrence.attemptId,
              trigger: {
                kind: "launchd",
                observedAt: "2026-07-23T10:00:00.000Z",
                scheduleProofRef: "habit-schedule:definition:slot",
              },
            },
          }
        }),
        settle: vi.fn(() => {
          calls.push("settle")
          return { occurrenceId: occurrence.occurrenceId }
        }),
        markUnknown: vi.fn(),
      } as never,
      barrierStore: {
        withScheduledAdmission: vi.fn((_command, claim: () => unknown) => {
          calls.push("barrier")
          return { admission: { kind: "admitted", actionWindow: null }, claim: claim() }
        }),
      } as never,
    })

    const result = await coordinator.dispatch({
      habit: habit(),
      trigger: "launchd",
    })

    calls.push("project")
    expect(result).toEqual({
      kind: "settled",
      occurrenceId: "occ_slot",
      attemptId: "hat_attempt",
      outcome,
    })
    expect(calls).toEqual(["validate", "fence", "barrier", "claim", "adapter", "settle", "project"])
  })

  it("does not invoke an adapter when fence, barrier, or claim admission is blocked", async () => {
    for (const blockedAt of ["fence", "barrier", "claim"] as const) {
      const invoke = vi.fn(async () => ({
        version: 1 as const,
        disposition: "settled" as const,
        result: { version: 1 as const, status: "completed" as const, resultRef: "receipt" },
      }))
      const occurrenceStore = {
        checkFenceAdmission: vi.fn(() => blockedAt === "fence"
          ? { kind: "blocked", reason: "unknown_slot_fence", occurrenceId: "occ_old" }
          : { kind: "admitted" }),
        claimNext: vi.fn(() => blockedAt === "claim"
          ? { kind: "blocked", reason: "active_attempt", occurrenceId: "occ_active" }
          : { kind: "claimed", occurrence: { occurrenceId: "occ_slot" }, attempt: { attemptId: "hat_1" } }),
      }
      const barrierStore = {
        withScheduledAdmission: vi.fn((_command: unknown, claim: () => unknown) => blockedAt === "barrier"
          ? { admission: { kind: "deferred", deferredId: "deferred", deferred: {} } }
          : { admission: { kind: "admitted", actionWindow: null }, claim: claim() }),
      }
      const coordinator = new HabitDispatchCoordinator({
        agent: "slugger",
        bundleRoot: "/bundle",
        owner,
        now: () => "2026-07-23T10:00:00.000Z",
        randomUuid: () => "11111111-1111-4111-8111-111111111111",
        deadlineMs: 60_000,
        registry: registry(settledAdapter(invoke)),
        scheduleStore: { reconcile: () => ({ definitionSha256: "definition", scheduleRevision: "revision" }) } as never,
        slotAtOrBefore: () => ({
          kind: "scheduled",
          slotKey: "slot",
          scheduleRevision: "revision",
          scheduledAtUtc: "2026-07-23T10:00:00.000Z",
        }),
        occurrenceStore: occurrenceStore as never,
        barrierStore: barrierStore as never,
      })

      const result = await coordinator.dispatch({ habit: habit(), trigger: "launchd" })

      expect(result.kind).toBe("blocked")
      expect(invoke).not.toHaveBeenCalled()
    }
  })

  it("blocks a manual trigger at the recovered habit fence", async () => {
    const invoke = vi.fn()
    const coordinator = new HabitDispatchCoordinator({
      agent: "slugger",
      bundleRoot: "/bundle",
      owner,
      now: () => "2026-07-23T10:00:00.000Z",
      deadlineMs: 60_000,
      registry: registry(settledAdapter(invoke)),
      scheduleStore: { reconcile: vi.fn() } as never,
      occurrenceStore: {
        checkFenceAdmission: () => ({
          kind: "blocked",
          reason: "unknown_slot_fence",
          occurrenceId: "occ_unknown",
        }),
      } as never,
      barrierStore: { withScheduledAdmission: vi.fn() } as never,
    })

    await expect(coordinator.dispatch({ habit: habit({ cadence: null }), trigger: "manual" })).resolves.toEqual({
      kind: "blocked",
      reason: "unknown_slot_fence",
      occurrenceId: "occ_unknown",
    })
    expect(invoke).not.toHaveBeenCalled()
  })

  it("validates adapter config before fence or barrier admission", async () => {
    const fence = vi.fn()
    const barrier = vi.fn()
    const coordinator = new HabitDispatchCoordinator({
      agent: "slugger",
      bundleRoot: "/bundle",
      owner,
      now: () => "2026-07-23T10:00:00.000Z",
      randomUuid: () => "11111111-1111-4111-8111-111111111111",
      deadlineMs: 60_000,
      registry: registry(settledAdapter()),
      scheduleStore: { reconcile: vi.fn() } as never,
      occurrenceStore: { checkFenceAdmission: fence } as never,
      barrierStore: { withScheduledAdmission: barrier } as never,
    })

    await expect(coordinator.dispatch({
      habit: habit({ execution: { ...execution, config: { forbidden: true } } }),
      trigger: "launchd",
    })).rejects.toThrow("config must be empty")
    expect(fence).not.toHaveBeenCalled()
    expect(barrier).not.toHaveBeenCalled()
  })

  it("uses the same manual claim and settlement boundary for a poke", async () => {
    const invoke = vi.fn(async () => ({
      version: 1 as const,
      disposition: "settled" as const,
      result: { version: 1 as const, status: "completed" as const, resultRef: "manual:done" },
    }))
    const occurrenceStore = {
      checkFenceAdmission: vi.fn(() => ({ kind: "admitted" })),
      claimManual: vi.fn(() => ({
        kind: "claimed",
        occurrence: { occurrenceId: "occ_manual_one" },
        attempt: { attemptId: "hat_manual" },
      })),
      settle: vi.fn(() => ({ occurrenceId: "occ_manual_one" })),
    }
    const coordinator = new HabitDispatchCoordinator({
      agent: "slugger",
      bundleRoot: "/bundle",
      owner,
      now: () => "2026-07-23T10:00:00.000Z",
      randomUuid: () => "11111111-1111-4111-8111-111111111111",
      deadlineMs: 60_000,
      registry: registry(settledAdapter(invoke)),
      scheduleStore: { reconcile: vi.fn() } as never,
      occurrenceStore: occurrenceStore as never,
      barrierStore: { withScheduledAdmission: vi.fn() } as never,
    })

    const result = await coordinator.dispatch({ habit: habit({ cadence: null }), trigger: "poke" })

    expect(result.kind).toBe("settled")
    expect(occurrenceStore.claimManual).toHaveBeenCalledWith(expect.objectContaining({
      habitId: "heartbeat",
      requestId: "11111111-1111-4111-8111-111111111111",
      trigger: {
        kind: "poke",
        observedAt: "2026-07-23T10:00:00.000Z",
        scheduleProofRef: null,
      },
    }))
    expect(invoke).toHaveBeenCalledTimes(1)
    expect(occurrenceStore.settle).toHaveBeenCalledTimes(1)
  })

  it("persists explicit adapter-reported unknown evidence before returning it", async () => {
    const evidence = {
      kind: "adapter-owned" as const,
      ref: "evidence:unknown",
      sha256: "a".repeat(64),
      observedAt: "2026-07-23T10:00:00.000Z",
    }
    const occurrenceStore = {
      checkFenceAdmission: vi.fn(() => ({ kind: "admitted" })),
      claimManual: vi.fn(() => ({
        kind: "claimed",
        occurrence: { occurrenceId: "occ_manual_one" },
        attempt: { attemptId: "hat_manual" },
      })),
      markUnknown: vi.fn(() => ({ occurrenceId: "occ_manual_one" })),
    }
    const adapter: HabitExecutionAdapter<Record<string, never>> = {
      ...settledAdapter(),
      invoke: vi.fn(async () => ({
        version: 1,
        disposition: "outcome_unknown",
        reason: "adapter_reported_unknown",
        evidence,
      })),
    }
    const coordinator = new HabitDispatchCoordinator({
      agent: "slugger",
      bundleRoot: "/bundle",
      owner,
      now: () => "2026-07-23T10:00:00.000Z",
      randomUuid: () => "11111111-1111-4111-8111-111111111111",
      deadlineMs: 60_000,
      registry: registry(adapter),
      scheduleStore: { reconcile: vi.fn() } as never,
      occurrenceStore: occurrenceStore as never,
      barrierStore: { withScheduledAdmission: vi.fn() } as never,
    })

    const result = await coordinator.dispatch({ habit: habit({ cadence: null }), trigger: "manual" })

    expect(occurrenceStore.markUnknown).toHaveBeenCalledWith(
      "occ_manual_one",
      "hat_manual",
      "adapter_reported_unknown",
      [evidence],
    )
    expect(result).toMatchObject({ kind: "outcome_unknown", outcome: { evidence } })
  })

  it("withholds an adapter result when durable settlement fails", async () => {
    const occurrenceStore = {
      checkFenceAdmission: vi.fn(() => ({ kind: "admitted" })),
      claimManual: vi.fn(() => ({
        kind: "claimed",
        occurrence: { occurrenceId: "occ_manual_one" },
        attempt: { attemptId: "hat_manual" },
      })),
      settle: vi.fn(() => { throw new Error("fsync failed") }),
    }
    const invoke = vi.fn(async () => ({
      version: 1 as const,
      disposition: "settled" as const,
      result: { version: 1 as const, status: "completed" as const, resultRef: "receipt:done" },
    }))
    const coordinator = new HabitDispatchCoordinator({
      agent: "slugger",
      bundleRoot: "/bundle",
      owner,
      now: () => "2026-07-23T10:00:00.000Z",
      randomUuid: () => "11111111-1111-4111-8111-111111111111",
      deadlineMs: 60_000,
      registry: registry(settledAdapter(invoke)),
      scheduleStore: { reconcile: vi.fn() } as never,
      occurrenceStore: occurrenceStore as never,
      barrierStore: { withScheduledAdmission: vi.fn() } as never,
    })

    await expect(coordinator.dispatch({ habit: habit({ cadence: null }), trigger: "manual" }))
      .rejects.toThrow("fsync failed")
    expect(invoke).toHaveBeenCalledTimes(1)
    expect(occurrenceStore.settle).toHaveBeenCalledTimes(2)
  })

  it("preserves non-Error settlement diagnostics while retrying the same write", async () => {
    const settle = vi.fn()
      .mockImplementationOnce(() => { throw "transient write failure" })
      .mockReturnValueOnce({ occurrenceId: "occ_manual_one" })
    const occurrenceStore = {
      checkFenceAdmission: () => ({ kind: "admitted" }),
      claimManual: () => ({
        kind: "claimed",
        occurrence: { occurrenceId: "occ_manual_one" },
        attempt: {
          attemptId: "hat_manual",
          trigger: { kind: "manual", observedAt: "2026-07-23T10:00:00.000Z", scheduleProofRef: null },
        },
      }),
      settle,
    }
    const coordinator = new HabitDispatchCoordinator({
      agent: "slugger",
      bundleRoot: "/bundle",
      owner,
      now: () => "2026-07-23T10:00:00.000Z",
      deadlineMs: 60_000,
      registry: registry(settledAdapter()),
      scheduleStore: { reconcile: vi.fn() } as never,
      occurrenceStore: occurrenceStore as never,
      barrierStore: { withScheduledAdmission: vi.fn() } as never,
    })

    await expect(coordinator.dispatch({ habit: habit({ cadence: null }), trigger: "manual" }))
      .resolves.toMatchObject({ kind: "settled" })
    expect(settle).toHaveBeenCalledTimes(2)
  })

  it("retries the same result write under the same live claim owner before projection", async () => {
    const settle = vi.fn()
      .mockImplementationOnce(() => { throw new Error("transient directory fsync failure") })
      .mockReturnValueOnce({ occurrenceId: "occ_manual_one" })
    const occurrenceStore = {
      checkFenceAdmission: () => ({ kind: "admitted" }),
      claimManual: () => ({
        kind: "claimed",
        occurrence: { occurrenceId: "occ_manual_one" },
        attempt: {
          attemptId: "hat_manual",
          trigger: { kind: "manual", observedAt: "2026-07-23T10:00:00.000Z", scheduleProofRef: null },
        },
      }),
      settle,
    }
    const coordinator = new HabitDispatchCoordinator({
      agent: "slugger",
      bundleRoot: "/bundle",
      owner,
      now: () => "2026-07-23T10:00:00.000Z",
      deadlineMs: 60_000,
      registry: registry(settledAdapter()),
      scheduleStore: { reconcile: vi.fn() } as never,
      occurrenceStore: occurrenceStore as never,
      barrierStore: { withScheduledAdmission: vi.fn() } as never,
    })

    await expect(coordinator.dispatch({ habit: habit({ cadence: null }), trigger: "manual" }))
      .resolves.toMatchObject({ kind: "settled" })
    expect(settle).toHaveBeenCalledTimes(2)
    expect(settle.mock.calls[0]).toEqual(settle.mock.calls[1])
  })

  it("invokes nothing when a durable claim write fails", async () => {
    const invoke = vi.fn(async () => ({
      version: 1 as const,
      disposition: "settled" as const,
      result: { version: 1 as const, status: "completed" as const, resultRef: "receipt:done" },
    }))
    const coordinator = new HabitDispatchCoordinator({
      agent: "slugger",
      bundleRoot: "/bundle",
      owner,
      now: () => "2026-07-23T10:00:00.000Z",
      deadlineMs: 60_000,
      registry: registry(settledAdapter(invoke)),
      scheduleStore: { reconcile: vi.fn() } as never,
      occurrenceStore: {
        checkFenceAdmission: () => ({ kind: "admitted" }),
        claimManual: () => { throw new Error("claim fsync failed") },
      } as never,
      barrierStore: { withScheduledAdmission: vi.fn() } as never,
    })

    await expect(coordinator.dispatch({ habit: habit({ cadence: null }), trigger: "poke" }))
      .rejects.toThrow("claim fsync failed")
    expect(invoke).not.toHaveBeenCalled()
  })

  it("durably marks adapter invocation ambiguity before propagating the failure", async () => {
    const occurrenceStore = {
      checkFenceAdmission: () => ({ kind: "admitted" }),
      claimManual: () => ({
        kind: "claimed",
        occurrence: { occurrenceId: "occ_manual_one" },
        attempt: {
          attemptId: "hat_manual",
          trigger: {
            kind: "poke",
            observedAt: "2026-07-23T10:00:00.000Z",
            scheduleProofRef: null,
          },
        },
      }),
      markUnknown: vi.fn(),
    }
    const adapter = settledAdapter(vi.fn(async () => {
      throw new HabitAdapterInvocationError("adapter_transport_unknown", "connection lost after dispatch")
    }))
    const coordinator = new HabitDispatchCoordinator({
      agent: "slugger",
      bundleRoot: "/bundle",
      owner,
      now: () => "2026-07-23T10:00:00.000Z",
      deadlineMs: 60_000,
      registry: registry(adapter),
      scheduleStore: { reconcile: vi.fn() } as never,
      occurrenceStore: occurrenceStore as never,
      barrierStore: { withScheduledAdmission: vi.fn() } as never,
    })

    await expect(coordinator.dispatch({ habit: habit({ cadence: null }), trigger: "poke" }))
      .rejects.toThrow("connection lost after dispatch")
    expect(occurrenceStore.markUnknown).toHaveBeenCalledWith(
      "occ_manual_one",
      "hat_manual",
      "adapter_transport_unknown",
      [],
    )
  })

  it("classifies an unexpected invocation-boundary failure as adapter ambiguity", async () => {
    const occurrenceStore = {
      checkFenceAdmission: () => ({ kind: "admitted" }),
      claimManual: () => ({
        kind: "claimed",
        occurrence: { occurrenceId: "occ_manual_one" },
        attempt: {
          attemptId: "hat_manual",
          trigger: { kind: "manual", observedAt: "2026-07-23T10:00:00.000Z", scheduleProofRef: null },
        },
      }),
      markUnknown: vi.fn(),
    }
    const coordinator = new HabitDispatchCoordinator({
      agent: "slugger",
      bundleRoot: "/bundle",
      owner,
      now: () => "2026-07-23T10:00:00.000Z",
      deadlineMs: 60_000,
      registry: registry(settledAdapter()),
      scheduleStore: { reconcile: vi.fn() } as never,
      occurrenceStore: occurrenceStore as never,
      barrierStore: { withScheduledAdmission: vi.fn() } as never,
      invokeResolved: vi.fn(async () => { throw new Error("unexpected invocation boundary failure") }),
    })

    await expect(coordinator.dispatch({ habit: habit({ cadence: null }), trigger: "manual" }))
      .rejects.toThrow("unexpected invocation boundary failure")
    expect(occurrenceStore.markUnknown).toHaveBeenCalledWith(
      "occ_manual_one",
      "hat_manual",
      "adapter_exception",
      [],
    )
  })

  it("reports a scheduled definition whose first slot is still in the future without touching a claim", async () => {
    const claimNext = vi.fn()
    const coordinator = new HabitDispatchCoordinator({
      agent: "slugger",
      bundleRoot: "/bundle",
      owner,
      now: () => "2026-07-23T10:00:00.000Z",
      deadlineMs: 60_000,
      registry: registry(settledAdapter()),
      scheduleStore: { reconcile: () => ({ definitionSha256: "definition" }) } as never,
      occurrenceStore: { claimNext } as never,
      barrierStore: { withScheduledAdmission: vi.fn() } as never,
      slotAtOrBefore: () => null,
    })

    await expect(coordinator.dispatch({ habit: habit(), trigger: "cron" })).resolves.toEqual({
      kind: "blocked",
      reason: "no_due_slot",
      occurrenceId: null,
    })
    expect(claimNext).not.toHaveBeenCalled()
  })

  it("blocks a scheduled trigger when the habit has no cadence", async () => {
    const reconcile = vi.fn()
    const coordinator = new HabitDispatchCoordinator({
      agent: "slugger",
      bundleRoot: "/bundle",
      owner,
      now: () => "2026-07-23T10:00:00.000Z",
      deadlineMs: 60_000,
      registry: registry(settledAdapter()),
      scheduleStore: { reconcile } as never,
      occurrenceStore: {} as never,
      barrierStore: {} as never,
    })

    await expect(coordinator.dispatch({ habit: habit({ cadence: null }), trigger: "cron" })).resolves.toEqual({
      kind: "blocked",
      reason: "no_cadence",
      occurrenceId: null,
    })
    expect(reconcile).not.toHaveBeenCalled()
  })

  it("admits one adapter entry for concurrent scheduler triggers sharing a canonical slot", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ouro-habit-dispatch-race-"))
    let release!: () => void
    const held = new Promise<void>((resolve) => { release = resolve })
    const entered = vi.fn(async () => {
      await held
      return {
        version: 1 as const,
        disposition: "settled" as const,
        result: { version: 1 as const, status: "completed" as const, resultRef: "receipt:done" },
      }
    })
    const first = realCoordinator({ root, adapter: settledAdapter(entered) })
    const second = realCoordinator({ root, adapter: settledAdapter(entered) })

    const firstResult = first.dispatch({ habit: habit(), trigger: "launchd" })
    await vi.waitFor(() => expect(entered).toHaveBeenCalledTimes(1))
    const secondResult = await second.dispatch({ habit: habit(), trigger: "overdue" })
    release()

    await expect(firstResult).resolves.toMatchObject({ kind: "settled" })
    expect(secondResult).toMatchObject({ kind: "blocked", reason: "active_attempt" })
    expect(entered).toHaveBeenCalledTimes(1)
  })
})
