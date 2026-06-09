import * as fs from "fs"
import * as path from "path"
import { getAgentRoot } from "../heart/identity"
import { emitNervesEvent } from "../nerves/runtime"

export interface DeskRecordPaths {
  recordRoot: string
  diaryRoot: string
  diaryDailyDir: string
  factsPath: string
  entitiesPath: string
  notesRoot: string
  migrationReportPath: string
}

interface MigrationReportEntry {
  schemaVersion: 1
  action: "moved" | "merged" | "removed" | "dropped" | "created" | "quarantined"
  source?: string
  destination?: string
  reason: string
  recordedAt: string
}

const migratedAgentRoots = new Set<string>()
const DERIVED_JOURNAL_INDEX_FILES = new Set([".index.json"])

function nowIso(): string {
  return new Date().toISOString()
}

export function resolveDeskRecordPaths(agentRoot = getAgentRoot()): DeskRecordPaths {
  const recordRoot = path.join(agentRoot, "desk", "_record")
  const diaryRoot = path.join(recordRoot, "diary")
  return {
    recordRoot,
    diaryRoot,
    diaryDailyDir: path.join(diaryRoot, "daily"),
    factsPath: path.join(diaryRoot, "facts.jsonl"),
    entitiesPath: path.join(diaryRoot, "entities.json"),
    notesRoot: path.join(recordRoot, "notes"),
    migrationReportPath: path.join(recordRoot, "migration-report.jsonl"),
  }
}

function appendMigrationReport(paths: DeskRecordPaths, entry: Omit<MigrationReportEntry, "schemaVersion" | "recordedAt">): void {
  fs.mkdirSync(paths.recordRoot, { recursive: true })
  fs.appendFileSync(
    paths.migrationReportPath,
    `${JSON.stringify({ schemaVersion: 1, recordedAt: nowIso(), ...entry })}\n`,
    "utf-8",
  )
}

function ensureRecordScaffold(paths: DeskRecordPaths): void {
  fs.mkdirSync(paths.diaryDailyDir, { recursive: true })
  fs.mkdirSync(paths.notesRoot, { recursive: true })
  if (!fs.existsSync(paths.factsPath)) fs.writeFileSync(paths.factsPath, "", "utf-8")
  if (!fs.existsSync(paths.entitiesPath)) fs.writeFileSync(paths.entitiesPath, "{}\n", "utf-8")
}

function uniquePathForCollision(destination: string): string {
  const dir = path.dirname(destination)
  const ext = path.extname(destination)
  const base = path.basename(destination, ext)
  for (let index = 1; index < 10_000; index += 1) {
    const candidate = path.join(dir, `${base}.migrated-${index}${ext}`)
    if (!fs.existsSync(candidate)) return candidate
  }
  /* v8 ignore next -- defensive exhaustion guard; normal collision allocation is covered @preserve */
  throw new Error(`could not allocate migration collision path for ${destination}`)
}

function mergeJsonlFile(source: string, destination: string): "copied" | "merged" | "kept-destination" {
  const sourceText = fs.readFileSync(source, "utf-8")
  if (!fs.existsSync(destination)) {
    fs.writeFileSync(destination, sourceText, "utf-8")
    return "copied"
  }
  const destinationText = fs.readFileSync(destination, "utf-8")
  const existing = new Set(destinationText.split(/\r?\n/).map((line) => line.trim()).filter(Boolean))
  const additions = sourceText.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0 && !existing.has(line))
  if (additions.length === 0) return "kept-destination"
  const prefix = destinationText.length > 0 && !destinationText.endsWith("\n") ? "\n" : ""
  fs.appendFileSync(destination, `${prefix}${additions.join("\n")}\n`, "utf-8")
  return "merged"
}

function readJsonObject(filePath: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf-8")) as unknown
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null
  } catch {
    return null
  }
}

