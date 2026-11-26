import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// Every server is taken to run under the agent's declared host account; that check has its own tests.
vi.mock("../../../senses/bluebubbles/host-account-verifier", () => ({ verifyBlueBubblesServerAccount: vi.fn(async () => undefined) }))
vi.mock("../../../senses/bluebubbles/send-health", () => ({ recordBlueBubblesSendBlocked: vi.fn(), recordBlueBubblesSendDelivered: vi.fn() }))

import { writeAnsweringHandle } from "../../../heart/letters/answering"
import { BlueBubblesSendError, createBlueBubblesClient } from "../../../senses/bluebubbles/client"
import { OURO_LETTER_SEND, answeringHandleSet, letterChatRefusal, oneToOneHandle } from "../../../senses/bluebubbles/letter-guard"
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
    expect(oneToOneHandle(direct("+15551234567", { isGroup: true }))).toBeNull()
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
    expect(letterChatRefusal({ what: "message", chat: direct("+15551234567", { isGroup: true }), text: "L7" }, agentRoot)).toBeNull()
    expect(letterChatRefusal({ what: "message", chat: direct("+15551234567"), text: "L7 · Slugger asks", mark: OURO_LETTER_SEND }, agentRoot)).toBeNull()
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), "letter-guard-none-"))
    expect(answeringHandleSet(empty).size).toBe(0)
    expect(letterChatRefusal({ what: "edit", chat: null, text: "L7" }, empty)).toBeNull()
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
    expect(fetch).not.toHaveBeenCalled()
  })
})
