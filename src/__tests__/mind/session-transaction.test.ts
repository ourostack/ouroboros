import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { spawn } from "node:child_process"

import { afterEach, describe, expect, it, vi } from "vitest"

const roots: string[] = []

function makeSession(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ouro-session-transaction-"))
  roots.push(root)
  const sessionPath = path.join(root, "session.json")
  fs.writeFileSync(sessionPath, JSON.stringify({ version: 2, marker: "base" }))
  return sessionPath
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
const sessionPath = process.argv[2]
const mode = process.argv[3]
;(async () => {
  const lease = await runtime.acquireSessionTurnLease(sessionPath, {
    ownerId: "child-owner",
    timeoutMs: 1000,
    pollIntervalMs: 1,
  })
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

afterEach(() => {
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
    fs.writeFileSync(`${sessionPath}.turn.lock`, JSON.stringify({ pid: 999_999_999, ownerId: "dead", ownerToken: "dead-token" }))
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
    child.stdin!.end()
    await waitForOutput(child, "RELEASED")

    const parentLease = await acquireSessionTurnLease(sessionPath, { ownerId: "parent-owner", timeoutMs: 100, pollIntervalMs: 1 })
    const base = readSessionTransaction(sessionPath, parentLease)
    writeSessionTransaction(sessionPath, { version: 2, marker: "parent" }, { lease: parentLease, expectedRevision: base.revision })
    await parentLease.release()

    const staleChild = spawn(process.execPath, ["-e", childScript(), modulePath, sessionPath, "stale-write", base.revision], {
      stdio: ["ignore", "pipe", "pipe"],
    })
    const staleOutput = await waitForOutput(staleChild, "STALE:")
    expect(staleOutput).toContain("STALE:")
    expect(JSON.parse(fs.readFileSync(sessionPath, "utf8"))).toMatchObject({ marker: "parent" })
  })
})
