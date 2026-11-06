import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { computeSessionStats, formatStatsReport, runSessionStats, runSessionStatsCli } from "../../heart/session-stats"
import type { SessionEnvelope, SessionEvent } from "../../heart/session-events"

const tempFiles: string[] = []

function tempFile(content: unknown): string {
  const file = path.join(os.tmpdir(), `ouro-session-stats-${Date.now()}-${Math.random().toString(36).slice(2)}.json`)
  fs.writeFileSync(file, JSON.stringify(content))
  tempFiles.push(file)
  return file
}

afterEach(() => {
  for (const file of tempFiles.splice(0)) {
    try { fs.unlinkSync(file) } catch { /* ignore */ }
  }
})

function event(overrides: Partial<SessionEvent> = {}): SessionEvent {
  return {
    id: `evt_${Math.random().toString(36).slice(2)}`,
    sequence: 1,
    role: "user",
    content: "hi",
    name: null,
    toolCallId: null,
    toolCalls: [],
    attachments: [],
    time: { authoredAt: "2026-04-25T10:00:00.000Z", authoredAtSource: "unknown", observedAt: null, observedAtSource: "unknown" },
    relations: { /* shape varies; empty defensively */ } as any,
    provenance: { /* shape varies; empty defensively */ } as any,
    ...overrides,
  } as SessionEvent
}

function envelope(events: SessionEvent[], overrides: Partial<SessionEnvelope> = {}): SessionEnvelope {
  return {
    version: 2,
    events,
    projection: {
      eventIds: events.map((event) => event.id),
      trimmed: false,
      maxTokens: 200_000,
      contextMargin: 8_000,
      inputTokens: 12_345,
      projectedAt: "2026-04-25T11:00:00.000Z",
    },
    lastUsage: null,
    state: { /* shape varies */ } as any,
    ...overrides,
  } as SessionEnvelope
}

