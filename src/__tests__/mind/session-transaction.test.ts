import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { spawn } from "node:child_process"
import Database from "better-sqlite3"

import { afterEach, describe, expect, it, vi } from "vitest"

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
    const record = content as { pid?: unknown; ownerId?: unknown; ownerToken?: unknown }
    database.prepare(`
      INSERT INTO session_turn_lease (singleton, pid, owner_id, owner_token) VALUES (1, ?, ?, ?)
    `).run(record.pid, record.ownerId, record.ownerToken)
  }
  database.close()
  return lockPath
}

function readLock(sessionPath: string): { pid: number; ownerId: string; ownerToken: string } | null {
  const database = new Database(`${sessionPath}.turn.lock`)
  try {
    const row = database.prepare(`
      SELECT pid, owner_id, owner_token FROM session_turn_lease WHERE singleton = 1
    `).get() as { pid: number; owner_id: string; owner_token: string } | undefined
    return row ? { pid: row.pid, ownerId: row.owner_id, ownerToken: row.owner_token } : null
  } finally {
    database.close()
  }
}

function replaceLock(sessionPath: string, content: { pid: number; ownerId: string; ownerToken: string }): void {
  const database = new Database(`${sessionPath}.turn.lock`)
  try {
    database.prepare(`
      UPDATE session_turn_lease SET pid = ?, owner_id = ?, owner_token = ? WHERE singleton = 1
    `).run(content.pid, content.ownerId, content.ownerToken)
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

  it("excludes a real child process, then rejects its stale cross-process revision", async () => {
    const { acquireSessionTurnLease, readSessionTransaction, writeSessionTransaction } = await subject()
    const sessionPath = makeSession()
    const modulePath = path.resolve(__dirname, "../../mind/session-transaction.ts")
    const child = spawn(process.execPath, ["-e", childScript(), modulePath, sessionPath, "hold"], {
      stdio: ["pipe", "pipe", "pipe"],
    })
    await waitForOutput(child, "READY")

    await expect(acquireSessionTurnLease(sessionPath, {
      ownerId: "parent-owner",
      timeoutMs: 10,
      pollIntervalMs: 1,
    })).rejects.toMatchObject({ name: "SessionTurnBusyError" })
    const released = waitForOutput(child, "RELEASED")
    const childExit = waitForCleanExit(child)
    child.stdin!.end()
    await released
    await childExit

    const parentLease = await acquireSessionTurnLease(sessionPath, { ownerId: "parent-owner", timeoutMs: 100, pollIntervalMs: 1 })
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
