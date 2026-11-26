import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { afterEach, describe, expect, it, vi } from "vitest"

const credentials = vi.hoisted(() => ({
  read: vi.fn(),
  refresh: vi.fn(),
}))

vi.mock("../../../heart/runtime-credentials", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../heart/runtime-credentials")>()),
  readMachineRuntimeCredentialConfig: credentials.read,
  refreshMachineRuntimeCredentialConfig: credentials.refresh,
}))

vi.mock("../../../heart/machine-identity", () => ({ loadOrCreateMachineIdentity: () => ({ machineId: "machine-1" }) }))

import {
  agentHostOptions,
  agentMachineRuntimeConfig,
  blueBubblesClientForAgent,
  blueBubblesSettings,
  chatWithHandle,
  letterChatSender,
  sendLetterByBlueBubbles,
} from "../../../senses/bluebubbles/agent-client"
import { BlueBubblesSendError, type BlueBubblesClient } from "../../../senses/bluebubbles/client"
import { OURO_LETTER_SEND } from "../../../senses/bluebubbles/letter-guard"

const ok = (config: Record<string, unknown>) => ({ ok: true as const, itemPath: "vault:runtime/machines/machine-1/config", config, revision: "r1", updatedAt: "2026-11-26T00:00:00.000Z" })
const configured = ok({ bluebubbles: { serverUrl: " http://127.0.0.1:1234 ", password: " pw ", ownHandles: [" me@x.io ", 7, ""] }, bluebubblesChannel: { port: 9999 } })

afterEach(() => {
  credentials.read.mockReset()
  credentials.refresh.mockReset()
})

describe("agentMachineRuntimeConfig", () => {
  it("uses the cached config, and reads the vault for this machine only when nothing is cached", async () => {
    credentials.read.mockReturnValueOnce(configured)
    expect(await agentMachineRuntimeConfig("slugger")).toBe(configured)
    expect(credentials.refresh).not.toHaveBeenCalled()
    credentials.read.mockReturnValueOnce({ ok: false, reason: "missing", itemPath: "p", error: "none" })
    credentials.refresh.mockResolvedValueOnce(configured)
    expect(await agentMachineRuntimeConfig("slugger")).toBe(configured)
    expect(credentials.refresh).toHaveBeenCalledWith("slugger", "machine-1", { preserveCachedOnFailure: true })
  })
})

describe("blueBubblesSettings", () => {
  it("reads the client and channel settings, trimmed, with the channel's defaults", () => {
    expect(blueBubblesSettings(configured)).toEqual({
      config: { serverUrl: "http://127.0.0.1:1234", password: "pw", accountId: "default", ownHandles: ["me@x.io"] },
      channelConfig: { port: 9999, webhookPath: "/bluebubbles-webhook", requestTimeoutMs: 30_000 },
    })
    expect(blueBubblesSettings(ok({ bluebubbles: { serverUrl: "u", password: "p", accountId: "acct", ownHandles: "x" }, bluebubblesChannel: [] }), "route").config)
      .toEqual({ serverUrl: "u", password: "p", accountId: "acct", ownHandles: [] })
    expect(blueBubblesSettings(ok({ bluebubbles: { serverUrl: "u", password: "p" } }), "route").config.accountId).toBe("route")
  })

  it("names what is missing and the command that fixes it", () => {
    expect(() => blueBubblesSettings({ ok: false, reason: "missing", itemPath: "vault:x", error: "nothing stored" }))
      .toThrow("BlueBubbles runtime config unavailable at vault:x: nothing stored")
    expect(() => blueBubblesSettings(ok({}))).toThrow(/bluebubbles\.serverUrl is required/)
    expect(() => blueBubblesSettings(ok({ bluebubbles: { serverUrl: "u" } }))).toThrow(/bluebubbles\.password is required/)
  })
})

