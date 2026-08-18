import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

import { afterEach, describe, expect, it, vi } from "vitest"

import { openApprovalStore, type ApprovalStore } from "../../heart/approval-store"

const APPROVAL_ID = "11111111-1111-4111-8111-111111111111"
const roots: string[] = []

function makeStorePair() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ouro-continuation-claim-"))
  roots.push(root)
  const databasePath = path.join(root, "approvals.sqlite")
  const options = {
    databasePath,
    now: () => new Date("2026-08-17T17:30:00.000Z"),
    randomUUID: () => APPROVAL_ID,
    randomBytes: (size: number) => Buffer.alloc(size, 0xab),
  }
  return { databasePath, first: openApprovalStore(options), second: openApprovalStore(options), options }
}

function makeSucceeded(store: ApprovalStore): void {
  const prepared = store.prepare({
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
      tool_calls: [{ id: "call_restart", type: "function", function: { name: "shell", arguments: "{\"command\":\"docker restart calibre-web\"}" } }],
    },
  })
  store.activate({ approvalId: APPROVAL_ID, checkpointDigest: "e".repeat(64), suspendedSessionRevision: "f".repeat(64) })
  store.bindPrompt({ approvalId: APPROVAL_ID, transport: "telegram", transportChatId: "7", transportMessageId: "99" })
  const claimed = store.decide({
    approvalId: APPROVAL_ID,
    decisionToken: prepared.decisionToken,
    decision: "approve",
    requesterId: "friend-ari",
    transport: "telegram",
    transportUserId: "42",
    transportChatId: "7",
    transportMessageId: "99",
    sessionKey: "telegram:chat-7",
    ownerId: "execution-owner",
  })
  store.markAttempted({ approvalId: APPROVAL_ID, ownerId: "execution-owner", epoch: claimed.epoch })
  store.complete({ approvalId: APPROVAL_ID, ownerId: "execution-owner", epoch: claimed.epoch, state: "succeeded", result: "restarted" })
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

describe("durable continuation claim", () => {
  it("allows exactly one SQLite CAS winner to enter the provider continuation", () => {
    const fixture = makeStorePair()
    makeSucceeded(fixture.first)
    const provider = vi.fn()

    const first = (fixture.first as any).claimContinuation({ approvalId: APPROVAL_ID, ownerId: "continuation-a" })
    const second = (fixture.second as any).claimContinuation({ approvalId: APPROVAL_ID, ownerId: "continuation-b" })
    if (first.claimed) provider(first)
    if (second.claimed) provider(second)

    expect([first.claimed, second.claimed].filter(Boolean)).toHaveLength(1)
    expect(provider).toHaveBeenCalledTimes(1)
    fixture.first.close()
    fixture.second.close()
  })

  it("persists a consumed continuation claim across process restart and never retries provider work", () => {
    const fixture = makeStorePair()
    makeSucceeded(fixture.first)
    const claimed = (fixture.first as any).claimContinuation({ approvalId: APPROVAL_ID, ownerId: "continuation-a" })
    expect(claimed.claimed).toBe(true)
    fixture.first.close()
    fixture.second.close()

    const restarted = openApprovalStore(fixture.options)
    const duplicate = (restarted as any).claimContinuation({ approvalId: APPROVAL_ID, ownerId: "continuation-after-restart" })
    expect(duplicate.claimed).toBe(false)
    expect(duplicate.record.continuationOwnerId).toBe("continuation-a")
    restarted.close()
  })

  it("fences continuation completion by owner and epoch", () => {
    const fixture = makeStorePair()
    makeSucceeded(fixture.first)
    const claim = (fixture.first as any).claimContinuation({ approvalId: APPROVAL_ID, ownerId: "continuation-a" })

    expect(() => (fixture.second as any).completeContinuation({
      approvalId: APPROVAL_ID,
      ownerId: "continuation-b",
      epoch: claim.record.continuationEpoch,
    })).toThrow()
    const completed = (fixture.first as any).completeContinuation({
      approvalId: APPROVAL_ID,
      ownerId: "continuation-a",
      epoch: claim.record.continuationEpoch,
    })
    expect(completed.continuedAt).toBe("2026-08-17T17:30:00.000Z")
    fixture.first.close()
    fixture.second.close()
  })
})
