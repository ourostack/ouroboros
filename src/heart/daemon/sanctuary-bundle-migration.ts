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

export type SanctuaryInstallMismatchCode =
  | "managed_file_missing"
  | "managed_file_content"
  | "managed_file_mode"
  | "bundle_meta_missing"
  | "bundle_meta_field"
  | "bundle_meta_mode"

export type SanctuaryInstallErrorCode =
  | "invalid_package_root"
  | "invalid_package_source"
  | "packaged_policy_not_empty"
  | "package_version_mismatch"
  | "invalid_live_root"
  | "invalid_live_bundle"
  | "invalid_journal"
  | "inspection_unavailable"

export type SanctuaryInstallRepair =
  | { actor: "none"; action: "none" }
  | { actor: "human-required"; action: "restart_from_verified_release" | "run_verified_update_recovery" | "roll_back_or_install_verified_release" }

export type SanctuaryInstallErrorMessage =
  | "verified release contents are invalid"
  | "installed Sanctuary bundle is invalid"
  | "Sanctuary update recovery is required"
  | "Sanctuary install state is unavailable"

export type SanctuaryPackageManagedBundleInspection =
  | { ok: true; data: { runtimePackageVersion: string; packagedBundleVersion: string; liveBundleVersion: string | null; parity: "exact" | "mismatch"; mismatchCodes: SanctuaryInstallMismatchCode[]; journalState: "absent" | "rollback" | "committing"; ready: boolean; repair: SanctuaryInstallRepair } }
  | { ok: false; error: { code: SanctuaryInstallErrorCode; message: SanctuaryInstallErrorMessage; degraded: true; repair: Extract<SanctuaryInstallRepair, { actor: "human-required" }> } }

export interface SanctuaryDirectoryIdentity {
  realPath: string
  device: number
  inode: number
}

class SanctuaryInspectionFault extends Error {
  constructor(readonly code: SanctuaryInstallErrorCode) {
    super(code)
  }
}

const CANONICAL_EMPTY_PACKAGED_POLICY = { schemaVersion: 1, version: 0, desiredStates: {}, routineActionGrants: {}, updatedAt: null } as const

