import { createHash, randomBytes } from "crypto"
import * as fs from "fs"
import * as path from "path"

import { emitNervesEvent } from "../../nerves/runtime"
import { canonicalizeJson, parseCanonicalJson, sha256CanonicalJson } from "../runtime/canonical-json"

const IDENTIFIER = /^[a-z][a-z0-9-]*$/
const SHA256 = /^[0-9a-f]{64}$/
const MAX_TARGET_BYTES = 1024 * 1024

export type MigrationFaultPoint =
  | "after-prepared"
  | "after-rewrite"
  | "after-applied"
  | "after-result"
  | "after-receipt"
  | "rollback-after-rewrite"

export interface FileIdentityV1 {
  dev: string
  ino: string
  nlink: 1
  uid: number
  gid: number
  mode: string
  ctimeNs: string
  kind: "regular"
}

export interface DirectoryIdentityV1 {
  dev: string
  ino: string
  nlink: number
  uid: number
  gid: number
  mode: string
  ctimeNs: string
  kind: "directory"
}

export interface HabitMigrationRequestV1 {
  migrationId: "exact-file"
  version: 1
  habitId: string
  habitPath: string
  expectedBeforeSha256: string
  targetBytesBase64: string
  targetSha256: string
  requestSha256: string
}

export interface AgentConfigCasRequestV1 {
  migrationId: "agent-config-cas"
  version: 1
  agentConfigPath: "agent.json"
  expectedBeforeSha256: string
  targetBytesBase64: string
  targetSha256: string
  requestSha256: string
}

interface MigrationPlanBaseV1 {
  schemaVersion: 1
  transactionId: string
  requestSha256: string
  version: 1
  disposition: "migrated" | "already_current"
  parentIdentity: DirectoryIdentityV1
  beforeIdentity: FileIdentityV1
  beforeRef: string
  beforeSha256: string
  afterRef: string
  afterSha256: string
  plannedAt: string
}

export interface HabitMigrationPlanV1 extends MigrationPlanBaseV1 {
  migrationId: "exact-file"
  habitId: string
  habitPath: string
}

export interface AgentConfigCasPlanV1 extends MigrationPlanBaseV1 {
  migrationId: "agent-config-cas"
  agentConfigPath: "agent.json"
  parsedConfigSha256: string
}

interface MigrationResultBaseV1 {
  schemaVersion: 1
  transactionId: string
  requestSha256: string
  version: 1
  direction: "forward" | "rollback"
  rollbackOf: string | null
  parentIdentity: DirectoryIdentityV1
  expectedCurrentSha256: string
  resultingIdentity: FileIdentityV1
  resultingSha256: string
  disposition: "migrated" | "already_current" | "rolled_back"
}

export interface HabitMigrationResultV1 extends MigrationResultBaseV1 {
  migrationId: "exact-file"
  habitId: string
  habitPath: string
}

export interface AgentConfigCasResultV1 extends MigrationResultBaseV1 {
  migrationId: "agent-config-cas"
  agentConfigPath: "agent.json"
}

export interface MigrationPhaseReceiptV1 {
  schemaVersion: 1
  receiptId: string
  transactionId: string
  phase: "apply" | "rollback"
  priorTransactionSha256: string
  resultRef: string
  resultSha256: string
  resultingFileSha256: string
  committedAt: string
}

export interface MigrationTxnV1 {
  schemaVersion: 1
  transactionId: string
  requestSha256: string
  planRef: string
  planSha256: string
  state: "prepared" | "applied" | "committed" | "rollback_required" | "rolled_back" | "rollback_failed"
  currentExpectedSha256: string
  forwardResultRef: string | null
  forwardResultSha256: string | null
  forwardReceiptRef: string | null
  forwardReceiptSha256: string | null
  rollbackResultRef: string | null
  rollbackResultSha256: string | null
  rollbackReceiptRef: string | null
  rollbackReceiptSha256: string | null
  lastError: null | { code: string; message: string }
  createdAt: string
  updatedAt: string
}

export interface CompletedHabitMigration {
  plan: HabitMigrationPlanV1
  transaction: MigrationTxnV1
  result: HabitMigrationResultV1
  receipt: MigrationPhaseReceiptV1
}

export interface CompletedAgentConfigCas {
  plan: AgentConfigCasPlanV1
  transaction: MigrationTxnV1
  result: AgentConfigCasResultV1
  receipt: MigrationPhaseReceiptV1
}

interface ExecuteOptions<R> {
  bundleRoot: string
  request: R
  now?: () => Date
  hook?: (point: "after-target-lstat" | "before-rename") => void
  fault?: (point: MigrationFaultPoint) => void
}

interface RollbackOptions {
  bundleRoot: string
  requestSha256: string
  fault?: (point: MigrationFaultPoint) => void
}

type AnyRequest = HabitMigrationRequestV1 | AgentConfigCasRequestV1
type AnyPlan = HabitMigrationPlanV1 | AgentConfigCasPlanV1
type AnyResult = HabitMigrationResultV1 | AgentConfigCasResultV1

interface MigrationCoordinates {
  bundleRoot: string
  parentPath: string
  targetPath: string
  targetRelativePath: string
  transactionDirectory: string
  requestPath: string
  transactionPath: string
}

interface StableFile {
  bytes: Buffer
  identity: FileIdentityV1
}

