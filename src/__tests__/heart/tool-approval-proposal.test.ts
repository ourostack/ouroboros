import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

import { afterEach, describe, expect, it, vi } from "vitest"

import { openApprovalStore, type ApprovalStore, type PrepareApprovalInput } from "../../heart/approval-store"
import {
  commitApprovalProposal,
  recoverApprovalProposals,
  type ApprovalSuspensionCheckpoint,
  type ApprovalSuspensionCheckpointStore,
  type ApprovalTokenStore,
} from "../../heart/tool-approval"

const UUID = "11111111-1111-4111-8111-111111111111"
const NOW = "2026-08-17T17:30:00.000Z"
const roots: string[] = []

function root(): string {
  const value = fs.mkdtempSync(path.join(os.tmpdir(), "ouro-approval-proposal-"))
  roots.push(value)
  return value
}

function store(directory = root()): ApprovalStore {
  return openApprovalStore({
    databasePath: path.join(directory, "approvals.sqlite"),
    now: () => new Date(NOW),
    randomUUID: () => UUID,
    randomBytes: (size) => Buffer.alloc(size, 0xab),
  })
}

function proposal(): PrepareApprovalInput {
  return {
    toolCallId: "call_restart",
    toolName: "shell",
    arguments: { command: "docker restart calibre-web" },
    schemaDigest: "a".repeat(64),
    toolDigest: "b".repeat(64),
    policyDigest: "c".repeat(64),
    policyId: "shell.docker-lifecycle.v1",
    sessionKey: "telegram:chat-7",
    sessionPath: "/tmp/disposable/session.json",
    baseSessionRevision: "d".repeat(64),
    checkpointDigest: "e".repeat(64),
    requesterId: "friend-ari",
    transport: "telegram",
    transportUserId: "42",
    transportChatId: "7",
    expiresAt: "2026-08-17T18:30:00.000Z",
    frozenAssistantMessage: {
      role: "assistant",
      content: null,
      tool_calls: [{
        id: "call_restart",
        type: "function",
        function: { name: "shell", arguments: "{\"command\":\"docker restart calibre-web\"}" },
      }],
    },
  }
}

function checkpointStore(attestation: { checkpointDigest: string; suspendedSessionRevision: string } = {
  checkpointDigest: "e".repeat(64),
  suspendedSessionRevision: "f".repeat(64),
}): ApprovalSuspensionCheckpointStore & { records: Map<string, ApprovalSuspensionCheckpoint> } {
  const records = new Map<string, ApprovalSuspensionCheckpoint>()
  return {
    records,
    write: vi.fn((draft) => {
      const checkpoint: ApprovalSuspensionCheckpoint = {
        ...structuredClone(draft),
        checkpointDigest: attestation.checkpointDigest,
        suspendedSessionRevision: attestation.suspendedSessionRevision,
      }
      records.set(checkpoint.approvalId, checkpoint)
      return structuredClone(attestation)
    }),
    read: vi.fn((approvalId) => structuredClone(records.get(approvalId) ?? null)),
    list: vi.fn(() => [...records.values()].map((record) => structuredClone(record))),
    remove: vi.fn((approvalId) => { records.delete(approvalId) }),
  }
}

function tokenStore(): ApprovalTokenStore & { records: Map<string, string> } {
  const records = new Map<string, string>()
  return {
    records,
    put: vi.fn((approvalId, token) => { records.set(approvalId, token) }),
    has: vi.fn((approvalId) => records.has(approvalId)),
    remove: vi.fn((approvalId) => { records.delete(approvalId) }),
  }
}

afterEach(() => {
  for (const directory of roots.splice(0)) fs.rmSync(directory, { recursive: true, force: true })
})

