import * as fs from "fs"
import * as path from "path"
import { emitNervesEvent } from "../../../nerves/runtime"
import type { BundleMeta } from "../../../mind/bundle-manifest"
import type { UpdateHookContext, UpdateHookResult } from "../../versioning/update-hooks"

/**
 * Migrate bundle from schema 1 to schema 2:
 * - Move state/{episodes,obligations,cares,intentions}/* to arc/{name}/*
 * - Move psyche/memory/* to diary/
 * Idempotent: skips missing sources; on collision, newer mtime wins.
 */
function migrateToSchema2(agentRoot: string): void {
  emitNervesEvent({
    component: "daemon",
    event: "daemon.bundle_migration_start",
    message: "migrating bundle to schema 2",
    meta: { agentRoot },
  })

  // Migrate arc entities
  for (const name of ["episodes", "obligations", "cares", "intentions"]) {
    const src = path.join(agentRoot, "state", name)
    const dest = path.join(agentRoot, "arc", name)
    migrateDirectory(src, dest)
  }

  // Migrate diary
  const memorySrc = path.join(agentRoot, "psyche", "memory")
  const diaryDest = path.join(agentRoot, "diary")
  migrateDirectory(memorySrc, diaryDest)

  // Update bundle .gitignore
  updateBundleGitignore(agentRoot)

  emitNervesEvent({
    component: "daemon",
    event: "daemon.bundle_migration_end",
    message: "bundle migration to schema 2 complete",
    meta: { agentRoot },
  })
}

/**
 * Ensure bundle .gitignore has state/ ignored and does NOT ignore arc/, diary/, journal/.
 */
function updateBundleGitignore(agentRoot: string): void {
  const gitignorePath = path.join(agentRoot, ".gitignore")
  let lines: string[] = []

  try {
    if (fs.existsSync(gitignorePath)) {
      lines = fs.readFileSync(gitignorePath, "utf-8").split("\n")
    }
  } catch {
    // If we can't read, start fresh
  }

  // Remove arc/, diary/, journal/ from ignore (they should be tracked)
  const toRemove = new Set(["arc/", "diary/", "journal/"])
  lines = lines.filter((line) => !toRemove.has(line.trim()))

  // Ensure state/ is in the ignore list
  const hasState = lines.some((line) => line.trim() === "state/")
  if (!hasState) {
    lines.push("state/")
  }

  // Write back, trimming trailing empty lines and ensuring trailing newline
  const content = lines.join("\n").replace(/\n+$/, "") + "\n"
  try {
    fs.writeFileSync(gitignorePath, content, "utf-8")
  } catch {
    // Non-blocking: if we can't write .gitignore, migration still succeeds
  }
}

/**
 * Recursively copy files from src to dest.
 * Creates destination directories as needed. Skips if source doesn't exist.
 * When both source and destination exist, compares mtimes: newer file wins.
 * Logs a warning either way when a collision is detected.
 */
function migrateDirectory(src: string, dest: string): void {
  if (!fs.existsSync(src)) return

  fs.mkdirSync(dest, { recursive: true })

  const entries = fs.readdirSync(src, { withFileTypes: true })
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name)
    const destPath = path.join(dest, entry.name)

    if (entry.isDirectory()) {
      migrateDirectory(srcPath, destPath)
    } else if (!fs.existsSync(destPath)) {
      fs.copyFileSync(srcPath, destPath)
    } else {
      // Collision: both source and destination exist — compare mtimes
      const srcMtime = fs.statSync(srcPath).mtimeMs
      const destMtime = fs.statSync(destPath).mtimeMs
      if (srcMtime > destMtime) {
        fs.copyFileSync(srcPath, destPath)
        emitNervesEvent({
          level: "warn",
          component: "daemon",
          event: "daemon.bundle_migration_collision",
          message: `migration collision: source newer, overwriting destination`,
          meta: { srcPath, destPath, srcMtime, destMtime },
        })
      } else {
        emitNervesEvent({
          level: "warn",
          component: "daemon",
          event: "daemon.bundle_migration_collision",
          message: `migration collision: destination newer or equal, keeping destination`,
          meta: { srcPath, destPath, srcMtime, destMtime },
        })
      }
    }
  }
}

export async function bundleMetaHook(ctx: UpdateHookContext): Promise<UpdateHookResult> {
  emitNervesEvent({
    component: "daemon",
    event: "daemon.bundle_meta_hook_start",
    message: "running bundle-meta update hook",
    meta: { agentRoot: ctx.agentRoot, currentVersion: ctx.currentVersion },
  })

  const metaPath = path.join(ctx.agentRoot, "bundle-meta.json")

  let existing: BundleMeta | undefined
  try {
    if (fs.existsSync(metaPath)) {
      const raw = fs.readFileSync(metaPath, "utf-8")
      existing = JSON.parse(raw) as BundleMeta
    }
  } catch {
    // Malformed JSON -- treat as missing, will overwrite with fresh
    existing = undefined
  }

  // Run schema-2 migration if needed
  const currentSchema = existing?.bundleSchemaVersion ?? 1
  if (currentSchema < 2) {
    migrateToSchema2(ctx.agentRoot)
  }

  const updated: BundleMeta = {
    runtimeVersion: ctx.currentVersion,
    bundleSchemaVersion: currentSchema < 2 ? 2 : currentSchema,
    lastUpdated: new Date().toISOString(),
  }

  // Save old runtimeVersion as previousRuntimeVersion (if there was one)
  if (existing?.runtimeVersion) {
    updated.previousRuntimeVersion = existing.runtimeVersion
  }

  try {
    fs.writeFileSync(metaPath, JSON.stringify(updated, null, 2) + "\n", "utf-8")
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : /* v8 ignore next -- defensive: non-Error catch branch @preserve */ String(err)
    emitNervesEvent({
      component: "daemon",
      event: "daemon.bundle_meta_hook_error",
      message: "bundle-meta hook write failed",
      meta: { agentRoot: ctx.agentRoot, error: errorMessage },
    })
    return { ok: false, error: errorMessage }
  }

  emitNervesEvent({
    component: "daemon",
    event: "daemon.bundle_meta_hook_end",
    message: "bundle-meta updated",
    meta: {
      agentRoot: ctx.agentRoot,
      runtimeVersion: updated.runtimeVersion,
      previousRuntimeVersion: updated.previousRuntimeVersion,
    },
  })

  return { ok: true }
}
