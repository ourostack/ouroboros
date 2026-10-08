import * as fs from "node:fs"
import * as path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { createTmpBundle, type TmpBundleHandle } from "../test-helpers/tmpdir-bundle"
import { FileOutboxStore, OUTBOX_LIST_MAX_CHARS, OUTBOX_MAX_BODY_CHARS, OUTBOX_MAX_ENTRIES, isOutboxEntryId, outboxRoot } from "../../a2a/outbox-store"

let tmp: TmpBundleHandle | null = null
afterEach(() => { tmp?.cleanup(); tmp = null })
function store() { tmp = createTmpBundle({ agentName: `outbox-${Date.now()}` }); return { store: new FileOutboxStore(tmp.agentRoot), agentRoot: tmp.agentRoot } }

describe("peer outbox store", () => {
  it("appends sortable entries per friend and lists them oldest first after a cursor", () => {
    const { store: outbox } = store()
    const a = outbox.append("peer-a", { kind: "failure_report", body: "one", meta: { reportId: "r1" } }, 1_760_000_000_000)
    const b = outbox.append("peer-a", { kind: "await_outcome", body: "two" }, 1_760_000_000_001)
    outbox.append("peer-b", { kind: "failure_report", body: "other peer" }, 1_760_000_000_002)
    expect(isOutboxEntryId(a.id)).toBe(true)
    expect(a.meta).toEqual({ reportId: "r1" })
    expect(b.meta).toBeUndefined()
    const all = outbox.list("peer-a")
    expect(all.entries.map((entry) => entry.body)).toEqual(["one", "two"])
    expect(all).toMatchObject({ nextCursor: b.id, more: false })
    expect(outbox.list("peer-a", { since: a.id }).entries.map((entry) => entry.id)).toEqual([b.id])
    expect(outbox.list("peer-a", { since: b.id })).toEqual({ entries: [], nextCursor: null, more: false })
    expect(outbox.list("nobody")).toEqual({ entries: [], nextCursor: null, more: false })
    expect(outbox.list("peer-b").entries.map((entry) => entry.body)).toEqual(["other peer"])
  })

  it("limits a listing by count and by size, and flags that more remain", () => {
    const { store: outbox } = store()
    for (let i = 0; i < 5; i += 1) outbox.append("p", { kind: "k", body: `body ${i}` }, 1_760_000_000_000 + i)
    const limited = outbox.list("p", { limit: 2 })
    expect(limited.entries).toHaveLength(2)
    expect(limited.more).toBe(true)
    expect(outbox.list("p", { limit: 0 }).entries).toHaveLength(1)
    expect(outbox.list("p", { limit: 1_000 }).entries).toHaveLength(5)
    const big = store().store
    for (let i = 0; i < 4; i += 1) big.append("p", { kind: "k", body: "x".repeat(OUTBOX_MAX_BODY_CHARS) }, 1_760_000_000_000 + i)
    const sized = big.list("p")
    expect(sized.entries.length).toBeGreaterThan(0)
    expect(JSON.stringify(sized.entries).length).toBeLessThanOrEqual(OUTBOX_LIST_MAX_CHARS + 10)
    expect(sized.more).toBe(true)
  })

  it("caps a body, skips unreadable files and drops the oldest entries beyond the cap", () => {
    const { store: outbox, agentRoot } = store()
    const capped = outbox.append("p", { kind: "k", body: "y".repeat(OUTBOX_MAX_BODY_CHARS + 50) }, 1_760_000_000_000)
    expect(capped.body).toHaveLength(OUTBOX_MAX_BODY_CHARS)
    const dir = path.join(outboxRoot(agentRoot), "p")
    fs.writeFileSync(path.join(dir, "1760000000005-aaaaaa.json"), "{broken")
    fs.writeFileSync(path.join(dir, "1760000000006-bbbbbb.json"), JSON.stringify({ id: "wrong" }))
    fs.writeFileSync(path.join(dir, "notes.txt"), "ignored")
    expect(outbox.list("p").entries.map((entry) => entry.id)).toEqual([capped.id])
    for (let i = 0; i < OUTBOX_MAX_ENTRIES + 3; i += 1) outbox.append("q", { kind: "k", body: String(i) }, 1_760_000_100_000 + i)
    expect(fs.readdirSync(path.join(outboxRoot(agentRoot), "q"))).toHaveLength(OUTBOX_MAX_ENTRIES)
    expect(outbox.list("q", { limit: 1 }).entries[0]!.body).toBe("3")
  })

  it("acks only this friend's own entries and reports the rest as unknown", () => {
    const { store: outbox } = store()
    const mine = outbox.append("mine", { kind: "k", body: "m" }, 1_760_000_000_000)
    const theirs = outbox.append("theirs", { kind: "k", body: "t" }, 1_760_000_000_001)
    expect(outbox.ack("mine", [theirs.id, "../../escape", mine.id, mine.id])).toEqual({ acked: [mine.id], unknown: [theirs.id, "../../escape", mine.id] })
    expect(outbox.list("theirs").entries).toHaveLength(1)
    expect(outbox.list("mine").entries).toHaveLength(0)
    expect(outbox.ack("mine", [])).toEqual({ acked: [], unknown: [] })
  })

  it("refuses a friend id that could leave the outbox directory", () => {
    const { store: outbox } = store()
    expect(() => outbox.append("../escape", { kind: "k", body: "x" })).toThrow("outbox friend id is invalid")
    expect(() => outbox.list("a/b")).toThrow("outbox friend id is invalid")
    expect(isOutboxEntryId(5)).toBe(false)
  })

  it("appendOnce posts a delivery once while it is unacked and again after the peer has cleared it", () => {
    const { store: outbox } = store()
    const first = outbox.appendOnce("peer-a", "await:x:resolved", { kind: "await_outcome", body: "done", meta: { awaitName: "x" } }, 1_760_000_000_000)
    expect(first.meta).toEqual({ awaitName: "x", dedupeKey: "await:x:resolved" })
    expect(outbox.appendOnce("peer-a", "await:x:resolved", { kind: "await_outcome", body: "done" }, 1_760_000_000_500).id).toBe(first.id)
    expect(outbox.appendOnce("peer-a", "await:y:resolved", { kind: "await_outcome", body: "other" }, 1_760_000_001_000).id).not.toBe(first.id)
    expect(outbox.list("peer-a").entries).toHaveLength(2)
    outbox.ack("peer-a", [first.id])
    expect(outbox.appendOnce("peer-a", "await:x:resolved", { kind: "await_outcome", body: "done" }, 1_760_000_002_000).id).not.toBe(first.id)
  })
})
