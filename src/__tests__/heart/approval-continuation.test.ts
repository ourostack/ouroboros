import { describe, expect, it, vi } from "vitest"

import type { ApprovalRecord, ApprovalState } from "../../heart/approval-store"
import type { ApprovalSuspensionCheckpoint } from "../../heart/tool-approval"
import * as core from "../../heart/core"
import * as sessionEvents from "../../heart/session-events"

const APPROVAL_ID = "11111111-1111-4111-8111-111111111111"
const REVISION = "f".repeat(64)

function assistantMessage() {
  return {
    role: "assistant" as const,
    content: null,
    tool_calls: [{
      id: "call_restart",
      type: "function" as const,
      function: { name: "shell", arguments: "{\"command\":\"docker restart calibre-web\"}" },
    }],
  }
}

function checkpoint(): ApprovalSuspensionCheckpoint {
  return {
    approvalId: APPROVAL_ID,
    checkpointDigest: "e".repeat(64),
    baseSessionRevision: "d".repeat(64),
    suspendedSessionRevision: REVISION,
    argumentDigest: "1".repeat(64),
    schemaDigest: "a".repeat(64),
    toolDigest: "b".repeat(64),
    policyDigest: "c".repeat(64),
    preCallDigest: "2".repeat(64),
    preCallMessages: [
      { role: "system", content: "system" },
      { role: "user", content: "restart calibre-web" },
    ],
    frozenAssistantMessage: assistantMessage(),
  }
}

function continuationLifecycle() {
  return {
    markContinuationMaterialized: vi.fn(),
    markContinuationAttempted: vi.fn(),
    completeContinuation: vi.fn(),
  }
}

function continuationClaim(
  claimed: boolean,
  continuationState: "claimed" | "materialized" | "attempted" | "completed" = "claimed",
  interruptedAfterAttempt = false,
) {
  return { claimed, interruptedAfterAttempt, record: { continuationState } as any }
}

function record(state: ApprovalState, result: string | null = null): ApprovalRecord {
  return {
    approvalId: APPROVAL_ID,
    state,
    toolCallId: "call_restart",
    toolName: "shell",
    arguments: { command: "docker restart calibre-web" },
    argumentDigest: "1".repeat(64),
    schemaDigest: "a".repeat(64),
    toolDigest: "b".repeat(64),
    policyDigest: "c".repeat(64),
    policyId: "shell.docker-lifecycle.v1",
    sessionKey: "telegram:chat-7",
    sessionPath: "/tmp/disposable/session.json",
    baseSessionRevision: "d".repeat(64),
    suspendedSessionRevision: REVISION,
    checkpointDigest: "e".repeat(64),
    requesterId: "friend-ari",
    transport: "telegram",
    transportUserId: "42",
    transportChatId: "7",
    transportMessageId: "99",
    decisionTokenDigest: "9".repeat(64),
    expiresAt: "2026-08-17T18:30:00.000Z",
    createdAt: "2026-08-17T17:30:00.000Z",
    updatedAt: "2026-08-17T17:31:00.000Z",
    ownerId: state === "claimed" || state === "attempted" || state === "succeeded" || state === "failed" || state === "attempted_indeterminate" ? "owner-a" : null,
    epoch: state === "proposed" ? 0 : 1,
    attemptedAt: state === "attempted" || state === "succeeded" || state === "failed" || state === "attempted_indeterminate" ? "2026-08-17T17:31:00.000Z" : null,
    result,
    reason: state === "session_head_changed" ? "suspended session revision changed" : null,
    frozenAssistantMessage: assistantMessage(),
  }
}