function mergeEntitiesFile(source: string, destination: string): "copied" | "merged" | "kept-destination" {
  if (!fs.existsSync(destination)) {
    fs.copyFileSync(source, destination)
    return "copied"
  }
  const sourceObject = readJsonObject(source)
  const destinationObject = readJsonObject(destination)
  if (!sourceObject || !destinationObject) return copyLosslessFile(source, destination) === destination ? "merged" : "copied"

  const conflicts: Record<string, unknown> = {}
  const merged: Record<string, unknown> = { ...destinationObject }
  for (const [key, value] of Object.entries(sourceObject)) {
    if (!(key in merged)) {
      merged[key] = value
      continue
    }
    if (JSON.stringify(merged[key]) !== JSON.stringify(value)) {
      conflicts[key] = value
    }
  }
  fs.writeFileSync(destination, `${JSON.stringify(merged, null, 2)}\n`, "utf-8")
  if (Object.keys(conflicts).length > 0) {
    const conflictPath = uniquePathForCollision(path.join(path.dirname(destination), "entities.migration-conflicts.json"))
    fs.writeFileSync(conflictPath, `${JSON.stringify(conflicts, null, 2)}\n`, "utf-8")
  }
  return Object.keys(sourceObject).length > 0 ? "merged" : "kept-destination"
}

function copyLosslessFile(source: string, destination: string): string {
  if (!fs.existsSync(destination)) {
    fs.copyFileSync(source, destination)
    return destination
  }
  const sourceContent = fs.readFileSync(source)
  const destinationContent = fs.readFileSync(destination)
  if (sourceContent.equals(destinationContent)) return destination
  if (sourceContent.length > 0 && destinationContent.length === 0) {
    fs.copyFileSync(source, destination)
    return destination
  }
  const collisionPath = uniquePathForCollision(destination)
  fs.copyFileSync(source, collisionPath)
  return collisionPath
}

function mergeRecordFile(source: string, destination: string): void {
  fs.mkdirSync(path.dirname(destination), { recursive: true })
  const basename = path.basename(destination)
  if (basename === "facts.jsonl" || destination.endsWith(".jsonl")) {
    mergeJsonlFile(source, destination)
    return
  }
  if (basename === "entities.json") {
    mergeEntitiesFile(source, destination)
    return
  }
  copyLosslessFile(source, destination)
}

function mergeDirectory(source: string, destination: string): void {
  fs.mkdirSync(destination, { recursive: true })
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const sourcePath = path.join(source, entry.name)
    const destinationPath = path.join(destination, entry.name)
    if (entry.isDirectory()) {
      mergeDirectory(sourcePath, destinationPath)
      continue
    }
    mergeRecordFile(sourcePath, destinationPath)
  }
}

function removeDirectoryTree(root: string): void {
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const entryPath = path.join(root, entry.name)
    if (entry.isDirectory()) {
      removeDirectoryTree(entryPath)
      continue
    }
    fs.rmSync(entryPath, { force: true })
  }
  fs.rmdirSync(root)
}

function moveOrMergeDirectory(paths: DeskRecordPaths, source: string, destination: string, reason: string): void {
  if (!fs.existsSync(source)) return
  fs.mkdirSync(path.dirname(destination), { recursive: true })
  mergeDirectory(source, destination)
  removeDirectoryTree(source)
  appendMigrationReport(paths, { action: "merged", source, destination, reason })
}

function quarantineJournalFile(paths: DeskRecordPaths, sourcePath: string, relativePath: string, reason: string): void {
  const destinationPath = path.join(paths.recordRoot, "migration-quarantine", "journal", relativePath)
  fs.mkdirSync(path.dirname(destinationPath), { recursive: true })
  copyLosslessFile(sourcePath, destinationPath)
  appendMigrationReport(paths, { action: "quarantined", source: sourcePath, destination: destinationPath, reason })
}

function slugFromJournalFile(filename: string): string {
  const base = filename.replace(/\.[^.]+$/, "")
  const slug = base
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80)
    .replace(/-+$/g, "")
  return slug || "entry"
}

