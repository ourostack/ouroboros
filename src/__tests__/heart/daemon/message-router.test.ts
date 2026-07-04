import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { afterEach, describe, expect, it } from "vitest"

import { FileMessageRouter, getDaemonMessageRouterDir } from "../../../heart/daemon/message-router"

describe("FileMessageRouter", () => {
  const tempDirs: string[] = []

  afterEach(() => {
    for (const dir of tempDirs) {
      fs.rmSync(dir, { recursive: true, force: true })
    }
    tempDirs.length = 0
  })

  it("defaults to machine-scoped daemon storage without creating a default agent bundle", async () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "message-router-home-"))
    tempDirs.push(homeDir)

    const router = new FileMessageRouter({
      homeDir,
      now: () => "2026-05-25T08:08:09.010Z",
    })

    expect(getDaemonMessageRouterDir(homeDir)).toBe(path.join(homeDir, ".ouro-cli", "daemon", "messages"))
    expect(fs.existsSync(path.join(homeDir, ".ouro-cli", "daemon", "messages"))).toBe(true)
    expect(fs.existsSync(path.join(homeDir, "AgentBundles", "default.ouro"))).toBe(false)

    await router.send({
      from: "slugger",
      to: "ouroboros",
      content: "hello from daemon storage",
    })
    expect(router.pollInbox("ouroboros")).toEqual([
      expect.objectContaining({ content: "hello from daemon storage" }),
    ])
    expect(fs.existsSync(path.join(homeDir, "AgentBundles", "default.ouro"))).toBe(false)
  })

  it("queues messages with default priority and empties inbox after polling", async () => {
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "message-router-"))
    tempDirs.push(baseDir)

    const router = new FileMessageRouter({
      baseDir,
      now: () => "2026-03-07T01:02:03.004Z",
    })

    const queued = await router.send({
      from: "slugger",
      to: "ouroboros",
      content: "hello from coding session",
    })
    expect(queued).toEqual({
      id: "msg-20260307010203004",
      queuedAt: "2026-03-07T01:02:03.004Z",
    })

    const messages = router.pollInbox("ouroboros")
    expect(messages).toEqual([
      {
        id: "msg-20260307010203004",
        from: "slugger",
        to: "ouroboros",
        content: "hello from coding session",
        queuedAt: "2026-03-07T01:02:03.004Z",
        priority: "normal",
      },
    ])

    const inboxPath = path.join(baseDir, "ouroboros-inbox.jsonl")
    expect(fs.readFileSync(inboxPath, "utf-8")).toBe("")
  })

  it("keeps same-millisecond message receipts distinct", async () => {
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "message-router-"))
    tempDirs.push(baseDir)

    const router = new FileMessageRouter({
      baseDir,
      now: () => "2026-03-07T01:02:03.004Z",
    })

    const first = await router.send({
      from: "slugger",
      to: "ouroboros",
      content: "first",
    })
    const second = await router.send({
      from: "slugger",
      to: "ouroboros",
      content: "second",
    })

    expect(first).toEqual({
      id: "msg-20260307010203004",
      queuedAt: "2026-03-07T01:02:03.004Z",
    })
    expect(second).toEqual({
      id: "msg-20260307010203004-2",
      queuedAt: "2026-03-07T01:02:03.004Z",
    })
    expect(router.pollInbox("ouroboros").map((message) => message.id)).toEqual([
      "msg-20260307010203004",
      "msg-20260307010203004-2",
    ])
  })

  it("caps storm backlogs to the newest queued messages while keeping receipts distinct", async () => {
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "message-router-"))
    tempDirs.push(baseDir)

    const router = new FileMessageRouter({
      baseDir,
      now: () => "2026-03-07T01:02:03.004Z",
      maxMessagesPerInbox: 3,
    })

    for (let index = 1; index <= 5; index += 1) {
      await router.send({
        from: "claude-code:storm-session",
        to: "slugger",
        content: `post-tool-use ${index}`,
      })
    }

    expect(router.pollInbox("slugger")).toEqual([
      expect.objectContaining({
        id: "msg-20260307010203004-3",
        content: "post-tool-use 3",
      }),
      expect.objectContaining({
        id: "msg-20260307010203004-4",
        content: "post-tool-use 4",
      }),
      expect.objectContaining({
        id: "msg-20260307010203004-5",
        content: "post-tool-use 5",
      }),
    ])
  })

  it("returns no messages when the inbox file does not exist and preserves explicit priority", async () => {
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "message-router-"))
    tempDirs.push(baseDir)

    const router = new FileMessageRouter({
      baseDir,
      now: () => "2026-03-07T10:20:30.400Z",
    })

    expect(router.pollInbox("missing-agent")).toEqual([])

    await router.send({
      from: "ouroboros",
      to: "slugger",
      content: "this is urgent",
      priority: "high",
    })
    expect(router.pollInbox("slugger")).toEqual([
      expect.objectContaining({
        from: "ouroboros",
        to: "slugger",
        content: "this is urgent",
        priority: "high",
      }),
    ])
  })

  it("skips corrupt lines, returns valid messages, and preserves unparsed lines in inbox", async () => {
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "message-router-"))
    tempDirs.push(baseDir)

    const router = new FileMessageRouter({
      baseDir,
      now: () => "2026-03-10T00:00:00.000Z",
    })

    // Write a mix of valid and corrupt lines directly to the inbox file.
    const inboxPath = path.join(baseDir, "agent-inbox.jsonl")
    const validMsg = JSON.stringify({ id: "msg-1", from: "a", to: "agent", content: "ok", queuedAt: "t", priority: "normal" })
    fs.writeFileSync(inboxPath, `${validMsg}\n{corrupt\n`, "utf-8")

    const messages = router.pollInbox("agent")
    expect(messages).toHaveLength(1)
    expect(messages[0].content).toBe("ok")

    // The corrupt line should still be in the inbox for inspection.
    expect(fs.readFileSync(inboxPath, "utf-8")).toContain("{corrupt")
  })

  it("does not drop corrupt inbox lines when trimming storm backlogs", async () => {
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "message-router-"))
    tempDirs.push(baseDir)

    const router = new FileMessageRouter({
      baseDir,
      now: () => "2026-03-10T00:00:00.000Z",
      maxMessagesPerInbox: 2,
    })
    const inboxPath = path.join(baseDir, "agent-inbox.jsonl")
    fs.writeFileSync(inboxPath, "{corrupt\n", "utf-8")

    for (let index = 1; index <= 3; index += 1) {
      await router.send({
        from: "storm",
        to: "agent",
        content: `valid ${index}`,
      })
    }

    expect(router.pollInbox("agent")).toEqual([
      expect.objectContaining({ content: "valid 2" }),
      expect.objectContaining({ content: "valid 3" }),
    ])
    expect(fs.readFileSync(inboxPath, "utf-8")).toContain("{corrupt")
  })
})