export interface SanctuaryBundleMigrationResult {
  managedFilesUpdated: number
}
function readObject(filePath: string): Record<string, unknown> {
  const value: unknown = JSON.parse(fs.readFileSync(filePath, "utf8"))
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${path.basename(filePath)} must contain an object`)
  return value as Record<string, unknown>
}

function isMissing(error: unknown): boolean {
  return !!error && typeof error === "object" && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT"
}

function isFilesystemFailure(error: unknown): boolean {
  return !!error && typeof error === "object" && "code" in error && typeof (error as NodeJS.ErrnoException).code === "string"
}

export function inspectSanctuaryDirectoryFromBase(baseRoot: string, segments: readonly string[]): SanctuaryDirectoryIdentity | null {
  if (!path.isAbsolute(baseRoot)) return null
  let current = path.resolve(baseRoot)
  let stat: fs.Stats | null = null
  for (const candidate of [current, ...segments.map((segment) => { current = path.join(current, segment); return current })]) {
    try { stat = fs.lstatSync(candidate) } catch (error) {
      if (isMissing(error)) return null
      throw error
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) return null
  }
  const realPath = fs.realpathSync(current)
  if (realPath !== path.resolve(current)) return null
  return { realPath, device: stat!.dev, inode: stat!.ino }
}

export function sanctuaryDirectoriesShareIdentity(left: SanctuaryDirectoryIdentity, right: SanctuaryDirectoryIdentity): boolean {
  return left.realPath === right.realPath || (left.device === right.device && left.inode === right.inode)
}

function inspectStandaloneSanctuaryDirectory(root: string): SanctuaryDirectoryIdentity | null {
  if (!path.isAbsolute(root)) return null
  const resolved = path.resolve(root)
  return inspectSanctuaryDirectoryFromBase(path.dirname(resolved), [path.basename(resolved)])
}

function isCanonicalEmptyPackagedPolicy(value: Record<string, unknown>): boolean {
  return JSON.stringify(Object.keys(value).sort()) === JSON.stringify(Object.keys(CANONICAL_EMPTY_PACKAGED_POLICY).sort())
    && value.schemaVersion === 1
    && value.version === 0
    && value.updatedAt === null
    && !!value.desiredStates
    && typeof value.desiredStates === "object"
    && !Array.isArray(value.desiredStates)
    && Object.keys(value.desiredStates).length === 0
    && !!value.routineActionGrants
    && typeof value.routineActionGrants === "object"
    && !Array.isArray(value.routineActionGrants)
    && Object.keys(value.routineActionGrants).length === 0
}

function validatePackagedPolicy(packageRoot: string): void {
  const relative = "state/policy/steward.json"
  validateDestination(packageRoot, relative)
  requirePlainFile(path.join(packageRoot, relative), "packaged steward policy")
  const value = readObject(path.join(packageRoot, relative))
  if (value.routineActionGrants && typeof value.routineActionGrants === "object" && !Array.isArray(value.routineActionGrants) && Object.keys(value.routineActionGrants).length > 0) throw new Error("packaged steward policy must not carry routine action grants; authorize them through an authenticated owner session")
  if (value.desiredStates && typeof value.desiredStates === "object" && !Array.isArray(value.desiredStates) && Object.keys(value.desiredStates).length > 0) throw new Error("packaged steward policy must not carry desired state")
  if (!isCanonicalEmptyPackagedPolicy(value)) throw new Error("packaged steward policy must be the canonical empty policy")
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

const SNAPSHOT_RELATIVES = [...SANCTUARY_PACKAGE_MANAGED_FILES, "bundle-meta.json"] as const

function packageManagedArtifactPaths(agentRoot: string): string[] {
  return SNAPSHOT_RELATIVES.map((relative) => path.join(agentRoot, relative))
}

function inspectInterruptedWrites(filePaths: readonly string[]): Array<{ stagingDirectory: string; temporary: string | null }> {
  const stages: Array<{ stagingDirectory: string; temporary: string | null }> = []
  for (const filePath of [...filePaths].sort()) {
    const parent = path.dirname(filePath)
    const prefix = `${path.basename(filePath)}.package-migration.`
    let names: string[]
    try { names = fs.readdirSync(parent).sort() } catch (error) {
      if (isMissing(error)) continue
      throw error
    }
    for (const name of names) {
      if (!name.startsWith(prefix)) continue
      const stagingDirectory = path.join(parent, name)
      const parentStat = fs.lstatSync(parent)
      const stagingStat = fs.lstatSync(stagingDirectory)
      if (parentStat.isSymbolicLink() || !parentStat.isDirectory() || stagingStat.isSymbolicLink() || !stagingStat.isDirectory() || (stagingStat.mode & 0o777) !== 0o700 || stagingStat.uid !== parentStat.uid || stagingStat.gid !== parentStat.gid) throw new Error(`interrupted package migration stage is invalid: ${name}`)
      const entries = fs.readdirSync(stagingDirectory)
      if (entries.some((entry) => entry !== "value")) throw new Error(`interrupted package migration stage contains unexpected entries: ${name}`)
      const temporary = entries.includes("value") ? path.join(stagingDirectory, "value") : null
      if (temporary) {
        const temporaryStat = fs.lstatSync(temporary)
        if (temporaryStat.isSymbolicLink() || !temporaryStat.isFile() || (temporaryStat.mode & 0o777) !== 0o600 || temporaryStat.uid !== stagingStat.uid || temporaryStat.gid !== stagingStat.gid) throw new Error(`interrupted package migration value is invalid: ${name}`)
      }
      stages.push({ stagingDirectory, temporary })
    }
  }
  return stages
}

function cleanupInterruptedWrites(filePaths: readonly string[]): void {
  const stages = inspectInterruptedWrites(filePaths)
  for (const stage of stages) {
    if (stage.temporary) fs.unlinkSync(stage.temporary)
    fs.rmdirSync(stage.stagingDirectory)
  }
  for (const parent of [...new Set(stages.map((stage) => path.dirname(stage.stagingDirectory)))].sort()) {
    const directory = fs.openSync(parent, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW)
    try { fs.fsyncSync(directory) } finally { fs.closeSync(directory) }
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
  const names = fs.readdirSync(agentRoot)
  const stagePrefixes = [`${SANCTUARY_BUNDLE_ROLLBACK_FILE}.package-migration.`, `${SANCTUARY_BUNDLE_COMMITTING_FILE}.package-migration.`]
  if (names.some((name) => stagePrefixes.some((prefix) => name.startsWith(prefix)))) throw new Error("Sanctuary bundle journal staging residue requires verified recovery")
  const candidates = [rollbackPath(agentRoot), path.join(agentRoot, SANCTUARY_BUNDLE_COMMITTING_FILE)].flatMap((filePath) => {
    try { return [{ filePath, stat: fs.lstatSync(filePath) }] } catch (error) {
      if (isMissing(error)) return []
      throw error
    }
  })
  if (candidates.length === 0) return null
  if (candidates.length !== 1) throw new Error("Sanctuary bundle rollback record state is ambiguous")
  const [{ filePath, stat }] = candidates
  if (stat.isSymbolicLink()) throw new Error("Sanctuary bundle rollback record must not be a symlink")
  if (!stat.isFile() || (stat.mode & 0o777) !== 0o600) throw new Error("Sanctuary bundle rollback record must be a mode-0600 regular file")
  const serialized = fs.readFileSync(filePath, "utf8")
  let value: unknown
  try { value = JSON.parse(serialized) } catch { throw new Error("Sanctuary bundle rollback record is invalid JSON") }
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
  if (!inspectStandaloneSanctuaryDirectory(agentRoot)) throw new Error("agent root must be a canonical real directory")
}

function inspectionError(code: SanctuaryInstallErrorCode): SanctuaryPackageManagedBundleInspection {
  if (code === "invalid_package_root" || code === "invalid_package_source" || code === "packaged_policy_not_empty" || code === "package_version_mismatch") {
    return { ok: false, error: { code, message: "verified release contents are invalid", degraded: true, repair: { actor: "human-required", action: "roll_back_or_install_verified_release" } } }
  }
  if (code === "invalid_live_root" || code === "invalid_live_bundle") {
    return { ok: false, error: { code, message: "installed Sanctuary bundle is invalid", degraded: true, repair: { actor: "human-required", action: "roll_back_or_install_verified_release" } } }
  }
  if (code === "invalid_journal") {
    return { ok: false, error: { code, message: "Sanctuary update recovery is required", degraded: true, repair: { actor: "human-required", action: "run_verified_update_recovery" } } }
  }
  return { ok: false, error: { code, message: "Sanctuary install state is unavailable", degraded: true, repair: { actor: "human-required", action: "run_verified_update_recovery" } } }
}

function validateInspectionRoot(root: string, code: "invalid_package_root" | "invalid_live_root"): SanctuaryDirectoryIdentity {
  const identity = inspectStandaloneSanctuaryDirectory(root)
  if (!identity) throw new SanctuaryInspectionFault(code)
  return identity
}

function inspectRelativeFile(root: string, relative: string, code: "invalid_package_source" | "invalid_live_bundle"): fs.Stats | null {
  let current = root
  let result: fs.Stats | null = null
  const segments = relative.split(path.sep)
  for (let index = 0; index < segments.length; index += 1) {
    current = path.join(current, segments[index]!)
    let stat: fs.Stats
    try { stat = fs.lstatSync(current) } catch (error) {
      if (isMissing(error)) return null
      throw error
    }
    if (stat.isSymbolicLink()) throw new SanctuaryInspectionFault(code)
    if (index < segments.length - 1 && !stat.isDirectory()) throw new SanctuaryInspectionFault(code)
    if (index === segments.length - 1 && !stat.isFile()) throw new SanctuaryInspectionFault(code)
    if (index === segments.length - 1) result = stat
  }
  return result
}

function readInspectionObject(filePath: string, code: "invalid_package_source" | "invalid_live_bundle"): Record<string, unknown> {
  let value: unknown
  try { value = JSON.parse(fs.readFileSync(filePath, "utf8")) } catch (error) {
    if (error instanceof SyntaxError) throw new SanctuaryInspectionFault(code)
    throw error
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new SanctuaryInspectionFault(code)
  return value as Record<string, unknown>
}

function inspectPackageSources(packageRoot: string, runtimePackageVersion: string): { managed: Map<string, Buffer>; metadata: Record<string, unknown>; packagedBundleVersion: string } {
  const managed = new Map<string, Buffer>()
  for (const relative of SANCTUARY_PACKAGE_MANAGED_FILES) {
    if (!inspectRelativeFile(packageRoot, relative, "invalid_package_source")) throw new SanctuaryInspectionFault("invalid_package_source")
    managed.set(relative, fs.readFileSync(path.join(packageRoot, relative)))
  }
  if (!inspectRelativeFile(packageRoot, "bundle-meta.json", "invalid_package_source")) throw new SanctuaryInspectionFault("invalid_package_source")
  const metadata = readInspectionObject(path.join(packageRoot, "bundle-meta.json"), "invalid_package_source")
  if (typeof metadata.runtimeVersion !== "string" || metadata.runtimeVersion.length === 0 || !Number.isInteger(metadata.bundleSchemaVersion) || typeof metadata.lastUpdated !== "string" || metadata.lastUpdated.length === 0) throw new SanctuaryInspectionFault("invalid_package_source")
  if (!inspectRelativeFile(packageRoot, "state/policy/steward.json", "invalid_package_source")) throw new SanctuaryInspectionFault("invalid_package_source")
  const policy = readInspectionObject(path.join(packageRoot, "state/policy/steward.json"), "invalid_package_source")
  if (!isCanonicalEmptyPackagedPolicy(policy)) throw new SanctuaryInspectionFault("packaged_policy_not_empty")
  if (runtimePackageVersion.length === 0 || metadata.runtimeVersion !== runtimePackageVersion) throw new SanctuaryInspectionFault("package_version_mismatch")
  return { managed, metadata, packagedBundleVersion: metadata.runtimeVersion }
}

function journalRepair(journalState: "absent" | "rollback" | "committing", parity: "exact" | "mismatch"): SanctuaryInstallRepair {
  if (parity === "exact" && journalState !== "committing") return { actor: "none", action: "none" }
  if (parity === "mismatch" && journalState === "absent") return { actor: "human-required", action: "restart_from_verified_release" }
  return { actor: "human-required", action: "run_verified_update_recovery" }
}

export function inspectSanctuaryPackageManagedBundle(input: { packageRoot: string; agentRoot: string; runtimePackageVersion: string }): SanctuaryPackageManagedBundleInspection {
  try {
    const packageIdentity = validateInspectionRoot(input.packageRoot, "invalid_package_root")
    const packaged = inspectPackageSources(input.packageRoot, input.runtimePackageVersion)
    const agentIdentity = validateInspectionRoot(input.agentRoot, "invalid_live_root")
    if (sanctuaryDirectoriesShareIdentity(packageIdentity, agentIdentity)) throw new SanctuaryInspectionFault("invalid_live_root")

    let managedMissing = false
    let managedContent = false
    let managedMode = false
    for (const relative of SANCTUARY_PACKAGE_MANAGED_FILES) {
      const stat = inspectRelativeFile(input.agentRoot, relative, "invalid_live_bundle")
      if (!stat) {
        managedMissing = true
        continue
      }
      if (!fs.readFileSync(path.join(input.agentRoot, relative)).equals(packaged.managed.get(relative)!)) managedContent = true
      if ((stat.mode & 0o777) !== 0o600) managedMode = true
    }

    let liveBundleVersion: string | null = null
    let bundleMetaMissing = false
    let bundleMetaField = false
    let bundleMetaMode = false
    const liveMetaStat = inspectRelativeFile(input.agentRoot, "bundle-meta.json", "invalid_live_bundle")
    if (!liveMetaStat) {
      bundleMetaMissing = true
    } else {
      const liveMeta = readInspectionObject(path.join(input.agentRoot, "bundle-meta.json"), "invalid_live_bundle")
      liveBundleVersion = typeof liveMeta.runtimeVersion === "string" ? liveMeta.runtimeVersion : null
      bundleMetaField = BUNDLE_META_VERSION_FIELDS.some((field) => liveMeta[field] !== packaged.metadata[field])
      bundleMetaMode = (liveMetaStat.mode & 0o777) !== 0o600
    }

    let journalState: "absent" | "rollback" | "committing" = "absent"
    try {
      if (inspectInterruptedWrites(packageManagedArtifactPaths(input.agentRoot)).length > 0) throw new Error("Sanctuary bundle staging residue requires verified recovery")
      journalState = readDurableRecord(input.agentRoot)?.state ?? "absent"
    } catch (error) {
      if (isFilesystemFailure(error)) throw error
      throw new SanctuaryInspectionFault("invalid_journal")
    }
    const mismatchCodes: SanctuaryInstallMismatchCode[] = []
    if (managedMissing) mismatchCodes.push("managed_file_missing")
    if (managedContent) mismatchCodes.push("managed_file_content")
    if (managedMode) mismatchCodes.push("managed_file_mode")
    if (bundleMetaMissing) mismatchCodes.push("bundle_meta_missing")
    if (bundleMetaField) mismatchCodes.push("bundle_meta_field")
    if (bundleMetaMode) mismatchCodes.push("bundle_meta_mode")
    const parity = mismatchCodes.length === 0 ? "exact" : "mismatch"
    const ready = parity === "exact" && journalState !== "committing"
    return {
      ok: true,
      data: {
        runtimePackageVersion: input.runtimePackageVersion,
        packagedBundleVersion: packaged.packagedBundleVersion,
        liveBundleVersion,
        parity,
        mismatchCodes,
        journalState,
        ready,
        repair: journalRepair(journalState, parity),
      },
    }
  } catch (error) {
    return inspectionError(error instanceof SanctuaryInspectionFault ? error.code : "inspection_unavailable")
  }
}

export function ensureSanctuaryPackageManagedBundle(
  input: { packageRoot: string; agentRoot: string; runtimePackageVersion: string },
  deps: { inspect?: typeof inspectSanctuaryPackageManagedBundle; migrate?: typeof migrateSanctuaryPackageManagedBundle; commit?: typeof commitSanctuaryPackageManagedBundle } = {},
): SanctuaryPackageManagedBundleInspection {
  const inspect = deps.inspect ?? inspectSanctuaryPackageManagedBundle
  const before = inspect(input)
  if (!before.ok) {
    if (before.error.code !== "invalid_journal") return before
    try {
      (deps.migrate ?? migrateSanctuaryPackageManagedBundle)({ packageRoot: input.packageRoot, agentRoot: input.agentRoot })
    } catch {
      return before
    }
  } else if (before.data.ready) {
    return before
  } else if (before.data.parity === "mismatch" && before.data.journalState !== "absent") {
    return before
  } else if (before.data.parity === "exact" && before.data.journalState === "committing") {
    (deps.commit ?? commitSanctuaryPackageManagedBundle)(input.agentRoot)
  } else {
    (deps.migrate ?? migrateSanctuaryPackageManagedBundle)({ packageRoot: input.packageRoot, agentRoot: input.agentRoot })
  }
  const after = inspect(input)
  if (!after.ok || !after.data.ready) return after
  if (after.data.parity !== "exact" || after.data.journalState !== "absent") throw new Error("Sanctuary package-managed bundle did not converge")
  return after
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
  cleanupInterruptedWrites(snapshot.files.map((file) => file.path))
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
    if (!path.isAbsolute(input.packageRoot) || !path.isAbsolute(input.agentRoot)) throw new Error("package and agent roots must be absolute paths")
    const packageIdentity = inspectStandaloneSanctuaryDirectory(input.packageRoot)
    const agentIdentity = inspectStandaloneSanctuaryDirectory(input.agentRoot)
    if (!packageIdentity) throw new Error("package root must be a canonical real directory")
    if (!agentIdentity) throw new Error("agent root must be a canonical real directory")
    if (sanctuaryDirectoriesShareIdentity(packageIdentity, agentIdentity)) throw new Error("package and agent roots must be distinct real directories")
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
    validatePackagedPolicy(input.packageRoot)
    cleanupInterruptedWrites(packageManagedArtifactPaths(input.agentRoot))
    snapshot = captureMigrationSnapshot(input.agentRoot)
    if (input.retainRollback) {
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
    const metaExists = fs.existsSync(metaPath)
    const currentMeta = metaExists ? readObject(metaPath) : {}
    const nextMeta = { ...currentMeta }
    for (const field of BUNDLE_META_VERSION_FIELDS) nextMeta[field] = packagedMeta[field]
    if (!metaExists || BUNDLE_META_VERSION_FIELDS.some((field) => currentMeta[field] !== packagedMeta[field])) {
      writeAtomic(metaPath, `${JSON.stringify(nextMeta, null, 2)}\n`)
    } else if ((fs.statSync(metaPath).mode & 0o777) !== 0o600) {
      fs.chmodSync(metaPath, 0o600)
      const meta = fs.openSync(metaPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
      try { fs.fsyncSync(meta) } finally { fs.closeSync(meta) }
    }

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
