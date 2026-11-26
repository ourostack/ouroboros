import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import type { FriendRecord } from "@ouro.bot/friends"
import { afterEach, describe, expect, it } from "vitest"
import { ANSWERED_GUIDS_FILE, DELIVERY_SLACK_MS, addAnsweredGuid, answerProblem, parseAnswer, readAnsweredGuids, type ServerMessage } from "../../../heart/letters/answer-reader"
import { answerLettersAnswerCommand, looksLikeAnswer } from "../../../heart/letters/answer-command"
import { writeAnsweringHandle } from "../../../heart/letters/answering"
import { LettersWriter } from "../../../heart/letters/writer"
import type { LetterAnswerSource } from "../../../senses/bluebubbles/agent-client"

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }) })

const NOW = Date.parse("2026-11-26T12:00:00.000Z")
const ARI = "+15551234567"

function friend(id: string): FriendRecord {
  return {
    id, name: id, trustLevel: "family", externalIds: [{ provider: "local", externalId: "ari", linkedAt: "2026-01-01T00:00:00.000Z" }],
    tenantMemberships: [], toolPreferences: {}, notes: {}, totalTokens: 0, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", schemaVersion: 1,
  } as FriendRecord
}

/** Slugger, whose person answers from ARI, with L1 (two options) filed and delivered at NOW. */
async function delivered(): Promise<{ writer: LettersWriter; clock: { now: number }; lettersDir: string }> {
  const bundles = fs.mkdtempSync(path.join(os.tmpdir(), "letters-answer-"))
  roots.push(bundles)
  const lettersDir = path.join(bundles, "slugger.ouro", "state", "letters")
  writeAnsweringHandle(lettersDir, "friend-ari", ARI)
  const clock = { now: NOW }
  let n = 0
  const writer = new LettersWriter({
    bundlesRoot: bundles, now: () => new Date(clock.now), newId: () => `ltr_T${++n}`, listFriends: async () => [friend("friend-ari")], ownerUsername: () => "ari",
    deliverChat: async () => ({ channel: "bluebubbles", key: `iMessage;-;${ARI}`, messageId: "sent-1" }),
  })
  await writer.run("slugger", "mailbox_send", { kind: "decide", subject: "Which name?", whyOnlyYou: "It is your product.", options: [{ label: "Orca", effect: "Ship as Orca." }, { label: "Ouro", effect: "Ship as Ouro." }] })
  await writer.run("slugger", "mailbox_deliver", { letter: "L1" })
  clock.now = NOW + 60_000
  return { writer, clock, lettersDir }
}

function message(extra: Partial<ServerMessage> = {}): ServerMessage {
  return { guid: "m-1", text: "L1 2", isFromMe: false, sender: ARI, service: "iMessage", chatGuids: [`iMessage;-;${ARI}`], dateCreated: NOW + 30_000, ...extra }
}

describe("parseAnswer", () => {
  it("reads only a code, a space and an option number, with an optional note after a dash", () => {
    expect(parseAnswer("L7 2")).toEqual({ code: "L7", option: "2" })
    expect(parseAnswer("  L12 1 — after lunch ")).toEqual({ code: "L12", option: "1", note: "after lunch" })
    expect(parseAnswer("L7 2 - ok")).toEqual({ code: "L7", option: "2", note: "ok" })
    for (const text of ["2", "Ouro", "L7", "L7  2", "l7 2", "L07 2", "L7 6", "L7 2 please", "L7 2 —", "L 7 2", "Ｌ7 2", "L7 2\nL8 1"]) {
      expect(parseAnswer(text)).toBeNull()
    }
    // A note loses format characters such as a bidi override, and is capped.
    expect(parseAnswer("L7 2 — a\u202Eb\u200B")).toEqual({ code: "L7", option: "2", note: "ab" })
    expect(parseAnswer("L7 2 — \u202E")).toEqual({ code: "L7", option: "2" })
    expect(parseAnswer(`L7 2 - ${"x".repeat(300)}`)!.note).toHaveLength(200)
    expect(looksLikeAnswer("L3 1")).toBe(true)
    expect(looksLikeAnswer("see L3")).toBe(false)
  })
})

