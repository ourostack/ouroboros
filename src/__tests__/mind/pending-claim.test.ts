import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import * as nervesRuntime from "../../nerves/runtime"
import { claimPending, hasPendingMessages, MAX_PENDING_FAILED_TRIES, queuePendingMessage, queuePendingMessageOnce, releaseHeldPendingClaimsOnExit, type PendingMessage } from "../../mind/pending"

// A pending message (a mail notice, an app-session report) is only deleted once a turn has handled it. A turn that
// never got to it leaves it for the next turn, and a message that keeps failing is set aside instead of failing
// every turn after it.

const dirs: string[] = []
function pendingDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pending-claim-"))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    fs.chmodSync(dir, 0o700)
    fs.rmSync(dir, { recursive: true, force: true })
  }
  vi.restoreAllMocks()
})

function message(content: string, timestamp: number): PendingMessage {
  return { from: "mail", content, timestamp }
}

function suffixes(dir: string): string[] {
  return fs.readdirSync(dir).map((name) => name.replace(/^.*?(\.json.*)$/, "$1")).sort()
}

function readStored(dir: string): Record<string, unknown> {
  const [name] = fs.readdirSync(dir)
  return JSON.parse(fs.readFileSync(path.join(dir, name!), "utf-8")) as Record<string, unknown>
}

