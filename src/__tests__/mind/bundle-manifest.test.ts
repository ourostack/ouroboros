import * as fs from "fs"
import * as os from "os"
import * as path from "path"

import { afterEach, describe, expect, it } from "vitest"

import {
  CANONICAL_BUNDLE_MANIFEST,
  findNonCanonicalBundlePaths,
  isCanonicalBundlePath,
  getPackageVersion,
  getChangelogPath,
  createBundleMeta,
  backfillBundleMeta,
  resetBackfillTracking,
} from "../../mind/bundle-manifest"
import type { BundleMeta } from "../../mind/bundle-manifest"

const createdDirs: string[] = []

function createTempBundleRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bundle-manifest-test-"))
  createdDirs.push(dir)
  return dir
}

afterEach(() => {
  while (createdDirs.length > 0) {
    const dir = createdDirs.pop()
    if (dir) fs.rmSync(dir, { recursive: true, force: true })
  }
})

describe("bundle-manifest", () => {
  it("accepts canonical file and directory paths", () => {
    for (const entry of CANONICAL_BUNDLE_MANIFEST) {
      expect(isCanonicalBundlePath(entry.path)).toBe(true)
    }
    expect(isCanonicalBundlePath("")).toBe(true)
    expect(isCanonicalBundlePath("./")).toBe(true)
    expect(isCanonicalBundlePath("\\\\tasks\\\\habit.md")).toBe(true)
    expect(isCanonicalBundlePath("tasks/backlog/task-1.md")).toBe(true)
    expect(isCanonicalBundlePath("skills/custom/review.md")).toBe(true)
    expect(isCanonicalBundlePath("diary/facts.jsonl")).toBe(true)
    expect(isCanonicalBundlePath("diary/daily/2026-03-25.md")).toBe(true)
    expect(isCanonicalBundlePath("arc/episodes/ep-123.json")).toBe(true)
    expect(isCanonicalBundlePath("arc/obligations/ob-123.json")).toBe(true)
    expect(isCanonicalBundlePath("arc/cares/care-123.json")).toBe(true)
    expect(isCanonicalBundlePath("arc/intentions/int-123.json")).toBe(true)
    expect(isCanonicalBundlePath("state/sessions/self/inner/dialog.json")).toBe(true)
  })

  it("rejects non-canonical psyche and legacy bundle paths", () => {
    expect(isCanonicalBundlePath("psyche/FRIENDS.md")).toBe(false)
    expect(isCanonicalBundlePath("psyche/CONTEXT.md")).toBe(false)
    expect(isCanonicalBundlePath("teams-app/manifest.json")).toBe(false)
    expect(isCanonicalBundlePath("random.txt")).toBe(false)
  })

  it("finds non-canonical files and directories", () => {
    const root = createTempBundleRoot()

    fs.mkdirSync(path.join(root, "arc", "episodes"), { recursive: true })
    fs.mkdirSync(path.join(root, "arc", "obligations"), { recursive: true })
    fs.mkdirSync(path.join(root, "arc", "cares"), { recursive: true })
    fs.mkdirSync(path.join(root, "arc", "intentions"), { recursive: true })
    fs.mkdirSync(path.join(root, "psyche"), { recursive: true })
    fs.mkdirSync(path.join(root, "friends"), { recursive: true })
    fs.mkdirSync(path.join(root, "tasks"), { recursive: true })
    fs.mkdirSync(path.join(root, "skills"), { recursive: true })
    fs.mkdirSync(path.join(root, "senses", "teams"), { recursive: true })

    fs.writeFileSync(path.join(root, "agent.json"), "{}")
    fs.writeFileSync(path.join(root, "psyche", "SOUL.md"), "soul")
    fs.writeFileSync(path.join(root, "psyche", "IDENTITY.md"), "identity")
    fs.writeFileSync(path.join(root, "psyche", "LORE.md"), "lore")
    fs.writeFileSync(path.join(root, "psyche", "TACIT.md"), "tacit")
    fs.writeFileSync(path.join(root, "psyche", "ASPIRATIONS.md"), "aspirations")

    fs.writeFileSync(path.join(root, "psyche", "FRIENDS.md"), "legacy")
    fs.mkdirSync(path.join(root, "teams-app"), { recursive: true })
    fs.writeFileSync(path.join(root, "teams-app", "manifest.json"), "{}")

    const nonCanonical = findNonCanonicalBundlePaths(root)

    expect(nonCanonical).toContain("psyche/FRIENDS.md")
    expect(nonCanonical).toContain("teams-app")
    expect(nonCanonical).toContain("teams-app/manifest.json")
    expect(nonCanonical).not.toContain("agent.json")
    expect(nonCanonical).not.toContain("senses/teams")
  })

  it("returns empty list when bundle root is missing", () => {
    const missingRoot = path.join(os.tmpdir(), "does-not-exist-bundle-root")
    expect(findNonCanonicalBundlePaths(missingRoot)).toEqual([])
  })

  it("includes bundle-meta.json in canonical manifest", () => {
    const paths = CANONICAL_BUNDLE_MANIFEST.map((e) => e.path)
    expect(paths).toContain("bundle-meta.json")
    const entry = CANONICAL_BUNDLE_MANIFEST.find((e) => e.path === "bundle-meta.json")
    expect(entry?.kind).toBe("file")
  })

  it("accepts bundle-meta.json as a canonical path", () => {
    expect(isCanonicalBundlePath("bundle-meta.json")).toBe(true)
  })
})