describe("approval terminal transcript projection", () => {
  it.each([
    ["succeeded", "restarted", "restarted", true],
    ["failed", "error: restart refused", "error: restart refused", true],
    ["denied", null, "approval denied by requester; the protected action was not executed", true],
  ] as const)("materializes one exact correlated pair for %s and marks provider resume eligibility", async (state, result, expected, resumeProvider) => {
    const materializeApprovalTerminal = (sessionEvents as any).materializeApprovalTerminal

    const materialized = materializeApprovalTerminal({
      messages: checkpoint().preCallMessages,
      checkpoint: checkpoint(),
      record: record(state, result),
      currentSessionRevision: REVISION,
    })

    expect(materialized.materialized).toBe(true)
    expect(materialized.resumeProvider).toBe(resumeProvider)
    expect(materialized.messages).toEqual([
      ...checkpoint().preCallMessages,
      assistantMessage(),
      { role: "tool", tool_call_id: "call_restart", content: expected },
    ])
    expect(JSON.stringify(materialized.messages)).not.toContain("tool call's result was lost")
  })

  it("is idempotent by approval id and never inserts a duplicate assistant/tool pair", async () => {
    const materializeApprovalTerminal = (sessionEvents as any).materializeApprovalTerminal
    const first = materializeApprovalTerminal({
      messages: checkpoint().preCallMessages,
      checkpoint: checkpoint(),
      record: record("succeeded", "restarted"),
      currentSessionRevision: REVISION,
    })
    const second = materializeApprovalTerminal({
      messages: first.messages,
      checkpoint: checkpoint(),
      record: record("succeeded", "restarted"),
      currentSessionRevision: first.revision,
      materializedApprovalIds: [APPROVAL_ID],
    })

    expect(second.materialized).toBe(false)
    expect(second.messages.filter((message: any) => message.role === "assistant")).toHaveLength(1)
    expect(second.messages.filter((message: any) => message.role === "tool" && message.tool_call_id === "call_restart")).toHaveLength(1)
  })

  it("honors a durable approval-id marker without requiring a projected pair in the current view", async () => {
    const materializeApprovalTerminal = (sessionEvents as any).materializeApprovalTerminal
    const projected = materializeApprovalTerminal({
      messages: checkpoint().preCallMessages,
      checkpoint: checkpoint(),
      record: record("expired"),
      currentSessionRevision: REVISION,
      materializedApprovalIds: [APPROVAL_ID],
    })

    expect(projected).toMatchObject({
      materialized: false,
      resumeProvider: false,
      directNotice: "approval expired before execution; the protected action was not executed",
    })
    expect(projected.messages).toEqual(checkpoint().preCallMessages)
  })

  it.each([
    ["expired", false, "approval expired before execution; the protected action was not executed"],
    ["drifted", false, "approval became invalid before execution; the protected action was not executed"],
    ["abandoned_before_attempt", false, "approval was abandoned before execution; the protected action was not executed; request a fresh approval"],
    ["attempted_indeterminate", false, "execution may have occurred; do not retry automatically"],
  ] as const)("projects %s without provider resume and with a safe direct notice", async (state, resumeProvider, canonicalResult) => {
    const materializeApprovalTerminal = (sessionEvents as any).materializeApprovalTerminal
    const projected = materializeApprovalTerminal({
      messages: checkpoint().preCallMessages,
      checkpoint: checkpoint(),
      record: record(state, state === "attempted_indeterminate" ? "execution may have occurred" : null),
      currentSessionRevision: REVISION,
    })

    expect(projected.resumeProvider).toBe(resumeProvider)
    expect(projected.directNotice).toBe(canonicalResult)
    expect(projected.directNotice).not.toContain("decisionToken")
    expect(projected.materialized).toBe(true)
    expect(projected.messages).toEqual([
      ...checkpoint().preCallMessages,
      assistantMessage(),
      { role: "tool", tool_call_id: "call_restart", content: canonicalResult },
    ])
    if (state === "attempted_indeterminate") {
      expect(projected.messages.at(-1)).toEqual(expect.objectContaining({
        role: "tool",
        tool_call_id: "call_restart",
        content: "execution may have occurred; do not retry automatically",
      }))
      expect(projected.severity).toBe("high")
    }
  })

  it("never inserts the frozen call into an advanced transcript for session-head-changed", async () => {
    const materializeApprovalTerminal = (sessionEvents as any).materializeApprovalTerminal
    const advanced = [...checkpoint().preCallMessages, { role: "user" as const, content: "actually, stop" }]
    const projected = materializeApprovalTerminal({
      messages: advanced,
      checkpoint: checkpoint(),
      record: record("session_head_changed"),
      currentSessionRevision: "0".repeat(64),
    })

    expect(projected.materialized).toBe(false)
    expect(projected.resumeProvider).toBe(false)
    expect(projected.messages).toEqual(advanced)
    expect(projected.directNotice).toContain("session changed")
  })

  it("authenticates and reuses the exact frozen pair after a crash advanced the persisted revision", async () => {
    const materializeApprovalTerminal = (sessionEvents as any).materializeApprovalTerminal
    const persistedPair = [
      ...checkpoint().preCallMessages,
      assistantMessage(),
      { role: "tool" as const, tool_call_id: "call_restart", content: "restarted" },
    ]

    const projected = materializeApprovalTerminal({
      messages: persistedPair,
      checkpoint: checkpoint(),
      record: record("succeeded", "restarted"),
      currentSessionRevision: "0".repeat(64),
    })

    expect(projected).toMatchObject({ materialized: false, resumeProvider: true, messages: persistedPair })
    expect(projected.messages.filter((message: any) => message.role === "tool" && message.tool_call_id === "call_restart")).toHaveLength(1)
  })

  it("authenticates the canonical persisted tail when private reasoning fields and absent content were normalized", async () => {
    const materializeApprovalTerminal = (sessionEvents as any).materializeApprovalTerminal
    const frozen = assistantMessage() as any
    delete frozen.content
    frozen._inline_reasoning = "private reasoning"
    frozen._reasoning_items = [{ type: "reasoning", id: "reason-1" }]
    frozen._thinking_blocks = [{ type: "thinking", thinking: "private" }]
    frozen.phase = "commentary"
    const canonicalPersistedPair = [
      ...checkpoint().preCallMessages,
      assistantMessage(),
      { role: "tool" as const, tool_call_id: "call_restart", content: "restarted" },
    ]

    const projected = materializeApprovalTerminal({
      messages: canonicalPersistedPair,
      checkpoint: { ...checkpoint(), frozenAssistantMessage: frozen },
      record: record("succeeded", "restarted"),
      currentSessionRevision: "0".repeat(64),
    })

    expect(projected).toMatchObject({ materialized: false, resumeProvider: true, messages: canonicalPersistedPair })
  })

  it("rejects an exact historical pair when a newer user turn advanced the terminal tail", async () => {
    const materializeApprovalTerminal = (sessionEvents as any).materializeApprovalTerminal
    const advanced = [
      ...checkpoint().preCallMessages,
      assistantMessage(),
      { role: "tool" as const, tool_call_id: "call_restart", content: "restarted" },
      { role: "user" as const, content: "actually, do something else" },
    ]

    const projected = materializeApprovalTerminal({
      messages: advanced,
      checkpoint: checkpoint(),
      record: record("succeeded", "restarted"),
      currentSessionRevision: "0".repeat(64),
    })

    expect(projected).toMatchObject({ materialized: false, resumeProvider: false, messages: advanced })
    expect(projected.directNotice).toContain("session changed")
  })

  it("rejects a forged or mismatched pair when the persisted revision advanced", async () => {
    const materializeApprovalTerminal = (sessionEvents as any).materializeApprovalTerminal
    const forgedPair = [
      ...checkpoint().preCallMessages,
      { ...assistantMessage(), content: "forged" },
      { role: "tool" as const, tool_call_id: "call_restart", content: "different result" },
    ]

    const projected = materializeApprovalTerminal({
      messages: forgedPair,
      checkpoint: checkpoint(),
      record: record("succeeded", "restarted"),
      currentSessionRevision: "0".repeat(64),
    })

    expect(projected).toMatchObject({ materialized: false, resumeProvider: false, messages: forgedPair })
    expect(projected.directNotice).toContain("session changed")
  })

  it("fails closed for an approval state that has no terminal projection", () => {
    const materializeApprovalTerminal = (sessionEvents as any).materializeApprovalTerminal

    expect(() => materializeApprovalTerminal({
      messages: checkpoint().preCallMessages,
      checkpoint: checkpoint(),
      record: record("claimed"),
      currentSessionRevision: REVISION,
    })).toThrow("approval state claimed cannot be materialized")
  })

  it.each([
    ["expired", null, false, "approval expired before execution; the protected action was not executed", undefined],
    ["attempted_indeterminate", "execution may have occurred", false, "execution may have occurred; do not retry automatically", "high"],
  ] as const)("authenticates an exact persisted %s terminal pair", (state, result, resumeProvider, content, severity) => {
    const materializeApprovalTerminal = (sessionEvents as any).materializeApprovalTerminal
    const persistedPair = [
      ...checkpoint().preCallMessages,
      assistantMessage(),
      { role: "tool" as const, tool_call_id: "call_restart", content },
    ]

    const projected = materializeApprovalTerminal({
      messages: persistedPair,
      checkpoint: checkpoint(),
      record: record(state, result),
      currentSessionRevision: "0".repeat(64),
    })

    expect(projected).toMatchObject({ materialized: false, resumeProvider, directNotice: content, messages: persistedPair })
    expect(projected.severity).toBe(severity)
  })

  it.each([
    ["succeeded", "restarted", true, undefined, undefined],
    ["attempted_indeterminate", "execution may have occurred", false, "execution may have occurred; do not retry automatically", "high"],
  ] as const)("honors a durable approval-id marker for %s", (state, result, resumeProvider, directNotice, severity) => {
    const materializeApprovalTerminal = (sessionEvents as any).materializeApprovalTerminal
    const projected = materializeApprovalTerminal({
      messages: checkpoint().preCallMessages,
      checkpoint: checkpoint(),
      record: record(state, result),
      currentSessionRevision: REVISION,
      materializedApprovalIds: [APPROVAL_ID],
    })

    expect(projected).toMatchObject({ materialized: false, resumeProvider, messages: checkpoint().preCallMessages })
    expect(projected.directNotice).toBe(directNotice)
    expect(projected.severity).toBe(severity)
  })

  it("does not authenticate a partial terminal pair", () => {
    const materializeApprovalTerminal = (sessionEvents as any).materializeApprovalTerminal
    const projected = materializeApprovalTerminal({
      messages: [assistantMessage()],
      checkpoint: checkpoint(),
      record: record("succeeded", "restarted"),
      currentSessionRevision: "0".repeat(64),
    })

    expect(projected).toMatchObject({ materialized: false, resumeProvider: false })
    expect(projected.directNotice).toContain("session changed")
  })
})

