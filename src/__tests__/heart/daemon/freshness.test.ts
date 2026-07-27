import { describe, expect, it, vi } from "vitest"
import {
  DEFAULT_CLOCK_SKEW_TOLERANCE_MS,
  FRESHNESS_DAY_MS,
  FRESHNESS_HOUR_MS,
  FRESHNESS_MINUTE_MS,
  evaluateFreshness,
  formatFreshnessAge,
  formatFreshnessTimestamp,
  observeAppendPerEventStore,
  observeCreatePerEventStore,
  observeMirroredStore,
  resolveFreshnessThresholds,
  type FreshnessFsDeps,
  type FreshnessInput,
  type FreshnessThresholds,
} from "../../../heart/daemon/freshness"

const NOW_MS = Date.parse("2026-07-26T12:00:00.000Z")

const THRESHOLDS: FreshnessThresholds = {
  warnAfterMs: 24 * FRESHNESS_HOUR_MS,
  failAfterMs: 72 * FRESHNESS_HOUR_MS,
}

function baseInput(overrides: Partial<FreshnessInput> = {}): FreshnessInput {
  return {
    activity: "mail ingested",
    unit: "message",
    observation: { kind: "activity", atMs: NOW_MS },
    nowMs: NOW_MS,
    thresholds: THRESHOLDS,
    remediation: "check the mailbox grant",
    ...overrides,
  }
}

function fsDeps(overrides: Partial<FreshnessFsDeps> = {}): FreshnessFsDeps {
  return {
    existsSync: () => true,
    readdirSync: () => [],
    statSync: () => ({ mtimeMs: NOW_MS }),
    ...overrides,
  }
}

// ── formatting ──

describe("formatFreshnessAge", () => {
  it("renders sub-minute ages in seconds with correct pluralisation", () => {
    expect(formatFreshnessAge(0)).toBe("0 seconds")
    expect(formatFreshnessAge(1_000)).toBe("1 second")
    expect(formatFreshnessAge(59_000)).toBe("59 seconds")
  })

  it("clamps negative durations to zero rather than emitting a negative age", () => {
    expect(formatFreshnessAge(-5_000)).toBe("0 seconds")
  })

  it("renders minutes, hours and days, always rounding down", () => {
    expect(formatFreshnessAge(FRESHNESS_MINUTE_MS)).toBe("1 minute")
    expect(formatFreshnessAge(59 * FRESHNESS_MINUTE_MS + 59_000)).toBe("59 minutes")
    expect(formatFreshnessAge(FRESHNESS_HOUR_MS)).toBe("1 hour")
    expect(formatFreshnessAge(47 * FRESHNESS_HOUR_MS)).toBe("47 hours")
    expect(formatFreshnessAge(48 * FRESHNESS_HOUR_MS)).toBe("2 days")
    expect(formatFreshnessAge(77 * FRESHNESS_DAY_MS + 20 * FRESHNESS_HOUR_MS)).toBe("77 days")
  })

  it("keeps a single day in hours — the day bucket only starts at 48h", () => {
    expect(formatFreshnessAge(FRESHNESS_DAY_MS)).toBe("24 hours")
    expect(formatFreshnessAge(2 * FRESHNESS_DAY_MS)).toBe("2 days")
  })
})

describe("formatFreshnessTimestamp", () => {
  it("renders a minute-precision ISO instant that keeps the date visible", () => {
    expect(formatFreshnessTimestamp(Date.parse("2026-05-10T23:24:11.482Z"))).toBe("2026-05-10T23:24Z")
  })
})

// ── core evaluation ──

