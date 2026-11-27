import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"

const mockEmitNervesEvent = vi.hoisted(() => vi.fn())

vi.mock("../../../nerves/runtime", () => ({
  emitNervesEvent: (...args: any[]) => mockEmitNervesEvent(...args),
}))

vi.mock("../../../heart/identity", () => ({
  getAgentName: vi.fn(() => "testagent"),
  getAgentRoot: vi.fn(() => "/nonexistent/agent-root"),
}))

// A mid-turn iMessage gets its own outbound record and is noted on disk before it goes out, so a turn cut off by a
// crash is never replayed into sending it again.

const roots: string[] = []
function agentRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bb-mid-turn-"))
  roots.push(root)
  return root
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
  mockEmitNervesEvent.mockReset()
})

const chat = {
  chatGuid: "any;-;friend@example.test",
  chatIdentifier: "friend@example.test",
  sendTarget: "chat",
  sessionKey: "chat:any;-;friend@example.test",
  isGroup: false,
  participantHandles: ["friend@example.test"],
} as any

async function setup(options: { sendText?: (...args: any[]) => Promise<any>; noteSend?: (spoke: any) => void; durable?: boolean; replyTo?: string; activity?: boolean; group?: boolean } = {}) {
  const { createBlueBubblesCallbacks } = await import("../../../senses/bluebubbles")
  const { readBlueBubblesOutboundRecord } = await import("../../../senses/bluebubbles/outbound-state")
  const root = agentRoot()
  const order: string[] = []
  const sendText = vi.fn(options.sendText ?? (async () => ({ messageGuid: "speak-guid" })))
  const client = {
    sendText: (...args: any[]) => { order.push("send"); return sendText(...args) },
    setTyping: vi.fn(async () => {}),
    markChatRead: vi.fn(async () => {}),
  }
  const noted: any[] = []
  const replyTarget = { getReplyToMessageGuid: vi.fn(() => options.replyTo), setSelection: vi.fn(() => "ok") }
  const callbacks = createBlueBubblesCallbacks(client as any, options.group ? { ...chat, isGroup: true } : chat, replyTarget as any, options.group === true, () => order.push("visible"), {
    enableActivitySignals: options.activity === true,
    ...(options.durable === false ? {} : {
      durableOutbound: {
        agentRoot: root,
        idempotencyKey: "bluebubbles-inbound-reply:capture-1",
        attachment: { serverUrl: "http://bluebubbles.local", accountId: "default" },
        speakIdempotencyKeyPrefix: "bluebubbles-inbound-reply:capture-1:turn-1",
      },
    }),
    noteSend: (spoke) => {
      order.push("note")
      ;(options.noteSend ?? ((value) => noted.push(value)))(spoke)
    },
  })
  return { callbacks, client, sendText, noted, order, read: (recordId: string) => readBlueBubblesOutboundRecord(root, recordId) }
}

