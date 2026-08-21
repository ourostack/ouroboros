import { describe, expect, it, vi } from "vitest"

const stores = vi.hoisted(() => ({ openCount: 0 }))

vi.mock("../../heart/approval-store", () => ({
  openApprovalStore: vi.fn(() => {
    stores.openCount += 1
    if (stores.openCount === 1) return {
      prepare: vi.fn(() => ({ record: { approvalId: "prepared", checkpointDigest: "1".repeat(64) }, decisionToken: "token" })),
      activate: vi.fn(), bindPrompt: vi.fn(),
      decide: vi.fn(() => ({ approvalId: "prepared", epoch: 1 })),
      markAttempted: vi.fn(() => ({ approvalId: "prepared", state: "attempted" })), close: vi.fn(),
    }
    return { read: vi.fn(() => undefined), close: vi.fn() }
  }),
  readApprovalsByScenarioHandleDigest: vi.fn(),
}))

vi.mock("../../heart/tool-approval", () => ({ recoverAttemptedApproval: vi.fn() }))

import { proveSanctuaryAttemptedRecoveryWithoutRetry } from "../../senses/sanctuary-interactive-control"

describe("Sanctuary attempted recovery reopen coverage", () => {
  it("fails closed when the attempted row is absent after reopen", () => {
    const approval = {
      toolCallId: "call-1", toolName: "unraid_restart_container", arguments: { container: "calibre-web" }, schemaDigest: "b".repeat(64), toolDigest: "c".repeat(64), policyDigest: "d".repeat(64), policyId: "restart",
      baseSessionRevision: "e".repeat(64), suspendedSessionRevision: "f".repeat(64), checkpointDigest: "1".repeat(64),
      frozenAssistantMessage: { role: "assistant", content: null, tool_calls: [{ id: "call-1", type: "function", function: { name: "unraid_restart_container", arguments: "{}" } }] },
    }
    expect(() => proveSanctuaryAttemptedRecoveryWithoutRetry("/tmp/reopen-missing", "a".repeat(64), approval as never))
      .toThrow("not durable across reopen")
  })
})
