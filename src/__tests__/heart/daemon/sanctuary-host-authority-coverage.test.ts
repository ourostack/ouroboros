import { generateKeyPairSync } from "node:crypto"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

import { describe, expect, it } from "vitest"

import { authorityArtifactDigest, signAuthorityPayload } from "../../../heart/daemon/sanctuary-authority-codec"
import {
  FileSanctuaryHostAuthority,
  sanctuaryHostAuthorityStatePath,
  type HostProposalRequestV1,
} from "../../../heart/daemon/sanctuary-host-authority"
import { sanctuaryAuthorityPublicKeyDigest, type TelegramTransportObservationV1 } from "../../../heart/daemon/sanctuary-telegram-authority-gateway"
import { readSessionTransaction, withImmediateSessionTurnLease, writeSessionTransaction } from "../../../mind/session-transaction"

const keys = generateKeyPairSync("ed25519")
const publicKeyDigest = sanctuaryAuthorityPublicKeyDigest(keys.privateKey)
const observation = signAuthorityPayload<TelegramTransportObservationV1>({
  domain: "ouro.sanctuary.telegram-observation.v1",
  keyId: "issuer-1",
  privateKey: keys.privateKey,
  payload: {
    targetHost: "sanctuary",
    botId: "123456",
    updateId: 1,
    updateClass: "message",
    userId: "42",
    chatId: "42",
    ownerEligible: true,
    messageId: "101",
    callbackQueryId: null,
    rawUpdateDigest: `tgu_${"a".repeat(43)}`,
    observedAt: "2026-09-16T20:00:00.000Z",
    settlement: "pending",
    nonce: "b".repeat(43),
    publicKeyDigest,
  },
})
const observationDigest = authorityArtifactDigest(observation.domain, observation.payload)

function request(overrides: Partial<HostProposalRequestV1> = {}): HostProposalRequestV1 {
  return {
    targetHost: "sanctuary",
    targetResource: "host",
    command: { kind: "executable", executable: "/usr/bin/id", arguments: [] },
    workingDirectoryProfile: "host.root.v1",
    environmentProfile: "host.clean.v1",
    timeoutMs: 1_000,
    verification: null,
    ownerObservation: {
      digest: observationDigest,
      updateId: 1,
      userId: "42",
      chatId: "42",
      messageId: "101",
    },
    ...overrides,
  }
}

function authority(options: Record<string, unknown> = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ouro-host-authority-coverage-"))
  let nonce = 0
  return {
    root,
    value: new FileSanctuaryHostAuthority(root, {
      targetHost: "sanctuary",
      botId: "123456",
      ownerUserId: "42",
      ownerChatId: "42",
      keyId: "issuer-1",
      publicKeyDigest,
      publicKey: keys.publicKey,
      privateKey: keys.privateKey,
      now: () => "2026-09-16T20:00:00.000Z",
      nonce: () => Buffer.alloc(32, ++nonce).toString("base64url"),
      resolveOwnerObservation: () => observation,
      ...options,
    }),
  }
}

