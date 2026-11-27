import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import type { FriendRecord } from "@ouro.bot/friends"
import { afterEach, describe, expect, it } from "vitest"
import type { ServerMessage } from "../../../heart/letters/answer-reader"
import { writeAnsweringHandle } from "../../../heart/letters/answering"
import { answerLettersSeenCommand } from "../../../heart/letters/seen-command"
import { LettersWriter } from "../../../heart/letters/writer"
import type { LetterAnswerSource } from "../../../senses/bluebubbles/agent-client"

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }) })

const NOW = Date.parse("2026-11-26T12:00:00.000Z")
const ARI = "+15551234567"
const CHAT = `iMessage;-;${ARI}`

/** Slugger's L1, delivered at NOW as message sent-1, and L2, filed but not delivered. */
async function delivered() {
  const bundles = fs.mkdtempSync(path.join(os.tmpdir(), "letters-seen-"))
  roots.push(bundles)
  writeAnsweringHandle(path.join(bundles, "slugger.ouro", "state", "letters"), "friend-ari", ARI)
  const clock = { now: NOW }
  let n = 0
  const writer = new LettersWriter({
    bundlesRoot: bundles, now: () => new Date(clock.now), newId: () => `ltr_T${++n}`, ownerUsername: () => "ari",
    listFriends: async () => [{ id: "friend-ari", name: "Ari", trustLevel: "family", externalIds: [{ provider: "local", externalId: "ari" }] } as unknown as FriendRecord],
    deliverChat: async () => ({ channel: "bluebubbles", key: CHAT, messageId: "sent-1" }),
  })
  await writer.run("slugger", "mailbox_send", { kind: "know", subject: "The build is green" })
  await writer.run("slugger", "mailbox_send", { kind: "know", subject: "Not yet sent" })
  await writer.run("slugger", "mailbox_deliver", { letter: "L1" })
  return { writer, clock }
}
const read = (extra: Partial<ServerMessage> = {}): ServerMessage => ({ guid: "sent-1", text: "x", isFromMe: true, chatGuids: [CHAT], dateCreated: NOW, dateRead: NOW + 60_000, ...extra })

describe("a letter the person has read", () => {
  it("is recorded seen once, at the server's read time, and the listing says so", async () => {
    const { writer, clock } = await delivered()
    expect(await writer.recordSeen("slugger", read())).toEqual({ recorded: true, codes: ["L1"] })
    expect(await writer.recordSeen("slugger", read())).toEqual({ recorded: false, reason: "already-seen" })
    clock.now = NOW + 2 * 60 * 60_000 + 60_000
    expect((await writer.run("slugger", "mailbox_list", {})).listing).toBe("L1  waiting, seen 2h ago  2h  The build is green\nL2  waiting  2h  Not yet sent")
    const letter = await writer.run("slugger", "mailbox_read", { letter: "L1" })
    expect(letter.seen).toBe("seen 2h ago, not answered")
    expect(letter.events).toContain(`${new Date(NOW + 60_000).toISOString()} seen on chat`)
    expect((await writer.run("slugger", "mailbox_read", { letter: "L2" })).seen).toBeUndefined()
  })

  it("needs the server to say this side sent it, into the chat it went to, and that it was read", async () => {
    const { writer } = await delivered()
    expect(await writer.recordSeen("slugger", read({ guid: "other" }))).toEqual({ recorded: false, reason: "no-letter" })
    expect(await writer.recordSeen("slugger", read({ isFromMe: false }))).toEqual({ recorded: false, reason: "not-from-me" })
    expect(await writer.recordSeen("slugger", read({ isFromMe: undefined }))).toEqual({ recorded: false, reason: "not-from-me" })
    expect(await writer.recordSeen("slugger", read({ chatGuids: ["iMessage;-;+15550000000"] }))).toEqual({ recorded: false, reason: "wrong-chat" })
    expect(await writer.recordSeen("slugger", read({ chatGuids: [CHAT, CHAT] }))).toEqual({ recorded: false, reason: "wrong-chat" })
    expect(await writer.recordSeen("slugger", read({ dateRead: undefined }))).toEqual({ recorded: false, reason: "not-read" })
  })

  it("isn't recorded for a letter that is no longer waiting", async () => {
    const { writer } = await delivered()
    await writer.run("slugger", "mailbox_withdraw", { letter: "L1", reason: "Fixed it myself." })
    expect(await writer.recordSeen("slugger", read())).toEqual({ recorded: false, reason: "no-letter" })
    expect(writer.hasWaitingDelivery("slugger", "sent-1")).toBe(false)
  })

  it("isn't recorded for a letter whose send wasn't confirmed, which has no message GUID", async () => {
    const bundles = fs.mkdtempSync(path.join(os.tmpdir(), "letters-seen-"))
    roots.push(bundles)
    writeAnsweringHandle(path.join(bundles, "slugger.ouro", "state", "letters"), "friend-ari", ARI)
    const writer = new LettersWriter({
      bundlesRoot: bundles, now: () => new Date(NOW), newId: () => "ltr_U1", ownerUsername: () => "ari",
      listFriends: async () => [{ id: "friend-ari", name: "Ari", trustLevel: "family", externalIds: [{ provider: "local", externalId: "ari" }] } as unknown as FriendRecord],
      deliverChat: async () => { throw Object.assign(new Error("socket closed mid-send"), { transportInvoked: true }) },
    })
    await writer.run("slugger", "mailbox_send", { kind: "know", subject: "The build is green" })
    await writer.run("slugger", "mailbox_deliver", { letter: "L1" }).catch(() => undefined)
    expect((await writer.run("slugger", "mailbox_read", { letter: "L1" })).events).toContain("delivered")
    expect(writer.hasWaitingDelivery("slugger", "")).toBe(false)
    expect(await writer.recordSeen("slugger", read({ guid: "" }))).toEqual({ recorded: false, reason: "no-letter" })
  })
})

