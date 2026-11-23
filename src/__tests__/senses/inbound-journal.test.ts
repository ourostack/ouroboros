import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { MAX_INBOUND_ATTEMPTS, openInboundJournal, readInboundOutcome } from "../../senses/inbound-journal"
import { turnSpoke } from "../../senses/turn-attempts"

const roots: string[] = []
function agentRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "inbound-journal-"))
  roots.push(root)
  return root
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

describe("the shared inbound journal", () => {
  it("keeps an inbound pending, on disk, until its one outcome is recorded", () => {
    const root = agentRoot()
    const journal = openInboundJournal<{ text: string }>(root, "test-sense")
    const recorded = journal.record("message-1", { text: "hello" })
    expect(recorded).toMatchObject({ id: "message-1", sense: "test-sense", attempts: 0, spoke: false, payload: { text: "hello" } })

    // A new process sees the same pending inbound.
    const reopened = openInboundJournal<{ text: string }>(root, "test-sense")
    expect(reopened.pending().map((entry) => entry.id)).toEqual(["message-1"])
    expect(reopened.get("message-1")?.payload).toEqual({ text: "hello" })

    expect(reopened.settle("message-1", "answered")).toBe(true)
    expect(reopened.pending()).toEqual([])
    expect(reopened.get("message-1")).toBeNull()
    expect(readInboundOutcome(root, "test-sense", "message-1")).toMatchObject({ id: "message-1", outcome: "answered", attempts: 0 })
  })

  it("records a second copy of the same inbound once, and a second outcome not at all", () => {
    const root = agentRoot()
    const journal = openInboundJournal<{ text: string }>(root, "test-sense")
    journal.record("message-1", { text: "first" })
    expect(journal.record("message-1", { text: "second" })?.payload).toEqual({ text: "first" })
    expect(journal.settle("message-1", "failed", "the turn threw")).toBe(true)
    expect(journal.settle("message-1", "answered")).toBe(false)
    expect(readInboundOutcome(root, "test-sense", "message-1")).toMatchObject({ outcome: "failed", detail: "the turn threw" })
    // An inbound that already has an outcome is never pending again, even if a copy arrives later.
    expect(journal.record("message-1", { text: "third" })).toBeNull()
    expect(journal.pending()).toEqual([])
    expect(journal.settle("never-recorded", "answered")).toBe(false)
  })

  it("counts attempts on disk, so a crash does not reset them", () => {
    const root = agentRoot()
    const journal = openInboundJournal<{ text: string }>(root, "test-sense")
    journal.record("message-1", { text: "hello" })
    expect(journal.beginAttempt("message-1")).toBe(1)
    expect(openInboundJournal(root, "test-sense").beginAttempt("message-1")).toBe(2)
    expect(openInboundJournal(root, "test-sense").get("message-1")?.attempts).toBe(2)
    expect(MAX_INBOUND_ATTEMPTS).toBe(3)
    expect(journal.beginAttempt("missing")).toBe(0)
  })

  it("gives back an attempt that a clean shutdown stopped, so restarts alone never use up an inbound", () => {
    const root = agentRoot()
    const journal = openInboundJournal<{ text: string }>(root, "test-sense")
    journal.record("message-1", { text: "hello" })
    journal.refundAttempt("message-1")
    expect(journal.get("message-1")?.attempts).toBe(0)
    journal.beginAttempt("message-1")
    journal.beginAttempt("message-1")
    journal.refundAttempt("message-1")
    expect(openInboundJournal(root, "test-sense").get("message-1")?.attempts).toBe(1)
    journal.refundAttempt("missing")
  })

  it("remembers that the person may already have seen part of the reply", () => {
    const root = agentRoot()
    const journal = openInboundJournal<{ text: string }>(root, "test-sense")
    journal.record("message-1", { text: "hello" })
    journal.markSpoke("message-1")
    journal.markSpoke("missing")
    expect(openInboundJournal(root, "test-sense").get("message-1")?.spoke).toBe(true)
  })

  it("keeps what went out and when, so the next process can say what the person already has", () => {
    const root = agentRoot()
    const journal = openInboundJournal<{ text: string }>(root, "test-sense")
    journal.record("message-1", { text: "hello" })
    journal.markSpoke("message-1", turnSpoke("tool:send_message", "the build is out", null, Date.parse("2026-11-22T10:00:00.000Z")))
    journal.markSpoke("message-1", turnSpoke("tool:surface", "ready"))
    const entry = openInboundJournal(root, "test-sense").get("message-1")
    expect(entry?.spoke).toBe(true)
    expect(entry?.spokeRecords).toEqual([
      expect.objectContaining({ kind: "tool:send_message", sentAt: "2026-11-22T10:00:00.000Z", textLength: 16 }),
      expect.objectContaining({ kind: "tool:surface" }),
    ])
  })

  it("lists pending inbounds oldest first and reports the oldest one's age", () => {
    const root = agentRoot()
    let now = Date.parse("2026-11-22T20:00:00.000Z")
    const journal = openInboundJournal<{ n: number }>(root, "test-sense", { now: () => now })
    expect(journal.oldestPendingAgeMs()).toBeNull()
    journal.record("b", { n: 1 })
    now += 1_000
    journal.record("a", { n: 2 })
    now += 4_000
    expect(journal.pending().map((entry) => entry.id)).toEqual(["b", "a"])
    const { oldestPendingAgeMs } = journal
    expect(oldestPendingAgeMs()).toBe(5_000)
  })

  it("keeps the order inbounds arrived in when they arrive in the same millisecond", () => {
    const root = agentRoot()
    const now = Date.parse("2026-11-22T20:00:00.000Z")
    const journal = openInboundJournal<{ n: number }>(root, "test-sense", { now: () => now })
    for (const id of ["first", "second", "third", "fourth"]) journal.record(id, { n: 0 })
    // One recorded before inbounds carried a sequence sorts ahead of its millisecond.
    const pendingDir = path.join(root, "state", "senses", "test-sense", "pending-inbound")
    fs.writeFileSync(path.join(pendingDir, "unsequenced.json"), JSON.stringify({ id: "unsequenced", sense: "test-sense", receivedAt: new Date(now).toISOString(), attempts: 0, spoke: false, payload: { n: 0 } }))
    expect(openInboundJournal(root, "test-sense", { now: () => now }).pending().map((entry) => entry.id)).toEqual(["unsequenced", "first", "second", "third", "fourth"])
  })

  it("finishes an outcome that was recorded just before a crash instead of replaying it", () => {
    const root = agentRoot()
    const journal = openInboundJournal<{ text: string }>(root, "test-sense")
    journal.record("message-1", { text: "hello" })
    const pendingDir = path.join(root, "state", "senses", "test-sense", "pending-inbound")
    const [file] = fs.readdirSync(pendingDir)
    // The outcome file landed, then the process died before removing the pending copy.
    journal.settle("message-1", "answered")
    fs.writeFileSync(path.join(pendingDir, file!), JSON.stringify({ id: "message-1", sense: "test-sense", receivedAt: new Date().toISOString(), attempts: 1, spoke: false, payload: { text: "hello" } }))
    expect(openInboundJournal(root, "test-sense").pending()).toEqual([])
    expect(fs.readdirSync(pendingDir)).toEqual([])
  })

  it("skips a pending file it cannot read instead of failing every replay", () => {
    const root = agentRoot()
    const journal = openInboundJournal<{ text: string }>(root, "test-sense")
    journal.record("message-1", { text: "hello" })
    const pendingDir = path.join(root, "state", "senses", "test-sense", "pending-inbound")
    fs.writeFileSync(path.join(pendingDir, "torn.json"), "{not json")
    fs.writeFileSync(path.join(pendingDir, "leftover.json.123.tmp"), "{}")
    expect(journal.pending().map((entry) => entry.id)).toEqual(["message-1"])
  })

  it("lists nothing when its folder was removed underneath it", () => {
    const root = agentRoot()
    const journal = openInboundJournal<{ text: string }>(root, "test-sense")
    journal.record("message-1", { text: "hello" })
    fs.rmSync(path.join(root, "state", "senses", "test-sense", "pending-inbound"), { recursive: true })
    expect(journal.pending()).toEqual([])
  })

  it("keeps its files in a folder the sense names, when it has one", () => {
    const root = agentRoot()
    const dir = path.join(root, "calls", "utterances")
    const journal = openInboundJournal<{ text: string }>(root, "voice", { dir })
    journal.record("utterance-1", { text: "hello" })
    expect(fs.readdirSync(path.join(dir, "pending-inbound"))).toHaveLength(1)
    expect(fs.existsSync(path.join(root, "state"))).toBe(false)
    expect(journal.outcome("utterance-1")).toBeNull()
    journal.settle("utterance-1", "answered")
    expect(journal.outcome("utterance-1")).toMatchObject({ id: "utterance-1", sense: "voice", outcome: "answered" })
    expect(openInboundJournal(root, "voice", { dir }).outcome("utterance-1")).toMatchObject({ outcome: "answered" })
  })

  it("forgets outcomes older than the retention window", () => {
    const root = agentRoot()
    let now = Date.parse("2026-11-01T00:00:00.000Z")
    const journal = openInboundJournal<{ text: string }>(root, "test-sense", { now: () => now })
    journal.record("old", { text: "old" })
    journal.settle("old", "answered")
    now += 31 * 24 * 60 * 60_000
    journal.record("new", { text: "new" })
    journal.settle("new", "answered")
    openInboundJournal(root, "test-sense", { now: () => now })
    expect(readInboundOutcome(root, "test-sense", "old")).toBeNull()
    expect(readInboundOutcome(root, "test-sense", "new")).not.toBeNull()
  })
})
