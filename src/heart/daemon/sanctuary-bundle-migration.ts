import * as fs from "node:fs"
import * as path from "node:path"
import { emitNervesEvent } from "../../nerves/runtime"
import { readStewardPolicy } from "../steward-policy"

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

const BUNDLE_META_VERSION_FIELDS = ["runtimeVersion", "bundleSchemaVersion", "lastUpdated"] as const

export interface SanctuaryBundleMigrationResult {
  managedFilesUpdated: number
  grantsAdded: number
  grantsUpdated: number
  grantsPreserved: number
  policyVersion: number
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

interface FileSnapshot { path: string; content: Buffer | null; mode: number | null }
interface DirectorySnapshot { path: string; mode: number | null }
interface MigrationSnapshot { files: FileSnapshot[]; directories: DirectorySnapshot[] }

function captureMigrationSnapshot(agentRoot: string): MigrationSnapshot {
  const relatives = [...SANCTUARY_PACKAGE_MANAGED_FILES, "bundle-meta.json", "state/policy/steward.json", "state/policy/steward.json.turn.lock", "state/policy/policy-audit.ndjson"]
  const files = relatives.map((relative): FileSnapshot => {
    const filePath = path.join(agentRoot, relative)
    if (!fs.existsSync(filePath)) return { path: filePath, content: null, mode: null }
    const stat = fs.lstatSync(filePath)
    return { path: filePath, content: fs.readFileSync(filePath), mode: stat.mode & 0o777 }
  })
  const directoryPaths = new Set<string>()
  for (const relative of relatives) {
    let directory = path.dirname(path.join(agentRoot, relative))
    while (directory !== agentRoot) {
      directoryPaths.add(directory)
      directory = path.dirname(directory)
    }
  }
  const directories = [...directoryPaths].sort((left, right) => left.length - right.length).map((directory): DirectorySnapshot => {
    if (!fs.existsSync(directory)) return { path: directory, mode: null }
    const stat = fs.lstatSync(directory)
    return { path: directory, mode: stat.mode & 0o777 }
  })
  return { files, directories }
}

function restoreMigrationSnapshot(snapshot: MigrationSnapshot): void {
  for (const file of snapshot.files) {
    if (file.content === null) {
      fs.rmSync(file.path, { force: true })
    } else {
      writeAtomic(file.path, file.content)
      fs.chmodSync(file.path, file.mode!)
    }
  }
  for (const directory of [...snapshot.directories].reverse()) {
    if (directory.mode === null) {
      fs.rmdirSync(directory.path)
    } else {
      fs.chmodSync(directory.path, directory.mode)
    }
  }
}

export function migrateSanctuaryPackageManagedBundle(input: { packageRoot: string; agentRoot: string }): SanctuaryBundleMigrationResult {
  emitNervesEvent({ component: "daemon", event: "daemon.sanctuary_bundle_migration_start", message: "starting Sanctuary package-managed bundle migration", meta: { agentRoot: input.agentRoot } })
  let snapshot: MigrationSnapshot | null = null
  try {
    if (!path.isAbsolute(input.packageRoot) || !path.isAbsolute(input.agentRoot) || input.packageRoot === input.agentRoot) throw new Error("package and agent roots must be distinct absolute paths")
    const packageStat = fs.lstatSync(input.packageRoot)
    const agentStat = fs.lstatSync(input.agentRoot)
    if (packageStat.isSymbolicLink() || !packageStat.isDirectory()) throw new Error("package root must be a real directory")
    if (agentStat.isSymbolicLink() || !agentStat.isDirectory()) throw new Error("agent root must be a real directory")

    for (const relative of SANCTUARY_PACKAGE_MANAGED_FILES) {
      requirePlainFile(path.join(input.packageRoot, relative), `package-managed source ${relative}`)
      validateDestination(input.agentRoot, relative)
    }
    requirePlainFile(path.join(input.packageRoot, "bundle-meta.json"), "packaged bundle-meta.json")
    validateDestination(input.agentRoot, "bundle-meta.json")
    validateDestination(input.agentRoot, "state/policy/steward.json")
    validateDestination(input.agentRoot, "state/policy/steward.json.turn.lock")
    validateDestination(input.agentRoot, "state/policy/policy-audit.ndjson")
    const packagedMeta = readObject(path.join(input.packageRoot, "bundle-meta.json"))
    for (const field of BUNDLE_META_VERSION_FIELDS) if (!(field in packagedMeta)) throw new Error(`packaged bundle-meta.json is missing ${field}`)
    const packagedPolicy = readStewardPolicy(input.packageRoot)
    if (Object.keys(packagedPolicy.routineActionGrants).length > 0) {
      throw new Error("packaged steward policy must not carry routine action grants; authorize them through an authenticated owner session")
    }
    snapshot = captureMigrationSnapshot(input.agentRoot)

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

    const policy = readStewardPolicy(input.agentRoot)
    const result = { managedFilesUpdated, grantsAdded: 0, grantsUpdated: 0, grantsPreserved: Object.keys(policy.routineActionGrants).length, policyVersion: policy.version }
    emitNervesEvent({ component: "daemon", event: "daemon.sanctuary_bundle_migration_end", message: "completed Sanctuary package-managed bundle migration", meta: result })
    return result
  } catch (error) {
    if (snapshot) restoreMigrationSnapshot(snapshot)
    emitNervesEvent({ component: "daemon", event: "daemon.sanctuary_bundle_migration_error", level: "error", message: "Sanctuary package-managed bundle migration failed", meta: { error: String(error), agentRoot: input.agentRoot } })
    throw error
  }
}
