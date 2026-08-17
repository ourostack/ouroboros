import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import {
  ApprovalStoreError,
  canonicalApprovalArguments,
  openApprovalStore,
  parseApprovalRecord,
  type ApprovalStore,
} from "../../heart/approval-store"

const NOW = "2026-08-17T17:15:00.000Z"
const LATER = "2026-08-17T17:20:00.000Z"
const EXPIRES = "2026-08-17T17:25:00.000Z"
const UUID = "11111111-1111-4111-8111-111111111111"
const roots: string[] = []

function makeRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ouro-approval-store-"))
  roots.push(root)
  return root
}

function open(root = makeRoot(), now = NOW): ApprovalStore {
  return openApprovalStore({
    databasePath: path.join(root, "approvals.sqlite"),
    now: () => new Date(now),
    randomUUID: () => UUID,
    randomBytes: (size) => Buffer.alloc(size, 0xab),
  })
}

function proposalInput(overrides: Record<string, unknown> = {}) {
  return {
    toolCallId: "call_restart_1",
    toolName: "shell",
    arguments: { command: "docker restart calibre-web" },
    schemaDigest: "a".repeat(64),
    toolDigest: "b".repeat(64),
    policyDigest: "c".repeat(64),
    policyId: "shell.docker-lifecycle.v1",
    sessionKey: "telegram:chat-7",
    sessionPath: "/tmp/disposable-agent/session.json",
    baseSessionRevision: "d".repeat(64),
    checkpointDigest: "e".repeat(64),
    requesterId: "friend-ari",
    transport: "telegram",
    transportUserId: "42",
    transportChatId: "7",
    expiresAt: EXPIRES,
    frozenAssistantMessage: {
      role: "assistant",
      content: null,
      tool_calls: [{
        id: "call_restart_1",
        type: "function",
        function: { name: "shell", arguments: "{\"command\":\"docker restart calibre-web\"}" },
      }],
    },
    ...overrides,
  }
}

function makeProposed(store: ApprovalStore) {
  const prepared = store.prepare(proposalInput())
  store.activate({
    approvalId: prepared.record.approvalId,
    checkpointDigest: prepared.record.checkpointDigest,
    suspendedSessionRevision: "f".repeat(64),
  })
  const proposed = store.bindPrompt({
    approvalId: prepared.record.approvalId,
    transport: "telegram",
    transportChatId: "7",
    transportMessageId: "99",
  })
  return { ...prepared, record: proposed }
}

