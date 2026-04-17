import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("../../../senses/bluebubbles/replay", () => ({
  replayBlueBubblesMessage: vi.fn(),
  formatBlueBubblesReplayText: vi.fn(),
}))

import {
  parseOuroCommand,
  runOuroCli,
  type OuroCliDeps,
} from "../../../heart/daemon/daemon-cli"
import {
  replayBlueBubblesMessage,
  formatBlueBubblesReplayText,
} from "../../../senses/bluebubbles/replay"

function createMockDeps(overrides: Partial<OuroCliDeps> = {}): OuroCliDeps {
  return {
    socketPath: "/tmp/ouro-test.sock",
    sendCommand: vi.fn().mockResolvedValue({ ok: true, summary: "ok" }),
    startDaemonProcess: vi.fn().mockResolvedValue({ pid: 12345 }),
    writeStdout: vi.fn(),
    checkSocketAlive: vi.fn().mockResolvedValue(true),
    cleanupStaleSocket: vi.fn(),
    fallbackPendingMessage: vi.fn().mockReturnValue("pending"),
    ...overrides,
  }
}

describe("ouro bluebubbles replay CLI parsing", () => {
  it("parses replay arguments with defaults", () => {
    expect(parseOuroCommand([
      "bluebubbles",
      "replay",
      "--agent",
      "slugger",
      "--message-guid",
      "message-guid",
    ])).toEqual({
      kind: "bluebubbles.replay",
      agent: "slugger",
      messageGuid: "message-guid",
      eventType: "new-message",
    })
  })

  it("parses replay overrides for updated-message and json output", () => {
    expect(parseOuroCommand([
      "bluebubbles",
      "replay",
      "--agent",
      "slugger",
      "--message-guid",
      "message-guid",
      "--event-type",
      "updated-message",
      "--json",
    ])).toEqual({
      kind: "bluebubbles.replay",
      agent: "slugger",
      messageGuid: "message-guid",
      eventType: "updated-message",
      json: true,
    })
  })

  it("ignores unknown trailing replay arguments after parsing known flags", () => {
    expect(parseOuroCommand([
      "bluebubbles",
      "replay",
      "--agent",
      "slugger",
      "--message-guid",
      "message-guid",
      "--mystery-flag",
    ])).toEqual({
      kind: "bluebubbles.replay",
      agent: "slugger",
      messageGuid: "message-guid",
      eventType: "new-message",
    })
  })

  it("rejects malformed replay arguments", () => {
    expect(() => parseOuroCommand(["bluebubbles", "replay", "--agent", "slugger"])).toThrow("message-guid")
    expect(parseOuroCommand(["bluebubbles", "replay", "--message-guid", "guid"])).toEqual({
      kind: "bluebubbles.replay",
      messageGuid: "guid",
      eventType: "new-message",
    })
    expect(() => parseOuroCommand([
      "bluebubbles",
      "replay",
      "--agent",
      "slugger",
      "--message-guid",
      "guid",
      "--event-type",
      "not-real",
    ])).toThrow("new-message")
  })

  it("rejects unknown bluebubbles subcommands with usage guidance", () => {
    expect(() => parseOuroCommand(["bluebubbles", "inspect"])).toThrow("Usage")
  })
})

