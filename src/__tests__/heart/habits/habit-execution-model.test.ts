import { describe, expect, expectTypeOf, it } from "vitest"

import {
  DEFAULT_HABIT_EXECUTION,
  parseHabitExecutionEnvelope,
  parseHabitFrontmatterYaml,
  type HabitExecutionAdapter,
  type HabitExecutionEnvelopeV1,
  type HabitInvocationOutcomeV1,
  type HabitInvocationV1,
  type HabitReconciliationInputV1,
  type HabitReconciliationResultV1,
} from "../../../heart/habits/habit-execution"

describe("habit execution model", () => {
  it("exposes the exact immutable in-memory default", () => {
    expect(DEFAULT_HABIT_EXECUTION).toEqual({
      version: 1,
      adapter: "agent-turn",
      config: {},
      policy: { maxOccurrenceAttempts: 3, unknownSlotFence: "none" },
    })
    expect(Object.isFrozen(DEFAULT_HABIT_EXECUTION)).toBe(true)
    expect(Object.isFrozen(DEFAULT_HABIT_EXECUTION.config)).toBe(true)
    expect(Object.isFrozen(DEFAULT_HABIT_EXECUTION.policy)).toBe(true)
  })

  it("preserves adapter-owned configuration without interpreting its fields", () => {
    const raw = {
      version: 1,
      adapter: "custom-adapter",
      config: {
        arbitrary: { nested: [1, true, null, { value: "kept" }] },
      },
      policy: {},
    }

    expect(parseHabitExecutionEnvelope(raw)).toEqual({
      ...raw,
      policy: { maxOccurrenceAttempts: 3, unknownSlotFence: "none" },
    })
  })

  it("rejects multiple YAML documents before conversion to plain data", () => {
    expect(() => parseHabitFrontmatterYaml("title: First\n---\ntitle: Second\n")).toThrow(/multiple.*document/i)
  })

  it("defines the exact adapter invocation and reconciliation contracts", () => {
    type Config = { executorId: string }
    const invocation: HabitInvocationV1<Config> = {
      schemaVersion: 1,
      agent: "agent-a",
      bundleRoot: "/bundles/agent-a.ouro",
      habit: {
        id: "habit-a",
        title: "Habit A",
        body: "Do work.",
        tools: ["read_file"],
        continuity: { mode: "fresh" },
      },
      config: { executorId: "executor-a" },
      occurrenceId: "occurrence-a",
      attemptId: "attempt-a",
      trigger: { kind: "launchd", observedAt: "2026-07-24T12:00:00.000Z", scheduleProofRef: null },
      owner: {
        uid: 501,
        pid: 9001,
        startIdentity: "darwin-proc:1770000000:000001",
        bootId: "boot-a",
        daemonInstanceId: "daemon-a",
      },
      deadlineAt: "2026-07-24T12:01:00.000Z",
      signal: new AbortController().signal,
    }
    const reconcile: HabitReconciliationInputV1<Config> = {
      schemaVersion: 1,
      agent: invocation.agent,
      bundleRoot: invocation.bundleRoot,
      habitId: invocation.habit.id,
      config: invocation.config,
      occurrenceId: invocation.occurrenceId,
      attemptId: invocation.attemptId,
      unknownReason: "adapter_transport_unknown",
      priorEvidence: [],
    }
    const adapter: HabitExecutionAdapter<Config> = {
      id: "custom-adapter",
      version: 1,
      validateConfig: (raw) => ({ executorId: String(raw.executorId) }),
      invoke: async () => ({ version: 1, disposition: "settled", result: { version: 1, status: "completed", resultRef: "result-a" } }),
      reconcile: async () => ({ version: 1, disposition: "unresolved" }),
    }

    expect(Object.keys(invocation).sort()).toEqual([
      "agent", "attemptId", "bundleRoot", "config", "deadlineAt", "habit", "occurrenceId", "owner", "schemaVersion", "signal", "trigger",
    ])
    expect(Object.keys(reconcile).sort()).toEqual([
      "agent", "attemptId", "bundleRoot", "config", "habitId", "occurrenceId", "priorEvidence", "schemaVersion", "unknownReason",
    ])
    expect(adapter.version).toBe(1)
    expectTypeOf<Awaited<ReturnType<typeof adapter.invoke>>>().toEqualTypeOf<HabitInvocationOutcomeV1>()
    expectTypeOf<Awaited<ReturnType<NonNullable<typeof adapter.reconcile>>>>().toEqualTypeOf<HabitReconciliationResultV1>()
    expectTypeOf<ReturnType<typeof parseHabitExecutionEnvelope>>().toEqualTypeOf<HabitExecutionEnvelopeV1>()
  })
})
