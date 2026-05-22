import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"

const mockGetAgentRoot = vi.fn<[], string>()

vi.mock("../../heart/identity", () => ({
  getAgentRoot: () => mockGetAgentRoot(),
}))

import { deskSection, formatRelative } from "../../mind/desk-section"

const NOW = new Date("2026-05-22T12:00:00Z")

interface TaskOpts {
  status?: string
  updated?: string | null
  schemaVersion?: 0 | 1
}

function writeTask(taskDir: string, slug: string, opts: TaskOpts = {}): void {
  fs.mkdirSync(path.join(taskDir, slug), { recursive: true })
  const fmLines: string[] = ["---"]
  if (opts.schemaVersion === 1) fmLines.push("schema_version: 1")
  fmLines.push(`status: ${opts.status ?? "processing"}`)
  if (opts.updated !== null) {
    fmLines.push(`updated: ${opts.updated ?? "2026-05-22T10:00:00Z"}`)
  }
  fmLines.push("---")
  fmLines.push("")
  fmLines.push(`# ${slug}`)
  fs.writeFileSync(path.join(taskDir, slug, "task.md"), fmLines.join("\n"), "utf-8")
}

function writeTrack(deskRoot: string, slug: string, status: string = "active"): string {
  const dir = path.join(deskRoot, slug)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    path.join(dir, "track.md"),
    `---\nstatus: ${status}\n---\n\n# ${slug}\n`,
    "utf-8",
  )
  return dir
}

function writeFeatured(deskRoot: string, slugs: string[]): void {
  const metaDir = path.join(deskRoot, "_meta")
  fs.mkdirSync(metaDir, { recursive: true })
  fs.writeFileSync(path.join(metaDir, "featured.md"), slugs.join("\n") + "\n", "utf-8")
}

