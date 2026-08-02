import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { formatNerveEntry, parseDuration, reviewNerveEvents } from "../../nerves/review/core"
import { runNervesReviewCli } from "../../nerves/review/cli"

const tempFiles: string[] = []

function tempFile(lines: string[]): string {
  const file = path.join(os.tmpdir(), `ouro-nerves-review-${Date.now()}-${Math.random().toString(36).slice(2)}.ndjson`)
  fs.writeFileSync(file, `${lines.join("\n")}\n`)
  tempFiles.push(file)
  return file
}

afterEach(() => {
  for (const file of tempFiles.splice(0)) {
    try { fs.unlinkSync(file) } catch { /* ignore */ }
  }
})

const eventLine = (overrides: Record<string, unknown> = {}): string => JSON.stringify({
  ts: "2026-04-25T12:00:00.000Z",
  level: "info",
  component: "senses",
  event: "senses.bluebubbles_from_me_ignored",
  message: "ignored",
  ...overrides,
})

describe("parseDuration", () => {
  it("parses durations with all supported units", () => {
    expect(parseDuration("500ms")).toBe(500)
    expect(parseDuration("2s")).toBe(2_000)
    expect(parseDuration("5m")).toBe(300_000)
    expect(parseDuration("1.5h")).toBe(5_400_000)
    expect(parseDuration("2d")).toBe(172_800_000)
  })
  it("returns null for malformed inputs", () => {
    expect(parseDuration("foo")).toBeNull()
    expect(parseDuration("")).toBeNull()
    expect(parseDuration("-5m")).toBeNull()
    expect(parseDuration("5y")).toBeNull()
  })
})