describe("computeSessionStats", () => {
  it("uses observed time when authored time is absent and ignores invalid authored time", () => {
    const env = envelope([
      event({ time: { authoredAt: null, authoredAtSource: "unknown", observedAt: "2026-04-25T11:30:00.000Z", observedAtSource: "unknown" } }),
      event({ time: { authoredAt: "invalid", authoredAtSource: "unknown", observedAt: "2026-04-25T09:00:00.000Z", observedAtSource: "unknown" } }),
      event(),
    ])
    expect(computeSessionStats(env, "/tmp/times").timeRange).toEqual({
      earliest: "2026-04-25T10:00:00.000Z", latest: "2026-04-25T11:30:00.000Z", durationMs: 5_400_000,
    })
  })

  it("keeps the existing defensive counter for a role supplied by an untyped caller", () => {
    const fromJavaScript = JSON.parse(JSON.stringify({ ...event(), role: "external" }))
    const stats = computeSessionStats(envelope([fromJavaScript]), "/tmp/external")
    expect(stats.totalEvents).toBe(1)
    expect(stats.byRole).toEqual({ system: 0, user: 0, assistant: 0, tool: 0, external: 1 })
  })

  it("counts events by role and rolls up tool calls", () => {
    const env = envelope([
      event({ role: "system" }),
      event({ role: "user" }),
      event({
        role: "assistant",
        toolCalls: [
          { id: "call_a", type: "function", function: { name: "shell", arguments: "{}" } },
          { id: "call_b", type: "function", function: { name: "read_file", arguments: "{}" } },
        ],
      }),
      event({ role: "tool", toolCallId: "call_a" }),
      event({ role: "tool", toolCallId: "call_b" }),
      event({
        role: "assistant",
        toolCalls: [{ id: "call_c", type: "function", function: { name: "shell", arguments: "{}" } }],
      }),
      event({ role: "tool", toolCallId: "call_c" }),
    ])
    const stats = computeSessionStats(env, "/tmp/x")
    expect(stats.byRole).toEqual({ system: 1, user: 1, assistant: 2, tool: 3 })
    expect(stats.toolCalls.total).toBe(3)
    expect(stats.toolCalls.distinctNames).toBe(2)
    expect(stats.toolCalls.topByFrequency).toEqual([
      { name: "shell", count: 2 },
      { name: "read_file", count: 1 },
    ])
  })

  it("derives time range and duration from authoredAt timestamps", () => {
    const env = envelope([
      event({ time: { authoredAt: "2026-04-25T10:00:00.000Z", authoredAtSource: "unknown", observedAt: null, observedAtSource: "unknown" } }),
      event({ time: { authoredAt: "2026-04-25T11:30:00.000Z", authoredAtSource: "unknown", observedAt: null, observedAtSource: "unknown" } }),
    ])
    const stats = computeSessionStats(env, "/tmp/x")
    expect(stats.timeRange.earliest).toBe("2026-04-25T10:00:00.000Z")
    expect(stats.timeRange.latest).toBe("2026-04-25T11:30:00.000Z")
    expect(stats.timeRange.durationMs).toBe(90 * 60_000)
  })

  it("handles events with no timestamps", () => {
    const env = envelope([
      event({ time: { authoredAt: null, authoredAtSource: "unknown", observedAt: null, observedAtSource: "unknown" } }),
    ])
    const stats = computeSessionStats(env, "/tmp/x")
    expect(stats.timeRange).toEqual({ earliest: null, latest: null, durationMs: null })
  })

  it("counts attachments across events", () => {
    const env = envelope([
      event({ attachments: ["a", "b"] }),
      event({ attachments: ["c"] }),
    ])
    expect(computeSessionStats(env, "/tmp/x").attachments).toBe(3)
  })

  it("reports projection omissions when projection.eventIds is shorter than events", () => {
    const events = [event({ id: "e1" }), event({ id: "e2" }), event({ id: "e3" })]
    const env = envelope(events)
    env.projection.eventIds = ["e1", "e2"]
    const stats = computeSessionStats(env, "/tmp/x")
    expect(stats.projection.eventCount).toBe(2)
    expect(stats.projection.omittedFromProjection).toBe(1)
  })
})

