import { afterEach, beforeEach, describe, expect, it } from "vitest"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

describe("BlueBubbles mutation log", () => {
  let tmpRoot = ""
  const originalHome = process.env.HOME

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "bb-mutation-log-"))
    process.env.HOME = tmpRoot
  })

  afterEach(() => {
    process.env.HOME = originalHome
    fs.rmSync(tmpRoot, { recursive: true, force: true })
  })

  it("appends durable mutation records under agentstate without touching the session prompt", async () => {
    const { getBlueBubblesMutationLogPath, recordBlueBubblesMutation } = await import("../../senses/bluebubbles-mutation-log")

    const pathToLog = getBlueBubblesMutationLogPath("slugger", "chat:any;+;group/id:thread/reply")
    expect(pathToLog).toBe(
      path.join(
        tmpRoot,
        "AgentBundles",
        "slugger.ouro",
        "state",
        "senses",
        "bluebubbles",
        "mutations",
        "chat_any;+;group_id_thread_reply.ndjson",
      ),
    )

    recordBlueBubblesMutation("slugger", {
      kind: "mutation",
      eventType: "updated-message",
      mutationType: "read",
      messageGuid: "msg-1",
      timestamp: 1,
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
        sessionKey: "chat:any;+;group/id:thread/reply",
        sendTarget: { kind: "chat_guid", value: "any;-;ari@mendelow.me" },
      },
      shouldNotifyAgent: false,
      textForAgent: "message marked as read",
      requiresRepair: false,
    })

    recordBlueBubblesMutation("slugger", {
      kind: "mutation",
      eventType: "updated-message",
      mutationType: "edit",
      messageGuid: "msg-2",
      timestamp: 2,
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
        sessionKey: "chat:any;+;group/id:thread/reply",
        sendTarget: { kind: "chat_guid", value: "any;-;ari@mendelow.me" },
      },
      shouldNotifyAgent: true,
      textForAgent: "edited message: fixed text",
      requiresRepair: false,
    })

    const lines = fs.readFileSync(pathToLog, "utf-8").trim().split("\n")
    expect(lines).toHaveLength(2)
    expect(JSON.parse(lines[0] ?? "")).toEqual(
      expect.objectContaining({
        mutationType: "read",
        shouldNotifyAgent: false,
        messageGuid: "msg-1",
      }),
    )
    expect(JSON.parse(lines[1] ?? "")).toEqual(
      expect.objectContaining({
        mutationType: "edit",
        shouldNotifyAgent: true,
        messageGuid: "msg-2",
      }),
    )
  })

  it("records null chat identity fields when BlueBubbles only gives a session key", async () => {
    const { getBlueBubblesMutationLogPath, recordBlueBubblesMutation } = await import("../../senses/bluebubbles-mutation-log")

    recordBlueBubblesMutation("slugger", {
      kind: "mutation",
      eventType: "updated-message",
      mutationType: "delivery",
      messageGuid: "msg-3",
      timestamp: 3,
      fromMe: false,
      sender: {
        provider: "imessage-handle",
        externalId: "ari@mendelow.me",
        rawId: "ari@mendelow.me",
        displayName: "ari@mendelow.me",
      },
      chat: {
        isGroup: true,
        sessionKey: "chat_identifier:group-only",
        sendTarget: { kind: "chat_identifier", value: "group-only" },
      },
      shouldNotifyAgent: false,
      textForAgent: "message marked as delivered",
      requiresRepair: false,
    })

    const pathToLog = getBlueBubblesMutationLogPath("slugger", "chat_identifier:group-only")
    const entry = JSON.parse(fs.readFileSync(pathToLog, "utf-8").trim())
    expect(entry).toEqual(
      expect.objectContaining({
        chatGuid: null,
        chatIdentifier: null,
        mutationType: "delivery",
      }),
    )
  })
})