function migrateJournalEntry(paths: DeskRecordPaths, sourcePath: string, relativePath: string): void {
  const entryName = path.basename(sourcePath)
  if (DERIVED_JOURNAL_INDEX_FILES.has(entryName)) {
    appendMigrationReport(paths, {
      action: "dropped",
      source: sourcePath,
      reason: "derived journal index is obsolete after Desk record migration",
    })
    return
  }
  const extension = path.extname(entryName).toLowerCase()
  if (extension !== ".md" && extension !== ".txt") {
    quarantineJournalFile(paths, sourcePath, relativePath, "non-text journal scratch quarantined after Desk record migration")
    return
  }
  const relativeSlug = slugFromJournalFile(relativePath.split(path.sep).join("-"))
  const destinationPath = copyLosslessFile(sourcePath, path.join(paths.notesRoot, `journal-${relativeSlug}.md`))
  appendMigrationReport(paths, {
    action: "moved",
    source: sourcePath,
    destination: destinationPath,
    reason: "journal text migrated into Desk record notes",
  })
}

function migrateJournalTree(paths: DeskRecordPaths, root: string, current: string): void {
  for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
    const sourcePath = path.join(current, entry.name)
    if (entry.isDirectory()) {
      migrateJournalTree(paths, root, sourcePath)
      continue
    }
    migrateJournalEntry(paths, sourcePath, path.relative(root, sourcePath))
  }
}

function migrateJournalIntoNotes(paths: DeskRecordPaths, agentRoot: string): void {
  const journalRoot = path.join(agentRoot, "journal")
  if (!fs.existsSync(journalRoot)) return
  fs.mkdirSync(paths.notesRoot, { recursive: true })
  migrateJournalTree(paths, journalRoot, journalRoot)
  removeDirectoryTree(journalRoot)
  appendMigrationReport(paths, {
    action: "removed",
    source: journalRoot,
    reason: "top-level journal is no longer an active substrate",
  })
}

export function migrateLegacyRecordStores(agentRoot = getAgentRoot()): DeskRecordPaths {
  const paths = resolveDeskRecordPaths(agentRoot)
  const legacyRoots = [
    path.join(agentRoot, "psyche", "mem" + "ory"),
    path.join(agentRoot, "diary"),
    path.join(agentRoot, "notes"),
    path.join(agentRoot, "journal"),
  ]
  if (migratedAgentRoots.has(agentRoot) && !legacyRoots.some((root) => fs.existsSync(root))) {
    ensureRecordScaffold(paths)
    return paths
  }
  migratedAgentRoots.add(agentRoot)

  emitNervesEvent({
    component: "mind",
    event: "mind.record_store_migration_start",
    message: "record store migration started",
    meta: { agentRoot, recordRoot: paths.recordRoot },
  })

  ensureRecordScaffold(paths)
  moveOrMergeDirectory(
    paths,
    path.join(agentRoot, "psyche", "mem" + "ory"),
    paths.diaryRoot,
    "legacy pre-diary fact store moved into Desk record diary",
  )
  moveOrMergeDirectory(
    paths,
    path.join(agentRoot, "diary"),
    paths.diaryRoot,
    "top-level diary moved into Desk record diary",
  )
  moveOrMergeDirectory(
    paths,
    path.join(agentRoot, "notes"),
    paths.notesRoot,
    "top-level notes moved into Desk record notes",
  )
  const staleNotesIndex = path.join(paths.notesRoot, ".index.json")
  if (fs.existsSync(staleNotesIndex)) {
    fs.rmSync(staleNotesIndex, { force: true })
    appendMigrationReport(paths, {
      action: "removed",
      source: staleNotesIndex,
      reason: "canonical notes index stores file paths and must be rebuilt after migration",
    })
  }
  migrateJournalIntoNotes(paths, agentRoot)
  ensureRecordScaffold(paths)

  emitNervesEvent({
    component: "mind",
    event: "mind.record_store_migration_end",
    message: "record store migration completed",
    meta: { agentRoot, recordRoot: paths.recordRoot },
  })

  return paths
}

export function resolveRecordDiaryRoot(agentRoot = getAgentRoot()): string {
  return migrateLegacyRecordStores(agentRoot).diaryRoot
}

export function resolveRecordNotesRoot(agentRoot = getAgentRoot()): string {
  return migrateLegacyRecordStores(agentRoot).notesRoot
}

export function resetRecordStoreMigrationTrackingForTests(): void {
  migratedAgentRoots.clear()
}