describe("a letter the person wrote after, with their read receipts off", () => {
  // Ari's own iMessage in his one-to-one chat, sent a minute after L1 landed.
  const reply = (extra: Partial<ServerMessage> = {}): ServerMessage => ({ guid: "in-1", text: "sorry what's the question?", isFromMe: false, sender: ARI, service: "iMessage", chatGuids: [CHAT], dateCreated: NOW + 60_000, ...extra })

  it("is recorded seen once, at the time they wrote, and only for letters delivered before", async () => {
    const { writer } = await delivered()
    expect(writer.hasUnseenDelivery("slugger")).toBe(true)
    expect(await writer.recordSeenByReply("slugger", reply())).toEqual({ recorded: true, codes: ["L1"] })
    expect((await writer.run("slugger", "mailbox_read", { letter: "L1" })).events).toContain(`${new Date(NOW + 60_000).toISOString()} seen on chat`)
    expect((await writer.run("slugger", "mailbox_read", { letter: "L2" })).seen).toBeUndefined()
    expect(writer.hasUnseenDelivery("slugger")).toBe(false)
    expect(await writer.recordSeenByReply("slugger", reply({ guid: "in-2" }))).toEqual({ recorded: false, reason: "no-letter" })
  })

  it("dates the letter's landing by the server's send time when it can be had", async () => {
    const { writer } = await delivered()
    // The server sent L1 at NOW + 2 min, so a message at NOW + 1 min came before it.
    const sentAt = async (guid: string) => (guid === "sent-1" ? NOW + 120_000 : undefined)
    expect(await writer.recordSeenByReply("slugger", reply(), sentAt)).toEqual({ recorded: false, reason: "no-letter" })
    expect(await writer.recordSeenByReply("slugger", reply({ dateCreated: NOW + 180_000 }), sentAt)).toEqual({ recorded: true, codes: ["L1"] })
  })

  it("needs an iMessage from the answering handle, in their one-to-one chat, after the letter landed", async () => {
    const { writer } = await delivered()
    for (const extra of [
      { isFromMe: true }, { isFromMe: undefined }, { service: "SMS" }, { sender: undefined }, { sender: "+15550000000" },
      { chatGuids: ["iMessage;-;+15550000000"] }, { chatGuids: [CHAT, CHAT] }, { chatGuids: ["iMessage;+;chat-group"] },
      { dateCreated: undefined }, { dateCreated: NOW - 6 * 60_000 },
    ] as Partial<ServerMessage>[]) {
      expect(await writer.recordSeenByReply("slugger", reply(extra))).toEqual({ recorded: false, reason: "no-letter" })
    }
    expect(writer.hasUnseenDelivery("slugger")).toBe(true)
  })

  it("leaves a letter already seen by its read receipt, or no longer waiting", async () => {
    const { writer } = await delivered()
    await writer.recordSeen("slugger", read())
    expect(writer.hasUnseenDelivery("slugger")).toBe(false)
    expect(await writer.recordSeenByReply("slugger", reply())).toEqual({ recorded: false, reason: "no-letter" })
    const again = await delivered()
    await again.writer.run("slugger", "mailbox_withdraw", { letter: "L1", reason: "Fixed it myself." })
    expect(again.writer.hasUnseenDelivery("slugger")).toBe(false)
  })
})

