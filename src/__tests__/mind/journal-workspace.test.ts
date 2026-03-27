import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"

// ── bodyMapSection tests ─────────────────────────────────────────

describe("bodyMapSection journal/diary paths", () => {
  it("includes journal/ in the body map", async () => {
    const { bodyMapSection } = await import("../../mind/prompt")
    const result = bodyMapSection("testagent")
    expect(result).toContain("journal/")
  })

  it("includes diary/ in the body map", async () => {
    const { bodyMapSection } = await import("../../mind/prompt")
    const result = bodyMapSection("testagent")
    expect(result).toContain("diary/")
  })

  it("does NOT include memory/ as a standalone section in the body map", async () => {
    const { bodyMapSection } = await import("../../mind/prompt")
    const result = bodyMapSection("testagent")
    // memory/ should not appear as a body map path (psyche/memory was removed)
    // It may still appear in psyche/ description if there's a legacy ref, but
    // the standalone line listing memory/ as a home directory should be gone
    const lines = result.split("\n")
    const memoryLine = lines.find(
      (line) => /^\s+memory\//.test(line) && !line.includes("psyche/"),
    )
    expect(memoryLine).toBeUndefined()
  })
})

// ── metacognitiveFramingSection tests ─────────────────────────────

describe("metacognitiveFramingSection vocabulary", () => {
  it("mentions journal", async () => {
    const { metacognitiveFramingSection } = await import("../../mind/prompt")
    const result = metacognitiveFramingSection("inner")
    expect(result.toLowerCase()).toContain("journal")
  })

  it("mentions diary", async () => {
    const { metacognitiveFramingSection } = await import("../../mind/prompt")
    const result = metacognitiveFramingSection("inner")
    expect(result.toLowerCase()).toContain("diary")
  })

  it("mentions ponder", async () => {
    const { metacognitiveFramingSection } = await import("../../mind/prompt")
    const result = metacognitiveFramingSection("inner")
    expect(result.toLowerCase()).toContain("ponder")
  })

  it("mentions rest", async () => {
    const { metacognitiveFramingSection } = await import("../../mind/prompt")
    const result = metacognitiveFramingSection("inner")
    expect(result.toLowerCase()).toContain("rest")
  })

  it("mentions morning briefings", async () => {
    const { metacognitiveFramingSection } = await import("../../mind/prompt")
    const result = metacognitiveFramingSection("inner")
    // Should mention the concept of morning briefings / surfacing what you've been thinking
    expect(result.toLowerCase()).toMatch(/morning|briefing/)
  })

  it("mentions heartbeat self-setup awareness", async () => {
    const { metacognitiveFramingSection } = await import("../../mind/prompt")
    const result = metacognitiveFramingSection("inner")
    expect(result).toContain("heartbeat")
    expect(result).toContain("tasks/habits/")
    expect(result).toContain("cadence")
  })

  it("mentions diary migration awareness", async () => {
    const { metacognitiveFramingSection } = await import("../../mind/prompt")
    const result = metacognitiveFramingSection("inner")
    expect(result).toContain("psyche/memory/")
    expect(result).toContain("diary/")
    expect(result).toContain("migrate")
  })

  it("returns empty string for non-inner channels", async () => {
    const { metacognitiveFramingSection } = await import("../../mind/prompt")
    expect(metacognitiveFramingSection("cli")).toBe("")
    expect(metacognitiveFramingSection("teams")).toBe("")
    expect(metacognitiveFramingSection("bluebubbles")).toBe("")
  })
})

// ── journalSection tests ──────────────────────────────────────────

vi.mock("../../nerves/runtime", () => ({
  emitNervesEvent: vi.fn(),
}))

