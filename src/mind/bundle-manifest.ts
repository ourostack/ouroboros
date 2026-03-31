import * as fs from "fs"
import * as path from "path"
import { emitNervesEvent } from "../nerves/runtime"

export interface BundleManifestEntry {
  path: string
  kind: "file" | "dir"
}

export interface BundleMeta {
  runtimeVersion: string
  bundleSchemaVersion: number
  lastUpdated: string
  previousRuntimeVersion?: string
}

export const CANONICAL_BUNDLE_MANIFEST: readonly BundleManifestEntry[] = [
  { path: "agent.json", kind: "file" },
  { path: "bundle-meta.json", kind: "file" },
  { path: "psyche/SOUL.md", kind: "file" },
  { path: "psyche/IDENTITY.md", kind: "file" },
  { path: "psyche/LORE.md", kind: "file" },
  { path: "psyche/TACIT.md", kind: "file" },
  { path: "psyche/ASPIRATIONS.md", kind: "file" },
  { path: "diary", kind: "dir" },
  { path: "journal", kind: "dir" },
  { path: "psyche/memory", kind: "dir" },
  { path: "friends", kind: "dir" },
  { path: "state", kind: "dir" },
  { path: "tasks", kind: "dir" },
  { path: "skills", kind: "dir" },
  { path: "senses", kind: "dir" },
  { path: "senses/teams", kind: "dir" },
]

export function getChangelogPath(): string {
  const changelogPath = path.resolve(__dirname, "../../changelog.json")
  emitNervesEvent({
    component: "mind",
    event: "mind.changelog_path_resolved",
    message: "resolved changelog path",
    meta: { path: changelogPath },
  })
  return changelogPath
}

export function getPackageVersion(): string {
  const packageJsonPath = path.resolve(__dirname, "../../package.json")
  const raw = fs.readFileSync(packageJsonPath, "utf-8")
  const parsed = JSON.parse(raw) as { version: string }
  emitNervesEvent({
    component: "mind",
    event: "mind.package_version_read",
    message: "read package version",
    meta: { version: parsed.version },
  })
  return parsed.version
}

export function createBundleMeta(): BundleMeta {
  return {
    runtimeVersion: getPackageVersion(),
    bundleSchemaVersion: 1,
    lastUpdated: new Date().toISOString(),
  }
}

const _backfilledRoots = new Set<string>()

/**
 * If bundle-meta.json is missing from the agent root, create it with current runtime version.
 * This backfills existing agent bundles that were created before bundle-meta.json was introduced.
 * Only attempts once per bundleRoot per process.
 */
export function backfillBundleMeta(bundleRoot: string): void {
  if (_backfilledRoots.has(bundleRoot)) return
  _backfilledRoots.add(bundleRoot)

  const metaPath = path.join(bundleRoot, "bundle-meta.json")
  try {
    if (fs.existsSync(metaPath)) {
      return
    }
    const meta = createBundleMeta()
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2) + "\n", "utf-8")
    emitNervesEvent({
      component: "mind",
      event: "mind.bundle_meta_backfill",
      message: "backfilled missing bundle-meta.json",
      meta: { bundleRoot },
    })
  } catch {
    // Non-blocking: if we can't write, that's okay
  }
}

/**
 * Reset the backfill tracking set. Used in tests.
 */
export function resetBackfillTracking(): void {
  _backfilledRoots.clear()
}

const CANONICAL_FILE_PATHS = new Set(
  CANONICAL_BUNDLE_MANIFEST
    .filter((entry) => entry.kind === "file")
    .map((entry) => entry.path),
)

const CANONICAL_DIR_PATHS = CANONICAL_BUNDLE_MANIFEST
  .filter((entry) => entry.kind === "dir")
  .map((entry) => entry.path)

function normalizeRelativePath(relativePath: string): string {
  return relativePath
    .replace(/\\/g, "/")
    .replace(/^\.?\/+/, "")
    .replace(/\/+$/, "")
}

export function isCanonicalBundlePath(relativePath: string): boolean {
  const normalized = normalizeRelativePath(relativePath)
  if (!normalized) return true
  if (CANONICAL_FILE_PATHS.has(normalized)) return true
  return CANONICAL_DIR_PATHS.some(
    (canonicalDir) => normalized === canonicalDir || normalized.startsWith(`${canonicalDir}/`),
  )
}

export function findNonCanonicalBundlePaths(bundleRoot: string): string[] {
  emitNervesEvent({
    component: "mind",
    event: "mind.bundle_manifest_scan_start",
    message: "scanning bundle for non-canonical paths",
    meta: { bundle_root: bundleRoot },
  })

  const discovered = listBundleRelativePaths(bundleRoot)
  const nonCanonical = discovered
    .filter((relativePath) => !isCanonicalBundlePath(relativePath))
    .sort((left, right) => left.localeCompare(right))

  emitNervesEvent({
    component: "mind",
    event: "mind.bundle_manifest_scan_end",
    message: "bundle non-canonical scan complete",
    meta: { bundle_root: bundleRoot, non_canonical_count: nonCanonical.length },
  })

  return nonCanonical
}

function listBundleRelativePaths(bundleRoot: string): string[] {
  const discovered: string[] = []

  function walk(currentAbsolutePath: string, currentRelativePath: string): void {
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(currentAbsolutePath, { withFileTypes: true })
    } catch {
      return
    }

    for (const entry of entries) {
      const absolutePath = path.join(currentAbsolutePath, entry.name)
      const relativePath = currentRelativePath
        ? `${currentRelativePath}/${entry.name}`
        : entry.name

      discovered.push(relativePath)

      if (entry.isDirectory()) {
        walk(absolutePath, relativePath)
      }
    }
  }

  walk(bundleRoot, "")

  return discovered
}
