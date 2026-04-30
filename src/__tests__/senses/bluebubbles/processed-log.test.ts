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

describe("BlueBubbles processed log", () => {
  let tmpRoot = ""
  const originalHome = process.env.HOME

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "bb-processed-log-"))
    process.env.HOME = tmpRoot
  })

  afterEach(() => {
    vi.doUnmock("node:fs")
    vi.doUnmock("../../../nerves/runtime")
    vi.resetModules()
    process.env.HOME = originalHome
    vi.restoreAllMocks()
    fs.rmSync(tmpRoot, { recursive: true, force: true })
  })

  it("records handled messages to bundle state and skips blank message ids during dedupe checks", async () => {
    const {
      getBlueBubblesProcessedLogPath,
      hasProcessedBlueBubblesMessage,
      recordProcessedBlueBubblesMessage,
    } = await import("../../../senses/bluebubbles/processed-log")

    const logPath = recordProcessedBlueBubblesMessage("slugger", messageEvent, "webhook", "turn-complete")

    expect(logPath).toBe(
      path.join(
        tmpRoot,
        "AgentBundles",
        "slugger.ouro",
        "state",
        "senses",
        "bluebubbles",
        "processed",
        "chat_any;-;ari@mendelow.me.ndjson",
      ),
    )
    expect(getBlueBubblesProcessedLogPath("slugger", messageEvent.chat.sessionKey)).toBe(logPath)
    expect(hasProcessedBlueBubblesMessage("slugger", messageEvent.chat.sessionKey, "msg-1")).toBe(true)
    expect(hasProcessedBlueBubblesMessage("slugger", messageEvent.chat.sessionKey, "   ")).toBe(false)
  })

  it("dedupes repeated writes for the same sessionKey/messageGuid pair", async () => {
    const {
      getBlueBubblesProcessedLogPath,
      hasProcessedBlueBubblesMessage,
      recordProcessedBlueBubblesMessage,
    } = await import("../../../senses/bluebubbles/processed-log")

    const logPath = getBlueBubblesProcessedLogPath("slugger", messageEvent.chat.sessionKey)
    expect(recordProcessedBlueBubblesMessage("slugger", messageEvent, "webhook", "turn-complete")).toBe(logPath)
    expect(recordProcessedBlueBubblesMessage("slugger", messageEvent, "mutation-recovery", "session-bootstrap")).toBe(logPath)

    const lines = fs.readFileSync(logPath, "utf-8").trim().split("\n")
    expect(lines).toHaveLength(1)
    expect(JSON.parse(lines[0] ?? "{}")).toEqual(
      expect.objectContaining({
        messageGuid: "msg-1",
        source: "webhook",
        outcome: "turn-complete",
      }),
    )
    expect(hasProcessedBlueBubblesMessage("slugger", messageEvent.chat.sessionKey, "msg-1")).toBe(true)
  })

  it("does not treat legacy recovery-timeout records as processed", async () => {
    const {
      getBlueBubblesProcessedLogPath,
      hasProcessedBlueBubblesMessage,
      hasProcessedBlueBubblesMessageGuid,
      recordProcessedBlueBubblesMessage,
    } = await import("../../../senses/bluebubbles/processed-log")

    const logPath = getBlueBubblesProcessedLogPath("slugger", messageEvent.chat.sessionKey)
    expect(recordProcessedBlueBubblesMessage("slugger", messageEvent, "mutation-recovery", "recovery-timeout")).toBe(logPath)
    expect(hasProcessedBlueBubblesMessage("slugger", messageEvent.chat.sessionKey, "msg-1")).toBe(false)
    expect(hasProcessedBlueBubblesMessageGuid("slugger", "msg-1")).toBe(false)

    expect(recordProcessedBlueBubblesMessage("slugger", messageEvent, "webhook", "turn-complete")).toBe(logPath)
    const lines = fs.readFileSync(logPath, "utf-8").trim().split("\n")
    expect(lines).toHaveLength(2)
    expect(JSON.parse(lines[1] ?? "{}")).toEqual(
      expect.objectContaining({
        messageGuid: "msg-1",
        source: "webhook",
        outcome: "turn-complete",
      }),
    )
    expect(hasProcessedBlueBubblesMessage("slugger", messageEvent.chat.sessionKey, "msg-1")).toBe(true)
    expect(hasProcessedBlueBubblesMessageGuid("slugger", "msg-1")).toBe(true)
  })

  it("treats malformed logs as empty and returns the target path when writes fail", async () => {
    const {
      getBlueBubblesProcessedLogPath,
      hasProcessedBlueBubblesMessage,
      recordProcessedBlueBubblesMessage,
    } = await import("../../../senses/bluebubbles/processed-log")

    const logPath = getBlueBubblesProcessedLogPath("slugger", messageEvent.chat.sessionKey)
    fs.mkdirSync(path.dirname(logPath), { recursive: true })
    fs.writeFileSync(logPath, "{bad json}\n", "utf-8")

    expect(hasProcessedBlueBubblesMessage("slugger", messageEvent.chat.sessionKey, "msg-1")).toBe(false)

    fs.rmSync(logPath, { force: true })
    const processedDir = path.dirname(logPath)
    fs.rmSync(processedDir, { recursive: true, force: true })
    fs.mkdirSync(path.dirname(processedDir), { recursive: true })
    fs.writeFileSync(processedDir, "blocked", "utf-8")

    expect(recordProcessedBlueBubblesMessage("slugger", messageEvent, "mutation-recovery", "turn-complete")).toBe(logPath)
  })

  it("stringifies non-Error write failures in nerves metadata", async () => {
    vi.doMock("node:fs", async () => {
      const actual = await vi.importActual<typeof import("node:fs")>("node:fs")
      return {
        ...actual,
        appendFileSync: vi.fn(() => {
          throw "disk full"
        }),
      }
    })
    vi.doMock("../../../nerves/runtime", () => ({
      emitNervesEvent: vi.fn(),
    }))

    const runtime = await import("../../../nerves/runtime")
    const emitNervesEvent = vi.mocked(runtime.emitNervesEvent)
    const { recordProcessedBlueBubblesMessage } = await import("../../../senses/bluebubbles/processed-log")

    recordProcessedBlueBubblesMessage("slugger", messageEvent, "webhook", "trust-gated")

    expect(emitNervesEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "senses.bluebubbles_processed_log_error",
        meta: expect.objectContaining({
          messageGuid: "msg-1",
          reason: "disk full",
        }),
      }),
    )
  })
})
