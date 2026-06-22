import * as fs from "node:fs"
import * as path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { createTmpBundle, type TmpBundleHandle } from "../test-helpers/tmpdir-bundle"
import { FileA2ASeenLedger } from "../../a2a/seen-ledger"

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
    ledger.markSeen(nonce)
    expect(ledger.isSeen(nonce)).toBe(true)
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
})