describe("reviewNerveEvents", () => {
  it("returns the most recent N events when no filter is set", () => {
    const file = tempFile([
      eventLine({ event: "a", ts: "2026-04-25T11:00:00.000Z" }),
      eventLine({ event: "b", ts: "2026-04-25T11:05:00.000Z" }),
      eventLine({ event: "c", ts: "2026-04-25T11:10:00.000Z" }),
    ])
    const result = reviewNerveEvents(file, { limit: 10 })
    expect(result.map((entry) => entry.parsed?.event)).toEqual(["a", "b", "c"])
  })

  it("filters by component substring (case-insensitive)", () => {
    const file = tempFile([
      eventLine({ component: "senses" }),
      eventLine({ component: "mind" }),
      eventLine({ component: "Senses-bluebubbles" }),
    ])
    const result = reviewNerveEvents(file, { componentSubstring: "senses" })
    expect(result).toHaveLength(2)
  })

  it("filters by event substring", () => {
    const file = tempFile([
      eventLine({ event: "engine.foo" }),
      eventLine({ event: "engine.bar" }),
      eventLine({ event: "senses.foo" }),
    ])
    const result = reviewNerveEvents(file, { eventSubstring: "engine" })
    expect(result).toHaveLength(2)
  })

  it("filters by level (exact match)", () => {
    const file = tempFile([
      eventLine({ level: "info" }),
      eventLine({ level: "warn" }),
      eventLine({ level: "warn" }),
    ])
    const result = reviewNerveEvents(file, { level: "warn" })
    expect(result).toHaveLength(2)
  })

  it("filters by sinceMs window", () => {
    const file = tempFile([
      eventLine({ ts: "2026-04-25T10:00:00.000Z" }),
      eventLine({ ts: "2026-04-25T11:55:00.000Z" }),
      eventLine({ ts: "2026-04-25T11:59:00.000Z" }),
    ])
    const nowMs = Date.parse("2026-04-25T12:00:00.000Z")
    const result = reviewNerveEvents(file, { sinceMs: 10 * 60_000, nowMs })
    expect(result).toHaveLength(2)
  })

  it("falls back to legacy time only when canonical ts is absent", () => {
    const file = tempFile([
      eventLine({ event: "canonical-old", ts: "2026-04-25T10:00:00.000Z", time: "2026-04-25T11:59:00.000Z" }),
      eventLine({ event: "canonical-recent", ts: "2026-04-25T11:59:00.000Z", time: "2026-04-25T10:00:00.000Z" }),
      eventLine({ event: "malformed-canonical", ts: "not-a-time", time: "2026-04-25T11:59:00.000Z" }),
      eventLine({ event: "non-string-canonical", ts: 123, time: "2026-04-25T11:59:00.000Z" }),
      eventLine({ event: "legacy-recent", ts: undefined, time: "2026-04-25T11:58:00.000Z" }),
      eventLine({ event: "missing-timestamp", ts: undefined, time: undefined }),
    ])
    const nowMs = Date.parse("2026-04-25T12:00:00.000Z")

    const result = reviewNerveEvents(file, { sinceMs: 10 * 60_000, nowMs })

    expect(result.map((entry) => entry.parsed?.event)).toEqual(["canonical-recent", "legacy-recent"])
  })

  it("respects the limit and returns the most recent matches", () => {
    const lines = Array.from({ length: 100 }, (_, i) =>
      eventLine({ event: `evt-${i}`, ts: `2026-04-25T${String(10 + Math.floor(i / 60)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}:00.000Z` }),
    )
    const file = tempFile(lines)
    const result = reviewNerveEvents(file, { limit: 5 })
    expect(result).toHaveLength(5)
    expect(result.map((entry) => entry.parsed?.event)).toEqual([
      "evt-95", "evt-96", "evt-97", "evt-98", "evt-99",
    ])
  })

  it("ignores malformed JSON lines and missing files gracefully", () => {
    const file = tempFile([
      "not-json",
      eventLine({ event: "valid" }),
      "{}", // valid JSON but no event field — passes through as parsed
    ])
    const result = reviewNerveEvents(file)
    expect(result.length).toBeGreaterThanOrEqual(1)
    expect(reviewNerveEvents("/path/that/does/not/exist.ndjson")).toEqual([])
  })

  it("formats a parsed legacy entry with time, level, component/event, and message", () => {
    const entry = { raw: "{}", parsed: { time: "T", level: "warn", component: "senses", event: "x.y", message: "m" } }
    expect(formatNerveEntry(entry as any)).toBe("T [warn ] senses/x.y — m")
  })

  it("formats canonical ts with precedence over legacy time", () => {
    const entry = {
      raw: "{}",
      parsed: {
        ts: "2026-04-25T12:00:00.000Z",
        time: "legacy-must-not-win",
        level: "info",
        component: "daemon",
        event: "daemon.ready",
        message: "ready",
      },
    }
    expect(formatNerveEntry(entry)).toBe("2026-04-25T12:00:00.000Z [info ] daemon/daemon.ready — ready")
  })

  it("does not format legacy time when a malformed canonical ts is present", () => {
    const entry = {
      raw: "{}",
      parsed: { ts: "not-a-time", time: "legacy-must-not-win", component: "daemon", event: "daemon.bad_ts" },
    }
    expect(formatNerveEntry(entry)).toBe("not-a-time [info ] daemon/daemon.bad_ts — ")
    expect(formatNerveEntry({
      raw: "{}",
      parsed: { ts: 123, time: "legacy-must-not-win", component: "daemon", event: "daemon.non_string_ts" },
    })).toBe(" [info ] daemon/daemon.non_string_ts — ")
  })
})

describe("runNervesReviewCli", () => {
  it("prints help when --help is passed", () => {
    const logs: string[] = []
    const original = console.log
    console.log = (...args: unknown[]) => { logs.push(args.map(String).join(" ")) }
    try {
      const code = runNervesReviewCli(["--help"])
      expect(code).toBe(0)
      expect(logs.join("\n")).toContain("usage: ouro nerves-review")
      expect(logs.join("\n")).toContain("default: ouro")
    } finally {
      console.log = original
    }
  })

  it("rejects an invalid --since duration", () => {
    const logs: string[] = []
    const original = console.error
    console.error = (...args: unknown[]) => { logs.push(args.map(String).join(" ")) }
    try {
      const code = runNervesReviewCli(["--since", "garbage"])
      expect(code).toBe(2)
      expect(logs.join("\n")).toContain("not a valid duration")
    } finally {
      console.error = original
    }
  })
})
