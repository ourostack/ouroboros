#!/usr/bin/env node
// The host lock: one holder at a time on a Docker host that eval runs and the Butler's upgrade share (#1760).
//
// The lock is the directory /var/lock/ouro-host.d, made with mkdir (atomic), with owner.json inside naming its holder,
// token, pid, host and expiry. A lock is stale, and safe to break, when its expiry has passed, when its pid is gone
// on this host, or when it has had no readable owner.json for a minute. Taking, breaking and releasing all happen
// inside a short guard (the directory ouro-host.d.guard, also made with mkdir), so a breaker can never remove a lock
// that another process took after the breaker judged it stale. A guard older than 30 seconds belonged to a process
// that died inside it and is broken in turn.
//
// Holders: the eval runs `hold`, which keeps the lock with its own pid for as long as its stdin stays open (its ssh
// session), so a dropped session frees it. butler:ship runs `acquire` and later `release`, and passes the token to
// the upgrade (OURO_HOST_LOCK_TOKEN), which takes the lock over with its own pid (tryAcquire's `adopt`) for as long
// as it runs and hands it back when it exits.
//
// Usage: ouro-host-lock.mjs acquire --holder <name> --ttl <seconds> [--wait <seconds>]
//        ouro-host-lock.mjs hold    --holder <name> --ttl <seconds> [--wait <seconds>]
//        ouro-host-lock.mjs release --token <token>
//        ouro-host-lock.mjs check   --token <token>      (exit 0 only while that token holds a live lock)
//        ouro-host-lock.mjs free-eval                    (eval:stop: frees a lock whose holder starts with "eval")
//        ouro-host-lock.mjs status                       (@@LOCK free, eval <owner> or other <owner>)
// Output lines start with @@LOCK. Exit 3: the lock stayed held for all of --wait. Exit 2: bad usage.
import { randomBytes } from "node:crypto"
import { mkdirSync, readFileSync, realpathSync, renameSync, rmSync, rmdirSync, statSync, writeFileSync } from "node:fs"
import { hostname } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

export const LOCK_DIR = "/var/lock/ouro-host.d"
export const GUARD_STALE_MS = 30_000
export const UNWRITTEN_GRACE_MS = 60_000
const OWNER = "owner.json"

function processAlive(pid) {
  try { process.kill(pid, 0); return true } catch (error) { return error.code === "EPERM" }
}

const defaults = (io = {}) => ({ now: () => Date.now(), host: hostname(), alive: processAlive, guardWaitMs: 5_000, ...io })
const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)

/** The owner record, or { unreadable, ageMs } when the directory exists without a readable one, or null when free. */
export function readOwner(dir, io) {
  let made
  try { made = statSync(dir).mtimeMs } catch { return null }
  try {
    const owner = JSON.parse(readFileSync(join(dir, OWNER), "utf8"))
    if (typeof owner.token === "string" && typeof owner.expiresAt === "string") return owner
  } catch { /* below */ }
  return { unreadable: true, ageMs: defaults(io).now() - made }
}

/** Why this owner no longer holds the lock, or null while it does. */
export function staleReason(owner, io) {
  const { now, host, alive } = defaults(io)
  if (owner.unreadable) return owner.ageMs > UNWRITTEN_GRACE_MS ? `it has had no readable owner for ${Math.round(owner.ageMs / 1000)}s` : null
  if (Date.parse(owner.expiresAt) <= now()) return `it expired at ${owner.expiresAt}`
  if (typeof owner.pid === "number" && owner.host === host && !alive(owner.pid)) return `its process ${owner.pid} on ${host} is gone`
  return null
}

export function describeOwner(owner) {
  if (owner.unreadable) return "an unknown holder (no readable owner yet)"
  return `${owner.holder} (${typeof owner.pid === "number" ? `pid ${owner.pid} ` : ""}on ${owner.host}) until ${owner.expiresAt}`
}

