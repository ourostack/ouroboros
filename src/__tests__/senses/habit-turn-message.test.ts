import { describe, expect, it, vi } from "vitest"
import { emitNervesEvent } from "../../nerves/runtime"

vi.mock("../../nerves/runtime", () => ({
  emitNervesEvent: vi.fn(),
}))

import {
  buildHabitTurnMessage,
  type HabitTurnMessageOptions,
} from "../../senses/habit-turn-message"

function makeOptions(overrides: Partial<HabitTurnMessageOptions> = {}): HabitTurnMessageOptions {
  return {
    habitName: "habitName" in overrides ? overrides.habitName! : "heartbeat",
    habitTitle: "habitTitle" in overrides ? overrides.habitTitle! : "Heartbeat",
    habitBody: "habitBody" in overrides ? overrides.habitBody : "Check in on responsibilities.",
    lastRun: "lastRun" in overrides ? overrides.lastRun! : "2026-03-26T11:30:00.000Z",
    checkpoint: "checkpoint" in overrides ? overrides.checkpoint : undefined,
    alsoDue: "alsoDue" in overrides ? overrides.alsoDue : undefined,
    staleObligations: overrides.staleObligations ?? [],
    parseErrors: overrides.parseErrors ?? [],
    degradedComponents: overrides.degradedComponents ?? [],
    now: overrides.now ?? (() => new Date("2026-03-26T12:00:00Z")),
  }
}