describe("evaluateFreshness", () => {
  it("passes when activity is inside the warn threshold", () => {
    const result = evaluateFreshness(baseInput({
      observation: { kind: "activity", atMs: NOW_MS - 30 * FRESHNESS_MINUTE_MS },
    }))

    expect(result.status).toBe("pass")
    expect(result.state).toBe("fresh")
    expect(result.ageMs).toBe(30 * FRESHNESS_MINUTE_MS)
    expect(result.detail).toBe("mail ingested 30 minutes ago (last message 2026-07-26T11:30Z)")
    expect(result.detail).not.toContain("fix:")
  })

  it("warns past the warn threshold and states the age plus a fix", () => {
    const result = evaluateFreshness(baseInput({
      observation: { kind: "activity", atMs: NOW_MS - 30 * FRESHNESS_HOUR_MS },
    }))

    expect(result.status).toBe("warn")
    expect(result.state).toBe("stale")
    expect(result.detail).toContain("no mail ingested in 30 hours")
    expect(result.detail).toContain("last message 2026-07-25T06:00Z")
    expect(result.detail).toContain("fix: check the mailbox grant")
  })

  it("fails past the fail threshold with the age in the message", () => {
    const result = evaluateFreshness(baseInput({
      observation: { kind: "activity", atMs: NOW_MS - 77 * FRESHNESS_DAY_MS },
      context: "mailbox configured",
      provenance: "derived from messages/ directory mtime",
    }))

    expect(result.status).toBe("fail")
    expect(result.state).toBe("stale")
    expect(result.ageMs).toBe(77 * FRESHNESS_DAY_MS)
    expect(result.detail).toBe([
      "mailbox configured",
      "no mail ingested in 77 days — last message 2026-05-10T12:00Z",
      "derived from messages/ directory mtime",
      "fix: check the mailbox grant",
    ].join("; "))
  })

  it("treats the warn and fail thresholds as inclusive boundaries", () => {
    const atWarn = evaluateFreshness(baseInput({
      observation: { kind: "activity", atMs: NOW_MS - THRESHOLDS.warnAfterMs },
    }))
    const atFail = evaluateFreshness(baseInput({
      observation: { kind: "activity", atMs: NOW_MS - THRESHOLDS.failAfterMs },
    }))

    expect(atWarn.status).toBe("warn")
    expect(atFail.status).toBe("fail")
  })

  it("keeps 'never observed' distinct from 'stale' and never reports it as ok", () => {
    const result = evaluateFreshness(baseInput({ observation: { kind: "none" } }))

    expect(result.status).toBe("fail")
    expect(result.state).toBe("never")
    expect(result.ageMs).toBeNull()
    expect(result.detail).toContain("no mail ingested ever — the store is readable and empty")
    expect(result.detail).toContain("fix: check the mailbox grant")
  })

  it("softens 'never observed' to a warning while the pipe is newly configured", () => {
    const result = evaluateFreshness(baseInput({
      observation: { kind: "none" },
      configuredSinceMs: NOW_MS - 10 * FRESHNESS_MINUTE_MS,
    }))

    expect(result.status).toBe("warn")
    expect(result.state).toBe("never")
    expect(result.detail).toContain("has been configured for 10 minutes")
  })

  it("escalates 'never observed' once the pipe has been configured past a threshold", () => {
    const warned = evaluateFreshness(baseInput({
      observation: { kind: "none" },
      configuredSinceMs: NOW_MS - 30 * FRESHNESS_HOUR_MS,
    }))
    const failed = evaluateFreshness(baseInput({
      observation: { kind: "none" },
      configuredSinceMs: NOW_MS - 90 * FRESHNESS_HOUR_MS,
    }))

    expect(warned.status).toBe("warn")
    expect(failed.status).toBe("fail")
    expect(failed.detail).toContain("has been configured for 3 days")
  })

  it("ignores a non-finite configuredSinceMs instead of producing NaN ages", () => {
    const result = evaluateFreshness(baseInput({
      observation: { kind: "none" },
      configuredSinceMs: Number.NaN,
    }))

    expect(result.status).toBe("fail")
    expect(result.detail).toContain("the store is readable and empty")
    expect(result.detail).not.toContain("configured for")
  })

  it("clamps a future configuredSinceMs to a zero-length configured window", () => {
    const result = evaluateFreshness(baseInput({
      observation: { kind: "none" },
      configuredSinceMs: NOW_MS + FRESHNESS_DAY_MS,
    }))

    expect(result.status).toBe("warn")
    expect(result.detail).toContain("has been configured for 0 seconds")
  })

  it("fails loudly when the store could not be observed at all", () => {
    const result = evaluateFreshness(baseInput({
      observation: { kind: "unknown", reason: "EACCES" },
    }))

    expect(result.status).toBe("fail")
    expect(result.state).toBe("unknown")
    expect(result.ageMs).toBeNull()
    expect(result.detail).toContain("mail ingested: last-activity time could not be determined — EACCES")
    expect(result.detail).toContain("unverified, not healthy")
  })

  it("downgrades a non-finite activity timestamp to the unknown state", () => {
    const result = evaluateFreshness(baseInput({
      observation: { kind: "activity", atMs: Number.NaN },
    }))

    expect(result.status).toBe("fail")
    expect(result.state).toBe("unknown")
    expect(result.detail).toContain("observed timestamp is not a finite epoch-ms value (NaN)")
  })

  it("absorbs sub-tolerance clock skew as fresh", () => {
    const result = evaluateFreshness(baseInput({
      observation: { kind: "activity", atMs: NOW_MS + DEFAULT_CLOCK_SKEW_TOLERANCE_MS },
    }))

    expect(result.status).toBe("pass")
    expect(result.state).toBe("fresh")
    expect(result.ageMs).toBe(0)
  })

  it("warns rather than silently passing when a timestamp is far in the future", () => {
    const result = evaluateFreshness(baseInput({
      observation: { kind: "activity", atMs: NOW_MS + 3 * FRESHNESS_DAY_MS },
    }))

    expect(result.status).toBe("warn")
    expect(result.state).toBe("future")
    expect(result.ageMs).toBe(0)
    expect(result.detail).toContain("is timestamped 2026-07-29T12:00Z, 3 days in the future")
    expect(result.detail).toContain("clock skew means freshness cannot be trusted")
    expect(result.detail).toContain("fix: check the mailbox grant")
  })

  it("honours an explicit clock-skew tolerance override", () => {
    const result = evaluateFreshness(baseInput({
      observation: { kind: "activity", atMs: NOW_MS + 10 * FRESHNESS_MINUTE_MS },
      clockSkewToleranceMs: 30 * FRESHNESS_MINUTE_MS,
    }))

    expect(result.status).toBe("pass")
    expect(result.state).toBe("fresh")
  })

  it("drops blank context and provenance fragments from the detail", () => {
    const result = evaluateFreshness(baseInput({
      observation: { kind: "activity", atMs: NOW_MS },
      context: "   ",
      provenance: "",
    }))

    expect(result.detail).toBe("mail ingested 0 seconds ago (last message 2026-07-26T12:00Z)")
  })
})

