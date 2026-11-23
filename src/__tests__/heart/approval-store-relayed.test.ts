import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import { ApprovalStoreError, openApprovalStore, parseApprovalRecord, type ApprovalStore } from "../../heart/approval-store"

// A relayed answer is Ari saying no through Slugger instead of tapping the card: the store records it as its own actor.
const NOW = "2026-08-17T17:15:00.000Z"
const EXPIRES = "2026-08-17T17:25:00.000Z"
const UUID = "11111111-1111-4111-8111-111111111111"
const SLUGGER = "did:key:z6MkSyntheticSluggerRoute"
const roots: string[] = []

function open(now = NOW): ApprovalStore {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ouro-approval-relayed-"))
  roots.push(root)
  return openApprovalStore({ databasePath: path.join(root, "approvals.sqlite"), now: () => new Date(now), randomUUID: () => UUID, randomBytes: (size) => Buffer.alloc(size, 0xab) })
}

function proposed(store: ApprovalStore) {
  const prepared = store.prepare({
    toolCallId: "call_restart_1", toolName: "shell", arguments: { command: "docker restart calibre-web" },
    schemaDigest: "a".repeat(64), toolDigest: "b".repeat(64), policyDigest: "c".repeat(64), policyId: "shell.docker-lifecycle.v1",
    sessionKey: "telegram:chat-7", sessionPath: "/tmp/disposable-agent/session.json", baseSessionRevision: "d".repeat(64),
    checkpointDigest: "e".repeat(64), requesterId: "friend-ari", transport: "telegram", transportUserId: "42", transportChatId: "7",
    expiresAt: EXPIRES,
    frozenAssistantMessage: { role: "assistant", content: null, tool_calls: [{ id: "call_restart_1", type: "function", function: { name: "shell", arguments: "{}" } }] },
  })
  store.activate({ approvalId: UUID, checkpointDigest: prepared.record.checkpointDigest, suspendedSessionRevision: "f".repeat(64) })
  store.bindPrompt({ approvalId: UUID, transport: "telegram", transportChatId: "7", transportMessageId: "99" })
  return prepared.decisionToken
}

const relayed = (decisionToken: string, overrides: Record<string, unknown> = {}) => ({
  approvalId: UUID, decisionToken, decision: "deny" as const, senderDid: SLUGGER, envelopeBindingId: "bind-1", ...overrides,
})

function code(fn: () => unknown): string {
  try { fn() } catch (error) { return error instanceof ApprovalStoreError ? error.code : "other" }
  return "none"
}

afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }) })

describe("decideRelayed", () => {
  it("denies a proposed approval and records who relayed it", () => {
    const store = open()
    const token = proposed(store)
    const record = store.decideRelayed(relayed(token))
    expect(record.state).toBe("denied")
    expect(record.relayDecision).toEqual({ actor: "owner-via-relay", senderDid: SLUGGER, envelopeBindingId: "bind-1", decidedAt: NOW })
    expect(store.read(UUID)).toEqual(record)
    expect(parseApprovalRecord(JSON.parse(JSON.stringify(record)))).toEqual(record)
    // The tap path's binding still answers a repeat deny on the same record.
    expect(store.read(UUID)?.transportMessageId).toBe("99")
  })

  it("answers a repeat of the same relayed answer with the same record, and refuses any other", () => {
    const store = open()
    const token = proposed(store)
    const first = store.decideRelayed(relayed(token))
    expect(store.decideRelayed(relayed(token))).toEqual(first)
    expect(code(() => store.decideRelayed(relayed(token, { envelopeBindingId: "bind-2" })))).toBe("decision_not_eligible")
  })

  it("refuses a wrong or empty decision token", () => {
    const store = open()
    const token = proposed(store)
    expect(code(() => store.decideRelayed(relayed(`${token}x`)))).toBe("decision_binding_mismatch")
    expect(code(() => store.decideRelayed(relayed("")))).toBe("decision_binding_mismatch")
    expect(store.read(UUID)?.state).toBe("proposed")
  })

  it("refuses approve, whatever the caller's types say", () => {
    const store = open()
    const token = proposed(store)
    expect(code(() => store.decideRelayed(relayed(token, { decision: "approve" }) as never))).toBe("relay_decision_not_allowed")
    expect(store.read(UUID)?.state).toBe("proposed")
  })

  it.each([[{ senderDid: "" }], [{ envelopeBindingId: "" }], [{ senderDid: 7 }]])("refuses a relay without its provenance %j", (overrides) => {
    const store = open()
    const token = proposed(store)
    expect(code(() => store.decideRelayed(relayed(token, overrides) as never))).toBe("invalid_relay_decision")
  })

  it("expires an approval whose time is up instead of denying it", () => {
    const store = open()
    const token = proposed(store)
    const record = store.decideRelayed(relayed(token, { decisionAt: Date.parse(EXPIRES) }))
    expect(record.state).toBe("expired")
    expect(record.relayDecision).toBeUndefined()
    expect(code(() => store.decideRelayed(relayed(token)))).toBe("decision_not_eligible")
  })

  it("refuses a bad decision time on a proposed approval", () => {
    const store = open()
    const token = proposed(store)
    expect(code(() => store.decideRelayed(relayed(token, { decisionAt: 1.5 })))).toBe("invalid_decision_time")
  })

  it("refuses an approval a tap already decided", () => {
    const store = open()
    const token = proposed(store)
    store.decide({ approvalId: UUID, decisionToken: token, decision: "deny", requesterId: "friend-ari", transport: "telegram", transportUserId: "42", transportChatId: "7", transportMessageId: "99", sessionKey: "telegram:chat-7", ownerId: "worker-a" })
    expect(code(() => store.decideRelayed(relayed(token)))).toBe("decision_not_eligible")
    const approved = open()
    const approvedToken = proposed(approved)
    approved.decide({ approvalId: UUID, decisionToken: approvedToken, decision: "approve", requesterId: "friend-ari", transport: "telegram", transportUserId: "42", transportChatId: "7", transportMessageId: "99", sessionKey: "telegram:chat-7", ownerId: "worker-a" })
    expect(code(() => approved.decideRelayed(relayed(approvedToken)))).toBe("decision_not_eligible")
  })

  it("refuses an unknown approval", () => {
    expect(code(() => open().decideRelayed(relayed("token")))).toBe("approval_not_found")
  })
})

describe("a relay decision in a stored record", () => {
  it("is valid only on a denied record, and only in its exact shape", () => {
    const store = open()
    const denied = store.decideRelayed(relayed(proposed(store)))
    const raw = JSON.parse(JSON.stringify(denied)) as Record<string, unknown>
    const relay = raw.relayDecision as Record<string, unknown>
    for (const bad of [
      { ...relay, actor: "owner" }, { ...relay, senderDid: "" }, { ...relay, envelopeBindingId: 5 }, { ...relay, decidedAt: "soon" },
      { ...relay, extra: true }, null, "owner-via-relay",
    ]) expect(code(() => parseApprovalRecord({ ...raw, relayDecision: bad }))).toBe("corrupt_record")
    expect(code(() => parseApprovalRecord({ ...raw, state: "expired" }))).toBe("corrupt_record")
  })
})