describe("runSessionStats / formatStatsReport / CLI", () => {
  it("D006 prints retained native counts separately from the active projection through the real CLI", () => {
    const env = envelope([
      event({ id: "e1", attachments: ["artifact-a"] }),
      event({ id: "e2", role: "assistant", toolCalls: [{ id: "call-1", type: "function", function: { name: "shell", arguments: "{}" } }] }),
      event({ id: "e3", role: "tool", toolCallId: "call-1", time: { authoredAt: "2026-04-25T10:00:02.000Z", authoredAtSource: "unknown", observedAt: null, observedAtSource: "unknown" } }),
    ])
    env.projection.eventIds = ["e2"]
    env.projection.trimmed = true
    env.lastUsage = { input_tokens: 7, output_tokens: 2, reasoning_tokens: 0, total_tokens: 9 }
    const file = tempFile(env)
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined)
    try {
      expect(runSessionStatsCli([file])).toBe(0)
      expect(log.mock.calls).toEqual([[
        [
          `Session stats: ${file}`,
          "  envelope version: 2",
          "  total events:     3",
          "  by role:          system=0 user=1 assistant=1 tool=1",
          "  tool calls:       1 (1 distinct names)",
          "  top tools:",
          "    shell: 1",
          "  attachments:      1",
          "  time range:       2026-04-25T10:00:00.000Z \u2192 2026-04-25T10:00:02.000Z (2s)",
          "  projection:",
          "    in projection:  1",
          "    omitted:        2",
          "    input tokens:   12345",
          "    max tokens:     200000",
          "    trimmed:        true",
          '  last usage:       {"input_tokens":7,"output_tokens":2,"reasoning_tokens":0,"total_tokens":9}',
        ].join("\n"),
      ]])
    } finally {
      log.mockRestore()
    }
  })

  it("formats an empty recognized session without inventing optional measurements", () => {
    const env = envelope([])
    env.projection.inputTokens = null
    env.projection.maxTokens = null
    expect(formatStatsReport(computeSessionStats(env, "/tmp/empty"))).toBe([
      "Session stats: /tmp/empty",
      "  envelope version: 2",
      "  total events:     0",
      "  by role:          system=0 user=0 assistant=0 tool=0",
      "  tool calls:       0 (0 distinct names)",
      "  attachments:      0",
      "  projection:",
      "    in projection:  0",
      "    omitted:        0",
    ].join("\n"))
  })

  it.each([
    { earliest: "2026-04-25T10:00:00.000Z", latest: null, expected: null },
    { earliest: null, latest: "2026-04-25T10:00:00.000Z", expected: null },
    { earliest: "2026-04-25T10:00:00.000Z", latest: "2026-04-25T10:01:00.000Z", expected: "  time range:       2026-04-25T10:00:00.000Z \u2192 2026-04-25T10:01:00.000Z" },
  ])("formats externally supplied time bounds without a duration: $earliest, $latest", ({ earliest, latest, expected }) => {
    const report = computeSessionStats(envelope([]), "/tmp/partial-time")
    report.timeRange = { earliest, latest, durationMs: null }
    expect(formatStatsReport(report).split("\n").filter((line) => line.includes("time range:"))).toEqual(expected === null ? [] : [expected])
  })

  it("handles explicit help without reading the supplied path", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined)
    try {
      expect(runSessionStatsCli(["not-a-session-file", "--help"])).toBe(0)
      expect(log).toHaveBeenCalledExactlyOnceWith("usage: ouro session-stats <session.json> [--json]")
    } finally {
      log.mockRestore()
    }
  })

  it("keeps filesystem and JSON failures visible rather than returning an empty report", () => {
    const file = tempFile({})
    fs.writeFileSync(file, '{"unfinished":')
    expect(() => runSessionStats(file)).toThrow(SyntaxError)
    fs.unlinkSync(file)
    expect(() => runSessionStats(file)).toThrow(/ENOENT/)
  })

  it("returns the unrecognized stub for an unparsable envelope", () => {
    const file = tempFile({ unrecognized: true })
    const stats = runSessionStats(file)
    expect(stats.envelopeVersion).toBeNull()
    expect(formatStatsReport(stats)).toContain("envelope: unrecognized")
  })

  it("prints help when CLI called with no args", () => {
    const logs: string[] = []
    const original = console.log
    console.log = (...args: unknown[]) => { logs.push(args.map(String).join(" ")) }
    try {
      const code = runSessionStatsCli([])
      expect(code).toBe(2)
      expect(logs.join("\n")).toContain("usage: ouro session-stats")
    } finally {
      console.log = original
    }
  })

  it("emits parseable JSON via --json", () => {
    const file = tempFile({
      version: 2,
      events: [
        { id: "e1", sequence: 1, role: "user", content: "hi", name: null, toolCallId: null, toolCalls: [], attachments: [], time: { authoredAt: "2026-04-25T10:00:00.000Z" } },
      ],
      projection: { eventIds: ["e1"], trimmed: false, maxTokens: null, contextMargin: null, inputTokens: null, projectedAt: null },
      lastUsage: null,
      state: {},
    })
    const logs: string[] = []
    const original = console.log
    console.log = (...args: unknown[]) => { logs.push(args.map(String).join(" ")) }
    try {
      const code = runSessionStatsCli([file, "--json"])
      expect(code).toBe(0)
      const parsed = JSON.parse(logs.join("\n"))
      expect(parsed.totalEvents).toBe(1)
      expect(parsed.byRole.user).toBe(1)
    } finally {
      console.log = original
    }
  })
})
