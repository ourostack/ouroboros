import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import Database from "better-sqlite3"

import { afterEach, describe, expect, it, vi } from "vitest"
import { D004_INODE_A, D004_INODE_B, d004IdentityKey, installD004StatMetadata } from "../fixtures/d004-native-stats"

vi.mock("node:fs", async (original) => ({ ...await original<typeof import("node:fs")>() }))

const roots: string[] = []

function makeSession(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ouro-session-transaction-"))
  roots.push(root)
  const sessionPath = path.join(root, "session.json")
  fs.writeFileSync(sessionPath, JSON.stringify({ version: 2, marker: "base" }))
  return sessionPath
}

function writeLock(sessionPath: string, content?: unknown): string {
  const lockPath = `${sessionPath}.turn.lock`
  const database = new Database(lockPath)
  database.exec(`
    CREATE TABLE IF NOT EXISTS session_turn_lease (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      pid INTEGER NOT NULL,
      owner_id TEXT NOT NULL,
      owner_token TEXT NOT NULL
    )
  `)
  database.prepare(`DELETE FROM session_turn_lease`).run()
  if (content && typeof content === "object") {
    const record = content as { pid?: unknown; ownerId?: unknown; ownerToken?: unknown; bootIdentity?: unknown; processStartedAt?: unknown }
    if (record.bootIdentity !== undefined || record.processStartedAt !== undefined) {
      database.exec(`ALTER TABLE session_turn_lease ADD COLUMN boot_identity TEXT`)
      database.exec(`ALTER TABLE session_turn_lease ADD COLUMN process_started_at TEXT`)
      database.prepare(`
        INSERT INTO session_turn_lease (singleton, pid, owner_id, owner_token, boot_identity, process_started_at) VALUES (1, ?, ?, ?, ?, ?)
      `).run(record.pid, record.ownerId, record.ownerToken, record.bootIdentity, record.processStartedAt)
    } else {
      database.prepare(`
        INSERT INTO session_turn_lease (singleton, pid, owner_id, owner_token) VALUES (1, ?, ?, ?)
      `).run(record.pid, record.ownerId, record.ownerToken)
    }
  }
  database.close()
  return lockPath
}

function readLock(sessionPath: string): { pid: number; ownerId: string; ownerToken: string; bootIdentity: string | null; processStartedAt: string | null } | null {
  const database = new Database(`${sessionPath}.turn.lock`)
  try {
    const row = database.prepare(`
      SELECT pid, owner_id, owner_token, boot_identity, process_started_at FROM session_turn_lease WHERE singleton = 1
    `).get() as { pid: number; owner_id: string; owner_token: string; boot_identity: string | null; process_started_at: string | null } | undefined
    return row ? { pid: row.pid, ownerId: row.owner_id, ownerToken: row.owner_token, bootIdentity: row.boot_identity, processStartedAt: row.process_started_at } : null
  } finally {
    database.close()
  }
}

function replaceLock(sessionPath: string, content: { pid: number; ownerId: string; ownerToken: string; bootIdentity?: string; processStartedAt?: string }): void {
  const database = new Database(`${sessionPath}.turn.lock`)
  try {
    database.prepare(`
      UPDATE session_turn_lease SET pid = ?, owner_id = ?, owner_token = ?,
        boot_identity = COALESCE(?, boot_identity), process_started_at = COALESCE(?, process_started_at)
      WHERE singleton = 1
    `).run(content.pid, content.ownerId, content.ownerToken, content.bootIdentity ?? null, content.processStartedAt ?? null)
  } finally {
    database.close()
  }
}

async function subject(): Promise<any> {
  return import("../../mind/session-transaction")
}

function childScript(): string {
  return String.raw`
const ts = require("typescript")
require.extensions[".ts"] = (module, filename) => {
  const source = require("fs").readFileSync(filename, "utf8")
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    fileName: filename,
  }).outputText
  module._compile(output, filename)
}
const runtime = require(process.argv[1])
const fs = require("fs")
const sessionPath = process.argv[2]
const mode = process.argv[3]
;(async () => {
  const lease = await runtime.acquireSessionTurnLease(sessionPath, {
    ownerId: "child-owner",
    timeoutMs: 1000,
    pollIntervalMs: 1,
  })
  if (mode === "reclaim") {
    const effectsPath = process.argv[4]
    fs.appendFileSync(effectsPath, "ENTER:" + process.pid + "\n")
    await new Promise((resolve) => setTimeout(resolve, 30))
    fs.appendFileSync(effectsPath, "EXIT:" + process.pid + "\n")
    await lease.release()
    process.stdout.write("RECLAIMED\n")
    return
  }
  if (mode === "hold") {
    process.stdout.write("READY\n")
    process.stdin.resume()
    process.stdin.once("end", async () => {
      await lease.release()
      process.stdout.write("RELEASED\n")
    })
    return
  }
  try {
    runtime.writeSessionTransaction(sessionPath, { version: 2, marker: "child-stale" }, {
      lease,
      expectedRevision: process.argv[4],
    })
    process.stdout.write("WROTE\n")
  } catch (error) {
    process.stdout.write("STALE:" + error.name + "\n")
  } finally {
    await lease.release()
  }
})().catch((error) => { process.stderr.write(String(error.stack || error)); process.exitCode = 1 })
`
}

function waitForOutput(child: ReturnType<typeof spawn>, needle: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let output = ""
    child.stdout!.on("data", (chunk) => {
      output += String(chunk)
      if (output.includes(needle)) resolve(output)
    })
    child.stderr!.on("data", (chunk) => reject(new Error(String(chunk))))
    child.once("exit", (code) => {
      if (!output.includes(needle)) reject(new Error(`child exited ${code}: ${output}`))
    })
  })
}

function waitForCleanExit(child: ReturnType<typeof spawn>): Promise<void> {
  return new Promise((resolve, reject) => {
    child.once("error", reject)
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`child exited ${code}`)))
  })
}

