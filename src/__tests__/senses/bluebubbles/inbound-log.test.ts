import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

const messageEvent = {
  kind: "message" as const,
  eventType: "new-message",
  messageGuid: "msg-1",
  timestamp: Date.parse("2026-03-11T18:14:00.000Z"),
  fromMe: false,
  sender: {
    provider: "imessage-handle" as const,
    externalId: "ari@mendelow.me",
    rawId: "ari@mendelow.me",
    displayName: "ari@mendelow.me",
  },
  chat: {
    chatGuid: "any;-;ari@mendelow.me",
    chatIdentifier: "ari@mendelow.me",
    isGroup: false,
    sessionKey: "chat:any;-;ari@mendelow.me",
    sendTarget: { kind: "chat_guid" as const, value: "any;-;ari@mendelow.me" },
    participantHandles: [],
  },
  text: "you there?",
  textForAgent: "you there?",
  attachments: [],
  hasPayloadData: false,
  requiresRepair: false,
}

describe("BlueBubbles inbound log", () => {
  let tmpRoot = ""
  const originalHome = process.env.HOME

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "bb-inbound-log-"))
    process.env.HOME = tmpRoot
  })

  afterEach(() => {
    process.env.HOME = originalHome
    vi.restoreAllMocks()
    fs.rmSync(tmpRoot, { recursive: true, force: true })
  })

  it("records inbound messages to bundle state and skips blank message ids during dedupe checks", async () => {
    const {
      getBlueBubblesInboundLogPath,
      hasRecordedBlueBubblesInbound,
      recordBlueBubblesInbound,
    } = await import("../../../senses/bluebubbles/inbound-log")

    const logPath = recordBlueBubblesInbound("slugger", messageEvent, "webhook")

    expect(logPath).toBe(
      path.join(
        tmpRoot,
        "AgentBundles",
        "slugger.ouro",
        "state",
        "senses",
        "bluebubbles",
        "inbound",
        "chat_any;-;ari@mendelow.me.ndjson",
      ),
    )
    expect(getBlueBubblesInboundLogPath("slugger", messageEvent.chat.sessionKey)).toBe(logPath)
    expect(hasRecordedBlueBubblesInbound("slugger", messageEvent.chat.sessionKey, "msg-1")).toBe(true)
    expect(hasRecordedBlueBubblesInbound("slugger", messageEvent.chat.sessionKey, "   ")).toBe(false)
  })

  it("records null chat identity fields when only the session key is available", async () => {
    const { getBlueBubblesInboundLogPath, recordBlueBubblesInbound } = await import("../../../senses/bluebubbles/inbound-log")

    const eventWithoutChatIdentity = {
      ...messageEvent,
      chat: {
        ...messageEvent.chat,
        chatGuid: undefined,
        chatIdentifier: undefined,
        sessionKey: "chat_identifier:group-only",
      },
    }

    const logPath = recordBlueBubblesInbound("slugger", eventWithoutChatIdentity, "recovery-bootstrap")
    const entry = JSON.parse(fs.readFileSync(logPath, "utf-8").trim())

    expect(logPath).toBe(getBlueBubblesInboundLogPath("slugger", "chat_identifier:group-only"))
    expect(entry).toEqual(
      expect.objectContaining({
        chatGuid: null,
        chatIdentifier: null,
        sessionKey: "chat_identifier:group-only",
      }),
    )
  })

  it("dedupes repeated writes for the same sessionKey/messageGuid pair", async () => {
    const {
      getBlueBubblesInboundLogPath,
      hasRecordedBlueBubblesInbound,
      recordBlueBubblesInbound,
    } = await import("../../../senses/bluebubbles/inbound-log")

    const logPath = getBlueBubblesInboundLogPath("slugger", messageEvent.chat.sessionKey)
    expect(recordBlueBubblesInbound("slugger", messageEvent, "webhook")).toBe(logPath)
    expect(recordBlueBubblesInbound("slugger", messageEvent, "mutation-recovery")).toBe(logPath)

    const lines = fs.readFileSync(logPath, "utf-8").trim().split("\n")
    expect(lines).toHaveLength(1)
    expect(JSON.parse(lines[0] ?? "{}")).toEqual(
      expect.objectContaining({
        messageGuid: "msg-1",
        source: "webhook",
      }),
    )
    expect(hasRecordedBlueBubblesInbound("slugger", messageEvent.chat.sessionKey, "msg-1")).toBe(true)
  })

  it("treats malformed logs as empty and returns the target path when writes fail", async () => {
    const {
      getBlueBubblesInboundLogPath,
      hasRecordedBlueBubblesInbound,
      recordBlueBubblesInbound,
    } = await import("../../../senses/bluebubbles/inbound-log")

    const logPath = getBlueBubblesInboundLogPath("slugger", messageEvent.chat.sessionKey)
    fs.mkdirSync(path.dirname(logPath), { recursive: true })
    fs.writeFileSync(logPath, "{bad json}\n", "utf-8")

    expect(hasRecordedBlueBubblesInbound("slugger", messageEvent.chat.sessionKey, "msg-1")).toBe(false)

    fs.rmSync(logPath, { force: true })
    const inboundDir = path.dirname(logPath)
    fs.rmSync(inboundDir, { recursive: true, force: true })
    fs.mkdirSync(path.dirname(inboundDir), { recursive: true })
    fs.writeFileSync(inboundDir, "blocked", "utf-8")

    expect(recordBlueBubblesInbound("slugger", messageEvent, "mutation-recovery")).toBe(logPath)
  })

  it("emits senses.bluebubbles_inbound_logged at warn level so it survives the BB default log level", async () => {
    vi.resetModules()
    const nervesMock = vi.fn()
    vi.doMock("../../../nerves/runtime", () => ({ emitNervesEvent: nervesMock }))
    const { recordBlueBubblesInbound } = await import("../../../senses/bluebubbles/inbound-log")
    recordBlueBubblesInbound("slugger", messageEvent, "webhook")
    const logged = nervesMock.mock.calls.find(
      (c) => c[0]?.event === "senses.bluebubbles_inbound_logged",
    )
    expect(logged).toBeDefined()
    expect(logged?.[0].level).toBe("warn")
    vi.doUnmock("../../../nerves/runtime")
  })

  it("stringifies non-Error write failures when inbound sidecar serialization explodes", async () => {
    const { getBlueBubblesInboundLogPath, recordBlueBubblesInbound } = await import("../../../senses/bluebubbles/inbound-log")

    const badEvent = {
      ...messageEvent,
      chat: { ...messageEvent.chat },
    }
    Object.defineProperty(badEvent.chat, "chatGuid", {
      get() {
        throw "string-sidecar-failure"
      },
      configurable: true,
    })

    expect(recordBlueBubblesInbound("slugger", badEvent, "webhook")).toBe(
      getBlueBubblesInboundLogPath("slugger", messageEvent.chat.sessionKey),
    )
  })
})
