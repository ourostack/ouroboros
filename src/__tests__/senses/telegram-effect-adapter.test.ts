import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  appendTelegramArtifactEvents,
  createTelegramApprovalEffectPort,
  createTelegramAuthorizedEffectExecutor,
  FileTelegramEffectJournal,
  executeTelegramEffect,
  prepareTelegramEffect,
  recordTelegramEffectInSession,
  recordTelegramEffectsInSession,
  recoverTelegramEffectOutbox,
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

  it("recovers only bounded definitely-unsent outbox work and never retries indeterminate delivery", async () => {
    const store = journal()
    const execute = createTelegramAuthorizedEffectExecutor({
      store,
      api: { request: vi.fn(async () => ({ message_id: 91 })) },
      authorize: () => authorization,
    })
    for (const key of ["recover:1", "recover:2", "recover:3"]) {
      prepareTelegramEffect(store, { idempotencyKey: key, target, authorClass: "butler", effect: { kind: "text", text: key }, authorization })
    }
    const uncertain = prepareTelegramEffect(store, { idempotencyKey: "recover:uncertain", target, authorClass: "butler", effect: { kind: "text", text: "uncertain" }, authorization })
    uncertain.parts[0]!.state = "indeterminate"
    store.write(uncertain)

    const recovered = await recoverTelegramEffectOutbox({ store, execute, maxArtifacts: 2 })

    expect(recovered).toMatchObject({ attempted: 2, accepted: 2, failed: 0 })
    expect(store.list().filter((artifact) => artifact.parts.some((part) => part.state === "accepted"))).toHaveLength(2)
    expect(store.read(uncertain.id).parts[0]?.state).toBe("indeterminate")

    const failed = await recoverTelegramEffectOutbox({
      store,
      execute: async () => { throw new Error("still offline") },
      matches: (artifact) => artifact.parts.some((part) => part.state === "prepared"),
    })
    expect(failed).toMatchObject({ attempted: 1, accepted: 0, failed: 1 })
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

    expect(() => prepareTelegramEffect(store, { idempotencyKey: "bad-admission-kind", target, authorClass: "control", effect: { kind: "admission_ack", text: "Thanks — I’ve asked Ari." }, authorization })).toThrow("requires an admission target")
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
    const admission = prepareTelegramEffect(store, { idempotencyKey: "ack:route-drift", target: admissionTarget, authorClass: "control", effect: { kind: "admission_ack", text: "Thanks — I’ve asked Ari." }, authorization: admissionAuthorization })
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
    expect(prepareTelegramEffect(store, { idempotencyKey: "ack:adm-1", target: admissionTarget, authorClass: "control", effect: { kind: "admission_ack", text: "Thanks — I’ve asked Ari." }, authorization: { ...authorization, transport: { chatId: "200" } } })).toMatchObject({ target: admissionTarget })
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

    await recordTelegramEffectsInSession({ store, sessionPath, artifacts: [store.read(artifact.id)] })

    const recorded = JSON.parse(fs.readFileSync(sessionPath, "utf8")) as SessionEnvelope
    expect(recorded.events).toHaveLength(1)
    expect(recorded.events[0]?.relations.references).toEqual(expect.arrayContaining([`telegram-artifact:${artifact.id}`, "telegram-message:88"]))
    expect(store.read(artifact.id).parts[0]).toMatchObject({ state: "session_recorded", sessionEventId: "evt-000002" })

    const crashWindow = store.read(artifact.id)
    crashWindow.parts[0]!.state = "accepted"
    delete crashWindow.parts[0]!.sessionEventId
    store.write(crashWindow)
    await recordTelegramEffectsInSession({ store, sessionPath, artifacts: [crashWindow] })
    expect((JSON.parse(fs.readFileSync(sessionPath, "utf8")) as SessionEnvelope).events).toHaveLength(1)
    expect(store.read(artifact.id).parts[0]).toMatchObject({ state: "session_recorded", sessionEventId: "evt-000002" })
  })

  it("binds plain and speak assistant output while ignoring malformed or unrelated tool calls", async () => {
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
      await recordTelegramEffectsInSession({ store, sessionPath, artifacts: [store.read(artifact.id)] })
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
})
