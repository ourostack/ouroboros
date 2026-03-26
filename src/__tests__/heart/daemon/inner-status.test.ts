import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("../../../nerves/runtime", () => ({
  emitNervesEvent: vi.fn(),
}))

import { emitNervesEvent } from "../../../nerves/runtime"

describe("ouro inner status", () => {
  let buildInnerStatusOutput: typeof import("../../../heart/daemon/inner-status").buildInnerStatusOutput

  beforeEach(async () => {
    vi.resetModules()
    const mod = await import("../../../heart/daemon/inner-status")
    buildInnerStatusOutput = mod.buildInnerStatusOutput
  })

  it("is exported from inner-status module", async () => {
    const mod = await import("../../../heart/daemon/inner-status")
    expect(mod.buildInnerStatusOutput).toBeDefined()
    expect(typeof mod.buildInnerStatusOutput).toBe("function")
  })

  it("shows full status when all data present", () => {
    const now = new Date("2026-03-26T10:30:00Z").getTime()
    const result = buildInnerStatusOutput({
      agentName: "slugger",
      runtimeState: {
        status: "idle",
        reason: "heartbeat",
        lastCompletedAt: "2026-03-26T10:18:00Z",
      },
      journalFiles: [
        { name: "auth-migration.md", mtimeMs: now - 2 * 60 * 60 * 1000 },
        { name: "trust-patterns.md", mtimeMs: now - 26 * 60 * 60 * 1000 },
      ],
      heartbeat: {
        cadenceMs: 30 * 60 * 1000,
        lastCompletedAt: new Date("2026-03-26T10:18:00Z").getTime(),
      },
      attentionCount: 0,
      now,
    })

    expect(result).toContain("inner dialog status: slugger")
    expect(result).toContain("last turn: 12 minutes ago (heartbeat)")
    expect(result).toContain("status: idle")
    expect(result).toContain("heartbeat: healthy")
    expect(result).toContain("auth-migration.md")
    expect(result).toContain("trust-patterns.md")
    expect(result).toContain("attention: 0 held thoughts")
    expect(emitNervesEvent).toHaveBeenCalledWith(expect.objectContaining({
      event: "daemon.inner_status_read",
      component: "daemon",
    }))
  })

  it("shows running status with reason", () => {
    const now = new Date("2026-03-26T10:30:00Z").getTime()
    const result = buildInnerStatusOutput({
      agentName: "slugger",
      runtimeState: {
        status: "running",
        reason: "instinct",
        startedAt: "2026-03-26T10:28:00Z",
      },
      journalFiles: [],
      heartbeat: null,
      attentionCount: 2,
      now,
    })

    expect(result).toContain("status: running (instinct)")
    expect(result).toContain("attention: 2 held thoughts")
  })

  it("handles missing runtime.json (no state)", () => {
    const now = Date.now()
    const result = buildInnerStatusOutput({
      agentName: "slugger",
      runtimeState: null,
      journalFiles: [],
      heartbeat: null,
      attentionCount: 0,
      now,
    })

    expect(result).toContain("inner dialog status: slugger")
    expect(result).toContain("last turn: unknown")
    expect(result).toContain("status: unknown")
  })

  it("handles missing journal directory (empty files)", () => {
    const now = Date.now()
    const result = buildInnerStatusOutput({
      agentName: "test",
      runtimeState: { status: "idle" },
      journalFiles: [],
      heartbeat: null,
      attentionCount: 0,
      now,
    })

    expect(result).toContain("journal: (empty)")
  })

  it("shows journal files sorted by recency", () => {
    const now = new Date("2026-03-26T10:30:00Z").getTime()
    const result = buildInnerStatusOutput({
      agentName: "test",
      runtimeState: { status: "idle" },
      journalFiles: [
        { name: "old.md", mtimeMs: now - 3 * 24 * 60 * 60 * 1000 },
        { name: "recent.md", mtimeMs: now - 5 * 60 * 1000 },
        { name: "mid.md", mtimeMs: now - 2 * 60 * 60 * 1000 },
      ],
      heartbeat: null,
      attentionCount: 0,
      now,
    })

    // Most recent first
    const recentIdx = result.indexOf("recent.md")
    const midIdx = result.indexOf("mid.md")
    const oldIdx = result.indexOf("old.md")
    expect(recentIdx).toBeLessThan(midIdx)
    expect(midIdx).toBeLessThan(oldIdx)
  })

  it("computes heartbeat as healthy when elapsed < cadence * 1.5", () => {
    const now = new Date("2026-03-26T10:30:00Z").getTime()
    const result = buildInnerStatusOutput({
      agentName: "test",
      runtimeState: { status: "idle" },
      journalFiles: [],
      heartbeat: {
        cadenceMs: 30 * 60 * 1000,
        lastCompletedAt: now - 20 * 60 * 1000, // 20 min ago, cadence 30m
      },
      attentionCount: 0,
      now,
    })

    expect(result).toContain("heartbeat: healthy")
    expect(result).toContain("cadence 30m")
  })

  it("computes heartbeat as overdue when elapsed > cadence * 1.5", () => {
    const now = new Date("2026-03-26T10:30:00Z").getTime()
    const result = buildInnerStatusOutput({
      agentName: "test",
      runtimeState: { status: "idle" },
      journalFiles: [],
      heartbeat: {
        cadenceMs: 30 * 60 * 1000,
        lastCompletedAt: now - 50 * 60 * 1000, // 50 min ago, cadence 30m, threshold 45m
      },
      attentionCount: 0,
      now,
    })

    expect(result).toContain("heartbeat: overdue")
  })

  it("shows heartbeat as unknown when no heartbeat data", () => {
    const now = Date.now()
    const result = buildInnerStatusOutput({
      agentName: "test",
      runtimeState: { status: "idle" },
      journalFiles: [],
      heartbeat: null,
      attentionCount: 0,
      now,
    })

    expect(result).toContain("heartbeat: unknown")
  })

  it("shows heartbeat as unknown when no lastCompletedAt", () => {
    const now = Date.now()
    const result = buildInnerStatusOutput({
      agentName: "test",
      runtimeState: { status: "idle" },
      journalFiles: [],
      heartbeat: {
        cadenceMs: 30 * 60 * 1000,
        lastCompletedAt: null,
      },
      attentionCount: 0,
      now,
    })

    expect(result).toContain("heartbeat: unknown")
  })

  it("formats last turn relative time in minutes", () => {
    const now = new Date("2026-03-26T10:30:00Z").getTime()
    const result = buildInnerStatusOutput({
      agentName: "test",
      runtimeState: {
        status: "idle",
        reason: "heartbeat",
        lastCompletedAt: "2026-03-26T10:25:00Z",
      },
      journalFiles: [],
      heartbeat: null,
      attentionCount: 0,
      now,
    })

    expect(result).toContain("last turn: 5 minutes ago (heartbeat)")
  })

  it("formats last turn relative time in hours", () => {
    const now = new Date("2026-03-26T10:30:00Z").getTime()
    const result = buildInnerStatusOutput({
      agentName: "test",
      runtimeState: {
        status: "idle",
        reason: "heartbeat",
        lastCompletedAt: "2026-03-26T08:30:00Z",
      },
      journalFiles: [],
      heartbeat: null,
      attentionCount: 0,
      now,
    })

    expect(result).toContain("last turn: 2 hours ago (heartbeat)")
  })

  it("formats last turn as 'just now' when < 1 minute", () => {
    const now = new Date("2026-03-26T10:30:00Z").getTime()
    const result = buildInnerStatusOutput({
      agentName: "test",
      runtimeState: {
        status: "idle",
        reason: "heartbeat",
        lastCompletedAt: "2026-03-26T10:29:45Z",
      },
      journalFiles: [],
      heartbeat: null,
      attentionCount: 0,
      now,
    })

    expect(result).toContain("last turn: just now (heartbeat)")
  })

  it("formats singular '1 minute ago'", () => {
    const now = new Date("2026-03-26T10:30:00Z").getTime()
    const result = buildInnerStatusOutput({
      agentName: "test",
      runtimeState: {
        status: "idle",
        reason: "heartbeat",
        lastCompletedAt: "2026-03-26T10:29:00Z",
      },
      journalFiles: [],
      heartbeat: null,
      attentionCount: 0,
      now,
    })

    expect(result).toContain("last turn: 1 minute ago (heartbeat)")
  })

  it("formats singular '1 hour ago'", () => {
    const now = new Date("2026-03-26T10:30:00Z").getTime()
    const result = buildInnerStatusOutput({
      agentName: "test",
      runtimeState: {
        status: "idle",
        reason: "heartbeat",
        lastCompletedAt: "2026-03-26T09:30:00Z",
      },
      journalFiles: [],
      heartbeat: null,
      attentionCount: 0,
      now,
    })

    expect(result).toContain("last turn: 1 hour ago (heartbeat)")
  })

  it("formats singular '1 held thought'", () => {
    const now = Date.now()
    const result = buildInnerStatusOutput({
      agentName: "test",
      runtimeState: { status: "idle" },
      journalFiles: [],
      heartbeat: null,
      attentionCount: 1,
      now,
    })

    expect(result).toContain("attention: 1 held thought")
    // Not "thoughts" (singular)
    expect(result).not.toMatch(/1 held thoughts/)
  })

  it("formats cadence in hours when >= 60m", () => {
    const now = new Date("2026-03-26T10:30:00Z").getTime()
    const result = buildInnerStatusOutput({
      agentName: "test",
      runtimeState: { status: "idle" },
      journalFiles: [],
      heartbeat: {
        cadenceMs: 2 * 60 * 60 * 1000,
        lastCompletedAt: now - 30 * 60 * 1000,
      },
      attentionCount: 0,
      now,
    })

    expect(result).toContain("cadence 2h")
  })

  it("shows last turn without reason when reason not set", () => {
    const now = new Date("2026-03-26T10:30:00Z").getTime()
    const result = buildInnerStatusOutput({
      agentName: "test",
      runtimeState: {
        status: "idle",
        lastCompletedAt: "2026-03-26T10:25:00Z",
      },
      journalFiles: [],
      heartbeat: null,
      attentionCount: 0,
      now,
    })

    expect(result).toContain("last turn: 5 minutes ago")
    expect(result).not.toContain("(heartbeat)")
    expect(result).not.toContain("(undefined)")
  })
})

describe("ouro inner CLI parsing", () => {
  let parseOuroCommand: typeof import("../../../heart/daemon/daemon-cli").parseOuroCommand

  beforeEach(async () => {
    vi.resetModules()
    const mod = await import("../../../heart/daemon/daemon-cli")
    parseOuroCommand = mod.parseOuroCommand
  })

  it("parses 'inner' command with default agent", () => {
    const result = parseOuroCommand(["inner"])
    expect(result).toEqual({ kind: "inner.status" })
  })

  it("parses 'inner' with --agent flag", () => {
    const result = parseOuroCommand(["inner", "--agent", "slugger"])
    expect(result).toEqual({ kind: "inner.status", agent: "slugger" })
  })

  it("parses 'inner' when global --agent flag is consumed by recursive parse", () => {
    // Global --agent is consumed at the top of parseOuroCommand and recurses
    // without passing the agent down — per existing pattern (same as whoami, changelog)
    const result = parseOuroCommand(["--agent", "slugger", "inner"])
    expect(result).toEqual({ kind: "inner.status" })
  })
})
