import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  appendTelegramArtifactEvents,
  FileTelegramEffectJournal,
  executeTelegramEffect,
  prepareTelegramEffect,
  recordTelegramEffectInSession,
  resolveTelegramReply,
} from "../../senses/telegram-effect-adapter"
import type { SessionEnvelope } from "../../heart/session-events"

const roots: string[] = []

function journal(): FileTelegramEffectJournal {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "telegram-effects-"))
  roots.push(root)
  return new FileTelegramEffectJournal(root)
}

const target = { kind: "approved_relationship" as const, friendId: "ari", sessionKey: "telegram:ari", chatId: "42", requestId: "req-1" }
const authorization = { allowed: true as const, receiptId: "auth-1", expiresAt: "2099-01-01T00:00:00.000Z" }

afterEach(() => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

describe("Telegram effect adapter", () => {
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
    expect(prepareTelegramEffect(store, { idempotencyKey: "ack:adm-1", target: admissionTarget, authorClass: "control", effect: { kind: "admission_ack", text: "Thanks — I’ve asked Ari." }, authorization })).toMatchObject({ target: admissionTarget })
  })

  it("records accepted Butler/control/system artifacts in order without relabeling authorship", async () => {
    const store = journal()
    const api = { request: vi.fn(async () => ({ message_id: 1 })) }
    for (const authorClass of ["butler", "control", "system_failsafe"] as const) {
      const prepared = prepareTelegramEffect(store, { idempotencyKey: `artifact:${authorClass}`, target, authorClass, effect: { kind: "text", text: authorClass }, authorization })
      await executeTelegramEffect(store, prepared.id, api, () => authorization)
      const recorded = recordTelegramEffectInSession(store, prepared.id, [`session:${authorClass}`])
      expect(recorded.parts[0]).toMatchObject({ state: "session_recorded", sessionEventId: `session:${authorClass}` })
      expect(recorded.authorClass).toBe(authorClass)
    }
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
    expect(resolveTelegramReply(store, { messageId: 2, chatId: "42", friendId: "ari", sessionKey: "telegram:ari" })).toMatchObject({ authorClass: "control", sessionEventId: "evt-000002" })
    expect(resolveTelegramReply(store, { messageId: 2, chatId: "other", friendId: "ari", sessionKey: "telegram:ari" })).toBeNull()
  })
})