// Moves the stale guard aside (only one rename can win) and removes it, unless what was moved is not the guard that
// was judged stale (another breaker already replaced it with a live one). Identity is inode and mtime together: a
// filesystem such as ext4 can give a guard made right after another was removed the same inode number.
function breakGuard(guard, seen, io) {
  io?.beforeBreak?.()
  const aside = `${guard}.broken-${randomBytes(4).toString("hex")}`
  try { renameSync(guard, aside) } catch { return }
  let moved
  try { moved = statSync(aside) } catch { return }
  if (moved.ino === seen.ino && moved.mtimeMs === seen.mtimeMs) { try { rmdirSync(aside) } catch { /* left */ } return }
  // That was a live guard: stand a fresh one in its place for its holder (who removes it when done), then drop the
  // moved copy. Never rename onto the guard path, which would replace a guard a third process just made.
  try { mkdirSync(guard) } catch { /* someone made one already */ }
  try { rmdirSync(aside) } catch { /* left */ }
}

function withGuard(dir, io, work) {
  const guard = `${dir}.guard`
  const { now, guardWaitMs } = defaults(io)
  const deadline = Date.now() + guardWaitMs
  for (;;) {
    try { mkdirSync(guard); break } catch (error) {
      if (error.code !== "EEXIST") throw error
    }
    let seen
    try { seen = statSync(guard) } catch { continue }
    if (now() - seen.mtimeMs > GUARD_STALE_MS) { breakGuard(guard, seen, io); continue }
    if (Date.now() >= deadline) throw new Error(`the host lock's guard ${guard} is busy`)
    sleepSync(10)
  }
  try { return work() } finally { try { rmdirSync(guard) } catch (error) { if (error.code !== "ENOENT") throw error } }
}

/**
 * Takes the lock if it is free or stale. With `adopt`, a process that was handed a live lock's token takes it over
 * with its own pid and a fresh expiry, keeping the token. { acquired: true, token, owner, adopted?, broke?,
 * staleBecause? } or { acquired: false, owner }.
 */
export function tryAcquire(dir, { holder, ttlMs, pid, adopt }, io) {
  const { now, host } = defaults(io)
  return withGuard(dir, io, () => {
    let broke
    let staleBecause
    const current = readOwner(dir, io)
    if (current) {
      staleBecause = staleReason(current, io)
      if (!staleBecause && adopt && current.token === adopt) {
        const owner = { ...current, holder, pid: pid ?? null, host, expiresAt: new Date(now() + ttlMs).toISOString() }
        writeFileSync(join(dir, OWNER), `${JSON.stringify(owner)}\n`, { mode: 0o644 })
        return { acquired: true, token: adopt, owner, adopted: true }
      }
      if (!staleBecause) return { acquired: false, owner: current }
      broke = current
      rmSync(dir, { recursive: true, force: true })
    }
    mkdirSync(dir, { mode: 0o755 })
    const token = randomBytes(16).toString("hex")
    const owner = { holder, token, pid: pid ?? null, host, acquiredAt: new Date(now()).toISOString(), expiresAt: new Date(now() + ttlMs).toISOString() }
    writeFileSync(join(dir, OWNER), `${JSON.stringify(owner)}\n`, { mode: 0o644 })
    return { acquired: true, token, owner, ...(broke ? { broke, staleBecause } : {}) }
  })
}

/** Gives a lock this token holds back with no pid and a fresh expiry; creates nothing when it no longer holds it. */
export function handBack(dir, token, { holder, ttlMs }, io) {
  const { now } = defaults(io)
  return withGuard(dir, io, () => {
    const current = readOwner(dir, io)
    if (!current || current.token !== token) return false
    writeFileSync(join(dir, OWNER), `${JSON.stringify({ ...current, holder, pid: null, expiresAt: new Date(now() + ttlMs).toISOString() })}\n`, { mode: 0o644 })
    return true
  })
}

/** Frees the lock if this token holds it; true when it did. */
export function release(dir, token, io) {
  return withGuard(dir, io, () => {
    const current = readOwner(dir, io)
    if (!current || current.token !== token) return false
    rmSync(dir, { recursive: true, force: true })
    return true
  })
}

// Eval runs and interview batches take the lock only under a holder starting with "eval" (their --host-lock checks it).
const isEval = (owner) => !owner.unreadable && typeof owner.holder === "string" && owner.holder.startsWith("eval")

/**
 * Where the lock stands for `npm run eval:stop`: "free", "eval" (an eval run or interview batch holds it), or "other"
 * (a Butler upgrade or rollback, a person's manual hold, or an owner not written yet). A stale lock counts as free.
 */
export function stopStatus(dir, io) {
  const current = readOwner(dir, io)
  if (!current || staleReason(current, io)) return { state: "free" }
  return { state: isEval(current) ? "eval" : "other", owner: current }
}

