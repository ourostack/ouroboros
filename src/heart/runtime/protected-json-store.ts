import { randomBytes } from "crypto"
import * as fs from "fs"
import * as path from "path"
import { emitNervesEvent } from "../../nerves/runtime"
import { canonicalizeJson, parseCanonicalJson } from "./canonical-json"
import { parseProcessIdentity, processIdentityEquals } from "./process-identity"
import type { ExactProcessState, ProcessIdentity } from "./process-identity"

interface FileIdentity {
  dev: number
  ino: number
  nlink: number
  uid: number
  gid: number
  mode: number
  ctimeMs: number
}

interface DirectoryIdentity {
  dev: string
  ino: string
  nlink: string
  uid: string
  gid: string
  mode: string
  ctimeNs: string
}

export interface ProtectedStoreIo {
  lstatSync(filePath: string): fs.Stats
  fstatSync(fd: number): fs.Stats
  lstatDirectorySync(directoryPath: string): fs.BigIntStats
  fstatDirectorySync(fd: number): fs.BigIntStats
  openSync(filePath: string, flags: number, mode?: number): number
  readFileSync(pathOrFd: string | number): Buffer
  writeSync(fd: number, buffer: Buffer, offset: number, length: number): number
  fsyncSync(fd: number): void
  closeSync(fd: number): void
  renameSync(from: string, to: string): void
  unlinkSync(filePath: string): void
}

export const nodeProtectedStoreIo: ProtectedStoreIo = {
  lstatSync: (filePath) => fs.lstatSync(filePath),
  fstatSync: (fd) => fs.fstatSync(fd),
  lstatDirectorySync: (directoryPath) => fs.lstatSync(directoryPath, { bigint: true }),
  fstatDirectorySync: (fd) => fs.fstatSync(fd, { bigint: true }),
  openSync: (filePath, flags, mode) => fs.openSync(filePath, flags, mode),
  readFileSync: (pathOrFd) => fs.readFileSync(pathOrFd),
  writeSync: (fd, buffer, offset, length) => fs.writeSync(fd, buffer, offset, length),
  fsyncSync: (fd) => fs.fsyncSync(fd),
  closeSync: (fd) => fs.closeSync(fd),
  renameSync: (from, to) => fs.renameSync(from, to),
  unlinkSync: (filePath) => fs.unlinkSync(filePath),
}

export class ProtectedStoreLockedError extends Error {
  constructor(message = "protected store is locked by a live or unobservable owner") {
    super(message)
    this.name = "ProtectedStoreLockedError"
  }
}

export class ProtectedStoreCorruptError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ProtectedStoreCorruptError"
  }
}

export interface ProtectedLock {
  readonly targetPath: string
  assertHeld(): void
  release(): void
}

function errorCode(error: unknown): string | null {
  return error !== null && typeof error === "object" && "code" in error && typeof error.code === "string"
    ? error.code
    : null
}

function identityFromStats(stats: fs.Stats): FileIdentity {
  return {
    dev: stats.dev,
    ino: stats.ino,
    nlink: stats.nlink,
    uid: stats.uid,
    gid: stats.gid,
    mode: stats.mode,
    ctimeMs: stats.ctimeMs,
  }
}

function identitiesEqual(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev &&
    left.ino === right.ino &&
    left.nlink === right.nlink &&
    left.uid === right.uid &&
    left.gid === right.gid &&
    left.mode === right.mode &&
    left.ctimeMs === right.ctimeMs
}

function regularIdentity(stats: fs.Stats, label: string): FileIdentity {
  if (stats.isSymbolicLink() || !stats.isFile() || stats.nlink !== 1) {
    throw new ProtectedStoreCorruptError(`${label} must be a regular single-link file, not a symlink`)
  }
  if ((stats.mode & 0o777) !== 0o600) throw new ProtectedStoreCorruptError(`${label} must have mode 0600`)
  return identityFromStats(stats)
}