// ── create-per-event stores (mailroom messages/) ──

describe("observeCreatePerEventStore", () => {
  it("reports the directory mtime without stat'ing a single entry", () => {
    const statSync = vi.fn(() => ({ mtimeMs: NOW_MS - FRESHNESS_HOUR_MS }))
    const probe = observeCreatePerEventStore("/store/messages", fsDeps({ statSync }), { hasEntries: true })

    expect(probe.observation).toEqual({ kind: "activity", atMs: NOW_MS - FRESHNESS_HOUR_MS })
    expect(statSync).toHaveBeenCalledTimes(1)
    expect(statSync).toHaveBeenCalledWith("/store/messages")
    expect(probe.provenance).toContain("O(1), no per-entry scan")
  })

  it("reports 'none' when the store directory does not exist", () => {
    const probe = observeCreatePerEventStore("/store/messages", fsDeps({ existsSync: () => false }), { hasEntries: false })

    expect(probe.observation).toEqual({ kind: "none" })
    expect(probe.provenance).toBe("/store/messages does not exist")
  })

  it("reports 'none' for an existing but empty store rather than its own creation time", () => {
    const probe = observeCreatePerEventStore("/store/messages", fsDeps(), { hasEntries: false })

    expect(probe.observation).toEqual({ kind: "none" })
    expect(probe.provenance).toBe("/store/messages is empty")
  })

  it("reports 'unknown' when the directory cannot be stat'd", () => {
    const probe = observeCreatePerEventStore("/store/messages", fsDeps({
      statSync: () => { throw new Error("EACCES") },
    }), { hasEntries: true })

    expect(probe.observation).toEqual({ kind: "unknown", reason: "/store/messages could not be stat'd: EACCES" })
  })

  it("stringifies non-Error stat failures", () => {
    const probe = observeCreatePerEventStore("/store/messages", fsDeps({
      statSync: () => { throw "boom" },
    }), { hasEntries: true })

    expect(probe.observation).toEqual({ kind: "unknown", reason: "/store/messages could not be stat'd: boom" })
  })
})

// ── mirrors of remote stores (hosted mailroom → state/mail-search/) ──

