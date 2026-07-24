import { describe, expect, it, vi } from "vitest"

import type {
  HabitExecutionAdapter,
  HabitInvocationV1,
  HabitReconciliationInputV1,
} from "../../../heart/habits/habit-execution"
import {
  HabitAdapterInvocationError,
  HabitExecutionRegistry,
  dispatchHabitExecution,
  reconcileResolvedHabitExecution,
} from "../../../heart/habits/habit-execution-registry"
import { createPackagedHabitExecutionRegistry } from "../../../heart/habits/packaged-habit-adapters"

function adapter(
  id: string,
  options: {
    validateConfig?: (raw: Record<string, unknown>) => Record<string, unknown>
    invoke?: HabitExecutionAdapter<Record<string, unknown>>["invoke"]
  } = {},
): HabitExecutionAdapter<Record<string, unknown>> {
  return {
    id,
    version: 1,
    validateConfig: options.validateConfig ?? ((raw) => raw),
    invoke: options.invoke ?? (async () => ({
      version: 1,
      disposition: "settled",
      result: { version: 1, status: "completed", resultRef: "result:test" },
    })),
  }
}

function invocation(): Omit<HabitInvocationV1<Record<string, unknown>>, "config"> {
  return {
    schemaVersion: 1,
    agent: "agent-a",
    bundleRoot: "/bundles/agent-a.ouro",
    habit: {
      id: "inventory-refresh",
      title: "Inventory refresh",
      body: "Refresh the inventory.",
      tools: [],
      continuity: { mode: "fresh" },
    },
    occurrenceId: "occurrence-a",
    attemptId: "attempt-a",
    trigger: {
      kind: "manual",
      observedAt: "2026-07-24T12:00:00.000Z",
      scheduleProofRef: null,
    },
    owner: {
      pid: 100,
      uid: 501,
      startIdentity: "darwin-proc:1:1",
      bootId: "boot-a",
      daemonInstanceId: "daemon-a",
    },
    deadlineAt: "2026-07-24T12:01:00.000Z",
    signal: new AbortController().signal,
  }
}