function decisionInput(decisionToken: string, overrides: Record<string, unknown> = {}) {
  return {
    approvalId: UUID,
    decisionToken,
    decision: "approve" as const,
    requesterId: "friend-ari",
    transport: "telegram",
    transportUserId: "42",
    transportChatId: "7",
    transportMessageId: "99",
    sessionKey: "telegram:chat-7",
    ownerId: "worker-a",
    ...overrides,
  }
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

describe("approval store", () => {
  it("canonicalizes JSON object keys recursively before hashing", () => {
    const left = canonicalApprovalArguments({ z: [3, { b: true, a: null }], a: "x" })
    const right = canonicalApprovalArguments({ a: "x", z: [3, { a: null, b: true }] })

    expect(left.canonical).toBe('{"a":"x","z":[3,{"a":null,"b":true}]}')
    expect(right).toEqual(left)
    expect(left.digest).toMatch(/^[a-f0-9]{64}$/)
  })

  it("creates a preparing record with a high-entropy token whose plaintext is not persisted", () => {
    const root = makeRoot()
    const store = open(root)

    const created = store.prepare(proposalInput())

    expect(created.record).toMatchObject({
      approvalId: UUID,
      state: "preparing",
      epoch: 0,
      arguments: { command: "docker restart calibre-web" },
      createdAt: NOW,
      updatedAt: NOW,
    })
    expect(created.record.argumentDigest).toMatch(/^[a-f0-9]{64}$/)
    expect(created.record.decisionTokenDigest).toMatch(/^[a-f0-9]{64}$/)
    expect(created.decisionToken).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(created.record).not.toHaveProperty("decisionToken")
    store.close()

    const persisted = fs.readFileSync(path.join(root, "approvals.sqlite"))
    expect(persisted.includes(Buffer.from(created.decisionToken))).toBe(false)
  })

  it("rejects invalid proposal identities, hashes, times, and non-object arguments", () => {
    const store = open()
    for (const overrides of [
      { toolCallId: "" },
      { schemaDigest: "bad" },
      { expiresAt: "later" },
      { arguments: null },
      { arguments: [] },
    ]) {
      expect(() => store.prepare(proposalInput(overrides))).toThrowError(ApprovalStoreError)
    }
    store.close()
  })

  it("strictly rejects malformed or internally inconsistent records", () => {
    const store = open()
    const { record } = store.prepare(proposalInput())
    store.close()

    expect(() => parseApprovalRecord({ ...record, surprise: true })).toThrowError(ApprovalStoreError)
    expect(() => parseApprovalRecord({ ...record, state: "attempted", ownerId: null })).toThrowError(ApprovalStoreError)
    expect(() => parseApprovalRecord({ ...record, argumentDigest: "0".repeat(64) })).toThrowError(ApprovalStoreError)
    expect(() => parseApprovalRecord("corrupt")).toThrowError(ApprovalStoreError)
  })

  it("activates only the matching checkpoint and binds prompt identity exactly once", () => {
    const store = open()
    const { record } = store.prepare(proposalInput())

    expect(() => store.activate({
      approvalId: record.approvalId,
      checkpointDigest: "0".repeat(64),
      suspendedSessionRevision: "f".repeat(64),
    })).toThrowError(ApprovalStoreError)
    expect(store.read(record.approvalId)?.state).toBe("preparing")

    const awaiting = store.activate({
      approvalId: record.approvalId,
      checkpointDigest: record.checkpointDigest,
      suspendedSessionRevision: "f".repeat(64),
    })
    expect(awaiting.state).toBe("awaiting_prompt_binding")

    const proposed = store.bindPrompt({
      approvalId: record.approvalId,
      transport: "telegram",
      transportChatId: "7",
      transportMessageId: "99",
    })
    expect(proposed).toMatchObject({ state: "proposed", transportMessageId: "99" })
    expect(() => store.bindPrompt({
      approvalId: record.approvalId,
      transport: "telegram",
      transportChatId: "7",
      transportMessageId: "100",
    })).toThrowError(ApprovalStoreError)
    store.close()
  })

  it("rejects decisions while prompt binding is incomplete", () => {
    const store = open()
    const prepared = store.prepare(proposalInput())
    store.activate({
      approvalId: prepared.record.approvalId,
      checkpointDigest: prepared.record.checkpointDigest,
      suspendedSessionRevision: "f".repeat(64),
    })

    expect(() => store.decide(decisionInput(prepared.decisionToken))).toThrowError(ApprovalStoreError)
    expect(store.read(UUID)?.state).toBe("awaiting_prompt_binding")
    store.close()
  })

  it.each([
    ["token", { decisionToken: "wrong" }],
    ["requester", { requesterId: "friend-eve" }],
    ["transport user", { transportUserId: "84" }],
    ["chat", { transportChatId: "8" }],
    ["message", { transportMessageId: "100" }],
    ["session", { sessionKey: "telegram:chat-8" }],
  ])("rejects a %s mismatch without changing state", (_label, overrides) => {
    const store = open()
    const proposed = makeProposed(store)

    expect(() => store.decide(decisionInput(proposed.decisionToken, overrides))).toThrowError(ApprovalStoreError)
    expect(store.read(UUID)?.state).toBe("proposed")
    store.close()
  })

  it("allows only one atomic claimant across independent database connections", () => {
    const root = makeRoot()
    const first = open(root)
    const proposed = makeProposed(first)
    const second = open(root)

    const winner = first.decide(decisionInput(proposed.decisionToken, { ownerId: "worker-a" }))
    expect(winner).toMatchObject({ state: "claimed", ownerId: "worker-a", epoch: 1 })
    expect(() => second.decide(decisionInput(proposed.decisionToken, { ownerId: "worker-b" }))).toThrowError(ApprovalStoreError)
    expect(second.read(UUID)).toMatchObject({ state: "claimed", ownerId: "worker-a", epoch: 1 })
    first.close()
    second.close()
  })

  it("denies atomically and never creates an execution owner", () => {
    const store = open()
    const proposed = makeProposed(store)

    const denied = store.decide(decisionInput(proposed.decisionToken, { decision: "deny" }))
    expect(denied).toMatchObject({ state: "denied", ownerId: null, attemptedAt: null })
    expect(() => store.decide(decisionInput(proposed.decisionToken))).toThrowError(ApprovalStoreError)
    store.close()
  })

  it("expires a proposal at the boundary and rejects later decisions", () => {
    const root = makeRoot()
    const store = open(root, EXPIRES)
    const proposed = makeProposed(store)

    const expired = store.expire({ approvalId: proposed.record.approvalId })
    expect(expired.state).toBe("expired")
    expect(() => store.decide(decisionInput(proposed.decisionToken))).toThrowError(ApprovalStoreError)
    store.close()
  })

  it("uses owner and epoch for the claimed-to-attempted CAS", () => {
    const store = open()
    const proposed = makeProposed(store)
    const claimed = store.decide(decisionInput(proposed.decisionToken))

    expect(() => store.markAttempted({ approvalId: UUID, ownerId: "worker-b", epoch: claimed.epoch })).toThrowError(ApprovalStoreError)
    expect(() => store.markAttempted({ approvalId: UUID, ownerId: "worker-a", epoch: claimed.epoch + 1 })).toThrowError(ApprovalStoreError)
    expect(store.read(UUID)?.state).toBe("claimed")

    const attempted = store.markAttempted({ approvalId: UUID, ownerId: "worker-a", epoch: claimed.epoch })
    expect(attempted).toMatchObject({ state: "attempted", attemptedAt: NOW })
    store.close()
  })

  it("deterministically fences a paused stale owner before attempted CAS", () => {
    const store = open()
    const proposed = makeProposed(store)
    const staleClaim = store.decide(decisionInput(proposed.decisionToken))

    const abandoned = store.abandonBeforeAttempt({
      approvalId: UUID,
      ownerId: staleClaim.ownerId!,
      epoch: staleClaim.epoch,
      reason: "owner process died before attempted CAS",
    })
    expect(abandoned.state).toBe("abandoned_before_attempt")
    expect(() => store.markAttempted({
      approvalId: UUID,
      ownerId: staleClaim.ownerId!,
      epoch: staleClaim.epoch,
    })).toThrowError(ApprovalStoreError)
    expect(store.read(UUID)?.attemptedAt).toBeNull()
    store.close()
  })

  it("never permits an attempted or indeterminate action to be claimed again", () => {
    const store = open()
    const proposed = makeProposed(store)
    const claimed = store.decide(decisionInput(proposed.decisionToken))
    store.markAttempted({ approvalId: UUID, ownerId: claimed.ownerId!, epoch: claimed.epoch })
    store.complete({
      approvalId: UUID,
      ownerId: claimed.ownerId!,
      epoch: claimed.epoch,
      state: "attempted_indeterminate",
      result: "process exited after invocation boundary",
    })

    expect(() => store.decide(decisionInput(proposed.decisionToken, { ownerId: "worker-b" }))).toThrowError(ApprovalStoreError)
    expect(() => store.markAttempted({ approvalId: UUID, ownerId: claimed.ownerId!, epoch: claimed.epoch })).toThrowError(ApprovalStoreError)
    store.close()
  })

  it("makes an identical terminal completion idempotent and rejects conflicting completion", () => {
    const store = open()
    const proposed = makeProposed(store)
    const claimed = store.decide(decisionInput(proposed.decisionToken))
    store.markAttempted({ approvalId: UUID, ownerId: claimed.ownerId!, epoch: claimed.epoch })
    const completion = {
      approvalId: UUID,
      ownerId: claimed.ownerId!,
      epoch: claimed.epoch,
      state: "succeeded" as const,
      result: "restarted",
    }

    const first = store.complete(completion)
    expect(store.complete(completion)).toEqual(first)
    expect(() => store.complete({ ...completion, result: "different" })).toThrowError(ApprovalStoreError)
    store.close()
  })

  it("persists records across close and reopen", () => {
    const root = makeRoot()
    const first = open(root)
    const proposed = makeProposed(first)
    first.close()

    const reopened = open(root, LATER)
    expect(reopened.read(proposed.record.approvalId)).toMatchObject({
      state: "proposed",
      approvalId: proposed.record.approvalId,
      updatedAt: NOW,
    })
    reopened.close()
  })
})
