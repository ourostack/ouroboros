import { describe, expect, it } from "vitest"
import type { Letter, LetterEvent } from "../../../heart/letters/letter"
import { LetterIndex, dedupeScope } from "../../../heart/letters/letter-index"

const NOW = Date.parse("2026-11-23T12:00:00.000Z")
const HOUR = 60 * 60 * 1000

function letter(id: string, code: string, extra: Partial<Letter> = {}): Letter {
  return {
    v: 1, id: `ltr_${id}`, code, to: "friend-ari", from: { agent: "slugger" }, kind: "know", subject: `Letter ${id}`, body: "",
    options: [{ id: "1", label: "got it", effect: "e" }], links: [], urgency: "whenever", createdAt: new Date(NOW - 3 * HOUR).toISOString(), ...extra,
  }
}

function answered(hoursAgo: number): LetterEvent {
  return {
    t: "answered", at: new Date(NOW - hoursAgo * HOUR).toISOString(), option: "1", via: "chat",
    evidence: { friendId: "friend-ari", channel: "bluebubbles", chatGuid: "c", messageGuid: "g", dateCreated: "d" }, hostTrust: "separate",
  }
}

describe("dedupeScope", () => {
  it("keys by sender agent, peer and dedupe key, so one sender never collides with another's key", () => {
    expect(dedupeScope(letter("A", "L1", { dedupeKey: "k" }))).toBe(JSON.stringify(["slugger", "local", "k"]))
    expect(dedupeScope(letter("A", "L1", { dedupeKey: "k", from: { agent: "slugger", peer: { did: "did:x", taskId: "t" } } }))).toBe(JSON.stringify(["slugger", "did:x", "k"]))
    expect(dedupeScope(letter("A", "L1"))).toBeNull()
  })
})

describe("LetterIndex", () => {
  it("finds letters by id or code, case-insensitively for codes", () => {
    const index = new LetterIndex([{ letter: letter("A", "L1"), events: [], closed: false }], 1)
    expect(index.get("ltr_A")!.letter.code).toBe("L1")
    expect(index.get("l1")!.letter.id).toBe("ltr_A")
    expect(index.get("L9")).toBeUndefined()
  })

  it("lists waiting letters oldest first, and every letter with all", () => {
    const index = new LetterIndex([
      { letter: letter("B", "L2", { createdAt: new Date(NOW - HOUR).toISOString() }), events: [], closed: false },
      { letter: letter("A", "L1", { createdAt: new Date(NOW - 2 * HOUR).toISOString() }), events: [], closed: false },
      { letter: letter("C", "L3"), events: [{ t: "withdrawn", at: new Date(NOW).toISOString(), reason: "moot" }], closed: true },
    ], 1)
    expect(index.list({}).map((entry) => entry.letter.code)).toEqual(["L1", "L2"])
    expect(index.list({ all: true }).map((entry) => entry.letter.code)).toEqual(["L3", "L1", "L2"])
    expect(index.list({ kind: "decide" })).toEqual([])
    expect(index.list({ from: "butler" })).toEqual([])
    expect(index.list({ from: "slugger" })).toHaveLength(2)
  })

  it("tracks events added after it is built, and the state they lead to", () => {
    const index = new LetterIndex([], 1)
    index.add({ letter: letter("A", "L1"), events: [], closed: false })
    expect(index.get("ltr_A")!.state).toBe("waiting")
    index.addEvent("ltr_A", { t: "withdrawn", at: new Date(NOW).toISOString(), reason: "moot" })
    expect(index.get("ltr_A")!.state).toBe("withdrawn")
    index.markClosed("ltr_A")
    expect(index.get("ltr_A")!.closed).toBe(true)
    expect(() => index.addEvent("ltr_X", { t: "expired", at: "x" })).toThrow(/no letter ltr_X/)
  })

  it("finds an open duplicate in the same scope, never across senders", () => {
    const index = new LetterIndex([{ letter: letter("A", "L1", { dedupeKey: "k" }), events: [], closed: false }], 1)
    expect(index.findDuplicate(letter("N", "?", { dedupeKey: "k" }), NOW)).toEqual({ entry: index.get("ltr_A"), why: "open" })
    expect(index.findDuplicate(letter("N", "?", { dedupeKey: "k", from: { agent: "butler" } }), NOW)).toBeNull()
    expect(index.findDuplicate(letter("N", "?", { dedupeKey: "other" }), NOW)).toBeNull()
    expect(index.findDuplicate(letter("N", "?"), NOW)).toBeNull()
  })

  it("returns a letter answered in the last 24 hours, and lets a new one be filed after that", () => {
    const recent = new LetterIndex([{ letter: letter("A", "L1", { dedupeKey: "k" }), events: [answered(23)], closed: false }], 1)
    expect(recent.findDuplicate(letter("N", "?", { dedupeKey: "k" }), NOW)!.why).toBe("answered")
    const old = new LetterIndex([{ letter: letter("A", "L1", { dedupeKey: "k" }), events: [answered(25)], closed: false }], 1)
    expect(old.findDuplicate(letter("N", "?", { dedupeKey: "k" }), NOW)).toBeNull()
    const withdrawn = new LetterIndex([{ letter: letter("A", "L1", { dedupeKey: "k" }), events: [{ t: "withdrawn", at: new Date(NOW).toISOString(), reason: "r" }], closed: false }], 1)
    expect(withdrawn.findDuplicate(letter("N", "?", { dedupeKey: "k" }), NOW)).toBeNull()
  })

  it("allocates codes past both the recorded counter and every code on disk, never reusing one", () => {
    expect(new LetterIndex([], 1).nextCode()).toBe(1)
    expect(new LetterIndex([], 5).nextCode()).toBe(5)
    const index = new LetterIndex([{ letter: letter("A", "L7"), events: [], closed: true }, { letter: letter("B", "odd"), events: [], closed: false }], 3)
    expect(index.nextCode()).toBe(8)
  })
})