describe("getPackageVersion", () => {
  it("returns a semver-like version string", () => {
    const version = getPackageVersion()
    expect(typeof version).toBe("string")
    expect(version.length).toBeGreaterThan(0)
    // Should look like a version (starts with digit)
    expect(version).toMatch(/^\d+\.\d+\.\d+/)
  })
})

describe("createBundleMeta", () => {
  it("returns BundleMeta with current runtime version", () => {
    const meta: BundleMeta = createBundleMeta()
    expect(meta.runtimeVersion).toBe(getPackageVersion())
  })

  it("returns bundleSchemaVersion 1", () => {
    const meta: BundleMeta = createBundleMeta()
    expect(meta.bundleSchemaVersion).toBe(1)
  })

  it("returns a valid ISO timestamp for lastUpdated", () => {
    const before = new Date().toISOString()
    const meta: BundleMeta = createBundleMeta()
    const after = new Date().toISOString()
    expect(meta.lastUpdated >= before).toBe(true)
    expect(meta.lastUpdated <= after).toBe(true)
  })
})

describe("backfillBundleMeta", () => {
  afterEach(() => {
    resetBackfillTracking()
  })

  it("creates bundle-meta.json when missing", () => {
    const bundleRoot = createTempBundleRoot()

    backfillBundleMeta(bundleRoot)

    const metaPath = path.join(bundleRoot, "bundle-meta.json")
    expect(fs.existsSync(metaPath)).toBe(true)
    const meta = JSON.parse(fs.readFileSync(metaPath, "utf-8")) as BundleMeta
    expect(meta.runtimeVersion).toBe(getPackageVersion())
    expect(meta.bundleSchemaVersion).toBe(1)
    expect(meta.lastUpdated).toBeTruthy()
  })

  it("does not overwrite existing bundle-meta.json", () => {
    const bundleRoot = createTempBundleRoot()
    const metaPath = path.join(bundleRoot, "bundle-meta.json")
    const existingMeta = { runtimeVersion: "0.0.1", bundleSchemaVersion: 1, lastUpdated: "2025-01-01T00:00:00Z" }
    fs.writeFileSync(metaPath, JSON.stringify(existingMeta), "utf-8")

    backfillBundleMeta(bundleRoot)

    const meta = JSON.parse(fs.readFileSync(metaPath, "utf-8")) as BundleMeta
    expect(meta.runtimeVersion).toBe("0.0.1")
    expect(meta.lastUpdated).toBe("2025-01-01T00:00:00Z")
  })

  it("handles non-existent bundleRoot gracefully", () => {
    expect(() => backfillBundleMeta("/nonexistent/bundle/root")).not.toThrow()
  })
})

describe("previousRuntimeVersion in BundleMeta", () => {
  afterEach(() => {
    resetBackfillTracking()
  })

  it("createBundleMeta does not set previousRuntimeVersion on first create", () => {
    const meta = createBundleMeta()
    expect(meta.previousRuntimeVersion).toBeUndefined()
  })

  it("backfillBundleMeta preserves existing previousRuntimeVersion", () => {
    const bundleRoot = createTempBundleRoot()
    const metaPath = path.join(bundleRoot, "bundle-meta.json")
    const existingMeta = {
      runtimeVersion: "0.0.1",
      bundleSchemaVersion: 1,
      lastUpdated: "2025-01-01T00:00:00Z",
      previousRuntimeVersion: "0.0.0",
    }
    fs.writeFileSync(metaPath, JSON.stringify(existingMeta), "utf-8")

    backfillBundleMeta(bundleRoot)

    const meta = JSON.parse(fs.readFileSync(metaPath, "utf-8")) as BundleMeta
    expect(meta.previousRuntimeVersion).toBe("0.0.0")
  })

  it("reads bundle-meta.json without previousRuntimeVersion field", () => {
    const bundleRoot = createTempBundleRoot()
    const metaPath = path.join(bundleRoot, "bundle-meta.json")
    const existingMeta = {
      runtimeVersion: "0.0.1",
      bundleSchemaVersion: 1,
      lastUpdated: "2025-01-01T00:00:00Z",
    }
    fs.writeFileSync(metaPath, JSON.stringify(existingMeta), "utf-8")

    const raw = fs.readFileSync(metaPath, "utf-8")
    const meta = JSON.parse(raw) as BundleMeta
    expect(meta.runtimeVersion).toBe("0.0.1")
    expect(meta.previousRuntimeVersion).toBeUndefined()
  })

  it("reads bundle-meta.json with previousRuntimeVersion field", () => {
    const bundleRoot = createTempBundleRoot()
    const metaPath = path.join(bundleRoot, "bundle-meta.json")
    const existingMeta = {
      runtimeVersion: "0.1.0",
      bundleSchemaVersion: 1,
      lastUpdated: "2025-01-01T00:00:00Z",
      previousRuntimeVersion: "0.0.9",
    }
    fs.writeFileSync(metaPath, JSON.stringify(existingMeta), "utf-8")

    const raw = fs.readFileSync(metaPath, "utf-8")
    const meta = JSON.parse(raw) as BundleMeta
    expect(meta.runtimeVersion).toBe("0.1.0")
    expect(meta.previousRuntimeVersion).toBe("0.0.9")
  })
})

describe("getChangelogPath", () => {
  it("returns a valid absolute path", () => {
    const result = getChangelogPath()
    expect(path.isAbsolute(result)).toBe(true)
  })

  it("returns a path ending with changelog.json", () => {
    const result = getChangelogPath()
    expect(result).toMatch(/changelog\.json$/)
  })

  it("points to an existing file", () => {
    const result = getChangelogPath()
    expect(fs.existsSync(result)).toBe(true)
  })
})
