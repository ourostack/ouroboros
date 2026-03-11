import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { afterEach, describe, expect, it } from "vitest"

import { FileMessageRouter } from "../../../heart/daemon/message-router"

describe("FileMessageRouter", () => {
  const tempDirs: string[] = []

  afterEach(() => {
    for (const dir of tempDirs) {
      fs.rmSync(dir, { recursive: true, force: true })
    }
    tempDirs.length = 0
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
})
