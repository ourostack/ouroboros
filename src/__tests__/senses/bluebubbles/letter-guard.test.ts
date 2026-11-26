import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// Every server is taken to run under the agent's declared host account; that check has its own tests.
vi.mock("../../../senses/bluebubbles/host-account-verifier", () => ({ verifyBlueBubblesServerAccount: vi.fn(async () => undefined) }))
vi.mock("../../../senses/bluebubbles/send-health", () => ({ recordBlueBubblesSendBlocked: vi.fn(), recordBlueBubblesSendDelivered: vi.fn() }))

import { writeAnsweringHandle } from "../../../heart/letters/answering"
import { BlueBubblesSendError, createBlueBubblesClient } from "../../../senses/bluebubbles/client"
import { OURO_LETTER_SEND, answeringHandleSet, letterChatRefusal, oneToOneHandle, tellAgentReplyRefused } from "../../../senses/bluebubbles/letter-guard"
import { getPrivateRuntimePendingDir } from "../../../mind/pending"
import type { BlueBubblesChatRef } from "../../../senses/bluebubbles/model"

const direct = (handle: string, extra: Partial<BlueBubblesChatRef> = {}): BlueBubblesChatRef =>
  ({ chatIdentifier: handle, isGroup: false, sessionKey: `chat_identifier:${handle}`, sendTarget: { kind: "chat_identifier", value: handle }, participantHandles: [], ...extra })

let agentRoot: string
beforeEach(() => {
  agentRoot = fs.mkdtempSync(path.join(os.tmpdir(), "letter-guard-"))
  writeAnsweringHandle(path.join(agentRoot, "state", "letters"), "friend-ari", "+15551234567")
})
afterEach(() => {
  fs.rmSync(agentRoot, { recursive: true, force: true })
  vi.unstubAllGlobals()
})

describe("oneToOneHandle", () => {
  it("reads the handle from the chat GUID first, then the identifier, then the send target, normalised", () => {
    expect(oneToOneHandle(direct("x", { chatGuid: "any;-;ARI@Example.com" }))).toBe("ari@example.com")
    expect(oneToOneHandle(direct("+1 (555) 123-4567"))).toBe("+15551234567")
    expect(oneToOneHandle({ isGroup: false, sessionKey: "k", sendTarget: { kind: "chat_identifier", value: "+15551234567" }, participantHandles: [] })).toBe("+15551234567")
  })

  it("has no handle for a group, a chat with none, or one that isn't a handle", () => {
    expect(oneToOneHandle(direct("chat123456", { isGroup: true }))).toBeNull()
    expect(oneToOneHandle({ isGroup: false, sessionKey: "k", sendTarget: { kind: "chat_guid", value: "g" }, participantHandles: [] })).toBeNull()
    expect(oneToOneHandle(direct("chat1234"))).toBeNull()
  })
})