describe("replySeenProblem", () => {
  it("names why a message shows nothing about a letter", async () => {
    const { replySeenProblem } = await import("../../../heart/letters/answer-reader")
    const entry = (over: Record<string, unknown> = {}) => ({ state: "waiting", events: [], letter: { answeringHandle: ARI }, ...over }) as never
    const message: ServerMessage = { guid: "in-1", text: "", isFromMe: false, sender: ARI, service: "iMessage", chatGuids: [CHAT], dateCreated: NOW }
    expect(replySeenProblem(entry({ state: "answered" }), message, 0)).toBe("not-waiting")
    expect(replySeenProblem(entry({ events: [{ t: "seen" }] }), message, 0)).toBe("already-seen")
    expect(replySeenProblem(entry({ letter: {} }), message, 0)).toBe("no-answering-handle")
    expect(replySeenProblem(entry(), message, null)).toBe("not-delivered")
    expect(replySeenProblem(entry(), message, NOW)).toBe("before-delivery")
    expect(replySeenProblem(entry(), message, NOW - 1)).toBeNull()
  })
})

describe("the letters.seen command", () => {
  const source = (extra: Partial<LetterAnswerSource> = {}) => async (): Promise<LetterAnswerSource> => ({
    trust: "loopback", hostTrust: "separate", getServerMessage: async (guid) => (guid === "sent-1" ? read() : null), ...extra,
  })

  it("reads the message from the agent's own server and records the letter seen", async () => {
    const { writer } = await delivered()
    expect(await answerLettersSeenCommand(writer, { kind: "letters.seen", agent: "slugger", messageGuid: " sent-1 " }, source())).toEqual({ ok: true, data: { recorded: true, codes: ["L1"] } })
  })

  it("reads a message the person sent and records seen the letters that landed in their chat before it", async () => {
    const { writer } = await delivered()
    const theirs: ServerMessage = { guid: "in-1", text: "hi", isFromMe: false, sender: ARI, service: "iMessage", chatGuids: [CHAT], dateCreated: NOW + 60_000 }
    const fetched: string[] = []
    const getServerMessage = async (guid: string) => { fetched.push(guid); return guid === "in-1" ? theirs : guid === "sent-1" ? read() : null }
    expect(await answerLettersSeenCommand(writer, { kind: "letters.seen", agent: "slugger", messageGuid: "in-1" }, source({ getServerMessage }))).toEqual({ ok: true, data: { recorded: true, codes: ["L1"] } })
    // The letter's own sent message dates its landing on the server's clock.
    expect(fetched).toEqual(["in-1", "sent-1"])
    // With nothing left unseen, the next message is turned away from the index, before the server is asked.
    expect(await answerLettersSeenCommand(writer, { kind: "letters.seen", agent: "slugger", messageGuid: "in-2" }, source({ getServerMessage }))).toEqual({ ok: true, data: { recorded: false, reason: "no-letter" } })
    expect(fetched).toEqual(["in-1", "sent-1"])
  })

  it("refuses a bad command or agent, asks no untrusted server, and records nothing for a message it can't find", async () => {
    const { writer } = await delivered()
    expect(await answerLettersSeenCommand(writer, { kind: "letters.seen", agent: "slugger", messageGuid: " " }, source())).toMatchObject({ ok: false })
    expect(await answerLettersSeenCommand(writer, { kind: "letters.seen", agent: 5 as never, messageGuid: "sent-1" }, source())).toMatchObject({ ok: false })
    expect(await answerLettersSeenCommand(writer, { kind: "letters.seen", agent: "nobody", messageGuid: "sent-1" }, source())).toMatchObject({ ok: false, error: expect.stringContaining("nobody.ouro") })
    const fetched: string[] = []
    expect(await answerLettersSeenCommand(writer, { kind: "letters.seen", agent: "slugger", messageGuid: "sent-1" }, source({ trust: "untrusted", getServerMessage: async (guid) => { fetched.push(guid); return null } })))
      .toEqual({ ok: true, data: { recorded: false, reason: "untrusted-server-url" } })
    expect(fetched).toEqual([])
    // Once no delivered letter is unseen, a message no waiting letter was delivered as is turned away from the index, before the server is asked.
    await writer.recordSeen("slugger", read())
    let asked = 0
    expect(await answerLettersSeenCommand(writer, { kind: "letters.seen", agent: "slugger", messageGuid: "sent-9" }, async () => { asked++; return source()() })).toEqual({ ok: true, data: { recorded: false, reason: "no-letter" } })
    expect(asked).toBe(0)
    expect(await answerLettersSeenCommand(writer, { kind: "letters.seen", agent: "slugger", messageGuid: "sent-1" }, source({ getServerMessage: async () => null }))).toEqual({ ok: true, data: { recorded: false, reason: "unknown-message" } })
    expect(await answerLettersSeenCommand(writer, { kind: "letters.seen", agent: "slugger", messageGuid: "sent-1" }, source({ getServerMessage: async () => read({ guid: "else" }) }))).toEqual({ ok: true, data: { recorded: false, reason: "unknown-message" } })
    expect(await answerLettersSeenCommand(writer, { kind: "letters.seen", agent: "slugger", messageGuid: "sent-1" }, source({ getServerMessage: async () => { throw new Error("server down") } }))).toEqual({ ok: false, error: "server down" })
  })
})