describe("the answered GUID ledger", () => {
  it("adds GUIDs and reads them back, past a torn line, and is empty before the first", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "answered-guids-"))
    roots.push(dir)
    expect(readAnsweredGuids(dir).size).toBe(0)
    addAnsweredGuid(dir, "m-1", "ltr_1", "t")
    fs.appendFileSync(path.join(dir, ANSWERED_GUIDS_FILE), "{\"guid\":")
    expect([...readAnsweredGuids(dir)]).toEqual(["m-1"])
    // The next GUID after a torn line still reads.
    addAnsweredGuid(dir, "m-2", "ltr_2", "t")
    expect([...readAnsweredGuids(dir)]).toEqual(["m-1", "m-2"])
    fs.writeFileSync(path.join(dir, ANSWERED_GUIDS_FILE), "{\"guid\":7}\n")
    expect(readAnsweredGuids(dir).size).toBe(0)
  })

  it("throws when the ledger can't be read, rather than forgetting what answered", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "answered-guids-"))
    roots.push(dir)
    fs.mkdirSync(path.join(dir, ANSWERED_GUIDS_FILE))
    expect(() => readAnsweredGuids(dir)).toThrow()
  })
})

describe("recordAnswer", () => {
  it("records the person's answer from the server's message, once, and wakes a waiter", async () => {
    const { writer, lettersDir } = await delivered()
    const waiting = writer.run("slugger", "mailbox_wait", { letter: "L1", timeout: 5 })
    expect(await writer.recordAnswer("slugger", message({ text: "L1 2 — ship it" }), "shared-apple-id")).toEqual({
      recorded: true, id: "ltr_T1", code: "L1", subject: "Which name?", option: "2", label: "Ouro", note: "ship it",
    })
    expect(await waiting).toMatchObject({ state: "answered" })
    const read = await writer.run("slugger", "mailbox_read", { letter: "L1" })
    const answered = JSON.parse(fs.readFileSync(path.join(lettersDir, "ltr_T1.jsonl"), "utf8").trim().split("\n").at(-1)!)
    expect(answered).toEqual({
      t: "answered", at: new Date(NOW + 60_000).toISOString(), option: "2", note: "ship it", via: "chat",
      evidence: { friendId: "friend-ari", channel: "bluebubbles", chatGuid: `iMessage;-;${ARI}`, messageGuid: "m-1", dateCreated: new Date(NOW + 30_000).toISOString() },
      hostTrust: "shared-apple-id",
    })
    expect(read.events).toContain("answered 2 (Ouro)")
    expect([...readAnsweredGuids(lettersDir)]).toEqual(["m-1"])
    expect(await writer.recordAnswer("slugger", message(), "separate")).toEqual({ recorded: false, reason: "not-waiting" })
  })

  it("records nothing for text that isn't an answer, or names no letter", async () => {
    const { writer } = await delivered()
    expect(await writer.recordAnswer("slugger", message({ text: "Ouro" }), "separate")).toEqual({ recorded: false, reason: "not-answer-form" })
    expect(await writer.recordAnswer("slugger", message({ text: "L9 1" }), "separate")).toEqual({ recorded: false, reason: "no-such-letter" })
  })

  it("records nothing for each message the checks refuse", async () => {
    const { writer } = await delivered()
    const cases: Array<[Partial<ServerMessage>, string]> = [
      [{ isFromMe: true }, "from-me"],
      [{ isFromMe: undefined }, "from-me"],
      [{ service: "SMS" }, "not-imessage"],
      [{ service: undefined }, "not-imessage"],
      [{ sender: "+15559999999" }, "wrong-sender"],
      [{ sender: undefined }, "wrong-sender"],
      [{ sender: "not a handle" }, "wrong-sender"],
      [{ chatGuids: ["iMessage;+;chat42"] }, "wrong-chat"],
      [{ chatGuids: [`iMessage;-;${ARI}`, "iMessage;-;+15550000000"] }, "wrong-chat"],
      [{ chatGuids: ["iMessage;-;+15559999999"] }, "wrong-chat"],
      [{ chatGuids: ["iMessage;-;nobody"] }, "wrong-chat"],
      [{ threadOriginatorGuid: "letter-msg" }, "threaded"],
      [{ dateEdited: NOW + 40_000 }, "edited"],
      [{ dateRetracted: NOW + 40_000 }, "edited"],
      // With no server time for the sent letter, the floor is the daemon's delivered time less DELIVERY_SLACK_MS.
      [{ dateCreated: NOW - DELIVERY_SLACK_MS }, "before-delivery"],
      [{ dateCreated: undefined }, "before-delivery"],
      [{ text: "L1 3" }, "no-such-option"],
    ]
    for (const [extra, reason] of cases) {
      expect(await writer.recordAnswer("slugger", message(extra), "separate"), reason).toEqual({ recorded: false, reason })
    }
    // A real `any;-;<handle>` chat answers, with the sender's handle written any way the server writes it.
    expect(await writer.recordAnswer("slugger", message({ chatGuids: [`any;-;${ARI}`], sender: "+1 (555) 123-4567" }), "separate")).toMatchObject({ recorded: true })
  })

  it("dates delivery by the server's own time for the sent letter when it can, and by the daemon's less a margin when not", async () => {
    const { writer } = await delivered()
    const sentGuids: string[] = []
    const serverSaysSentAt = (time: number) => async (guid: string) => { sentGuids.push(guid); return time }
    expect(await writer.recordAnswer("slugger", message({ dateCreated: NOW + 10_000 }), "separate", serverSaysSentAt(NOW + 20_000))).toEqual({ recorded: false, reason: "before-delivery" })
    expect(sentGuids).toEqual(["sent-1"])
    // A server clock behind the daemon's still takes an answer sent after the letter.
    expect(await writer.recordAnswer("slugger", message({ dateCreated: NOW - 60 * 60_000 }), "separate", serverSaysSentAt(NOW - 61 * 60_000))).toMatchObject({ recorded: true })
  })

  it("falls back to the daemon's time when the server can't date the sent letter", async () => {
    const { writer } = await delivered()
    expect(await writer.recordAnswer("slugger", message({ dateCreated: NOW - 60_000 }), "separate", async () => { throw new Error("down") })).toMatchObject({ recorded: true })
  })

  it("takes an answer sent before expiry even when it is read after", async () => {
    const { writer, clock } = await delivered()
    clock.now = NOW + 10 * 60_000
    expect(await writer.recordAnswer("slugger", message({ dateCreated: NOW + 30_000 }), "separate")).toMatchObject({ recorded: true })
  })

  it("records nothing for a GUID that already answered, an undelivered or expired letter, or one with no handle", async () => {
    const { writer, lettersDir, clock } = await delivered()
    addAnsweredGuid(lettersDir, "m-old", "ltr_X", "t")
    expect(await writer.recordAnswer("slugger", message({ guid: "m-old" }), "separate")).toEqual({ recorded: false, reason: "guid-answered" })
    await writer.run("slugger", "mailbox_send", { kind: "know", subject: "Undelivered" })
    expect(await writer.recordAnswer("slugger", message({ text: "L2 1" }), "separate")).toEqual({ recorded: false, reason: "not-delivered" })
    await writer.run("slugger", "mailbox_send", { kind: "know", subject: "Soon gone", expiresAt: new Date(clock.now + 1000).toISOString() })
    clock.now += 2000
    expect(await writer.recordAnswer("slugger", message({ text: "L3 1", dateCreated: clock.now }), "separate")).toEqual({ recorded: false, reason: "not-waiting" })
    fs.writeFileSync(path.join(lettersDir, "answering.json"), JSON.stringify({ v: 1, handles: {} }))
    await writer.run("slugger", "mailbox_send", { kind: "know", subject: "No handle" })
    expect(await writer.recordAnswer("slugger", message({ text: "L4 1" }), "separate")).toEqual({ recorded: false, reason: "no-answering-handle" })
  })
})

