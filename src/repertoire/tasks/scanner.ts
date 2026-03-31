import * as fs from "fs"
import * as path from "path"
import { getAgentRoot } from "../../heart/identity"
import { emitNervesEvent } from "../../nerves/runtime"
import type { TaskFile, TaskIndex, TaskIssue } from "./types"
import {
  TASK_CANONICAL_COLLECTIONS,
  isCanonicalTaskFilename,
} from "./transitions"
import { parseFrontmatter, parseTaskFile } from "./parser"

let scanCache: { fingerprint: string; index: TaskIndex } | null = null

export function getTaskRoot(): string {
  return path.join(getAgentRoot(), "tasks")
}

export function ensureTaskLayout(root = getTaskRoot()): void {
  const dirs = [
    root,
    ...TASK_CANONICAL_COLLECTIONS.map((collection) => path.join(root, collection)),
    path.join(root, "templates"),
    path.join(root, ".trash"),
    path.join(root, "archive"),
  ]

  for (const dir of dirs) {
    fs.mkdirSync(dir, { recursive: true })
  }
}

/**
 * Attempt to extract frontmatter from markdown content.
 * Returns parsed frontmatter dict or null. Never throws.
 */
export function tryExtractFrontmatter(content: string): Record<string, unknown> | null {
  emitNervesEvent({
    event: "repertoire.frontmatter_extract_start",
    component: "repertoire",
    message: "attempting frontmatter extraction",
  })

  const lines = content.split(/\r?\n/)
  if (lines[0]?.trim() !== "---") {
    return null
  }

  const closing = lines.findIndex((line, index) => index > 0 && line.trim() === "---")
  if (closing === -1) {
    return null
  }

  try {
    const rawFrontmatter = lines.slice(1, closing).join("\n")
    return parseFrontmatter(rawFrontmatter)
  } catch {
    return null
  }
}

const LEGACY_TASK_TYPES = ["one-shot", "ongoing", "habit"]

function buildFingerprint(root: string): string {
  emitNervesEvent({
    event: "repertoire.fingerprint_build_start",
    component: "repertoire",
    message: "building scan fingerprint",
    meta: { root },
  })

  const segments: string[] = []

  for (const collection of TASK_CANONICAL_COLLECTIONS) {
    const collDir = path.join(root, collection)
    if (!fs.existsSync(collDir)) continue

    const entries = fs.readdirSync(collDir, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".md")) continue
      const filePath = path.join(collDir, entry.name)
      const stat = fs.statSync(filePath)
      segments.push(`${filePath}:${stat.mtimeMs}:${stat.size}`)
    }
  }

  // Also include root-level md files for orphan detection fingerprinting
  if (fs.existsSync(root)) {
    const rootEntries = fs.readdirSync(root, { withFileTypes: true })
    for (const entry of rootEntries) {
      if (!entry.isFile() || !entry.name.endsWith(".md")) continue
      const filePath = path.join(root, entry.name)
      const stat = fs.statSync(filePath)
      segments.push(`${filePath}:${stat.mtimeMs}:${stat.size}`)
    }
  }

  segments.sort()
  return segments.join("|")
}

export function clearTaskScanCache(): void {
  scanCache = null
}

