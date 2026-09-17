import { generateKeyPairSync } from "node:crypto"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

import { describe, expect, it, vi } from "vitest"

import { authorityArtifactDigest, verifyAuthorityPayload } from "../../../heart/daemon/sanctuary-authority-codec"
import {
  FileSanctuaryHostAuthority,
  hostProposalCommitment,
  type HostProposalRequestV1,
} from "../../../heart/daemon/sanctuary-host-authority"
import {
  sanctuaryAuthorityPublicKeyDigest,
  type TelegramTransportObservationV1,
} from "../../../heart/daemon/sanctuary-telegram-authority-gateway"
import { signAuthorityPayload } from "../../../heart/daemon/sanctuary-authority-codec"
import { FileSanctuaryAuthorityLedger } from "../../../heart/daemon/sanctuary-authority-ledger"

const keys = generateKeyPairSync("ed25519")
const publicKeyDigest = sanctuaryAuthorityPublicKeyDigest(keys.privateKey)
const ownerObservation = signAuthorityPayload<TelegramTransportObservationV1>({
  domain: "ouro.sanctuary.telegram-observation.v1",
  keyId: "issuer-1",
  privateKey: keys.privateKey,
  payload: {
    targetHost: "sanctuary",
    botId: "123456",
    updateId: 41,
    updateClass: "message",
    userId: "42",
    chatId: "42",
    ownerEligible: true,
    messageId: "141",
    callbackQueryId: null,
    rawUpdateDigest: `tgu_${"a".repeat(43)}`,
    observedAt: "2026-09-16T20:00:00.000Z",
    settlement: "pending",
    nonce: "b".repeat(43),
    publicKeyDigest,
  },
})
const ownerObservationDigest = authorityArtifactDigest(ownerObservation.domain, ownerObservation.payload)

function proposal(overrides: Partial<HostProposalRequestV1> = {}): HostProposalRequestV1 {
  return {
    targetHost: "sanctuary",
    targetResource: "host",
    command: { kind: "executable", executable: "/usr/bin/id", arguments: ["-u"] },
    workingDirectoryProfile: "host.root.v1",
    environmentProfile: "host.clean.v1",
    timeoutMs: 60_000,
    verification: null,
    ownerObservation: {
      digest: ownerObservationDigest,
      updateId: 41,
      userId: "42",
      chatId: "42",
      messageId: "141",
    },
    ...overrides,
  }
}

function fixture(overrides: {
  now?: () => string
  resolveOwnerObservation?: () => typeof ownerObservation | null
  beforeWrite?: () => void
} = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ouro-host-authority-"))
  let nonce = 0
  const authority = new FileSanctuaryHostAuthority(root, {
    targetHost: "sanctuary",
    botId: "123456",
    ownerUserId: "42",
    ownerChatId: "42",
    keyId: "issuer-1",
    publicKeyDigest,
    publicKey: keys.publicKey,
    privateKey: keys.privateKey,
    now: overrides.now ?? (() => "2026-09-16T20:00:00.000Z"),
    nonce: () => Buffer.alloc(32, ++nonce).toString("base64url"),
    resolveOwnerObservation: overrides.resolveOwnerObservation ?? (() => ownerObservation),
    ...(overrides.beforeWrite ? { beforeWrite: overrides.beforeWrite } : {}),
  })
  return { authority, root }
}

