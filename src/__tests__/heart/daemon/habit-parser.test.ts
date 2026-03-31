import { describe, expect, it } from "vitest"

import {
  parseHabitFile,
  renderHabitFile,
  type HabitFile,
  type HabitStatus,
} from "../../../heart/daemon/habit-parser"

describe("parseHabitFile", () => {
  it("parses a valid habit file with all fields", () => {
    const content = [
      "---",
      "title: Heartbeat",
      "cadence: 30m",
      "status: active",
      "lastRun: 2026-03-27T10:00:00.000Z",
      "created: 2026-03-27",
      "---",
      "",
      "Check in on my responsibilities and reflect.",
    ].join("\n")

    const result = parseHabitFile(content, "/bundles/agent.ouro/habits/heartbeat.md")

    expect(result).toEqual({
      name: "heartbeat",
      title: "Heartbeat",
      cadence: "30m",
      status: "active",
      lastRun: "2026-03-27T10:00:00.000Z",
      created: "2026-03-27",
      body: "Check in on my responsibilities and reflect.",
    })
  })

  it("returns null cadence when cadence is missing", () => {
    const content = [
      "---",
      "title: Manual habit",
      "status: active",
      "created: 2026-03-27",
      "---",
      "",
      "Run manually.",
    ].join("\n")

    const result = parseHabitFile(content, "/bundles/agent.ouro/habits/manual-habit.md")
    expect(result.cadence).toBeNull()
  })

  it("defaults status to 'active' when missing", () => {
    const content = [
      "---",
      "title: No status",
      "cadence: 1h",
      "created: 2026-03-27",
      "---",
      "",
      "Body.",
    ].join("\n")

    const result = parseHabitFile(content, "/bundles/agent.ouro/habits/no-status.md")
    expect(result.status).toBe("active")
  })

  it("uses filename stem as title when title is missing", () => {
    const content = [
      "---",
      "cadence: 15m",
      "status: paused",
      "created: 2026-03-27",
      "---",
      "",
      "Body.",
    ].join("\n")

    const result = parseHabitFile(content, "/bundles/agent.ouro/habits/daily-reflection.md")
    expect(result.title).toBe("daily-reflection")
    expect(result.name).toBe("daily-reflection")
  })

  it("handles invalid frontmatter gracefully with defaults", () => {
    const content = "this is not frontmatter at all"

    const result = parseHabitFile(content, "/bundles/agent.ouro/habits/broken.md")
    expect(result.name).toBe("broken")
    expect(result.title).toBe("broken")
    expect(result.cadence).toBeNull()
    expect(result.status).toBe("active")
    expect(result.lastRun).toBeNull()
    expect(result.created).toBeNull()
    expect(result.body).toBe("this is not frontmatter at all")
  })

  it("handles an empty file", () => {
    const result = parseHabitFile("", "/bundles/agent.ouro/habits/empty.md")
    expect(result.name).toBe("empty")
    expect(result.title).toBe("empty")
    expect(result.cadence).toBeNull()
    expect(result.status).toBe("active")
    expect(result.lastRun).toBeNull()
    expect(result.created).toBeNull()
    expect(result.body).toBe("")
  })

  it("handles a file with body but no frontmatter", () => {
    const content = "Just a plain text body\nwith multiple lines"

    const result = parseHabitFile(content, "/bundles/agent.ouro/habits/plain.md")
    expect(result.name).toBe("plain")
    expect(result.title).toBe("plain")
    expect(result.body).toBe("Just a plain text body\nwith multiple lines")
    expect(result.cadence).toBeNull()
  })

  it("handles unterminated frontmatter gracefully", () => {
    const content = "---\ntitle: Oops\ncadence: 30m"

    const result = parseHabitFile(content, "/bundles/agent.ouro/habits/oops.md")
    expect(result.name).toBe("oops")
    // Unterminated frontmatter treated as no frontmatter
    expect(result.body).toBe("---\ntitle: Oops\ncadence: 30m")
  })

  it("returns null for lastRun and created when missing from frontmatter", () => {
    const content = [
      "---",
      "title: Minimal",
      "cadence: 1h",
      "status: active",
      "---",
      "",
      "Body.",
    ].join("\n")

    const result = parseHabitFile(content, "/bundles/agent.ouro/habits/minimal.md")
    expect(result.lastRun).toBeNull()
    expect(result.created).toBeNull()
  })

  it("normalizes paused status", () => {
    const content = [
      "---",
      "title: Paused habit",
      "cadence: 2h",
      "status: paused",
      "created: 2026-03-27",
      "---",
      "",
      "On hold.",
    ].join("\n")

    const result = parseHabitFile(content, "/bundles/agent.ouro/habits/paused-habit.md")
    expect(result.status).toBe("paused")
  })

  it("treats unknown status as active", () => {
    const content = [
      "---",
      "title: Weird status",
      "status: banana",
      "---",
      "",
      "Body.",
    ].join("\n")

    const result = parseHabitFile(content, "/bundles/agent.ouro/habits/weird.md")
    expect(result.status).toBe("active")
  })

  it("handles lastRun as null frontmatter value", () => {
    const content = [
      "---",
      "title: Null lastRun",
      "cadence: 30m",
      "status: active",
      "lastRun: null",
      "created: 2026-03-27",
      "---",
      "",
      "Body.",
    ].join("\n")

    const result = parseHabitFile(content, "/bundles/agent.ouro/habits/null-lastrun.md")
    expect(result.lastRun).toBeNull()
  })

  it("returns correct return type shape", () => {
    const content = [
      "---",
      "title: Shape test",
      "cadence: 5m",
      "status: active",
      "lastRun: 2026-03-27T10:00:00.000Z",
      "created: 2026-03-20",
      "---",
      "",
      "Test body.",
    ].join("\n")

    const result: HabitFile = parseHabitFile(content, "/bundles/agent.ouro/habits/shape-test.md")
    const keys = Object.keys(result).sort()
    expect(keys).toEqual(["body", "cadence", "created", "lastRun", "name", "status", "title"])
  })

  it("exports HabitStatus type correctly", () => {
    const active: HabitStatus = "active"
    const paused: HabitStatus = "paused"
    expect(active).toBe("active")
    expect(paused).toBe("paused")
  })
})

