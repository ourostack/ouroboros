import * as fs from "node:fs"
import { createHash } from "node:crypto"
import * as os from "node:os"
import * as path from "node:path"

import Database from "better-sqlite3"
import { afterEach, describe, expect, it } from "vitest"

import { createLogger, type LogEvent } from "../../nerves"
import { setRuntimeLogger } from "../../nerves/runtime"
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
  setRuntimeLogger(null)
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

describe("approval store", () => {
  it("canonicalizes JSON object keys recursively before hashing", () => {
    const left = canonicalApprovalArguments({ z: [3, { b: true, a: null }], a: "x" })
    const right = canonicalApprovalArguments({ a: "x", z: [3, { a: null, b: true }] })

    expect(left.canonical).toBe('{"a":"x","z":[3,{"a":null,"b":true}]}')
    expect(right).toEqual(left)
    expect(left.digest).toBe(createHash("sha256").update(left.canonical, "utf8").digest("hex"))
    expect(canonicalApprovalArguments({ a: "different" }).digest).not.toBe(left.digest)
  })

  it("creates a preparing record with a high-entropy token whose plaintext is not persisted", () => {
    const root = makeRoot()
    const requestedSizes: number[] = []
    let fill = 1
    let uuidCounter = 1
    const store = openApprovalStore({
      databasePath: path.join(root, "approvals.sqlite"),
      now: () => new Date(NOW),
      randomUUID: () => uuidCounter++ === 1 ? UUID : "22222222-2222-4222-8222-222222222222",
      randomBytes: (size) => {
        requestedSizes.push(size)
        return Buffer.alloc(size, fill++)
      },
    })

    const created = store.prepare(proposalInput())
    const second = store.prepare(proposalInput({
      toolCallId: "call_restart_2",
      frozenAssistantMessage: {
        role: "assistant",
        content: null,
        tool_calls: [{
          id: "call_restart_2",
          type: "function",
          function: { name: "shell", arguments: "{\"command\":\"docker restart calibre-web\"}" },
        }],
      },
    }))

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
    expect(second.decisionToken).not.toBe(created.decisionToken)
    expect(requestedSizes).toEqual([32, 32])
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
    expect(() => parseApprovalRecord({ ...record, state: "claimed", ownerId: "worker-a", epoch: 0 })).toThrowError(ApprovalStoreError)
    expect(() => parseApprovalRecord({ ...record, state: "succeeded", result: null })).toThrowError(ApprovalStoreError)
    expect(() => parseApprovalRecord({ ...record, argumentDigest: "0".repeat(64) })).toThrowError(ApprovalStoreError)
    expect(() => parseApprovalRecord("corrupt")).toThrowError(ApprovalStoreError)
  })

  it.each([
    ["ownerId", 42],
    ["ownerId", ""],
    ["attemptedAt", 42],
    ["attemptedAt", "yesterday"],
    ["reason", 42],
    ["reason", ""],
    ["result", 42],
    ["result", ""],
    ["transportMessageId", 42],
    ["transportMessageId", ""],
    ["suspendedSessionRevision", 42],
    ["suspendedSessionRevision", "not-a-revision"],
  ])("rejects a malformed non-null %s value (%s)", (field, malformed) => {
    const store = open()
    const { record } = store.prepare(proposalInput())
    store.close()

    expect(() => parseApprovalRecord({ ...record, [field]: malformed })).toThrowError(ApprovalStoreError)
  })

  it("fails closed when a persisted record is malformed", () => {
    const root = makeRoot()
    const store = open(root)
    store.prepare(proposalInput())
    store.close()

    const database = new Database(path.join(root, "approvals.sqlite"))
    database.prepare("UPDATE approval_actions SET record_json = ? WHERE approval_id = ?")
      .run('{"state":"claimed","ownerId":null}', UUID)
    database.close()

    const reopened = open(root)
    expect(() => reopened.read(UUID)).toThrowError(ApprovalStoreError)
    reopened.close()
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

    for (const mismatch of [
      { transport: "teams", transportChatId: "7" },
      { transport: "telegram", transportChatId: "8" },
    ]) {
      expect(() => store.bindPrompt({
        approvalId: record.approvalId,
        ...mismatch,
        transportMessageId: "99",
      })).toThrowError(ApprovalStoreError)
      expect(store.read(record.approvalId)?.state).toBe("awaiting_prompt_binding")
    }

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
    ["transport", { transport: "teams" }],
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

  it("allows only one atomic claimant when two connections overlap at the claim CAS", () => {
    const root = makeRoot()
    const first = open(root)
    const proposed = makeProposed(first)
    const second = open(root)
    let secondWinner: ReturnType<ApprovalStore["decide"]> | undefined
    let hookCalls = 0
    const pausedFirst = openApprovalStore({
      databasePath: path.join(root, "approvals.sqlite"),
      now: () => new Date(NOW),
      randomUUID: () => "22222222-2222-4222-8222-222222222222",
      randomBytes: (size) => Buffer.alloc(size, 0xcd),
      hooks: {
        beforeClaimCas: () => {
          hookCalls += 1
          secondWinner = second.decide(decisionInput(proposed.decisionToken, { ownerId: "worker-b" }))
        },
      },
    })

    expect(() => pausedFirst.decide(decisionInput(proposed.decisionToken, { ownerId: "worker-a" }))).toThrowError(ApprovalStoreError)
    expect(hookCalls).toBe(1)
    expect(secondWinner).toMatchObject({ state: "claimed", ownerId: "worker-b", epoch: 1 })
    expect(second.read(UUID)).toMatchObject({ state: "claimed", ownerId: "worker-b", epoch: 1 })
    first.close()
    second.close()
    pausedFirst.close()
  })

  it("denies atomically and never creates an execution owner", () => {
    const store = open()
    const proposed = makeProposed(store)

    const denied = store.decide(decisionInput(proposed.decisionToken, { decision: "deny" }))
    expect(denied).toMatchObject({ state: "denied", ownerId: null, attemptedAt: null })
    expect(store.decide(decisionInput(proposed.decisionToken, { decision: "deny" }))).toEqual(denied)
    expect(() => store.decide(decisionInput(proposed.decisionToken))).toThrowError(ApprovalStoreError)
    store.close()
  })

  it("makes decide atomically expire a proposal at the time boundary", () => {
    const root = makeRoot()
    const setup = open(root)
    const proposed = makeProposed(setup)
    setup.close()
    const store = open(root, EXPIRES)

    expect(store.decide(decisionInput(proposed.decisionToken))).toMatchObject({ state: "expired", ownerId: null })
    expect(store.expire({ approvalId: proposed.record.approvalId })).toEqual(store.read(UUID))
    store.close()
  })

  it("lets expiry beat a paused approval claim atomically", () => {
    const root = makeRoot()
    const setup = open(root)
    const proposed = makeProposed(setup)
    const expirer = open(root, EXPIRES)
    let expired = false
    const claimant = openApprovalStore({
      databasePath: path.join(root, "approvals.sqlite"),
      now: () => new Date(NOW),
      randomUUID: () => "22222222-2222-4222-8222-222222222222",
      randomBytes: (size) => Buffer.alloc(size, 0xcd),
      hooks: { beforeClaimCas: () => { expired = expirer.expire({ approvalId: UUID }).state === "expired" } },
    })

    expect(() => claimant.decide(decisionInput(proposed.decisionToken))).toThrowError(ApprovalStoreError)
    expect(expired).toBe(true)
    expect(claimant.read(UUID)?.state).toBe("expired")
    setup.close()
    expirer.close()
    claimant.close()
  })

  it("rechecks expiry at the claim CAS boundary without requiring a competing writer", () => {
    const root = makeRoot()
    let clock = NOW
    const store = openApprovalStore({
      databasePath: path.join(root, "approvals.sqlite"),
      now: () => new Date(clock),
      randomUUID: () => UUID,
      randomBytes: (size) => Buffer.alloc(size, 0xab),
      hooks: { beforeClaimCas: () => { clock = EXPIRES } },
    })
    const proposed = makeProposed(store)

    expect(store.decide(decisionInput(proposed.decisionToken))).toMatchObject({
      state: "expired",
      ownerId: null,
      epoch: 0,
    })
    expect(store.read(UUID)?.state).toBe("expired")
    store.close()
  })

  it("discovers and terminalizes stranded preparing records without inventing an owner or attempt", () => {
    const store = open()
    const prepared = store.prepare(proposalInput())

    expect(store.listPreparing()).toEqual([prepared.record])
    const abandoned = store.recoverPreparing({
      approvalId: UUID,
      state: "abandoned_before_attempt",
      reason: "checkpoint was never written",
    })
    expect(abandoned).toMatchObject({
      state: "abandoned_before_attempt",
      ownerId: null,
      epoch: 0,
      attemptedAt: null,
      reason: "checkpoint was never written",
    })
    expect(store.recoverPreparing({
      approvalId: UUID,
      state: "abandoned_before_attempt",
      reason: "checkpoint was never written",
    })).toEqual(abandoned)
    expect(store.listPreparing()).toEqual([])
    store.close()
  })

  it("can idempotently mark a stranded preparing record drifted without owner or attempt", () => {
    const store = open()
    store.prepare(proposalInput())

    const drifted = store.recoverPreparing({
      approvalId: UUID,
      state: "drifted",
      reason: "checkpoint digest does not match",
    })
    expect(drifted).toMatchObject({ state: "drifted", ownerId: null, epoch: 0, attemptedAt: null })
    expect(store.recoverPreparing({
      approvalId: UUID,
      state: "drifted",
      reason: "checkpoint digest does not match",
    })).toEqual(drifted)
    expect(() => store.recoverPreparing({
      approvalId: UUID,
      state: "abandoned_before_attempt",
      reason: "different recovery",
    })).toThrowError(ApprovalStoreError)
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

  it("deterministically fences a stale owner paused immediately before attempted CAS", () => {
    const root = makeRoot()
    const setup = open(root)
    const proposed = makeProposed(setup)
    const staleClaim = setup.decide(decisionInput(proposed.decisionToken))
    const recovery = open(root)
    let recoveryRan = false
    const staleWorker = openApprovalStore({
      databasePath: path.join(root, "approvals.sqlite"),
      now: () => new Date(NOW),
      randomUUID: () => "22222222-2222-4222-8222-222222222222",
      randomBytes: (size) => Buffer.alloc(size, 0xcd),
      hooks: {
        beforeAttemptCas: () => {
          recoveryRan = recovery.abandonBeforeAttempt({
            approvalId: UUID,
            ownerId: staleClaim.ownerId!,
            epoch: staleClaim.epoch,
            reason: "owner process died before attempted CAS",
          }).state === "abandoned_before_attempt"
        },
      },
    })

    expect(() => staleWorker.markAttempted({
      approvalId: UUID,
      ownerId: staleClaim.ownerId!,
      epoch: staleClaim.epoch,
    })).toThrowError(ApprovalStoreError)
    expect(recoveryRan).toBe(true)
    expect(staleWorker.read(UUID)).toMatchObject({ state: "abandoned_before_attempt", attemptedAt: null })
    setup.close()
    recovery.close()
    staleWorker.close()
  })

  it("requires the winning owner and epoch to abandon a pre-attempt claim", () => {
    const store = open()
    const proposed = makeProposed(store)
    const claim = store.decide(decisionInput(proposed.decisionToken))
    const request = { approvalId: UUID, ownerId: claim.ownerId!, epoch: claim.epoch, reason: "dead owner" }

    expect(() => store.abandonBeforeAttempt({ ...request, ownerId: "worker-b" })).toThrowError(ApprovalStoreError)
    expect(() => store.abandonBeforeAttempt({ ...request, epoch: claim.epoch + 1 })).toThrowError(ApprovalStoreError)
    expect(store.read(UUID)?.state).toBe("claimed")
    const abandoned = store.abandonBeforeAttempt(request)
    expect(store.abandonBeforeAttempt(request)).toEqual(abandoned)
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

  it("does not retry a bare durable attempted row after close and reopen", () => {
    const root = makeRoot()
    const first = open(root)
    const proposed = makeProposed(first)
    const claimed = first.decide(decisionInput(proposed.decisionToken))
    first.markAttempted({ approvalId: UUID, ownerId: claimed.ownerId!, epoch: claimed.epoch })
    first.close()

    const reopened = open(root, LATER)
    expect(reopened.read(UUID)?.state).toBe("attempted")
    expect(() => reopened.decide(decisionInput(proposed.decisionToken, { ownerId: "worker-b" }))).toThrowError(ApprovalStoreError)
    expect(() => reopened.markAttempted({ approvalId: UUID, ownerId: claimed.ownerId!, epoch: claimed.epoch })).toThrowError(ApprovalStoreError)
    reopened.close()
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

  it.each(["failed", "attempted_indeterminate"] as const)("makes %s completion idempotent", (state) => {
    const store = open()
    const proposed = makeProposed(store)
    const claimed = store.decide(decisionInput(proposed.decisionToken))
    store.markAttempted({ approvalId: UUID, ownerId: claimed.ownerId!, epoch: claimed.epoch })
    const completion = {
      approvalId: UUID,
      ownerId: claimed.ownerId!,
      epoch: claimed.epoch,
      state,
      result: state === "failed" ? "handler failed" : "outcome unknown",
    }

    expect(store.complete(completion)).toEqual(store.complete(completion))
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

  it("emits a static operation event for every public API and marks representative errors", () => {
    const events: LogEvent[] = []
    setRuntimeLogger(createLogger({ level: "debug", sinks: [(event) => events.push(event)] }))
    const store = open()
    const prepared = store.prepare(proposalInput())
    store.listPreparing()
    expect(() => store.activate({
      approvalId: UUID,
      checkpointDigest: "0".repeat(64),
      suspendedSessionRevision: "f".repeat(64),
    })).toThrowError(ApprovalStoreError)
    store.activate({
      approvalId: UUID,
      checkpointDigest: prepared.record.checkpointDigest,
      suspendedSessionRevision: "f".repeat(64),
    })
    store.bindPrompt({
      approvalId: UUID,
      transport: "telegram",
      transportChatId: "7",
      transportMessageId: "99",
    })
    expect(() => store.decide(decisionInput("wrong"))).toThrowError(ApprovalStoreError)
    const claimed = store.decide(decisionInput(prepared.decisionToken))
    expect(() => store.expire({ approvalId: UUID })).toThrowError(ApprovalStoreError)
    expect(() => store.markAttempted({ approvalId: UUID, ownerId: "wrong", epoch: claimed.epoch })).toThrowError(ApprovalStoreError)
    const attempted = store.markAttempted({ approvalId: UUID, ownerId: claimed.ownerId!, epoch: claimed.epoch })
    expect(() => store.abandonBeforeAttempt({
      approvalId: UUID,
      ownerId: attempted.ownerId!,
      epoch: attempted.epoch,
      reason: "too late",
    })).toThrowError(ApprovalStoreError)
    store.complete({
      approvalId: UUID,
      ownerId: attempted.ownerId!,
      epoch: attempted.epoch,
      state: "succeeded",
      result: "ok",
    })
    store.read(UUID)

    const recovery = open()
    recovery.prepare(proposalInput())
    expect(() => recovery.recoverPreparing({ approvalId: UUID, state: "drifted", reason: "" })).toThrowError(ApprovalStoreError)
    recovery.recoverPreparing({ approvalId: UUID, state: "drifted", reason: "mismatch" })
    recovery.close()
    store.close()

    const operationEvents = events.filter((event) => event.event.startsWith("approval.store_"))
    expect(new Set(operationEvents.map((event) => event.event))).toEqual(new Set([
      "approval.store_prepare",
      "approval.store_activate",
      "approval.store_bind_prompt",
      "approval.store_decide",
      "approval.store_expire",
      "approval.store_mark_attempted",
      "approval.store_abandon_before_attempt",
      "approval.store_complete",
      "approval.store_read",
      "approval.store_list_preparing",
      "approval.store_recover_preparing",
      "approval.store_close",
    ]))
    expect(operationEvents.filter((event) => event.level === "error").map((event) => event.event)).toEqual(expect.arrayContaining([
      "approval.store_activate",
      "approval.store_decide",
      "approval.store_expire",
      "approval.store_mark_attempted",
      "approval.store_abandon_before_attempt",
      "approval.store_recover_preparing",
    ]))
    expect(operationEvents.every((event) => Object.keys(event.meta).length > 0)).toBe(true)
  })
})