/**
 * Frees the lock for `npm run eval:stop` when an eval holds it, whatever its token; never anyone else's, such as a
 * Butler upgrade's or a person's manual hold. { freed, owner? }.
 */
export function freeEval(dir, io) {
  return withGuard(dir, io, () => {
    const current = readOwner(dir, io)
    if (!current || !isEval(current)) return { freed: false, ...(current ? { owner: current } : {}) }
    rmSync(dir, { recursive: true, force: true })
    return { freed: true, owner: current }
  })
}

/** True while this token holds a lock that is not stale. */
export function heldBy(dir, token, io) {
  const current = readOwner(dir, io)
  return Boolean(current && current.token === token && !staleReason(current, io))
}

/** The live holder that is not this token, or null when the way is clear for it. */
export function blocker(dir, token, io) {
  const current = readOwner(dir, io)
  if (!current || (token && current.token === token) || staleReason(current, io)) return null
  return current
}

function parse(argv) {
  const [command, ...rest] = argv
  const opts = {}
  for (let i = 0; i < rest.length; i += 2) opts[String(rest[i]).replace(/^--/, "")] = rest[i + 1]
  const needs = { acquire: ["holder", "ttl"], hold: ["holder", "ttl"], release: ["token"], check: ["token"], "free-eval": [], status: [] }[command]
  if (!needs || needs.some((key) => !opts[key])) return null
  return { command, ...opts }
}

async function takeWaiting(dir, args, pid, over = () => false) {
  const pollMs = Number(process.env.OURO_HOST_LOCK_POLL_MS ?? 5_000)
  const until = Date.now() + Number(args.wait ?? 0) * 1000
  let said = false
  for (;;) {
    const got = tryAcquire(dir, { holder: args.holder, ttlMs: Number(args.ttl) * 1000, pid })
    if (got.acquired) {
      if (got.broke) console.log(`@@LOCK broke ${describeOwner(got.broke)}: ${got.staleBecause}`)
      console.log(`@@LOCK acquired ${got.token}`)
      return got.token
    }
    if (Date.now() >= until || over()) { console.log(`@@LOCK held ${describeOwner(got.owner)}`); return null }
    if (!said) { console.log(`@@LOCK waiting ${describeOwner(got.owner)}`); said = true }
    await new Promise((resolve) => setTimeout(resolve, pollMs))
  }
}

export async function main(argv, dir = process.env.OURO_HOST_LOCK_DIR || LOCK_DIR) {
  const args = parse(argv)
  if (!args) { console.error("usage: ouro-host-lock.mjs acquire|hold --holder <name> --ttl <seconds> [--wait <seconds>] | release|check --token <token> | free-eval | status"); return 2 }
  if (args.command === "check") return heldBy(dir, args.token) ? 0 : 1
  if (args.command === "status") {
    const { state, owner } = stopStatus(dir)
    console.log(`@@LOCK ${state}${owner ? ` ${describeOwner(owner)}` : ""}`)
    return 0
  }
  if (args.command === "free-eval") {
    const { freed, owner } = freeEval(dir)
    console.log(freed ? `@@LOCK freed ${describeOwner(owner)}` : owner ? `@@LOCK kept ${describeOwner(owner)}` : "@@LOCK free")
    return 0
  }
  if (args.command === "release") { console.log(release(dir, args.token) ? "@@LOCK released" : "@@LOCK not-held"); return 0 }
  if (args.command === "acquire") return (await takeWaiting(dir, args, null)) ? 0 : 3
  // hold: keep it until the session that asked for it ends. Listen before taking it, so an early signal still releases.
  const ended = new Promise((resolve) => {
    process.stdin.on("end", resolve).on("close", resolve).on("error", resolve).resume()
    for (const signal of ["SIGTERM", "SIGHUP", "SIGINT"]) process.on(signal, resolve)
  })
  let over = false
  void ended.then(() => { over = true })
  const token = await takeWaiting(dir, args, process.pid, () => over)
  if (!token) return 3
  await ended
  console.log(release(dir, token) ? "@@LOCK released" : "@@LOCK not-held")
  return 0
}

if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) main(process.argv.slice(2)).then((code) => process.exit(code), (error) => { console.error(error); process.exit(1) })