function directoryIdentity(stats: fs.BigIntStats, label: string): DirectoryIdentity {
  if (stats.isSymbolicLink() || !stats.isDirectory() || stats.nlink <= 0n) {
    throw new ProtectedStoreCorruptError(`${label} must be a real directory with a positive link count`)
  }
  return {
    dev: stats.dev.toString(),
    ino: stats.ino.toString(),
    nlink: stats.nlink.toString(),
    uid: stats.uid.toString(),
    gid: stats.gid.toString(),
    mode: stats.mode.toString(),
    ctimeNs: stats.ctimeNs.toString(),
  }
}

function directoryIdentitiesEqual(left: DirectoryIdentity, right: DirectoryIdentity): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

function stableDirectoryIdentity(identity: DirectoryIdentity): string {
  return JSON.stringify({
    dev: identity.dev,
    ino: identity.ino,
    uid: identity.uid,
    gid: identity.gid,
    mode: identity.mode,
  })
}

interface RetainedDirectory {
  fd: number
  identity: DirectoryIdentity
}

function openRetainedDirectory(directoryPath: string, io: ProtectedStoreIo): RetainedDirectory {
  const before = directoryIdentity(io.lstatDirectorySync(directoryPath), "protected store parent")
  const fd = io.openSync(directoryPath, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW)
  try {
    const opened = directoryIdentity(io.fstatDirectorySync(fd), "protected store parent")
    if (!directoryIdentitiesEqual(before, opened)) {
      throw new ProtectedStoreCorruptError("protected store parent changed while opening")
    }
    return { fd, identity: opened }
  } catch (error) {
    io.closeSync(fd)
    throw error
  }
}

function assertRetainedDirectory(directoryPath: string, retained: RetainedDirectory, io: ProtectedStoreIo): void {
  const byPath = directoryIdentity(io.lstatDirectorySync(directoryPath), "protected store parent")
  const byDescriptor = directoryIdentity(io.fstatDirectorySync(retained.fd), "protected store parent")
  if (!directoryIdentitiesEqual(retained.identity, byPath) || !directoryIdentitiesEqual(byPath, byDescriptor)) {
    throw new ProtectedStoreCorruptError("protected store parent identity changed")
  }
}

function refreshRetainedDirectory(directoryPath: string, retained: RetainedDirectory, io: ProtectedStoreIo): void {
  const byPath = directoryIdentity(io.lstatDirectorySync(directoryPath), "protected store parent")
  const byDescriptor = directoryIdentity(io.fstatDirectorySync(retained.fd), "protected store parent")
  if (
    stableDirectoryIdentity(retained.identity) !== stableDirectoryIdentity(byPath) ||
    stableDirectoryIdentity(byPath) !== stableDirectoryIdentity(byDescriptor)
  ) {
    throw new ProtectedStoreCorruptError("protected store parent stable identity changed")
  }
  retained.identity = byDescriptor
}

function lstatOptional(filePath: string, io: ProtectedStoreIo): fs.Stats | null {
  try {
    return io.lstatSync(filePath)
  } catch (error) {
    if (errorCode(error) === "ENOENT") return null
    throw error
  }
}

function readStableRegularFile(filePath: string, io: ProtectedStoreIo, label: string): {
  bytes: Buffer
  identity: FileIdentity
} {
  const beforeStats = lstatOptional(filePath, io)
  if (beforeStats === null) throw new ProtectedStoreCorruptError(`${label} is missing`)
  const before = regularIdentity(beforeStats, label)
  let fd: number | null = null
  try {
    fd = io.openSync(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
    const opened = regularIdentity(io.fstatSync(fd), label)
    if (!identitiesEqual(before, opened)) throw new ProtectedStoreCorruptError(`${label} changed while opening`)
    const bytes = io.readFileSync(fd)
    const after = regularIdentity(io.fstatSync(fd), label)
    if (!identitiesEqual(opened, after)) throw new ProtectedStoreCorruptError(`${label} changed while reading`)
    return { bytes, identity: after }
  } catch (error) {
    if (error instanceof ProtectedStoreCorruptError) throw error
    throw new ProtectedStoreCorruptError(`${label} could not be read without following links`)
  } finally {
    if (fd !== null) io.closeSync(fd)
  }
}

function parseLock(bytes: Buffer): { schemaVersion: 1; owner: ProcessIdentity } {
  let value: unknown
  try {
    value = parseCanonicalJson(bytes)
  } catch {
    throw new ProtectedStoreCorruptError("protected lock record is corrupt or non-canonical")
  }
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(",") !== "owner,schemaVersion" ||
    (value as Record<string, unknown>).schemaVersion !== 1
  ) {
    throw new ProtectedStoreCorruptError("protected lock record has an invalid schema")
  }
  try {
    return { schemaVersion: 1, owner: parseProcessIdentity((value as Record<string, unknown>).owner) }
  } catch {
    throw new ProtectedStoreCorruptError("protected lock owner is invalid")
  }
}

