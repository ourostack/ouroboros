import { describe, expect, it, vi } from "vitest"

import type { ApprovalRecord, ApprovalState } from "../../heart/approval-store"
import type { ApprovalSuspensionCheckpoint } from "../../heart/tool-approval"

const APPROVAL_ID = "11111111-1111-4111-8111-111111111111"
const REVISION = "f".repeat(64)

async function subject(): Promise<any> {
  return import("../../heart/approval-continuation")
}

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
    const { materializeApprovalTerminal } = await subject()

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
    const { materializeApprovalTerminal } = await subject()
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

  it.each([
    ["expired", false, "expired before execution"],
    ["drifted", false, "approval became invalid before execution"],
    ["abandoned_before_attempt", false, "approval was abandoned before execution"],
    ["attempted_indeterminate", false, "may have executed; do not retry"],
  ] as const)("projects %s without provider resume and with a safe direct notice", async (state, resumeProvider, notice) => {
    const { materializeApprovalTerminal } = await subject()
    const projected = materializeApprovalTerminal({
      messages: checkpoint().preCallMessages,
      checkpoint: checkpoint(),
      record: record(state, state === "attempted_indeterminate" ? "execution may have occurred" : null),
      currentSessionRevision: REVISION,
    })

    expect(projected.resumeProvider).toBe(resumeProvider)
    expect(projected.directNotice).toContain(notice)
    expect(projected.directNotice).not.toContain("decisionToken")
    if (state === "attempted_indeterminate") {
      expect(projected.messages.at(-1)).toEqual(expect.objectContaining({
        role: "tool",
        tool_call_id: "call_restart",
        content: expect.stringContaining("do not retry"),
      }))
      expect(projected.severity).toBe("high")
    }
  })

  it("never inserts the frozen call into an advanced transcript for session-head-changed", async () => {
    const { materializeApprovalTerminal } = await subject()
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
})

describe("same-loop approval continuation", () => {
  it("restores the frozen call after delay, resumes runAgent from its tool result, persists, then delivers", async () => {
    const { resumeApprovalContinuation } = await subject()
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
    const callbacks = { onTextChunk: vi.fn() }

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
      claimContinuation: vi.fn(() => true),
    })

    expect(runAgent).toHaveBeenCalledTimes(1)
    expect(runAgent.mock.calls[0]![0].filter((message: any) => message.role === "user")).toHaveLength(1)
    expect(persist).toHaveBeenCalledTimes(1)
    expect(deliver).toHaveBeenCalledWith("calibre-web is back up")
    expect(persist.mock.invocationCallOrder[0]).toBeLessThan(deliver.mock.invocationCallOrder[0]!)
    expect(result.outcome).toBe("settled")
  })

  it("restarts from durable checkpoint state without replaying the originating provider work or handler", async () => {
    const { resumeApprovalContinuation } = await subject()
    const execute = vi.fn()
    const runAgent = vi.fn(async (messages: any[]) => {
      expect(messages.filter((message: any) => message.role === "user" && message.content === "restart calibre-web")).toHaveLength(1)
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
      claimContinuation: vi.fn(() => true),
    })

    expect(execute).not.toHaveBeenCalled()
    expect(runAgent).toHaveBeenCalledTimes(1)
  })

  it("does not resume the provider twice when continuation eligibility was already consumed", async () => {
    const { resumeApprovalContinuation } = await subject()
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
      claimContinuation: vi.fn(() => false),
    })

    expect(runAgent).not.toHaveBeenCalled()
    expect(result.outcome).toBe("already_continued")
  })

  it("does not route a suspended checkpoint through ordinary orphan repair", async () => {
    const { resumeApprovalContinuation } = await subject()
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
      claimContinuation: vi.fn(() => true),
    })).resolves.toMatchObject({ outcome: "settled" })
    expect(repairOrphans).not.toHaveBeenCalled()
  })
})