describe("deskSection", () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "desk-section-"))
    mockGetAgentRoot.mockReturnValue(tmpDir)
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
    vi.clearAllMocks()
  })

  it("always includes the static Candidate D body and all three 'what doesn't' bullets", () => {
    const result = deskSection(NOW)
    expect(result).toContain("## my desk")
    expect(result).toContain("every ouro agent has a desk")
    // all three "what doesn't" bullets including the first-class systems one
    expect(result).toContain("- a single-turn answer")
    expect(result).toContain("- ephemeral debugging that resolves in the same exchange")
    expect(result).toContain("work that has its own first-class system")
    expect(result).toContain("trips, habits, attention items, diary entries, journal entries")
  })

  it("returns empty-desk stub when no <bundle>/desk/ dir exists", () => {
    // no desk/ directory under tmpDir
    const result = deskSection(NOW)
    expect(result).toContain("### currently\nempty — no tracks yet.")
  })

  it("returns empty-desk stub when desk/ exists but contains no tracks", () => {
    fs.mkdirSync(path.join(tmpDir, "desk"), { recursive: true })
    const result = deskSection(NOW)
    expect(result).toContain("### currently\nempty — no tracks yet.")
  })

  it("single-track desk with no featured.md falls back to alphabetical first", () => {
    const deskRoot = path.join(tmpDir, "desk")
    const trackDir = writeTrack(deskRoot, "harness-care")
    writeTask(trackDir, "rewrite-bridges", { status: "processing", updated: "2026-05-22T10:00:00Z" })
    const result = deskSection(NOW)
    expect(result).toContain("FEATURED: harness-care   (status: active)")
    expect(result).toContain("→ rewrite-bridges")
    expect(result).toContain("non-terminal tasks: 1")
  })

  it("single-track desk with featured.md uses the featured slug", () => {
    const deskRoot = path.join(tmpDir, "desk")
    const trackDir = writeTrack(deskRoot, "harness-care")
    writeTask(trackDir, "fix-thing", { status: "processing", updated: "2026-05-22T10:00:00Z" })
    writeFeatured(deskRoot, ["harness-care"])
    const result = deskSection(NOW)
    expect(result).toContain("FEATURED: harness-care   (status: active)")
  })

  it("multi-track desk: featured.md picks one, others appear alphabetically in 'other active tracks'", () => {
    const deskRoot = path.join(tmpDir, "desk")
    const t1 = writeTrack(deskRoot, "alpha-track")
    const t2 = writeTrack(deskRoot, "harness-care")
    const t3 = writeTrack(deskRoot, "zulu-track")
    writeTask(t1, "task-a", { status: "processing", updated: "2026-05-22T11:00:00Z" })
    writeTask(t2, "task-h", { status: "processing", updated: "2026-05-22T11:00:00Z" })
    writeTask(t3, "task-z", { status: "processing", updated: "2026-05-22T11:00:00Z" })
    writeFeatured(deskRoot, ["harness-care"])
    const result = deskSection(NOW)
    expect(result).toContain("FEATURED: harness-care")
    expect(result).toContain("other active tracks: alpha-track, zulu-track")
    expect(result).toContain("non-terminal tasks: 3")
  })

  it("stale featured slug (listed but no track dir) falls back to next entry then alphabetical", () => {
    const deskRoot = path.join(tmpDir, "desk")
    writeTrack(deskRoot, "alpha")
    writeTrack(deskRoot, "beta")
    writeFeatured(deskRoot, ["ghost-track", "beta"])
    const result = deskSection(NOW)
    expect(result).toContain("FEATURED: beta")
    // and never crashes
  })

  it("falls back to alphabetical when ALL featured slugs are stale", () => {
    const deskRoot = path.join(tmpDir, "desk")
    writeTrack(deskRoot, "alpha")
    writeTrack(deskRoot, "beta")
    writeFeatured(deskRoot, ["ghost-1", "ghost-2"])
    const result = deskSection(NOW)
    expect(result).toContain("FEATURED: alpha")
  })

  it("closed featured track is skipped; falls back to alphabetical first active", () => {
    const deskRoot = path.join(tmpDir, "desk")
    writeTrack(deskRoot, "alpha", "closed")
    writeTrack(deskRoot, "beta", "active")
    writeFeatured(deskRoot, ["alpha"])
    const result = deskSection(NOW)
    expect(result).toContain("FEATURED: beta   (status: active)")
    // closed track NOT in other active tracks either
    expect(result).not.toContain("other active tracks: alpha")
  })

  it("emits top-N (N=3) non-terminal tasks oldest-updated first; skips done/cancelled", () => {
    const deskRoot = path.join(tmpDir, "desk")
    const trackDir = writeTrack(deskRoot, "harness-care")
    // 5 non-terminal tasks with varying updated; oldest 3 should appear in order
    writeTask(trackDir, "newest", { status: "processing", updated: "2026-05-22T11:00:00Z" })
    writeTask(trackDir, "oldest", { status: "processing", updated: "2026-05-01T10:00:00Z" })
    writeTask(trackDir, "middle", { status: "processing", updated: "2026-05-10T10:00:00Z" })
    writeTask(trackDir, "second-oldest", { status: "processing", updated: "2026-05-05T10:00:00Z" })
    writeTask(trackDir, "very-newest", { status: "processing", updated: "2026-05-22T11:30:00Z" })
    // terminal tasks — should be ignored
    writeTask(trackDir, "old-done", { status: "done", updated: "2026-04-01T10:00:00Z" })
    writeTask(trackDir, "old-cancelled", { status: "cancelled", updated: "2026-04-02T10:00:00Z" })

    const result = deskSection(NOW)
    const idxOldest = result.indexOf("→ oldest")
    const idxSecond = result.indexOf("→ second-oldest")
    const idxMiddle = result.indexOf("→ middle")
    expect(idxOldest).toBeGreaterThan(-1)
    expect(idxSecond).toBeGreaterThan(idxOldest)
    expect(idxMiddle).toBeGreaterThan(idxSecond)
    // only 3 appear
    expect(result).not.toContain("→ newest")
    expect(result).not.toContain("→ very-newest")
    // and terminal tasks don't show
    expect(result).not.toContain("→ old-done")
    expect(result).not.toContain("→ old-cancelled")
    // count of non-terminal across all tracks
    expect(result).toContain("non-terminal tasks: 5")
  })

  it("schema_version: 0 (no field) parses identically to schema_version: 1", () => {
    const deskRoot = path.join(tmpDir, "desk")
    const t1 = writeTrack(deskRoot, "alpha-v0")
    const t2 = writeTrack(deskRoot, "beta-v1")
    writeTask(t1, "task-v0", { status: "processing", updated: "2026-05-22T10:00:00Z", schemaVersion: 0 })
    writeTask(t2, "task-v1", { status: "processing", updated: "2026-05-22T10:00:00Z", schemaVersion: 1 })
    writeFeatured(deskRoot, ["alpha-v0"])
    const result = deskSection(NOW)
    expect(result).toContain("FEATURED: alpha-v0")
    expect(result).toContain("→ task-v0")
    expect(result).toContain("non-terminal tasks: 2")
  })

  it("golden snapshot of an assembled body for a small representative fixture desk", () => {
    const deskRoot = path.join(tmpDir, "desk")
    const tA = writeTrack(deskRoot, "harness-care", "active")
    const tB = writeTrack(deskRoot, "summer-trip", "active")
    writeTask(tA, "wire-desk-section", { status: "processing", updated: "2026-05-22T10:00:00Z" })
    writeTask(tA, "kill-task-board", { status: "drafting", updated: "2026-05-20T08:00:00Z" })
    writeTask(tB, "book-flights", { status: "blocked", updated: "2026-05-15T09:00:00Z" })
    writeFeatured(deskRoot, ["harness-care"])
    const result = deskSection(NOW)
    expect(result).toMatchSnapshot()
  })
})

describe("formatRelative", () => {
  const now = new Date("2026-05-22T12:00:00Z")

  it("returns 'unknown' for null/empty/invalid", () => {
    expect(formatRelative(null, now)).toBe("unknown")
    expect(formatRelative("not-a-date", now)).toBe("unknown")
  })

  it("formats sub-minute as Xs ago", () => {
    expect(formatRelative("2026-05-22T11:59:30Z", now)).toBe("30s ago")
  })

  it("formats sub-hour as Xm ago", () => {
    expect(formatRelative("2026-05-22T11:30:00Z", now)).toBe("30m ago")
  })

  it("formats sub-day as Xh ago", () => {
    expect(formatRelative("2026-05-22T10:00:00Z", now)).toBe("2h ago")
  })

  it("formats days as Xd ago", () => {
    expect(formatRelative("2026-05-19T12:00:00Z", now)).toBe("3d ago")
    expect(formatRelative("2026-04-21T12:00:00Z", now)).toBe("31d ago")
  })

  it("returns 'just now' for future timestamps", () => {
    expect(formatRelative("2026-05-22T12:30:00Z", now)).toBe("just now")
  })
})
