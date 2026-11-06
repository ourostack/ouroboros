import * as fs from "fs"
import * as path from "path"
import { emitNervesEvent } from "../../nerves/runtime"
import { renderHabitFile } from "./habit-parser"
import { writeHabitLastRun } from "./habit-runtime-state"
import { parseFrontmatter } from "../../repertoire/tasks/parser"

/** Fields that belong to the task system and should be stripped from migrated habits. */
const TASK_ONLY_FIELDS = new Set([
  "type",
  "category",
  "requester",
  "validator",
  "scheduledAt",
  "updated",
  "depends_on",
  "parent_task",
  "artifacts",
])

/** Regex matching the YYYY-MM-DD-HHMM- timestamp prefix in task filenames. */
const TIMESTAMP_PREFIX = /^\d{4}-\d{2}-\d{2}-\d{4}-/

/** Map old task statuses to habit statuses. */
function mapStatus(taskStatus: string): "active" | "paused" | null {
  if (taskStatus === "processing") return "active"
  if (taskStatus === "paused") return "paused"
  if (taskStatus === "done") return null // skip done habits
  return "active" // default to active for unknown statuses
}

/** Strip timestamp prefix from filename to get the slug name. */
function stripTimestampPrefix(filename: string): string {
  return filename.replace(TIMESTAMP_PREFIX, "")
}

/**
 * Migrate habit files from the old `tasks/habits/` location to the new `habits/` bundle root.
 * - Strips timestamp prefix from filenames
 * - Maps task statuses to habit statuses
 * - Strips task-only frontmatter fields
 * - Preserves body text
 * - Skips done habits, README files, and already-migrated habits
 * - No-op if `tasks/habits/` does not exist
 */
export function migrateHabitsFromTaskSystem(bundleRoot: string): void {
  const oldHabitsDir = path.join(bundleRoot, "tasks", "habits")

  if (!fs.existsSync(oldHabitsDir)) {
    return
  }

  let files: string[]
  try {
    files = fs.readdirSync(oldHabitsDir)
  } catch {
    /* v8 ignore next -- race condition: dir removed between existsSync and readdirSync @preserve */
    return
  }

  const mdFiles = files.filter((f) => f.endsWith(".md") && f !== "README.md")
  if (mdFiles.length === 0) return

  const newHabitsDir = path.join(bundleRoot, "habits")
  fs.mkdirSync(newHabitsDir, { recursive: true })

  let migratedCount = 0

  for (const file of mdFiles) {
    const slugName = stripTimestampPrefix(file)
    const targetPath = path.join(newHabitsDir, slugName)

    // Skip if already migrated
    if (fs.existsSync(targetPath)) {
      emitNervesEvent({
        component: "daemon",
        event: "daemon.habit_migration_skip",
        message: "habit already exists at target, skipping",
        meta: { file, targetPath },
      })
      continue
    }

    const sourcePath = path.join(oldHabitsDir, file)
    let content: string
    try {
      content = fs.readFileSync(sourcePath, "utf-8")
    } catch {
      continue
    }

    // Parse frontmatter and body
    const lines = content.split(/\r?\n/)
    if (lines[0]?.trim() !== "---") continue

    const closing = lines.findIndex((line, index) => index > 0 && line.trim() === "---")
    if (closing === -1) continue

    const rawFrontmatter = lines.slice(1, closing).join("\n")
    const body = lines.slice(closing + 1).join("\n").trim()
    const frontmatter = parseFrontmatter(rawFrontmatter)

    // Check status — skip done habits
    const rawStatus = typeof frontmatter.status === "string" ? frontmatter.status : "processing"
    const habitStatus = mapStatus(rawStatus)
    if (habitStatus === null) {
      emitNervesEvent({
        component: "daemon",
        event: "daemon.habit_migration_skip",
        message: "skipping done habit",
        meta: { file, status: rawStatus },
      })
      continue
    }

    const legacyLastRun = typeof frontmatter.lastRun === "string" && frontmatter.lastRun !== "null"
      ? frontmatter.lastRun
      : typeof frontmatter.last_run === "string" && frontmatter.last_run !== "null"
        ? frontmatter.last_run
        : null

    // Build new frontmatter, stripping task-only fields
    const newFrontmatter: Record<string, unknown> = {}
    if (typeof frontmatter.title === "string") newFrontmatter.title = frontmatter.title
    if (typeof frontmatter.cadence === "string") newFrontmatter.cadence = frontmatter.cadence
    newFrontmatter.status = habitStatus
    newFrontmatter.created = typeof frontmatter.created === "string" ? frontmatter.created : "null"

    // Add any other non-task fields from original
    for (const [key, value] of Object.entries(frontmatter)) {
      if (TASK_ONLY_FIELDS.has(key)) continue
      if (key === "lastRun" || key === "last_run") continue
      if (key in newFrontmatter) continue
      /* v8 ignore next -- dead code: status is caught by `key in newFrontmatter` above since newFrontmatter.status is always set @preserve */
      if (key === "status") continue // already mapped
      newFrontmatter[key] = value
    }

    const rendered = renderHabitFile(newFrontmatter, body)
    fs.writeFileSync(targetPath, rendered, "utf-8")
    if (legacyLastRun) {
      writeHabitLastRun(bundleRoot, path.basename(slugName, ".md"), legacyLastRun)
    }
    migratedCount++

    emitNervesEvent({
      component: "daemon",
      event: "daemon.habit_migrated",
      message: "migrated habit from task system",
      meta: { from: sourcePath, to: targetPath },
    })
  }

  if (migratedCount > 0) {
    emitNervesEvent({
      component: "daemon",
      event: "daemon.habit_migration_complete",
      message: "habit migration complete",
      meta: { bundleRoot, count: migratedCount },
    })
  }
}