describe("journalSection", () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "journal-test-"))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it("is exported from prompt.ts", async () => {
    const mod = await import("../../mind/prompt")
    expect(typeof mod.journalSection).toBe("function")
  })

  it("returns empty string when journal/ dir does not exist", async () => {
    const { journalSection } = await import("../../mind/prompt")
    const agentRoot = path.join(tmpDir, "no-journal-agent")
    fs.mkdirSync(agentRoot, { recursive: true })
    const result = journalSection(agentRoot)
    expect(result).toBe("")
  })

  it("returns empty string when journal/ dir is empty", async () => {
    const { journalSection } = await import("../../mind/prompt")
    const agentRoot = path.join(tmpDir, "empty-journal-agent")
    fs.mkdirSync(path.join(agentRoot, "journal"), { recursive: true })
    const result = journalSection(agentRoot)
    expect(result).toBe("")
  })

  it("returns file index for journal files sorted by mtime", async () => {
    const { journalSection } = await import("../../mind/prompt")
    const agentRoot = path.join(tmpDir, "journal-agent")
    const journalDir = path.join(agentRoot, "journal")
    fs.mkdirSync(journalDir, { recursive: true })

    // Create files with different mtimes — use a fixed "now" to compute relative times
    const now = new Date("2026-03-26T12:00:00Z")

    // File 1: 2 hours ago
    const file1 = path.join(journalDir, "thinking-about-auth.md")
    fs.writeFileSync(file1, "# Auth redesign\nSome thoughts about auth...", "utf8")
    const mtime1 = new Date(now.getTime() - 2 * 60 * 60 * 1000)
    fs.utimesSync(file1, mtime1, mtime1)

    // File 2: 30 minutes ago (most recent)
    const file2 = path.join(journalDir, "api-sketch.md")
    fs.writeFileSync(file2, "# API sketch\nDesigning the API...", "utf8")
    const mtime2 = new Date(now.getTime() - 30 * 60 * 1000)
    fs.utimesSync(file2, mtime2, mtime2)

    const result = journalSection(agentRoot, now)
    expect(result).toContain("api-sketch.md")
    expect(result).toContain("thinking-about-auth.md")
    // Most recent should appear first
    const apiPos = result.indexOf("api-sketch.md")
    const authPos = result.indexOf("thinking-about-auth.md")
    expect(apiPos).toBeLessThan(authPos)
    // Should contain first-line previews
    expect(result).toContain("API sketch")
    expect(result).toContain("Auth redesign")
  })

  it("shows relative times like '2 hours ago'", async () => {
    const { journalSection } = await import("../../mind/prompt")
    const agentRoot = path.join(tmpDir, "relative-time-agent")
    const journalDir = path.join(agentRoot, "journal")
    fs.mkdirSync(journalDir, { recursive: true })

    const now = new Date("2026-03-26T12:00:00Z")
    const file = path.join(journalDir, "notes.md")
    fs.writeFileSync(file, "# Some notes", "utf8")
    const mtime = new Date(now.getTime() - 2 * 60 * 60 * 1000)
    fs.utimesSync(file, mtime, mtime)

    const result = journalSection(agentRoot, now)
    expect(result).toMatch(/2 hours? ago/)
  })

  it("shows 'just now' for very recent files", async () => {
    const { journalSection } = await import("../../mind/prompt")
    const agentRoot = path.join(tmpDir, "just-now-agent")
    const journalDir = path.join(agentRoot, "journal")
    fs.mkdirSync(journalDir, { recursive: true })

    const now = new Date("2026-03-26T12:00:00Z")
    const file = path.join(journalDir, "fresh.md")
    fs.writeFileSync(file, "# Fresh", "utf8")
    const mtime = new Date(now.getTime() - 10 * 1000) // 10 seconds ago
    fs.utimesSync(file, mtime, mtime)

    const result = journalSection(agentRoot, now)
    expect(result).toContain("just now")
  })

  it("shows '1 minute ago' for singular minute", async () => {
    const { journalSection } = await import("../../mind/prompt")
    const agentRoot = path.join(tmpDir, "one-min-agent")
    const journalDir = path.join(agentRoot, "journal")
    fs.mkdirSync(journalDir, { recursive: true })

    const now = new Date("2026-03-26T12:00:00Z")
    const file = path.join(journalDir, "recent.md")
    fs.writeFileSync(file, "# Recent", "utf8")
    const mtime = new Date(now.getTime() - 1 * 60 * 1000) // 1 minute ago
    fs.utimesSync(file, mtime, mtime)

    const result = journalSection(agentRoot, now)
    expect(result).toContain("1 minute ago")
  })

  it("shows '1 hour ago' for singular hour", async () => {
    const { journalSection } = await import("../../mind/prompt")
    const agentRoot = path.join(tmpDir, "one-hour-agent")
    const journalDir = path.join(agentRoot, "journal")
    fs.mkdirSync(journalDir, { recursive: true })

    const now = new Date("2026-03-26T12:00:00Z")
    const file = path.join(journalDir, "hourold.md")
    fs.writeFileSync(file, "# Hour old", "utf8")
    const mtime = new Date(now.getTime() - 1 * 60 * 60 * 1000)
    fs.utimesSync(file, mtime, mtime)

    const result = journalSection(agentRoot, now)
    expect(result).toContain("1 hour ago")
  })

  it("shows 'days ago' for files older than 24 hours", async () => {
    const { journalSection } = await import("../../mind/prompt")
    const agentRoot = path.join(tmpDir, "days-ago-agent")
    const journalDir = path.join(agentRoot, "journal")
    fs.mkdirSync(journalDir, { recursive: true })

    const now = new Date("2026-03-26T12:00:00Z")
    const file = path.join(journalDir, "old.md")
    fs.writeFileSync(file, "# Old thoughts", "utf8")
    const mtime = new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000) // 3 days ago
    fs.utimesSync(file, mtime, mtime)

    const result = journalSection(agentRoot, now)
    expect(result).toContain("3 days ago")
  })

  it("shows '1 day ago' for singular day", async () => {
    const { journalSection } = await import("../../mind/prompt")
    const agentRoot = path.join(tmpDir, "one-day-agent")
    const journalDir = path.join(agentRoot, "journal")
    fs.mkdirSync(journalDir, { recursive: true })

    const now = new Date("2026-03-26T12:00:00Z")
    const file = path.join(journalDir, "yesterday.md")
    fs.writeFileSync(file, "# Yesterday", "utf8")
    const mtime = new Date(now.getTime() - 25 * 60 * 60 * 1000) // 25 hours = 1 day
    fs.utimesSync(file, mtime, mtime)

    const result = journalSection(agentRoot, now)
    expect(result).toContain("1 day ago")
  })

  it("limits output to 10 most recently modified files", async () => {
    const { journalSection } = await import("../../mind/prompt")
    const agentRoot = path.join(tmpDir, "many-files-agent")
    const journalDir = path.join(agentRoot, "journal")
    fs.mkdirSync(journalDir, { recursive: true })

    const now = new Date("2026-03-26T12:00:00Z")
    // Create 15 files
    for (let i = 0; i < 15; i++) {
      const file = path.join(journalDir, `note-${i.toString().padStart(2, "0")}.md`)
      fs.writeFileSync(file, `# Note ${i}`, "utf8")
      const mtime = new Date(now.getTime() - i * 60 * 60 * 1000)
      fs.utimesSync(file, mtime, mtime)
    }

    const result = journalSection(agentRoot, now)
    // Should contain the 10 most recent (note-00 through note-09)
    for (let i = 0; i < 10; i++) {
      expect(result).toContain(`note-${i.toString().padStart(2, "0")}.md`)
    }
    // Should NOT contain the older files
    for (let i = 10; i < 15; i++) {
      expect(result).not.toContain(`note-${i.toString().padStart(2, "0")}.md`)
    }
  })

  it("handles files with no content (empty first line)", async () => {
    const { journalSection } = await import("../../mind/prompt")
    const agentRoot = path.join(tmpDir, "empty-content-agent")
    const journalDir = path.join(agentRoot, "journal")
    fs.mkdirSync(journalDir, { recursive: true })

    const file = path.join(journalDir, "blank.md")
    fs.writeFileSync(file, "", "utf8")

    const now = new Date("2026-03-26T12:00:00Z")
    const result = journalSection(agentRoot, now)
    // Should still list the file even if content is empty
    expect(result).toContain("blank.md")
  })

  it("skips subdirectories in journal/", async () => {
    const { journalSection } = await import("../../mind/prompt")
    const agentRoot = path.join(tmpDir, "subdir-agent")
    const journalDir = path.join(agentRoot, "journal")
    fs.mkdirSync(journalDir, { recursive: true })

    // Create a subdirectory
    fs.mkdirSync(path.join(journalDir, "subdir"))
    // Create a regular file
    fs.writeFileSync(path.join(journalDir, "notes.md"), "# Notes", "utf8")

    const now = new Date("2026-03-26T12:00:00Z")
    const result = journalSection(agentRoot, now)
    expect(result).toContain("notes.md")
    expect(result).not.toContain("subdir")
  })

  it("uses current time when now is not provided", async () => {
    const { journalSection } = await import("../../mind/prompt")
    const agentRoot = path.join(tmpDir, "default-now-agent")
    const journalDir = path.join(agentRoot, "journal")
    fs.mkdirSync(journalDir, { recursive: true })

    const file = path.join(journalDir, "recent.md")
    fs.writeFileSync(file, "# Recent work", "utf8")

    // Call without a `now` parameter — should use Date.now() internally
    const result = journalSection(agentRoot)
    expect(result).toContain("recent.md")
    // Since we just wrote the file, it should show "just now" or a very small time
    expect(result).toMatch(/just now|1 minute/)
  })

  it("skips hidden files like .index.json", async () => {
    const { journalSection } = await import("../../mind/prompt")
    const agentRoot = path.join(tmpDir, "hidden-files-agent")
    const journalDir = path.join(agentRoot, "journal")
    fs.mkdirSync(journalDir, { recursive: true })

    // Create a visible file and a hidden index file
    fs.writeFileSync(path.join(journalDir, "notes.md"), "# Notes", "utf8")
    fs.writeFileSync(path.join(journalDir, ".index.json"), '{"entries":[]}', "utf8")

    const now = new Date("2026-03-26T12:00:00Z")
    const result = journalSection(agentRoot, now)
    expect(result).toContain("notes.md")
    expect(result).not.toContain(".index.json")
  })
})