describe("Sanctuary root host authority", () => {
  it.each([
    ["/bin/sh", "-ec", "printf unapproved"],
    ["/bin/sh", "-xc", "printf unapproved"],
    ["/usr/bin/node", "-p", "1+1"],
    ["/usr/bin/node", "--print=1+1", ""],
    ["/usr/bin/node", "-pe", "1+1"],
    ["/usr/bin/perl", "-E", "say 1"],
    ["/usr/bin/ruby", "-we", "puts 1"],
  ])("refuses inline code through %s %s before preparing a card", (interpreter, flag, source) => {
    const f = fixture()
    expect(() => f.authority.prepare(proposal({
      command: { kind: "script", interpreter, arguments: [flag, source].filter(Boolean), script: "printf safe\n" },
    }))).toThrow(/command is invalid/u)
  })

  it("retires registrations and unreserved permits without disguising reserved execution as cleanup", () => {
    const f = fixture()
    const ledger = new FileSanctuaryAuthorityLedger(f.root)
    const committed = f.authority.prepare(proposal())
    f.authority.commit({ registrationId: committed.registrationId, telegramMessageId: 500 })
    expect(f.authority.retireRegistrations(ledger)).toEqual([])
    expect(f.authority.status(committed.registrationId)?.state).toBe("expired")
    const pending = f.authority.prepare(proposal())
    expect(f.authority.retireRegistrations(ledger)).toEqual([])
    expect(f.authority.status(pending.registrationId)?.state).toBe("orphaned")
    const permit = (messageId: number) => {
      const prepared = f.authority.prepare(proposal())
      f.authority.commit({ registrationId: prepared.registrationId, telegramMessageId: messageId })
      f.authority.decide({ callbackQueryId: `retire-${messageId}`, callbackData: prepared.replyMarkup.inline_keyboard[0]![0]!.callback_data, telegramMessageId: messageId, userId: "42", chatId: "42", callbackObservationDigest: `sha256:${"c".repeat(64)}`, decidedAt: "2026-09-16T20:00:00.000Z" })
      const artifact = f.authority.issuePermit({ registrationId: prepared.registrationId, residentFriendId: "friend-owner", relationshipProfileId: "sanctuary-owner", relationshipProfileVersion: 7, requestId: `request-${messageId}`, sessionKey: "telegram:123456:42", sessionEventId: "evt_1234567890", residentApprovalId: `approval-${messageId}`, stewardPolicy: null })
      return { prepared, artifact }
    }
    const unreserved = permit(501)
    expect(f.authority.retireRegistrations(ledger)).toEqual([])
    expect(f.authority.status(unreserved.prepared.registrationId)?.state).toBe("retired")
    const reserved = permit(502)
    ledger.reserve({ permitId: String(reserved.artifact.payload.permitId), nonce: String(reserved.artifact.payload.nonce), permitDigest: authorityArtifactDigest(reserved.artifact.domain, reserved.artifact.payload), reservedAt: "2026-09-16T20:00:00.000Z" })
    expect(f.authority.retireRegistrations(ledger)).toEqual([reserved.prepared.registrationId])
    expect(f.authority.status(pending.registrationId)?.state).toBe("orphaned")
    expect(f.authority.status(committed.registrationId)?.state).toBe("expired")
    expect(f.authority.status(unreserved.prepared.registrationId)?.state).toBe("retired")
    expect(ledger.read(String(unreserved.artifact.payload.permitId))?.state).toBe("refused")
    expect(ledger.read(String(reserved.artifact.payload.permitId))?.state).toBe("reserved")
    expect(f.authority.retireRegistrations(ledger)).toEqual([reserved.prepared.registrationId])
    expect(f.authority.ownsMessage(501)).toBe(true)
    const existing = ledger.read(String(unreserved.artifact.payload.permitId))!
    const read = ledger.read.bind(ledger)
    const fault = vi.spyOn(ledger, "read").mockImplementation((id) => id === existing.permitId ? { ...existing, outcomeDigest: `sha256:${"f".repeat(64)}` } : read(id))
    try { expect(() => f.authority.retireRegistrations(ledger)).toThrow(/ledger changed/u) } finally { fault.mockRestore() }
  })
  it("does not claim another chat's card or renew an already-observed callback with a substituted digest", () => {
    const f = fixture()
    const prepared = f.authority.prepare(proposal())
    f.authority.commit({ registrationId: prepared.registrationId, telegramMessageId: 500 })
    const input = { callbackQueryId: "callback-new", callbackData: "unrelated", telegramMessageId: 500, userId: "42", chatId: "43", callbackObservationDigest: `sha256:${"c".repeat(64)}`, decidedAt: "2026-09-16T20:00:00.000Z" }
    expect(f.authority.claimCallback(input)).toBeNull()
    const valid = { ...input, chatId: "42", callbackData: prepared.replyMarkup.inline_keyboard[0]![0]!.callback_data }
    expect(f.authority.claimCallback(valid)?.payload.decision).not.toBeNull()
    expect(f.authority.claimCallback({ ...valid, callbackObservationDigest: `sha256:${"d".repeat(64)}` })?.payload.decision).toBeNull()
  })
  it("commits deterministic executable proposals and renders every blast-radius field", () => {
    const value = proposal()
    const committed = { ...value, expiresAt: "2026-09-16T20:05:00.000Z" }
    expect(hostProposalCommitment(committed)).toBe(hostProposalCommitment({ ...committed, command: { ...committed.command } }))
    const f = fixture()
    const prepared = f.authority.prepare(value)
    expect(prepared.expiresAt).toBe("2026-09-16T20:05:00.000Z")
    expect(prepared.prompt).toContain("unrestricted root, potentially destructive and persistent")
    expect(prepared.prompt).toContain("real Sanctuary host namespaces")
    expect(prepared.prompt).toContain("/usr/bin/id")
    expect(prepared.prompt).toContain("[&quot;-u&quot;]")
    expect(prepared.prompt).toContain("host.root.v1")
    expect(prepared.prompt).toContain("host.clean.v1")
    expect(prepared.prompt).toContain("60000 ms")
    expect(prepared.prompt).toContain(prepared.proposalDigest)
    expect(Buffer.byteLength(prepared.replyMarkup.inline_keyboard[0]![0]!.callback_data, "utf8")).toBeLessThanOrEqual(64)
    expect(Buffer.byteLength(prepared.replyMarkup.inline_keyboard[0]![1]!.callback_data, "utf8")).toBeLessThanOrEqual(64)
    expect(prepared.replyMarkup.inline_keyboard[0]![0]!.callback_data).not.toBe(prepared.registrationId)
  })

  it("renders byte-exact LF scripts and refuses deceptive or unrenderable proposal fields", () => {
    const f = fixture()
    const script = "printf '&lt;safe&gt;\\n'\nprintf 'done\\n'\n"
    const prepared = f.authority.prepare(proposal({
      command: { kind: "script", interpreter: "/bin/sh", arguments: [], script },
    }))
    expect(prepared.prompt).toContain("printf &#39;&amp;lt;safe&amp;gt;\\n&#39;\nprintf &#39;done\\n&#39;\n")
    expect(prepared.prompt).not.toContain("<safe>")

    for (const bad of [
      proposal({ targetResource: "host\nhidden" }),
      proposal({ targetResource: "h\u200bost" }),
      proposal({ command: { kind: "executable", executable: "id", arguments: [] } }),
      proposal({ command: { kind: "executable", executable: "/bin/sh", arguments: ["-c", "id"] } }),
      proposal({ command: { kind: "script", interpreter: "/bin/sh", arguments: [], script: "echo hi\r\n" } }),
      proposal({ command: { kind: "script", interpreter: "/bin/sh", arguments: [], script: "echo hi \n" } }),
      proposal({ command: { kind: "script", interpreter: "/usr/bin/node", arguments: ["-e"], script: "process.exit()\n" } }),
      proposal({ timeoutMs: 900_001 }),
    ]) {
      expect(() => f.authority.prepare(bad)).toThrow()
    }
  })

  it("persists a private prepared intent before send and invalidates it on restart reconciliation", () => {
    const f = fixture()
    const prepared = f.authority.prepare(proposal())
    const statePath = path.join(f.root, "authority", "host-authority.json")
    const state = JSON.parse(fs.readFileSync(statePath, "utf8")) as Record<string, unknown>
    expect(JSON.stringify(state)).toContain(prepared.registrationId)
    expect(JSON.stringify(state)).toContain(prepared.replyMarkup.inline_keyboard[0]![0]!.callback_data)

    const restarted = fixture()
    fs.mkdirSync(path.dirname(path.join(restarted.root, "authority", "host-authority.json")), { recursive: true })
    fs.copyFileSync(statePath, path.join(restarted.root, "authority", "host-authority.json"))
    expect(restarted.authority.reconcilePrepared()).toEqual([prepared.registrationId])
    expect(restarted.authority.status(prepared.registrationId)).toMatchObject({ state: "orphaned" })
  })

  it("commits a signed registration without exposing handles and exclusively owns its message", () => {
    const f = fixture()
    const prepared = f.authority.prepare(proposal())
    const registration = f.authority.commit({
      registrationId: prepared.registrationId,
      telegramMessageId: 501,
    })
    expect(registration).not.toHaveProperty("replyMarkup")
    expect(registration).not.toHaveProperty("approveHandle")
    const payload = verifyAuthorityPayload<Record<string, unknown>>({
      artifact: registration,
      expectedDomain: "ouro.sanctuary.host-registration.v1",
      expectedKeyId: "issuer-1",
      publicKey: keys.publicKey,
    })
    expect(payload).toMatchObject({
      registrationId: prepared.registrationId,
      telegramMessageId: 501,
      proposalDigest: prepared.proposalDigest,
      ownerObservationDigest,
    })
    expect(f.authority.ownsMessage(501)).toBe(true)
    expect(f.authority.ownsPrompt(prepared.prompt)).toBe(true)
    expect(f.authority.ownsPrompt("ordinary owner message")).toBe(false)
  })

  it("accepts only the exact root-observed owner callback and consumes each decision once", () => {
    const f = fixture()
    const prepared = f.authority.prepare(proposal())
    f.authority.commit({ registrationId: prepared.registrationId, telegramMessageId: 501 })
    const approveHandle = prepared.replyMarkup.inline_keyboard[0]![0]!.callback_data
    const decision = f.authority.decide({
      callbackQueryId: "callback-1",
      callbackData: approveHandle,
      telegramMessageId: 501,
      userId: "42",
      chatId: "42",
      callbackObservationDigest: `sha256:${"c".repeat(64)}`,
      decidedAt: "2026-09-16T20:01:00.000Z",
    })
    expect(verifyAuthorityPayload<Record<string, unknown>>({
      artifact: decision,
      expectedDomain: "ouro.sanctuary.host-decision.v1",
      expectedKeyId: "issuer-1",
      publicKey: keys.publicKey,
    })).toMatchObject({ registrationId: prepared.registrationId, decision: "approve" })
    expect(f.authority.decide({
      callbackQueryId: "callback-2",
      callbackData: approveHandle,
      telegramMessageId: 501,
      userId: "42",
      chatId: "42",
      callbackObservationDigest: `sha256:${"d".repeat(64)}`,
      decidedAt: "2026-09-16T20:01:01.000Z",
    })).toBeNull()
  })

  it("refuses non-owner, changed-message, unknown-handle, duplicate-callback, and expired decisions", () => {
    const f = fixture()
    const prepared = f.authority.prepare(proposal())
    f.authority.commit({ registrationId: prepared.registrationId, telegramMessageId: 501 })
    const handle = prepared.replyMarkup.inline_keyboard[0]![0]!.callback_data
    const base = {
      callbackQueryId: "callback-1",
      callbackData: handle,
      telegramMessageId: 501,
      userId: "42",
      chatId: "42",
      callbackObservationDigest: `sha256:${"c".repeat(64)}`,
      decidedAt: "2026-09-16T20:01:00.000Z",
    }
    for (const changed of [
      { userId: "84" },
      { chatId: "84" },
      { telegramMessageId: 502 },
      { callbackData: "unknown" },
      { callbackQueryId: "" },
      { callbackObservationDigest: "bad" },
      { decidedAt: "2026-09-16T20:05:00.001Z" },
    ]) {
      expect(() => f.authority.decide({ ...base, ...changed })).toThrow()
    }
    const duplicate = fixture()
    const duplicatePrepared = duplicate.authority.prepare(proposal())
    duplicate.authority.commit({ registrationId: duplicatePrepared.registrationId, telegramMessageId: 501 })
    const duplicateHandle = duplicatePrepared.replyMarkup.inline_keyboard[0]![0]!.callback_data
    duplicate.authority.decide({ ...base, callbackData: duplicateHandle })
    expect(() => duplicate.authority.decide({ ...base, callbackData: duplicateHandle })).toThrow()
  })

  it("refuses changed or non-owner observations before preparing any durable intent", () => {
    for (const resolveOwnerObservation of [
      () => null,
      () => ({ ...ownerObservation, payload: { ...ownerObservation.payload, ownerEligible: false } }),
      () => ({ ...ownerObservation, payload: { ...ownerObservation.payload, messageId: "999" } }),
    ]) {
      const f = fixture({ resolveOwnerObservation })
      expect(() => f.authority.prepare(proposal())).toThrow(/observation/u)
      expect(fs.existsSync(path.join(f.root, "authority", "host-authority.json"))).toBe(false)
    }
  })

  it("does not report a committed registration when durable commit persistence fails", () => {
    let writes = 0
    const f = fixture({ beforeWrite: () => {
      writes += 1
      if (writes === 2) throw new Error("disk failure")
    } })
    const prepared = f.authority.prepare(proposal())
    expect(() => f.authority.commit({ registrationId: prepared.registrationId, telegramMessageId: 501 })).toThrow("disk failure")
    expect(f.authority.status(prepared.registrationId)).toMatchObject({ state: "prepared" })
  })

  it("issues one signed two-minute permit only after the exact positive callback", () => {
    let now = "2026-09-16T20:00:00.000Z"
    const f = fixture({ now: () => now })
    const prepared = f.authority.prepare(proposal())
    f.authority.commit({ registrationId: prepared.registrationId, telegramMessageId: 501 })
    now = "2026-09-16T20:01:00.000Z"
    f.authority.decide({
      callbackQueryId: "callback-permit",
      callbackData: prepared.replyMarkup.inline_keyboard[0]![0]!.callback_data,
      telegramMessageId: 501,
      userId: "42",
      chatId: "42",
      callbackObservationDigest: `sha256:${"c".repeat(64)}`,
      decidedAt: now,
    })
    const permit = f.authority.issuePermit({
      registrationId: prepared.registrationId,
      residentFriendId: "friend-owner",
      relationshipProfileId: "sanctuary-owner",
      relationshipProfileVersion: 7,
      requestId: "request-1",
      sessionKey: "telegram:123456:42",
      sessionEventId: "evt_1234567890",
      residentApprovalId: "approval-1",
      stewardPolicy: null,
    })
    expect(verifyAuthorityPayload<Record<string, unknown>>({
      artifact: permit,
      expectedDomain: "ouro.sanctuary.host-permit.v1",
      expectedKeyId: "issuer-1",
      publicKey: keys.publicKey,
    })).toMatchObject({
      targetHost: "sanctuary",
      registrationId: prepared.registrationId,
      effectClass: "owner_approved_arbitrary_host",
      executionProfile: "host.owner_approved.v1",
      residentFriendId: "friend-owner",
      relationshipProfileVersion: 7,
      issuedAt: now,
      expiresAt: "2026-09-16T20:03:00.000Z",
    })
    expect(() => f.authority.issuePermit({
      registrationId: prepared.registrationId,
      residentFriendId: "friend-owner",
      relationshipProfileId: "sanctuary-owner",
      relationshipProfileVersion: 7,
      requestId: "request-1",
      sessionKey: "telegram:123456:42",
      sessionEventId: "evt_1234567890",
      residentApprovalId: "approval-1",
      stewardPolicy: null,
    })).toThrow(/state|permit/u)

    const denied = fixture()
    const deniedPrepared = denied.authority.prepare(proposal())
    denied.authority.commit({ registrationId: deniedPrepared.registrationId, telegramMessageId: 501 })
    denied.authority.decide({
      callbackQueryId: "callback-denied",
      callbackData: deniedPrepared.replyMarkup.inline_keyboard[0]![1]!.callback_data,
      telegramMessageId: 501,
      userId: "42",
      chatId: "42",
      callbackObservationDigest: `sha256:${"d".repeat(64)}`,
      decidedAt: "2026-09-16T20:01:00.000Z",
    })
    expect(() => denied.authority.issuePermit({
      registrationId: deniedPrepared.registrationId,
      residentFriendId: "friend-owner",
      relationshipProfileId: "sanctuary-owner",
      relationshipProfileVersion: 7,
      requestId: "request-1",
      sessionKey: "telegram:123456:42",
      sessionEventId: "evt_1234567890",
      residentApprovalId: "approval-1",
      stewardPolicy: null,
    })).toThrow(/state/u)
  })

  it("expires an untouched registration once and leaves a durable terminal card update", () => {
    let now = "2026-09-16T20:00:00.000Z"
    const f = fixture({ now: () => now })
    const prepared = f.authority.prepare(proposal())
    f.authority.commit({ registrationId: prepared.registrationId, telegramMessageId: 501 })
    expect(f.authority.expireRegistrations()).toEqual([])
    now = "2026-09-16T20:05:00.001Z"
    expect(f.authority.expireRegistrations()).toEqual([prepared.registrationId])
    expect(f.authority.expireRegistrations()).toEqual([])
    expect(f.authority.status(prepared.registrationId)).toMatchObject({ state: "expired", cardPending: true })
    const edit = f.authority.pendingCardEdit(prepared.registrationId)
    expect(edit).toMatchObject({ telegramMessageId: 501, revision: "expired", text: expect.stringContaining("Expired.") })
    f.authority.markCardEdited(prepared.registrationId, "expired")
    expect(f.authority.pendingCardEdit(prepared.registrationId)).toBeNull()
  })

  it("expires an approved registration when its two-minute permit issue window closes", () => {
    let now = "2026-09-16T20:00:00.000Z"
    const f = fixture({ now: () => now })
    const prepared = f.authority.prepare(proposal())
    f.authority.commit({ registrationId: prepared.registrationId, telegramMessageId: 501 })
    f.authority.decide({
      callbackQueryId: "callback-expiry",
      callbackData: prepared.replyMarkup.inline_keyboard[0]![0]!.callback_data,
      telegramMessageId: 501,
      userId: "42",
      chatId: "42",
      callbackObservationDigest: `sha256:${"d".repeat(64)}`,
      decidedAt: now,
    })
    now = "2026-09-16T20:02:00.001Z"
    expect(f.authority.expireRegistrations()).toEqual([prepared.registrationId])
    expect(f.authority.status(prepared.registrationId)).toMatchObject({ state: "expired", cardPending: true })
    expect(() => f.authority.prepare(proposal())).not.toThrow()

    now = "2026-09-16T20:00:00.000Z"
    const late = fixture({ now: () => now })
    const latePrepared = late.authority.prepare(proposal())
    late.authority.commit({ registrationId: latePrepared.registrationId, telegramMessageId: 502 })
    late.authority.decide({
      callbackQueryId: "callback-late-issue",
      callbackData: latePrepared.replyMarkup.inline_keyboard[0]![0]!.callback_data,
      telegramMessageId: 502,
      userId: "42",
      chatId: "42",
      callbackObservationDigest: `sha256:${"d".repeat(64)}`,
      decidedAt: now,
    })
    now = "2026-09-16T20:02:00.001Z"
    expect(() => late.authority.issuePermit({
      registrationId: latePrepared.registrationId,
      residentFriendId: "friend",
      relationshipProfileId: "owner",
      relationshipProfileVersion: 1,
      requestId: "request",
      sessionKey: "session",
      sessionEventId: "event",
      residentApprovalId: "approval",
      stewardPolicy: null,
    })).toThrow(/window/u)
    expect(late.authority.status(latePrepared.registrationId)).toMatchObject({ state: "expired" })
  })
})
