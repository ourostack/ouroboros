/**
 * W6 Unit 11 — `ouro migrate-to-desk` migrator tests.
 *
 * Synthetic fixture bundle at `__tests__/fixtures/migrate-bundle-mini/`
 * covers all five buckets. Tests assert:
 *   - post-migration tree shape (every file lands where expected)
 *   - frontmatter `schema_version: 1` set on every touched markdown
 *   - idempotency: second run aborts cleanly without `--force`
 *   - `--force` scope is bounded to migrator-owned dirs
 *   - `--dry-run` writes nothing
 *   - missing bundle handled gracefully
 *   - CLI parser routes argv to `{ kind: "migrate-to-desk", ... }`
 *   - CLI executor wires through to the migrator (via deps.bundlesRoot)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import {
  runMigrateToDesk,
  ensureSchemaVersion,
} from "../../../heart/daemon/migrate-to-desk"
import {
  classifyFile,
  deriveTaskSlug,
  extractParentTaskDir,
  resolveUpdatedMs,
} from "../../../repertoire/desk/classifier"
import {
  parseOuroCommand,
  runOuroCli,
  type OuroCliDeps,
} from "../../../heart/daemon/daemon-cli"

const FIXTURE_BUNDLE = path.resolve(
  __dirname,
  "../../fixtures/migrate-bundle-mini",
)

const TODAY = new Date(Date.UTC(2026, 4, 22)) // 2026-05-22
const CUTOFF_MS = Date.UTC(2026, 3, 22) // 2026-04-22

// ── Helpers ──

function makeTempBundle(): string {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "migrate-to-desk-test-"))
  copyDirSync(FIXTURE_BUNDLE, tmp)
  return tmp
}

function copyDirSync(src: string, dst: string): void {
  fs.mkdirSync(dst, { recursive: true })
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name)
    const dstPath = path.join(dst, entry.name)
    if (entry.isDirectory()) {
      copyDirSync(srcPath, dstPath)
    } else if (entry.isFile()) {
      fs.copyFileSync(srcPath, dstPath)
    }
  }
}

function readAll(root: string): string[] {
  const out: string[] = []
  const walk = (dir: string, rel: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const childRel = rel ? path.join(rel, entry.name) : entry.name
      const childAbs = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(childAbs, childRel)
      } else if (entry.isFile()) {
        out.push(childRel.split(path.sep).join("/"))
      }
    }
  }
  walk(root, "")
  return out.sort()
}

// ── Classifier unit tests ──

describe("classifier", () => {
  it("classifies terminal status as terminal", () => {
    const result = classifyFile({
      relPath: "one-shots/2026-04-15-doing-foo.md",
      content: "---\nstatus: done\nupdated: 2026-04-15\n---\nbody",
      mtimeMs: TODAY.getTime(),
      cutoffMs: CUTOFF_MS,
    })
    expect(result.bucket).toBe("terminal")
    expect(result.status).toBe("done")
  })

  it("classifies live status within 30 days as live_clear", () => {
    const result = classifyFile({
      relPath: "one-shots/2026-05-12-doing-foo.md",
      content: "---\nstatus: ready_for_execution\nupdated: 2026-05-12\n---\nbody",
      mtimeMs: TODAY.getTime(),
      cutoffMs: CUTOFF_MS,
    })
    expect(result.bucket).toBe("live_clear")
  })

  it("classifies live status outside 30 days as stale_live", () => {
    const result = classifyFile({
      relPath: "one-shots/2026-03-01-doing-foo.md",
      content: "---\nstatus: in-progress\nupdated: 2026-03-01\n---\nbody",
      mtimeMs: TODAY.getTime(),
      cutoffMs: CUTOFF_MS,
    })
    expect(result.bucket).toBe("stale_live")
  })

  it("classifies missing status as ambiguous", () => {
    const result = classifyFile({
      relPath: "one-shots/2026-04-29-foo.md",
      content: "# foo\nNo frontmatter, no status.",
      mtimeMs: TODAY.getTime(),
      cutoffMs: CUTOFF_MS,
    })
    expect(result.bucket).toBe("ambiguous")
  })

  it("classifies unknown status as ambiguous", () => {
    const result = classifyFile({
      relPath: "one-shots/2026-05-01-foo.md",
      content: "---\nstatus: wibble\n---\nbody",
      mtimeMs: TODAY.getTime(),
      cutoffMs: CUTOFF_MS,
    })
    expect(result.bucket).toBe("ambiguous")
    expect(result.status).toBe("wibble")
  })

  it("classifies files under archive/ as terminal regardless of frontmatter", () => {
    const result = classifyFile({
      relPath: "archive/2026-04-25/2026-03-07-foo.md",
      content: "---\nstatus: in_progress\n---\nbody",
      mtimeMs: TODAY.getTime(),
      cutoffMs: CUTOFF_MS,
    })
    expect(result.bucket).toBe("terminal")
  })

  it("classifies the europe-trip task as special_europe_trip", () => {
    const result = classifyFile({
      relPath: "ongoing/2026-03-09-1410-summer-2026-europe-trip.md",
      content: "---\nstatus: processing\nupdated: 2026-04-30\n---\nbody",
      mtimeMs: TODAY.getTime(),
      cutoffMs: CUTOFF_MS,
    })
    expect(result.bucket).toBe("special_europe_trip")
  })

  it("classifies .md.bak backup files as ambiguous", () => {
    const result = classifyFile({
      relPath: "one-shots/foo.md.bak",
      content: "stuff",
      mtimeMs: TODAY.getTime(),
      cutoffMs: CUTOFF_MS,
    })
    expect(result.bucket).toBe("ambiguous")
    expect(result.reason).toContain("backup")
  })

  it("classifies empty files as ambiguous", () => {
    const result = classifyFile({
      relPath: "one-shots/empty.md",
      content: "",
      mtimeMs: TODAY.getTime(),
      cutoffMs: CUTOFF_MS,
    })
    expect(result.bucket).toBe("ambiguous")
    expect(result.reason).toBe("empty file")
  })

  it("classifies non-markdown standalones as ambiguous", () => {
    const result = classifyFile({
      relPath: "one-shots/log.txt",
      content: "log content",
      mtimeMs: TODAY.getTime(),
      cutoffMs: CUTOFF_MS,
    })
    expect(result.bucket).toBe("ambiguous")
  })

  it("falls back to filename date prefix when no frontmatter updated", () => {
    // Filename `2026-05-12-1122-...` parses to 2026-05-12 11:22 UTC
    const fileDate = Date.UTC(2026, 4, 12, 11, 22)
    const result = classifyFile({
      relPath: "one-shots/2026-05-12-1122-doing-foo.md",
      content: "---\nstatus: ready_for_execution\n---\nbody",
      mtimeMs: 0,
      cutoffMs: CUTOFF_MS,
    })
    expect(result.bucket).toBe("live_clear")
    expect(result.updatedMs).toBe(fileDate)
  })

  it("falls back to filename date prefix without HHMM", () => {
    const result = classifyFile({
      relPath: "one-shots/2026-05-10-doing-foo.md",
      content: "---\nstatus: ready_for_execution\n---\nbody",
      mtimeMs: 0,
      cutoffMs: CUTOFF_MS,
    })
    expect(result.bucket).toBe("live_clear")
    expect(result.updatedMs).toBe(Date.UTC(2026, 4, 10))
  })

  it("falls back to file mtime when nothing else is available", () => {
    const mtime = Date.UTC(2026, 4, 5)
    const result = classifyFile({
      relPath: "scratch.md",
      content: "---\nstatus: in-progress\n---\nbody",
      mtimeMs: mtime,
      cutoffMs: CUTOFF_MS,
    })
    expect(result.updatedMs).toBe(mtime)
  })

  it("falls back to approved date when updated is missing", () => {
    const result = classifyFile({
      relPath: "scratch.md",
      content: "---\nstatus: in-progress\napproved: 2026-05-15\n---\nbody",
      mtimeMs: 0,
      cutoffMs: CUTOFF_MS,
    })
    expect(result.updatedMs).toBe(Date.UTC(2026, 4, 15))
  })

  it("falls back to created date when updated+approved are missing", () => {
    const result = classifyFile({
      relPath: "scratch.md",
      content: "---\nstatus: in-progress\ncreated: 2026-05-10\n---\nbody",
      mtimeMs: 0,
      cutoffMs: CUTOFF_MS,
    })
    expect(result.updatedMs).toBe(Date.UTC(2026, 4, 10))
  })

  it("falls back to body **Updated**: when frontmatter is missing", () => {
    const result = classifyFile({
      relPath: "scratch.md",
      content: "# foo\n\n**Updated**: 2026-05-11\n\nbody",
      mtimeMs: 0,
      cutoffMs: CUTOFF_MS,
    })
    expect(result.updatedMs).toBe(Date.UTC(2026, 4, 11))
  })

  it("resolveUpdatedMs handles malformed frontmatter dates gracefully", () => {
    const ms = resolveUpdatedMs({
      relPath: "scratch.md",
      content: "---\nupdated: not-a-date\n---\nbody",
      mtimeMs: 12345,
      cutoffMs: 0,
    })
    expect(ms).toBe(12345)
  })

  it("derives task slugs from various filename shapes", () => {
    expect(deriveTaskSlug("2026-05-10-doing-foo.md")).toBe("foo")
    expect(deriveTaskSlug("one-shots/2026-05-12-1122-doing-rest-loop-incident.md")).toBe(
      "rest-loop-incident",
    )
    expect(deriveTaskSlug("one-shots/2026-05-12-1122-planning-rest-loop-incident.md")).toBe(
      "rest-loop-incident",
    )
    expect(deriveTaskSlug("one-shots/2026-04-27-ideation-foo.md")).toBe("foo")
    expect(deriveTaskSlug("one-shots/2026-04-27-audit-report-foo.md")).toBe("foo")
    expect(deriveTaskSlug("one-shots/2026-04-27-audit-foo.md")).toBe("foo")
  })

  it("extractParentTaskDir walks up to the task-shaped segment", () => {
    expect(
      extractParentTaskDir("one-shots/2026-05-12-1122-doing-rest-loop-incident/baseline.md"),
    ).toBe("one-shots/2026-05-12-1122-doing-rest-loop-incident")
    expect(extractParentTaskDir("one-shots/2026-05-10-doing-foo.md")).toBeUndefined()
    expect(extractParentTaskDir("foo.md")).toBeUndefined()
  })

  it("ensureSchemaVersion adds schema_version to a file without frontmatter", () => {
    const out = ensureSchemaVersion("# title\nbody")
    expect(out).toMatch(/^---\nschema_version: 1\n---\n# title/)
  })

  it("ensureSchemaVersion injects schema_version into existing frontmatter", () => {
    const out = ensureSchemaVersion("---\nstatus: done\n---\nbody")
    expect(out).toMatch(/schema_version: 1/)
    expect(out).toMatch(/status: done/)
  })

  it("ensureSchemaVersion is idempotent when schema_version already present", () => {
    const input = "---\nschema_version: 1\nstatus: done\n---\nbody"
    expect(ensureSchemaVersion(input)).toBe(input)
  })

  it("deriveTaskSlug falls back to the input when split returns empty", () => {
    // Empty input → split("") returns [""], pop() returns "" → falsy → fallback.
    // Either way the result is the empty string, and the function does not crash.
    expect(deriveTaskSlug("")).toBe("")
  })

  it("classifier treats unclosed frontmatter as having no frontmatter", () => {
    // Opens with --- but never closes → extractFrontmatterBlock returns undefined.
    // Falls through to filename / mtime resolution chain.
    const result = classifyFile({
      relPath: "scratch.md",
      content: "---\nstatus: in-progress\nupdated: 2026-05-12\nno closing fence ever",
      mtimeMs: 42,
      cutoffMs: CUTOFF_MS,
    })
    expect(result.bucket).toBe("ambiguous")
    expect(result.updatedMs).toBe(42)
  })

  it("resolveUpdatedMs handles body **Updated** with non-parseable trailing text", () => {
    // YYYY-MM-DD matches the body regex but the captured value extends past
    // the parseable stem; Date.parse on the full captured string returns NaN
    // → undefined → falls through to mtime.
    const ms = resolveUpdatedMs({
      relPath: "scratch.md",
      content: "**Updated**: not-a-date-at-all-12345xyz67890\n",
      mtimeMs: 7777,
      cutoffMs: 0,
    })
    expect(ms).toBe(7777)
  })

  it("classifier YAML updated accepts ISO 8601 timestamps with time component", () => {
    const result = classifyFile({
      relPath: "scratch.md",
      content: "---\nstatus: in-progress\nupdated: 2026-05-12T08:00:00Z\n---\nbody",
      mtimeMs: 0,
      cutoffMs: CUTOFF_MS,
    })
    expect(result.updatedMs).toBe(Date.UTC(2026, 4, 12, 8, 0, 0))
  })

  it("classifier YAML updated falls back when value fails Date.parse", () => {
    // frontmatter 'updated: garbage123' — string, non-empty, not strict YYYY-MM-DD,
    // Date.parse returns NaN → undefined → falls through.
    const result = classifyFile({
      relPath: "scratch.md",
      content: "---\nstatus: in-progress\nupdated: garbage123\n---\nbody",
      mtimeMs: 5555,
      cutoffMs: CUTOFF_MS,
    })
    expect(result.updatedMs).toBe(5555)
  })

  it("classifier handles empty string updated value", () => {
    // `updated: ` with empty value → parseDateString returns undefined → falls through.
    const result = classifyFile({
      relPath: "scratch.md",
      content: "---\nstatus: in-progress\nupdated: \n---\nbody",
      mtimeMs: 12345,
      cutoffMs: CUTOFF_MS,
    })
    // mtime fallback
    expect(result.updatedMs).toBe(12345)
  })

  it("extractParentTaskDir handles paths with no task-shaped segment gracefully", () => {
    expect(extractParentTaskDir("nested/no/task/segments/here.md")).toBeUndefined()
  })

  it("classifier handles malformed YAML dates (returns undefined → falls through chain)", () => {
    // YYYY-MM-DD format that does NOT parse (clearly bad numbers — Date.UTC handles
    // out-of-range gracefully by normalizing, so this exercises the catch-all
    // Date.parse path with a string that isn't a date).
    const result = classifyFile({
      relPath: "scratch.md",
      content: "---\nstatus: in-progress\nupdated: 99-99-99\n---\nbody",
      mtimeMs: 99999,
      cutoffMs: CUTOFF_MS,
    })
    // updated couldn't parse, so we fall through to filename date prefix (none)
    // then to mtime.
    expect(result.updatedMs).toBe(99999)
  })

  it("ensureSchemaVersion handles malformed (unclosed) frontmatter as no-frontmatter", () => {
    const out = ensureSchemaVersion("---\nstatus: done\nno close fence ever")
    // No closing fence → treated as no-frontmatter; prepends a new block.
    expect(out).toMatch(/^---\nschema_version: 1\n---\n---\nstatus: done/)
  })
})

// ── Migrator integration tests ──

describe("migrate-to-desk", () => {
  let bundle: string

  beforeEach(() => {
    bundle = makeTempBundle()
  })

  afterEach(() => {
    fs.rmSync(bundle, { recursive: true, force: true })
  })

  it("classifies every fixture into the expected bucket", async () => {
    const result = await runMigrateToDesk({
      agent: "fixture",
      root: bundle,
      bundlesRoot: bundle,
      today: TODAY,
      cutoffMs: CUTOFF_MS,
    })
    expect(result.performed).toBe(true)
    expect(result.counts.terminal).toBeGreaterThanOrEqual(3) // archive + 2 paired done
    expect(result.counts.stale_live).toBe(1)
    expect(result.counts.ambiguous).toBeGreaterThanOrEqual(1)
    // live_clear: rest-loop (doing + planning + sub baseline.md + sub log.txt) +
    // second-live-task (doing.md)
    expect(result.counts.live_clear).toBe(5)
    expect(result.counts.special_europe_trip).toBe(1)
  })

  it("writes the post-migration tree in the expected shape", async () => {
    await runMigrateToDesk({
      agent: "fixture",
      root: bundle,
      bundlesRoot: bundle,
      today: TODAY,
      cutoffMs: CUTOFF_MS,
    })
    const deskFiles = readAll(path.join(bundle, "desk"))
    // _archive contains the terminals + stale_live + ambiguous
    expect(deskFiles).toContain("_archive/one-shots/2026-04-15-doing-done-feature.md")
    expect(deskFiles).toContain("_archive/one-shots/2026-04-15-planning-done-feature.md")
    expect(deskFiles).toContain("_archive/archive/2026-04-25/2026-03-07-archived-thing.md")
    expect(deskFiles).toContain("_archive/one-shots/2026-03-01-doing-old-but-live.md")
    expect(deskFiles).toContain("_archive/one-shots/2026-04-29-junk-no-status.md")
    // legacy track with task + iterations
    expect(deskFiles).toContain("legacy/track.md")
    expect(deskFiles).toContain("legacy/rest-loop-incident/task.md")
    expect(deskFiles).toContain("legacy/rest-loop-incident/iterations/2026-05-12-1122-planning-rest-loop-incident.md")
    expect(deskFiles).toContain("legacy/rest-loop-incident/iterations/baseline.md")
    expect(deskFiles).toContain("legacy/rest-loop-incident/iterations/log.txt")
    // europe-trip scaffold
    expect(deskFiles).toContain("summer-2026-europe-trip/track.md")
    expect(deskFiles).toContain("summer-2026-europe-trip/book-replacement-outbound/task.md")
    expect(deskFiles).toContain("summer-2026-europe-trip/weekly-trip-check/task.md")
    expect(deskFiles).toContain("summer-2026-europe-trip/_planning/overview.md")
    expect(deskFiles).toContain("summer-2026-europe-trip/_planning/next-actions.md")
    // featured pointer
    expect(deskFiles).toContain("_meta/featured.md")
    // migration log
    expect(deskFiles).toContain("_meta/migration-2026-05-22.log")
  })

  it("does NOT touch the source tasks/ directory (copy semantics)", async () => {
    const beforeFiles = readAll(path.join(bundle, "tasks"))
    await runMigrateToDesk({
      agent: "fixture",
      root: bundle,
      bundlesRoot: bundle,
      today: TODAY,
      cutoffMs: CUTOFF_MS,
    })
    const afterFiles = readAll(path.join(bundle, "tasks"))
    expect(afterFiles).toEqual(beforeFiles)
  })

  it("sets schema_version: 1 on touched markdown", async () => {
    await runMigrateToDesk({
      agent: "fixture",
      root: bundle,
      bundlesRoot: bundle,
      today: TODAY,
      cutoffMs: CUTOFF_MS,
    })
    const archived = fs.readFileSync(
      path.join(bundle, "desk/_archive/one-shots/2026-04-15-doing-done-feature.md"),
      "utf-8",
    )
    expect(archived).toMatch(/schema_version:\s*1/)

    const task = fs.readFileSync(
      path.join(bundle, "desk/legacy/rest-loop-incident/task.md"),
      "utf-8",
    )
    expect(task).toMatch(/schema_version:\s*1/)

    const ambig = fs.readFileSync(
      path.join(bundle, "desk/_archive/one-shots/2026-04-29-junk-no-status.md"),
      "utf-8",
    )
    expect(ambig).toMatch(/schema_version:\s*1/)
  })

  it("copies non-markdown sub-artifacts without modifying content", async () => {
    const originalLog = fs.readFileSync(
      path.join(
        bundle,
        "tasks/one-shots/2026-05-12-1122-doing-rest-loop-incident/log.txt",
      ),
      "utf-8",
    )
    await runMigrateToDesk({
      agent: "fixture",
      root: bundle,
      bundlesRoot: bundle,
      today: TODAY,
      cutoffMs: CUTOFF_MS,
    })
    const migratedLog = fs.readFileSync(
      path.join(bundle, "desk/legacy/rest-loop-incident/iterations/log.txt"),
      "utf-8",
    )
    // Non-markdown iteration artifacts ride through untouched (byte-for-byte).
    expect(migratedLog).toBe(originalLog)
  })

  it("writes the legacy track.md with the expected frontmatter", async () => {
    await runMigrateToDesk({
      agent: "fixture",
      root: bundle,
      bundlesRoot: bundle,
      today: TODAY,
      cutoffMs: CUTOFF_MS,
    })
    const trackMd = fs.readFileSync(
      path.join(bundle, "desk/legacy/track.md"),
      "utf-8",
    )
    expect(trackMd).toMatch(/track:\s*legacy/)
    expect(trackMd).toMatch(/status:\s*collaborating/)
    expect(trackMd).toMatch(/Migrated from `tasks\/` on 2026-05-22/)
  })

  it("writes the europe-trip track.md with featured: true + trip-tools links", async () => {
    await runMigrateToDesk({
      agent: "fixture",
      root: bundle,
      bundlesRoot: bundle,
      today: TODAY,
      cutoffMs: CUTOFF_MS,
    })
    const trackMd = fs.readFileSync(
      path.join(bundle, "desk/summer-2026-europe-trip/track.md"),
      "utf-8",
    )
    expect(trackMd).toMatch(/featured:\s*true/)
    expect(trackMd).toMatch(/trip_record:/)
    expect(trackMd).toMatch(/travel_docs:/)

    const featured = fs.readFileSync(
      path.join(bundle, "desk/_meta/featured.md"),
      "utf-8",
    )
    expect(featured.trim()).toBe("summer-2026-europe-trip")
  })

  it("writes the migration log with one entry per file", async () => {
    await runMigrateToDesk({
      agent: "fixture",
      root: bundle,
      bundlesRoot: bundle,
      today: TODAY,
      cutoffMs: CUTOFF_MS,
    })
    const log = fs.readFileSync(
      path.join(bundle, "desk/_meta/migration-2026-05-22.log"),
      "utf-8",
    )
    expect(log).toMatch(/# migration log — 2026-05-22/)
    // The done-feature pair should both appear
    expect(log).toContain("2026-04-15-doing-done-feature.md")
    expect(log).toContain("2026-04-15-planning-done-feature.md")
    // The europe-trip task
    expect(log).toContain("ongoing/2026-03-09-1410-summer-2026-europe-trip.md")
  })

  it("aborts cleanly on re-run (idempotency) without --force", async () => {
    await runMigrateToDesk({
      agent: "fixture",
      root: bundle,
      bundlesRoot: bundle,
      today: TODAY,
      cutoffMs: CUTOFF_MS,
    })
    const second = await runMigrateToDesk({
      agent: "fixture",
      root: bundle,
      bundlesRoot: bundle,
      today: TODAY,
      cutoffMs: CUTOFF_MS,
    })
    expect(second.performed).toBe(false)
    expect(second.abortedExisting).toBe(true)
    expect(second.summary).toMatch(/already exists/)
    expect(second.summary).toMatch(/--force/)
  })

  it("--force works when some migrator-owned dirs don't yet exist", async () => {
    // Create only the migration log, none of the owned dirs.
    const metaDir = path.join(bundle, "desk/_meta")
    fs.mkdirSync(metaDir, { recursive: true })
    fs.writeFileSync(path.join(metaDir, "migration-2026-05-22.log"), "stub\n", "utf-8")

    const result = await runMigrateToDesk({
      agent: "fixture",
      root: bundle,
      bundlesRoot: bundle,
      force: true,
      today: TODAY,
      cutoffMs: CUTOFF_MS,
    })
    expect(result.performed).toBe(true)
    expect(fs.existsSync(path.join(bundle, "desk/_archive"))).toBe(true)
  })

  it("--force re-runs and only touches migrator-owned dirs", async () => {
    await runMigrateToDesk({
      agent: "fixture",
      root: bundle,
      bundlesRoot: bundle,
      today: TODAY,
      cutoffMs: CUTOFF_MS,
    })
    // Drop a sentinel file outside the migrator's scope.
    const sentinelDir = path.join(bundle, "desk/some-other-track")
    fs.mkdirSync(sentinelDir, { recursive: true })
    const sentinel = path.join(sentinelDir, "track.md")
    fs.writeFileSync(sentinel, "operator-owned content\n", "utf-8")
    // Also drop a sentinel inside _meta but NOT migration-log or featured.md
    const metaSentinel = path.join(bundle, "desk/_meta/operator-note.md")
    fs.writeFileSync(metaSentinel, "operator note\n", "utf-8")

    const second = await runMigrateToDesk({
      agent: "fixture",
      root: bundle,
      bundlesRoot: bundle,
      force: true,
      today: TODAY,
      cutoffMs: CUTOFF_MS,
    })
    expect(second.performed).toBe(true)

    // Sentinel survived.
    expect(fs.existsSync(sentinel)).toBe(true)
    expect(fs.readFileSync(sentinel, "utf-8")).toBe("operator-owned content\n")
    expect(fs.existsSync(metaSentinel)).toBe(true)

    // Migration log was rewritten.
    expect(fs.existsSync(path.join(bundle, "desk/_meta/migration-2026-05-22.log"))).toBe(
      true,
    )
  })

  it("--dry-run writes no files", async () => {
    const result = await runMigrateToDesk({
      agent: "fixture",
      root: bundle,
      bundlesRoot: bundle,
      dryRun: true,
      today: TODAY,
      cutoffMs: CUTOFF_MS,
    })
    expect(result.performed).toBe(false)
    expect(result.summary).toMatch(/\[dry-run\]/)
    expect(fs.existsSync(path.join(bundle, "desk"))).toBe(false)
  })

  it("dry-run summary reports per-bucket counts", async () => {
    const result = await runMigrateToDesk({
      agent: "fixture",
      root: bundle,
      bundlesRoot: bundle,
      dryRun: true,
      today: TODAY,
      cutoffMs: CUTOFF_MS,
    })
    expect(result.summary).toMatch(/terminal:\s+\d+/)
    expect(result.summary).toMatch(/stale_live:\s+\d+/)
    expect(result.summary).toMatch(/ambiguous:\s+\d+/)
    expect(result.summary).toMatch(/live_clear:\s+\d+/)
    expect(result.summary).toMatch(/special_europe_trip:\s+\d+/)
  })

  it("handles a missing bundle root gracefully", async () => {
    const missing = path.join(bundle, "does-not-exist")
    const result = await runMigrateToDesk({
      agent: "fixture",
      root: missing,
      bundlesRoot: bundle,
      today: TODAY,
      cutoffMs: CUTOFF_MS,
    })
    expect(result.performed).toBe(false)
    expect(result.summary).toMatch(/no tasks\/ directory/)
  })

  it("default root derives from agent + bundlesRoot when --root is unset", async () => {
    // Create a fake bundle at <bundle-parent>/<agent>.ouro/tasks/
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), "migrate-default-root-"))
    const agentBundle = path.join(parent, "alpha.ouro")
    fs.mkdirSync(path.join(agentBundle, "tasks"), { recursive: true })
    fs.writeFileSync(
      path.join(agentBundle, "tasks/foo.md"),
      "---\nstatus: done\n---\nbody",
      "utf-8",
    )
    try {
      const result = await runMigrateToDesk({
        agent: "alpha",
        bundlesRoot: parent,
        today: TODAY,
        cutoffMs: CUTOFF_MS,
      })
      expect(result.performed).toBe(true)
      expect(
        fs.existsSync(path.join(agentBundle, "desk/_archive/foo.md")),
      ).toBe(true)
    } finally {
      fs.rmSync(parent, { recursive: true, force: true })
    }
  })

  it("handles a tasks/ dir that is empty", async () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), "migrate-empty-"))
    fs.mkdirSync(path.join(empty, "tasks"), { recursive: true })
    try {
      const result = await runMigrateToDesk({
        agent: "fixture",
        root: empty,
        bundlesRoot: empty,
        today: TODAY,
        cutoffMs: CUTOFF_MS,
      })
      expect(result.performed).toBe(true)
      expect(result.counts.terminal).toBe(0)
      expect(result.counts.live_clear).toBe(0)
      expect(result.counts.special_europe_trip).toBe(0)
    } finally {
      fs.rmSync(empty, { recursive: true, force: true })
    }
  })
})

// ── CLI parser tests ──

describe("ouro migrate-to-desk CLI parsing", () => {
  it("parses --agent only", () => {
    expect(parseOuroCommand(["migrate-to-desk", "--agent", "slugger"])).toEqual({
      kind: "migrate-to-desk",
      agent: "slugger",
    })
  })

  it("parses --root + --force + --dry-run", () => {
    expect(
      parseOuroCommand([
        "migrate-to-desk",
        "--agent",
        "slugger",
        "--root",
        "/tmp/slugger-latest",
        "--force",
        "--dry-run",
      ]),
    ).toEqual({
      kind: "migrate-to-desk",
      agent: "slugger",
      root: "/tmp/slugger-latest",
      force: true,
      dryRun: true,
    })
  })

  it("requires --agent", () => {
    expect(() => parseOuroCommand(["migrate-to-desk"])).toThrow(/Usage/i)
    expect(() => parseOuroCommand(["migrate-to-desk", "--force"])).toThrow(/Usage/i)
  })

  it("rejects unknown flags", () => {
    expect(() =>
      parseOuroCommand(["migrate-to-desk", "--agent", "slugger", "--wat"]),
    ).toThrow(/Usage/i)
  })
})

// ── CLI executor tests ──

function createMockDeps(overrides: Partial<OuroCliDeps> = {}): OuroCliDeps {
  return {
    socketPath: "/tmp/ouro-test.sock",
    sendCommand: vi.fn(),
    startDaemonProcess: vi.fn().mockResolvedValue({ pid: 1 }),
    writeStdout: vi.fn(),
    setExitCode: vi.fn(),
    checkSocketAlive: vi.fn().mockResolvedValue(true),
    cleanupStaleSocket: vi.fn(),
    fallbackPendingMessage: vi.fn().mockReturnValue("pending"),
    ...overrides,
  }
}

describe("ouro migrate-to-desk CLI execution", () => {
  let bundle: string

  beforeEach(() => {
    bundle = makeTempBundle()
  })

  afterEach(() => {
    fs.rmSync(bundle, { recursive: true, force: true })
  })

  it("runs the migrator via runOuroCli and writes summary to stdout", async () => {
    const writeStdout = vi.fn()
    const deps = createMockDeps({ writeStdout, bundlesRoot: bundle })
    const out = await runOuroCli(
      ["migrate-to-desk", "--agent", "fixture", "--root", bundle, "--dry-run"],
      deps,
    )
    expect(out).toMatch(/\[dry-run\]/)
    expect(writeStdout).toHaveBeenCalled()
    // Verify it did not write any files.
    expect(fs.existsSync(path.join(bundle, "desk"))).toBe(false)
  })

  it("sets exit code on idempotency abort", async () => {
    const setExitCode = vi.fn()
    const deps = createMockDeps({ setExitCode, bundlesRoot: bundle })
    await runOuroCli(
      ["migrate-to-desk", "--agent", "fixture", "--root", bundle],
      deps,
    )
    await runOuroCli(
      ["migrate-to-desk", "--agent", "fixture", "--root", bundle],
      deps,
    )
    expect(setExitCode).toHaveBeenCalledWith(1)
  })
})