describe("observeMirroredStore", () => {
  const remote = "hosted azure-blob https://acct.blob.core.windows.net/mailroom"

  it("reports the mirror's directory mtime without stat'ing a single entry", () => {
    const statSync = vi.fn(() => ({ mtimeMs: NOW_MS - FRESHNESS_HOUR_MS }))
    const probe = observeMirroredStore("/bundle/state/mail-search", fsDeps({ statSync }), { hasEntries: true, remote })

    expect(probe.observation).toEqual({ kind: "activity", atMs: NOW_MS - FRESHNESS_HOUR_MS })
    expect(statSync).toHaveBeenCalledTimes(1)
    expect(statSync).toHaveBeenCalledWith("/bundle/state/mail-search")
    expect(probe.provenance).toContain("derived from the local mirror at /bundle/state/mail-search")
    expect(probe.provenance).toContain(`the authoritative store is ${remote}, which doctor does not read`)
  })

  it("reports 'unknown' — never 'none' — for an absent mirror, because the remote store is unread", () => {
    const probe = observeMirroredStore("/bundle/state/mail-search", fsDeps({ existsSync: () => false }), {
      hasEntries: false,
      remote,
    })

    expect(probe.observation).toEqual({
      kind: "unknown",
      reason: `the local mirror at /bundle/state/mail-search is absent, and ${remote} is not read by doctor (no network calls, no credentials), so recency cannot be measured on this machine`,
    })
  })

  it("reports 'unknown' for an empty mirror rather than claiming the remote store never delivered", () => {
    const probe = observeMirroredStore("/bundle/state/mail-search", fsDeps(), { hasEntries: false, remote })

    expect(probe.observation).toEqual({
      kind: "unknown",
      reason: `the local mirror at /bundle/state/mail-search is empty, and ${remote} is not read by doctor (no network calls, no credentials), so recency cannot be measured on this machine`,
    })
  })

  it("reports 'unknown' when the mirror directory cannot be stat'd", () => {
    const probe = observeMirroredStore("/bundle/state/mail-search", fsDeps({
      statSync: () => { throw new Error("EACCES") },
    }), { hasEntries: true, remote })

    expect(probe.observation).toEqual({
      kind: "unknown",
      reason: "/bundle/state/mail-search could not be stat'd: EACCES",
    })
  })

  it("stringifies non-Error stat failures", () => {
    const probe = observeMirroredStore("/bundle/state/mail-search", fsDeps({
      statSync: () => { throw "boom" },
    }), { hasEntries: true, remote })

    expect(probe.observation).toEqual({
      kind: "unknown",
      reason: "/bundle/state/mail-search could not be stat'd: boom",
    })
  })

  it("never returns pass-eligible states for an unobservable mirror", () => {
    for (const deps of [fsDeps({ existsSync: () => false }), fsDeps()]) {
      const probe = observeMirroredStore("/bundle/state/mail-search", deps, { hasEntries: false, remote })
      const result = evaluateFreshness(baseInput({ observation: probe.observation, provenance: probe.provenance }))

      expect(result.status).toBe("fail")
      expect(result.state).toBe("unknown")
      expect(result.detail).toContain("unverified, not healthy")
    }
  })
})

// ── append-per-event stores (bluebubbles inbound/*.ndjson) ──

