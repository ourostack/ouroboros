import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import * as nervesRuntime from "../../nerves/runtime"
import { claimPending, hasPendingMessages, MAX_PENDING_CLAIMS, queuePendingMessage, type PendingMessage } from "../../mind/pending"

// A pending message (a mail notice, an app-session report) is only deleted once the turn that read it has been
// recorded. A turn that throws, or a process that dies mid-turn, leaves it for the next turn to read again.

const dirs: string[] = []
function pendingDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pending-claim-"))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
  vi.restoreAllMocks()
})

function message(content: string, timestamp: number): PendingMessage {
  return { from: "mail", content, timestamp }
}

describe("claimPending", () => {
  it("keeps the messages it hands to a turn on disk until the turn settles them", () => {
    const dir = pendingDir()
    queuePendingMessage(dir, message("first", 1))
    queuePendingMessage(dir, message("second", 2))

    const claim = claimPending(dir)
    expect(claim.messages.map((m) => m.content)).toEqual(["first", "second"])
    expect(fs.readdirSync(dir).every((name) => name.endsWith(".json.processing"))).toBe(true)
    expect(hasPendingMessages(dir)).toBe(true)

    claim.settle()
    expect(fs.readdirSync(dir)).toEqual([])
    // Settling twice, or releasing after settling, changes nothing.
    claim.settle()
    claim.release()
    expect(claimPending(dir).messages).toEqual([])
  })

  it("gives the messages of a turn that never settled to the next turn, in their order", () => {
    const dir = pendingDir()
    queuePendingMessage(dir, message("first", 1))
    const failed = claimPending(dir)
    queuePendingMessage(dir, message("second", 2))
    // A second turn while the first still holds its claim does not read the first's messages again.
    const concurrent = claimPending(dir)
    expect(concurrent.messages.map((m) => m.content)).toEqual(["second"])
    concurrent.settle()

    failed.release()
    const next = claimPending(dir)
    expect(next.messages).toEqual([message("first", 1)])
    next.settle()
    expect(fs.readdirSync(dir)).toEqual([])
  })

  it("reads again a message a process died holding, and sets it aside once it has failed every try", () => {
    const dir = pendingDir()
    queuePendingMessage(dir, message("poison", 1))
    const events = vi.spyOn(nervesRuntime, "emitNervesEvent")

    expect(MAX_PENDING_CLAIMS).toBe(3)
    for (let claimNumber = 1; claimNumber <= MAX_PENDING_CLAIMS; claimNumber += 1) {
      const claim = claimPending(dir)
      expect(claim.messages).toEqual([message("poison", 1)])
      claim.release()
    }
    // Claimed three times and never settled: it no longer blocks every later turn.
    const last = claimPending(dir)
    expect(last.messages).toEqual([])
    expect(fs.readdirSync(dir).map((name) => name.replace(/^.*?(\.json.*)$/, "$1"))).toEqual([".json.failed"])
    expect(hasPendingMessages(dir)).toBe(false)
    expect(events).toHaveBeenCalledWith(expect.objectContaining({ level: "error", event: "mind.pending_message_failed", meta: expect.objectContaining({ claims: MAX_PENDING_CLAIMS }) }))
  })

  it("drops a file it cannot read, and claims nothing from a folder that is not there", () => {
    const dir = pendingDir()
    fs.writeFileSync(path.join(dir, "1-torn.json"), "{not json")
    fs.writeFileSync(path.join(dir, "2-torn.json.processing"), "{not json")
    expect(claimPending(dir).messages).toEqual([])
    expect(fs.readdirSync(dir)).toEqual([])
    expect(claimPending(path.join(dir, "missing")).messages).toEqual([])
  })

  it("claims nothing when the folder cannot be listed", () => {
    const dir = pendingDir()
    const notAFolder = path.join(dir, "file")
    fs.writeFileSync(notAFolder, "")
    expect(claimPending(notAFolder).messages).toEqual([])
  })

  it("says so when a settled message cannot be deleted", () => {
    const dir = pendingDir()
    queuePendingMessage(dir, message("sticky", 1))
    const claim = claimPending(dir)
    const [held] = fs.readdirSync(dir)
    // Something else put a folder where the claimed file was, so deleting it fails.
    fs.rmSync(path.join(dir, held!))
    fs.mkdirSync(path.join(dir, held!))
    const events = vi.spyOn(nervesRuntime, "emitNervesEvent")
    claim.settle()
    expect(events).toHaveBeenCalledWith(expect.objectContaining({ event: "mind.pending_settle_error" }))
  })
})