afterEach(() => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

describe("cross-process session turn transaction contract", () => {
  it("serializes whole turns before session load and provider invocation", async () => {
    const { withSessionTurnLease } = await subject()
    const sessionPath = makeSession()
    const firstEntered = Promise.withResolvers<void>()
    const releaseFirst = Promise.withResolvers<void>()
    const order: string[] = []

    const first = withSessionTurnLease(sessionPath, async () => {
      order.push("first:load")
      firstEntered.resolve()
      await releaseFirst.promise
      order.push("first:deliver")
    }, { ownerId: "owner-a", timeoutMs: 1_000, pollIntervalMs: 1 })
    await firstEntered.promise

    const second = withSessionTurnLease(sessionPath, async () => {
      order.push("second:load")
      order.push("second:provider")
    }, { ownerId: "owner-b", timeoutMs: 1_000, pollIntervalMs: 1 })

    await new Promise((resolve) => setImmediate(resolve))
    expect(order).toEqual(["first:load"])
    releaseFirst.resolve()
    await Promise.all([first, second])
    expect(order).toEqual(["first:load", "first:deliver", "second:load", "second:provider"])
  })

  it("times out a contender without loading, invoking a provider, mutating, or delivering", async () => {
    const { acquireSessionTurnLease, withSessionTurnLease, SessionTurnBusyError } = await subject()
    const sessionPath = makeSession()
    const held = await acquireSessionTurnLease(sessionPath, { ownerId: "owner-a", timeoutMs: 20, pollIntervalMs: 1 })
    const callback = vi.fn()

    await expect(withSessionTurnLease(sessionPath, callback, {
      ownerId: "owner-b",
      timeoutMs: 5,
      pollIntervalMs: 1,
    })).rejects.toBeInstanceOf(SessionTurnBusyError)
    expect(callback).not.toHaveBeenCalled()
    await held.release()
  })

  it("retries transient SQLite writer contention and maps it to immediate busy", async () => {
    const { acquireSessionTurnLease, withImmediateSessionTurnLease } = await subject()
    const asyncSessionPath = makeSession()
    writeLock(asyncSessionPath)
    const asyncBlocker = new Database(`${asyncSessionPath}.turn.lock`)
    asyncBlocker.exec("BEGIN EXCLUSIVE")
    const pending = acquireSessionTurnLease(asyncSessionPath, { timeoutMs: 100, pollIntervalMs: 1 })
    asyncBlocker.exec("COMMIT")
    asyncBlocker.close()
    const lease = await pending
    await lease.release()

    const immediateSessionPath = makeSession()
    writeLock(immediateSessionPath)
    const immediateBlocker = new Database(`${immediateSessionPath}.turn.lock`)
    immediateBlocker.exec("BEGIN EXCLUSIVE")
    expect(() => withImmediateSessionTurnLease(immediateSessionPath, () => undefined)).toThrow(/busy/i)
    immediateBlocker.exec("COMMIT")
    immediateBlocker.close()
  })

  it("supports explicit same-owner reentrancy without releasing the outer lease early", async () => {
    const { acquireSessionTurnLease } = await subject()
    const sessionPath = makeSession()
    const outer = await acquireSessionTurnLease(sessionPath, { ownerId: "owner-a", timeoutMs: 20, pollIntervalMs: 1 })
    const nested = await acquireSessionTurnLease(sessionPath, {
      ownerId: outer.ownerId,
      ownerToken: outer.ownerToken,
      timeoutMs: 20,
      pollIntervalMs: 1,
    })

    await nested.release()
    await expect(acquireSessionTurnLease(sessionPath, {
      ownerId: "owner-b",
      timeoutMs: 5,
      pollIntervalMs: 1,
    })).rejects.toMatchObject({ name: "SessionTurnBusyError" })
    await outer.release()
    const next = await acquireSessionTurnLease(sessionPath, { ownerId: "owner-b", timeoutMs: 20, pollIntervalMs: 1 })
    await next.release()
  })

  it("rejects a forged reentrant owner token", async () => {
    const { acquireSessionTurnLease } = await subject()
    const sessionPath = makeSession()
    const held = await acquireSessionTurnLease(sessionPath, { ownerId: "owner-a", timeoutMs: 20, pollIntervalMs: 1 })

    await expect(acquireSessionTurnLease(sessionPath, {
      ownerId: held.ownerId,
      ownerToken: "forged",
      timeoutMs: 5,
      pollIntervalMs: 1,
    })).rejects.toMatchObject({ name: "SessionTurnBusyError" })
    await held.release()
  })

  it("steals only a dead-process lease and records the stale owner", async () => {
    const { acquireSessionTurnLease } = await subject()
    const sessionPath = makeSession()
    writeLock(sessionPath, { pid: 999_999_999, ownerId: "dead", ownerToken: "dead-token" })
    const onStaleLease = vi.fn()

    const lease = await acquireSessionTurnLease(sessionPath, {
      ownerId: "owner-a",
      timeoutMs: 20,
      pollIntervalMs: 1,
      isProcessAlive: () => false,
      onStaleLease,
    })

    expect(onStaleLease).toHaveBeenCalledWith(expect.objectContaining({ pid: 999_999_999, ownerId: "dead" }))
    await lease.release()
  })

  it("recovers a reused live PID only when its persisted process incarnation differs", async () => {
    const { acquireSessionTurnLease, withImmediateSessionTurnLease } = await subject()
    const asyncPath = makeSession()
    writeLock(asyncPath, { pid: process.pid, ownerId: "previous-container", ownerToken: "old-token", bootIdentity: "boot-a", processStartedAt: "linux:old" })
    const probes = { isProcessAlive: () => true, getBootIdentity: () => "boot-a", getProcessStartedAt: () => "linux:current" }

    const lease = await acquireSessionTurnLease(asyncPath, { ...probes, ownerId: "current-container", ownerToken: "new-token", timeoutMs: 20, pollIntervalMs: 1 })
    await lease.release()

    const immediatePath = makeSession()
    writeLock(immediatePath, { pid: process.pid, ownerId: "previous-container", ownerToken: "old-token", bootIdentity: "boot-a", processStartedAt: "linux:old" })
    expect(withImmediateSessionTurnLease(immediatePath, () => "recovered", probes)).toBe("recovered")
  })

  it("never steals a live lease from the same process incarnation", async () => {
    const { acquireSessionTurnLease, withImmediateSessionTurnLease } = await subject()
    const sessionPath = makeSession()
    const probes = { isProcessAlive: () => true, getBootIdentity: () => "boot-a", getProcessStartedAt: () => "linux:current" }
    writeLock(sessionPath, { pid: process.pid, ownerId: "concurrent", ownerToken: "held-token", bootIdentity: "boot-a", processStartedAt: "linux:current" })

    await expect(acquireSessionTurnLease(sessionPath, { ...probes, timeoutMs: 2, pollIntervalMs: 1 })).rejects.toMatchObject({ name: "SessionTurnBusyError" })
    expect(() => withImmediateSessionTurnLease(sessionPath, () => undefined, probes)).toThrow(/busy/i)
  })

  it("recovers identity-bound rows from an earlier boot and fails closed when a live identity cannot be probed", async () => {
    const { acquireSessionTurnLease } = await subject()
    const oldBootPath = makeSession()
    writeLock(oldBootPath, { pid: 900, ownerId: "old-boot", ownerToken: "old-token", bootIdentity: "boot-old", processStartedAt: "linux:10" })
    const recovered = await acquireSessionTurnLease(oldBootPath, {
      getBootIdentity: () => "boot-current",
      getProcessStartedAt: () => "linux:10",
      isProcessAlive: () => true,
      timeoutMs: 20,
      pollIntervalMs: 1,
    })
    await recovered.release()

    const unknownPath = makeSession()
    writeLock(unknownPath, { pid: 901, ownerId: "unknown", ownerToken: "unknown-token", bootIdentity: "boot-current", processStartedAt: "linux:11" })
    await expect(acquireSessionTurnLease(unknownPath, {
      getBootIdentity: () => "boot-current",
      getProcessStartedAt: (pid) => pid === process.pid ? "linux:current" : null,
      isProcessAlive: () => true,
      timeoutMs: 2,
      pollIntervalMs: 1,
    })).rejects.toMatchObject({ name: "SessionTurnBusyError" })
  })

  it("keeps a live identity-less same-PID row busy", async () => {
    const { acquireSessionTurnLease } = await subject()
    const sessionPath = makeSession()
    writeLock(sessionPath, { pid: process.pid, ownerId: "legacy-container", ownerToken: "legacy-token" })

    await expect(acquireSessionTurnLease(sessionPath, {
      getBootIdentity: () => "boot-a",
      getProcessStartedAt: () => "linux:current",
      isProcessAlive: () => true,
      timeoutMs: 2,
      pollIntervalMs: 1,
    })).rejects.toMatchObject({ name: "SessionTurnBusyError" })
  })

  it("reclaims and migrates an identity-less row only when its PID is dead", async () => {
    const { acquireSessionTurnLease } = await subject()
    const sessionPath = makeSession()
    writeLock(sessionPath, { pid: 999_999_999, ownerId: "legacy-container", ownerToken: "legacy-token" })
    const onStaleLease = vi.fn()

    const lease = await acquireSessionTurnLease(sessionPath, {
      getBootIdentity: () => "boot-a",
      getProcessStartedAt: () => "linux:current",
      isProcessAlive: () => false,
      onStaleLease,
      timeoutMs: 20,
      pollIntervalMs: 1,
    })

    expect(onStaleLease).toHaveBeenCalledWith(expect.objectContaining({ ownerId: "legacy-container" }))
    expect(readLock(sessionPath)).toMatchObject({ bootIdentity: "boot-a", processStartedAt: "linux:current" })
    await lease.release()
  })

  it("does not report ownership when the stale-row compare-and-swap changes no row", async () => {
    const { acquireSessionTurnLease } = await subject()
    const sessionPath = makeSession()
    writeLock(sessionPath, { pid: 999_999_999, ownerId: "dead", ownerToken: "dead-token" })
    const database = new Database(`${sessionPath}.turn.lock`)
    database.exec(`CREATE TRIGGER suppress_lease_update BEFORE UPDATE ON session_turn_lease BEGIN SELECT RAISE(IGNORE); END`)
    database.close()
    const onStaleLease = vi.fn()

    await expect(acquireSessionTurnLease(sessionPath, {
      isProcessAlive: () => false,
      onStaleLease,
      timeoutMs: 2,
      pollIntervalMs: 1,
    })).rejects.toMatchObject({ name: "SessionTurnBusyError" })
    expect(onStaleLease).not.toHaveBeenCalled()
    expect(readLock(sessionPath)).toMatchObject({ ownerId: "dead", ownerToken: "dead-token" })
  })

  it("fails closed when either part of the acquiring process identity is unavailable", async () => {
    const { acquireSessionTurnLease, withImmediateSessionTurnLease } = await subject()
    await expect(acquireSessionTurnLease(makeSession(), {
      getBootIdentity: () => "",
      getProcessStartedAt: () => "linux:current",
    })).rejects.toThrow(/process identity is unavailable/i)
    expect(() => withImmediateSessionTurnLease(makeSession(), () => undefined, {
      getBootIdentity: () => "boot-a",
      getProcessStartedAt: () => null,
    })).toThrow(/process identity is unavailable/i)
  })

  it("binds a lease to one canonical session path", async () => {
    const { acquireSessionTurnLease, readSessionTransaction } = await subject()
    const sessionPath = makeSession()
    const otherPath = makeSession()
    const lease = await acquireSessionTurnLease(sessionPath, { ownerId: "owner-a", timeoutMs: 20, pollIntervalMs: 1 })

    expect(() => readSessionTransaction(otherPath, lease)).toThrow(/session path/i)
    await lease.release()
  })

  it("uses revision CAS so simultaneous writers from one base cannot both commit", async () => {
    const { acquireSessionTurnLease, readSessionTransaction, writeSessionTransaction } = await subject()
    const sessionPath = makeSession()
    const lease = await acquireSessionTurnLease(sessionPath, { ownerId: "owner-a", timeoutMs: 20, pollIntervalMs: 1 })
    const base = readSessionTransaction(sessionPath, lease)

    const firstRevision = writeSessionTransaction(sessionPath, { version: 2, marker: "first" }, {
      lease,
      expectedRevision: base.revision,
    })
    expect(firstRevision).toMatch(/^[a-f0-9]{64}$/)
    expect(() => writeSessionTransaction(sessionPath, { version: 2, marker: "stale" }, {
      lease,
      expectedRevision: base.revision,
    })).toThrow(/revision/i)
    expect(JSON.parse(fs.readFileSync(sessionPath, "utf8"))).toMatchObject({ marker: "first" })
    await lease.release()
  })

  it("leaves the old session intact when crashing before atomic rename", async () => {
    const { acquireSessionTurnLease, readSessionTransaction, writeSessionTransaction } = await subject()
    const sessionPath = makeSession()
    const lease = await acquireSessionTurnLease(sessionPath, { ownerId: "owner-a", timeoutMs: 20, pollIntervalMs: 1 })
    const base = readSessionTransaction(sessionPath, lease)

    expect(() => writeSessionTransaction(sessionPath, { version: 2, marker: "new" }, {
      lease,
      expectedRevision: base.revision,
      hooks: { beforeRename: () => { throw new Error("crash before rename") } },
    })).toThrow("crash before rename")
    expect(JSON.parse(fs.readFileSync(sessionPath, "utf8"))).toMatchObject({ marker: "base" })
    expect(fs.readdirSync(path.dirname(sessionPath)).filter((name) => name.includes(".tmp-"))).toEqual([])
    await lease.release()
  })

  it.each([false, true])("excludes a real child process, then rejects its stale cross-process revision (confined=%s)", async (confined) => {
    const { acquireSessionTurnLease, readSessionTransaction, writeSessionTransaction } = await subject()
    const created = makeSession()
    const sessionPath = confined ? fs.realpathSync(created) : created
    const confinement = confined ? { confinementRoot: path.dirname(sessionPath) } : {}
    const modulePath = path.resolve(__dirname, "../../mind/session-transaction.ts")
    const child = spawn(process.execPath, ["-e", childScript(), modulePath, sessionPath, "hold"], {
      stdio: ["pipe", "pipe", "pipe"],
    })
    await waitForOutput(child, "READY")

    await expect(acquireSessionTurnLease(sessionPath, {
      ...confinement,
      ownerId: "parent-owner",
      timeoutMs: 10,
      pollIntervalMs: 1,
    })).rejects.toMatchObject({ name: "SessionTurnBusyError" })
    const released = waitForOutput(child, "RELEASED")
    const childExit = waitForCleanExit(child)
    child.stdin!.end()
    await released
    await childExit

    const parentLease = await acquireSessionTurnLease(sessionPath, { ...confinement, ownerId: "parent-owner", timeoutMs: 100, pollIntervalMs: 1 })
    const base = readSessionTransaction(sessionPath, parentLease)
    writeSessionTransaction(sessionPath, { version: 2, marker: "parent" }, { lease: parentLease, expectedRevision: base.revision })
    await parentLease.release()

    const staleChild = spawn(process.execPath, ["-e", childScript(), modulePath, sessionPath, "stale-write", base.revision], {
      stdio: ["ignore", "pipe", "pipe"],
    })
    const staleExit = waitForCleanExit(staleChild)
    const staleOutput = await waitForOutput(staleChild, "STALE:")
    await staleExit
    expect(staleOutput).toContain("STALE:")
    expect(JSON.parse(fs.readFileSync(sessionPath, "utf8"))).toMatchObject({ marker: "parent" })
  })
})

describe("A003 confined session transaction owner", () => {
      function fixture() {
        const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "a003-owner-")))
        roots.push(root)
        const confinementRoot = path.join(root, "sessions")
        const parent = path.join(confinementRoot, "ari", "telegram")
        fs.mkdirSync(parent, { recursive: true, mode: 0o700 })
        const sessionPath = path.join(parent, "owner.json")
        fs.writeFileSync(sessionPath, '{"version":2,"marker":"base"}', { mode: 0o600 })
        return { root, confinementRoot, parent, sessionPath }
      }

      function snapshot(root: string): Record<string, string> {
        const result: Record<string, string> = {}
        const walk = (dir: string): void => {
          for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const file = path.join(dir, entry.name)
            if (entry.isDirectory()) walk(file)
            else if (entry.isFile()) result[path.relative(root, file)] = createHash("sha256").update(fs.readFileSync(file)).digest("hex")
            else result[path.relative(root, file)] = `link:${fs.readlinkSync(file)}`
          }
        }
        walk(root)
        return result
      }

      describe("D004 exact native identity consumers", () => {
        async function directoryPair(original: string, replacement: string, coordinate: "ino" | "dev" = "ino") {
          const native = await vi.importActual<typeof import("node:fs")>("node:fs")
          const first = native.lstatSync(original, { bigint: true })
          const second = native.lstatSync(replacement, { bigint: true })
          expect(d004IdentityKey(first)).not.toBe(d004IdentityKey(second))
          const identities = new Map([
            [d004IdentityKey(first), coordinate === "ino" ? { dev: 43n, ino: D004_INODE_A } : { dev: D004_INODE_A, ino: 7n }],
            [d004IdentityKey(second), coordinate === "ino" ? { dev: 43n, ino: D004_INODE_B } : { dev: D004_INODE_B, ino: 7n }],
          ])
          installD004StatMetadata(fs, (physical) => identities.get(d004IdentityKey(physical)))
          return native
        }

        it("reports faithful Number and BigInt metadata while directory I/O remains real", async () => {
          const f = fixture()
          const other = path.join(f.root, "other")
          fs.mkdirSync(other, { mode: 0o700 })
          const native = await directoryPair(f.parent, other)
          const first = fs.lstatSync(f.parent)
          const second = fs.lstatSync(other)
          expect(first.ino).toBe(second.ino)
          expect(Number.isSafeInteger(first.ino)).toBe(false)
          expect(first.isDirectory()).toBe(true)
          expect(first.isSymbolicLink()).toBe(false)
          expect(first.mode).toBe(native.lstatSync(f.parent).mode)
          expect(fs.lstatSync(f.parent, { bigint: true }).ino).toBe(D004_INODE_A)
          expect(fs.lstatSync(other, { bigint: true }).ino).toBe(D004_INODE_B)
          expect(typeof fs.lstatSync(other, { bigint: true }).mode).toBe("bigint")
          expect(fs.readdirSync(f.parent)).toContain("owner.json")
        })

        it.each([D004_INODE_A, D004_INODE_B])("keeps stable large identity %s valid through async/immediate transactions and JSON", async (baseIdentity) => {
          const f = fixture()
          const tx = await subject()
          installD004StatMetadata(fs, (physical) => ({
            dev: baseIdentity + physical.dev * 4n,
            ino: baseIdentity + physical.ino * 4n,
          }))
          await tx.withSessionTurnLease(f.sessionPath, async (lease: any) => {
            expect(Object.keys(lease).sort()).toEqual(["ownerId", "ownerToken", "release", "sessionPath"])
            const before = tx.readSessionTransaction(f.sessionPath, lease)
            const revision = tx.writeSessionTransaction(f.sessionPath, { version: 2, marker: "large" }, { lease, expectedRevision: before.revision })
            const nested = await tx.acquireSessionTurnLease(f.sessionPath, { ownerId: lease.ownerId, ownerToken: lease.ownerToken })
            expect(tx.readSessionTransaction(f.sessionPath, nested).revision).toBe(revision)
            await nested.release()
            expect(tx.withImmediateSessionTurnLease(f.sessionPath, (inner: any) => {
              expect(inner).toBe(lease)
              return tx.readSessionTransaction(f.sessionPath, inner).value
            })).toEqual({ version: 2, marker: "large" })
            expect(() => JSON.stringify({ lease, snapshot: tx.readSessionTransaction(f.sessionPath, lease) })).not.toThrow()
          }, { confinementRoot: f.confinementRoot })
          expect(readLock(f.sessionPath)).toBeNull()
          tx.withImmediateSessionTurnLease(f.sessionPath, (lease: any) => {
            const before = tx.readSessionTransaction(f.sessionPath, lease)
            tx.writeSessionTransaction(f.sessionPath, { marker: "immediate" }, { lease, expectedRevision: before.revision })
            expect(tx.readSessionTransaction(f.sessionPath, lease).value).toEqual({ marker: "immediate" })
            tx.deleteSessionTransaction(f.sessionPath, lease)
            expect(tx.readSessionTransaction(f.sessionPath, lease).value).toBeNull()
          }, { confinementRoot: f.confinementRoot })
          expect(fs.existsSync(f.sessionPath)).toBe(false)
          expect(readLock(f.sessionPath)).toBeNull()
        })

        it("keeps a large-identity confined parent interoperable with an ordinary real child lease and CAS", async () => {
          const f = fixture()
          const tx = await subject()
          installD004StatMetadata(fs, (physical) => ({
            dev: D004_INODE_B + physical.dev * 4n,
            ino: D004_INODE_B + physical.ino * 4n,
          }))
          const modulePath = path.resolve(__dirname, "../../mind/session-transaction.ts")
          const child = spawn(process.execPath, ["-e", childScript(), modulePath, f.sessionPath, "hold"], { stdio: ["pipe", "pipe", "pipe"] })
          await waitForOutput(child, "READY")
          try {
            await expect(tx.acquireSessionTurnLease(f.sessionPath, { confinementRoot: f.confinementRoot, timeoutMs: 10, pollIntervalMs: 1 })).rejects.toBeInstanceOf(tx.SessionTurnBusyError)
          } finally {
            const released = waitForOutput(child, "RELEASED")
            const exited = waitForCleanExit(child)
            child.stdin!.end()
            await released
            await exited
          }
          let beforeRevision = ""
          await tx.withSessionTurnLease(f.sessionPath, async (lease: any) => {
            beforeRevision = tx.readSessionTransaction(f.sessionPath, lease).revision
            tx.writeSessionTransaction(f.sessionPath, { marker: "large-parent" }, { lease, expectedRevision: beforeRevision })
          }, { confinementRoot: f.confinementRoot })
          const stale = spawn(process.execPath, ["-e", childScript(), modulePath, f.sessionPath, "stale-write", beforeRevision], { stdio: ["ignore", "pipe", "pipe"] })
          const exited = waitForCleanExit(stale)
          expect(await waitForOutput(stale, "STALE:")).toContain("STALE:")
          await exited
          expect(JSON.parse(fs.readFileSync(f.sessionPath, "utf8"))).toEqual({ marker: "large-parent" })
        })

        it.each([false, true])("refuses adjacent large directory identity during real lease wait (foreign database=%s)", async (existing) => {
          const f = fixture()
          const tx = await subject()
          await tx.withSessionTurnLease(f.sessionPath, async () => undefined)
          const foreign = path.join(f.root, "foreign")
          fs.cpSync(f.parent, foreign, { recursive: true })
          if (!existing) fs.unlinkSync(path.join(foreign, "owner.json.turn.lock"))
          await directoryPair(f.parent, foreign)
          const before = snapshot(foreign)
          const blocker = await tx.acquireSessionTurnLease(f.sessionPath)
          const entered = vi.fn()
          const pending = tx.withSessionTurnLease(f.sessionPath, async () => {
            entered()
            throw new Error("foreign work must not begin")
          }, { confinementRoot: f.confinementRoot, timeoutMs: 500, pollIntervalMs: 1 }).then(() => null, (error: unknown) => error)
          await new Promise((resolve) => setImmediate(resolve))
          const saved = `${f.parent}.saved`
          fs.renameSync(f.parent, saved)
          fs.renameSync(foreign, f.parent)
          try {
            expect(fs.lstatSync(f.parent).isSymbolicLink()).toBe(false)
            const error = await pending
            expect(snapshot(f.parent)).toEqual(before)
            expect(entered).not.toHaveBeenCalled()
            expect(error).toBeInstanceOf(tx.SessionTransactionError)
          } finally {
            fs.renameSync(f.parent, foreign)
            fs.renameSync(saved, f.parent)
            await blocker.release()
          }
        })

        it.each(["ino", "dev"].flatMap((coordinate) => ["read", "write", "delete", "release", "explicit-reuse", "contextual-reuse"].map((operation) => ({ coordinate, operation }))))(
          "rejects a rounded $coordinate collision before held $operation",
          async ({ coordinate, operation }) => {
            const f = fixture()
            const tx = await subject()
            const foreign = path.join(f.root, "foreign")
            fs.mkdirSync(foreign, { mode: 0o700 })
            await directoryPair(f.parent, foreign, coordinate as "ino" | "dev")
            await tx.withSessionTurnLease(f.sessionPath, async (lease: any) => {
              const base = tx.readSessionTransaction(f.sessionPath, lease)
              fs.cpSync(f.parent, foreign, { recursive: true })
              const before = snapshot(foreign)
              const saved = `${f.parent}.saved`
              fs.renameSync(f.parent, saved)
              fs.renameSync(foreign, f.parent)
              let error: unknown
              const entered = vi.fn()
              try {
                try {
                  if (operation === "read") tx.readSessionTransaction(f.sessionPath, lease)
                  if (operation === "write") tx.writeSessionTransaction(f.sessionPath, { changed: true }, { lease, expectedRevision: base.revision })
                  if (operation === "delete") tx.deleteSessionTransaction(f.sessionPath, lease)
                  if (operation === "release") await lease.release()
                  if (operation === "explicit-reuse") {
                    const nested = await tx.acquireSessionTurnLease(f.sessionPath, { ownerId: lease.ownerId, ownerToken: lease.ownerToken })
                    entered()
                    await nested.release()
                  }
                  if (operation === "contextual-reuse") tx.withImmediateSessionTurnLease(f.sessionPath, (inner: any) => {
                    entered()
                    tx.readSessionTransaction(f.sessionPath, inner)
                  })
                } catch (caught) { error = caught }
                expect(snapshot(f.parent)).toEqual(before)
                expect(error).toBeInstanceOf(tx.SessionTransactionError)
                expect(entered).not.toHaveBeenCalled()
                if (operation === "release") {
                  expect(() => tx.assertSessionTurnLease(f.sessionPath, lease)).toThrow(/owner token/u)
                  const original = new Database(path.join(saved, "owner.json.turn.lock"), { readonly: true })
                  try { expect(original.prepare("SELECT owner_token FROM session_turn_lease").get()).toEqual({ owner_token: lease.ownerToken }) }
                  finally { original.close() }
                }
              } finally {
                fs.renameSync(f.parent, foreign)
                fs.renameSync(saved, f.parent)
              }
            }, { confinementRoot: f.confinementRoot })
          },
        )

        it.each(["ino", "dev"].flatMap((coordinate) => [false, true].map((primaryThrows) => ({ coordinate, primaryThrows }))))(
          "preserves a foreign temporary file across a rounded $coordinate collision (primary=$primaryThrows)",
          async ({ coordinate, primaryThrows }) => {
            const f = fixture()
            const tx = await subject()
            const native = await vi.importActual<typeof import("node:fs")>("node:fs")
            let originalIdentity = ""
            let replacementIdentity = ""
            installD004StatMetadata(fs, (physical, target) => {
              if (!originalIdentity && typeof target === "number" && physical.isFile()) originalIdentity = d004IdentityKey(physical)
              const key = d004IdentityKey(physical)
              if (key !== originalIdentity && key !== replacementIdentity) return undefined
              const value = key === replacementIdentity ? D004_INODE_B : D004_INODE_A
              return coordinate === "ino" ? { dev: 43n, ino: value } : { dev: value, ino: 7n }
            })
            const primary = new Error("original native-identity write failure")
            const foreignBytes = '{"foreign":"do not publish or delete"}'
            let temporary = ""
            let caught: unknown
            await tx.withSessionTurnLease(f.sessionPath, async (lease: any) => {
              const before = tx.readSessionTransaction(f.sessionPath, lease)
              try {
                tx.writeSessionTransaction(f.sessionPath, { version: 2, marker: "new" }, {
                  lease, expectedRevision: before.revision,
                  hooks: { beforeRename: () => {
                    temporary = path.join(f.parent, fs.readdirSync(f.parent).find((name) => name.includes(".tmp-"))!)
                    expect(originalIdentity).not.toBe("")
                    fs.renameSync(temporary, `${temporary}.original`)
                    fs.writeFileSync(temporary, foreignBytes, { mode: 0o600 })
                    replacementIdentity = d004IdentityKey(native.lstatSync(temporary, { bigint: true }))
                    expect(replacementIdentity).not.toBe(originalIdentity)
                    if (primaryThrows) throw primary
                  } },
                })
              } catch (error) { caught = error }
              expect(fs.readFileSync(f.sessionPath, "utf8")).toBe(before.bytes)
              expect(fs.existsSync(temporary)).toBe(true)
              expect(fs.readFileSync(temporary, "utf8")).toBe(foreignBytes)
              expect(fs.existsSync(`${temporary}.original`)).toBe(true)
              if (primaryThrows) expect(caught).toBe(primary)
              else expect(caught).toBeInstanceOf(tx.SessionTransactionError)
            }, { confinementRoot: f.confinementRoot })
          },
        )

        it("preserves the primary work error and foreign lease bytes when large-identity release refuses", async () => {
          const f = fixture()
          const tx = await subject()
          const foreign = path.join(f.root, "foreign")
          fs.mkdirSync(foreign, { mode: 0o700 })
          await directoryPair(f.parent, foreign)
          const saved = `${f.parent}.saved`
          const primary = new Error("primary work failure")
          let before: Record<string, string> = {}
          let caught: unknown
          try {
            await tx.withSessionTurnLease(f.sessionPath, async () => {
              fs.cpSync(f.parent, foreign, { recursive: true })
              before = snapshot(foreign)
              fs.renameSync(f.parent, saved)
              fs.renameSync(foreign, f.parent)
              throw primary
            }, { confinementRoot: f.confinementRoot })
          } catch (error) { caught = error }
          try {
            expect(caught).toBe(primary)
            expect(snapshot(f.parent)).toEqual(before)
          } finally {
            fs.renameSync(f.parent, foreign)
            fs.renameSync(saved, f.parent)
          }
        })

        it.each(["async", "immediate"])("keeps omitted confinement on its existing %s symlink route without new stat guards", async (kind) => {
          const f = fixture()
          const tx = await subject()
          const alias = path.join(f.root, "legacy-alias")
          fs.symlinkSync(f.parent, alias)
          const file = path.join(alias, "owner.json")
          const lstat = vi.spyOn(fs, "lstatSync")
          const fstat = vi.spyOn(fs, "fstatSync")
          const exercise = (lease: any) => {
            const before = tx.readSessionTransaction(file, lease)
            tx.writeSessionTransaction(file, { marker: "unconfined" }, { lease, expectedRevision: before.revision })
            expect(tx.withImmediateSessionTurnLease(file, (nested: any) => {
              expect(nested).toBe(lease)
              return tx.readSessionTransaction(file, nested).value
            })).toEqual({ marker: "unconfined" })
            tx.deleteSessionTransaction(file, lease)
            expect(tx.readSessionTransaction(file, lease).value).toBeNull()
          }
          if (kind === "async") await tx.withSessionTurnLease(file, async (lease: any) => exercise(lease))
          else tx.withImmediateSessionTurnLease(file, exercise)
          expect(lstat).not.toHaveBeenCalled()
          expect(fstat).not.toHaveBeenCalled()
          expect(readLock(file)).toBeNull()
        })
      })

      it.each(["null", "empty", "relative", "normalized", "missing", "file", "symlink", "outside", "root-as-session"])(
        "refuses initial %s confinement before creating any lease or sidecar",
        async (kind) => {
          const f = fixture()
          const tx = await subject()
          let confinementRoot: unknown = f.confinementRoot
          let sessionPath = f.sessionPath
          if (kind === "null") confinementRoot = null
          if (kind === "empty") confinementRoot = ""
          if (kind === "relative") confinementRoot = "sessions"
          if (kind === "normalized") confinementRoot = `${f.confinementRoot}/.`
          if (kind === "missing") confinementRoot = path.join(f.root, "missing")
          if (kind === "file") confinementRoot = f.sessionPath
          if (kind === "symlink") { confinementRoot = path.join(f.root, "alias"); fs.symlinkSync(f.confinementRoot, confinementRoot as string) }
          if (kind === "outside") { sessionPath = path.join(f.root, "outside.json"); fs.writeFileSync(sessionPath, "{}") }
          if (kind === "root-as-session") sessionPath = f.confinementRoot
          const before = snapshot(f.root)
          let lease: any
          const result = await tx.acquireSessionTurnLease(sessionPath, { confinementRoot, timeoutMs: 0 }).then((value: any) => { lease = value; return null }, (error: unknown) => error)
          try {
            expect(snapshot(f.root)).toEqual(before)
            expect(result).toBeInstanceOf(tx.SessionTransactionError)
          } finally { await lease?.release() }
        },
      )

      it.each([false, true])("refuses a replaced ancestor during real contention without touching a foreign lease (existing=%s)", async (existing) => {
        const f = fixture()
        const tx = await subject()
        await tx.withSessionTurnLease(f.sessionPath, async () => undefined)
        const foreign = path.join(f.root, "foreign")
        fs.cpSync(f.parent, foreign, { recursive: true })
        if (!existing) fs.unlinkSync(path.join(foreign, "owner.json.turn.lock"))
        const before = snapshot(foreign)
        const blocker = await tx.acquireSessionTurnLease(f.sessionPath)
        const entered = vi.fn()
        const primary = new Error("work must not begin")
        const pending = tx.withSessionTurnLease(f.sessionPath, async () => { entered(); throw primary }, {
          confinementRoot: f.confinementRoot, timeoutMs: 500, pollIntervalMs: 1,
        }).then(() => null, (error: unknown) => error)
        await new Promise((resolve) => setImmediate(resolve))
        const saved = `${f.parent}.saved`
        fs.renameSync(f.parent, saved)
        fs.symlinkSync(foreign, f.parent)
        try {
          const error = await pending
          expect(snapshot(foreign)).toEqual(before)
          expect(error).toBeInstanceOf(tx.SessionTransactionError)
          expect(entered).not.toHaveBeenCalled()
        } finally {
          fs.unlinkSync(f.parent); fs.renameSync(saved, f.parent)
          await blocker.release()
        }
      })

      it.each(["read", "write", "delete", "release"])("retains owner confinement for %s after an ancestor is replaced", async (operation) => {
        const f = fixture()
        const tx = await subject()
        const lease = await tx.acquireSessionTurnLease(f.sessionPath, { confinementRoot: f.confinementRoot })
        const base = tx.readSessionTransaction(f.sessionPath, lease)
        const foreign = path.join(f.root, "foreign")
        fs.cpSync(f.parent, foreign, { recursive: true })
        const before = snapshot(foreign)
        const saved = `${f.parent}.saved`
        fs.renameSync(f.parent, saved); fs.symlinkSync(foreign, f.parent)
        let error: unknown
        try {
          try {
            if (operation === "read") tx.readSessionTransaction(f.sessionPath, lease)
            if (operation === "write") tx.writeSessionTransaction(f.sessionPath, { changed: true }, { lease, expectedRevision: base.revision })
            if (operation === "delete") tx.deleteSessionTransaction(f.sessionPath, lease)
            if (operation === "release") await lease.release()
          } catch (caught) { error = caught }
          expect(snapshot(foreign)).toEqual(before)
          expect(error).toBeInstanceOf(tx.SessionTransactionError)
          if (operation === "release") {
            expect(() => tx.assertSessionTurnLease(f.sessionPath, lease)).toThrow(/owner token/u)
            const original = new Database(path.join(saved, "owner.json.turn.lock"), { readonly: true })
            try { expect(original.prepare("SELECT owner_token FROM session_turn_lease").get()).toEqual({ owner_token: lease.ownerToken }) }
            finally { original.close() }
          }
        } finally {
          fs.unlinkSync(f.parent); fs.renameSync(saved, f.parent)
          await lease.release().catch(() => undefined)
        }
      })

      it.each([false, true])("does not publish or clean up a foreign copied temporary file (primary throws=%s)", async (throws) => {
        const f = fixture()
        const tx = await subject()
        const foreign = path.join(f.root, "foreign")
        const saved = `${f.parent}.saved`
        const primary = new Error("original beforeRename failure")
        let before: Record<string, string> = {}
        let error: unknown
        let leaseRef: any
        try {
          await tx.withSessionTurnLease(f.sessionPath, async (lease: any) => {
            leaseRef = lease
            const base = tx.readSessionTransaction(f.sessionPath, lease)
            tx.writeSessionTransaction(f.sessionPath, { version: 2, marker: "new" }, {
              lease, expectedRevision: base.revision,
              hooks: { beforeRename: () => {
                fs.renameSync(f.parent, saved)
                fs.cpSync(saved, foreign, { recursive: true })
                fs.symlinkSync(foreign, f.parent)
                before = snapshot(foreign)
                if (throws) throw primary
              } },
            })
          }, { confinementRoot: f.confinementRoot })
        } catch (caught) { error = caught }
        try {
          expect(snapshot(foreign)).toEqual(before)
          expect(fs.readdirSync(saved).some((name) => name.includes(".tmp-"))).toBe(true)
          if (throws) expect(error).toBe(primary)
          else expect(error).toBeInstanceOf(tx.SessionTransactionError)
          expect(() => tx.assertSessionTurnLease(f.sessionPath, leaseRef)).toThrow(/owner token/u)
        } finally {
          fs.unlinkSync(f.parent); fs.renameSync(saved, f.parent)
          await leaseRef?.release().catch(() => undefined)
        }
      })

      it("preserves a primary work error if release cannot safely address its original path", async () => {
        const f = fixture()
        const tx = await subject()
        const primary = new Error("primary work error")
        const foreign = path.join(f.root, "foreign")
        const saved = `${f.parent}.saved`
        let before: Record<string, string> = {}
        let caught: unknown
        try {
          await tx.withSessionTurnLease(f.sessionPath, async () => {
            fs.cpSync(f.parent, foreign, { recursive: true })
            before = snapshot(foreign)
            fs.renameSync(f.parent, saved); fs.symlinkSync(foreign, f.parent)
            throw primary
          }, { confinementRoot: f.confinementRoot })
        } catch (error) { caught = error }
        expect(snapshot(foreign)).toEqual(before)
        expect(caught).toBe(primary)
      })

      it.each([".turn.lock", ".turn.lock-journal", ".turn.lock-wal", ".turn.lock-shm"])("refuses a file-level %s symlink with unchanged parent identity", async (suffix) => {
        const f = fixture()
        const tx = await subject()
        const lease = await tx.acquireSessionTurnLease(f.sessionPath, { confinementRoot: f.confinementRoot })
        const foreign = path.join(f.root, "foreign")
        fs.mkdirSync(foreign)
        const target = path.join(foreign, "target")
        const candidate = `${f.sessionPath}${suffix}`
        if (suffix === ".turn.lock") fs.copyFileSync(candidate, target)
        else fs.writeFileSync(target, "foreign sidecar must not change")
        const parentInode = fs.statSync(f.parent).ino
        const saved = `${candidate}.saved`
        if (fs.existsSync(candidate)) fs.renameSync(candidate, saved)
        fs.symlinkSync(target, candidate)
        const before = snapshot(foreign)
        const error = await lease.release().then(() => null, (caught: unknown) => caught)
        expect(fs.statSync(f.parent).ino).toBe(parentInode)
        expect(snapshot(foreign)).toEqual(before)
        expect(error).toBeInstanceOf(tx.SessionTransactionError)
        expect(() => tx.assertSessionTurnLease(f.sessionPath, lease)).toThrow(/owner token/u)
      })

      it.each([".turn.lock", ".turn.lock-journal", ".turn.lock-wal", ".turn.lock-shm"])("rejects an initial %s symlink before SQLite creates or migrates anything", async (suffix) => {
        const f = fixture()
        const tx = await subject()
        await tx.withSessionTurnLease(f.sessionPath, async () => undefined)
        const foreign = path.join(f.root, "foreign")
        fs.mkdirSync(foreign)
        const target = path.join(foreign, "target")
        const candidate = `${f.sessionPath}${suffix}`
        if (suffix === ".turn.lock") { fs.copyFileSync(candidate, target); fs.unlinkSync(candidate) }
        else fs.writeFileSync(target, "foreign sidecar")
        fs.symlinkSync(target, candidate)
        const before = snapshot(f.root)
        let lease: any
        const error = await tx.acquireSessionTurnLease(f.sessionPath, { confinementRoot: f.confinementRoot }).then((value: any) => { lease = value; return null }, (caught: unknown) => caught)
        try {
          expect(snapshot(f.root)).toEqual(before)
          expect(error).toBeInstanceOf(tx.SessionTransactionError)
        } finally { await lease?.release().catch(() => undefined) }
      })

      it.each(["explicit", "contextual"])("does not drop the pin when %s nested acquisition omits confinementRoot", async (kind) => {
        const f = fixture()
        const tx = await subject()
        const foreign = path.join(f.root, "foreign")
        const saved = `${f.parent}.saved`
        let before: Record<string, string> = {}
        let readError: unknown
        await tx.withSessionTurnLease(f.sessionPath, async (outer: any) => {
          const work = (nested: any) => {
            fs.cpSync(f.parent, foreign, { recursive: true })
            before = snapshot(foreign)
            fs.renameSync(f.parent, saved); fs.symlinkSync(foreign, f.parent)
            try { tx.readSessionTransaction(f.sessionPath, nested) } catch (error) { readError = error }
          }
          try {
            if (kind === "contextual") tx.withImmediateSessionTurnLease(f.sessionPath, work)
            else {
              const nested = await tx.acquireSessionTurnLease(f.sessionPath, { ownerId: outer.ownerId, ownerToken: outer.ownerToken })
              work(nested)
              await nested.release()
            }
            expect(snapshot(foreign)).toEqual(before)
            expect(readError).toBeInstanceOf(tx.SessionTransactionError)
          } finally { fs.unlinkSync(f.parent); fs.renameSync(saved, f.parent) }
        }, { confinementRoot: f.confinementRoot })
      })

      it.each(["explicit", "contextual"])("refuses a conflicting %s reentrant root before invoking work", async (kind) => {
        const f = fixture()
        const tx = await subject()
        const callback = vi.fn()
        await tx.withSessionTurnLease(f.sessionPath, async (outer: any) => {
          const options = { ownerId: outer.ownerId, ownerToken: outer.ownerToken, confinementRoot: f.root }
          if (kind === "contextual") expect(() => tx.withImmediateSessionTurnLease(f.sessionPath, callback, options)).toThrow(tx.SessionTransactionError)
          else {
            let unexpected: any
            const error = await tx.acquireSessionTurnLease(f.sessionPath, options).then((value: any) => { unexpected = value; return null }, (caught: unknown) => caught)
            await unexpected?.release()
            expect(error).toBeInstanceOf(tx.SessionTransactionError)
          }
          expect(callback).not.toHaveBeenCalled()
        }, { confinementRoot: f.confinementRoot })
      })

      it("keeps safe confined immediate read/write/delete behavior on the same canonical lease", async () => {
        const f = fixture()
        const tx = await subject()
        tx.withImmediateSessionTurnLease(f.sessionPath, (lease: any) => {
          const before = tx.readSessionTransaction(f.sessionPath, lease)
          tx.writeSessionTransaction(f.sessionPath, { version: 2, marker: "accepted" }, { lease, expectedRevision: before.revision })
          expect(tx.readSessionTransaction(f.sessionPath, lease).value).toEqual({ version: 2, marker: "accepted" })
          tx.deleteSessionTransaction(f.sessionPath, lease)
          expect(tx.readSessionTransaction(f.sessionPath, lease).bytes).toBe("")
        }, { confinementRoot: f.confinementRoot })
      })

      it("rejects a regular-directory replacement even without a symlink", async () => {
        const f = fixture()
        const tx = await subject()
        const lease = await tx.acquireSessionTurnLease(f.sessionPath, { confinementRoot: f.confinementRoot })
        const replacement = path.join(f.root, "replacement")
        fs.cpSync(f.parent, replacement, { recursive: true })
        const saved = `${f.parent}.saved`
        fs.renameSync(f.parent, saved); fs.renameSync(replacement, f.parent)
        const before = snapshot(f.parent)
        const error = await lease.release().then(() => null, (caught: unknown) => caught)
        expect(fs.lstatSync(f.parent).isSymbolicLink()).toBe(false)
        expect(snapshot(f.parent)).toEqual(before)
        expect(error).toBeInstanceOf(tx.SessionTransactionError)
      })

      it("rechecks the pin after a stale-owner probe and before changing the stale row", async () => {
        const f = fixture()
        const tx = await subject()
        writeLock(f.sessionPath, { pid: 999_999_999, ownerId: "stale", ownerToken: "stale-token" })
        const foreign = path.join(f.root, "foreign")
        const saved = `${f.parent}.saved`
        let before: Record<string, string> = {}
        let savedBefore: Record<string, string> = {}
        const error = await tx.acquireSessionTurnLease(f.sessionPath, {
          confinementRoot: f.confinementRoot,
          isProcessAlive: () => {
            fs.cpSync(f.parent, foreign, { recursive: true })
            fs.renameSync(f.parent, saved); fs.symlinkSync(foreign, f.parent)
            before = snapshot(foreign); savedBefore = snapshot(saved)
            return false
          },
        }).then(async (lease: any) => { await lease.release(); return null }, (caught: unknown) => caught)
        expect(snapshot(foreign)).toEqual(before)
        expect(snapshot(saved)).toEqual(savedBefore)
        expect(error).toBeInstanceOf(tx.SessionTransactionError)
      })

      it.each([false, true])("never publishes or unlinks a replaced temporary inode (primary throws=%s)", async (throws) => {
        const f = fixture()
        const tx = await subject()
        const primary = new Error("primary temporary failure")
        const original = fs.readFileSync(f.sessionPath, "utf8")
        let temporary = ""
        let caught: unknown
        try {
          await tx.withSessionTurnLease(f.sessionPath, async (lease: any) => {
            const base = tx.readSessionTransaction(f.sessionPath, lease)
            tx.writeSessionTransaction(f.sessionPath, { changed: true }, {
              lease, expectedRevision: base.revision,
              hooks: { beforeRename: () => {
                temporary = path.join(f.parent, fs.readdirSync(f.parent).find((name) => name.includes(".tmp-"))!)
                fs.renameSync(temporary, `${temporary}.owned`)
                fs.writeFileSync(temporary, "foreign replacement", { mode: 0o600 })
                if (throws) throw primary
              } },
            })
          }, { confinementRoot: f.confinementRoot })
        } catch (error) { caught = error }
        expect(fs.readFileSync(f.sessionPath, "utf8")).toBe(original)
        expect(fs.existsSync(temporary)).toBe(true)
        expect(fs.readFileSync(temporary, "utf8")).toBe("foreign replacement")
        if (throws) expect(caught).toBe(primary)
        else expect(caught).toBeInstanceOf(tx.SessionTransactionError)
      })

      it("refuses an unreadable confined file before any lease acquisition", async () => {
        const f = fixture()
        const tx = await subject()
        const actual = fs.lstatSync
        const spy = vi.spyOn(fs, "lstatSync").mockImplementation(((file: fs.PathLike, ...args: any[]) => {
          if (String(file) === `${f.sessionPath}.turn.lock`) throw Object.assign(new Error("metadata denied"), { code: "EACCES" })
          return (actual as any)(file, ...args)
        }) as typeof fs.lstatSync)
        let unexpected: any
        const error = await tx.acquireSessionTurnLease(f.sessionPath, { confinementRoot: f.confinementRoot }).then((lease: any) => { unexpected = lease; return null }, (caught: unknown) => caught)
        try { expect(error).toBeInstanceOf(tx.SessionTransactionError) }
        finally { spy.mockRestore(); await unexpected?.release() }
      })

      it.each(["missing", "file"])("refuses a %s session ancestor before directory creation", async (kind) => {
        const f = fixture()
        const tx = await subject()
        fs.rmSync(f.parent, { recursive: true })
        if (kind === "file") fs.writeFileSync(f.parent, "not a directory")
        const before = snapshot(f.root)
        let unexpected: any
        const error = await tx.acquireSessionTurnLease(f.sessionPath, { confinementRoot: f.confinementRoot }).then((lease: any) => { unexpected = lease; return null }, (caught: unknown) => caught)
        try {
          expect(snapshot(f.root)).toEqual(before)
          expect(error).toBeInstanceOf(tx.SessionTransactionError)
        } finally { await unexpected?.release() }
      })

      it.each(["work-error", "work-and-release-error", "release-only"])("preserves immediate owner error precedence for %s", async (kind) => {
        const f = fixture()
        const tx = await subject()
        const primary = new Error("primary immediate work error")
        const foreign = path.join(f.root, "foreign")
        let before: Record<string, string> = {}
        let caught: unknown
        try {
          tx.withImmediateSessionTurnLease(f.sessionPath, () => {
            if (kind !== "work-error") {
              fs.cpSync(f.parent, foreign, { recursive: true })
              before = snapshot(foreign)
              fs.renameSync(f.parent, `${f.parent}.saved`); fs.symlinkSync(foreign, f.parent)
            }
            if (kind !== "release-only") throw primary
          }, { confinementRoot: f.confinementRoot })
        } catch (error) { caught = error }
        if (kind !== "work-error") expect(snapshot(foreign)).toEqual(before)
        if (kind === "release-only") expect(caught).toBeInstanceOf(tx.SessionTransactionError)
        else expect(caught).toBe(primary)
      })

      it("does not erase a replacement held-lease capability when an old incarnation releases", async () => {
        const f = fixture()
        const tx = await subject()
        const first = await tx.acquireSessionTurnLease(f.sessionPath, { confinementRoot: f.confinementRoot, getBootIdentity: () => "old-boot", getProcessStartedAt: () => "started", ownerId: "first" })
        const second = await tx.acquireSessionTurnLease(f.sessionPath, { confinementRoot: f.confinementRoot, getBootIdentity: () => "new-boot", getProcessStartedAt: () => "started", ownerId: "second" })
        await first.release()
        expect(() => tx.assertSessionTurnLease(f.sessionPath, second)).not.toThrow()
        await second.release()
      })

      it("rejects an already released contextual lease", async () => {
        const f = fixture()
        const tx = await subject()
        await tx.withSessionTurnLease(f.sessionPath, async (lease: any) => {
          await lease.release()
          expect(() => tx.withImmediateSessionTurnLease(f.sessionPath, () => undefined)).toThrow(/owner token/u)
        }, { confinementRoot: f.confinementRoot })
      })

      it("surfaces unsafe release after successful work when the pinned ancestor disappears", async () => {
        const f = fixture()
        const tx = await subject()
        let retained: any
        await expect(tx.withSessionTurnLease(f.sessionPath, async (lease: any) => {
          retained = lease
          fs.renameSync(f.parent, `${f.parent}.saved`)
        }, { confinementRoot: f.confinementRoot })).rejects.toBeInstanceOf(tx.SessionTransactionError)
        expect(() => tx.assertSessionTurnLease(f.sessionPath, retained)).toThrow(/owner token/u)
        expect(fs.readFileSync(path.join(`${f.parent}.saved`, "owner.json"), "utf8")).toBe('{"version":2,"marker":"base"}')
      })

      it("preserves an ordinary caller's primary error when temporary cleanup also fails", async () => {
        const f = fixture()
        const tx = await subject()
        const primary = new Error("primary unconfined error")
        const unlink = fs.unlinkSync
        const spy = vi.spyOn(fs, "unlinkSync").mockImplementation((file) => {
          if (String(file).includes(".tmp-")) throw new Error("cleanup denied")
          return unlink(file)
        })
        const lease = await tx.acquireSessionTurnLease(f.sessionPath)
        try {
          const base = tx.readSessionTransaction(f.sessionPath, lease)
          expect(() => tx.writeSessionTransaction(f.sessionPath, {}, { lease, expectedRevision: base.revision, hooks: { beforeRename: () => { throw primary } } })).toThrow(primary)
        } finally { spy.mockRestore(); await lease.release() }
      })

      it("does not retrofit a new confinement promise onto an already unconfined contextual lease", async () => {
        const f = fixture()
        const tx = await subject()
        await tx.withSessionTurnLease(f.sessionPath, async () => {
          expect(() => tx.withImmediateSessionTurnLease(f.sessionPath, () => undefined, { confinementRoot: f.confinementRoot })).toThrow(tx.SessionTransactionError)
        })
      })
    })