export function scanTasks(root = getTaskRoot()): TaskIndex {
  emitNervesEvent({
    event: "mind.step_start",
    component: "mind",
    message: "scanning task files",
    meta: { root },
  })

  ensureTaskLayout(root)

  const fingerprint = buildFingerprint(root)
  if (scanCache && scanCache.fingerprint === fingerprint) {
    return scanCache.index
  }

  const tasks: TaskFile[] = []
  const issues: TaskIssue[] = []

  // Scan each collection with flat directory reads (no recursion)
  for (const collection of TASK_CANONICAL_COLLECTIONS) {
    const collDir = path.join(root, collection)
    if (!fs.existsSync(collDir)) continue

    const entries = fs.readdirSync(collDir, { withFileTypes: true })
    const dirNames = new Set<string>()

    // Collect directory names for work dir detection
    for (const entry of entries) {
      if (entry.isDirectory()) {
        dirNames.add(entry.name)
      }
    }

    // Process only .md files at collection root (flat, no recursion)
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".md")) continue

      const filePath = path.join(collDir, entry.name)
      const content = fs.readFileSync(filePath, "utf-8")

      // Step 1: Try to extract frontmatter
      const frontmatter = tryExtractFrontmatter(content)
      if (!frontmatter) {
        // No frontmatter — not a task, skip silently
        continue
      }

      // Step 2: Check kind: task
      const isKindTask = frontmatter.kind === "task"
      const fmType = typeof frontmatter.type === "string" ? frontmatter.type.trim().toLowerCase() : ""
      const isLegacyTask = !isKindTask && LEGACY_TASK_TYPES.includes(fmType)

      if (!isKindTask && !isLegacyTask) {
        // Has frontmatter but not a task — skip silently
        continue
      }

      // Step 3: Emit migration issue for legacy task
      if (isLegacyTask) {
        const relPath = path.relative(root, filePath)
        issues.push({
          target: relPath,
          code: "schema-missing-kind",
          description: "Task card missing kind: task field",
          fix: "Add kind: task to frontmatter",
          confidence: "safe",
          category: "migration",
        })
      }

      // Step 4: Parse the task file
      try {
        const task = parseTaskFile(content, filePath)

        // Check filename canonicality
        const base = path.basename(filePath)
        if (!isCanonicalTaskFilename(base)) {
          const relPath = path.relative(root, filePath)
          issues.push({
            target: relPath,
            code: "filename-not-canonical",
            description: `Non-canonical filename: ${base}`,
            fix: `Rename to canonical format (YYYY-MM-DD-HHMM-slug.md)`,
            confidence: "safe",
            category: "migration",
          })
        }

        // Work dir detection
        const stem = base.replace(/\.md$/i, "")
        if (dirNames.has(stem)) {
          task.hasWorkDir = true
          const workDirPath = path.join(collDir, stem)
          task.workDirFiles = fs.readdirSync(workDirPath).sort()
        }

        tasks.push(task)
      } catch (error) {
        // Parse error on a file we identified as a task — real issue
        const relPath = path.relative(root, filePath)
        issues.push({
          target: relPath,
          code: "schema-invalid",
          description: `Parse error: ${error instanceof Error ? error.message : String(error)}`,
          fix: "Fix the task card schema (ensure required fields: type, status, etc.)",
          confidence: "needs_review",
          category: "live",
        })
      }
    }
  }

  // Orphan detection: root-level .md files outside any canonical collection
  if (fs.existsSync(root)) {
    const rootEntries = fs.readdirSync(root, { withFileTypes: true })
    const collectionSet = new Set<string>(TASK_CANONICAL_COLLECTIONS)

    for (const entry of rootEntries) {
      if (!entry.isFile() || !entry.name.endsWith(".md")) continue

      const filePath = path.join(root, entry.name)
      const content = fs.readFileSync(filePath, "utf-8")
      const frontmatter = tryExtractFrontmatter(content)

      // Only flag as orphan if it has task-like frontmatter
      if (!frontmatter) continue

      const fmType = typeof frontmatter.type === "string" ? frontmatter.type.trim().toLowerCase() : ""
      const hasTaskLikeContent =
        frontmatter.kind === "task" ||
        LEGACY_TASK_TYPES.includes(fmType) ||
        (typeof frontmatter.status === "string" && typeof frontmatter.title === "string")

      if (hasTaskLikeContent) {
        emitNervesEvent({
          event: "repertoire.orphan_detected",
          component: "repertoire",
          message: "root-level orphan document detected",
          meta: { filePath },
        })

        issues.push({
          target: entry.name,
          code: "org-root-level-doc",
          description: `Root-level document outside any collection: ${entry.name}`,
          fix: `Move to appropriate collection directory (${[...collectionSet].join(", ")})`,
          confidence: "needs_review",
          category: "migration",
        })
      }
    }
  }

  // Populate derivedChildren from parent_task links
  const stemToTask = new Map<string, TaskFile>()
  for (const task of tasks) {
    stemToTask.set(task.stem, task)
  }

  for (const task of tasks) {
    const parentStem = typeof task.frontmatter.parent_task === "string"
      ? task.frontmatter.parent_task.trim()
      : ""

    if (parentStem && stemToTask.has(parentStem)) {
      const parent = stemToTask.get(parentStem)!
      parent.derivedChildren.push(task.stem)
    }
  }

  const index: TaskIndex = {
    root,
    tasks,
    issues,
    fingerprint,
  }

  scanCache = { fingerprint, index }
  return index
}
