import { afterEach, describe, expect, it } from "vitest"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

const tempDirs: string[] = []

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bb-thread-cleanup-"))
  tempDirs.push(dir)
  return dir
}

function writeFile(filePath: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, "{}")
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

describe("bluebubbles thread lane cleanup", () => {
  it("removes only sibling thread lane files for a live chat trunk", async () => {
    const { cleanupObsoleteBlueBubblesThreadSessions } = await import("../../senses/bluebubbles-session-cleanup")

    const dir = makeTempDir()
    const trunk = path.join(dir, "chat_any;-;ari@mendelow.me.json")
    const threadA = path.join(dir, "chat_any;-;ari@mendelow.me_thread_123.json")
    const threadB = path.join(dir, "chat_any;-;ari@mendelow.me_thread_456.json")
    const unrelatedChat = path.join(dir, "chat_any;-;someoneelse.json")
    const unrelatedThread = path.join(dir, "chat_any;-;someoneelse_thread_999.json")

    writeFile(trunk)
    writeFile(threadA)
    writeFile(threadB)
    writeFile(unrelatedChat)
    writeFile(unrelatedThread)

    const removed = cleanupObsoleteBlueBubblesThreadSessions(trunk)

    expect(removed.sort()).toEqual([threadA, threadB].sort())
    expect(fs.existsSync(trunk)).toBe(true)
    expect(fs.existsSync(threadA)).toBe(false)
    expect(fs.existsSync(threadB)).toBe(false)
    expect(fs.existsSync(unrelatedChat)).toBe(true)
    expect(fs.existsSync(unrelatedThread)).toBe(true)
  })

  it("does nothing when the provided path is not a live chat trunk", async () => {
    const { cleanupObsoleteBlueBubblesThreadSessions } = await import("../../senses/bluebubbles-session-cleanup")

    const dir = makeTempDir()
    const missingTrunk = path.join(dir, "chat_any;-;ari@mendelow.me.json")
    const nestedThread = path.join(dir, "chat_any;-;ari@mendelow.me_thread_123.json")
    writeFile(nestedThread)

    expect(cleanupObsoleteBlueBubblesThreadSessions(missingTrunk)).toEqual([])
    expect(cleanupObsoleteBlueBubblesThreadSessions(nestedThread)).toEqual([])
    expect(fs.existsSync(nestedThread)).toBe(true)
  })
})