describe("cross-process session turn transaction contract", () => {
  it("serializes two real-process reclaimers of a dead SQLite lease", async () => {
    const sessionPath = makeSession()
    const modulePath = path.resolve(__dirname, "../../mind/session-transaction.ts")
    const effectsPath = path.join(path.dirname(sessionPath), "reclaim-effects.log")
    writeLock(sessionPath, { pid: 999_999_999, ownerId: "dead", ownerToken: "dead-token" })
    const workers = [1, 2].map(() => spawn(process.execPath, [
      "-e", childScript(), modulePath, sessionPath, "reclaim", effectsPath,
    ], { stdio: ["ignore", "pipe", "pipe"] }))

    const exits = workers.map(waitForCleanExit)
    await Promise.all(workers.map((worker) => waitForOutput(worker, "RECLAIMED")))
    await Promise.all(exits)
    const effects = fs.readFileSync(effectsPath, "utf8").trim().split("\n")
    expect(effects).toHaveLength(4)
    expect(effects[0]).toMatch(/^ENTER:/)
    expect(effects[1]).toMatch(/^EXIT:/)
    expect(effects[2]).toMatch(/^ENTER:/)
    expect(effects[3]).toMatch(/^EXIT:/)
  })

  it("uses the contextual lease for immediate mutations and exposes it only for the matching path", async () => {
    const { currentSessionTurnLease, withImmediateSessionTurnLease, withSessionTurnLease } = await subject()
    const sessionPath = makeSession()
    const otherPath = makeSession()

    await withSessionTurnLease(sessionPath, async (outer: any) => {
      expect(currentSessionTurnLease(sessionPath)).toMatchObject({ ownerToken: outer.ownerToken })
      expect(currentSessionTurnLease(otherPath)).toBeNull()
      const nestedOwner = withImmediateSessionTurnLease(sessionPath, (nested: any) => nested.ownerToken)
      expect(nestedOwner).toBe(outer.ownerToken)
    }, { ownerId: "context-owner", ownerToken: "context-token" })

    expect(currentSessionTurnLease(sessionPath)).toBeNull()
  })

  it("supports a standalone immediate read, write, delete, and missing-file read", async () => {
    const { deleteSessionTransaction, readSessionTransaction, withImmediateSessionTurnLease, writeSessionTransaction } = await subject()
    const sessionPath = makeSession()

    withImmediateSessionTurnLease(sessionPath, (lease: any) => {
      const before = readSessionTransaction(sessionPath, lease)
      writeSessionTransaction(sessionPath, { version: 2, marker: "immediate" }, {
        lease,
        expectedRevision: before.revision,
      })
      deleteSessionTransaction(sessionPath, lease)
      expect(readSessionTransaction(sessionPath, lease)).toMatchObject({ bytes: "", value: null })
      deleteSessionTransaction(sessionPath, lease)
    }, { ownerId: "immediate-owner", ownerToken: "immediate-token" })
  })

  it("fails an immediate contender, claims an ownerless database, and recovers dead-owner locks", async () => {
    const { SessionTurnBusyError, withImmediateSessionTurnLease, acquireSessionTurnLease } = await subject()
    const sessionPath = makeSession()
    const held = await acquireSessionTurnLease(sessionPath, { ownerId: "live-owner", ownerToken: "live-token" })

    expect(() => withImmediateSessionTurnLease(sessionPath, () => undefined)).toThrow(SessionTurnBusyError)
    await held.release()

    writeLock(sessionPath)
    expect(withImmediateSessionTurnLease(sessionPath, () => "ownerless-claimed")).toBe("ownerless-claimed")

    const onStaleLease = vi.fn()
    writeLock(sessionPath, { pid: 999_999_999, ownerId: "dead", ownerToken: "dead-token" })
    expect(withImmediateSessionTurnLease(sessionPath, () => "dead-recovered", { onStaleLease })).toBe("dead-recovered")
    expect(onStaleLease).toHaveBeenCalledWith(expect.objectContaining({ ownerId: "dead" }))
  })

  it("fails closed for a corrupt lease database", async () => {
    const { acquireSessionTurnLease, withImmediateSessionTurnLease } = await subject()
    const sessionPath = makeSession()
    const lockPath = `${sessionPath}.turn.lock`
    fs.writeFileSync(lockPath, "not a sqlite database")
    expect(() => withImmediateSessionTurnLease(sessionPath, () => undefined)).toThrow()

    const malformedSessionPath = makeSession()
    writeLock(malformedSessionPath, { pid: "invalid", ownerId: "owner", ownerToken: "token" })
    await expect(acquireSessionTurnLease(malformedSessionPath, {
      isProcessAlive: () => false,
      timeoutMs: 1,
    })).rejects.toMatchObject({ name: "SessionTransactionError" })
  })

  it("rejects forged, released, and path-mismatched lease capabilities", async () => {
    const { SessionTransactionError, acquireSessionTurnLease, assertSessionTurnLease } = await subject()
    const sessionPath = makeSession()
    const lease = await acquireSessionTurnLease(sessionPath, { ownerId: "owner-a", ownerToken: "token-a" })

    expect(() => assertSessionTurnLease(sessionPath, { ...lease, ownerToken: "forged" })).toThrow(SessionTransactionError)
    expect(() => assertSessionTurnLease(makeSession(), lease)).toThrow(/path mismatch/)
    await lease.release()
    await lease.release()
    expect(() => assertSessionTurnLease(sessionPath, lease)).toThrow(/owner token mismatch/)
  })

  it("does not delete a lock that was replaced by another owner before release", async () => {
    const { acquireSessionTurnLease } = await subject()
    const sessionPath = makeSession()
    const lease = await acquireSessionTurnLease(sessionPath, { ownerId: "owner-a", ownerToken: "token-a" })
    replaceLock(sessionPath, { pid: process.pid, ownerId: "owner-b", ownerToken: "token-b" })

    await lease.release()
    expect(readLock(sessionPath)).toMatchObject({ ownerId: "owner-b" })
  })

  it("does not release a replacement incarnation even when its PID and logical owner match", async () => {
    const { acquireSessionTurnLease } = await subject()
    const sessionPath = makeSession()
    const lease = await acquireSessionTurnLease(sessionPath, { ownerId: "owner-a", ownerToken: "token-a" })
    replaceLock(sessionPath, { pid: process.pid, ownerId: "owner-a", ownerToken: "token-a", processStartedAt: "replacement-incarnation" })

    await lease.release()
    expect(readLock(sessionPath)).toMatchObject({ ownerId: "owner-a", ownerToken: "token-a" })
  })

  it("propagates non-contention acquisition and non-missing read/delete failures", async () => {
    const { acquireSessionTurnLease, deleteSessionTransaction, readSessionTransaction, withImmediateSessionTurnLease } = await subject()
    const sessionPath = makeSession()
    const root = path.dirname(sessionPath)
    fs.chmodSync(root, 0o500)
    try {
      await expect(acquireSessionTurnLease(sessionPath)).rejects.toMatchObject({ code: "SQLITE_CANTOPEN" })
      expect(() => withImmediateSessionTurnLease(sessionPath, () => undefined)).toThrow()
    } finally {
      fs.chmodSync(root, 0o700)
    }

    const lease = await acquireSessionTurnLease(sessionPath)
    fs.unlinkSync(sessionPath)
    fs.mkdirSync(sessionPath)
    expect(() => readSessionTransaction(sessionPath, lease)).toThrow()
    expect(() => deleteSessionTransaction(sessionPath, lease)).toThrow()
    fs.rmdirSync(sessionPath)
    await lease.release()
  })
})