describe("same-loop approval continuation", () => {
  it("restores the frozen call after delay, resumes runAgent from its tool result, persists, then delivers", async () => {
    const resumeApprovalContinuation = (core as any).resumeApprovalContinuation
    const runAgent = vi.fn(async (messages: any[], callbacks: any) => {
      expect(messages).toEqual([
        ...checkpoint().preCallMessages,
        assistantMessage(),
        { role: "tool", tool_call_id: "call_restart", content: "restarted" },
      ])
      callbacks.onTextChunk("calibre-web is back up")
      messages.push({ role: "assistant", content: "calibre-web is back up" })
      return { outcome: "settled" as const }
    })
    const persist = vi.fn()
    const deliver = vi.fn()
    const callbacks = {
      onTextChunk: vi.fn(),
      onClearText: vi.fn(),
      flushNow: vi.fn(),
      settleOutputMode: vi.fn(),
    }

    const result = await resumeApprovalContinuation({
      record: record("succeeded", "restarted"),
      checkpoint: checkpoint(),
      currentSessionRevision: REVISION,
      sessionMessages: checkpoint().preCallMessages,
      callbacks,
      channel: "telegram",
      runAgent,
      persist,
      deliver,
      claimContinuation: vi.fn(() => continuationClaim(true)),
      ...continuationLifecycle(),
    })

    expect(runAgent).toHaveBeenCalledTimes(1)
    expect(runAgent.mock.calls[0]![0].filter((message: any) => message.role === "user")).toHaveLength(1)
    expect(persist).toHaveBeenCalledTimes(2)
    expect(persist.mock.invocationCallOrder[0]).toBeLessThan(runAgent.mock.invocationCallOrder[0]!)
    expect(deliver).toHaveBeenCalledWith("calibre-web is back up")
    expect(persist.mock.invocationCallOrder[0]).toBeLessThan(deliver.mock.invocationCallOrder[0]!)
    expect(result.outcome).toBe("settled")
  })

  it("completes a non-resumable terminal continuation after delivering its direct notice", async () => {
    const resumeApprovalContinuation = (core as any).resumeApprovalContinuation
    const lifecycle = continuationLifecycle()
    const runAgent = vi.fn()
    const persist = vi.fn()
    const deliver = vi.fn()

    const result = await resumeApprovalContinuation({
      record: record("expired"),
      checkpoint: checkpoint(),
      currentSessionRevision: REVISION,
      sessionMessages: checkpoint().preCallMessages,
      callbacks: {},
      runAgent,
      persist,
      deliver,
      claimContinuation: () => continuationClaim(true),
      ...lifecycle,
    })

    expect(result.outcome).toBe("terminal_notice")
    expect(runAgent).not.toHaveBeenCalled()
    expect(deliver).toHaveBeenCalledWith("approval expired before execution; the protected action was not executed")
    expect(lifecycle.completeContinuation).toHaveBeenCalledTimes(1)
  })

  it("restarts from durable checkpoint state without replaying the originating provider work or handler", async () => {
    const resumeApprovalContinuation = (core as any).resumeApprovalContinuation
    const execute = vi.fn()
    const runAgent = vi.fn(async (messages: any[], callbacks: any) => {
      expect(messages.filter((message: any) => message.role === "user" && message.content === "restart calibre-web")).toHaveLength(1)
      callbacks.onModelStart()
      return { outcome: "settled" as const }
    })

    await resumeApprovalContinuation({
      record: record("succeeded", "restarted"),
      checkpoint: structuredClone(checkpoint()),
      currentSessionRevision: REVISION,
      sessionMessages: structuredClone(checkpoint().preCallMessages),
      callbacks: { onTextChunk: vi.fn() },
      channel: "telegram",
      runAgent,
      execute,
      persist: vi.fn(),
      deliver: vi.fn(),
      claimContinuation: vi.fn(() => continuationClaim(true)),
      ...continuationLifecycle(),
    })

    expect(execute).not.toHaveBeenCalled()
    expect(runAgent).toHaveBeenCalledTimes(1)
  })

  it("recovers a durably materialized pre-attempt continuation without duplicating its pair", async () => {
    const resumeApprovalContinuation = (core as any).resumeApprovalContinuation
    const lifecycle = continuationLifecycle()
    const persistedPair = [
      ...checkpoint().preCallMessages,
      checkpoint().frozenAssistantMessage,
      { role: "tool" as const, tool_call_id: "call_restart", content: "restarted" },
    ]
    const persist = vi.fn()
    const runAgent = vi.fn(async (messages: any[]) => {
      expect(messages.filter((message) => message.role === "tool" && message.tool_call_id === "call_restart")).toHaveLength(1)
      return { outcome: "settled" as const }
    })

    await resumeApprovalContinuation({
      record: record("succeeded", "restarted"),
      checkpoint: checkpoint(),
      currentSessionRevision: REVISION,
      sessionMessages: persistedPair,
      callbacks: {},
      runAgent,
      persist,
      deliver: vi.fn(),
      claimContinuation: () => continuationClaim(true, "materialized"),
      ...lifecycle,
    })

    expect(lifecycle.markContinuationMaterialized).not.toHaveBeenCalled()
    expect(lifecycle.markContinuationAttempted).toHaveBeenCalledTimes(1)
    expect(persist).toHaveBeenCalledTimes(1)
  })

  it("recovers a claimed continuation after its exact pair persisted but its phase marker did not", async () => {
    const resumeApprovalContinuation = (core as any).resumeApprovalContinuation
    const lifecycle = continuationLifecycle()
    const persistedPair = [
      ...checkpoint().preCallMessages,
      assistantMessage(),
      { role: "tool" as const, tool_call_id: "call_restart", content: "restarted" },
    ]
    const runAgent = vi.fn(async () => ({ outcome: "settled" as const }))
    const persist = vi.fn()

    const result = await resumeApprovalContinuation({
      record: record("succeeded", "restarted"),
      checkpoint: checkpoint(),
      currentSessionRevision: "0".repeat(64),
      sessionMessages: persistedPair,
      callbacks: {},
      runAgent,
      persist,
      deliver: vi.fn(),
      claimContinuation: () => continuationClaim(true, "claimed"),
      ...lifecycle,
    })

    expect(result.outcome).toBe("settled")
    expect(runAgent).toHaveBeenCalledTimes(1)
    expect(runAgent.mock.calls[0]![0].filter((message: any) => message.role === "tool" && message.tool_call_id === "call_restart")).toHaveLength(1)
    expect(lifecycle.markContinuationMaterialized).toHaveBeenCalledTimes(1)
  })

  it("does not resume the provider twice when continuation eligibility was already consumed", async () => {
    const resumeApprovalContinuation = (core as any).resumeApprovalContinuation
    const runAgent = vi.fn()
    const result = await resumeApprovalContinuation({
      record: record("succeeded", "restarted"),
      checkpoint: checkpoint(),
      currentSessionRevision: REVISION,
      sessionMessages: checkpoint().preCallMessages,
      callbacks: { onTextChunk: vi.fn() },
      channel: "telegram",
      runAgent,
      persist: vi.fn(),
      deliver: vi.fn(),
      claimContinuation: vi.fn(() => continuationClaim(false)),
      ...continuationLifecycle(),
    })

    expect(runAgent).not.toHaveBeenCalled()
    expect(result.outcome).toBe("already_continued")
  })

  it("surfaces an atomically terminalized dead-owner post-attempt continuation without retrying provider work", async () => {
    const resumeApprovalContinuation = (core as any).resumeApprovalContinuation
    const runAgent = vi.fn()
    const persist = vi.fn()
    const deliver = vi.fn()

    const result = await resumeApprovalContinuation({
      record: record("succeeded", "restarted"),
      checkpoint: checkpoint(),
      currentSessionRevision: "0".repeat(64),
      sessionMessages: checkpoint().preCallMessages,
      callbacks: {},
      runAgent,
      persist,
      deliver,
      claimContinuation: () => continuationClaim(false, "completed", true),
      ...continuationLifecycle(),
    })

    expect(result.outcome).toBe("terminal_notice")
    expect(runAgent).not.toHaveBeenCalled()
    expect(persist).not.toHaveBeenCalled()
    expect(deliver).toHaveBeenCalledWith("the approval continuation was interrupted after provider work began; its outcome is indeterminate and it will not be retried automatically")
  })

  it("does not route a suspended checkpoint through ordinary orphan repair", async () => {
    const resumeApprovalContinuation = (core as any).resumeApprovalContinuation
    const repairOrphans = vi.fn(() => { throw new Error("ordinary orphan repair must not run") })

    await expect(resumeApprovalContinuation({
      record: record("succeeded", "restarted"),
      checkpoint: checkpoint(),
      currentSessionRevision: REVISION,
      sessionMessages: checkpoint().preCallMessages,
      callbacks: { onTextChunk: vi.fn() },
      channel: "telegram",
      runAgent: vi.fn(async () => ({ outcome: "settled" as const })),
      persist: vi.fn(),
      deliver: vi.fn(),
      repairOrphans,
      claimContinuation: vi.fn(() => continuationClaim(true)),
      ...continuationLifecycle(),
    })).resolves.toMatchObject({ outcome: "settled" })
    expect(repairOrphans).not.toHaveBeenCalled()
  })

  it("does not ordinary-persist or deliver when the resumed provider suspends again", async () => {
    const resumeApprovalContinuation = (core as any).resumeApprovalContinuation
    const persist = vi.fn(async () => undefined)
    const deliver = vi.fn(async () => undefined)
    const suspension = { approvalId: "22222222-2222-4222-8222-222222222222" } as any

    const result = await resumeApprovalContinuation({
      record: record("succeeded", "restarted"),
      checkpoint: checkpoint(),
      currentSessionRevision: REVISION,
      sessionMessages: checkpoint().preCallMessages,
      callbacks: {},
      runAgent: vi.fn(async () => ({ outcome: "suspended" as const, suspension })),
      persist,
      deliver,
      claimContinuation: () => continuationClaim(true),
      ...continuationLifecycle(),
    })

    expect(result).toMatchObject({ outcome: "suspended", suspension })
    expect(persist).toHaveBeenCalledTimes(1)
    expect(deliver).not.toHaveBeenCalled()
  })
})