describe("renderHabitFile", () => {
  it("renders frontmatter and body as markdown", () => {
    const frontmatter = {
      title: "Heartbeat",
      cadence: "30m",
      status: "active",
      lastRun: "2026-03-27T10:00:00.000Z",
      created: "2026-03-27",
    }
    const body = "Check in on responsibilities."

    const result = renderHabitFile(frontmatter, body)

    expect(result).toContain("---")
    expect(result).toContain("title: Heartbeat")
    expect(result).toContain("cadence: 30m")
    expect(result).toContain("status: active")
    expect(result).toContain("lastRun: 2026-03-27T10:00:00.000Z")
    expect(result).toContain("created: 2026-03-27")
    expect(result).toContain("Check in on responsibilities.")
  })

  it("renders null values correctly", () => {
    const frontmatter = {
      title: "Minimal",
      cadence: "1h",
      status: "active",
      lastRun: null,
      created: "2026-03-27",
    }

    const result = renderHabitFile(frontmatter, "Body.")
    expect(result).toContain("lastRun: null")
  })

  it("roundtrips through parse and render", () => {
    const original = [
      "---",
      "title: Roundtrip",
      "cadence: 30m",
      "status: active",
      "lastRun: 2026-03-27T10:00:00.000Z",
      "created: 2026-03-27",
      "---",
      "",
      "Roundtrip body.",
    ].join("\n")

    const parsed = parseHabitFile(original, "/bundles/agent.ouro/habits/roundtrip.md")
    const rendered = renderHabitFile(
      {
        title: parsed.title,
        cadence: parsed.cadence,
        status: parsed.status,
        lastRun: parsed.lastRun,
        created: parsed.created,
      },
      parsed.body,
    )

    const reparsed = parseHabitFile(rendered, "/bundles/agent.ouro/habits/roundtrip.md")
    expect(reparsed.title).toBe(parsed.title)
    expect(reparsed.cadence).toBe(parsed.cadence)
    expect(reparsed.status).toBe(parsed.status)
    expect(reparsed.lastRun).toBe(parsed.lastRun)
    expect(reparsed.created).toBe(parsed.created)
    expect(reparsed.body).toBe(parsed.body)
  })
})