describe("claimPending", () => {
  it("keeps the messages it hands to a turn on disk until the turn settles them", () => {
    const dir = pendingDir()
    queuePendingMessage(dir, message("first", 1))
    queuePendingMessage(dir, message("second", 2))

    const claim = claimPending(dir)
    expect(claim.messages.map((m) => m.content)).toEqual(["first", "second"])
    expect(suffixes(dir)).toEqual([".json.claimed", ".json.claimed"])
    // Held by a turn in this process: not new work for another turn.
    expect(hasPendingMessages(dir)).toBe(false)

    claim.settle()
    expect(fs.readdirSync(dir)).toEqual([])
    // Settling twice, or releasing after settling, changes nothing.
    claim.settle()
    claim.release({ failed: true })
    expect(claimPending(dir).messages).toEqual([])
  })

  it("puts back the messages of a turn that did not get to them, without using up a try", () => {
    const dir = pendingDir()
    queuePendingMessage(dir, message("first", 1))
    const outage = claimPending(dir)
    queuePendingMessage(dir, message("second", 2))
    // A second turn while the first still holds its claim does not read the first's messages again.
    const concurrent = claimPending(dir)
    expect(concurrent.messages.map((m) => m.content)).toEqual(["second"])
    concurrent.settle()

    for (let turn = 0; turn < MAX_PENDING_FAILED_TRIES + 1; turn += 1) {
      outage.release()
      expect(suffixes(dir)).toEqual([".json"])
      expect(hasPendingMessages(dir)).toBe(true)
    }
    for (let turn = 0; turn < MAX_PENDING_FAILED_TRIES + 1; turn += 1) claimPending(dir).release()
    const next = claimPending(dir)
    expect(next.messages).toEqual([message("first", 1)])
    next.settle()
    expect(fs.readdirSync(dir)).toEqual([])
  })

  it("sets a message aside once turns that read it have thrown every try", () => {
    const dir = pendingDir()
    queuePendingMessage(dir, message("poison", 1))
    const events = vi.spyOn(nervesRuntime, "emitNervesEvent")

    expect(MAX_PENDING_FAILED_TRIES).toBe(3)
    for (let failedTries = 1; failedTries <= MAX_PENDING_FAILED_TRIES; failedTries += 1) {
      const claim = claimPending(dir)
      expect(claim.messages).toEqual([message("poison", 1)])
      claim.release({ failed: true })
      expect(readStored(dir)).toMatchObject({ content: "poison", failedTries })
    }
    const last = claimPending(dir)
    expect(last.messages).toEqual([])
    expect(suffixes(dir)).toEqual([".json.failed"])
    expect(hasPendingMessages(dir)).toBe(false)
    expect(events).toHaveBeenCalledWith(expect.objectContaining({ level: "error", event: "mind.pending_message_failed", meta: expect.objectContaining({ failedTries: MAX_PENDING_FAILED_TRIES }) }))
  })

  it("reads again a message a process died holding, counting the try that died", () => {
    const dir = pendingDir()
    // Left by processes that died mid-turn: one this code claimed, one drainPending was reading.
    fs.writeFileSync(path.join(dir, "1-a.json.claimed"), JSON.stringify(message("claimed", 1)))
    fs.writeFileSync(path.join(dir, "2-b.json.processing"), JSON.stringify({ ...message("draining", 2), failedTries: 1 }))
    fs.writeFileSync(path.join(dir, "3-c.json.claimed"), JSON.stringify({ ...message("died twice already", 3), failedTries: MAX_PENDING_FAILED_TRIES - 1 }))
    expect(hasPendingMessages(dir)).toBe(true)

    const claim = claimPending(dir)
    expect(claim.messages.map((m) => m.content)).toEqual(["claimed", "draining"])
    expect(JSON.parse(fs.readFileSync(path.join(dir, "1-a.json.claimed"), "utf-8"))).toMatchObject({ failedTries: 1 })
    expect(JSON.parse(fs.readFileSync(path.join(dir, "2-b.json.claimed"), "utf-8"))).toMatchObject({ failedTries: 2 })
    expect(fs.existsSync(path.join(dir, "3-c.json.failed"))).toBe(true)
    claim.release()
    expect(fs.readdirSync(dir).sort()).toEqual(["1-a.json", "2-b.json", "3-c.json.failed"])
  })

  it("settles only the messages it is given, and puts the rest back", () => {
    const dir = pendingDir()
    queuePendingMessage(dir, message("expired", 1))
    queuePendingMessage(dir, message("current", 2))
    const claim = claimPending(dir)
    claim.settle([claim.messages[0]!])
    expect(suffixes(dir)).toEqual([".json.claimed"])
    claim.release()
    expect(claimPending(dir).messages).toEqual([message("current", 2)])
  })

  it("reads a message queued again while a turn holds it once, and deletes the copy with it", () => {
    const dir = pendingDir()
    const notice = { ...message("mail arrived", 1), packetId: "packet-1" }
    queuePendingMessageOnce(dir, notice)
    const claim = claimPending(dir)
    queuePendingMessageOnce(dir, notice)
    expect(claimPending(dir).messages).toEqual([])
    claim.settle()
    expect(fs.readdirSync(dir)).toEqual([])

    // A copy beside a crash leftover is read once, under the leftover's name.
    queuePendingMessageOnce(dir, notice)
    const [name] = fs.readdirSync(dir)
    fs.copyFileSync(path.join(dir, name!), path.join(dir, `${name}.claimed`))
    const recovered = claimPending(dir)
    expect(recovered.messages).toEqual([notice])
    recovered.settle()
    expect(fs.readdirSync(dir)).toEqual([])
  })

  it("leaves a file it cannot read yet for a writer that may still be writing it, and sets an old one aside", () => {
    const dir = pendingDir()
    const events = vi.spyOn(nervesRuntime, "emitNervesEvent")
    fs.writeFileSync(path.join(dir, "1-being-written.json"), "{not json")
    fs.writeFileSync(path.join(dir, "2-torn.json"), "{not json")
    const longAgo = new Date(Date.now() - 5 * 60_000)
    fs.utimesSync(path.join(dir, "2-torn.json"), longAgo, longAgo)
    fs.writeFileSync(path.join(dir, "3-torn.json.processing"), "{not json")
    fs.mkdirSync(path.join(dir, "4-folder.json"))

    expect(claimPending(dir).messages).toEqual([])
    // Nothing is deleted: an old or crash-left file nobody can read is kept as .json.failed for a person to look at.
    expect(fs.readdirSync(dir).sort()).toEqual(["1-being-written.json", "2-torn.json.failed", "3-torn.json.failed", "4-folder.json"])
    expect(events).toHaveBeenCalledWith(expect.objectContaining({ level: "error", event: "mind.pending_message_unreadable", meta: expect.objectContaining({ file: "2-torn.json" }) }))
    expect(claimPending(path.join(dir, "missing")).messages).toEqual([])
  })

  it("counts a try once when a process dies while putting a message back", () => {
    const dir = pendingDir()
    // release({ failed: true }) wrote the counted copy back, then the process died before removing its claim.
    fs.writeFileSync(path.join(dir, "1-a.json"), JSON.stringify({ ...message("notice", 1), failedTries: 1 }))
    fs.writeFileSync(path.join(dir, "1-a.json.claimed"), JSON.stringify(message("notice", 1)))

    const claim = claimPending(dir)
    expect(claim.messages).toEqual([message("notice", 1)])
    claim.release()
    expect(fs.readdirSync(dir)).toEqual(["1-a.json"])
    expect(readStored(dir)).toMatchObject({ failedTries: 1 })
  })

  it("puts back a claim still held when the process exits, without counting it", () => {
    const dir = pendingDir()
    queuePendingMessage(dir, message("held at exit", 1))
    const claim = claimPending(dir)
    expect(claim.messages).toHaveLength(1)
    expect(process.listeners("exit")).toContain(releaseHeldPendingClaimsOnExit)

    releaseHeldPendingClaimsOnExit()
    expect(suffixes(dir)).toEqual([".json"])
    expect(readStored(dir)).not.toHaveProperty("failedTries")
    // The turn's own settle or release afterwards finds nothing left to do.
    claim.release({ failed: true })
    expect(readStored(dir)).not.toHaveProperty("failedTries")
    const next = claimPending(dir)
    expect(next.messages).toEqual([message("held at exit", 1)])
    releaseHeldPendingClaimsOnExit()
    next.settle()
    // Settling a claim the exit hook already put back leaves the message for the next process.
    expect(suffixes(dir)).toEqual([".json"])
  })

  it("puts back a claim held at a failing exit as a counted try", () => {
    const dir = pendingDir()
    queuePendingMessage(dir, message("held at a crash exit", 1))
    const claim = claimPending(dir)
    expect(claim.messages).toHaveLength(1)

    // An uncaught exception exits with code 1, and the messages may be why.
    releaseHeldPendingClaimsOnExit(1)

    expect(suffixes(dir)).toEqual([".json"])
    expect(readStored(dir)).toMatchObject({ content: "held at a crash exit", failedTries: 1 })
    claim.release({ failed: true })
    expect(readStored(dir)).toMatchObject({ failedTries: 1 })
  })

  it("never reads a settled message again in this process when its file could not be deleted, and deletes it later", () => {
    const dir = pendingDir()
    queuePendingMessage(dir, message("acted on", 1))
    const claim = claimPending(dir)
    expect(claim.messages).toHaveLength(1)
    fs.chmodSync(dir, 0o500)
    const events = vi.spyOn(nervesRuntime, "emitNervesEvent")

    claim.settle()
    expect(events).toHaveBeenCalledWith(expect.objectContaining({ event: "mind.pending_settle_error" }))
    expect(suffixes(dir)).toEqual([".json.claimed"])
    // Read again, it would repeat whatever the turn's tool did.
    expect(claimPending(dir).messages).toEqual([])

    fs.chmodSync(dir, 0o700)
    expect(claimPending(dir).messages).toEqual([])
    expect(fs.readdirSync(dir)).toEqual([])
  })

  describe("at a stop signal", () => {
    function pendingGuard(signal: "SIGTERM" | "SIGINT" = "SIGTERM"): () => void {
      const guard = process.rawListeners(signal).find((listener) => (listener as unknown as Record<symbol, unknown>)[Symbol.for("ouro.terminationGuard")] === true)
      expect(guard).toBeDefined()
      return guard as () => void
    }

    it("leaves held claims to the process's own shutdown when it has one", () => {
      const dir = pendingDir()
      queuePendingMessage(dir, message("held while stopping", 1))
      const claim = claimPending(dir)
      const guard = pendingGuard()
      vi.spyOn(process, "rawListeners").mockReturnValue([guard, () => undefined])
      const kill = vi.spyOn(process, "kill").mockImplementation(() => true)

      guard()

      expect(suffixes(dir)).toEqual([".json.claimed"])
      expect(kill).not.toHaveBeenCalled()
      claim.release()
    })

    it.each(["SIGTERM", "SIGINT"] as const)("puts held claims back uncounted and re-raises %s when nothing else handles it", (signal) => {
      const dir = pendingDir()
      queuePendingMessage(dir, message("held while stopping", 1))
      claimPending(dir)
      const guard = pendingGuard(signal)
      vi.spyOn(process, "rawListeners").mockReturnValue([guard])
      const kill = vi.spyOn(process, "kill").mockImplementation(() => true)
      try {
        guard()

        expect(suffixes(dir)).toEqual([".json"])
        expect(readStored(dir)).not.toHaveProperty("failedTries")
        expect(kill).toHaveBeenCalledWith(process.pid, signal)
        vi.restoreAllMocks()
        expect(process.rawListeners(signal)).not.toContain(guard)
      } finally {
        vi.restoreAllMocks()
        // Put the guard back for later tests, as a fresh process would have it.
        if (!process.rawListeners(signal).includes(guard)) {
          process.removeListener("exit", releaseHeldPendingClaimsOnExit)
          claimPending(pendingDir()).release()
        }
      }
    })
  })

  it("claims nothing when the folder cannot be listed", () => {
    const dir = pendingDir()
    const notAFolder = path.join(dir, "file")
    fs.writeFileSync(notAFolder, "")
    expect(claimPending(notAFolder).messages).toEqual([])
  })

  it("leaves messages where they are when the folder cannot be written, and says so", () => {
    const dir = pendingDir()
    queuePendingMessage(dir, message("fresh", 2))
    fs.writeFileSync(path.join(dir, "1-a.json.claimed"), JSON.stringify(message("left by a crash", 1)))
    fs.writeFileSync(path.join(dir, "3-c.json.claimed"), JSON.stringify({ ...message("used up", 3), failedTries: MAX_PENDING_FAILED_TRIES - 1 }))
    fs.writeFileSync(path.join(dir, "4-torn.json.claimed"), "{not json")
    fs.chmodSync(dir, 0o500)
    const events = vi.spyOn(nervesRuntime, "emitNervesEvent")

    // The fresh one cannot be renamed, so it is left for later; the leftover is read even though its count cannot land.
    const claim = claimPending(dir)
    expect(claim.messages.map((m) => m.content)).toEqual(["left by a crash"])
    claim.release({ failed: true })
    expect(events).toHaveBeenCalledWith(expect.objectContaining({ level: "warn", event: "mind.pending_release_error" }))

    const again = claimPending(dir)
    again.settle()
    expect(events).toHaveBeenCalledWith(expect.objectContaining({ level: "warn", event: "mind.pending_settle_error" }))
    fs.chmodSync(dir, 0o700)
    // The used-up message could not be set aside, so it stays claimed for a later turn to set aside.
    expect(events).toHaveBeenCalledWith(expect.objectContaining({ level: "warn", event: "mind.pending_set_aside_error" }))
    // Nor could the torn leftover, so it is not reported as set aside.
    expect(events).not.toHaveBeenCalledWith(expect.objectContaining({ event: "mind.pending_message_unreadable" }))
    expect(suffixes(dir)).toEqual([".json", ".json.claimed", ".json.claimed", ".json.claimed"])
  })

  it("puts its messages back when the claim itself fails", () => {
    const dir = pendingDir()
    queuePendingMessage(dir, message("held", 1))
    vi.spyOn(nervesRuntime, "emitNervesEvent").mockImplementation((event) => {
      if (event.event === "mind.pending_claimed") throw new Error("event sink down")
    })
    expect(() => claimPending(dir)).toThrow("event sink down")
    expect(suffixes(dir)).toEqual([".json"])
    vi.restoreAllMocks()
    expect(claimPending(dir).messages).toEqual([message("held", 1)])
  })
})
