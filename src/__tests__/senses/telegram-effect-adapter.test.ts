import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  appendTelegramArtifactEvents,
  appendTelegramInboundEvent,
  createTelegramApprovalEffectPort,
  createTelegramAuthorizedEffectExecutor,
  FileTelegramEffectJournal,
  FIXED_ADMISSION_ACKNOWLEDGEMENT,
  executeTelegramEffect,
  prepareTelegramEffect,
  recordTelegramEffectInSession,
  recordTelegramEffectsInSession,
  recoverTelegramEffectOutbox,
  resolveTelegramControlArtifact,
  resolveTelegramReply,
  type TelegramEffectArtifact,
} from "../../senses/telegram-effect-adapter"
import type { SessionEnvelope } from "../../heart/session-events"
import { TelegramApiError } from "../../senses/telegram-client"
import { withSessionTurnLease } from "../../mind/session-transaction"

const roots: string[] = []

function journal(): FileTelegramEffectJournal {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "telegram-effects-"))
  roots.push(root)
  return new FileTelegramEffectJournal(root)
}

const target = { kind: "approved_relationship" as const, friendId: "ari", sessionKey: "telegram:ari", requestId: "req-1" }
const authorization = { allowed: true as const, receiptId: "auth-1", expiresAt: "2099-01-01T00:00:00.000Z", transport: { chatId: "42" } }