describe("answerProblem", () => {
  it("says a letter with no delivered event hasn't been delivered", () => {
    const entry = { letter: { answeringHandle: ARI, options: [{ id: "1" }] }, events: [], state: "waiting", closed: false } as never
    expect(answerProblem(entry, message(), { code: "L1", option: "1" }, new Set(), null)).toBe("not-delivered")
    expect(answerProblem({ ...entry, letter: { ...(entry as { letter: object }).letter, expiresAt: new Date(NOW).toISOString() } } as never, message({ dateCreated: NOW }), { code: "L1", option: "1" }, new Set(), 0)).toBe("not-waiting")
    // A message the server didn't date can't show it came before expiry.
    expect(answerProblem({ ...entry, letter: { ...(entry as { letter: object }).letter, expiresAt: new Date(NOW).toISOString() } } as never, message({ dateCreated: undefined }), { code: "L1", option: "1" }, new Set(), 0)).toBe("not-waiting")
  })
})

describe("the letters.answer command", () => {
  const source = (extra: Partial<LetterAnswerSource> = {}) => async (): Promise<LetterAnswerSource> => ({
    trust: "loopback", hostTrust: "separate", getServerMessage: async (guid) => (guid === "m-1" ? message() : null), ...extra,
  })

  it("reads the message from the agent's own server and records the answer", async () => {
    const { writer } = await delivered()
    expect(await answerLettersAnswerCommand(writer, { kind: "letters.answer", agent: "slugger", messageGuid: " m-1 " }, source()))
      .toEqual({ ok: true, data: expect.objectContaining({ recorded: true, code: "L1", option: "2" }) })
  })

  it("asks no server whose address can't be trusted, and records nothing for a message it doesn't hold", async () => {
    const { writer } = await delivered()
    const fetched: string[] = []
    expect(await answerLettersAnswerCommand(writer, { kind: "letters.answer", agent: "slugger", messageGuid: "m-1" }, source({ trust: "untrusted", getServerMessage: async (guid) => { fetched.push(guid); return null } })))
      .toEqual({ ok: true, data: { recorded: false, reason: "untrusted-server-url" } })
    expect(fetched).toEqual([])
    expect(await answerLettersAnswerCommand(writer, { kind: "letters.answer", agent: "slugger", messageGuid: "m-9" }, source({ getServerMessage: async () => null })))
      .toEqual({ ok: true, data: { recorded: false, reason: "unknown-message" } })
  })

  it("checks the agent before asking its server, and takes only the message it asked for", async () => {
    const { writer } = await delivered()
    const asked: string[] = []
    expect(await answerLettersAnswerCommand(writer, { kind: "letters.answer", agent: "../x", messageGuid: "m-1" }, async () => { asked.push("x"); throw new Error("read") }))
      .toEqual({ ok: false, error: "No agent bundle ../x.ouro is on this machine." })
    expect(asked).toEqual([])
    expect(await answerLettersAnswerCommand(writer, { kind: "letters.answer", agent: "slugger", messageGuid: "m-other" }, source()))
      .toEqual({ ok: true, data: { recorded: false, reason: "unknown-message" } })
  })

  it("asks the server when it sent the letter", async () => {
    const { writer } = await delivered()
    const asked: string[] = []
    const getServerMessage = async (guid: string) => { asked.push(guid); return guid === "m-1" ? message() : { ...message(), guid, dateCreated: NOW + 1000 } }
    expect(await answerLettersAnswerCommand(writer, { kind: "letters.answer", agent: "slugger", messageGuid: "m-1" }, source({ getServerMessage })))
      .toEqual({ ok: true, data: expect.objectContaining({ recorded: true }) })
    expect(asked).toEqual(["m-1", "sent-1"])
  })

  it("refuses a command with no GUID, and reports a server that can't be reached", async () => {
    const { writer } = await delivered()
    expect(await answerLettersAnswerCommand(writer, { kind: "letters.answer", agent: "slugger", messageGuid: " " }, source())).toEqual({ ok: false, error: "letters.answer needs an agent and a messageGuid." })
    expect(await answerLettersAnswerCommand(writer, { kind: "letters.answer", agent: "slugger" } as never, source())).toMatchObject({ ok: false })
    expect(await answerLettersAnswerCommand(writer, { kind: "letters.answer", agent: "slugger", messageGuid: "m-1" }, source({ getServerMessage: async () => { throw new Error("server down") } })))
      .toEqual({ ok: false, error: "server down" })
  })
})