describe("HabitExecutionRegistry", () => {
  it("keys adapters by the exact id and version pair", () => {
    const registry = new HabitExecutionRegistry()
    const registered = adapter("custom-adapter")

    registry.register(registered)

    expect(registry.get("custom-adapter", 1)).toBe(registered)
    expect(() => registry.get("custom-adapter", 2)).toThrow(/unknown.*custom-adapter.*2/i)
  })

  it("rejects duplicate pairs and invalid identifiers", () => {
    const registry = new HabitExecutionRegistry()
    registry.register(adapter("custom-adapter"))

    expect(() => registry.register(adapter("custom-adapter"))).toThrow(/duplicate/i)
    expect(() => registry.register(adapter("Custom_Adapter"))).toThrow(/identifier|adapter.*id/i)
    expect(() => registry.register(adapter("1-adapter"))).toThrow(/identifier|adapter.*id/i)
    expect(() => registry.register({ ...adapter("future-adapter"), version: 2 as 1 })).toThrow(/version/i)
  })

  it("validates adapter configuration synchronously during resolution", () => {
    const invoke = vi.fn()
    const registry = new HabitExecutionRegistry()
    registry.register(adapter("strict-adapter", {
      validateConfig(raw) {
        if (raw.executorId !== "executor-a") throw new Error("executorId is required")
        return { executorId: raw.executorId }
      },
      invoke,
    }))

    expect(() => registry.resolve({
      version: 1,
      adapter: "strict-adapter",
      config: {},
      policy: { maxOccurrenceAttempts: 3, unknownSlotFence: "none" },
    })).toThrow(/executorId/i)
    expect(invoke).not.toHaveBeenCalled()
  })

  it("passes only validated configuration into the selected adapter", async () => {
    const invoke = vi.fn(async () => ({
      version: 1 as const,
      disposition: "settled" as const,
      result: { version: 1 as const, status: "completed" as const, resultRef: "result:a" },
    }))
    const registry = new HabitExecutionRegistry()
    registry.register(adapter("strict-adapter", {
      validateConfig: () => ({ normalized: true }),
      invoke,
    }))

    await expect(dispatchHabitExecution({
      registry,
      envelope: {
        version: 1,
        adapter: "strict-adapter",
        config: { untrusted: "discarded" },
        policy: { maxOccurrenceAttempts: 3, unknownSlotFence: "none" },
      },
      invocation: invocation(),
    })).resolves.toMatchObject({ disposition: "settled" })
    expect(invoke).toHaveBeenCalledWith(expect.objectContaining({ config: { normalized: true } }))
  })

  it("classifies adapter exceptions without inventing successful settlement", async () => {
    const registry = new HabitExecutionRegistry()
    registry.register(adapter("throwing-adapter", {
      invoke: async () => { throw new Error("adapter exploded") },
    }))

    await expect(dispatchHabitExecution({
      registry,
      envelope: {
        version: 1,
        adapter: "throwing-adapter",
        config: {},
        policy: { maxOccurrenceAttempts: 3, unknownSlotFence: "none" },
      },
      invocation: invocation(),
    })).rejects.toMatchObject<Partial<HabitAdapterInvocationError>>({
      name: "HabitAdapterInvocationError",
      unknownReason: "adapter_exception",
    })
  })

  it("preserves deliberate classifications and normalizes non-Error throws", async () => {
    const classified = new HabitExecutionRegistry()
    classified.register(adapter("classified-adapter", {
      invoke: async () => { throw new HabitAdapterInvocationError("adapter_transport_unknown", "already classified") },
    }))
    await expect(dispatchHabitExecution({
      registry: classified,
      envelope: {
        version: 1,
        adapter: "classified-adapter",
        config: {},
        policy: { maxOccurrenceAttempts: 3, unknownSlotFence: "none" },
      },
      invocation: invocation(),
    })).rejects.toMatchObject({ unknownReason: "adapter_transport_unknown", message: "already classified" })

    const raw = new HabitExecutionRegistry()
    raw.register(adapter("raw-adapter", { invoke: async () => { throw "raw failure" } }))
    await expect(dispatchHabitExecution({
      registry: raw,
      envelope: {
        version: 1,
        adapter: "raw-adapter",
        config: {},
        policy: { maxOccurrenceAttempts: 3, unknownSlotFence: "none" },
      },
      invocation: invocation(),
    })).rejects.toThrow(/raw failure/i)
  })

  it("preserves explicit schema-valid unknown outcomes and their evidence", async () => {
    const registry = new HabitExecutionRegistry()
    registry.register(adapter("unknown-adapter", {
      invoke: async () => ({
        version: 1,
        disposition: "outcome_unknown",
        reason: "adapter_reported_unknown",
        evidence: {
          kind: "adapter-owned",
          ref: "evidence:unknown-a",
          sha256: "a".repeat(64),
          observedAt: "2026-07-24T12:00:10.000Z",
        },
      }),
    }))

    await expect(dispatchHabitExecution({
      registry,
      envelope: {
        version: 1,
        adapter: "unknown-adapter",
        config: {},
        policy: { maxOccurrenceAttempts: 3, unknownSlotFence: "habit" },
      },
      invocation: invocation(),
    })).resolves.toMatchObject({
      disposition: "outcome_unknown",
      reason: "adapter_reported_unknown",
      evidence: { ref: "evidence:unknown-a" },
    })
  })

  it("classifies absent and schema-invalid invocation results as unknown", async () => {
    for (const [returned, reason] of [
      [undefined, "result_absent"],
      [{ version: 1, disposition: "settled" }, "result_absent"],
      [{ version: 1, disposition: "settled", result: { version: 1, status: "completed", resultRef: "" } }, "invalid_result"],
      [{ version: 1, disposition: "unrecognized" }, "invalid_result"],
    ] as const) {
      const registry = new HabitExecutionRegistry()
      registry.register(adapter("invalid-result", { invoke: vi.fn(async () => returned) as never }))

      await expect(dispatchHabitExecution({
        registry,
        envelope: {
          version: 1,
          adapter: "invalid-result",
          config: {},
          policy: { maxOccurrenceAttempts: 3, unknownSlotFence: "none" },
        },
        invocation: invocation(),
      })).rejects.toMatchObject({ unknownReason: reason })
    }
  })

  it("runs reconciliation only through the recorded resolved adapter and validates its result", async () => {
    const reconcileInput: HabitReconciliationInputV1<Record<string, unknown>> = {
      schemaVersion: 1,
      agent: "agent-a",
      bundleRoot: "/bundles/agent-a.ouro",
      habitId: "inventory-refresh",
      config: { normalized: true },
      occurrenceId: "occurrence-a",
      attemptId: "attempt-a",
      unknownReason: "adapter_reported_unknown",
      priorEvidence: [{
        kind: "adapter-owned",
        ref: "evidence:prior",
        sha256: "a".repeat(64),
        observedAt: "2026-07-24T12:00:00.000Z",
      }],
    }
    const reconcile = vi.fn(async () => ({
      version: 1 as const,
      disposition: "completed" as const,
      resultRef: "result:reconciled",
      evidence: {
        kind: "adapter-owned" as const,
        ref: "evidence:completed",
        sha256: "b".repeat(64),
        observedAt: "2026-07-24T12:01:00.000Z",
      },
    }))
    const registered = { ...adapter("reconciling"), reconcile }
    const registry = new HabitExecutionRegistry()
    registry.register(registered)
    const resolved = registry.resolve({
      version: 1,
      adapter: "reconciling",
      config: { raw: true },
      policy: { maxOccurrenceAttempts: 3, unknownSlotFence: "habit" },
    })

    await expect(reconcileResolvedHabitExecution({ resolved, input: reconcileInput }))
      .resolves.toMatchObject({ disposition: "completed", resultRef: "result:reconciled" })
    expect(reconcile).toHaveBeenCalledWith({ ...reconcileInput, config: { raw: true } })
  })

  it("leaves missing reconciliation unresolved and rejects malformed reconciliation authority", async () => {
    const registry = new HabitExecutionRegistry()
    registry.register(adapter("no-reconciliation"))
    const resolved = registry.resolve({
      version: 1,
      adapter: "no-reconciliation",
      config: {},
      policy: { maxOccurrenceAttempts: 3, unknownSlotFence: "habit" },
    })
    const input: HabitReconciliationInputV1<Record<string, unknown>> = {
      schemaVersion: 1,
      agent: "agent-a",
      bundleRoot: "/bundles/agent-a.ouro",
      habitId: "inventory-refresh",
      config: {},
      occurrenceId: "occurrence-a",
      attemptId: "attempt-a",
      unknownReason: "owner_died",
      priorEvidence: [],
    }

    await expect(reconcileResolvedHabitExecution({ resolved, input }))
      .resolves.toEqual({ version: 1, disposition: "unresolved" })

    const malformed = {
      ...adapter("malformed-reconciliation"),
      reconcile: vi.fn(async () => ({ version: 1, disposition: "completed", resultRef: "missing-evidence" })) as never,
    }
    const malformedRegistry = new HabitExecutionRegistry()
    malformedRegistry.register(malformed)
    await expect(reconcileResolvedHabitExecution({
      resolved: malformedRegistry.resolve({
        version: 1,
        adapter: "malformed-reconciliation",
        config: {},
        policy: { maxOccurrenceAttempts: 3, unknownSlotFence: "habit" },
      }),
      input,
    })).rejects.toThrow(/reconciliation.*invalid/i)

    const throwing = {
      ...adapter("throwing-reconciliation"),
      reconcile: vi.fn(async () => { throw "raw reconciliation failure" }),
    }
    const throwingRegistry = new HabitExecutionRegistry()
    throwingRegistry.register(throwing)
    await expect(reconcileResolvedHabitExecution({
      resolved: throwingRegistry.resolve({
        version: 1,
        adapter: "throwing-reconciliation",
        config: {},
        policy: { maxOccurrenceAttempts: 3, unknownSlotFence: "habit" },
      }),
      input,
    })).rejects.toThrow(/raw reconciliation failure/)
  })
})

describe("packaged habit adapter composition", () => {
  it("registers only the supplied generic framework adapters", () => {
    const agentTurn = adapter("agent-turn")
    const mcpTool = adapter("mcp-tool")
    const registry = createPackagedHabitExecutionRegistry({ agentTurn, mcpTool })

    expect(registry.keys()).toEqual([
      { id: "agent-turn", version: 1 },
      { id: "mcp-tool", version: 1 },
    ])
  })

  it("rejects mislabeled composition dependencies", () => {
    expect(() => createPackagedHabitExecutionRegistry({
      agentTurn: adapter("not-agent-turn"),
      mcpTool: adapter("mcp-tool"),
    })).toThrow(/agent-turn/i)
    expect(() => createPackagedHabitExecutionRegistry({
      agentTurn: adapter("agent-turn"),
      mcpTool: adapter("not-mcp-tool"),
    })).toThrow(/mcp-tool/i)
  })
})
