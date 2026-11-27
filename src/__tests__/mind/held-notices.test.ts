import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"

describe("held routine notices", () => {
  let root: string

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "held-notices-"))
    vi.resetModules()
    vi.doMock("../../heart/identity", () => ({ getAgentRoot: () => root }))
  })

  afterEach(() => {
    vi.doUnmock("../../heart/identity")
    fs.rmSync(root, { recursive: true, force: true })
  })

  it("keeps a notice with a typed held disposition, once per text", async () => {
    const { holdNoticeForReturn, getHeldNoticeDir } = await import("../../mind/pending")
    holdNoticeForReturn("agent", "friend-1", "nightly run finished")
    holdNoticeForReturn("agent", "friend-1", "nightly run finished")

    const files = fs.readdirSync(getHeldNoticeDir("agent", "friend-1"))
    expect(files).toHaveLength(1)
    const stored = JSON.parse(fs.readFileSync(path.join(getHeldNoticeDir("agent", "friend-1"), files[0]!), "utf-8"))
    expect(stored).toMatchObject({ content: "nightly run finished", disposition: "held_notice" })
  })

  it("keeps held notices until the summary turn settles them, and never replays them as deferred returns", async () => {
    const { holdNoticeForReturn, claimHeldNotices, drainDeferredReturns } = await import("../../mind/pending")
    holdNoticeForReturn("agent", "friend-1", "notice one")
    holdNoticeForReturn("agent", "friend-1", "notice two")

    expect(drainDeferredReturns("agent", "friend-1")).toEqual([])

    const failed = claimHeldNotices("agent", "friend-1")
    expect(failed.messages.map((m) => m.content).sort()).toEqual(["notice one", "notice two"])
    failed.release()

    const retried = claimHeldNotices("agent", "friend-1")
    expect(retried.messages).toHaveLength(2)
    retried.settle()

    expect(claimHeldNotices("agent", "friend-1").messages).toEqual([])
  })
})