function writeAll(fd: number, bytes: Buffer, io: ProtectedStoreIo): void {
  let offset = 0
  while (offset < bytes.length) {
    const written = io.writeSync(fd, bytes, offset, bytes.length - offset)
    if (written <= 0) throw new Error("protected store write made no progress")
    offset += written
  }
}

function createLock(lockPath: string, bytes: Buffer, io: ProtectedStoreIo): FileIdentity | null {
  let fd: number | null = null
  try {
    fd = io.openSync(
      lockPath,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
      0o600,
    )
    writeAll(fd, bytes, io)
    return regularIdentity(io.fstatSync(fd), "protected lock")
  } catch (error) {
    if (errorCode(error) === "EEXIST") return null
    throw error
  } finally {
    if (fd !== null) io.closeSync(fd)
  }
}

export function acquireProtectedLock(
  targetPath: string,
  owner: ProcessIdentity,
  proveOwnerState: (owner: ProcessIdentity) => ExactProcessState,
  io: ProtectedStoreIo = nodeProtectedStoreIo,
): ProtectedLock {
  const parsedOwner = parseProcessIdentity(owner)
  const lockPath = `${targetPath}.lock`
  const lockBytes = Buffer.from(canonicalizeJson({ schemaVersion: 1, owner: parsedOwner }), "utf8")
  let acquiredIdentity: FileIdentity | null = null

  for (let attempt = 0; attempt < 2; attempt += 1) {
    acquiredIdentity = createLock(lockPath, lockBytes, io)
    if (acquiredIdentity !== null) break

    const existing = readStableRegularFile(lockPath, io, "protected lock")
    const record = parseLock(existing.bytes)
    const ownerState = proveOwnerState(record.owner)
    if (ownerState.state !== "dead") throw new ProtectedStoreLockedError()

    const currentStats = lstatOptional(lockPath, io)
    if (currentStats === null) continue
    const current = regularIdentity(currentStats, "protected lock")
    if (!identitiesEqual(existing.identity, current)) throw new ProtectedStoreLockedError("protected lock changed during reclaim")
    try {
      io.unlinkSync(lockPath)
    } catch {
      throw new ProtectedStoreLockedError("protected lock could not be reclaimed")
    }
  }
  if (acquiredIdentity === null) throw new ProtectedStoreLockedError("protected lock acquisition raced")

  emitNervesEvent({
    component: "heart",
    event: "heart.runtime_protected_lock_acquired",
    message: "acquired owner-identified protected store lock",
    meta: { targetPath, uid: parsedOwner.uid, pid: parsedOwner.pid },
  })

  const lockIdentity = acquiredIdentity
  let released = false
  const assertHeld = (): void => {
    if (released) throw new ProtectedStoreLockedError("protected lock is already released")
    const currentStats = lstatOptional(lockPath, io)
    if (currentStats === null) throw new ProtectedStoreLockedError("protected lock disappeared")
    const current = regularIdentity(currentStats, "protected lock")
    if (!identitiesEqual(lockIdentity, current)) throw new ProtectedStoreLockedError("protected lock identity changed")
    const record = parseLock(readStableRegularFile(lockPath, io, "protected lock").bytes)
    if (!processIdentityEquals(record.owner, parsedOwner)) throw new ProtectedStoreLockedError("protected lock owner changed")
  }

  return {
    targetPath,
    assertHeld,
    release: () => {
      if (released) return
      released = true
      try {
        const currentStats = lstatOptional(lockPath, io)
        if (currentStats === null) return
        const current = regularIdentity(currentStats, "protected lock")
        if (!identitiesEqual(lockIdentity, current)) return
        const record = parseLock(readStableRegularFile(lockPath, io, "protected lock").bytes)
        if (!processIdentityEquals(record.owner, parsedOwner)) return
        io.unlinkSync(lockPath)
      } catch {
        // A changed lock belongs to another writer; release must fail closed.
      }
    },
  }
}