describe("BlueBubbles mid-turn sends", () => {
  it("brings the typing dots back after a mid-turn message in a one-to-one chat, since the agent is still working", async () => {
    const { callbacks, client } = await setup({ activity: true })
    callbacks.onModelStart()
    callbacks.onTextChunk("pulling up your imbox now")
    await callbacks.flushNow!()
    await callbacks.flush()

    const typing = client.setTyping.mock.calls.map((args: any[]) => args[1])
    // on at the start, back on after the ack lands, off with the final reply
    expect(typing).toEqual([true, true, false])
  })

  it("leaves typing alone after a mid-turn message in a group chat", async () => {
    const { callbacks, client } = await setup({ activity: true, group: true })
    callbacks.onTextChunk("on it")
    await callbacks.flushNow!()
    callbacks.onTextChunk("done")
    await callbacks.flush()

    expect(client.setTyping.mock.calls.map((args: any[]) => args[1])).toEqual([true, false])
  })

  it("notes a mid-turn message with its own outbound record before sending it, then marks it accepted", async () => {
    const { callbacks, noted, order, read, sendText } = await setup()
    callbacks.onTextChunk("checking on that now")
    await callbacks.flushNow!()

    expect(order).toEqual(["note", "visible", "send"])
    expect(sendText).toHaveBeenCalledWith(expect.objectContaining({ tempGuid: expect.stringMatching(/^ouro-speak-[0-9a-f]{32}$/) }))
    expect(noted).toEqual([expect.objectContaining({ kind: "speak", outboundRecordId: expect.stringMatching(/^bbout_[0-9a-f]{32}$/), textLength: 20 })])
    expect(read(noted[0].outboundRecordId)).toMatchObject({ status: "accepted", messageGuid: "speak-guid", textLength: 20, contentStored: false })

    // A second message in the same turn gets a record of its own.
    callbacks.onTextChunk("found it, one moment")
    await callbacks.flushNow!()
    expect(noted).toHaveLength(2)
    expect(noted[1].outboundRecordId).not.toBe(noted[0].outboundRecordId)
  })

  it("keeps the threaded reply target on a mid-turn message's record", async () => {
    const { callbacks, noted, read, sendText } = await setup({ replyTo: "inbound-guid-1" })
    callbacks.onTextChunk("checking on that now")
    await callbacks.flushNow!()
    expect(sendText).toHaveBeenCalledWith(expect.objectContaining({ replyToMessageGuid: "inbound-guid-1" }))
    expect(read(noted[0].outboundRecordId)?.replyToMessageGuidHash).toEqual(expect.any(String))
  })

  it("marks the record accepted without a message id when the transport returns none", async () => {
    const { callbacks, noted, read } = await setup({ sendText: async () => undefined })
    callbacks.onTextChunk("checking on that now")
    await callbacks.flushNow!()
    const record = read(noted[0].outboundRecordId)
    expect(record?.status).toBe("accepted")
    expect(record?.messageGuid).toBeUndefined()
  })

  it("marks the record failed and fails the speak call when the transport throws", async () => {
    const { callbacks, noted, read } = await setup({ sendText: async () => { throw new Error("transport down") } })
    callbacks.onTextChunk("checking on that now")
    await expect(callbacks.flushNow!()).rejects.toThrow("transport down")
    expect(read(noted[0].outboundRecordId)).toMatchObject({ status: "failed", failureReason: "transport down", failedAttempts: 1 })
  })

  it("records a thrown non-error as the failure reason", async () => {
    const { callbacks, noted, read } = await setup({ sendText: async () => { throw "socket closed" } })
    callbacks.onTextChunk("checking on that now")
    await expect(callbacks.flushNow!()).rejects.toBe("socket closed")
    expect(read(noted[0].outboundRecordId)?.failureReason).toBe("socket closed")
  })

  it("sends nothing when the send cannot be noted first", async () => {
    const { callbacks, sendText } = await setup({ noteSend: () => { throw new Error("disk full") } })
    callbacks.onTextChunk("checking on that now")
    await expect(callbacks.flushNow!()).rejects.toThrow("disk full")
    expect(sendText).not.toHaveBeenCalled()
  })

  it("notes a mid-turn message without an outbound record when the turn keeps none", async () => {
    const { callbacks, noted, sendText } = await setup({ durable: false })
    callbacks.onTextChunk("checking on that now")
    await callbacks.flushNow!()
    expect(noted).toEqual([expect.objectContaining({ kind: "speak", outboundRecordId: null })])
    expect(sendText).toHaveBeenCalledTimes(1)
    expect(sendText.mock.calls[0]![0]).not.toHaveProperty("tempGuid")
  })

  it("notes a tool that messages a person just before it runs, and only such tools", async () => {
    const { callbacks, noted } = await setup()
    callbacks.onToolStart("send_message", { friendId: "ari", channel: "telegram", content: "the build is out" })
    expect(noted).toEqual([])
    callbacks.onToolDispatch!("send_message")
    callbacks.onToolStart("read_file", { path: "/tmp/a" })
    callbacks.onToolDispatch!("read_file")
    // Refused before its handler: it never dispatches, so nothing was sent.
    callbacks.onToolStart("surface", { content: "ready" })
    expect(noted).toEqual([expect.objectContaining({ kind: "tool:send_message", outboundRecordId: null, textLength: 16 })])
  })

  it("stops a tool that messages a person when its send cannot be noted first", async () => {
    const { callbacks } = await setup({ noteSend: () => { throw new Error("disk full") } })
    callbacks.onToolStart("surface", { content: "ready" })
    expect(() => callbacks.onToolDispatch!("surface")).toThrow("disk full")
  })

  it("marks a mid-turn message's record failed when its send cannot be noted", async () => {
    const { createBlueBubblesCallbacks } = await import("../../../senses/bluebubbles")
    const root = agentRoot()
    const sendText = vi.fn(async () => ({ messageGuid: "never" }))
    let reserved: string | null = null
    const failures: unknown[] = [new Error("disk full"), "no space"]
    for (const failure of failures) {
      const callbacks = createBlueBubblesCallbacks({ sendText, setTyping: vi.fn(async () => {}), markChatRead: vi.fn(async () => {}) } as any, chat, { getReplyToMessageGuid: () => undefined } as any, false, undefined, {
        enableActivitySignals: false,
        durableOutbound: { agentRoot: root, idempotencyKey: "k", attachment: { serverUrl: "http://bluebubbles.local", accountId: "default" }, speakIdempotencyKeyPrefix: `k:turn-${String(failure)}` },
        noteSend: (spoke) => { reserved = spoke.outboundRecordId; throw failure },
      })
      callbacks.onTextChunk("checking on that now")
      await expect(callbacks.flushNow!()).rejects.toBe(failure)
      const { readBlueBubblesOutboundRecord } = await import("../../../senses/bluebubbles/outbound-state")
      expect(readBlueBubblesOutboundRecord(root, reserved!)).toMatchObject({ status: "failed", failureReason: expect.stringMatching(/^not sent: (disk full|no space)$/) })
    }
    expect(sendText).not.toHaveBeenCalled()
  })

  it("does nothing for a person-messaging tool when the turn notes no sends", async () => {
    const { createBlueBubblesCallbacks } = await import("../../../senses/bluebubbles")
    const callbacks = createBlueBubblesCallbacks({ setTyping: vi.fn(async () => {}), markChatRead: vi.fn(async () => {}) } as any, chat, { getReplyToMessageGuid: () => undefined } as any, false, undefined, { enableActivitySignals: false })
    expect(() => callbacks.onToolStart("surface", { content: "ready" })).not.toThrow()
    expect(() => callbacks.onToolDispatch!("surface")).not.toThrow()
  })
})
