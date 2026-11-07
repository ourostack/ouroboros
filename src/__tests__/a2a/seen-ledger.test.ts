import * as fs from "node:fs"
import * as path from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import * as nerves from "../../nerves/runtime"
import { createTmpBundle, type TmpBundleHandle } from "../test-helpers/tmpdir-bundle"
import {
  bindingWindowsWithinRetention,
  FileA2ASeenLedger,
  MAX_ENVELOPE_AGE_MS,
  MAX_FUTURE_SKEW_MS,
  openPrivateSeenLedger,
  SEEN_PRUNE_INTERVAL_MS,
  SEEN_RETENTION_MS,
} from "../../a2a/seen-ledger"

let tmp: TmpBundleHandle | null = null

afterEach(() => {
  tmp?.cleanup()
  tmp = null
})

/**
 * The durable replay-defense ledger implements the friends `SeenLedgerLike`
 * (`isSeen`/`markSeen`) over a durable home under `state/a2a/seen`, mirroring the
 * `FileA2ATaskStore` `state/a2a/tasks` precedent. The make-or-break guarantee: a
 * nonce marked seen STAYS marked across a restart — no reopened replay window.
 */
describe("durable a2a SeenLedger (replay defense, restart-safe)", () => {
  it("reports an unseen nonce as not-seen, then seen after markSeen", () => {
    tmp = createTmpBundle({ agentName: "seen-basic" })
    const ledger = new FileA2ASeenLedger(tmp.agentRoot)
    const nonce = "nonce-basic-AAAA"
    expect(ledger.isSeen(nonce)).toBe(false)
    expect(ledger.size).toBe(0)
    ledger.markSeen(nonce)
    expect(ledger.isSeen(nonce)).toBe(true)
    expect(ledger.size).toBe(1)
  })

  it("persists the seen-set durably under state/a2a/seen (the durable home)", () => {
    tmp = createTmpBundle({ agentName: "seen-home" })
    const ledger = new FileA2ASeenLedger(tmp.agentRoot)
    ledger.markSeen("nonce-home-BBBB")
    const seenDir = path.join(tmp.agentRoot, "state", "a2a", "seen")
    expect(fs.existsSync(seenDir)).toBe(true)
    // At least one durable artifact was written for the marked nonce.
    expect(fs.readdirSync(seenDir).length).toBeGreaterThan(0)
  })

  it("a replay AFTER a simulated restart is still seen (no reopened replay window)", () => {
    tmp = createTmpBundle({ agentName: "seen-restart" })
    const nonce = "nonce-restart-CCCC"

    {
      const ledger = new FileA2ASeenLedger(tmp.agentRoot)
      ledger.markSeen(nonce)
      expect(ledger.isSeen(nonce)).toBe(true)
    }

    // Simulated restart: a brand-new ledger over the same agent root.
    const reloaded = new FileA2ASeenLedger(tmp.agentRoot)
    expect(reloaded.isSeen(nonce)).toBe(true)
  })

  it("keeps multiple marked nonces distinct across restart", () => {
    tmp = createTmpBundle({ agentName: "seen-multi" })
    const a = "nonce-multi-A"
    const b = "nonce-multi-B"

    {
      const ledger = new FileA2ASeenLedger(tmp.agentRoot)
      ledger.markSeen(a)
      ledger.markSeen(b)
    }

    const reloaded = new FileA2ASeenLedger(tmp.agentRoot)
    expect(reloaded.isSeen(a)).toBe(true)
    expect(reloaded.isSeen(b)).toBe(true)
    expect(reloaded.isSeen("nonce-multi-never")).toBe(false)
  })

  it("markSeen is idempotent (marking twice keeps the nonce seen)", () => {
    tmp = createTmpBundle({ agentName: "seen-idempotent" })
    const ledger = new FileA2ASeenLedger(tmp.agentRoot)
    const nonce = "nonce-idem-DDDD"
    ledger.markSeen(nonce)
    ledger.markSeen(nonce)
    expect(ledger.isSeen(nonce)).toBe(true)
    // And it survives restart unchanged.
    const reloaded = new FileA2ASeenLedger(tmp.agentRoot)
    expect(reloaded.isSeen(nonce)).toBe(true)
  })

  it("never treats an empty-string nonce as seen (markSeen on '' is inert)", () => {
    tmp = createTmpBundle({ agentName: "seen-empty" })
    const ledger = new FileA2ASeenLedger(tmp.agentRoot)
    expect(ledger.isSeen("")).toBe(false)
    ledger.markSeen("")
    expect(ledger.isSeen("")).toBe(false)
  })

  it("treats a corrupt/unparseable ledger artifact as empty (does not crash on load)", () => {
    tmp = createTmpBundle({ agentName: "seen-corrupt" })
    const seenDir = path.join(tmp.agentRoot, "state", "a2a", "seen")
    fs.mkdirSync(seenDir, { recursive: true })
    fs.writeFileSync(path.join(seenDir, "garbage.json"), "{ not valid", "utf-8")

    const ledger = new FileA2ASeenLedger(tmp.agentRoot)
    // The corrupt artifact is ignored; the ledger still functions.
    expect(ledger.isSeen("nonce-after-corrupt")).toBe(false)
    ledger.markSeen("nonce-after-corrupt")
    expect(ledger.isSeen("nonce-after-corrupt")).toBe(true)
  })

  it("a missing ledger home is treated as empty (fresh agent, no prior seen-set)", () => {
    tmp = createTmpBundle({ agentName: "seen-missing" })
    // No seen dir pre-created; the constructor must tolerate it.
    const ledger = new FileA2ASeenLedger(tmp.agentRoot)
    expect(ledger.isSeen("anything")).toBe(false)
  })

  it("skips non-.json files and entries with no/blank nonce on load", () => {
    tmp = createTmpBundle({ agentName: "seen-skips" })
    const seenDir = path.join(tmp.agentRoot, "state", "a2a", "seen")
    fs.mkdirSync(seenDir, { recursive: true })
    // A stray non-json artifact is ignored.
    fs.writeFileSync(path.join(seenDir, "notes.txt"), "stray", "utf-8")
    // A json artifact whose nonce is blank is not loaded as a seen nonce.
    fs.writeFileSync(path.join(seenDir, "blank.json"), JSON.stringify({ nonce: "" }), "utf-8")

    const ledger = new FileA2ASeenLedger(tmp.agentRoot)
    expect(ledger.size).toBe(0)
    expect(ledger.isSeen("")).toBe(false)
  })

  it("drops entries marked longer ago than the freshness window on load, keeping recent and undated ones", () => {
    tmp = createTmpBundle({ agentName: "seen-prune" })
    const seenDir = path.join(tmp.agentRoot, "state", "a2a", "seen")
    fs.mkdirSync(seenDir, { recursive: true })
    const now = Date.parse("2026-11-20T00:00:00.000Z")
    const write = (name: string, record: unknown) => fs.writeFileSync(path.join(seenDir, name), JSON.stringify(record))
    write("old.json", { nonce: "old", markedAt: new Date(now - SEEN_RETENTION_MS - 1).toISOString() })
    write("edge.json", { nonce: "edge", markedAt: new Date(now - SEEN_RETENTION_MS).toISOString() })
    write("undated.json", { nonce: "undated" })
    write("garbled-date.json", { nonce: "garbled", markedAt: "not a date" })
    const ledger = new FileA2ASeenLedger(tmp.agentRoot, { now: () => now })
    expect(ledger.isSeen("old")).toBe(false)
    expect(fs.existsSync(path.join(seenDir, "old.json"))).toBe(false)
    for (const kept of ["edge", "undated", "garbled"]) expect(ledger.isSeen(kept)).toBe(true)
    expect(ledger.size).toBe(3)
    // Nothing stale: nothing is pruned, and the default clock is used.
    expect(new FileA2ASeenLedger(tmp.agentRoot).size).toBe(3)
  })

  it("prunes expired entries while the agent runs, on a new mark and at most once an hour", () => {
    tmp = createTmpBundle({ agentName: "seen-running-prune" })
    const seenDir = path.join(tmp.agentRoot, "state", "a2a", "seen")
    let clock = Date.parse("2026-11-01T00:00:00.000Z")
    const ledger = new FileA2ASeenLedger(tmp.agentRoot, { now: () => clock })
    ledger.markSeen("early")
    clock += SEEN_RETENTION_MS + 1
    // A new mark past the hourly interval drops the expired entry from memory and disk.
    ledger.markSeen("late")
    expect(ledger.isSeen("early")).toBe(false)
    expect(ledger.isSeen("late")).toBe(true)
    expect(fs.readdirSync(seenDir)).toHaveLength(1)
    expect(ledger.size).toBe(1)
  })

  it("prunes at most once an hour while running", () => {
    tmp = createTmpBundle({ agentName: "seen-hourly-prune" })
    const minute = 60 * 1000
    let clock = Date.parse("2026-11-01T00:00:00.000Z")
    const ledger = new FileA2ASeenLedger(tmp.agentRoot, { now: () => clock })
    ledger.markSeen("a")
    clock += SEEN_RETENTION_MS - 30 * minute
    ledger.markSeen("b") // prunes (more than an hour since start); "a" is not expired yet
    clock += 31 * minute
    ledger.markSeen("c") // "a" has expired, but the last prune was 31 minutes ago
    expect(ledger.isSeen("a")).toBe(true)
    clock += 30 * minute
    ledger.markSeen("d") // an hour since the last prune
    expect(ledger.isSeen("a")).toBe(false)
    expect(ledger.size).toBe(3)
    expect(SEEN_PRUNE_INTERVAL_MS).toBe(60 * minute)
  })

  it("clamps configured age windows to what the ledger keeps, and leaves windows inside it alone", () => {
    expect(bindingWindowsWithinRetention(undefined)).toEqual({})
    const inside = { now: 5, maxAgeMs: 60_000, delegatedMaxAgeMs: 60_000, maxFutureSkewMs: 1_000 }
    expect(bindingWindowsWithinRetention(inside)).toEqual(inside)
    const events = vi.spyOn(nerves, "emitNervesEvent")
    expect(bindingWindowsWithinRetention({ now: 5, maxAgeMs: MAX_ENVELOPE_AGE_MS * 2, delegatedMaxAgeMs: MAX_ENVELOPE_AGE_MS + 1, maxFutureSkewMs: MAX_FUTURE_SKEW_MS + 1 }))
      .toEqual({ now: 5, maxAgeMs: MAX_ENVELOPE_AGE_MS, delegatedMaxAgeMs: MAX_ENVELOPE_AGE_MS, maxFutureSkewMs: MAX_FUTURE_SKEW_MS })
    expect(events).toHaveBeenCalledWith(expect.objectContaining({ level: "warn", event: "channel.a2a_binding_window_clamped", meta: { fields: ["maxAgeMs", "delegatedMaxAgeMs", "maxFutureSkewMs"] } }))
    events.mockRestore()
  })

  it("keeps the retention at friends' 7-day freshness window plus its 2-minute future skew", () => {
    expect(SEEN_RETENTION_MS).toBe(7 * 24 * 60 * 60 * 1000 + 2 * 60 * 1000)
  })

  it("opens a private reply ledger and refuses one that group or other can reach, or a symlink", () => {
    tmp = createTmpBundle({ agentName: "seen-private" })
    const root = path.join(tmp.agentRoot, "reply-ledger")
    const ledger = openPrivateSeenLedger(root)
    ledger.markSeen("reply-1")
    expect(fs.statSync(root).mode & 0o777).toBe(0o700)
    expect(openPrivateSeenLedger(root).isSeen("reply-1")).toBe(true)
    fs.chmodSync(root, 0o755)
    expect(() => openPrivateSeenLedger(root)).toThrow(/must be a folder owned by you with mode 0700/)
    const link = path.join(tmp.agentRoot, "linked-ledger")
    fs.chmodSync(root, 0o700)
    fs.symlinkSync(root, link)
    expect(() => openPrivateSeenLedger(link)).toThrow(/must be a folder owned by you/)
  })
})