describe("buildHabitTurnMessage", () => {
  it("exports buildHabitTurnMessage function", () => {
    expect(typeof buildHabitTurnMessage).toBe("function")
  })

  // ── Normal turn ────────────────────────────────────────────────────

  it("normal turn: checkpoint leads, then elapsed, then body", () => {
    const result = buildHabitTurnMessage(makeOptions({
      checkpoint: "refactoring the tool registry",
      lastRun: "2026-03-26T11:32:00.000Z",
      now: () => new Date("2026-03-26T12:00:00Z"),
    }))

    // Checkpoint must come first
    const checkpointIdx = result.indexOf("you were thinking about refactoring the tool registry.")
    const elapsedIdx = result.indexOf("28 minutes have passed.")
    const bodyIdx = result.indexOf("Check in on responsibilities.")

    expect(checkpointIdx).toBeGreaterThanOrEqual(0)
    expect(elapsedIdx).toBeGreaterThan(checkpointIdx)
    expect(bodyIdx).toBeGreaterThan(elapsedIdx)
  })

  it("normal turn: includes also-due line", () => {
    const result = buildHabitTurnMessage(makeOptions({
      alsoDue: "also due: weekly-review, daily-journal",
    }))

    expect(result).toContain("also due: weekly-review, daily-journal")
  })

  it("normal turn: includes stale obligation alerts with timing and friend name", () => {
    const result = buildHabitTurnMessage(makeOptions({
      staleObligations: [
        { friendName: "ari", content: "review the architecture doc", stalenessMs: 45 * 60 * 1000 },
      ],
    }))

    expect(result).toContain("[internal] obligation: ari — waiting 45 minutes")
  })

  it("normal turn: multiple stale obligations each on their own line", () => {
    const result = buildHabitTurnMessage(makeOptions({
      staleObligations: [
        { friendName: "ari", content: "review PR", stalenessMs: 60 * 60 * 1000 },
        { friendName: "kai", content: "answer question", stalenessMs: 90 * 60 * 1000 },
      ],
    }))

    expect(result).toContain("[internal] obligation: ari — waiting 1 hour")
    expect(result).toContain("[internal] obligation: kai — waiting 1 hour")
    // Each on separate line
    const lines = result.split("\n")
    const obligationLines = lines.filter((l) => l.includes("[internal] obligation:"))
    expect(obligationLines).toHaveLength(2)
  })

  // ── First beat ─────────────────────────────────────────────────────

  it("first beat (lastRun null): alive framing with title and body", () => {
    const result = buildHabitTurnMessage(makeOptions({
      habitTitle: "Daily Reflection",
      habitBody: "Reflect on the day.",
      lastRun: null,
    }))

    expect(result).toContain("your Daily Reflection is alive. this is its first breath.")
    expect(result).toContain("Reflect on the day.")
  })

  it("first beat: uses habit title, not filename", () => {
    const result = buildHabitTurnMessage(makeOptions({
      habitName: "daily-reflection",
      habitTitle: "Daily Reflection",
      lastRun: null,
    }))

    expect(result).toContain("Daily Reflection")
    expect(result).not.toMatch(/^.*daily-reflection.*alive/m)
  })

  // ── No body ────────────────────────────────────────────────────────

  it("no body: nudge to add instructions", () => {
    const result = buildHabitTurnMessage(makeOptions({
      habitName: "daily-reflection",
      habitTitle: "Daily Reflection",
      habitBody: undefined,
    }))

    expect(result).toContain("your Daily Reflection fired but has no instructions")
    expect(result).toContain("habits/daily-reflection.md")
  })

  it("no body: empty string treated same as undefined", () => {
    const result = buildHabitTurnMessage(makeOptions({
      habitName: "daily-reflection",
      habitTitle: "Daily Reflection",
      habitBody: "",
    }))

    expect(result).toContain("has no instructions")
  })

  // ── No checkpoint ──────────────────────────────────────────────────

  it("no checkpoint: skips continuity line, starts with elapsed", () => {
    const result = buildHabitTurnMessage(makeOptions({
      checkpoint: undefined,
      lastRun: "2026-03-26T11:30:00.000Z",
      now: () => new Date("2026-03-26T12:00:00Z"),
    }))

    expect(result).not.toContain("you were thinking about")
    expect(result).toMatch(/^30 minutes have passed/)
  })

  // ── No stale obligations ───────────────────────────────────────────

  it("no stale obligations: no obligation section", () => {
    const result = buildHabitTurnMessage(makeOptions({
      staleObligations: [],
    }))

    expect(result).not.toContain("[internal] obligation:")
    expect(result).not.toContain("waiting")
  })

  // ── Cold start ─────────────────────────────────────────────────────

  it("cold start (no lastRun, no checkpoint): bare awareness fallback", () => {
    const result = buildHabitTurnMessage(makeOptions({
      lastRun: null,
      checkpoint: undefined,
      habitBody: undefined,
    }))

    expect(result).toBe("...time passing. anything stirring?")
  })

  // ── Parse errors ───────────────────────────────────────────────────

  it("parse error nudges appended when present", () => {
    const result = buildHabitTurnMessage(makeOptions({
      parseErrors: [
        { file: "broken-habit.md", error: "invalid frontmatter" },
      ],
    }))

    expect(result).toContain("broken-habit.md")
    expect(result).toContain("invalid frontmatter")
  })

  // ── Degraded state ─────────────────────────────────────────────────

  it("degraded state nudge appended when present", () => {
    const result = buildHabitTurnMessage(makeOptions({
      degradedComponents: [
        { component: "heartbeat", reason: "cron registration failed" },
      ],
    }))

    expect(result).toContain("[note: my scheduling is degraded")
    expect(result).toContain("heartbeat: cron registration failed")
  })

  // ── Same format for all habits ─────────────────────────────────────

  it("works identically for heartbeat and any other habit", () => {
    const baseOpts = {
      lastRun: "2026-03-26T11:30:00.000Z" as string | null,
      checkpoint: "thinking about something",
      now: () => new Date("2026-03-26T12:00:00Z"),
      habitBody: "Do the thing.",
    }

    const heartbeatResult = buildHabitTurnMessage(makeOptions({
      ...baseOpts,
      habitName: "heartbeat",
      habitTitle: "Heartbeat",
    }))

    const customResult = buildHabitTurnMessage(makeOptions({
      ...baseOpts,
      habitName: "daily-reflection",
      habitTitle: "Daily Reflection",
    }))

    // Both should have the same structure: checkpoint, elapsed, body
    expect(heartbeatResult).toContain("you were thinking about")
    expect(customResult).toContain("you were thinking about")
    expect(heartbeatResult).toContain("30 minutes have passed")
    expect(customResult).toContain("30 minutes have passed")
    expect(heartbeatResult).toContain("Do the thing.")
    expect(customResult).toContain("Do the thing.")
  })

  // ── Elapsed time formatting ────────────────────────────────────────

  it("singular minute: 1 minute", () => {
    const result = buildHabitTurnMessage(makeOptions({
      lastRun: "2026-03-26T11:59:00.000Z",
      now: () => new Date("2026-03-26T12:00:00Z"),
    }))

    expect(result).toContain("1 minute have passed.")
    expect(result).not.toContain("1 minutes")
  })

  it("plural minutes: 28 minutes", () => {
    const result = buildHabitTurnMessage(makeOptions({
      lastRun: "2026-03-26T11:32:00.000Z",
      now: () => new Date("2026-03-26T12:00:00Z"),
    }))

    expect(result).toContain("28 minutes have passed.")
  })

  it("singular hour: 1 hour", () => {
    const result = buildHabitTurnMessage(makeOptions({
      lastRun: "2026-03-26T11:00:00.000Z",
      now: () => new Date("2026-03-26T12:00:00Z"),
    }))

    expect(result).toContain("1 hour have passed.")
    expect(result).not.toContain("1 hours")
  })

  it("plural hours: 3 hours", () => {
    const result = buildHabitTurnMessage(makeOptions({
      lastRun: "2026-03-26T09:00:00.000Z",
      now: () => new Date("2026-03-26T12:00:00Z"),
    }))

    expect(result).toContain("3 hours have passed.")
  })

  // ── Nerves event ───────────────────────────────────────────────────

  it("emits nerves event senses.habit_turn_message_built", () => {
    buildHabitTurnMessage(makeOptions())

    expect(emitNervesEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        component: "senses",
        event: "senses.habit_turn_message_built",
      }),
    )
  })

  // ── Section ordering ───────────────────────────────────────────────

  it("full message ordering: checkpoint, elapsed, body, also-due, obligations, parse errors, degraded", () => {
    const result = buildHabitTurnMessage(makeOptions({
      checkpoint: "working on tools",
      lastRun: "2026-03-26T11:30:00.000Z",
      now: () => new Date("2026-03-26T12:00:00Z"),
      habitBody: "Check in on responsibilities.",
      alsoDue: "also due: weekly-review",
      staleObligations: [
        { friendName: "ari", content: "review PR", stalenessMs: 45 * 60 * 1000 },
      ],
      parseErrors: [{ file: "bad.md", error: "bad yaml" }],
      degradedComponents: [{ component: "heartbeat", reason: "fallback" }],
    }))

    const checkpointIdx = result.indexOf("you were thinking about")
    const elapsedIdx = result.indexOf("30 minutes have passed")
    const bodyIdx = result.indexOf("Check in on responsibilities.")
    const alsoDueIdx = result.indexOf("also due:")
    const obligationIdx = result.indexOf("[internal] obligation: ari")
    const parseIdx = result.indexOf("bad.md")
    const degradedIdx = result.indexOf("[note:")

    expect(checkpointIdx).toBeGreaterThanOrEqual(0)
    expect(elapsedIdx).toBeGreaterThan(checkpointIdx)
    expect(bodyIdx).toBeGreaterThan(elapsedIdx)
    expect(alsoDueIdx).toBeGreaterThan(bodyIdx)
    expect(obligationIdx).toBeGreaterThan(alsoDueIdx)
    expect(parseIdx).toBeGreaterThan(obligationIdx)
    expect(degradedIdx).toBeGreaterThan(parseIdx)
  })

  // ── First beat with no body (cold start edge case) ─────────────────

  it("first beat with body but no checkpoint: alive framing, no continuity line", () => {
    const result = buildHabitTurnMessage(makeOptions({
      lastRun: null,
      checkpoint: undefined,
      habitBody: "Check in on responsibilities.",
      habitTitle: "Heartbeat",
    }))

    expect(result).toContain("your Heartbeat is alive. this is its first breath.")
    expect(result).toContain("Check in on responsibilities.")
    expect(result).not.toContain("you were thinking about")
  })

  // ── Stale obligation elapsed formatting ────────────────────────────

  it("stale obligations: uses hours for large staleness", () => {
    const result = buildHabitTurnMessage(makeOptions({
      staleObligations: [
        { friendName: "ari", content: "review doc", stalenessMs: 2 * 60 * 60 * 1000 },
      ],
    }))

    expect(result).toContain("[internal] obligation: ari — waiting 2 hours")
  })

  it("stale obligations: singular 1 hour", () => {
    const result = buildHabitTurnMessage(makeOptions({
      staleObligations: [
        { friendName: "ari", content: "check thing", stalenessMs: 60 * 60 * 1000 },
      ],
    }))

    expect(result).toContain("[internal] obligation: ari — waiting 1 hour")
    expect(result).not.toContain("1 hours")
  })

  // ── First beat with checkpoint but no body ──────────────────────────

  it("first beat with checkpoint but no body: nudge to add body", () => {
    const result = buildHabitTurnMessage(makeOptions({
      habitName: "daily-reflection",
      habitTitle: "Daily Reflection",
      habitBody: undefined,
      lastRun: null,
      checkpoint: "something from earlier",
    }))

    // Has checkpoint so NOT cold start -- should get nudge
    expect(result).toContain("your Daily Reflection fired but has no instructions")
  })

  // ── Multiple degraded components ───────────────────────────────────

  it("multiple degraded components joined with semicolons", () => {
    const result = buildHabitTurnMessage(makeOptions({
      degradedComponents: [
        { component: "heartbeat", reason: "timer fallback" },
        { component: "cron", reason: "unreachable" },
      ],
    }))

    expect(result).toContain("heartbeat: timer fallback")
    expect(result).toContain("cron: unreachable")
  })

  // ── Multiple parse errors ──────────────────────────────────────────

  it("multiple parse errors each produce a nudge", () => {
    const result = buildHabitTurnMessage(makeOptions({
      parseErrors: [
        { file: "a.md", error: "bad yaml" },
        { file: "b.md", error: "missing title" },
      ],
    }))

    expect(result).toContain("a.md")
    expect(result).toContain("b.md")
  })
})