describe("agentHostOptions", () => {
  it("reads the agent's declared host account, and leaves it unset when agent.json doesn't read", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "bb-agent-client-"))
    const agentRoot = path.join(root, "slugger.ouro")
    expect(agentHostOptions("slugger", agentRoot)).toEqual({ agent: "slugger", agentRoot, hostUsername: undefined })
    fs.mkdirSync(agentRoot)
    fs.writeFileSync(path.join(agentRoot, "agent.json"), JSON.stringify({
      version: 2, enabled: true, humanFacing: { provider: "anthropic", model: "m" }, agentFacing: { provider: "anthropic", model: "m" },
      senses: { bluebubbles: { enabled: true, hostUsername: "slugger-host" } },
    }))
    expect(agentHostOptions("slugger", agentRoot).hostUsername).toBe("slugger-host")
  })
})

describe("sending a letter by BlueBubbles", () => {
  it("addresses a one-to-one chat by the handle alone", () => {
    expect(chatWithHandle("+15551234567")).toEqual({
      chatIdentifier: "+15551234567", isGroup: false, sessionKey: "chat_identifier:+15551234567",
      sendTarget: { kind: "chat_identifier", value: "+15551234567" }, participantHandles: [],
    })
  })

  it("sends the text to the handle's chat as the agent and says where it landed", async () => {
    const sendText = vi.fn().mockResolvedValue({ messageGuid: "m-1", chatGuid: "iMessage;-;+15551234567" })
    const clientFor = vi.fn(async () => ({ sendText }) as unknown as BlueBubblesClient)
    const send = letterChatSender("/bundles", clientFor)
    expect(await send({ agent: "slugger", handle: "+15551234567", text: "L1 · hi" })).toEqual({ channel: "bluebubbles", key: "iMessage;-;+15551234567", messageId: "m-1" })
    expect(clientFor).toHaveBeenCalledWith("slugger", path.join("/bundles", "slugger.ouro"))
    expect(sendText).toHaveBeenCalledWith({ chat: chatWithHandle("+15551234567"), text: "L1 · hi", mark: OURO_LETTER_SEND })
  })

  it("leaves the chat and message blank when the server names neither, rather than failing a sent message", async () => {
    const clientFor = async () => ({ sendText: async () => ({}) }) as unknown as BlueBubblesClient
    expect(await sendLetterByBlueBubbles({ agent: "slugger", handle: "a@x.io", text: "t" }, "/root", clientFor)).toEqual({ channel: "bluebubbles", key: "", messageId: "" })
  })

  it("says how to fix a chat that doesn't exist yet, and passes any other send error on as it is", async () => {
    const unresolved = new BlueBubblesSendError({ message: "BlueBubbles send currently requires chat.chatGuid from the inbound event.", httpStatus: null, errorCode: "chat_unresolved", transportInvoked: false })
    const failing = (error: unknown) => async () => ({ sendText: async () => { throw error } }) as unknown as BlueBubblesClient
    await expect(sendLetterByBlueBubbles({ agent: "slugger", handle: "a@x.io", text: "t" }, "/root", failing(unresolved))).rejects.toEqual(expect.objectContaining({
      message: "no chat with a@x.io exists yet; the person messages the agent once from that handle first", errorCode: "chat_unresolved", transportInvoked: false,
    }))
    const other = new BlueBubblesSendError({ message: "bad reply", httpStatus: 200, errorCode: "malformed_response", transportInvoked: true })
    await expect(sendLetterByBlueBubbles({ agent: "slugger", handle: "a@x.io", text: "t" }, "/root", failing(other))).rejects.toBe(other)
  })

  it("builds the agent's own client from its machine settings", async () => {
    credentials.read.mockReturnValue(configured)
    const client = await blueBubblesClientForAgent("slugger", path.join(os.tmpdir(), "no-such-agent.ouro"))
    expect(typeof client.sendText).toBe("function")
    credentials.read.mockReturnValue(ok({}))
    await expect(sendLetterByBlueBubbles({ agent: "slugger", handle: "a@x.io", text: "t" }, "/root")).rejects.toThrow(/serverUrl is required/)
  })
})