interface RetainedDirectory {
  fd: number
  identity: DirectoryIdentityV1
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex")
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key))
  const missing = allowed.filter((key) => !Object.prototype.hasOwnProperty.call(value, key))
  if (unknown.length > 0) throw new Error(`${label} has unknown field ${unknown.sort()[0]}`)
  if (missing.length > 0) throw new Error(`${label} is missing required field ${missing.sort()[0]}`)
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`)
  return value as Record<string, unknown>
}

function assertSha256(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !SHA256.test(value)) throw new Error(`${label} must be a lowercase SHA-256 hash`)
}

function decodeCanonicalBase64(value: unknown): Buffer {
  if (typeof value !== "string" || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new Error("target bytes must use canonical base64")
  }
  const bytes = Buffer.from(value, "base64")
  /* v8 ignore next -- the accepted grammar and Node base64 codec are canonical inverses @preserve */
  if (bytes.toString("base64") !== value) throw new Error("target bytes must use canonical base64")
  if (bytes.length > MAX_TARGET_BYTES) throw new Error("target byte size exceeds the 1 MiB ceiling")
  return bytes
}

function requestBody(request: AnyRequest): Record<string, unknown> {
  const { requestSha256: _requestSha256, ...body } = request
  return body
}

function validateCommonRequest(request: AnyRequest): Buffer {
  assertSha256(request.expectedBeforeSha256, "expectedBeforeSha256")
  assertSha256(request.targetSha256, "targetSha256")
  assertSha256(request.requestSha256, "requestSha256")
  const target = decodeCanonicalBase64(request.targetBytesBase64)
  if (sha256(target) !== request.targetSha256) throw new Error("target SHA-256 hash mismatch")
  if (sha256CanonicalJson(requestBody(request)) !== request.requestSha256) throw new Error("request SHA-256 hash mismatch")
  return target
}

function validateHabitRequest(value: HabitMigrationRequestV1): Buffer {
  const request = record(value, "exact-file request")
  exactKeys(request, [
    "migrationId", "version", "habitId", "habitPath", "expectedBeforeSha256",
    "targetBytesBase64", "targetSha256", "requestSha256",
  ], "exact-file request")
  if (value.migrationId !== "exact-file") throw new Error("migration id must be exact-file")
  if (value.version !== 1) throw new Error("exact-file version must be 1")
  if (typeof value.habitId !== "string" || !IDENTIFIER.test(value.habitId)) throw new Error("habit id is invalid")
  if (value.habitPath !== `habits/${value.habitId}.md`) throw new Error("habit path does not match the canonical habit id path")
  return validateCommonRequest(value)
}

function validateConfigRequest(value: AgentConfigCasRequestV1): Buffer {
  const request = record(value, "agent-config-cas request")
  exactKeys(request, [
    "migrationId", "version", "agentConfigPath", "expectedBeforeSha256",
    "targetBytesBase64", "targetSha256", "requestSha256",
  ], "agent-config-cas request")
  if (value.migrationId !== "agent-config-cas") throw new Error("migration id must be agent-config-cas")
  if (value.version !== 1) throw new Error("agent-config-cas version must be 1")
  if (value.agentConfigPath !== "agent.json") throw new Error("agent-config-cas accepts only agent.json")
  const bytes = validateCommonRequest(value)
  validateStrictAgentConfig(bytes)
  return bytes
}

function identityFromStats(stats: fs.BigIntStats, label: string): FileIdentityV1 {
  if (stats.isSymbolicLink() || !stats.isFile() || stats.nlink !== 1n) {
    throw new Error(`${label} must be a regular single-link target`)
  }
  return {
    dev: stats.dev.toString(),
    ino: stats.ino.toString(),
    nlink: 1,
    uid: Number(stats.uid),
    gid: Number(stats.gid),
    mode: stats.mode.toString(),
    ctimeNs: stats.ctimeNs.toString(),
    kind: "regular",
  }
}

function directoryIdentityFromStats(stats: fs.BigIntStats, label: string): DirectoryIdentityV1 {
  if (stats.isSymbolicLink() || !stats.isDirectory() || stats.nlink <= 0n) {
    throw new Error(`${label} must be a real directory`)
  }
  return {
    dev: stats.dev.toString(),
    ino: stats.ino.toString(),
    nlink: Number(stats.nlink),
    uid: Number(stats.uid),
    gid: Number(stats.gid),
    mode: stats.mode.toString(),
    ctimeNs: stats.ctimeNs.toString(),
    kind: "directory",
  }
}

function sameFileIdentity(left: FileIdentityV1, right: FileIdentityV1): boolean {
  return canonicalizeJson(left) === canonicalizeJson(right)
}

function sameStableDirectory(left: DirectoryIdentityV1, right: DirectoryIdentityV1): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.uid === right.uid &&
    left.gid === right.gid && left.mode === right.mode && left.kind === right.kind
}

function stableRead(filePath: string, label: string, afterLstat?: () => void): StableFile {
  let beforeStats: fs.BigIntStats
  try {
    beforeStats = fs.lstatSync(filePath, { bigint: true })
  } catch {
    throw new Error(`${label} target is missing`)
  }
  const before = identityFromStats(beforeStats, label)
  afterLstat?.()
  let fd: number | null = null
  try {
    fd = fs.openSync(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
    const opened = identityFromStats(fs.fstatSync(fd, { bigint: true }), label)
    if (!sameFileIdentity(before, opened)) throw new Error(`${label} identity changed while opening`)
    const bytes = fs.readFileSync(fd)
    const after = identityFromStats(fs.fstatSync(fd, { bigint: true }), label)
    /* v8 ignore next -- sub-read file replacement race; the surrounding identity checks are exercised @preserve */
    if (!sameFileIdentity(opened, after)) throw new Error(`${label} identity changed while reading`)
    return { bytes, identity: after }
  } catch (error) {
    if (error instanceof Error && /regular|identity|missing/.test(error.message)) throw error
    /* v8 ignore next -- OS-level open/read errors are normalized after all typed corruption branches @preserve */
    throw new Error(`${label} target could not be opened without following links`)
  } finally {
    if (fd !== null) fs.closeSync(fd)
  }
}

function openRetainedDirectory(directoryPath: string): RetainedDirectory {
  const before = directoryIdentityFromStats(fs.lstatSync(directoryPath, { bigint: true }), "migration parent")
  const fd = fs.openSync(directoryPath, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW)
  try {
    const opened = directoryIdentityFromStats(fs.fstatSync(fd, { bigint: true }), "migration parent")
    /* v8 ignore next -- sub-open directory replacement race; stable-parent replacement is exercised later @preserve */
    if (!sameStableDirectory(before, opened)) throw new Error("migration parent identity changed while opening")
    return { fd, identity: opened }
  /* v8 ignore next -- only the sub-open replacement race above enters this cleanup branch @preserve */
  } catch (error) {
    /* v8 ignore next -- best-effort descriptor cleanup after the injected kernel race @preserve */
    fs.closeSync(fd)
    /* v8 ignore next -- preserve the original fail-closed race error @preserve */
    throw error
  }
}

function assertRetainedDirectory(directoryPath: string, retained: RetainedDirectory): DirectoryIdentityV1 {
  const byPath = directoryIdentityFromStats(fs.lstatSync(directoryPath, { bigint: true }), "migration parent")
  const byDescriptor = directoryIdentityFromStats(fs.fstatSync(retained.fd, { bigint: true }), "migration parent")
  if (!sameStableDirectory(retained.identity, byPath) || !sameStableDirectory(byPath, byDescriptor)) {
    throw new Error("migration parent directory identity changed")
  }
  return byDescriptor
}

function writeAll(fd: number, bytes: Buffer): void {
  let offset = 0
  while (offset < bytes.length) {
    const written = fs.writeSync(fd, bytes, offset, bytes.length - offset)
    /* v8 ignore next -- Node fs.writeSync either throws or makes progress for a non-empty regular-file write @preserve */
    if (written <= 0) throw new Error("migration write made no progress")
    offset += written
  }
}

function atomicReplace(
  targetPath: string,
  parentPath: string,
  expected: StableFile,
  targetBytes: Buffer,
  targetSha256: string,
  hook?: (point: "after-target-lstat" | "before-rename") => void,
): StableFile {
  const retained = openRetainedDirectory(parentPath)
  const tempPath = path.join(parentPath, `.${path.basename(targetPath)}.migration-${randomBytes(16).toString("hex")}`)
  let tempFd: number | null = null
  let renamed = false
  try {
    tempFd = fs.openSync(
      tempPath,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
      0o600,
    )
    writeAll(tempFd, targetBytes)
    fs.fsyncSync(tempFd)
    fs.closeSync(tempFd)
    tempFd = null
    assertRetainedDirectory(parentPath, retained)
    const current = stableRead(targetPath, "migration", () => hook?.("after-target-lstat"))
    /* v8 ignore next -- sub-operation race between the outer verified read and retained-parent re-read @preserve */
    if (!sameFileIdentity(current.identity, expected.identity) || sha256(current.bytes) !== sha256(expected.bytes)) {
      throw new Error("migration target identity changed before atomic rewrite")
    }
    hook?.("before-rename")
    assertRetainedDirectory(parentPath, retained)
    const finalCheck = stableRead(targetPath, "migration")
    if (!sameFileIdentity(finalCheck.identity, expected.identity) || sha256(finalCheck.bytes) !== sha256(expected.bytes)) {
      throw new Error("migration target identity changed before rename")
    }
    fs.renameSync(tempPath, targetPath)
    renamed = true
    fs.fsyncSync(retained.fd)
    assertRetainedDirectory(parentPath, retained)
    const result = stableRead(targetPath, "migration")
    /* v8 ignore next -- sub-rename external replacement race; resulting bytes are always verified @preserve */
    if (sha256(result.bytes) !== targetSha256) throw new Error("migration resulting hash mismatch")
    return result
  } finally {
    /* v8 ignore next -- write/close failures before the normal explicit close retain a descriptor @preserve */
    if (tempFd !== null) {
      /* v8 ignore next -- best-effort close after a prior filesystem failure @preserve */
      try { fs.closeSync(tempFd) } catch { /* best-effort close */ }
    }
    if (!renamed) {
      try { fs.unlinkSync(tempPath) } catch { /* absent or raced temporary file */ }
    }
    fs.closeSync(retained.fd)
  }
}

function ensurePrivateDirectory(bundleRoot: string, directoryPath: string): void {
  const root = fs.realpathSync(path.resolve(bundleRoot))
  const target = path.resolve(directoryPath)
  /* v8 ignore next -- all callers construct state/migrations descendants from the canonical bundle root @preserve */
  if (!target.startsWith(`${root}${path.sep}`)) throw new Error("migration authority directory escapes bundle")
  let current = root
  for (const segment of path.relative(root, target).split(path.sep)) {
    current = path.join(current, segment)
    try {
      const stats = fs.lstatSync(current)
      if (stats.isSymbolicLink() || !stats.isDirectory()) throw new Error("migration authority directory is not a real directory")
    } catch (error) {
      if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error
      fs.mkdirSync(current, { mode: 0o700 })
    }
    /* v8 ignore next -- each segment was just lstat-verified as non-symlink beneath a canonical root @preserve */
    if (fs.realpathSync(current) !== current) throw new Error("migration authority directory contains a symlink")
  }
}

function relativeRef(bundleRoot: string, filePath: string): string {
  const relative = path.relative(bundleRoot, filePath)
  /* v8 ignore next -- authority paths are constructed beneath the canonical bundle root @preserve */
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("migration authority ref escapes bundle")
  return relative.split(path.sep).join("/")
}

function authorityPath(bundleRoot: string, kind: "bytes" | "json", digest: string): string {
  return path.join(bundleRoot, "state", "migrations", "authorities", kind, `${digest}.${kind === "bytes" ? "bin" : "json"}`)
}

function writeImmutableBytes(bundleRoot: string, bytes: Buffer, kind: "bytes" | "json"): { ref: string; sha256: string } {
  const digest = sha256(bytes)
  const filePath = authorityPath(bundleRoot, kind, digest)
  ensurePrivateDirectory(bundleRoot, path.dirname(filePath))
  try {
    const fd = fs.openSync(filePath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600)
    try {
      writeAll(fd, bytes)
      fs.fsyncSync(fd)
    } finally {
      fs.closeSync(fd)
    }
    const parentFd = fs.openSync(path.dirname(filePath), fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW)
    try { fs.fsyncSync(parentFd) } finally { fs.closeSync(parentFd) }
  } catch (error) {
    /* v8 ignore next -- non-EEXIST filesystem failures are propagated without reinterpretation @preserve */
    if (!(error && typeof error === "object" && "code" in error && error.code === "EEXIST")) throw error
    const existing = stableRead(filePath, "migration authority")
    if (sha256(existing.bytes) !== digest) throw new Error("migration authority content conflicts with its hash")
  }
  const persisted = stableRead(filePath, "migration authority")
  /* v8 ignore next -- sub-write external replacement race after immutable creation @preserve */
  if (sha256(persisted.bytes) !== digest) throw new Error("migration authority hash verification failed")
  return { ref: relativeRef(bundleRoot, filePath), sha256: digest }
}

function writeImmutableJson(bundleRoot: string, value: unknown): { ref: string; sha256: string } {
  return writeImmutableBytes(bundleRoot, Buffer.from(canonicalizeJson(value), "utf8"), "json")
}

function readAuthorityBytes(bundleRoot: string, ref: string, expectedSha256: string): Buffer {
  if (path.isAbsolute(ref)) throw new Error("migration authority ref must be relative")
  const root = path.resolve(bundleRoot)
  const filePath = path.resolve(root, ref)
  if (!filePath.startsWith(`${root}${path.sep}`)) throw new Error("migration authority ref escapes bundle")
  const bytes = stableRead(filePath, "migration authority").bytes
  if (sha256(bytes) !== expectedSha256) throw new Error("migration authority hash mismatch")
  return bytes
}

function readAuthorityJson<T>(bundleRoot: string, ref: string, expectedSha256: string): T {
  return parseCanonicalJson(readAuthorityBytes(bundleRoot, ref, expectedSha256)) as T
}

function writeMutableJson(bundleRoot: string, filePath: string, value: unknown): void {
  const parentPath = path.dirname(filePath)
  ensurePrivateDirectory(bundleRoot, parentPath)
  const bytes = Buffer.from(canonicalizeJson(value), "utf8")
  const tempPath = path.join(parentPath, `.${path.basename(filePath)}.tmp-${randomBytes(16).toString("hex")}`)
  let fd: number | null = null
  let renamed = false
  try {
    if (fs.existsSync(filePath)) stableRead(filePath, "migration transaction")
    fd = fs.openSync(tempPath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600)
    writeAll(fd, bytes)
    fs.fsyncSync(fd)
    fs.closeSync(fd)
    fd = null
    fs.renameSync(tempPath, filePath)
    renamed = true
    const parentFd = fs.openSync(parentPath, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW)
    try { fs.fsyncSync(parentFd) } finally { fs.closeSync(parentFd) }
  } finally {
    /* v8 ignore next -- write/close failures before the normal explicit close retain a descriptor @preserve */
    if (fd !== null) {
      /* v8 ignore next -- best-effort close after a prior filesystem failure @preserve */
      try { fs.closeSync(fd) } catch { /* best-effort close */ }
    }
    /* v8 ignore next -- only an injected filesystem failure leaves the mutable temp unrenamed @preserve */
    if (!renamed) {
      /* v8 ignore next -- best-effort unlink after a prior filesystem failure @preserve */
      try { fs.unlinkSync(tempPath) } catch { /* absent temporary file */ }
    }
  }
}

function readMutableJson<T>(filePath: string): T {
  return parseCanonicalJson(stableRead(filePath, "migration transaction").bytes) as T
}

function writeRequest(bundleRoot: string, filePath: string, request: AnyRequest): void {
  const bytes = Buffer.from(canonicalizeJson(request), "utf8")
  if (fs.existsSync(filePath)) {
    const prior = stableRead(filePath, "migration request").bytes
    if (!prior.equals(bytes)) throw new Error("migration request conflicts with persisted authority")
    return
  }
  writeMutableJson(bundleRoot, filePath, request)
}

function resolveCoordinates(bundleRootInput: string, request: AnyRequest): MigrationCoordinates {
  const requestedRoot = path.resolve(bundleRootInput)
  const requestedStats = fs.lstatSync(requestedRoot)
  if (requestedStats.isSymbolicLink() || !requestedStats.isDirectory()) throw new Error("bundle root must be a real directory")
  const bundleRoot = fs.realpathSync(requestedRoot)
  const targetRelativePath = request.migrationId === "exact-file" ? request.habitPath : request.agentConfigPath
  const targetPath = path.join(bundleRoot, ...targetRelativePath.split("/"))
  const parentPath = path.dirname(targetPath)
  const realParent = fs.realpathSync(parentPath)
  if (realParent !== parentPath || (realParent !== bundleRoot && !realParent.startsWith(`${bundleRoot}${path.sep}`))) {
    throw new Error("migration parent must be a real directory inside the bundle")
  }
  const transactionDirectory = path.join(bundleRoot, "state", "migrations", request.migrationId, request.requestSha256)
  return {
    bundleRoot,
    parentPath,
    targetPath,
    targetRelativePath,
    transactionDirectory,
    requestPath: path.join(transactionDirectory, "request.json"),
    transactionPath: path.join(transactionDirectory, "transaction.json"),
  }
}

function assertStringArray(value: unknown, label: string): void {
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) throw new Error(`${label} must be a string array`)
}

function assertOptionalObject(value: unknown, allowed: readonly string[], label: string): Record<string, unknown> | undefined {
  if (value === undefined) return undefined
  const parsed = record(value, label)
  const unknown = Object.keys(parsed).filter((key) => !allowed.includes(key))
  if (unknown.length > 0) throw new Error(`${label} has unknown field ${unknown.sort()[0]}`)
  return parsed
}

function validateStrictAgentConfig(bytes: Buffer): Record<string, unknown> {
  let parsed: Record<string, unknown>
  try {
    parsed = record(JSON.parse(bytes.toString("utf8")), "agent config")
  } catch (error) {
    throw new Error(`agent config JSON is invalid: ${error instanceof Error ? error.message : /* v8 ignore next -- JSON.parse and record throw Error instances @preserve */ String(error)}`)
  }
  const allowedRoot = [
    "version", "enabled", "provider", "humanFacing", "agentFacing", "context", "logging", "senses",
    "mcpServers", "habitExecutors", "mcpHealthProfiles", "shell", "phrases", "vault", "sync", "plugins",
    "privateRuntime",
  ]
  const unknown = Object.keys(parsed).filter((key) => !allowedRoot.includes(key))
  if (unknown.length > 0) throw new Error(`agent config has unknown root field ${unknown.sort()[0]}`)
  for (const required of ["version", "enabled", "humanFacing", "agentFacing", "phrases"]) {
    if (!Object.prototype.hasOwnProperty.call(parsed, required)) throw new Error(`agent config is missing required ${required}`)
  }
  if (parsed.version !== 2) throw new Error("agent config version must be 2")
  if (typeof parsed.enabled !== "boolean") throw new Error("agent config enabled must be boolean")
  const providers = new Set(["azure", "minimax", "anthropic", "openai-codex", "github-copilot"])
  for (const lane of ["humanFacing", "agentFacing"] as const) {
    const facing = record(parsed[lane], `agent config ${lane}`)
    exactKeys(facing, ["provider", "model"], `agent config ${lane}`)
    if (typeof facing.provider !== "string" || !providers.has(facing.provider)) throw new Error(`agent config ${lane}.provider is invalid`)
    if (typeof facing.model !== "string") throw new Error(`agent config ${lane}.model is required`)
  }
  if (parsed.provider !== undefined && (typeof parsed.provider !== "string" || !providers.has(parsed.provider))) {
    throw new Error("agent config deprecated provider is invalid")
  }
  const phrases = record(parsed.phrases, "agent config phrases")
  exactKeys(phrases, ["thinking", "tool", "followup"], "agent config phrases")
  assertStringArray(phrases.thinking, "agent config phrases.thinking")
  assertStringArray(phrases.tool, "agent config phrases.tool")
  assertStringArray(phrases.followup, "agent config phrases.followup")

  const context = assertOptionalObject(parsed.context, ["maxTokens", "contextMargin"], "agent config context")
  if (context?.maxTokens !== undefined && (!Number.isInteger(context.maxTokens) || (context.maxTokens as number) <= 0)) throw new Error("agent config context.maxTokens is invalid")
  if (context?.contextMargin !== undefined && (typeof context.contextMargin !== "number" || !Number.isFinite(context.contextMargin))) throw new Error("agent config context.contextMargin is invalid")
  const logging = assertOptionalObject(parsed.logging, ["level", "sinks"], "agent config logging")
  if (logging?.level !== undefined && !["debug", "info", "warn", "error"].includes(logging.level as string)) throw new Error("agent config logging.level is invalid")
  if (logging?.sinks !== undefined) {
    assertStringArray(logging.sinks, "agent config logging.sinks")
    if (!(logging.sinks as string[]).every((sink) => sink === "terminal" || sink === "ndjson")) throw new Error("agent config logging.sinks is invalid")
  }
  const senses = assertOptionalObject(parsed.senses, ["cli", "teams", "bluebubbles", "mail", "voice", "a2a", "workbench"], "agent config senses")
  for (const [sense, raw] of Object.entries(senses ?? {})) {
    const config = record(raw, `agent config senses.${sense}`)
    exactKeys(config, ["enabled"], `agent config senses.${sense}`)
    if (typeof config.enabled !== "boolean") throw new Error(`agent config senses.${sense}.enabled is invalid`)
  }
  const servers = assertOptionalObject(parsed.mcpServers, Object.keys(record(parsed.mcpServers ?? {}, "agent config mcpServers")), "agent config mcpServers")
  for (const [serverId, raw] of Object.entries(servers ?? {})) {
    if (!IDENTIFIER.test(serverId)) throw new Error(`agent config mcpServers.${serverId} id is invalid`)
    const server = record(raw, `agent config mcpServers.${serverId}`)
    const unknownServer = Object.keys(server).filter((key) => !["command", "args", "env", "cwd", "visibility"].includes(key))
    if (unknownServer.length > 0) throw new Error(`agent config mcpServers.${serverId} has unknown field ${unknownServer[0]}`)
    if (typeof server.command !== "string" || server.command.length === 0) throw new Error(`agent config mcpServers.${serverId}.command is required`)
    if (server.args !== undefined) assertStringArray(server.args, `agent config mcpServers.${serverId}.args`)
    if (server.env !== undefined) {
      const env = record(server.env, `agent config mcpServers.${serverId}.env`)
      if (!Object.values(env).every((entry) => typeof entry === "string")) throw new Error(`agent config mcpServers.${serverId}.env is invalid`)
    }
    if (server.cwd !== undefined && typeof server.cwd !== "string") throw new Error(`agent config mcpServers.${serverId}.cwd is invalid`)
    if (server.visibility !== undefined && server.visibility !== "agent" && server.visibility !== "internal") throw new Error(`agent config mcpServers.${serverId}.visibility is invalid`)
  }
  if (parsed.habitExecutors !== undefined && !Array.isArray(parsed.habitExecutors)) throw new Error("agent config habitExecutors must be an array")
  if (parsed.mcpHealthProfiles !== undefined && !Array.isArray(parsed.mcpHealthProfiles)) throw new Error("agent config mcpHealthProfiles must be an array")
  const shell = assertOptionalObject(parsed.shell, ["defaultTimeout"], "agent config shell")
  if (shell?.defaultTimeout !== undefined && (!Number.isInteger(shell.defaultTimeout) || (shell.defaultTimeout as number) <= 0)) throw new Error("agent config shell.defaultTimeout is invalid")
  const vault = assertOptionalObject(parsed.vault, ["email", "serverUrl"], "agent config vault")
  if (vault && typeof vault.email !== "string") throw new Error("agent config vault.email is required")
  if (vault?.serverUrl !== undefined && typeof vault.serverUrl !== "string") throw new Error("agent config vault.serverUrl is invalid")
  const sync = assertOptionalObject(parsed.sync, ["enabled", "remote"], "agent config sync")
  if (sync?.enabled !== undefined && typeof sync.enabled !== "boolean") throw new Error("agent config sync.enabled is invalid")
  if (sync?.remote !== undefined && typeof sync.remote !== "string") throw new Error("agent config sync.remote is invalid")
  if (parsed.plugins !== undefined && !Array.isArray(parsed.plugins)) throw new Error("agent config plugins must be an array")
  for (const [index, raw] of (parsed.plugins as unknown[] | undefined ?? []).entries()) {
    const plugin = record(raw, `agent config plugins[${index}]`)
    const unknownPlugin = Object.keys(plugin).filter((key) => !["id", "enabled", "source", "version"].includes(key))
    if (unknownPlugin.length > 0) throw new Error(`agent config plugins[${index}] has unknown field ${unknownPlugin[0]}`)
    if (typeof plugin.id !== "string" || typeof plugin.enabled !== "boolean") throw new Error(`agent config plugins[${index}] is invalid`)
    if (plugin.source !== undefined && typeof plugin.source !== "string") throw new Error(`agent config plugins[${index}].source is invalid`)
    if (plugin.version !== undefined && typeof plugin.version !== "string") throw new Error(`agent config plugins[${index}].version is invalid`)
  }
  const privateRuntime = assertOptionalObject(parsed.privateRuntime, ["autoStart"], "agent config privateRuntime")
  if (privateRuntime?.autoStart !== undefined && typeof privateRuntime.autoStart !== "boolean") throw new Error("agent config privateRuntime.autoStart is invalid")
  return parsed
}

function newTransaction(plan: AnyPlan, planRef: string, planSha256: string): MigrationTxnV1 {
  return {
    schemaVersion: 1,
    transactionId: plan.transactionId,
    requestSha256: plan.requestSha256,
    planRef,
    planSha256,
    state: "prepared",
    currentExpectedSha256: plan.beforeSha256,
    forwardResultRef: null,
    forwardResultSha256: null,
    forwardReceiptRef: null,
    forwardReceiptSha256: null,
    rollbackResultRef: null,
    rollbackResultSha256: null,
    rollbackReceiptRef: null,
    rollbackReceiptSha256: null,
    lastError: null,
    createdAt: plan.plannedAt,
    updatedAt: plan.plannedAt,
  }
}

function buildResult(plan: AnyPlan, direction: "forward" | "rollback", identity: FileIdentityV1, transaction: MigrationTxnV1): AnyResult {
  const common: MigrationResultBaseV1 = {
    schemaVersion: 1,
    transactionId: plan.transactionId,
    requestSha256: plan.requestSha256,
    version: 1,
    direction,
    rollbackOf: direction === "forward" ? null : transaction.forwardResultSha256,
    parentIdentity: plan.parentIdentity,
    expectedCurrentSha256: direction === "forward" ? plan.beforeSha256 : plan.afterSha256,
    resultingIdentity: identity,
    resultingSha256: direction === "forward" ? plan.afterSha256 : plan.beforeSha256,
    disposition: direction === "rollback" ? "rolled_back" : plan.disposition,
  }
  return plan.migrationId === "exact-file"
    ? { ...common, migrationId: "exact-file", habitId: plan.habitId, habitPath: plan.habitPath }
    : { ...common, migrationId: "agent-config-cas", agentConfigPath: plan.agentConfigPath }
}

function buildReceipt(
  plan: AnyPlan,
  phase: "apply" | "rollback",
  transaction: MigrationTxnV1,
  resultRef: string,
  resultSha256: string,
): MigrationPhaseReceiptV1 {
  const body = {
    schemaVersion: 1 as const,
    transactionId: plan.transactionId,
    phase,
    priorTransactionSha256: sha256CanonicalJson(transaction),
    resultRef,
    resultSha256,
    resultingFileSha256: phase === "apply" ? plan.afterSha256 : plan.beforeSha256,
    committedAt: plan.plannedAt,
  }
  return { ...body, receiptId: `${phase}-${sha256CanonicalJson(body)}` }
}

function completedForward(bundleRoot: string, plan: AnyPlan, transaction: MigrationTxnV1): { plan: AnyPlan; transaction: MigrationTxnV1; result: AnyResult; receipt: MigrationPhaseReceiptV1 } {
  if (!transaction.forwardResultRef || !transaction.forwardResultSha256 || !transaction.forwardReceiptRef || !transaction.forwardReceiptSha256) {
    throw new Error("committed migration is missing forward authorities")
  }
  return {
    plan,
    transaction,
    result: readAuthorityJson(bundleRoot, transaction.forwardResultRef, transaction.forwardResultSha256),
    receipt: readAuthorityJson(bundleRoot, transaction.forwardReceiptRef, transaction.forwardReceiptSha256),
  }
}

function executeMigration<R extends AnyRequest>(options: ExecuteOptions<R>, expectedMigrationId: AnyRequest["migrationId"]): { plan: AnyPlan; transaction: MigrationTxnV1; result: AnyResult; receipt: MigrationPhaseReceiptV1 } {
  emitNervesEvent({
    component: "heart",
    event: "heart.habit_exact_file_migration",
    message: "executing a byte-bound generic runtime migration",
    meta: { migrationId: options.request.migrationId },
  })
  const targetBytes = expectedMigrationId === "exact-file"
    ? validateHabitRequest(options.request as HabitMigrationRequestV1)
    : validateConfigRequest(options.request as AgentConfigCasRequestV1)
  const coordinates = resolveCoordinates(options.bundleRoot, options.request)
  ensurePrivateDirectory(coordinates.bundleRoot, coordinates.transactionDirectory)
  writeRequest(coordinates.bundleRoot, coordinates.requestPath, options.request)

  let plan: AnyPlan
  let transaction: MigrationTxnV1
  if (fs.existsSync(coordinates.transactionPath)) {
    const persistedRequest = readMutableJson<AnyRequest>(coordinates.requestPath)
    /* v8 ignore next -- writeRequest already compares; this closes a concurrent post-check tamper race @preserve */
    if (canonicalizeJson(persistedRequest) !== canonicalizeJson(options.request)) throw new Error("persisted migration request does not match")
    transaction = readMutableJson<MigrationTxnV1>(coordinates.transactionPath)
    plan = readAuthorityJson<AnyPlan>(coordinates.bundleRoot, transaction.planRef, transaction.planSha256)
    if (transaction.requestSha256 !== options.request.requestSha256 || plan.requestSha256 !== options.request.requestSha256) {
      throw new Error("migration transaction request authority mismatch")
    }
    if (transaction.state === "committed") return completedForward(coordinates.bundleRoot, plan, transaction)
    if (transaction.state === "rolled_back" || transaction.state === "rollback_failed") throw new Error(`migration cannot apply from ${transaction.state}`)
  } else {
    const parent = openRetainedDirectory(coordinates.parentPath)
    let before: StableFile
    let parentIdentity: DirectoryIdentityV1
    try {
      parentIdentity = assertRetainedDirectory(coordinates.parentPath, parent)
      before = stableRead(coordinates.targetPath, "migration", () => options.hook?.("after-target-lstat"))
      assertRetainedDirectory(coordinates.parentPath, parent)
    } finally {
      fs.closeSync(parent.fd)
    }
    const beforeSha256 = sha256(before.bytes)
    if (beforeSha256 !== options.request.expectedBeforeSha256) throw new Error("migration preimage hash does not match expected authority")
    const beforeAuthority = writeImmutableBytes(coordinates.bundleRoot, before.bytes, "bytes")
    const afterAuthority = writeImmutableBytes(coordinates.bundleRoot, targetBytes, "bytes")
    const plannedAt = (options.now?.() ?? new Date()).toISOString()
    const common: MigrationPlanBaseV1 = {
      schemaVersion: 1,
      transactionId: `${options.request.migrationId}-${options.request.requestSha256}`,
      requestSha256: options.request.requestSha256,
      version: 1,
      disposition: beforeSha256 === options.request.targetSha256 ? "already_current" : "migrated",
      parentIdentity,
      beforeIdentity: before.identity,
      beforeRef: beforeAuthority.ref,
      beforeSha256,
      afterRef: afterAuthority.ref,
      afterSha256: options.request.targetSha256,
      plannedAt,
    }
    plan = options.request.migrationId === "exact-file"
      ? { ...common, migrationId: "exact-file", habitId: options.request.habitId, habitPath: options.request.habitPath }
      : {
          ...common,
          migrationId: "agent-config-cas",
          agentConfigPath: "agent.json",
          parsedConfigSha256: sha256CanonicalJson(validateStrictAgentConfig(targetBytes)),
        }
    const planAuthority = writeImmutableJson(coordinates.bundleRoot, plan)
    transaction = newTransaction(plan, planAuthority.ref, planAuthority.sha256)
    writeMutableJson(coordinates.bundleRoot, coordinates.transactionPath, transaction)
    options.fault?.("after-prepared")
  }

  if (transaction.state !== "prepared" && transaction.state !== "applied") throw new Error(`migration has invalid forward state ${transaction.state}`)
  let resulting: StableFile
  const current = stableRead(coordinates.targetPath, "migration")
  const currentHash = sha256(current.bytes)
  if (currentHash === plan.afterSha256) {
    if (plan.disposition === "already_current" && !sameFileIdentity(current.identity, plan.beforeIdentity)) {
      throw new Error("already-current migration target identity changed")
    }
    resulting = current
  } else if (currentHash === plan.beforeSha256) {
    if (!sameFileIdentity(current.identity, plan.beforeIdentity)) throw new Error("migration preimage identity changed after planning")
    const afterBytes = readAuthorityBytes(coordinates.bundleRoot, plan.afterRef, plan.afterSha256)
    resulting = atomicReplace(
      coordinates.targetPath,
      coordinates.parentPath,
      current,
      afterBytes,
      plan.afterSha256,
      options.hook,
    )
    options.fault?.("after-rewrite")
  } else {
    throw new Error("migration target hash conflicts with both planned authorities")
  }

  if (transaction.state === "prepared") {
    transaction = { ...transaction, state: "applied", currentExpectedSha256: plan.afterSha256, updatedAt: transaction.createdAt }
    writeMutableJson(coordinates.bundleRoot, coordinates.transactionPath, transaction)
    options.fault?.("after-applied")
  }
  const result = buildResult(plan, "forward", resulting.identity, transaction)
  const resultAuthority = writeImmutableJson(coordinates.bundleRoot, result)
  options.fault?.("after-result")
  const receipt = buildReceipt(plan, "apply", transaction, resultAuthority.ref, resultAuthority.sha256)
  const receiptAuthority = writeImmutableJson(coordinates.bundleRoot, receipt)
  options.fault?.("after-receipt")
  transaction = {
    ...transaction,
    state: "committed",
    currentExpectedSha256: plan.afterSha256,
    forwardResultRef: resultAuthority.ref,
    forwardResultSha256: resultAuthority.sha256,
    forwardReceiptRef: receiptAuthority.ref,
    forwardReceiptSha256: receiptAuthority.sha256,
    lastError: null,
    updatedAt: transaction.createdAt,
  }
  writeMutableJson(coordinates.bundleRoot, coordinates.transactionPath, transaction)
  return { plan, transaction, result, receipt }
}

function rollbackMigration(bundleRoot: string, migrationId: AnyRequest["migrationId"], requestSha256: string, fault?: (point: MigrationFaultPoint) => void): { plan: AnyPlan; transaction: MigrationTxnV1; result: AnyResult; receipt: MigrationPhaseReceiptV1 } {
  assertSha256(requestSha256, "requestSha256")
  const transactionDirectory = path.join(fs.realpathSync(path.resolve(bundleRoot)), "state", "migrations", migrationId, requestSha256)
  const request = readMutableJson<AnyRequest>(path.join(transactionDirectory, "request.json"))
  if (request.migrationId !== migrationId || request.requestSha256 !== requestSha256) throw new Error("rollback request authority mismatch")
  if (migrationId === "exact-file") validateHabitRequest(request as HabitMigrationRequestV1)
  else validateConfigRequest(request as AgentConfigCasRequestV1)
  const coordinates = resolveCoordinates(bundleRoot, request)
  let transaction = readMutableJson<MigrationTxnV1>(coordinates.transactionPath)
  const plan = readAuthorityJson<AnyPlan>(coordinates.bundleRoot, transaction.planRef, transaction.planSha256)
  if (transaction.state === "rolled_back") {
    if (!transaction.rollbackResultRef || !transaction.rollbackResultSha256 || !transaction.rollbackReceiptRef || !transaction.rollbackReceiptSha256) {
      throw new Error("rolled-back migration is missing rollback authorities")
    }
    return {
      plan,
      transaction,
      result: readAuthorityJson(coordinates.bundleRoot, transaction.rollbackResultRef, transaction.rollbackResultSha256),
      receipt: readAuthorityJson(coordinates.bundleRoot, transaction.rollbackReceiptRef, transaction.rollbackReceiptSha256),
    }
  }
  if (transaction.state !== "committed" && transaction.state !== "rollback_required" && transaction.state !== "rollback_failed") {
    throw new Error(`migration cannot roll back from ${transaction.state}`)
  }
  if (!transaction.forwardResultSha256) throw new Error("rollback requires a committed forward result")
  const current = stableRead(coordinates.targetPath, "migration rollback")
  const currentHash = sha256(current.bytes)
  let resulting: StableFile
  if (currentHash === plan.beforeSha256) {
    resulting = current
  } else if (currentHash === plan.afterSha256) {
    if (!transaction.forwardResultRef || !transaction.forwardResultSha256) throw new Error("rollback requires a complete committed forward result")
    const forward = readAuthorityJson<AnyResult>(coordinates.bundleRoot, transaction.forwardResultRef, transaction.forwardResultSha256)
    if (!sameFileIdentity(current.identity, forward.resultingIdentity)) throw new Error("rollback target identity changed after apply")
    transaction = { ...transaction, state: "rollback_required", currentExpectedSha256: plan.afterSha256, lastError: null }
    writeMutableJson(coordinates.bundleRoot, coordinates.transactionPath, transaction)
    const beforeBytes = readAuthorityBytes(coordinates.bundleRoot, plan.beforeRef, plan.beforeSha256)
    resulting = atomicReplace(coordinates.targetPath, coordinates.parentPath, current, beforeBytes, plan.beforeSha256)
    fault?.("rollback-after-rewrite")
  } else {
    transaction = {
      ...transaction,
      state: "rollback_failed",
      lastError: { code: "third_hash_conflict", message: "rollback target hash conflicts with both planned authorities" },
    }
    writeMutableJson(coordinates.bundleRoot, coordinates.transactionPath, transaction)
    throw new Error("rollback target hash conflicts with expected authorities")
  }
  const result = buildResult(plan, "rollback", resulting.identity, transaction)
  const resultAuthority = writeImmutableJson(coordinates.bundleRoot, result)
  const receipt = buildReceipt(plan, "rollback", transaction, resultAuthority.ref, resultAuthority.sha256)
  const receiptAuthority = writeImmutableJson(coordinates.bundleRoot, receipt)
  transaction = {
    ...transaction,
    state: "rolled_back",
    currentExpectedSha256: plan.beforeSha256,
    rollbackResultRef: resultAuthority.ref,
    rollbackResultSha256: resultAuthority.sha256,
    rollbackReceiptRef: receiptAuthority.ref,
    rollbackReceiptSha256: receiptAuthority.sha256,
    lastError: null,
    updatedAt: transaction.createdAt,
  }
  writeMutableJson(coordinates.bundleRoot, coordinates.transactionPath, transaction)
  return { plan, transaction, result, receipt }
}

export function createHabitMigrationRequest(input: {
  habitId: string
  expectedBeforeBytes: Buffer
  targetBytes: Buffer
}): HabitMigrationRequestV1 {
  const body = {
    migrationId: "exact-file" as const,
    version: 1 as const,
    habitId: input.habitId,
    habitPath: `habits/${input.habitId}.md`,
    expectedBeforeSha256: sha256(input.expectedBeforeBytes),
    targetBytesBase64: input.targetBytes.toString("base64"),
    targetSha256: sha256(input.targetBytes),
  }
  return { ...body, requestSha256: sha256CanonicalJson(body) }
}

export function createAgentConfigCasRequest(input: {
  expectedBeforeBytes: Buffer
  targetBytes: Buffer
}): AgentConfigCasRequestV1 {
  const body = {
    migrationId: "agent-config-cas" as const,
    version: 1 as const,
    agentConfigPath: "agent.json" as const,
    expectedBeforeSha256: sha256(input.expectedBeforeBytes),
    targetBytesBase64: input.targetBytes.toString("base64"),
    targetSha256: sha256(input.targetBytes),
  }
  return { ...body, requestSha256: sha256CanonicalJson(body) }
}

export function executeHabitMigration(options: ExecuteOptions<HabitMigrationRequestV1>): CompletedHabitMigration {
  return executeMigration(options, "exact-file") as CompletedHabitMigration
}

export function executeAgentConfigCas(options: ExecuteOptions<AgentConfigCasRequestV1>): CompletedAgentConfigCas {
  return executeMigration(options, "agent-config-cas") as CompletedAgentConfigCas
}

export function rollbackHabitMigration(options: RollbackOptions): CompletedHabitMigration {
  return rollbackMigration(options.bundleRoot, "exact-file", options.requestSha256, options.fault) as CompletedHabitMigration
}

export function rollbackAgentConfigCas(options: RollbackOptions): CompletedAgentConfigCas {
  return rollbackMigration(options.bundleRoot, "agent-config-cas", options.requestSha256, options.fault) as CompletedAgentConfigCas
}

export function executeRuntimeAdoption(options: {
  bundleRoot: string
  agentConfig: AgentConfigCasRequestV1
  habits: HabitMigrationRequestV1[]
  validateCombined(): void
  hook?: (event: string) => void
}): { agentConfig: CompletedAgentConfigCas; habits: CompletedHabitMigration[] } {
  let agentConfig: CompletedAgentConfigCas | null = null
  const habits: CompletedHabitMigration[] = []
  try {
    agentConfig = executeAgentConfigCas({ bundleRoot: options.bundleRoot, request: options.agentConfig })
    options.hook?.("apply:agent.json")
    for (const request of options.habits) {
      habits.push(executeHabitMigration({ bundleRoot: options.bundleRoot, request }))
      options.hook?.(`apply:${request.habitPath}`)
    }
    options.hook?.("validate:combined")
    options.validateCombined()
    return { agentConfig, habits }
  } catch (error) {
    for (const completed of [...habits].reverse()) {
      options.hook?.(`rollback:${completed.plan.habitPath}`)
      rollbackHabitMigration({ bundleRoot: options.bundleRoot, requestSha256: completed.plan.requestSha256 })
    }
    if (agentConfig) {
      options.hook?.("rollback:agent.json")
      rollbackAgentConfigCas({ bundleRoot: options.bundleRoot, requestSha256: agentConfig.plan.requestSha256 })
    }
    throw error
  }
}
