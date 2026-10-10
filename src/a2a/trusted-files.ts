import * as fs from "node:fs"
import * as path from "node:path"
import { emitNervesEvent } from "../nerves/runtime"

/**
 * Operator-set state is only honoured when the agent's own process (and anything a prompt-injected model can run
 * through its shell) cannot have written it. The rule is the one sshd calls StrictModes: the file and EVERY directory
 * above it, up to `/`, must be real (no symlinks), owned by the trusted uid (root), and closed to group and other
 * writes. A check on the file's own directory alone is not enough: an agent that owns the parent can rename the
 * root-owned directory away and put one of its own making in its place (rename-then-rebless). Anything that fails reads
 * as "not there", so every consumer fails closed.
 */
export const TRUSTED_UID = 0
let uidOverride: number | undefined
let chainRootOverride: string | undefined
let ownerOverride: ((target: string) => number | undefined) | undefined

/** Only a test runner sets VITEST; the running Butler (and its prompt-injected shell) cannot reach this process's environment. */
const underTestRunner = (): boolean => process.env.VITEST !== undefined

/** Tests run as an ordinary user, so they declare that user trusted. Refused outside a test runner, and ignored there too. */
export function overrideTrustedUidForTests(uid: number | undefined): void {
  if (!underTestRunner()) throw new Error("overrideTrustedUidForTests is for tests only")
  uidOverride = uid
}

/**
 * Tests keep their files under a private temp root whose ancestors (`/tmp`, `/private`) are not the test user's. A test
 * names that root here, and the ancestor walk stops there (the root itself and everything above it are skipped).
 */
export function overrideTrustChainRootForTests(root: string | undefined): void {
  if (!underTestRunner()) throw new Error("overrideTrustChainRootForTests is for tests only")
  chainRootOverride = root
}

/** Tests are not root, so they cannot hand a path to another owner: this reports the owner a test wants for a path (`undefined` keeps the real one). */
export function overrideOwnerForTests(lookup: ((target: string) => number | undefined) | undefined): void {
  if (!underTestRunner()) throw new Error("overrideOwnerForTests is for tests only")
  ownerOverride = lookup
}

const ownerOf = (target: string, stat: fs.Stats): number => (underTestRunner() ? ownerOverride?.(target) : undefined) ?? stat.uid

const effectiveTrustedUid = (): number => (underTestRunner() ? uidOverride : undefined) ?? TRUSTED_UID
const effectiveChainRoot = (): string | undefined => (underTestRunner() ? chainRootOverride : undefined)

const REJECTION_WINDOW_MS = 60_000
const lastRejection = new Map<string, number>()

/** Test hook: the rate limiter is module state. */
export function __resetRejectionRateLimitForTests(): void {
  lastRejection.clear()
}

/** One warn per target and reason per minute: a rejected file is re-read on every inbound message. */
function rejected(target: string, reason: string): void {
  const key = `${target}\u0000${reason}`
  const now = Date.now()
  const last = lastRejection.get(key)
  if (last !== undefined && now - last < REJECTION_WINDOW_MS) return
  lastRejection.set(key, now)
  emitNervesEvent({ level: "warn", component: "senses", event: "senses.a2a_trusted_file_rejected", message: "ignored operator-set state the agent could have written", meta: { target, reason } })
}

type ChainResult = { state: "trusted" } | { state: "missing" } | { state: "untrusted"; reason: string }

/** Every directory from `target` up to `/` (or the test chain root): a real directory, trusted owner, closed to group and other writes. */
function inspectChain(target: string, trustedUid: number): ChainResult {
  const stop = effectiveChainRoot()
  let current = path.resolve(target)
  for (;;) {
    if (stop !== undefined && current === stop) return { state: "trusted" }
    let stat: fs.Stats
    try {
      stat = fs.lstatSync(current)
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ENOENT" || (error as NodeJS.ErrnoException).code === "ENOTDIR"
        ? { state: "missing" }
        : { state: "untrusted", reason: `cannot inspect ${current}` }
    }
    if (stat.isSymbolicLink()) return { state: "untrusted", reason: `${current} is a symlink` }
    if (!stat.isDirectory()) return { state: "untrusted", reason: `${current} is not a directory` }
    if (ownerOf(current, stat) !== trustedUid) return { state: "untrusted", reason: `${current} is not owned by the trusted uid` }
    if ((stat.mode & 0o022) !== 0) return { state: "untrusted", reason: `${current} is writable by group or other` }
    const parent = path.dirname(current)
    if (parent === current) return { state: "trusted" }
    current = parent
  }
}

/** A real directory (no symlink) owned by the trusted uid and closed to group and other writes, with every ancestor up to `/` the same. */
export function isTrustedDirectory(target: string, trustedUid: number = effectiveTrustedUid()): boolean {
  const result = inspectChain(target, trustedUid)
  if (result.state === "trusted") return true
  rejected(target, result.state === "missing" ? "directory does not exist" : result.reason)
  return false
}

/** Same chain check, without the warning: for callers that probe before they decide whether the state is wrong. */
export function inspectTrustedDirectory(target: string, trustedUid: number = effectiveTrustedUid()): ChainResult {
  return inspectChain(target, trustedUid)
}

export type TrustedJson = { state: "trusted"; value: unknown } | { state: "missing" } | { state: "untrusted"; reason: string }

/**
 * Reads a JSON file only if the whole chain above it is trusted and the file actually opened is trusted. The path is
 * opened once with O_NOFOLLOW, then the descriptor itself is checked (regular file, trusted owner, not group- or
 * other-writable) and read, so a rename loop cannot swap a different file in between the check and the read.
 * `missing` means the file or a directory above it does not exist; everything else that fails is `untrusted`.
 */
export function inspectTrustedJson(file: string, trustedUid: number = effectiveTrustedUid()): TrustedJson {
  const chain = inspectChain(path.dirname(file), trustedUid)
  if (chain.state === "missing") return { state: "missing" }
  if (chain.state === "untrusted") {
    rejected(file, chain.reason)
    return chain
  }
  let fd: number | undefined
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
    const stat = fs.fstatSync(fd)
    if (!stat.isFile() || ownerOf(file, stat) !== trustedUid || (stat.mode & 0o022) !== 0) {
      const reason = "file is not a regular file owned by the trusted uid and closed to group and other writes"
      rejected(file, reason)
      return { state: "untrusted", reason }
    }
    return { state: "trusted", value: JSON.parse(fs.readFileSync(fd, "utf8")) as unknown }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { state: "missing" }
    const reason = error instanceof SyntaxError ? "file is not valid JSON" : "file could not be opened without following links"
    rejected(file, reason)
    return { state: "untrusted", reason }
  } finally {
    if (fd !== undefined) fs.closeSync(fd)
  }
}

/** The parsed JSON of a trusted file, or `undefined` for anything else. */
export function readTrustedJson(file: string, trustedUid: number = effectiveTrustedUid()): unknown {
  const result = inspectTrustedJson(file, trustedUid)
  return result.state === "trusted" ? result.value : undefined
}
