import { describe, it, expect } from "vitest"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import {
  checkBundleSyncHealth,
  describeSkippedFiles,
  describeSyncFailure,
  formatMegabytes,
  parseBundleSyncFailure,
  parseBundleSyncSkippedFiles,
  readBundleSyncHealth,
  summarizeSyncError,
} from "../../heart/sync-health"

function makeBundles(records: Record<string, { pending?: unknown; skipped?: unknown }>): string {
  const bundlesRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sync-health-"))
  for (const [agent, record] of Object.entries(records)) {
    const stateDir = path.join(bundlesRoot, `${agent}.ouro`, "state")
    fs.mkdirSync(stateDir, { recursive: true })
    if (record.pending !== undefined) fs.writeFileSync(path.join(stateDir, "pending-sync.json"), JSON.stringify(record.pending), "utf-8")
    if (record.skipped !== undefined) fs.writeFileSync(path.join(stateDir, "sync-skipped-files.json"), JSON.stringify(record.skipped), "utf-8")
  }
  return bundlesRoot
}

const MiB = 1024 * 1024

describe("readBundleSyncHealth", () => {
  it("reads a failing sync and its skipped files", () => {
    const bundlesRoot = makeBundles({
      ouroboros: {
        pending: {
          error: "Command failed: git push origin\nremote: error: GH001: Large files detected.",
          failedAt: "2026-10-10T00:00:00.000Z",
          firstFailedAt: "2026-06-21T22:00:00.000Z",
          consecutiveFailures: 5189,
          classification: "unknown",
          conflictFiles: [],
        },
        skipped: { updatedAt: "2026-10-10T00:00:00.000Z", limitBytes: 50 * MiB, files: [{ path: "arc/big.jsonl", bytes: 110 * MiB }] },
      },
    })

    expect(readBundleSyncHealth(path.join(bundlesRoot, "ouroboros.ouro"))).toEqual({
      failure: {
        error: "Command failed: git push origin\nremote: error: GH001: Large files detected.",
        classification: "unknown",
        firstFailedAt: "2026-06-21T22:00:00.000Z",
        lastFailedAt: "2026-10-10T00:00:00.000Z",
        consecutiveFailures: 5189,
      },
      skippedFiles: [{ path: "arc/big.jsonl", bytes: 110 * MiB }],
    })
    fs.rmSync(bundlesRoot, { recursive: true, force: true })
  })

  it("reads a healthy bundle as no failure and no skipped files", () => {
    const bundlesRoot = makeBundles({ slugger: {} })
    expect(readBundleSyncHealth(path.join(bundlesRoot, "slugger.ouro"))).toEqual({ failure: null, skippedFiles: [] })
    fs.rmSync(bundlesRoot, { recursive: true, force: true })
  })

  it("uses an injected reader", () => {
    const health = readBundleSyncHealth("/fake", {
      readFileSync: (p) => (p.endsWith("pending-sync.json") ? JSON.stringify({ error: "boom" }) : "not json"),
    })
    expect(health.failure).toEqual({
      error: "boom",
      classification: "unknown",
      firstFailedAt: "unknown",
      lastFailedAt: "unknown",
      consecutiveFailures: 1,
    })
    expect(health.skippedFiles).toEqual([])
  })
})

describe("parseBundleSyncFailure", () => {
  it("rejects values that are not failure records", () => {
    expect(parseBundleSyncFailure(null)).toBeNull()
    expect(parseBundleSyncFailure([])).toBeNull()
    expect(parseBundleSyncFailure({ sync: { enabled: true } })).toBeNull()
  })

  it("accepts the status shape with lastFailedAt", () => {
    expect(parseBundleSyncFailure({
      error: "e",
      classification: "auth-failed",
      lastFailedAt: "2026-10-01T00:00:00.000Z",
      consecutiveFailures: 0,
    })).toEqual({
      error: "e",
      classification: "auth-failed",
      firstFailedAt: "2026-10-01T00:00:00.000Z",
      lastFailedAt: "2026-10-01T00:00:00.000Z",
      consecutiveFailures: 1,
    })
  })
})

describe("parseBundleSyncSkippedFiles", () => {
  it("accepts a bare array and drops malformed entries", () => {
    expect(parseBundleSyncSkippedFiles([{ path: "a", bytes: 1 }, null, { path: "b" }, "c"])).toEqual([{ path: "a", bytes: 1 }])
  })

  it("returns nothing for a record without files", () => {
    expect(parseBundleSyncSkippedFiles({ files: "no" })).toEqual([])
    expect(parseBundleSyncSkippedFiles(undefined)).toEqual([])
  })
})

describe("sync health text", () => {
  it("summarizes the first non-empty line of a git error and caps its length", () => {
    expect(summarizeSyncError("\n  fatal: denied  \nmore")).toBe("fatal: denied")
    expect(summarizeSyncError("")).toBe("unknown")
    const long = summarizeSyncError("x".repeat(200))
    expect(long).toHaveLength(160)
    expect(long.endsWith("...")).toBe(true)
  })

  it("formats sizes in MiB", () => {
    expect(formatMegabytes(110 * MiB)).toBe("110.0 MiB")
  })

  it("describes a failure with its start date and attempt count", () => {
    expect(describeSyncFailure({
      error: "push rejected",
      classification: "unknown",
      firstFailedAt: "2026-06-21T22:00:00.000Z",
      lastFailedAt: "2026-10-10T00:00:00.000Z",
      consecutiveFailures: 3,
    })).toBe("sync failing since 2026-06-21T22:00:00.000Z (3 attempt(s)): push rejected")
  })

  it("lists up to three skipped files and counts the rest", () => {
    expect(describeSkippedFiles([{ path: "a", bytes: MiB }])).toBe("1 file(s) too large to sync left uncommitted: a (1.0 MiB)")
    const files = ["a", "b", "c", "d", "e"].map((name) => ({ path: name, bytes: MiB }))
    expect(describeSkippedFiles(files)).toBe(
      "5 file(s) too large to sync left uncommitted: a (1.0 MiB), b (1.0 MiB), c (1.0 MiB), and 2 more",
    )
  })
})

describe("checkBundleSyncHealth", () => {
  it("is ok when no sync-enabled bundle has a problem", () => {
    expect(checkBundleSyncHealth([
      { agent: "ouroboros", enabled: true },
      { agent: "slugger", enabled: true, skippedFiles: [] },
      { agent: "off", enabled: false, failure: { error: "x", classification: "unknown", firstFailedAt: "t", lastFailedAt: "t", consecutiveFailures: 1 } },
    ])).toEqual({ name: "bundle-sync", status: "ok", message: "bundle sync healthy" })
  })

  it("warns, naming each agent, when a sync is failing or files are skipped", () => {
    expect(checkBundleSyncHealth([
      {
        agent: "ouroboros",
        enabled: true,
        failure: { error: "push rejected", classification: "unknown", firstFailedAt: "2026-10-10T00:00:00.000Z", lastFailedAt: "2026-10-10T00:00:00.000Z", consecutiveFailures: 1 },
      },
      { agent: "slugger", enabled: true, skippedFiles: [{ path: "big.bin", bytes: 60 * MiB }] },
    ])).toEqual({
      name: "bundle-sync",
      status: "warn",
      message: "ouroboros: sync failing since 2026-10-10T00:00:00.000Z (1 attempt(s)): push rejected; "
        + "slugger: 1 file(s) too large to sync left uncommitted: big.bin (60.0 MiB)",
    })
  })
})