describe("Sanctuary host authority refusal coverage", () => {
  it("refuses every malformed proposal boundary before state mutation", () => {
    const malformed: unknown[] = [
      null,
      {},
      { ...request(), extra: true },
      request({ targetHost: "other" }),
      request({ targetResource: "" }),
      request({ targetResource: "x".repeat(257) }),
      request({ workingDirectoryProfile: "other" as "host.root.v1" }),
      request({ environmentProfile: "other" as "host.clean.v1" }),
      request({ timeoutMs: 999 }),
      request({ timeoutMs: 1.5 }),
      request({ verification: {} as never }),
      request({ verification: "bad" as never }),
      request({ verification: { profile: "", expectedStateDigest: observationDigest } }),
      request({ verification: { profile: "file.digest.v1", expectedStateDigest: "bad" } }),
      request({ ownerObservation: null as never }),
      request({ ownerObservation: { ...request().ownerObservation, digest: "bad" } }),
      request({ ownerObservation: { ...request().ownerObservation, updateId: -1 } }),
      request({ ownerObservation: { ...request().ownerObservation, userId: "0" } }),
      request({ ownerObservation: { ...request().ownerObservation, chatId: "chat" } }),
      request({ ownerObservation: { ...request().ownerObservation, messageId: "" } }),
      request({ command: null as never }),
      request({ command: { kind: "unknown" } as never }),
      request({ command: { kind: "executable", executable: "/usr/bin/id", arguments: "bad" as never } }),
      request({ command: { kind: "executable", executable: "/usr/bin/../bin/id", arguments: [] } }),
      request({ command: { kind: "executable", executable: "/bin/sh", arguments: ["--eval=id"] } }),
      request({ command: { kind: "script", interpreter: "sh", arguments: [], script: "echo\n" } }),
      request({ command: { kind: "script", interpreter: "/bin/sh", arguments: ["bad\n"], script: "echo\n" } }),
      request({ command: { kind: "script", interpreter: "/bin/sh", arguments: [], script: "" } }),
      request({ command: { kind: "script", interpreter: "/bin/sh", arguments: [], script: "x".repeat(2_049) } }),
      request({ command: { kind: "script", interpreter: "/bin/sh", arguments: [], script: "echo\tbad\n" } }),
    ]
    for (const candidate of malformed) {
      const f = authority()
      expect(() => f.value.prepare(candidate as HostProposalRequestV1)).toThrow()
      expect(fs.existsSync(sanctuaryHostAuthorityStatePath(f.root))).toBe(false)
    }
    const verified = authority()
    expect(verified.value.prepare(request({
      targetResource: "/tmp/verified-state",
      verification: { profile: "file.digest.v1", expectedStateDigest: observationDigest },
    })).prompt).toContain("file.digest.v1")
    const oversized = authority()
    expect(() => oversized.value.prepare(request({
      command: { kind: "script", interpreter: "/bin/sh", arguments: [], script: "&".repeat(2_048) },
    }))).toThrow(/too large/u)
  })

  it("refuses invalid constructor clocks, nonces, active registrations, commits, handles, cards, and ids", () => {
    expect(() => new FileSanctuaryHostAuthority("relative", {} as never)).toThrow(/absolute/u)
    expect(() => authority({ now: () => "bad" }).value.prepare(request())).toThrow(/time/u)
    expect(() => authority({ nonce: () => "bad" }).value.prepare(request())).toThrow(/nonce/u)

    const f = authority()
    const prepared = f.value.prepare(request())
    expect(() => f.value.prepare(request())).toThrow(/active/u)
    for (const input of [
      { registrationId: "bad", telegramMessageId: 1 },
      { registrationId: prepared.registrationId, telegramMessageId: 0 },
      { registrationId: prepared.registrationId, telegramMessageId: 1.5 },
    ]) expect(() => f.value.commit(input)).toThrow()
    expect(() => f.value.commit({ registrationId: `hostreg-${"z".repeat(43)}`, telegramMessageId: 1 })).toThrow(/prepared/u)
    f.value.commit({ registrationId: prepared.registrationId, telegramMessageId: 1 })
    expect(f.value.ownsMessage(0)).toBe(false)
    expect(f.value.ownsMessage(2)).toBe(false)
    expect(f.value.ownsHandle("unknown")).toBe(false)
    expect(f.value.ownsHandle(null as never)).toBe(false)
    expect(f.value.ownsPrompt(null as never)).toBe(false)
    expect(f.value.ownsPrompt("OURO ROOT HOST APPROVAL forged")).toBe(true)
    expect(f.value.ownerMutationFrozen()).toBe(false)
    expect(f.value.decisionForCallback("")).toBeNull()
    expect(f.value.decisionForCallback("missing")).toBeNull()
    expect(() => f.value.status("bad")).toThrow()
    expect(f.value.status(`hostreg-${"z".repeat(43)}`)).toBeNull()
    expect(() => f.value.markCardEdited(prepared.registrationId, "denied")).toThrow(/revision/u)
    expect(f.value.reconcilePrepared()).toEqual([])
  })

  it("refuses malformed permit correlation, policy, issue windows, receipts, and changed card revisions", () => {
    let now = "2026-09-16T20:00:00.000Z"
    const f = authority({ now: () => now })
    const prepared = f.value.prepare(request())
    f.value.commit({ registrationId: prepared.registrationId, telegramMessageId: 1 })
    f.value.decide({
      callbackQueryId: "callback",
      callbackData: prepared.replyMarkup.inline_keyboard[0]![0]!.callback_data,
      telegramMessageId: 1,
      userId: "42",
      chatId: "42",
      callbackObservationDigest: `sha256:${"c".repeat(64)}`,
      decidedAt: now,
    })
    const correlation = {
      registrationId: prepared.registrationId,
      residentFriendId: "friend",
      relationshipProfileId: "owner",
      relationshipProfileVersion: 1,
      requestId: "request",
      sessionKey: "session",
      sessionEventId: "event",
      residentApprovalId: "approval",
      stewardPolicy: null,
    }
    for (const changed of [
      { extra: true },
      { registrationId: "bad" },
      { residentFriendId: "" },
      { relationshipProfileId: "" },
      { relationshipProfileVersion: 0 },
      { relationshipProfileVersion: 1.5 },
      { requestId: "" },
      { sessionKey: "" },
      { sessionEventId: "" },
      { residentApprovalId: "" },
      { stewardPolicy: {} },
      { stewardPolicy: { key: "", version: 1, digest: observationDigest } },
      { stewardPolicy: { key: "policy", version: 0, digest: observationDigest } },
      { stewardPolicy: { key: "policy", version: 1, digest: "bad" } },
    ]) expect(() => f.value.issuePermit({ ...correlation, ...changed } as never)).toThrow()

    now = "2026-09-16T19:59:59.999Z"
    expect(() => f.value.issuePermit(correlation)).toThrow(/window/u)
    now = "2026-09-16T20:01:00.000Z"
    const permit = f.value.issuePermit(correlation)
    expect(() => f.value.completeExecution("bad", {} as never)).toThrow()
    const receipt = (overrides: Record<string, unknown> = {}) => signAuthorityPayload({
      domain: "ouro.sanctuary.host-receipt.v1",
      keyId: "issuer-1",
      privateKey: keys.privateKey,
      payload: {
        state: "verified",
        targetHost: "sanctuary",
        registrationId: prepared.registrationId,
        permitId: permit.payload.permitId,
        permitDigest: authorityArtifactDigest(permit.domain, permit.payload),
        publicKeyDigest,
        startedAt: "2026-09-16T20:01:00.000Z",
        completedAt: "2026-09-16T20:01:01.000Z",
        ...overrides,
      },
    })
    expect(() => f.value.completeExecution(prepared.registrationId, receipt({ state: "other" }))).toThrow(/state/u)
    expect(() => f.value.completeExecution(prepared.registrationId, receipt({ permitId: "changed" }))).toThrow(/permit/u)
    const validReceipt = receipt()
    f.value.completeExecution(prepared.registrationId, validReceipt)
    expect(f.value.status(prepared.registrationId)).toMatchObject({ state: "executed", receipt: validReceipt })
    expect(() => f.value.completeExecution(prepared.registrationId, validReceipt)).toThrow(/state changed/u)
    expect(f.value.pendingCardEdit(prepared.registrationId)).toMatchObject({ revision: "executed_verified" })
    expect(() => f.value.pendingCardEdit("bad")).toThrow()

    const scriptAuthority = authority({ now: () => now })
    const scriptPrepared = scriptAuthority.value.prepare(request({
      command: { kind: "script", interpreter: "/bin/sh", arguments: [], script: "echo ok\n" },
    }))
    scriptAuthority.value.commit({ registrationId: scriptPrepared.registrationId, telegramMessageId: 2 })
    scriptAuthority.value.decide({
      callbackQueryId: "script-callback",
      callbackData: scriptPrepared.replyMarkup.inline_keyboard[0]![0]!.callback_data,
      telegramMessageId: 2,
      userId: "42",
      chatId: "42",
      callbackObservationDigest: `sha256:${"d".repeat(64)}`,
      decidedAt: now,
    })
    expect(scriptAuthority.value.issuePermit({ ...correlation, registrationId: scriptPrepared.registrationId }).payload.scriptDigest).toMatch(DIGEST_FOR_TEST)
  })

  it("fails closed on malformed durable state in both reads and writes", () => {
    const f = authority()
    const statePath = sanctuaryHostAuthorityStatePath(f.root)
    fs.mkdirSync(path.dirname(statePath), { recursive: true })
    fs.writeFileSync(statePath, "{", { mode: 0o600 })
    expect(() => f.value.status(`hostreg-${"a".repeat(43)}`)).toThrow()
    expect(() => f.value.prepare(request())).toThrow()

    const structured = authority()
    const structuredPath = sanctuaryHostAuthorityStatePath(structured.root)
    withImmediateSessionTurnLease(structuredPath, (lease) => {
      const transaction = readSessionTransaction(structuredPath, lease)
      writeSessionTransaction(structuredPath, { schemaVersion: 2 }, { lease, expectedRevision: transaction.revision })
    })
    expect(() => structured.value.status(`hostreg-${"a".repeat(43)}`)).toThrow(/state/u)
    expect(() => structured.value.prepare(request())).toThrow(/state/u)

    const nullRead = authority()
    const nullReadPath = sanctuaryHostAuthorityStatePath(nullRead.root)
    withImmediateSessionTurnLease(nullReadPath, (lease) => {
      const transaction = readSessionTransaction(nullReadPath, lease)
      writeSessionTransaction(nullReadPath, null, { lease, expectedRevision: transaction.revision })
    })
    expect(() => nullRead.value.status(`hostreg-${"a".repeat(43)}`)).toThrow(/state/u)

    const nullWrite = authority()
    const nullWritePath = sanctuaryHostAuthorityStatePath(nullWrite.root)
    withImmediateSessionTurnLease(nullWritePath, (lease) => {
      const transaction = readSessionTransaction(nullWritePath, lease)
      writeSessionTransaction(nullWritePath, null, { lease, expectedRevision: transaction.revision })
    })
    expect(() => nullWrite.value.prepare(request())).toThrow(/state/u)
  })

  it("covers committed, approved, permitted, duplicate registration, message, default time, and invalid decision time states", () => {
    const committed = authority()
    const committedPrepared = committed.value.prepare(request())
    committed.value.commit({ registrationId: committedPrepared.registrationId, telegramMessageId: 1 })
    expect(committed.value.expireRegistrations()).toEqual([])
    expect(() => committed.value.prepare(request())).toThrow(/active/u)

    const approved = authority()
    const approvedPrepared = approved.value.prepare(request())
    approved.value.commit({ registrationId: approvedPrepared.registrationId, telegramMessageId: 1 })
    approved.value.decide({
      callbackQueryId: "approved",
      callbackData: approvedPrepared.replyMarkup.inline_keyboard[0]![0]!.callback_data,
      telegramMessageId: 1,
      userId: "42",
      chatId: "42",
      callbackObservationDigest: `sha256:${"c".repeat(64)}`,
      decidedAt: "2026-09-16T20:00:00.000Z",
    })
    expect(approved.value.decisionForCallback("approved")).toMatchObject({ domain: "ouro.sanctuary.host-decision.v1" })
    expect(() => approved.value.prepare(request())).toThrow(/active/u)
    expect(() => approved.value.decide({
      callbackQueryId: "bad-time",
      callbackData: approvedPrepared.replyMarkup.inline_keyboard[0]![0]!.callback_data,
      telegramMessageId: 1,
      userId: "42",
      chatId: "42",
      callbackObservationDigest: `sha256:${"c".repeat(64)}`,
      decidedAt: 42 as never,
    })).toThrow()

    approved.value.issuePermit({
      registrationId: approvedPrepared.registrationId,
      residentFriendId: "friend",
      relationshipProfileId: "owner",
      relationshipProfileVersion: 1,
      requestId: "request",
      sessionKey: "session",
      sessionEventId: "event",
      residentApprovalId: "approval",
      stewardPolicy: { key: "policy", version: 1, digest: observationDigest },
    })
    expect(() => approved.value.prepare(request())).toThrow(/active/u)

    const fixedNonce = Buffer.alloc(32, 7).toString("base64url")
    const duplicate = authority({ nonce: () => fixedNonce })
    const first = duplicate.value.prepare(request())
    duplicate.value.commit({ registrationId: first.registrationId, telegramMessageId: 1 })
    duplicate.value.decide({
      callbackQueryId: "denied",
      callbackData: first.replyMarkup.inline_keyboard[0]![1]!.callback_data,
      telegramMessageId: 1,
      userId: "42",
      chatId: "42",
      callbackObservationDigest: `sha256:${"c".repeat(64)}`,
      decidedAt: "2026-09-16T20:00:00.000Z",
    })
    expect(() => duplicate.value.prepare(request())).toThrow(/already exists/u)

    const messageDuplicate = authority()
    const firstMessage = messageDuplicate.value.prepare(request())
    messageDuplicate.value.commit({ registrationId: firstMessage.registrationId, telegramMessageId: 1 })
    messageDuplicate.value.decide({
      callbackQueryId: "denied-message",
      callbackData: firstMessage.replyMarkup.inline_keyboard[0]![1]!.callback_data,
      telegramMessageId: 1,
      userId: "42",
      chatId: "42",
      callbackObservationDigest: `sha256:${"c".repeat(64)}`,
      decidedAt: "2026-09-16T20:00:00.000Z",
    })
    const secondMessage = messageDuplicate.value.prepare(request())
    expect(() => messageDuplicate.value.commit({ registrationId: secondMessage.registrationId, telegramMessageId: 1 })).toThrow(/message already/u)

    const defaults = authority({ now: undefined, nonce: undefined })
    expect(defaults.value.status(`hostreg-${"a".repeat(43)}`)).toBeNull()
    expect(defaults.value.expireRegistrations()).toEqual([])
    expect(defaults.value.prepare(request()).registrationId).toMatch(/^hostreg-/u)
    expect(() => authority({ nonce: () => "bad" }).value.prepare(request())).toThrow(/nonce/u)
    expect(() => authority({ now: () => "bad" }).value.prepare(request())).toThrow(/time/u)
  })
})

const DIGEST_FOR_TEST = /^sha256:[a-f0-9]{64}$/u