describe("letterChatRefusal", () => {
  it("refuses agent text that folds to a letter code or the option block in a letters chat", () => {
    for (const text of ["About L7: pick 2", "Ｌ８ is waiting", "Options (from Ouro):", "see letter 3"]) {
      expect(letterChatRefusal({ what: "message", chat: direct("+15551234567"), text }, agentRoot)).toMatch(/^This message names a letter code/)
    }
    expect(letterChatRefusal({ what: "message", chat: direct("+15551234567"), text: "L7" }, agentRoot))
      .toBe("This message names a letter code or Ouro's option block, which only Ouro writes in +15551234567's letters chat. Refer to the letter by its subject instead.")
  })

  it("lets ordinary text, other chats, Ouro's own marked text and agents with no letters chat through", () => {
    expect(letterChatRefusal({ what: "message", chat: direct("+15551234567"), text: "At 12:30, v1.2 shipped, all 3 lanes wait until 5pm." }, agentRoot)).toBeNull()
    expect(letterChatRefusal({ what: "message", chat: direct("+15559999999"), text: "L7" }, agentRoot)).toBeNull()
    expect(letterChatRefusal({ what: "message", chat: direct("chat123456", { isGroup: true }), text: "L7" }, agentRoot)).toBeNull()
    // A display name can mark a one-to-one chat a group; its handle still decides.
    expect(letterChatRefusal({ what: "message", chat: direct("+15551234567", { isGroup: true }), text: "L7" }, agentRoot)).toMatch(/letters chat/)
    expect(letterChatRefusal({ what: "message", chat: direct("+15551234567"), text: "L7 · Slugger asks", mark: OURO_LETTER_SEND }, agentRoot)).toBeNull()
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), "letter-guard-none-"))
    expect(answeringHandleSet(empty)!.size).toBe(0)
    expect(letterChatRefusal({ what: "edit", chat: null, text: "L7" }, empty)).toBeNull()
    fs.rmSync(empty, { recursive: true, force: true })
  })

  it("reads a handle from a GUID in any field, and trusts the GUID's shape over isGroup", () => {
    expect(oneToOneHandle(direct("iMessage;-;+15551234567"))).toBe("+15551234567")
    expect(oneToOneHandle({ isGroup: false, sessionKey: "k", sendTarget: { kind: "chat_identifier", value: "SMS;-;ARI@x.io" }, participantHandles: [] })).toBe("ari@x.io")
    expect(oneToOneHandle(direct("x", { chatGuid: "iMessage;-;+15551234567", isGroup: true }))).toBe("+15551234567")
    expect(oneToOneHandle(direct("+15551234567", { chatGuid: "iMessage;+;chat99" }))).toBeNull()
    for (const chatIdentifier of ["iMessage;-;+15551234567", "iMessage;-;+1 555 123 4567"]) {
      expect(letterChatRefusal({ what: "message", chat: direct(chatIdentifier), text: "L7" }, agentRoot)).toMatch(/letters chat/)
    }
  })

  it("guards the handle frozen on an open letter after the person's handle changes", () => {
    const lettersDir = path.join(agentRoot, "state", "letters")
    fs.writeFileSync(path.join(lettersDir, "ltr_A1.jsonl"), `${JSON.stringify({ v: 1, id: "ltr_A1", code: "L1", answeringHandle: "+15550000000", to: "friend-ari", from: { agent: "slugger" }, kind: "know", subject: "s", whyOnlyYou: "w", body: "", options: [], links: [], urgency: "today", createdAt: "2026-11-26T00:00:00.000Z" })}\n`)
    fs.writeFileSync(path.join(lettersDir, "ltr_A2.jsonl"), `${JSON.stringify({ v: 1, id: "ltr_A2", code: "L2", to: "friend-ari", from: { agent: "slugger" }, kind: "know", subject: "s", whyOnlyYou: "w", body: "", options: [], links: [], urgency: "today", createdAt: "2026-11-26T00:00:00.000Z" })}\n`)
    writeAnsweringHandle(lettersDir, "friend-ari", "+15551234567")
    expect([...answeringHandleSet(agentRoot)!].sort()).toEqual(["+15550000000", "+15551234567"])
    expect(letterChatRefusal({ what: "message", chat: direct("+15550000000"), text: "L1" }, agentRoot)).toMatch(/\+15550000000's letters chat/)
  })

  it("fails closed when answering.json doesn't read: coded text is refused in every one-to-one chat", () => {
    fs.writeFileSync(path.join(agentRoot, "state", "letters", "answering.json"), "{torn")
    expect(answeringHandleSet(agentRoot)).toBeNull()
    expect(letterChatRefusal({ what: "message", chat: direct("+15559999999"), text: "L7" }, agentRoot)).toMatch(/only Ouro writes where letters go/)
    expect(letterChatRefusal({ what: "message", chat: direct("chat999999", { isGroup: true }), text: "L7" }, agentRoot)).toBeNull()
    expect(letterChatRefusal({ what: "message", chat: direct("+15559999999"), text: "hello" }, agentRoot)).toBeNull()
    expect(letterChatRefusal({ what: "message", chat: direct("+15559999999"), text: "L7" }, () => agentRoot)).toMatch(/where letters go/)
  })

  it("fails closed when an open letter doesn't read", () => {
    fs.mkdirSync(path.join(agentRoot, "state", "letters", "ltr_B1.jsonl"))
    expect(answeringHandleSet(agentRoot)).toBeNull()
  })

  it("logs, rather than throws, when the note to the agent can't be queued", () => {
    const blocked = path.join(agentRoot, "blocked")
    fs.writeFileSync(blocked, "")
    expect(() => tellAgentReplyRefused("slugger", blocked, "m-2", "refused")).not.toThrow()
  })

  it("queues a note for the agent when its reply was refused, once per message", () => {
    tellAgentReplyRefused("slugger", agentRoot, "m-1", "This message names a letter code.")
    const dir = getPrivateRuntimePendingDir("slugger", agentRoot)
    const notes = fs.readdirSync(dir).map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")))
    expect(notes).toEqual([expect.objectContaining({ channel: "inner", packetId: "letter-guard:m-1", content: "my iMessage reply wasn't sent, so they haven't heard back from me: This message names a letter code." })])
  })

  it("refuses an edit into a letter code wherever it is, since an edit names no chat", () => {
    expect(letterChatRefusal({ what: "edit", chat: null, text: "L7 2" }, agentRoot)).toBe("This edit names a letter code or Ouro's option block, which only Ouro writes where letters go. Refer to the letter by its subject instead.")
  })
})

describe("the BlueBubbles client's letters chat", () => {
  const client = () => createBlueBubblesClient(
    { serverUrl: "http://bluebubbles.local", password: "pw", accountId: "default", ownHandles: [] },
    { port: 18790, webhookPath: "/bluebubbles-webhook", requestTimeoutMs: 1000 },
    { agent: "slugger", agentRoot, hostUsername: "slugger" },
  )

  it("refuses a send, an attachment or an edit before anything reaches the server", async () => {
    const fetch = vi.fn()
    vi.stubGlobal("fetch", fetch)
    await expect(client().sendText({ chat: direct("+15551234567"), text: "Answer L7 with 2" })).rejects.toEqual(expect.objectContaining({ name: "BlueBubblesSendError", errorCode: "letter_guard", transportInvoked: false }))
    await expect(client().sendText({ chat: direct("+15551234567"), text: "L7" })).rejects.toBeInstanceOf(BlueBubblesSendError)
    await expect(client().sendAttachment!({ chat: direct("+15551234567"), file: { name: "L7-options.png", contentType: "image/png", bytes: Buffer.from("x") } })).rejects.toThrow(/This attachment's name names a letter code/)
    await expect(client().editMessage({ messageGuid: "m-1", text: "L7 2" })).rejects.toThrow(/This edit names a letter code/)
    await expect(client().editMessage({ messageGuid: "m-1", text: "fixed", backwardsCompatibilityMessage: "Edited to: L7 2" })).rejects.toThrow(/This edit names a letter code/)
    expect(fetch).not.toHaveBeenCalled()
  })
})
