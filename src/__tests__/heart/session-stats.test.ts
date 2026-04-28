import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
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
