import * as fs from "node:fs"
import * as path from "node:path"
import { createHash } from "node:crypto"
import { emitNervesEvent } from "../../nerves/runtime"

export const SANCTUARY_PACKAGE_MANAGED_FILES = [
  "provider-readiness.json",
  "tool-profiles.json",
  "habits/sanctuary-health.md",
  "psyche/ASPIRATIONS.md",
  "psyche/IDENTITY.md",
  "psyche/LORE.md",
  "psyche/SOUL.md",
  "psyche/TACIT.md",
] as const

export const SANCTUARY_BUNDLE_ROLLBACK_FILE = ".sanctuary-package-managed-rollback.json"
const SANCTUARY_BUNDLE_COMMITTING_FILE = `${SANCTUARY_BUNDLE_ROLLBACK_FILE}.committing`

const BUNDLE_META_VERSION_FIELDS = ["runtimeVersion", "bundleSchemaVersion", "lastUpdated"] as const

export interface SanctuaryBundleMigrationResult {
  managedFilesUpdated: number
}

function readObject(filePath: string): Record<string, unknown> {
  const value: unknown = JSON.parse(fs.readFileSync(filePath, "utf8"))
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${path.basename(filePath)} must contain an object`)
  return value as Record<string, unknown>
}

function requirePlainFile(filePath: string, label: string): void {
  let stat: fs.Stats
  try { stat = fs.lstatSync(filePath) } catch { throw new Error(`${label} is missing`) }
  if (stat.isSymbolicLink()) throw new Error(`${label} must not be a symlink`)
  if (!stat.isFile()) throw new Error(`${label} must be a regular file`)
}

function ensureSafeParent(agentRoot: string, relative: string): void {
  let current = agentRoot
  for (const segment of path.dirname(relative).split(path.sep).filter((value) => value !== ".")) {
    current = path.join(current, segment)
    if (!fs.existsSync(current)) fs.mkdirSync(current, { mode: 0o700 })
  }
}

function validateDestination(agentRoot: string, relative: string): void {
  let current = agentRoot
  for (const segment of relative.split(path.sep)) {
    current = path.join(current, segment)
    let stat: fs.Stats
    try { stat = fs.lstatSync(current) } catch { return }
    if (stat.isSymbolicLink()) throw new Error(`package-managed destination must not be a symlink: ${relative}`)
    if (current !== path.join(agentRoot, relative) && !stat.isDirectory()) throw new Error(`package-managed destination parent must be a directory: ${relative}`)
    if (current === path.join(agentRoot, relative) && !stat.isFile()) throw new Error(`package-managed destination must be a regular file: ${relative}`)
  }
}

function writeAtomic(filePath: string, content: string | Buffer): void {
  const stagingDirectory = fs.mkdtempSync(`${filePath}.package-migration.`)
  const temporary = path.join(stagingDirectory, "value")
  try {
    const fd = fs.openSync(temporary, "wx", 0o600)
    try {
      fs.writeFileSync(fd, content)
      fs.fsyncSync(fd)
    } finally {
      fs.closeSync(fd)
    }
    fs.renameSync(temporary, filePath)
  } finally {
    fs.rmSync(temporary, { force: true })
    fs.rmdirSync(stagingDirectory)
  }
  fs.chmodSync(filePath, 0o600)
  const directory = fs.openSync(path.dirname(filePath), fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW)
  try { fs.fsyncSync(directory) } finally { fs.closeSync(directory) }
}

function cleanupInterruptedWrites(filePath: string): void {
  const parent = path.dirname(filePath)
  const prefix = `${path.basename(filePath)}.package-migration.`
  if (!fs.existsSync(parent)) return
  for (const name of fs.readdirSync(parent)) {
    if (!name.startsWith(prefix)) continue
    const stagingDirectory = path.join(parent, name)
    const stagingStat = fs.lstatSync(stagingDirectory)
    if (stagingStat.isSymbolicLink() || !stagingStat.isDirectory()) throw new Error(`interrupted package migration stage is invalid: ${name}`)
    const entries = fs.readdirSync(stagingDirectory)
    if (entries.some((entry) => entry !== "value")) throw new Error(`interrupted package migration stage contains unexpected entries: ${name}`)
    const temporary = path.join(stagingDirectory, "value")
    if (fs.existsSync(temporary)) {
      const temporaryStat = fs.lstatSync(temporary)
      if (temporaryStat.isSymbolicLink() || !temporaryStat.isFile()) throw new Error(`interrupted package migration value is invalid: ${name}`)
      fs.unlinkSync(temporary)
    }
    fs.rmdirSync(stagingDirectory)
  }
}

interface FileSnapshot { path: string; content: Buffer | null; mode: number | null }
interface DirectorySnapshot { path: string; mode: number | null }
interface MigrationSnapshot { files: FileSnapshot[]; directories: DirectorySnapshot[] }
interface DurableMigrationSnapshot {
  schemaVersion: 1
  rollbackImageId: string
  targetImageId: string
  snapshotDigest: string
  files: Array<{ relative: string; contentBase64: string | null; mode: number | null }>
  directories: Array<{ relative: string; mode: number | null }>
}

const SNAPSHOT_RELATIVES = [...SANCTUARY_PACKAGE_MANAGED_FILES, "bundle-meta.json"] as const

function snapshotDirectoryRelatives(): string[] {
  const directories = new Set<string>()
  for (const relative of SNAPSHOT_RELATIVES) {
    let directory = path.dirname(relative)
    while (directory !== ".") {
      directories.add(directory)
      directory = path.dirname(directory)
    }
  }
  return [...directories].sort((left, right) => left.length - right.length)
}

function captureMigrationSnapshot(agentRoot: string): MigrationSnapshot {
  const files = SNAPSHOT_RELATIVES.map((relative): FileSnapshot => {
    const filePath = path.join(agentRoot, relative)
    if (!fs.existsSync(filePath)) return { path: filePath, content: null, mode: null }
    const stat = fs.lstatSync(filePath)
    return { path: filePath, content: fs.readFileSync(filePath), mode: stat.mode & 0o777 }
  })
  const directories = snapshotDirectoryRelatives().map((relative): DirectorySnapshot => {
    const directory = path.join(agentRoot, relative)
    if (!fs.existsSync(directory)) return { path: directory, mode: null }
    const stat = fs.lstatSync(directory)
    return { path: directory, mode: stat.mode & 0o777 }
  })
  return { files, directories }
}

function rollbackPath(agentRoot: string): string {
  return path.join(agentRoot, SANCTUARY_BUNDLE_ROLLBACK_FILE)
}

function durableSnapshot(agentRoot: string, snapshot: MigrationSnapshot, rollbackImageId: string, targetImageId: string): DurableMigrationSnapshot {
  const payload = {
    schemaVersion: 1,
    rollbackImageId,
    targetImageId,
    files: snapshot.files.map((file) => ({ relative: path.relative(agentRoot, file.path), contentBase64: file.content?.toString("base64") ?? null, mode: file.mode })),
    directories: snapshot.directories.map((directory) => ({ relative: path.relative(agentRoot, directory.path), mode: directory.mode })),
  } as const
  return { ...payload, snapshotDigest: createHash("sha256").update(JSON.stringify(payload)).digest("hex") }
}

function readDurableRecord(agentRoot: string): { snapshot: MigrationSnapshot; rollbackImageId: string; targetImageId: string; filePath: string; state: "rollback" | "committing" } | null {
  const candidates = [rollbackPath(agentRoot), path.join(agentRoot, SANCTUARY_BUNDLE_COMMITTING_FILE)].filter((candidate) => fs.existsSync(candidate))
  if (candidates.length === 0) return null
  if (candidates.length !== 1) throw new Error("Sanctuary bundle rollback record state is ambiguous")
  const [filePath] = candidates
  const stat = fs.lstatSync(filePath)
  if (stat.isSymbolicLink()) throw new Error("Sanctuary bundle rollback record must not be a symlink")
  if (!stat.isFile() || (stat.mode & 0o777) !== 0o600) throw new Error("Sanctuary bundle rollback record must be a mode-0600 regular file")
  let value: unknown
  try { value = JSON.parse(fs.readFileSync(filePath, "utf8")) } catch { throw new Error("Sanctuary bundle rollback record is invalid JSON") }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Sanctuary bundle rollback record is invalid")
  const record = value as Partial<DurableMigrationSnapshot>
  if (record.schemaVersion !== 1 || typeof record.rollbackImageId !== "string" || !/^sha256:[0-9a-f]{64}$/u.test(record.rollbackImageId) || typeof record.targetImageId !== "string" || !/^sha256:[0-9a-f]{64}$/u.test(record.targetImageId) || record.targetImageId === record.rollbackImageId || typeof record.snapshotDigest !== "string" || !/^[0-9a-f]{64}$/u.test(record.snapshotDigest) || !Array.isArray(record.files) || !Array.isArray(record.directories)) throw new Error("Sanctuary bundle rollback record is invalid")
  const fileRelatives = record.files.map((file) => file?.relative)
  const directoryRelatives = record.directories.map((directory) => directory?.relative)
  const expectedDirectories = snapshotDirectoryRelatives()
  if (JSON.stringify(fileRelatives) !== JSON.stringify(SNAPSHOT_RELATIVES) || JSON.stringify(directoryRelatives) !== JSON.stringify(expectedDirectories)) throw new Error("Sanctuary bundle rollback record paths are invalid")
  for (const relative of SNAPSHOT_RELATIVES) validateDestination(agentRoot, relative)
  const validMode = (mode: unknown): mode is number | null => mode === null || (Number.isInteger(mode) && (mode as number) >= 0 && (mode as number) <= 0o777)
  const files = record.files.map((file): FileSnapshot => {
    if (!file || typeof file.relative !== "string" || !validMode(file.mode) || (file.contentBase64 !== null && typeof file.contentBase64 !== "string") || (file.contentBase64 === null) !== (file.mode === null)) throw new Error("Sanctuary bundle rollback record file is invalid")
    const content = file.contentBase64 === null ? null : Buffer.from(file.contentBase64, "base64")
    if (file.contentBase64 !== null && (!content || content.toString("base64") !== file.contentBase64)) throw new Error("Sanctuary bundle rollback record content is invalid")
    return { path: path.join(agentRoot, file.relative), content, mode: file.mode }
  })
  const directories = record.directories.map((directory): DirectorySnapshot => {
    if (!directory || typeof directory.relative !== "string" || !validMode(directory.mode)) throw new Error("Sanctuary bundle rollback record directory is invalid")
    return { path: path.join(agentRoot, directory.relative), mode: directory.mode }
  })
  const payload = { schemaVersion: record.schemaVersion, rollbackImageId: record.rollbackImageId, targetImageId: record.targetImageId, files: record.files, directories: record.directories }
  if (createHash("sha256").update(JSON.stringify(payload)).digest("hex") !== record.snapshotDigest) throw new Error("Sanctuary bundle rollback record digest is invalid")
  return { snapshot: { files, directories }, rollbackImageId: record.rollbackImageId, targetImageId: record.targetImageId, filePath, state: filePath === rollbackPath(agentRoot) ? "rollback" : "committing" }
}

function removeRollbackRecord(agentRoot: string, filePath: string): void {
  fs.unlinkSync(filePath)
  const root = fs.openSync(agentRoot, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW)
  try { fs.fsyncSync(root) } finally { fs.closeSync(root) }
}

function validateAgentRoot(agentRoot: string): void {
  if (!path.isAbsolute(agentRoot)) throw new Error("agent root must be an absolute path")
  const stat = fs.lstatSync(agentRoot)
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("agent root must be a real directory")
}

export function inspectSanctuaryPackageManagedBundleRollback(agentRoot: string): { rollbackImageId: string; targetImageId: string; state: "rollback" | "committing" } | null {
  validateAgentRoot(agentRoot)
  const record = readDurableRecord(agentRoot)
  return record ? { rollbackImageId: record.rollbackImageId, targetImageId: record.targetImageId, state: record.state } : null
}

export function rollbackSanctuaryPackageManagedBundle(agentRoot: string, options: { retainRecord?: boolean } = {}): boolean {
  validateAgentRoot(agentRoot)
  const record = readDurableRecord(agentRoot)
  if (!record) return false
  if (record.state === "committing") throw new Error("Sanctuary bundle commit is pending and cannot be rolled back")
  restoreMigrationSnapshot(record.snapshot)
  if (!options.retainRecord) removeRollbackRecord(agentRoot, record.filePath)
  return true
}

export function commitSanctuaryPackageManagedBundle(agentRoot: string): boolean {
  validateAgentRoot(agentRoot)
  const record = readDurableRecord(agentRoot)
  if (!record) return false
  const committingPath = path.join(agentRoot, SANCTUARY_BUNDLE_COMMITTING_FILE)
  if (record.filePath !== committingPath) {
    fs.renameSync(record.filePath, committingPath)
    const root = fs.openSync(agentRoot, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW)
    try { fs.fsyncSync(root) } finally { fs.closeSync(root) }
  }
  removeRollbackRecord(agentRoot, committingPath)
  return true
}

function restoreMigrationSnapshot(snapshot: MigrationSnapshot): void {
  for (const file of snapshot.files) {
    cleanupInterruptedWrites(file.path)
    if (file.content === null) {
      fs.rmSync(file.path, { force: true })
    } else {
      writeAtomic(file.path, file.content)
      fs.chmodSync(file.path, file.mode!)
    }
  }
  for (const directory of [...snapshot.directories].reverse()) {
    if (directory.mode === null) {
      if (!fs.existsSync(directory.path)) continue
      if (fs.readdirSync(directory.path).length === 0) fs.rmdirSync(directory.path)
    } else {
      fs.chmodSync(directory.path, directory.mode)
    }
  }
}

export function migrateSanctuaryPackageManagedBundle(input: { packageRoot: string; agentRoot: string; retainRollback?: boolean; rollbackImageId?: string; targetImageId?: string }): SanctuaryBundleMigrationResult {
  emitNervesEvent({ component: "daemon", event: "daemon.sanctuary_bundle_migration_start", message: "starting Sanctuary package-managed bundle migration", meta: { agentRoot: input.agentRoot } })
  let snapshot: MigrationSnapshot | null = null
  try {
    if (!path.isAbsolute(input.packageRoot) || !path.isAbsolute(input.agentRoot) || input.packageRoot === input.agentRoot) throw new Error("package and agent roots must be distinct absolute paths")
    const packageStat = fs.lstatSync(input.packageRoot)
    const agentStat = fs.lstatSync(input.agentRoot)
    if (packageStat.isSymbolicLink() || !packageStat.isDirectory()) throw new Error("package root must be a real directory")
    if (agentStat.isSymbolicLink() || !agentStat.isDirectory()) throw new Error("agent root must be a real directory")
    if (input.retainRollback && (!input.rollbackImageId || !/^sha256:[0-9a-f]{64}$/u.test(input.rollbackImageId) || !input.targetImageId || !/^sha256:[0-9a-f]{64}$/u.test(input.targetImageId) || input.targetImageId === input.rollbackImageId)) throw new Error("retained rollback requires distinct exact rollback and target image IDs")
    const existingRollback = rollbackPath(input.agentRoot)
    if (readDurableRecord(input.agentRoot)) throw new Error("Sanctuary bundle rollback is pending; rollback or commit it before another migration")

    for (const relative of SANCTUARY_PACKAGE_MANAGED_FILES) {
      requirePlainFile(path.join(input.packageRoot, relative), `package-managed source ${relative}`)
      validateDestination(input.agentRoot, relative)
    }
    requirePlainFile(path.join(input.packageRoot, "bundle-meta.json"), "packaged bundle-meta.json")
    validateDestination(input.agentRoot, "bundle-meta.json")
    const packagedMeta = readObject(path.join(input.packageRoot, "bundle-meta.json"))
    for (const field of BUNDLE_META_VERSION_FIELDS) if (!(field in packagedMeta)) throw new Error(`packaged bundle-meta.json is missing ${field}`)
    snapshot = captureMigrationSnapshot(input.agentRoot)
    if (input.retainRollback) {
      cleanupInterruptedWrites(existingRollback)
      writeAtomic(existingRollback, `${JSON.stringify(durableSnapshot(input.agentRoot, snapshot, input.rollbackImageId!, input.targetImageId!))}\n`)
    }

    let managedFilesUpdated = 0
    for (const relative of SANCTUARY_PACKAGE_MANAGED_FILES) {
      const source = fs.readFileSync(path.join(input.packageRoot, relative), "utf8")
      const destination = path.join(input.agentRoot, relative)
      ensureSafeParent(input.agentRoot, relative)
      if (fs.existsSync(destination) && fs.readFileSync(destination, "utf8") === source && (fs.statSync(destination).mode & 0o777) === 0o600) continue
      writeAtomic(destination, source)
      managedFilesUpdated += 1
    }

    const metaPath = path.join(input.agentRoot, "bundle-meta.json")
    const currentMeta = fs.existsSync(metaPath) ? readObject(metaPath) : {}
    const nextMeta = { ...currentMeta }
    for (const field of BUNDLE_META_VERSION_FIELDS) nextMeta[field] = packagedMeta[field]
    const nextMetaText = `${JSON.stringify(nextMeta, null, 2)}\n`
    if (!fs.existsSync(metaPath) || fs.readFileSync(metaPath, "utf8") !== nextMetaText) writeAtomic(metaPath, nextMetaText)

    const result = { managedFilesUpdated }
    emitNervesEvent({ component: "daemon", event: "daemon.sanctuary_bundle_migration_end", message: "completed Sanctuary package-managed bundle migration", meta: result })
    return result
  } catch (error) {
    let failure: unknown = error
    if (snapshot) {
      try {
        restoreMigrationSnapshot(snapshot)
        if (fs.existsSync(rollbackPath(input.agentRoot))) removeRollbackRecord(input.agentRoot, rollbackPath(input.agentRoot))
      } catch (restoreError) {
        failure = new AggregateError([error, restoreError], "Sanctuary bundle migration and rollback both failed")
      }
    }
    emitNervesEvent({ component: "daemon", event: "daemon.sanctuary_bundle_migration_error", level: "error", message: "Sanctuary package-managed bundle migration failed", meta: { error: String(failure), agentRoot: input.agentRoot } })
    throw failure
  }
}
