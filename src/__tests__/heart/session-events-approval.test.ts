import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

import { afterEach, describe, expect, it, vi } from "vitest"

import { repairOrphanedToolCalls } from "../../heart/core"
import { openApprovalStore, type PrepareApprovalInput } from "../../heart/approval-store"
import {
  attachApprovalSuspensionCheckpoint,
  buildCanonicalSessionEnvelope,
  listApprovalSuspensionCheckpoints,
  parseSessionEnvelope,
  projectProviderMessages,
  removeApprovalSuspensionCheckpoint,
  type SessionEnvelope,
} from "../../heart/session-events"
import {
  commitApprovalProposal,
  digestApprovalSuspensionCheckpointPayload,
  recoverApprovalProposals,
  type ApprovalSuspensionCheckpoint,
  type ApprovalSuspensionCheckpointStore,
  type ApprovalTokenStore,
} from "../../heart/tool-approval"

const UUID = "11111111-1111-4111-8111-111111111111"
const roots: string[] = []

function makeRoot(): string {
  const value = fs.mkdtempSync(path.join(os.tmpdir(), "ouro-approval-session-"))
  roots.push(value)
  return value
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

function baseEnvelope(): SessionEnvelope {
  const user = { role: "user" as const, content: "restart calibre-web" }
  return buildCanonicalSessionEnvelope({
    existing: null,
    previousMessages: [],
    currentMessages: [user],
    trimmedMessages: [user],
    recordedAt: "2026-08-17T17:30:00.000Z",
    projectionBasis: { maxTokens: 80_000, contextMargin: 20, inputTokens: 10 },
  }).envelope
}

function checkpoint(): ApprovalSuspensionCheckpoint {
  return {
    approvalId: UUID,
    checkpointDigest: "e".repeat(64),
    baseSessionRevision: "d".repeat(64),
    suspendedSessionRevision: "f".repeat(64),
    argumentDigest: "1".repeat(64),
    schemaDigest: "a".repeat(64),
    toolDigest: "b".repeat(64),
    policyDigest: "c".repeat(64),
    preCallDigest: "2".repeat(64),
    preCallMessages: [{ role: "user", content: "restart calibre-web" }],
    frozenAssistantMessage: proposal().frozenAssistantMessage,
  }
}

function sessionCheckpointStore(initial = baseEnvelope()): ApprovalSuspensionCheckpointStore & { envelope: () => SessionEnvelope } {
  let envelope = initial
  return {
    envelope: () => envelope,
    write: vi.fn((draft) => {
      const committed = { ...draft, checkpointDigest: digestApprovalSuspensionCheckpointPayload(draft), suspendedSessionRevision: "f".repeat(64) }
      envelope = attachApprovalSuspensionCheckpoint(envelope, committed)
      return { checkpointDigest: committed.checkpointDigest, suspendedSessionRevision: committed.suspendedSessionRevision }
    }),
    read: vi.fn((approvalId) => listApprovalSuspensionCheckpoints(envelope).find((item) => item.approvalId === approvalId) ?? null),
    list: vi.fn(() => listApprovalSuspensionCheckpoints(envelope)),
    remove: vi.fn((approvalId) => { envelope = removeApprovalSuspensionCheckpoint(envelope, approvalId) }),
  }
}

function tokenStore(): ApprovalTokenStore {
  const records = new Map<string, string>()
  return {
    put: (approvalId, token) => { records.set(approvalId, token) },
    has: (approvalId) => records.has(approvalId),
    get: (approvalId) => records.get(approvalId) ?? null,
    remove: (approvalId) => { records.delete(approvalId) },
  }
}

function assertNoProjectedApprovalOrphan(envelope: SessionEnvelope, handler: ReturnType<typeof vi.fn>): void {
  const projected = projectProviderMessages(envelope)
  repairOrphanedToolCalls(projected)
  for (const message of projected) {
    if (message.role !== "assistant" || !message.tool_calls) continue
    for (const call of message.tool_calls) handler(call)
  }
  expect(handler).not.toHaveBeenCalled()
  expect(JSON.stringify(projected)).not.toContain("tool call's result was lost")
  expect(projected).toEqual([expect.objectContaining({ role: "user", content: "restart calibre-web" })])
}

afterEach(() => {
  for (const directory of roots.splice(0)) fs.rmSync(directory, { recursive: true, force: true })
})

describe("approval suspension session projection", () => {
  it("round-trips suspension checkpoints through durable envelope parsing", () => {
    const attached = attachApprovalSuspensionCheckpoint(baseEnvelope(), checkpoint())

    const parsed = parseSessionEnvelope(JSON.parse(JSON.stringify(attached)))

    expect(parsed).not.toBeNull()
    expect(listApprovalSuspensionCheckpoints(parsed!)).toEqual([checkpoint()])
  })

  it("preserves suspension checkpoints while rebuilding the canonical envelope", () => {
    const existing = attachApprovalSuspensionCheckpoint(baseEnvelope(), checkpoint())
    const messages = projectProviderMessages(existing)

    const rebuilt = buildCanonicalSessionEnvelope({
      existing,
      previousMessages: messages,
      currentMessages: messages,
      trimmedMessages: messages,
      recordedAt: "2026-08-17T17:31:00.000Z",
      projectionBasis: { maxTokens: 80_000, contextMargin: 20, inputTokens: 10 },
    }).envelope

    expect(listApprovalSuspensionCheckpoints(rebuilt)).toEqual([checkpoint()])
  })

  it.each([
    ["journal-only", "afterJournalPrepare"],
    ["token-only", "afterTokenPersist"],
    ["checkpoint-written", "afterCheckpointWrite"],
  ] as const)("keeps the %s crash shape out of provider projection and ordinary orphan repair", (_label, hookName) => {
    const directory = makeRoot()
    const approvals = openApprovalStore({
      databasePath: path.join(directory, "approvals.sqlite"),
      now: () => new Date("2026-08-17T17:30:00.000Z"),
      randomUUID: () => UUID,
      randomBytes: (size) => Buffer.alloc(size, 0xab),
    })
    const checkpoints = sessionCheckpointStore()
    const tokens = tokenStore()
    const hooks = { [hookName]: () => { throw new Error(`crash at ${hookName}`) } }

    expect(() => commitApprovalProposal({
      approvalStore: approvals,
      checkpointStore: checkpoints,
      tokenStore: tokens,
      proposal: proposal(),
      preCallMessages: [{ role: "user", content: "restart calibre-web" }],
      hooks,
    })).toThrow(`crash at ${hookName}`)
    recoverApprovalProposals({ approvalStore: approvals, checkpointStore: checkpoints, tokenStore: tokens })

    assertNoProjectedApprovalOrphan(checkpoints.envelope(), vi.fn())
    approvals.close()
  })

  it("removes a checkpoint-without-journal reverse orphan before projection", () => {
    const directory = makeRoot()
    const approvals = openApprovalStore({ databasePath: path.join(directory, "approvals.sqlite") })
    const checkpoints = sessionCheckpointStore(attachApprovalSuspensionCheckpoint(baseEnvelope(), checkpoint()))
    const handler = vi.fn()

    recoverApprovalProposals({ approvalStore: approvals, checkpointStore: checkpoints, tokenStore: tokenStore() })

    expect(listApprovalSuspensionCheckpoints(checkpoints.envelope())).toEqual([])
    assertNoProjectedApprovalOrphan(checkpoints.envelope(), handler)
    approvals.close()
  })
})