afterEach(() => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

describe("Telegram effect adapter", () => {
  it("rejects empty effects, denied or invalid routes, admission drift, and malformed persisted admission effects", () => {
    const store = journal()
    expect(() => prepareTelegramEffect(store, { idempotencyKey: "empty", target, authorClass: "butler", effect: { kind: "text", text: " " }, authorization })).toThrow("nonempty")
    expect(() => prepareTelegramEffect(store, { idempotencyKey: "denied", target, authorClass: "butler", effect: { kind: "text", text: "No" }, authorization: { allowed: false, reason: "revoked" } })).toThrow("denied")
    expect(() => prepareTelegramEffect(store, { idempotencyKey: "route", target, authorClass: "butler", effect: { kind: "text", text: "No" }, authorization: { ...authorization, transport: { chatId: "0" } } })).toThrow("invalid transport")
    const admissionTarget = { kind: "admission_gate" as const, admissionId: "admission", botId: "100", userId: "200", chatId: "200" }
    expect(() => prepareTelegramEffect(store, { idempotencyKey: "ack:admission", target: admissionTarget, authorClass: "control", effect: { kind: "admission_ack", text: FIXED_ADMISSION_ACKNOWLEDGEMENT }, authorization: { ...authorization, transport: { chatId: "201" } } })).toThrow("route changed")

    const id = "c".repeat(64)
    const root = (store as unknown as { root: string }).root
    fs.writeFileSync(path.join(root, `${id}.json`), JSON.stringify({
      schemaVersion: 1, id, idempotencyKey: "wrong", target: admissionTarget, authorClass: "control",
      effect: { kind: "admission_ack", text: FIXED_ADMISSION_ACKNOWLEDGEMENT }, authorizationReceiptId: "receipt", authorizationExpiresAt: "2099-01-01T00:00:00.000Z",
      parts: [{ index: 0, text: FIXED_ADMISSION_ACKNOWLEDGEMENT, state: "prepared", updatedAt: "2026-08-29T00:00:00.000Z" }], createdAt: "2026-08-29T00:00:00.000Z", updatedAt: "2026-08-29T00:00:00.000Z",
    }), { mode: 0o600 })
    expect(() => store.read(id)).toThrow("invalid")
  })

  it("covers journal close, coordination, and bounded-file guards", () => {
    const store = journal()
    expect(() => store.coordinationPath("bad")).toThrow("id is invalid")
    const root = (store as unknown as { root: string }).root
    fs.writeFileSync(path.join(root, `${"d".repeat(64)}.json`), "x", { mode: 0o600 })
    expect(() => store.read("d".repeat(64))).toThrow("not a bounded regular file")
    store.close()
    expect(() => store.close()).not.toThrow()
    expect(() => store.read("d".repeat(64))).toThrow("closed")

    const fileRoot = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "telegram-effect-file-root-")), "journal")
    roots.push(path.dirname(fileRoot))
    fs.writeFileSync(fileRoot, "not a directory")
    expect(() => new FileTelegramEffectJournal(fileRoot)).toThrow("must be a directory")
  })

  it("prepares deterministic text chunks once and sends each through the existing renderer", async () => {
    const store = journal()
    const prepared = prepareTelegramEffect(store, {
      idempotencyKey: "reply:req-1",
      target,
      authorClass: "butler",
      effect: { kind: "text", text: `${"a".repeat(1_150)}\n\n${"b".repeat(1_150)}` },
      authorization,
    })
    const duplicate = prepareTelegramEffect(store, { idempotencyKey: "reply:req-1", target, authorClass: "butler", effect: prepared.effect, authorization })
    expect(duplicate.id).toBe(prepared.id)
    expect(() => prepareTelegramEffect(store, { idempotencyKey: "reply:req-1", target, authorClass: "butler", effect: { kind: "text", text: "different" }, authorization })).toThrow("different effect")
    expect(prepared.parts.length).toBeGreaterThan(1)
    const request = vi.fn().mockImplementation(async () => ({ message_id: request.mock.calls.length }))
    const result = await executeTelegramEffect(store, prepared.id, { request }, () => authorization)
    expect(result.parts.every((part) => part.state === "accepted" && typeof part.messageId === "number")).toBe(true)
    expect(request.mock.calls.every(([method]) => method === "sendMessage")).toBe(true)
    expect(JSON.stringify(store.read(prepared.id))).not.toContain("chatId")
  })

  it("persists raw Butler Markdown while rendering the supported subset as safe Telegram HTML", async () => {
    const store = journal()
    const request = vi.fn(async () => ({ message_id: 81 }))
    const authorize = vi.fn(() => authorization)
    const delivered = vi.fn()
    const execute = createTelegramAuthorizedEffectExecutor({ store, api: { request }, authorize })
    const familyTarget = { ...target, friendId: "mom", sessionKey: "telegram:mom" }

    const result = await execute({
      idempotencyKey: "reply:plain-text",
      target: familyTarget,
      authorClass: "butler",
      effect: {
        kind: "text",
        text: "**Sanctuary summary**\n\n_Moonstruck_ is ready.\nRun `npm <run> & **keep**` then compare <disk> & queue.",
      },
      onMessageDelivered: delivered,
    })

    const raw = "**Sanctuary summary**\n\n_Moonstruck_ is ready.\nRun `npm <run> & **keep**` then compare <disk> & queue."
    const html = "<b>Sanctuary summary</b>\n\n<i>Moonstruck</i> is ready.\nRun <code>npm &lt;run&gt; &amp; **keep**</code> then compare &lt;disk&gt; &amp; queue."
    expect(result.effect).toEqual({ kind: "text", text: raw })
    expect(result.parts).toEqual([expect.objectContaining({ text: raw, state: "accepted" })])
    expect(store.read(result.id)).toMatchObject({ target: familyTarget, effect: { text: raw }, parts: [{ text: raw }] })
    expect(authorize.mock.calls.map(([input]) => input)).toEqual([
      expect.objectContaining({ phase: "prepare", target: familyTarget, effect: { kind: "text", text: raw } }),
      expect.objectContaining({ phase: "send", target: familyTarget, effect: { kind: "text", text: raw }, artifact: expect.objectContaining({ effect: { kind: "text", text: raw } }) }),
    ])
    expect(delivered).toHaveBeenCalledWith(81, raw)
    expect(request).toHaveBeenCalledWith("sendMessage", { chat_id: "42", text: html, parse_mode: "HTML" }, undefined)
    const envelope: SessionEnvelope = {
      version: 2,
      events: [],
      projection: { eventIds: [], trimmed: false, maxTokens: null, contextMargin: null, inputTokens: null, projectedAt: null },
      lastUsage: null,
      state: { mustResolveBeforeHandoff: false, lastFriendActivityAt: null },
    }
    const appended = appendTelegramArtifactEvents(envelope, result, "2026-09-01T02:17:52.591Z")
    expect(appended.envelope.events).toEqual([expect.objectContaining({ role: "assistant", content: raw })])

    const duplicate = await execute({
      idempotencyKey: "reply:plain-text",
      target: familyTarget,
      authorClass: "butler",
      effect: { kind: "text", text: raw },
    })
    expect(duplicate).toEqual(result)
    expect(request).toHaveBeenCalledOnce()
  })

  it("fails closed to literal escaped text for unmatched, overlapping, and cross-chunk delimiters", async () => {
    const store = journal()
    const request = vi.fn(async () => ({ message_id: request.mock.calls.length }))
    const execute = createTelegramAuthorizedEffectExecutor({ store, api: { request }, authorize: () => authorization })
    const unmatched = "Keep *Moonstruck literal while **this would otherwise be bold**"
    const overlapping = "Keep **bold *italic** tail* literal <now> & later"

    await execute({ idempotencyKey: "reply:unmatched", target, authorClass: "butler", effect: { kind: "text", text: unmatched } })
    await execute({ idempotencyKey: "reply:overlapping", target, authorClass: "butler", effect: { kind: "text", text: overlapping } })

    const spanning = `Prefix *${"word ".repeat(300)}suffix*`
    const spanningResult = await execute({ idempotencyKey: "reply:cross-chunk", target, authorClass: "butler", effect: { kind: "text", text: spanning } })
    expect(spanningResult.parts).toHaveLength(2)
    expect(spanningResult.parts.map((part) => part.text).join("")).toBe(spanning)

    const htmlBodies = request.mock.calls.map(([, body]) => body.text)
    expect(htmlBodies[0]).toBe(unmatched)
    expect(htmlBodies[1]).toBe("Keep **bold *italic** tail* literal &lt;now&gt; &amp; later")
    expect(htmlBodies.slice(2).join("")).toBe(spanning)
    expect(htmlBodies.every((body) => !String(body).includes("<b>") && !String(body).includes("<i>"))).toBe(true)
  })

  it("preserves literal asterisks, globs, arithmetic, underscores, and URLs", async () => {
    const store = journal()
    const request = vi.fn(async () => ({ message_id: 81 }))
    const execute = createTelegramAuthorizedEffectExecutor({ store, api: { request }, authorize: () => authorization })
    const raw = "Keep **/src/** globs, arithmetic 2 ** 3, an ordinary lone *, a_b_c, and https://example.com/a_(b)."

    const result = await execute({ idempotencyKey: "reply:literal-data", target, authorClass: "butler", effect: { kind: "text", text: raw } })

    expect(result.effect).toEqual({ kind: "text", text: raw })
    expect(request).toHaveBeenCalledWith("sendMessage", { chat_id: "42", text: raw, parse_mode: "HTML" }, undefined)
  })

  it("falls back from Butler HTML to the identical raw Markdown chunk on Telegram 400", async () => {
    const store = journal()
    const raw = "*bold* and _italic_ with `code` & <unsafe>"
    const request = vi.fn()
      .mockRejectedValueOnce(new TelegramApiError("bad html", { status: 400, errorCode: 400 }))
      .mockResolvedValueOnce({ message_id: 82 })
    const delivered = vi.fn()
    const execute = createTelegramAuthorizedEffectExecutor({ store, api: { request }, authorize: () => authorization })

    const result = await execute({ idempotencyKey: "reply:html-fallback", target, authorClass: "butler", effect: { kind: "text", text: raw }, onMessageDelivered: delivered })

    expect(request.mock.calls).toEqual([
      ["sendMessage", { chat_id: "42", text: "<b>bold</b> and <i>italic</i> with <code>code</code> &amp; &lt;unsafe&gt;", parse_mode: "HTML" }, undefined],
      ["sendMessage", { chat_id: "42", text: raw }, undefined],
    ])
    expect(result.effect).toEqual({ kind: "text", text: raw })
    expect(result.parts).toEqual([expect.objectContaining({ text: raw, state: "accepted", messageId: 82 })])
    expect(delivered).toHaveBeenCalledWith(82, raw)
  })

  it("preserves backtick-delimited commands byte-for-byte", async () => {
    const store = journal()
    const execute = createTelegramAuthorizedEffectExecutor({ store, api: { request: vi.fn(async () => ({ message_id: 83 })) }, authorize: () => authorization })
    const command = "Run echo `date` and keep `**/*.ts` unchanged."

    const result = await execute({ idempotencyKey: "reply:command", target, authorClass: "butler", effect: { kind: "text", text: command } })

    expect(result.effect).toEqual({ kind: "text", text: command })
  })

  it("does not render control or system-authored text", async () => {
    const store = journal()
    const request = vi.fn(async () => ({ message_id: 82 }))
    const execute = createTelegramAuthorizedEffectExecutor({ store, api: { request }, authorize: () => authorization })

    const system = await execute({ idempotencyKey: "system:literal", target, authorClass: "system_failsafe", effect: { kind: "text", text: "Literal **markers** <safe>" } })
    const control = await execute({ idempotencyKey: "control:literal", target, authorClass: "control", effect: { kind: "text", text: "Literal *markers* & safe" } })

    expect(system.effect).toEqual({ kind: "text", text: "Literal **markers** <safe>" })
    expect(control.effect).toEqual({ kind: "text", text: "Literal *markers* & safe" })
    expect(request.mock.calls).toEqual([
      ["sendMessage", { chat_id: "42", text: "Literal **markers** &lt;safe&gt;", parse_mode: "HTML" }, undefined],
      ["sendMessage", { chat_id: "42", text: "Literal *markers* &amp; safe", parse_mode: "HTML" }, undefined],
    ])
  })

  it("recovers only bounded definitely-unsent outbox work and never retries indeterminate delivery", async () => {
    const store = journal()
    const execute = createTelegramAuthorizedEffectExecutor({
      store,
      api: { request: vi.fn(async () => ({ message_id: 91 })) },
      authorize: () => authorization,
    })
    for (const key of ["recover:1", "recover:2", "recover:3"]) {
      prepareTelegramEffect(store, { idempotencyKey: key, target, authorClass: "butler", effect: { kind: "text", text: key }, authorization,
        ...(key === "recover:1" ? { obligationReturnId: "obligation-1" } : {}) })
    }
    const uncertain = prepareTelegramEffect(store, { idempotencyKey: "recover:uncertain", target, authorClass: "butler", effect: { kind: "text", text: "uncertain" }, authorization })
    uncertain.parts[0]!.state = "indeterminate"
    store.write(uncertain)

    const recovered = await recoverTelegramEffectOutbox({ store, execute, maxArtifacts: 2 })

    expect(recovered).toMatchObject({ attempted: 2, accepted: 2, failed: 0 })
    expect(store.list().filter((artifact) => artifact.parts.some((part) => part.state === "accepted"))).toHaveLength(2)
    expect(store.list().find((artifact) => artifact.idempotencyKey === "recover:1")?.obligationReturnId).toBe("obligation-1")
    expect(store.read(uncertain.id).parts[0]?.state).toBe("indeterminate")

    const failed = await recoverTelegramEffectOutbox({
      store,
      execute: async () => { throw new Error("still offline") },
      matches: (artifact) => artifact.parts.some((part) => part.state === "prepared"),
    })
    expect(failed).toMatchObject({ attempted: 1, accepted: 0, failed: 1 })
  })

  it("skips invalid persisted artifacts during outbox recovery without hiding strict reads", async () => {
    const store = journal()
    const valid = prepareTelegramEffect(store, { idempotencyKey: "recover:valid", target, authorClass: "butler", effect: { kind: "text", text: "valid" }, authorization })
    const poisoned = prepareTelegramEffect(store, { idempotencyKey: "recover:poisoned", target, authorClass: "butler", effect: { kind: "text", text: "poisoned" }, authorization })
    poisoned.parts[0]!.attempts = 101
    store.write(poisoned)
    const execute = vi.fn(async () => {
      valid.parts[0]!.state = "accepted"
      valid.parts[0]!.messageId = 44
      store.write(valid)
      return valid
    })

    await expect(() => store.read(poisoned.id)).toThrow("invalid")
    await expect(recoverTelegramEffectOutbox({ store, execute })).resolves.toMatchObject({ attempted: 1, accepted: 1, failed: 0 })
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({ idempotencyKey: "recover:valid" }))
    await expect(() => store.read(poisoned.id)).toThrow("invalid")
  })

  it("quarantines and reprepares invalid same-key transport-only control artifacts", () => {
    const store = journal()
    const input = { idempotencyKey: "approval:expired:edit", target, authorClass: "control" as const, effect: { kind: "edit" as const, messageId: 77, text: "⚠️ Approval expired" }, authorization }
    const poisoned = prepareTelegramEffect(store, input)
    poisoned.parts[0]!.attempts = 101
    store.write(poisoned)
    const root = (store as unknown as { root: string }).root

    const reprepared = prepareTelegramEffect(store, input)

    expect(reprepared.id).toBe(poisoned.id)
    expect(reprepared.parts[0]).toMatchObject({ state: "prepared" })
    expect(reprepared.parts[0]?.attempts).toBeUndefined()
    expect(fs.existsSync(path.join(root, `${poisoned.id}.json`))).toBe(true)
    expect(fs.readdirSync(path.join(path.dirname(root), `${path.basename(root)}.quarantine`))).toHaveLength(1)

    const stringFailureStore = journal()
    vi.spyOn(stringFailureStore, "readIfExists").mockImplementationOnce(() => { throw "string failure" })
    vi.spyOn(stringFailureStore, "quarantineInvalid")
    prepareTelegramEffect(stringFailureStore, { ...input, idempotencyKey: "approval:expired:edit:string-failure" })
    expect(stringFailureStore.quarantineInvalid).toHaveBeenCalledWith(expect.any(String), "string failure")
  })

  it("keeps invalid same-key user-visible artifacts fail-closed and makes missing quarantine a no-op", () => {
    const store = journal()
    const input = { idempotencyKey: "reply:poisoned", target, authorClass: "butler" as const, effect: { kind: "text" as const, text: "maybe sent" }, authorization }
    const poisoned = prepareTelegramEffect(store, input)
    poisoned.parts[0]!.attempts = 101
    store.write(poisoned)

    expect(() => prepareTelegramEffect(store, input)).toThrow("invalid")
    expect(() => store.quarantineInvalid("f".repeat(64), "already gone")).not.toThrow()
  })

  it("logs non-Error invalid artifact skips during recoverable listing", () => {
    const store = journal()
    const artifact = prepareTelegramEffect(store, { idempotencyKey: "recover:string-throw", target, authorClass: "butler", effect: { kind: "text", text: "valid" }, authorization })
    const read = vi.spyOn(store, "read").mockImplementation((id) => {
      if (id === artifact.id) throw "string failure"
      return read.getMockImplementation()!(id)
    })

    expect(store.listRecoverable()).toEqual([])
  })

  it("classifies explicit Telegram rejection as definitely unsent but transport loss as indeterminate", async () => {
    const store = journal()
    const rejected = prepareTelegramEffect(store, { idempotencyKey: "retry:rejected", target, authorClass: "butler", effect: { kind: "text", text: "retry me" }, authorization })
    await expect(executeTelegramEffect(store, rejected.id, { request: vi.fn(async () => { throw new TelegramApiError("rate limited", { status: 429, errorCode: 429 }) }) }, () => authorization)).rejects.toThrow("rate limited")
    expect(store.read(rejected.id).parts[0]).toMatchObject({ state: "prepared", attempts: 1 })

    const uncertain = prepareTelegramEffect(store, { idempotencyKey: "retry:uncertain", target, authorClass: "butler", effect: { kind: "text", text: "do not retry me" }, authorization })
    await expect(executeTelegramEffect(store, uncertain.id, { request: vi.fn(async () => { throw new TelegramApiError("connection reset") }) }, () => authorization)).rejects.toThrow("connection reset")
    expect(store.read(uncertain.id).parts[0]).toMatchObject({ state: "indeterminate", attempts: 1 })
  })

  it("never resends accepted chunks after a later chunk becomes indeterminate", async () => {
    const store = journal()
    const prepared = prepareTelegramEffect(store, { idempotencyKey: "reply:req-2", target, authorClass: "butler", effect: { kind: "text", text: `${"a".repeat(1_200)} ${"b".repeat(1_200)}` }, authorization })
    let call = 0
    await expect(executeTelegramEffect(store, prepared.id, { request: vi.fn(async () => {
      call += 1
      if (call === 2) throw new Error("connection reset")
      return { message_id: call }
    }) }, () => authorization)).rejects.toThrow("connection reset")
    const failed = store.read(prepared.id)
    expect(failed.parts[0]).toMatchObject({ state: "accepted", messageId: 1 })
    expect(failed.parts[1]).toMatchObject({ state: "indeterminate" })
    const retryApi = { request: vi.fn(async () => ({ message_id: 99 })) }
    await expect(executeTelegramEffect(store, prepared.id, retryApi, () => authorization)).rejects.toThrow("indeterminate")
    expect(retryApi.request).not.toHaveBeenCalled()
  })

  it("turns a pre-existing attempting part into indeterminate without a blind resend", async () => {
    const store = journal()
    const prepared = prepareTelegramEffect(store, { idempotencyKey: "crash:req-2", target, authorClass: "butler", effect: { kind: "text", text: "Maybe accepted" }, authorization })
    prepared.parts[0]!.state = "attempting"
    store.write(prepared)
    const api = { request: vi.fn() }
    await expect(executeTelegramEffect(store, prepared.id, api, () => authorization)).rejects.toThrow("indeterminate")
    expect(api.request).not.toHaveBeenCalled()
    expect(store.read(prepared.id).parts[0]?.state).toBe("indeterminate")
  })

  it("serializes two same-key executors so Telegram receives one effect", async () => {
    const store = journal()
    const prepared = prepareTelegramEffect(store, { idempotencyKey: "concurrent:req-2", target, authorClass: "butler", effect: { kind: "text", text: "Once" }, authorization })
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const request = vi.fn(async () => { await gate; return { message_id: 77 } })
    const first = executeTelegramEffect(store, prepared.id, { request }, () => authorization)
    const second = executeTelegramEffect(store, prepared.id, { request }, () => authorization)
    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce())
    release()
    const [left, right] = await Promise.all([first, second])
    expect(request).toHaveBeenCalledOnce()
    expect(left.parts[0]).toMatchObject({ state: "accepted", messageId: 77 })
    expect(right.parts[0]).toMatchObject({ state: "accepted", messageId: 77 })
  })

  it("rejects a symlink journal root and corrupt persisted artifacts", () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), "telegram-effect-security-"))
    roots.push(parent)
    const targetRoot = path.join(parent, "target")
    const linkRoot = path.join(parent, "link")
    fs.mkdirSync(targetRoot)
    fs.symlinkSync(targetRoot, linkRoot)
    expect(() => new FileTelegramEffectJournal(linkRoot)).toThrow("symbolic link")

    const store = new FileTelegramEffectJournal(path.join(parent, "journal"))
    fs.writeFileSync(path.join(parent, "journal", `${"a".repeat(64)}.json`), "{}", { mode: 0o600 })
    expect(() => store.read("a".repeat(64))).toThrow("invalid")
  })

  it("rejects altered prepared bytes and a replaced root after construction", () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), "telegram-effect-integrity-"))
    roots.push(parent)
    const root = path.join(parent, "journal")
    const store = new FileTelegramEffectJournal(root)
    const prepared = prepareTelegramEffect(store, { idempotencyKey: "integrity:req-2", target, authorClass: "butler", effect: { kind: "text", text: "Authorized" }, authorization })
    const filePath = path.join(root, `${prepared.id}.json`)
    const altered = JSON.parse(fs.readFileSync(filePath, "utf8"))
    altered.parts[0].text = "Altered"
    fs.writeFileSync(filePath, JSON.stringify(altered), { mode: 0o600 })
    expect(() => store.read(prepared.id)).toThrow("invalid")

    const retained = path.join(parent, "retained")
    const redirect = path.join(parent, "redirect")
    fs.renameSync(root, retained)
    fs.mkdirSync(redirect)
    fs.symlinkSync(redirect, root)
    expect(() => store.list()).toThrow("identity changed")
    expect(fs.readdirSync(redirect)).toEqual([])
  })

  it("migrates a legacy approved route out of the journal and rejects invalid effect-target combinations", () => {
    const store = journal()
    const prepared = prepareTelegramEffect(store, { idempotencyKey: "legacy-route", target, authorClass: "butler", effect: { kind: "text", text: "Private route" }, authorization })
    const filePath = path.join((store as unknown as { root: string }).root, `${prepared.id}.json`)
    const legacy = JSON.parse(fs.readFileSync(filePath, "utf8"))
    legacy.target.chatId = "42"
    fs.writeFileSync(filePath, JSON.stringify(legacy), { mode: 0o600 })
    expect(store.read(prepared.id).target).toEqual(target)
    expect(fs.readFileSync(filePath, "utf8")).not.toContain("chatId")

    expect(() => prepareTelegramEffect(store, { idempotencyKey: "bad-admission-kind", target, authorClass: "control", effect: { kind: "admission_ack", text: FIXED_ADMISSION_ACKNOWLEDGEMENT }, authorization })).toThrow("requires an admission target")
    const corrupt = JSON.parse(fs.readFileSync(filePath, "utf8"))
    corrupt.effect = { kind: "unknown" }
    fs.writeFileSync(filePath, JSON.stringify(corrupt), { mode: 0o600 })
    expect(() => store.read(prepared.id)).toThrow("invalid")
  })

  it("supports cards, edits, and callback acknowledgements through the same effect boundary", async () => {
    const store = journal()
    const api = { request: vi.fn(async (method: string) => method === "answerCallbackQuery" ? true : { message_id: 77 }) }
    const card = prepareTelegramEffect(store, { idempotencyKey: "card:1", target, authorClass: "control", effect: { kind: "card", text: "Allow?", buttons: [[{ text: "Allow", callbackData: "allow:1" }]] }, authorization })
    const edit = prepareTelegramEffect(store, { idempotencyKey: "edit:1", target, authorClass: "control", effect: { kind: "edit", messageId: 77, text: "Allowed" }, authorization })
    const callback = prepareTelegramEffect(store, { idempotencyKey: "callback:1", target, authorClass: "control", effect: { kind: "callback_ack", callbackQueryId: "cb-1", text: "Done" }, authorization })
    await executeTelegramEffect(store, card.id, api, () => authorization)
    await executeTelegramEffect(store, edit.id, api, () => authorization)
    await executeTelegramEffect(store, callback.id, api, () => authorization)
    expect(api.request.mock.calls.map(([method]) => method)).toEqual(["sendMessage", "editMessageText", "answerCallbackQuery"])
  })

  it("handles malformed card responses, edit retry classifications, expired authorization, and cancellation", async () => {
    const store = journal()
    const card = prepareTelegramEffect(store, { idempotencyKey: "card:no-id", target, authorClass: "control", effect: { kind: "card", text: "Card", buttons: [[{ text: "Ok", callbackData: "ok" }]] }, authorization })
    await expect(executeTelegramEffect(store, card.id, { request: vi.fn(async () => ({})) }, () => authorization)).rejects.toThrow("omitted message_id")
    const arrayCard = prepareTelegramEffect(store, { idempotencyKey: "card:array-response", target, authorClass: "control", effect: { kind: "card", text: "Card", buttons: [[{ text: "Ok", callbackData: "ok" }]] }, authorization })
    await expect(executeTelegramEffect(store, arrayCard.id, { request: vi.fn(async () => []) }, () => authorization)).rejects.toThrow("omitted message_id")

    const unchanged = prepareTelegramEffect(store, { idempotencyKey: "edit:unchanged", target, authorClass: "control", effect: { kind: "edit", messageId: 7, text: "Same" }, authorization })
    await expect(executeTelegramEffect(store, unchanged.id, { request: vi.fn(async () => { throw new TelegramApiError("message is not modified", { status: 400, errorCode: 400 }) }) }, () => authorization)).resolves.toMatchObject({ parts: [{ state: "accepted", messageId: 7 }] })
    const server = prepareTelegramEffect(store, { idempotencyKey: "edit:server", target, authorClass: "control", effect: { kind: "edit", messageId: 8, text: "Edit" }, authorization })
    await expect(executeTelegramEffect(store, server.id, { request: vi.fn(async () => { throw new TelegramApiError("server", { status: 500, errorCode: 500 }) }) }, () => authorization)).rejects.toThrow("server")

    for (const [suffix, signal] of [["without-signal", undefined], ["with-signal", new AbortController().signal]] as const) {
      const fallback = prepareTelegramEffect(store, { idempotencyKey: `edit:fallback:${suffix}`, target, authorClass: "control", effect: { kind: "edit", messageId: 9, text: "<Edit>" }, authorization })
      const request = vi.fn()
        .mockRejectedValueOnce(new TelegramApiError("bad html", { status: 400, errorCode: 400 }))
        .mockResolvedValueOnce(true)
      await expect(executeTelegramEffect(store, fallback.id, { request }, () => authorization, signal)).resolves.toMatchObject({ parts: [{ state: "accepted", messageId: 9 }] })
      expect(request).toHaveBeenCalledTimes(2)
    }

    const fallbackErrors: Array<[string, unknown, boolean]> = [
      ["plain-error", new Error("plain fallback failure"), false],
      ["server-error", new TelegramApiError("server fallback failure", { status: 500, errorCode: 500 }), false],
      ["other-400", new TelegramApiError("other fallback failure", { status: 400, errorCode: 400 }), false],
      ["unchanged", new TelegramApiError("message is not modified", { status: 400, errorCode: 400 }), true],
    ]
    for (const [suffix, fallbackError, succeeds] of fallbackErrors) {
      const fallback = prepareTelegramEffect(store, { idempotencyKey: `edit:fallback-error:${suffix}`, target, authorClass: "control", effect: { kind: "edit", messageId: 10, text: "<Edit>" }, authorization })
      const request = vi.fn()
        .mockRejectedValueOnce(new TelegramApiError("bad html", { status: 400, errorCode: 400 }))
        .mockRejectedValueOnce(fallbackError)
      const result = executeTelegramEffect(store, fallback.id, { request }, () => authorization)
      if (succeeds) await expect(result).resolves.toMatchObject({ parts: [{ state: "accepted", messageId: 10 }] })
      else await expect(result).rejects.toBe(fallbackError)
    }

    const expired = prepareTelegramEffect(store, { idempotencyKey: "expired", target, authorClass: "butler", effect: { kind: "text", text: "Expired" }, authorization })
    await expect(executeTelegramEffect(store, expired.id, { request: vi.fn() }, () => ({ ...authorization, expiresAt: "2020-01-01T00:00:00.000Z" }))).rejects.toThrow("authorization expired")
    const invalidRoute = prepareTelegramEffect(store, { idempotencyKey: "invalid-send-route", target, authorClass: "butler", effect: { kind: "text", text: "No route" }, authorization })
    await expect(executeTelegramEffect(store, invalidRoute.id, { request: vi.fn() }, () => ({ ...authorization, transport: { chatId: "0" } }))).rejects.toThrow("invalid transport route")
    const aborted = prepareTelegramEffect(store, { idempotencyKey: "aborted", target, authorClass: "butler", effect: { kind: "text", text: "Abort" }, authorization })
    const controller = new AbortController(); controller.abort(new Error("cancelled"))
    await expect(executeTelegramEffect(store, aborted.id, { request: vi.fn() }, () => authorization, controller.signal)).rejects.toThrow("cancelled")
  })

  it("enforces executor cancellation at prepare and send boundaries", async () => {
    const store = journal()
    const already = new AbortController(); already.abort(new Error("already cancelled"))
    const execute = createTelegramAuthorizedEffectExecutor({ store, api: { request: vi.fn() }, authorize: () => authorization })
    await expect(execute({ idempotencyKey: "cancel:prepare", target, authorClass: "butler", effect: { kind: "text", text: "No" }, signal: already.signal })).rejects.toThrow("already cancelled")

    const during = new AbortController()
    const authorize = vi.fn(async () => { if (authorize.mock.calls.length === 1) during.abort(new Error("cancelled before send")); return authorization })
    const executeDuring = createTelegramAuthorizedEffectExecutor({ store, api: { request: vi.fn() }, authorize })
    await expect(executeDuring({ idempotencyKey: "cancel:send", target, authorClass: "butler", effect: { kind: "text", text: "No" }, signal: during.signal })).rejects.toThrow("cancelled before send")
  })

  it("handles explicit card rendering rejection and fences admission route drift", async () => {
    const store = journal()
    const card = prepareTelegramEffect(store, { idempotencyKey: "card:fallback", target, authorClass: "control", effect: { kind: "card", text: "<Allow?>", buttons: [[{ text: "Allow", callbackData: "allow:2" }]] }, authorization })
    const request = vi.fn()
      .mockRejectedValueOnce(new TelegramApiError("bad html", { status: 400, errorCode: 400 }))
      .mockResolvedValueOnce({ message_id: 78 })
    await executeTelegramEffect(store, card.id, { request }, () => authorization)
    expect(request).toHaveBeenCalledTimes(2)

    const rejected = prepareTelegramEffect(store, { idempotencyKey: "card:server", target, authorClass: "control", effect: { kind: "card", text: "Allow?", buttons: [[{ text: "Allow", callbackData: "allow:3" }]] }, authorization })
    await expect(executeTelegramEffect(store, rejected.id, { request: vi.fn(async () => { throw new TelegramApiError("offline") }) }, () => authorization)).rejects.toThrow("offline")

    const admissionTarget = { kind: "admission_gate" as const, admissionId: "route-drift", botId: "100", userId: "200", chatId: "200" }
    const admissionAuthorization = { ...authorization, transport: { chatId: "200" } }
    const admission = prepareTelegramEffect(store, { idempotencyKey: "ack:route-drift", target: admissionTarget, authorClass: "control", effect: { kind: "admission_ack", text: FIXED_ADMISSION_ACKNOWLEDGEMENT }, authorization: admissionAuthorization })
    await expect(executeTelegramEffect(store, admission.id, { request: vi.fn() }, () => ({ ...admissionAuthorization, transport: { chatId: "201" } }))).rejects.toThrow("route changed")
  })

  it("passes cancellation through the approval port and rejects missing delivery and session bindings", async () => {
    const artifacts: TelegramEffectArtifact[] = []
    const execute = vi.fn(async (input: any) => {
      const artifact = prepareTelegramEffect(journal(), { ...input, authorization })
      artifact.parts[0]!.state = "accepted"
      if (input.effect.kind === "card" || input.effect.kind === "edit") artifact.parts[0]!.messageId = input.effect.kind === "edit" ? input.effect.messageId : 1
      return artifact
    })
    const record = vi.fn(async (artifact: TelegramEffectArtifact) => { artifacts.push(artifact) })
    const port = createTelegramApprovalEffectPort({ target, chatId: "42", execute, record })
    const signal = new AbortController().signal
    await port.sendCard({ idempotencyKey: "port:card", chatId: "42", text: "Card", buttons: [[{ text: "Yes", callbackData: "yes" }]], signal })
    await port.edit({ idempotencyKey: "port:edit", chatId: "42", messageId: 1, text: "Edited", signal })
    await port.acknowledge({ idempotencyKey: "port:ack", callbackQueryId: "callback", signal })
    expect(execute.mock.calls.every(([input]) => input.signal === signal)).toBe(true)
    await expect(port.sendText({ idempotencyKey: "port:text", chatId: "42", text: "No id", authorClass: "butler", signal })).resolves.toEqual([])
    expect(() => recordTelegramEffectInSession(journal(), "missing", [])).toThrow()
    expect(artifacts).toHaveLength(4)
  })

  it("rejects approval route drift and a card result without a message id", async () => {
    const execute = vi.fn(async (input: any) => {
      const artifact = prepareTelegramEffect(journal(), { ...input, authorization })
      artifact.parts[0]!.state = "accepted"
      return artifact
    })
    const port = createTelegramApprovalEffectPort({ target, chatId: "42", execute, record: vi.fn(async () => undefined) })
    await expect(port.sendText({ idempotencyKey: "wrong:text", chatId: "43", text: "Text", authorClass: "butler" })).rejects.toThrow("target changed")
    await expect(port.sendCard({ idempotencyKey: "wrong:card", chatId: "43", text: "Card", buttons: [[{ text: "Ok", callbackData: "ok" }]] })).rejects.toThrow("target changed")
    await expect(port.edit({ idempotencyKey: "wrong:edit", chatId: "43", messageId: 1, text: "Edit" })).rejects.toThrow("target changed")
    await expect(port.sendCard({ idempotencyKey: "missing:id", chatId: "42", text: "Card", buttons: [[{ text: "Ok", callbackData: "ok" }]] })).rejects.toThrow("omitted its message id")
  })

  it("propagates caller cancellation through card, edit, and callback requests", async () => {
    const store = journal()
    const controller = new AbortController()
    const signals: AbortSignal[] = []
    const api = { request: vi.fn(async (method: string, _body: unknown, signal?: AbortSignal) => {
      if (signal) signals.push(signal)
      return method === "answerCallbackQuery" ? true : { message_id: 77 }
    }) }
    const effects = [
      prepareTelegramEffect(store, { idempotencyKey: "signal:card", target, authorClass: "control", effect: { kind: "card", text: "Allow?", buttons: [[{ text: "Allow", callbackData: "allow:1" }]] }, authorization }),
      prepareTelegramEffect(store, { idempotencyKey: "signal:edit", target, authorClass: "control", effect: { kind: "edit", messageId: 77, text: "Allowed" }, authorization }),
      prepareTelegramEffect(store, { idempotencyKey: "signal:callback", target, authorClass: "control", effect: { kind: "callback_ack", callbackQueryId: "cb-1" }, authorization }),
    ]
    for (const effect of effects) await executeTelegramEffect(store, effect.id, api, () => authorization, controller.signal)
    controller.abort(new Error("cancelled"))
    expect(signals).toHaveLength(3)
    expect(signals.every((signal) => signal.aborted)).toBe(true)
  })

  it("revalidates authorization immediately before sending", async () => {
    const store = journal()
    const prepared = prepareTelegramEffect(store, { idempotencyKey: "reply:req-3", target, authorClass: "butler", effect: { kind: "text", text: "Hello" }, authorization })
    const api = { request: vi.fn() }
    await expect(executeTelegramEffect(store, prepared.id, api, () => ({ allowed: false, reason: "revoked" }))).rejects.toThrow("revoked")
    expect(api.request).not.toHaveBeenCalled()
  })

  it("permits only fixed acknowledgements to exact pending admission coordinates", () => {
    const store = journal()
    const admissionTarget = { kind: "admission_gate" as const, admissionId: "adm-1", botId: "100", userId: "200", chatId: "200" }
    expect(() => prepareTelegramEffect(store, { idempotencyKey: "admission:adm-1", target: admissionTarget, authorClass: "control", effect: { kind: "text", text: "fixed" }, authorization })).toThrow("fixed admission")
    expect(prepareTelegramEffect(store, { idempotencyKey: "ack:adm-1", target: admissionTarget, authorClass: "control", effect: { kind: "admission_ack", text: FIXED_ADMISSION_ACKNOWLEDGEMENT }, authorization: { ...authorization, transport: { chatId: "200" } } })).toMatchObject({ target: admissionTarget })
  })

  it("records accepted Butler/control/system artifacts in order without relabeling authorship", async () => {
    const store = journal()
    const api = { request: vi.fn(async () => ({ message_id: 1 })) }
    for (const authorClass of ["butler", "control", "system_failsafe"] as const) {
      const prepared = prepareTelegramEffect(store, { idempotencyKey: `artifact:${authorClass}`, target, authorClass, effect: { kind: "text", text: authorClass }, authorization })
      await executeTelegramEffect(store, prepared.id, api, () => authorization)
      const accepted = store.read(prepared.id)
      accepted.parts[0]!.acceptedAt = "2026-08-29T00:00:00.000Z"
      store.write(accepted)
      const recorded = recordTelegramEffectInSession(store, prepared.id, [`session:${authorClass}`])
      expect(recorded.parts[0]).toMatchObject({ state: "session_recorded", sessionEventId: `session:${authorClass}` })
      expect(recorded.parts[0]?.acceptedAt).toBeTruthy()
      expect(recorded.parts[0]?.sessionRecordedAt).toBeTruthy()
      expect(recorded.parts[0]!.sessionRecordedAt).not.toBe(recorded.parts[0]!.acceptedAt)
      expect(recorded.authorClass).toBe(authorClass)
    }
  })

  it("loads legacy accepted artifacts without fabricating an acceptance timestamp", async () => {
    const store = journal()
    const prepared = prepareTelegramEffect(store, { idempotencyKey: "legacy:accepted", target, authorClass: "butler", effect: { kind: "text", text: "legacy" }, authorization })
    const executed = await executeTelegramEffect(store, prepared.id, { request: vi.fn(async () => ({ message_id: 99 })) }, () => authorization)
    delete executed.parts[0]!.acceptedAt
    store.write(executed)
    expect(store.read(prepared.id).parts[0]).toMatchObject({ state: "accepted", messageId: 99 })
    expect(store.read(prepared.id).parts[0]!.acceptedAt).toBeUndefined()
  })

  it("commits inbound-only admission ingress once and returns the exact durable session event", async () => {
    const store = journal()
    const sessionPath = path.join(roots[roots.length - 1]!, "session.json")
    await expect(recordTelegramEffectsInSession({ store, sessionPath, artifacts: [] })).resolves.toBeNull()
    const input = { text: "approved original", reference: "telegram-admission:abc123", relations: {
      replyToEventId: "evt-existing", threadRootEventId: null, references: ["telegram-artifact:reply"],
    } }
    const first = await recordTelegramEffectsInSession({ store, sessionPath, artifacts: [], inbound: input })
    const replay = await recordTelegramEffectsInSession({ store, sessionPath, artifacts: [], inbound: input })
    expect(replay).toEqual(first)
    expect(first).toMatchObject({ eventId: "evt-000001", reference: input.reference })
    const persisted = JSON.parse(fs.readFileSync(sessionPath, "utf8")) as SessionEnvelope
    expect(persisted.events).toHaveLength(1)
    expect(persisted.events[0]).toMatchObject({ id: first.eventId, role: "user", content: input.text, relations: {
      replyToEventId: "evt-existing", references: [input.reference, "telegram-artifact:reply"],
    } })
    await expect(recordTelegramEffectsInSession({ store, sessionPath, artifacts: [], inbound: { ...input, text: "different" } })).rejects.toThrow("conflicting inbound")
  })

  it("projects Butler speech as assistant but control and failsafe artifacts as typed system continuity", async () => {
    const store = journal()
    const api = { request: vi.fn(async () => ({ message_id: api.request.mock.calls.length })) }
    let envelope: SessionEnvelope = { version: 2, events: [], projection: { eventIds: [], trimmed: false, maxTokens: null, contextMargin: null, inputTokens: null, projectedAt: null }, lastUsage: null, state: { mustResolveBeforeHandoff: false, lastFriendActivityAt: null } }
    for (const authorClass of ["butler", "control", "system_failsafe"] as const) {
      const prepared = prepareTelegramEffect(store, { idempotencyKey: `projection:${authorClass}`, target, authorClass, effect: { kind: "text", text: authorClass }, authorization })
      await executeTelegramEffect(store, prepared.id, api, () => authorization)
      const appended = appendTelegramArtifactEvents(envelope, store.read(prepared.id), "2026-08-29T17:00:00.000Z")
      envelope = appended.envelope
      recordTelegramEffectInSession(store, prepared.id, appended.eventIds)
    }
    expect(envelope.events.map((event) => [event.role, event.name])).toEqual([
      ["assistant", "telegram-butler"],
      ["system", "telegram-control"],
      ["system", "telegram-system-failsafe"],
    ])
    expect(envelope.events.every((event) => event.relations.references.some((ref) => ref.startsWith("telegram-message:")))).toBe(true)
    expect(resolveTelegramReply(store, { messageId: 2, friendId: "ari", sessionKey: "telegram:ari" })).toMatchObject({ authorClass: "control", sessionEventId: "evt-000002" })
    expect(resolveTelegramReply(store, { messageId: 2, friendId: "other", sessionKey: "telegram:ari" })).toBeNull()
  })

  it("binds transport receipts to the canonical shared-turn assistant event without duplicate Butler speech", async () => {
    const store = journal()
    const sessionPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "telegram-shared-turn-")), "session.json")
    roots.push(path.dirname(sessionPath))
    const envelope: SessionEnvelope = {
      version: 2,
      events: [{
        id: "evt-000002", sequence: 2, role: "assistant", content: null, name: null, toolCallId: null,
        toolCalls: [{ id: "call-1", type: "function", function: { name: "settle", arguments: JSON.stringify({ answer: "One useful answer." }) } }], attachments: [],
        time: { authoredAt: null, authoredAtSource: "local", observedAt: null, observedAtSource: "local", recordedAt: "2026-08-29T17:00:00.000Z", recordedAtSource: "save" },
        relations: { replyToEventId: null, threadRootEventId: null, references: [], toolCallId: null, supersedesEventId: null, redactsEventId: null },
        provenance: { captureKind: "live", legacyVersion: null, sourceMessageIndex: null },
      }],
      projection: { eventIds: ["evt-000002"], trimmed: false, maxTokens: null, contextMargin: null, inputTokens: null, projectedAt: null }, lastUsage: null,
      state: { mustResolveBeforeHandoff: false, lastFriendActivityAt: null },
    }
    fs.writeFileSync(sessionPath, JSON.stringify(envelope))
    const artifact = prepareTelegramEffect(store, { idempotencyKey: "shared-turn:1", target, authorClass: "butler", effect: { kind: "text", text: "One useful answer." }, authorization })
    await executeTelegramEffect(store, artifact.id, { request: vi.fn(async () => ({ message_id: 88 })) }, () => authorization)

    const causalEventIds = { [artifact.id]: "evt-000002" }
    await recordTelegramEffectsInSession({ store, sessionPath, artifacts: [store.read(artifact.id)], causalEventIds })

    const recorded = JSON.parse(fs.readFileSync(sessionPath, "utf8")) as SessionEnvelope
    expect(recorded.events).toHaveLength(1)
    expect(recorded.events[0]?.relations.references).toEqual(expect.arrayContaining([`telegram-artifact:${artifact.id}`, "telegram-message:88"]))
    expect(store.read(artifact.id).parts[0]).toMatchObject({ state: "session_recorded", sessionEventId: "evt-000002" })

    const crashWindow = store.read(artifact.id)
    crashWindow.parts[0]!.state = "accepted"
    delete crashWindow.parts[0]!.sessionEventId
    store.write(crashWindow)
    await recordTelegramEffectsInSession({ store, sessionPath, artifacts: [crashWindow], causalEventIds })
    expect((JSON.parse(fs.readFileSync(sessionPath, "utf8")) as SessionEnvelope).events).toHaveLength(1)
    expect(store.read(artifact.id).parts[0]).toMatchObject({ state: "session_recorded", sessionEventId: "evt-000002" })
  })

  it("binds plain and speak assistant output only to the supplied causal events", async () => {
    const store = journal()
    const sessionRoot = fs.mkdtempSync(path.join(os.tmpdir(), "telegram-shared-branches-"))
    roots.push(sessionRoot)
    const sessionPath = path.join(sessionRoot, "session.json")
    const event = (id: string, sequence: number, content: string | null, toolCalls: SessionEnvelope["events"][number]["toolCalls"]) => ({
      id, sequence, role: "assistant" as const, content, name: null, toolCallId: null, toolCalls, attachments: [],
      time: { authoredAt: null, authoredAtSource: "local" as const, observedAt: null, observedAtSource: "local" as const, recordedAt: "2026-08-29T17:00:00.000Z", recordedAtSource: "save" as const },
      relations: { replyToEventId: null, threadRootEventId: null, references: [], toolCallId: null, supersedesEventId: null, redactsEventId: null },
      provenance: { captureKind: "live" as const, legacyVersion: null, sourceMessageIndex: null },
    })
    const envelope: SessionEnvelope = {
      version: 2,
      events: [
        event("evt-000001", 1, "Plain answer", []),
        event("evt-000002", 2, null, [{ id: "bad", type: "function", function: { name: "settle", arguments: "{" } }]),
        event("evt-000003", 3, null, [{ id: "other", type: "function", function: { name: "other", arguments: "{}" } }]),
        event("evt-000004", 4, null, [{ id: "speak", type: "function", function: { name: "speak", arguments: JSON.stringify({ message: "Spoken answer" }) } }]),
      ],
      projection: { eventIds: ["evt-000001", "evt-000002", "evt-000003", "evt-000004"], trimmed: false, maxTokens: null, contextMargin: null, inputTokens: null, projectedAt: null }, lastUsage: null,
      state: { mustResolveBeforeHandoff: false, lastFriendActivityAt: null },
    }
    fs.writeFileSync(sessionPath, JSON.stringify(envelope))
    for (const [key, text] of [["plain", "Plain answer"], ["speak", "Spoken answer"]]) {
      const artifact = prepareTelegramEffect(store, { idempotencyKey: `binding:${key}`, target: { kind: "approved_relationship", friendId: "ari", sessionKey: "telegram:ari" }, authorClass: "butler", effect: { kind: "text", text }, authorization })
      await executeTelegramEffect(store, artifact.id, { request: vi.fn(async () => ({ message_id: key === "plain" ? 91 : 92 })) }, () => authorization)
      await recordTelegramEffectsInSession({
        store,
        sessionPath,
        artifacts: [store.read(artifact.id)],
        causalEventIds: { [artifact.id]: key === "plain" ? "evt-000001" : "evt-000004" },
      })
    }
    const recorded = JSON.parse(fs.readFileSync(sessionPath, "utf8")) as SessionEnvelope
    expect(recorded.events).toHaveLength(4)
    expect(recorded.events[0]?.relations.references).toContain("telegram-message:91")
    expect(recorded.events[3]?.relations.references).toContain("telegram-message:92")
    expect(resolveTelegramReply(store, { messageId: 91, friendId: "ari", sessionKey: "telegram:ari" })?.requestId).toBeNull()
  })

  it("reuses an already-held production session lease and keeps an empty callback acknowledgement out of model-visible history", async () => {
    const store = journal()
    const sessionRoot = fs.mkdtempSync(path.join(os.tmpdir(), "telegram-held-lease-"))
    roots.push(sessionRoot)
    const sessionPath = path.join(sessionRoot, "session.json")
    const callback = prepareTelegramEffect(store, { idempotencyKey: "callback:quiet", target, authorClass: "control", effect: { kind: "callback_ack", callbackQueryId: "cb-quiet" }, authorization })
    await executeTelegramEffect(store, callback.id, { request: vi.fn(async () => true) }, () => authorization)

    await withSessionTurnLease(sessionPath, async () => recordTelegramEffectsInSession({ store, sessionPath, artifacts: [store.read(callback.id)] }))

    expect(fs.existsSync(sessionPath)).toBe(false)
    expect(store.read(callback.id).parts[0]).toMatchObject({ state: "session_recorded" })
    expect(store.read(callback.id).parts[0]?.sessionEventId).toBeUndefined()
  })

  it("keeps admission control cards out of model-visible history while retaining transport binding", async () => {
    const store = journal()
    const sessionPath = path.join(roots.at(-1)!, "owner-session.json")
    const card = prepareTelegramEffect(store, {
      idempotencyKey: "owner-card:admission",
      target: { kind: "approved_relationship", friendId: "ari", sessionKey: "telegram:ari", requestId: "a".repeat(20) },
      authorClass: "control",
      effect: { kind: "card", text: "Unverified Telegram label: ATTACKER_INSTRUCTION", buttons: [[{ text: "Allow", callbackData: `admit:${"a".repeat(20)}:allow` }]] },
      authorization,
    })
    await executeTelegramEffect(store, card.id, { request: vi.fn(async () => ({ message_id: 333 })) }, () => authorization)
    await recordTelegramEffectsInSession({ store, sessionPath, artifacts: [store.read(card.id)] })

    expect(fs.existsSync(sessionPath)).toBe(false)
    expect(resolveTelegramReply(store, { messageId: 333, friendId: "ari", sessionKey: "telegram:ari" })).toBeNull()
    expect(resolveTelegramControlArtifact(store, { messageId: 333, friendId: "ari", sessionKey: "telegram:ari" })).toEqual({ artifactId: card.id, requestId: "a".repeat(20) })

    const terminal = prepareTelegramEffect(store, {
      idempotencyKey: "owner-card-terminal:admission:denied",
      target: { kind: "approved_relationship", friendId: "ari", sessionKey: "telegram:ari", requestId: "a".repeat(20) },
      authorClass: "control",
      effect: { kind: "edit", messageId: 333, text: "Denied" },
      authorization,
    })
    await executeTelegramEffect(store, terminal.id, { request: vi.fn(async () => true) }, () => authorization)
    await recordTelegramEffectsInSession({ store, sessionPath, artifacts: [store.read(terminal.id)] })
    expect(resolveTelegramControlArtifact(store, { messageId: 333, friendId: "ari", sessionKey: "telegram:ari" })).toEqual({ artifactId: card.id, requestId: "a".repeat(20) })
  })

  it("rejects session reconciliation without accepted parts or its canonical causal event", async () => {
    const store = journal()
    const empty: SessionEnvelope = { version: 2, events: [], projection: { eventIds: [], trimmed: false, maxTokens: null, contextMargin: null, inputTokens: null, projectedAt: null }, lastUsage: null, state: { mustResolveBeforeHandoff: false, lastFriendActivityAt: null } }
    const prepared = prepareTelegramEffect(store, { idempotencyKey: "session:prepared", target, authorClass: "butler", effect: { kind: "text", text: "Prepared" }, authorization })
    expect(() => appendTelegramArtifactEvents(empty, prepared, "2026-08-29T00:00:00.000Z")).toThrow("no accepted parts")

    await executeTelegramEffect(store, prepared.id, { request: vi.fn(async () => ({ message_id: 91 })) }, () => authorization)
    expect(() => recordTelegramEffectInSession(store, prepared.id, [])).toThrow("do not match")
    const sessionPath = path.join((store as unknown as { root: string }).root, "missing-causal-session.json")
    await expect(recordTelegramEffectsInSession({ store, sessionPath, artifacts: [store.read(prepared.id)], causalEventIds: { [prepared.id]: "evt-999999" } })).rejects.toThrow("causal event is unavailable")
  })

  it("returns an unchanged envelope for duplicate inbound ingress and null for unmatched control messages", () => {
    const recordedAt = "2026-08-29T00:00:00.000Z"
    const empty: SessionEnvelope = { version: 2, events: [], projection: { eventIds: [], trimmed: false, maxTokens: null, contextMargin: null, inputTokens: null, projectedAt: null }, lastUsage: null, state: { mustResolveBeforeHandoff: false, lastFriendActivityAt: null } }
    const once = appendTelegramInboundEvent(empty, { text: "Hello", reference: "telegram-inbound:one", recordedAt })
    expect(appendTelegramInboundEvent(once, { text: "Hello", reference: "telegram-inbound:one", recordedAt })).toBe(once)

    const store = journal()
    const card = prepareTelegramEffect(store, { idempotencyKey: "control:miss", target, authorClass: "control", effect: { kind: "card", text: "Card", buttons: [[{ text: "Ok", callbackData: "ok" }]] }, authorization })
    card.parts[0]!.state = "session_recorded"; card.parts[0]!.messageId = 1
    store.write(card)
    expect(resolveTelegramControlArtifact(store, { messageId: 999, friendId: "ari", sessionKey: "telegram:ari" })).toBeNull()

    const noRequest = prepareTelegramEffect(store, { idempotencyKey: "control:no-request", target: { kind: "approved_relationship", friendId: "ari", sessionKey: "telegram:ari" }, authorClass: "control", effect: { kind: "card", text: "Card", buttons: [[{ text: "Ok", callbackData: "ok" }]] }, authorization })
    noRequest.parts[0]!.state = "session_recorded"; noRequest.parts[0]!.messageId = 2
    store.write(noRequest)
    expect(resolveTelegramControlArtifact(store, { messageId: 2, friendId: "ari", sessionKey: "telegram:ari" })).toEqual({ artifactId: noRequest.id, requestId: null })
  })

  it("records crash-window and transport-only edge states without duplicating session history", async () => {
    const store = journal()
    const sessionPath = path.join(roots.at(-1)!, "edge-session.json")
    const envelope: SessionEnvelope = {
      version: 2,
      events: [{
        id: "evt-000001", sequence: 1, role: "assistant", content: "First chunk", name: null, toolCallId: null, toolCalls: [], attachments: [],
        time: { authoredAt: null, authoredAtSource: "local", observedAt: null, observedAtSource: "local", recordedAt: "2026-08-29T00:00:00.000Z", recordedAtSource: "save" },
        relations: { replyToEventId: null, threadRootEventId: null, references: [], toolCallId: null, supersedesEventId: null, redactsEventId: null },
        provenance: { captureKind: "live", legacyVersion: null, sourceMessageIndex: null },
      }],
      projection: { eventIds: ["evt-000001"], trimmed: false, maxTokens: null, contextMargin: null, inputTokens: null, projectedAt: null },
      lastUsage: null,
      state: { mustResolveBeforeHandoff: false, lastFriendActivityAt: null },
    }
    fs.writeFileSync(sessionPath, JSON.stringify(envelope))

    const partial = prepareTelegramEffect(store, { idempotencyKey: "partial-send", target, authorClass: "butler", effect: { kind: "text", text: `${"a".repeat(2_500)} ${"b".repeat(2_500)}` }, authorization })
    partial.parts[0]!.state = "accepted"
    partial.parts[0]!.messageId = 11
    store.write(partial)
    await recordTelegramEffectsInSession({ store, sessionPath, artifacts: [partial], causalEventIds: { [partial.id]: "evt-000001" } })
    expect(store.read(partial.id).parts).toEqual(expect.arrayContaining([expect.objectContaining({ state: "session_recorded" }), expect.objectContaining({ state: "prepared" })]))

    const conflict = prepareTelegramEffect(store, { idempotencyKey: "partial-reconcile", target, authorClass: "butler", effect: { kind: "text", text: `${"c".repeat(2_500)} ${"d".repeat(2_500)}` }, authorization })
    conflict.parts.forEach((part, index) => { part.state = "accepted"; part.messageId = 20 + index })
    store.write(conflict)
    const existing = JSON.parse(fs.readFileSync(sessionPath, "utf8")) as SessionEnvelope
    existing.events[0]!.relations.references.push(`telegram-artifact:${conflict.id}`, "telegram-message:20")
    fs.writeFileSync(sessionPath, JSON.stringify(existing))
    await expect(recordTelegramEffectsInSession({ store, sessionPath, artifacts: [conflict] })).rejects.toThrow("reconciliation is partial")

    const callback = prepareTelegramEffect(store, { idempotencyKey: "callback:event-content", target: { kind: "approved_relationship", friendId: "ari", sessionKey: "telegram:ari" }, authorClass: "control", effect: { kind: "callback_ack", callbackQueryId: "callback" }, authorization })
    callback.parts[0]!.state = "accepted"
    const appended = appendTelegramArtifactEvents(existing, callback, "2026-08-29T00:00:01.000Z")
    expect(appended.envelope.events.at(-1)).toMatchObject({ content: "[Telegram control artifact]\n", relations: { references: [`telegram-artifact:${callback.id}`] } })
  })

  it("uses the deterministic artifact id as the outbox sort tiebreaker", async () => {
    const store = journal()
    const artifacts = ["tie:right", "tie:left"].map((idempotencyKey) => prepareTelegramEffect(store, { idempotencyKey, target, authorClass: "butler", effect: { kind: "text", text: idempotencyKey }, authorization, now: "2026-08-29T00:00:00.000Z" }))
    const order: string[] = []
    await recoverTelegramEffectOutbox({ store, execute: async (input) => { order.push(input.idempotencyKey); return artifacts.find((artifact) => artifact.idempotencyKey === input.idempotencyKey)! } })
    expect(order).toEqual([...order].sort((left, right) => artifacts.find((artifact) => artifact.idempotencyKey === left)!.id.localeCompare(artifacts.find((artifact) => artifact.idempotencyKey === right)!.id)))
  })

  it("records a non-Error transport loss as indeterminate", async () => {
    const store = journal()
    const artifact = prepareTelegramEffect(store, { idempotencyKey: "non-error-loss", target, authorClass: "butler", effect: { kind: "text", text: "Maybe sent" }, authorization })
    await expect(executeTelegramEffect(store, artifact.id, { request: vi.fn(async () => { throw "socket vanished" }) }, () => authorization)).rejects.toBe("socket vanished")
    expect(store.read(artifact.id).parts[0]).toMatchObject({ state: "indeterminate" })
  })
})
