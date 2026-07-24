import { describe, expect, it, vi } from "vitest"

import type { HabitInvocationV1 } from "../../../heart/habits/habit-execution"
import {
  createAgentTurnAdapter,
  type AgentTurnHabitRequestV1,
  type AgentTurnHabitResponseV1,
} from "../../../heart/habits/agent-turn-adapter"

function invocation(): HabitInvocationV1<Record<string, never>> {
  return {
    schemaVersion: 1,
    agent: "agent-a",
    bundleRoot: "/bundles/agent-a.ouro",
    habit: {
      id: "daily-review",
      title: "Daily review",
      body: "Review current work.",
      tools: ["read_file"],
      continuity: { mode: "stateful" },
    },
    config: {},
    occurrenceId: "occurrence-a",
    attemptId: "attempt-a",
    trigger: {
      kind: "launchd",
      observedAt: "2026-07-24T12:00:00.000Z",
      scheduleProofRef: "proof:schedule-a",
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

function settledResponse(request: AgentTurnHabitRequestV1): AgentTurnHabitResponseV1 {
  return {
    schemaVersion: 1,
    occurrenceId: request.occurrenceId,
    attemptId: request.attemptId,
    responseCapability: request.responseCapability,
    outcome: {
      version: 1,
      disposition: "settled",
      result: { version: 1, status: "completed", resultRef: "result:durable-turn-a" },
    },
  }
}

describe("agent-turn habit adapter", () => {
  it("accepts only an empty adapter configuration", () => {
    const adapter = createAgentTurnAdapter({
      randomBytes: () => Buffer.alloc(32, 7),
      request: vi.fn(),
    })

    expect(adapter.validateConfig({})).toEqual({})
    expect(() => adapter.validateConfig({ command: "run-this" })).toThrow(/unknown|empty/i)
  })

  it("sends exact occurrence correlation and a random response capability", async () => {
    const request = vi.fn(async (message: AgentTurnHabitRequestV1) => settledResponse(message))
    const adapter = createAgentTurnAdapter({
      randomBytes: () => Buffer.from("11".repeat(32), "hex"),
      request,
    })

    await expect(adapter.invoke(invocation())).resolves.toMatchObject({
      disposition: "settled",
      result: { status: "completed", resultRef: "result:durable-turn-a" },
    })
    expect(request).toHaveBeenCalledWith({
      schemaVersion: 1,
      agent: "agent-a",
      habitId: "daily-review",
      occurrenceId: "occurrence-a",
      attemptId: "attempt-a",
      deadlineAt: "2026-07-24T12:01:00.000Z",
      responseCapability: "11".repeat(32),
    }, expect.any(AbortSignal))
  })

  it("does not equate wake acceptance with completed work", async () => {
    const adapter = createAgentTurnAdapter({
      randomBytes: () => Buffer.alloc(32, 9),
      request: vi.fn(async () => ({ schemaVersion: 1, accepted: true } as unknown as AgentTurnHabitResponseV1)),
    })

    await expect(adapter.invoke(invocation())).rejects.toMatchObject({
      name: "HabitAdapterInvocationError",
      unknownReason: "adapter_transport_unknown",
    })
  })

  it("remains pending after transport acceptance until the correlated result arrives", async () => {
    let deliver: ((response: AgentTurnHabitResponseV1) => void) | undefined
    let captured: AgentTurnHabitRequestV1 | undefined
    const request = vi.fn((message: AgentTurnHabitRequestV1) => {
      captured = message
      return new Promise<AgentTurnHabitResponseV1>((resolve) => { deliver = resolve })
    })
    const adapter = createAgentTurnAdapter({
      randomBytes: () => Buffer.alloc(32, 3),
      request,
    })

    let settled = false
    const pending = adapter.invoke(invocation()).finally(() => { settled = true })
    await Promise.resolve()
    expect(request).toHaveBeenCalledOnce()
    expect(settled).toBe(false)

    deliver?.(settledResponse(captured as AgentTurnHabitRequestV1))
    await expect(pending).resolves.toMatchObject({ disposition: "settled" })
  })

  it.each([
    ["occurrence", { occurrenceId: "occurrence-other" }],
    ["attempt", { attemptId: "attempt-other" }],
    ["capability", { responseCapability: "ff".repeat(32) }],
  ])("maps a mismatched %s response to transport-unknown", async (_label, replacement) => {
    const adapter = createAgentTurnAdapter({
      randomBytes: () => Buffer.alloc(32, 5),
      request: vi.fn(async (message: AgentTurnHabitRequestV1) => ({
        ...settledResponse(message),
        ...replacement,
      })),
    })

    await expect(adapter.invoke(invocation())).rejects.toMatchObject({
      name: "HabitAdapterInvocationError",
      unknownReason: "adapter_transport_unknown",
    })
  })

  it("maps disconnect, timeout, and conflicting replay to transport-unknown", async () => {
    for (const reason of ["worker disconnected", "response timeout", "conflicting response replay"]) {
      const adapter = createAgentTurnAdapter({
        randomBytes: () => Buffer.alloc(32, 6),
        request: vi.fn(async () => { throw new Error(reason) }),
      })
      await expect(adapter.invoke(invocation())).rejects.toMatchObject({
        name: "HabitAdapterInvocationError",
        unknownReason: "adapter_transport_unknown",
      })
    }
  })

  it("never asserts safe retry while reconciling an unknown agent turn", async () => {
    const adapter = createAgentTurnAdapter({
      randomBytes: () => Buffer.alloc(32, 8),
      request: vi.fn(),
    })

    await expect(adapter.reconcile?.({
      schemaVersion: 1,
      agent: "agent-a",
      bundleRoot: "/bundles/agent-a.ouro",
      habitId: "daily-review",
      config: {},
      occurrenceId: "occurrence-a",
      attemptId: "attempt-a",
      unknownReason: "adapter_transport_unknown",
      priorEvidence: [],
    })).resolves.toEqual({ version: 1, disposition: "unresolved" })
  })
})
