import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, describe, expect, it } from "vitest"

function tempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "frontend-journal-"))
}

function ref(sessionId = "session-1") {
  return { agent: "boss", friendId: "friend-1", sessionId }
}

describe("frontend journal", () => {
  const roots: string[] = []

  afterEach(() => {
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
  })

  it("appends private monotonic events and replays from a cursor", async () => {
    const root = tempRoot()
    roots.push(root)
    const { FrontendJournalStore } = await import("../../heart/frontend-journal")
    const store = new FrontendJournalStore({
      agentRoot: (agent) => path.join(root, `${agent}.ouro`),
      now: () => "2026-09-03T20:00:00.000Z",
    })

    const first = store.append(ref(), { turnId: "turn-1", type: "user_message", data: { text: "hello" } })
    const second = store.append(ref(), { turnId: "turn-1", type: "turn_started", data: {} })
    const third = store.append(ref(), { turnId: "turn-1", type: "assistant_delivery", data: { text: "hi" } })
    expect([first.sequence, second.sequence, third.sequence]).toEqual([1, 2, 3])

    const replay = store.replay(ref(), { afterSequence: 1, limit: 1 })
    expect(replay.events).toEqual([second])
    expect(replay.lastSequence).toBe(3)
    expect(replay.hasMore).toBe(true)
    expect(replay.degraded).toBe(false)
    expect(fs.statSync(path.dirname(store.pathFor(ref()))).mode & 0o777).toBe(0o700)
    expect(fs.statSync(store.pathFor(ref())).mode & 0o777).toBe(0o600)
  })

  it("keeps friend and session identities in separate opaque paths", async () => {
    const root = tempRoot()
    roots.push(root)
    const { FrontendJournalStore } = await import("../../heart/frontend-journal")
    const store = new FrontendJournalStore({ agentRoot: (agent) => path.join(root, `${agent}.ouro`) })
    const firstRef = ref("session/one")
    const secondRef = { ...ref("session/one"), friendId: "friend-2" }

    store.append(firstRef, { turnId: "turn-1", type: "turn_started", data: {} })
    store.append(secondRef, { turnId: "turn-2", type: "turn_started", data: {} })

    expect(store.pathFor(firstRef)).not.toBe(store.pathFor(secondRef))
    expect(store.pathFor(firstRef)).not.toContain("session/one")
    expect(store.replay(firstRef).events).toHaveLength(1)
    expect(store.replay(secondRef).events).toHaveLength(1)
  })

  it("continues sequence numbers after a store restart", async () => {
    const root = tempRoot()
    roots.push(root)
    const { FrontendJournalStore } = await import("../../heart/frontend-journal")
    const options = { agentRoot: (agent: string) => path.join(root, `${agent}.ouro`) }
    new FrontendJournalStore(options).append(ref(), { turnId: "turn-1", type: "turn_started", data: {} })

    const event = new FrontendJournalStore(options).append(ref(), {
      turnId: "turn-1",
      type: "turn_completed",
      data: {},
    })

    expect(event.sequence).toBe(2)
  })

  it("replays through the last valid record and refuses to append after a corrupt tail", async () => {
    const root = tempRoot()
    roots.push(root)
    const { FrontendJournalStore, FrontendJournalCorruptError } = await import("../../heart/frontend-journal")
    const store = new FrontendJournalStore({ agentRoot: (agent) => path.join(root, `${agent}.ouro`) })
    const valid = store.append(ref(), { turnId: "turn-1", type: "turn_started", data: {} })
    fs.appendFileSync(store.pathFor(ref()), "{\"partial\":", "utf8")

    expect(store.replay(ref())).toMatchObject({
      events: [valid],
      lastSequence: 1,
      degraded: true,
    })
    expect(() => store.append(ref(), { turnId: "turn-1", type: "turn_completed", data: {} }))
      .toThrow(FrontendJournalCorruptError)
  })

  it("stops replay when a record changes identity or sequence", async () => {
    const root = tempRoot()
    roots.push(root)
    const { FrontendJournalStore } = await import("../../heart/frontend-journal")
    const store = new FrontendJournalStore({ agentRoot: (agent) => path.join(root, `${agent}.ouro`) })
    const valid = store.append(ref(), { turnId: "turn-1", type: "turn_started", data: {} })
    fs.appendFileSync(store.pathFor(ref()), `${JSON.stringify({ ...valid, sequence: 3, friendId: "other" })}\n`, "utf8")

    expect(store.replay(ref())).toMatchObject({
      events: [valid],
      lastSequence: 1,
      degraded: true,
    })
  })

  it("rejects invalid identities, cursors, limits, and oversized payloads", async () => {
    const root = tempRoot()
    roots.push(root)
    const { FrontendJournalStore, FrontendJournalPayloadTooLargeError } = await import("../../heart/frontend-journal")
    const store = new FrontendJournalStore({
      agentRoot: (agent) => path.join(root, `${agent}.ouro`),
      maxEventBytes: 200,
    })

    expect(() => store.pathFor({ ...ref(), agent: " " })).toThrow("agent")
    expect(() => store.replay(ref(), { afterSequence: -1 })).toThrow("afterSequence")
    expect(() => store.replay(ref(), { limit: 0 })).toThrow("limit")
    expect(() => store.append(ref(), {
      turnId: "turn-1",
      type: "assistant_delivery",
      data: { text: "x".repeat(500) },
    })).toThrow(FrontendJournalPayloadTooLargeError)
    expect(fs.existsSync(store.pathFor(ref()))).toBe(false)
  })
})