function decodeProtectedJson<T>(bytes: Buffer, parse: (value: unknown) => T): T {
  try {
    return parse(parseCanonicalJson(bytes))
  } catch {
    throw new ProtectedStoreCorruptError("protected JSON record is corrupt, non-canonical, or schema-invalid")
  }
}

export function readProtectedJson<T>(
  targetPath: string,
  parse: (value: unknown) => T,
  io: ProtectedStoreIo = nodeProtectedStoreIo,
): T {
  return decodeProtectedJson(readStableRegularFile(targetPath, io, "protected JSON record").bytes, parse)
}

function writeProtectedJsonAtomic(
  targetPath: string,
  value: unknown,
  expectedPrior: FileIdentity | null,
  lock: ProtectedLock,
  io: ProtectedStoreIo,
): void {
  const parentPath = path.dirname(targetPath)
  const tempPath = path.join(parentPath, `.${path.basename(targetPath)}.tmp-${randomBytes(16).toString("hex")}`)
  const bytes = Buffer.from(canonicalizeJson(value), "utf8")
  let tempFd: number | null = null
  let renamed = false
  const parent = openRetainedDirectory(parentPath, io)
  try {
    tempFd = io.openSync(
      tempPath,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
      0o600,
    )
    refreshRetainedDirectory(parentPath, parent, io)
    writeAll(tempFd, bytes, io)
    io.fsyncSync(tempFd)
    io.closeSync(tempFd)
    tempFd = null

    lock.assertHeld()
    assertRetainedDirectory(parentPath, parent, io)
    const currentStats = lstatOptional(targetPath, io)
    if (expectedPrior === null) {
      if (currentStats !== null) throw new ProtectedStoreLockedError("protected target appeared during mutation")
    } else {
      if (currentStats === null) throw new ProtectedStoreLockedError("protected target disappeared during mutation")
      const current = regularIdentity(currentStats, "protected JSON record")
      if (!identitiesEqual(expectedPrior, current)) throw new ProtectedStoreLockedError("protected target changed during mutation")
    }

    io.renameSync(tempPath, targetPath)
    renamed = true
    refreshRetainedDirectory(parentPath, parent, io)
    io.fsyncSync(parent.fd)
    assertRetainedDirectory(parentPath, parent, io)
  } finally {
    if (tempFd !== null) {
      try { io.closeSync(tempFd) } catch { /* best effort close before unlink */ }
    }
    if (!renamed) {
      try { io.unlinkSync(tempPath) } catch { /* missing temporary file is already clean */ }
    }
    io.closeSync(parent.fd)
  }
}

export interface ProtectedJsonMutation<T> {
  targetPath: string
  owner: ProcessIdentity
  proveOwnerState(owner: ProcessIdentity): ExactProcessState
  parse(value: unknown): T
  initial: T
  mutate(prior: T): T
  io?: ProtectedStoreIo
}

export function mutateProtectedJson<T>(options: ProtectedJsonMutation<T>): T {
  const io = options.io ?? nodeProtectedStoreIo
  const lock = acquireProtectedLock(options.targetPath, options.owner, options.proveOwnerState, io)
  try {
    const priorStats = lstatOptional(options.targetPath, io)
    const prior = priorStats === null
      ? options.parse(options.initial)
      : decodeProtectedJson(readStableRegularFile(options.targetPath, io, "protected JSON record").bytes, options.parse)
    const expectedPrior = priorStats === null ? null : regularIdentity(priorStats, "protected JSON record")
    const next = options.parse(options.mutate(prior))
    writeProtectedJsonAtomic(options.targetPath, next, expectedPrior, lock, io)
    return next
  } finally {
    lock.release()
  }
}
