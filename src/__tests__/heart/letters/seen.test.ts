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
    expect(await writer.recordSeen("slugger", read())).toEqual({ recorded: true, code: "L1" })
    expect(await writer.recordSeen("slugger", read())).toEqual({ recorded: false, reason: "already-seen" })
    clock.now = NOW + 2 * 60 * 60_000 + 60_000
    expect((await writer.run("slugger", "mailbox_list", {})).listing).toBe("L1  waiting, seen 2h ago  2h  The build is green\nL2  waiting  2h  Not yet sent")
    expect((await writer.run("slugger", "mailbox_read", { letter: "L1" })).events).toContain(`${new Date(NOW + 60_000).toISOString()} seen on chat`)
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

  it("isn't recorded for a letter that is no longer waiting, or whose send wasn't confirmed", async () => {
    const { writer } = await delivered()
    await writer.run("slugger", "mailbox_withdraw", { letter: "L1", reason: "Fixed it myself." })
    expect(await writer.recordSeen("slugger", read())).toEqual({ recorded: false, reason: "no-letter" })
    expect(await writer.recordSeen("slugger", read({ guid: "" }))).toEqual({ recorded: false, reason: "no-letter" })
  })
})

describe("the letters.seen command", () => {
  const source = (extra: Partial<LetterAnswerSource> = {}) => async (): Promise<LetterAnswerSource> => ({
    trust: "loopback", hostTrust: "separate", getServerMessage: async (guid) => (guid === "sent-1" ? read() : null), ...extra,
  })

  it("reads the message from the agent's own server and records the letter seen", async () => {
    const { writer } = await delivered()
    expect(await answerLettersSeenCommand(writer, { kind: "letters.seen", agent: "slugger", messageGuid: " sent-1 " }, source())).toEqual({ ok: true, data: { recorded: true, code: "L1" } })
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
    expect(await answerLettersSeenCommand(writer, { kind: "letters.seen", agent: "slugger", messageGuid: "sent-9" }, source())).toEqual({ ok: true, data: { recorded: false, reason: "unknown-message" } })
    expect(await answerLettersSeenCommand(writer, { kind: "letters.seen", agent: "slugger", messageGuid: "sent-1" }, source({ getServerMessage: async () => read({ guid: "else" }) }))).toEqual({ ok: true, data: { recorded: false, reason: "unknown-message" } })
    expect(await answerLettersSeenCommand(writer, { kind: "letters.seen", agent: "slugger", messageGuid: "sent-1" }, source({ getServerMessage: async () => { throw new Error("server down") } }))).toEqual({ ok: false, error: "server down" })
  })
})