describe("observeAppendPerEventStore", () => {
  const options = { suffix: ".ndjson", maxEntries: 3 }

  it("takes the newest mtime across the append-only logs", () => {
    const mtimes: Record<string, number> = {
      "/inbound/a.ndjson": NOW_MS - 5 * FRESHNESS_DAY_MS,
      "/inbound/b.ndjson": NOW_MS - FRESHNESS_HOUR_MS,
      "/inbound/c.ndjson": NOW_MS - 2 * FRESHNESS_DAY_MS,
    }
    const probe = observeAppendPerEventStore("/inbound", fsDeps({
      readdirSync: () => ["a.ndjson", "b.ndjson", "c.ndjson", "notes.txt"],
      statSync: (p) => ({ mtimeMs: mtimes[p] }),
    }), options)

    expect(probe.observation).toEqual({ kind: "activity", atMs: NOW_MS - FRESHNESS_HOUR_MS })
    expect(probe.provenance).toBe("newest mtime across 3 .ndjson logs in /inbound")
  })

  it("pluralises a single log correctly", () => {
    const probe = observeAppendPerEventStore("/inbound", fsDeps({
      readdirSync: () => ["only.ndjson"],
      statSync: () => ({ mtimeMs: NOW_MS }),
    }), options)

    expect(probe.provenance).toBe("newest mtime across 1 .ndjson log in /inbound")
  })

  it("reports 'none' when the inbound directory does not exist", () => {
    const probe = observeAppendPerEventStore("/inbound", fsDeps({ existsSync: () => false }), options)

    expect(probe.observation).toEqual({ kind: "none" })
    expect(probe.provenance).toBe("/inbound does not exist")
  })

  it("reports 'none' when the directory holds no matching logs", () => {
    const probe = observeAppendPerEventStore("/inbound", fsDeps({ readdirSync: () => ["README.md"] }), options)

    expect(probe.observation).toEqual({ kind: "none" })
    expect(probe.provenance).toBe("/inbound holds no .ndjson logs")
  })

  it("reports 'unknown' when the directory cannot be listed", () => {
    const probe = observeAppendPerEventStore("/inbound", fsDeps({
      readdirSync: () => { throw new Error("EPERM") },
    }), options)

    expect(probe.observation).toEqual({ kind: "unknown", reason: "/inbound could not be listed: EPERM" })
    expect(probe.provenance).toBe("attempted directory listing of /inbound")
  })

  it("stringifies non-Error listing failures", () => {
    const probe = observeAppendPerEventStore("/inbound", fsDeps({
      readdirSync: () => { throw "nope" },
    }), options)

    expect(probe.observation).toEqual({ kind: "unknown", reason: "/inbound could not be listed: nope" })
  })

  it("says so in the provenance when the scan is bounded, instead of sampling silently", () => {
    const probe = observeAppendPerEventStore("/inbound", fsDeps({
      readdirSync: () => ["a.ndjson", "b.ndjson", "c.ndjson", "d.ndjson", "e.ndjson"],
      statSync: () => ({ mtimeMs: NOW_MS }),
    }), options)

    expect(probe.provenance).toBe(
      "newest mtime across the first 3 of 5 .ndjson logs in /inbound — scan bounded, newer activity may exist in the unscanned 2",
    )
  })

  it("skips unreadable logs but records how many were skipped", () => {
    const probe = observeAppendPerEventStore("/inbound", fsDeps({
      readdirSync: () => ["a.ndjson", "b.ndjson"],
      statSync: (p) => {
        if (p === "/inbound/a.ndjson") throw new Error("EACCES")
        return { mtimeMs: NOW_MS - FRESHNESS_HOUR_MS }
      },
    }), options)

    expect(probe.observation).toEqual({ kind: "activity", atMs: NOW_MS - FRESHNESS_HOUR_MS })
    expect(probe.provenance).toContain("(1 unreadable and skipped)")
  })

  it("reports 'unknown' when no log in the directory can be stat'd", () => {
    const probe = observeAppendPerEventStore("/inbound", fsDeps({
      readdirSync: () => ["a.ndjson"],
      statSync: () => { throw "denied" },
    }), options)

    expect(probe.observation).toEqual({
      kind: "unknown",
      reason: "none of the 1 log(s) in /inbound could be stat'd: a.ndjson: denied",
    })
  })
})

// ── threshold configuration ──

describe("resolveFreshnessThresholds", () => {
  it("returns the defaults when there is no override", () => {
    expect(resolveFreshnessThresholds(THRESHOLDS, undefined)).toEqual(THRESHOLDS)
    expect(resolveFreshnessThresholds(THRESHOLDS, null)).toEqual(THRESHOLDS)
    expect(resolveFreshnessThresholds(THRESHOLDS, [1, 2])).toEqual(THRESHOLDS)
  })

  it("applies hour-denominated overrides from agent.json", () => {
    expect(resolveFreshnessThresholds(THRESHOLDS, { warnAfterHours: 6, failAfterHours: 12 })).toEqual({
      warnAfterMs: 6 * FRESHNESS_HOUR_MS,
      failAfterMs: 12 * FRESHNESS_HOUR_MS,
    })
  })

  it("applies a partial override and keeps the other default", () => {
    expect(resolveFreshnessThresholds(THRESHOLDS, { failAfterHours: 12 })).toEqual({
      warnAfterMs: THRESHOLDS.warnAfterMs,
      failAfterMs: 12 * FRESHNESS_HOUR_MS,
    })
  })

  it("ignores malformed overrides so the check can never be disabled by bad config", () => {
    expect(resolveFreshnessThresholds(THRESHOLDS, {
      warnAfterHours: 0,
      failAfterHours: "48",
    })).toEqual(THRESHOLDS)
    expect(resolveFreshnessThresholds(THRESHOLDS, {
      warnAfterHours: -1,
      failAfterHours: Number.POSITIVE_INFINITY,
    })).toEqual(THRESHOLDS)
  })
})