describe("ouro bluebubbles replay CLI execution", () => {
  beforeEach(() => {
    vi.mocked(replayBlueBubblesMessage).mockReset()
    vi.mocked(formatBlueBubblesReplayText).mockReset()
  })

  it("renders formatted replay output in text mode", async () => {
    vi.mocked(replayBlueBubblesMessage).mockResolvedValue({
      probe: {
        agentName: "slugger",
        messageGuid: "message-guid",
        eventType: "new-message",
      },
      event: {
        kind: "message",
        eventType: "new-message",
        messageGuid: "message-guid",
        timestamp: Date.parse("2026-04-08T19:05:00.000Z"),
        fromMe: false,
        sender: {
          provider: "imessage-handle",
          externalId: "ari@mendelow.me",
          rawId: "ari@mendelow.me",
          displayName: "ari@mendelow.me",
        },
        chat: {
          chatGuid: "any;-;ari@mendelow.me",
          chatIdentifier: "ari@mendelow.me",
          isGroup: false,
          sessionKey: "chat:any;-;ari@mendelow.me",
          sendTarget: { kind: "chat_guid", value: "any;-;ari@mendelow.me" },
          participantHandles: [],
        },
        text: "hello",
        textForAgent: "hello",
        attachments: [],
        hasPayloadData: false,
        requiresRepair: false,
      },
      attachmentIds: [],
      attachmentBlock: "",
    } as any)
    vi.mocked(formatBlueBubblesReplayText).mockReturnValue("formatted replay")
    const deps = createMockDeps()

    const result = await runOuroCli([
      "bluebubbles",
      "replay",
      "--agent",
      "slugger",
      "--message-guid",
      "message-guid",
    ], deps)

    expect(replayBlueBubblesMessage).toHaveBeenCalledWith({
      agentName: "slugger",
      messageGuid: "message-guid",
      eventType: "new-message",
    })
    expect(formatBlueBubblesReplayText).toHaveBeenCalledTimes(1)
    expect(result).toBe("formatted replay")
    expect(deps.writeStdout).toHaveBeenCalledWith("formatted replay")
  })

  it("resolves the only discovered agent for replay when --agent is omitted", async () => {
    vi.mocked(replayBlueBubblesMessage).mockResolvedValue({
      probe: {
        agentName: "slugger",
        messageGuid: "message-guid",
        eventType: "new-message",
      },
      event: {
        kind: "message",
        eventType: "new-message",
        messageGuid: "message-guid",
        timestamp: Date.parse("2026-04-08T19:05:00.000Z"),
        fromMe: false,
        sender: {
          provider: "imessage-handle",
          externalId: "ari@mendelow.me",
          rawId: "ari@mendelow.me",
          displayName: "ari@mendelow.me",
        },
        chat: {
          chatGuid: "any;-;ari@mendelow.me",
          chatIdentifier: "ari@mendelow.me",
          isGroup: false,
          sessionKey: "chat:any;-;ari@mendelow.me",
          sendTarget: { kind: "chat_guid", value: "any;-;ari@mendelow.me" },
          participantHandles: [],
        },
        text: "hello",
        textForAgent: "hello",
        attachments: [],
        hasPayloadData: false,
        requiresRepair: false,
      },
      attachmentIds: [],
      attachmentBlock: "",
    } as any)
    vi.mocked(formatBlueBubblesReplayText).mockReturnValue("formatted replay")
    const deps = createMockDeps({
      listDiscoveredAgents: vi.fn(() => ["slugger"]),
    })

    const result = await runOuroCli([
      "bluebubbles",
      "replay",
      "--message-guid",
      "message-guid",
    ], deps)

    expect(replayBlueBubblesMessage).toHaveBeenCalledWith({
      agentName: "slugger",
      messageGuid: "message-guid",
      eventType: "new-message",
    })
    expect(result).toBe("formatted replay")
  })

  it("prints structured json when requested", async () => {
    vi.mocked(replayBlueBubblesMessage).mockResolvedValue({
      probe: {
        agentName: "slugger",
        messageGuid: "message-guid",
        eventType: "updated-message",
      },
      event: {
        kind: "mutation",
        eventType: "updated-message",
        mutationType: "read",
        messageGuid: "message-guid",
        timestamp: Date.parse("2026-04-08T19:05:00.000Z"),
        fromMe: false,
        sender: {
          provider: "imessage-handle",
          externalId: "ari@mendelow.me",
          rawId: "ari@mendelow.me",
          displayName: "ari@mendelow.me",
        },
        chat: {
          chatGuid: "any;-;ari@mendelow.me",
          chatIdentifier: "ari@mendelow.me",
          isGroup: false,
          sessionKey: "chat:any;-;ari@mendelow.me",
          sendTarget: { kind: "chat_guid", value: "any;-;ari@mendelow.me" },
          participantHandles: [],
        },
        shouldNotifyAgent: false,
        textForAgent: "message marked as read",
        requiresRepair: false,
      },
      attachmentIds: [],
      attachmentBlock: "",
      hint: "rerun with --event-type new-message",
    } as any)
    const deps = createMockDeps()

    const result = await runOuroCli([
      "bluebubbles",
      "replay",
      "--agent",
      "slugger",
      "--message-guid",
      "message-guid",
      "--event-type",
      "updated-message",
      "--json",
    ], deps)

    expect(formatBlueBubblesReplayText).not.toHaveBeenCalled()
    expect(result).toContain("\"eventType\": \"updated-message\"")
    expect(result).toContain("\"hint\": \"rerun with --event-type new-message\"")
  })
})