describe("approval proposal commit recovery", () => {
  it("commits token mapping and full pre-call transcript checkpoint before activation", () => {
    const approvals = store()
    const checkpoints = checkpointStore()
    const tokens = tokenStore()
    const preCallMessages = [{ role: "user" as const, content: "restart calibre-web" }]

    const committed = commitApprovalProposal({
      approvalStore: approvals,
      checkpointStore: checkpoints,
      tokenStore: tokens,
      proposal: proposal(),
      preCallMessages,
    })

    expect(committed.record.state).toBe("awaiting_prompt_binding")
    expect(tokens.records.get(UUID)).toBe(committed.decisionToken)
    expect(checkpoints.records.get(UUID)).toMatchObject({
      approvalId: UUID,
      checkpointDigest: "e".repeat(64),
      baseSessionRevision: "d".repeat(64),
      suspendedSessionRevision: "f".repeat(64),
      preCallMessages,
      frozenAssistantMessage: proposal().frozenAssistantMessage,
    })
    approvals.close()
  })

  it("abandons a journal-only half-write and never invents a decision token", () => {
    const approvals = store()
    const checkpoints = checkpointStore()
    const tokens = tokenStore()

    expect(() => commitApprovalProposal({
      approvalStore: approvals,
      checkpointStore: checkpoints,
      tokenStore: tokens,
      proposal: proposal(),
      preCallMessages: [{ role: "user", content: "restart" }],
      hooks: { afterJournalPrepare: () => { throw new Error("crash after journal") } },
    })).toThrow("crash after journal")

    expect(recoverApprovalProposals({ approvalStore: approvals, checkpointStore: checkpoints, tokenStore: tokens }))
      .toEqual([{ approvalId: UUID, state: "abandoned_before_attempt" }])
    expect(approvals.read(UUID)?.state).toBe("abandoned_before_attempt")
    expect(tokens.records.size).toBe(0)
    expect(checkpoints.records.size).toBe(0)
    approvals.close()
  })

  it("cleans a token-only half-write and abandons without execution", () => {
    const approvals = store()
    const checkpoints = checkpointStore()
    const tokens = tokenStore()

    expect(() => commitApprovalProposal({
      approvalStore: approvals,
      checkpointStore: checkpoints,
      tokenStore: tokens,
      proposal: proposal(),
      preCallMessages: [{ role: "user", content: "restart" }],
      hooks: { afterTokenPersist: () => { throw new Error("crash after token") } },
    })).toThrow("crash after token")
    expect(tokens.records.has(UUID)).toBe(true)

    recoverApprovalProposals({ approvalStore: approvals, checkpointStore: checkpoints, tokenStore: tokens })
    expect(approvals.read(UUID)?.state).toBe("abandoned_before_attempt")
    expect(tokens.records.has(UUID)).toBe(false)
    approvals.close()
  })

  it("recovers matching journal+checkpoint half-writes to awaiting prompt binding", () => {
    const approvals = store()
    const checkpoints = checkpointStore()
    const tokens = tokenStore()

    expect(() => commitApprovalProposal({
      approvalStore: approvals,
      checkpointStore: checkpoints,
      tokenStore: tokens,
      proposal: proposal(),
      preCallMessages: [{ role: "user", content: "restart" }],
      hooks: { afterCheckpointWrite: () => { throw new Error("crash after checkpoint") } },
    })).toThrow("crash after checkpoint")

    expect(recoverApprovalProposals({ approvalStore: approvals, checkpointStore: checkpoints, tokenStore: tokens }))
      .toEqual([{ approvalId: UUID, state: "awaiting_prompt_binding" }])
    expect(approvals.read(UUID)?.state).toBe("awaiting_prompt_binding")
    expect(tokens.records.has(UUID)).toBe(true)
    approvals.close()
  })

  it("removes the forbidden reverse-order checkpoint-without-journal shape", () => {
    const approvals = store()
    const checkpoints = checkpointStore()
    const tokens = tokenStore()
    checkpoints.records.set(UUID, {
      approvalId: UUID,
      checkpointDigest: "e".repeat(64),
      baseSessionRevision: "d".repeat(64),
      suspendedSessionRevision: "f".repeat(64),
      preCallMessages: [{ role: "user", content: "restart" }],
      frozenAssistantMessage: proposal().frozenAssistantMessage,
    })

    expect(recoverApprovalProposals({ approvalStore: approvals, checkpointStore: checkpoints, tokenStore: tokens }))
      .toEqual([{ approvalId: UUID, state: "orphan_checkpoint_removed" }])
    expect(checkpoints.records.has(UUID)).toBe(false)
    approvals.close()
  })

  it("terminalizes mismatched checkpoint evidence as drifted and removes token authority", () => {
    const approvals = store()
    const checkpoints = checkpointStore()
    const tokens = tokenStore()
    const prepared = approvals.prepare(proposal())
    tokens.put(UUID, prepared.decisionToken)
    checkpoints.records.set(UUID, {
      approvalId: UUID,
      checkpointDigest: "0".repeat(64),
      baseSessionRevision: "d".repeat(64),
      suspendedSessionRevision: "f".repeat(64),
      preCallMessages: [{ role: "user", content: "restart" }],
      frozenAssistantMessage: proposal().frozenAssistantMessage,
    })

    recoverApprovalProposals({ approvalStore: approvals, checkpointStore: checkpoints, tokenStore: tokens })
    expect(approvals.read(UUID)).toMatchObject({ state: "drifted", reason: expect.stringContaining("checkpoint") })
    expect(tokens.records.has(UUID)).toBe(false)
    expect(checkpoints.records.has(UUID)).toBe(false)
    approvals.close()
  })

  it("refuses activation when the durable checkpoint write attests a different digest", () => {
    const approvals = store()
    const checkpoints = checkpointStore({
      checkpointDigest: "0".repeat(64),
      suspendedSessionRevision: "f".repeat(64),
    })
    const tokens = tokenStore()

    expect(() => commitApprovalProposal({
      approvalStore: approvals,
      checkpointStore: checkpoints,
      tokenStore: tokens,
      proposal: proposal(),
      preCallMessages: [{ role: "user", content: "restart" }],
    })).toThrowError(expect.objectContaining({ code: "checkpoint_attestation_mismatch" }))
    expect(approvals.read(UUID)).toMatchObject({ state: "drifted" })
    expect(tokens.records.has(UUID)).toBe(false)
    expect(checkpoints.records.has(UUID)).toBe(false)
    approvals.close()
  })
})
