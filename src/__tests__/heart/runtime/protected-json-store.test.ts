import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { afterEach, describe, expect, it, vi } from "vitest"

import {
  ProtectedStoreCorruptError,
  ProtectedStoreLockedError,
  acquireProtectedLock,
  mutateProtectedJson,
  nodeProtectedStoreIo,
  readProtectedJson,
  type ProtectedStoreIo,
} from "../../../heart/runtime/protected-json-store"
import type { ExactProcessState, ProcessIdentity } from "../../../heart/runtime/process-identity"

const owner: ProcessIdentity = {
  uid: 501,
  pid: 5151,
  startIdentity: "darwin-proc:1770000000:001234",
  bootId: "boot-a",
}

const roots: string[] = []

function tempTarget(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ouro-protected-store-"))
  roots.push(root)
  return path.join(root, "state.json")
}

function parseCounter(value: unknown): { schemaVersion: 1; count: number } {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(",") !== "count,schemaVersion" ||
    (value as Record<string, unknown>).schemaVersion !== 1 ||
    !Number.isSafeInteger((value as Record<string, unknown>).count)
  ) {
    throw new Error("invalid counter")
  }
  return value as { schemaVersion: 1; count: number }
}

function state(state: ExactProcessState["state"]): (candidate: ProcessIdentity) => ExactProcessState {
  return (candidate) => state === "alive"
    ? { state: "alive", observed: candidate }
    : state === "dead"
      ? { state: "dead", reason: "process-absent" }
      : { state: "unobservable", reason: "process-evidence-unavailable" }
}

afterEach(() => {
  vi.restoreAllMocks()
  while (roots.length > 0) fs.rmSync(roots.pop()!, { recursive: true, force: true })
})

describe("protected JSON store", () => {
  it("acquires an owner-identified exclusive mode-0600 lock and releases only its own bytes", () => {
    const target = tempTarget()
    const lock = acquireProtectedLock(target, owner, state("alive"))
    const lockPath = `${target}.lock`

    expect(fs.statSync(lockPath).mode & 0o777).toBe(0o600)
    expect(fs.readFileSync(lockPath, "utf8")).toBe(
      "{\"owner\":{\"bootId\":\"boot-a\",\"pid\":5151,\"startIdentity\":\"darwin-proc:1770000000:001234\",\"uid\":501},\"schemaVersion\":1}",
    )
    lock.release()
    expect(fs.existsSync(lockPath)).toBe(false)
    lock.release()
  })

  it("never reclaims a live, unobservable, or merely old owner", () => {
    const target = tempTarget()
    const held = acquireProtectedLock(target, owner, state("alive"))
    const old = new Date(0)
    fs.utimesSync(`${target}.lock`, old, old)

    expect(() => acquireProtectedLock(target, { ...owner, pid: 6161 }, state("alive"))).toThrow(ProtectedStoreLockedError)
    expect(() => acquireProtectedLock(target, { ...owner, pid: 6161 }, state("unobservable"))).toThrow(ProtectedStoreLockedError)
    expect(fs.existsSync(`${target}.lock`)).toBe(true)
    held.release()
  })

  it("reclaims only after fresh proof that the exact owner is dead", () => {
    const target = tempTarget()
    const abandoned = acquireProtectedLock(target, owner, state("alive"))
    const replacement = { ...owner, pid: 6161, startIdentity: "darwin-proc:1770000001:000001" }

    const reclaimed = acquireProtectedLock(target, replacement, state("dead"))
    expect(fs.readFileSync(`${target}.lock`, "utf8")).toContain("\"pid\":6161")
    abandoned.release()
    expect(fs.existsSync(`${target}.lock`)).toBe(true)
    reclaimed.release()
  })

  it("serializes concurrent writers instead of treating a matching PID as authority", async () => {
    const target = tempTarget()
    const first = acquireProtectedLock(target, owner, state("alive"))
    const contender = Promise.resolve().then(() => acquireProtectedLock(target, owner, state("alive")))

    await expect(contender).rejects.toBeInstanceOf(ProtectedStoreLockedError)
    first.release()
    expect(() => acquireProtectedLock(target, owner, state("alive")).release()).not.toThrow()
  })

  it("writes same-directory canonical bytes, fsyncs file then directory, and preserves mode 0600", () => {
    const target = tempTarget()
    const calls: string[] = []
    const io: ProtectedStoreIo = {
      ...nodeProtectedStoreIo,
      fsyncSync: (fd) => {
        calls.push(fs.fstatSync(fd).isDirectory() ? "fsync-directory" : "fsync-file")
        nodeProtectedStoreIo.fsyncSync(fd)
      },
      renameSync: (from, to) => {
        calls.push(`rename:${path.dirname(from) === path.dirname(to)}`)
        nodeProtectedStoreIo.renameSync(from, to)
      },
    }

    const result = mutateProtectedJson({
      targetPath: target,
      owner,
      proveOwnerState: state("alive"),
      parse: parseCounter,
      initial: { schemaVersion: 1, count: 0 },
      mutate: (prior) => ({ ...prior, count: prior.count + 1 }),
      io,
    })

    expect(result).toEqual({ schemaVersion: 1, count: 1 })
    expect(fs.readFileSync(target, "utf8")).toBe("{\"count\":1,\"schemaVersion\":1}")
    expect(fs.statSync(target).mode & 0o777).toBe(0o600)
    expect(calls).toEqual(["fsync-file", "rename:true", "fsync-directory"])
    expect(fs.readdirSync(path.dirname(target)).sort()).toEqual(["state.json"])
  })

  it("does not rename when file fsync fails and cleans the temporary file", () => {
    const target = tempTarget()
    fs.writeFileSync(target, "{\"count\":1,\"schemaVersion\":1}", { mode: 0o600 })
    const renameSync = vi.fn(nodeProtectedStoreIo.renameSync)
    const io: ProtectedStoreIo = {
      ...nodeProtectedStoreIo,
      fsyncSync: () => { throw new Error("file fsync failed") },
      renameSync,
    }

    expect(() => mutateProtectedJson({
      targetPath: target,
      owner,
      proveOwnerState: state("alive"),
      parse: parseCounter,
      initial: { schemaVersion: 1, count: 0 },
      mutate: (prior) => ({ ...prior, count: prior.count + 1 }),
      io,
    })).toThrow("file fsync failed")
    expect(renameSync).not.toHaveBeenCalled()
    expect(fs.readFileSync(target, "utf8")).toBe("{\"count\":1,\"schemaVersion\":1}")
    expect(fs.readdirSync(path.dirname(target)).sort()).toEqual(["state.json"])
  })

  it("surfaces directory fsync failure after rename without leaving lock or temp state", () => {
    const target = tempTarget()
    let fsyncCount = 0
    const io: ProtectedStoreIo = {
      ...nodeProtectedStoreIo,
      fsyncSync: (fd) => {
        fsyncCount += 1
        if (fs.fstatSync(fd).isDirectory()) throw new Error("directory fsync failed")
        nodeProtectedStoreIo.fsyncSync(fd)
      },
    }

    expect(() => mutateProtectedJson({
      targetPath: target,
      owner,
      proveOwnerState: state("alive"),
      parse: parseCounter,
      initial: { schemaVersion: 1, count: 0 },
      mutate: (prior) => ({ ...prior, count: prior.count + 1 }),
      io,
    })).toThrow("directory fsync failed")
    expect(fsyncCount).toBe(2)
    expect(fs.readFileSync(target, "utf8")).toBe("{\"count\":1,\"schemaVersion\":1}")
    expect(fs.readdirSync(path.dirname(target)).sort()).toEqual(["state.json"])
  })

  it("rejects target and lock symlinks without mutation", () => {
    const target = tempTarget()
    const outside = path.join(path.dirname(target), "outside.json")
    fs.writeFileSync(outside, "{\"count\":7,\"schemaVersion\":1}", { mode: 0o600 })
    fs.symlinkSync(outside, target)

    expect(() => mutateProtectedJson({
      targetPath: target,
      owner,
      proveOwnerState: state("alive"),
      parse: parseCounter,
      initial: { schemaVersion: 1, count: 0 },
      mutate: (prior) => ({ ...prior, count: prior.count + 1 }),
    })).toThrow(/symlink|regular/i)
    expect(fs.readFileSync(outside, "utf8")).toContain("\"count\":7")

    fs.unlinkSync(target)
    fs.symlinkSync(outside, `${target}.lock`)
    expect(() => acquireProtectedLock(target, owner, state("dead"))).toThrow(/symlink|regular/i)
    expect(fs.readFileSync(outside, "utf8")).toContain("\"count\":7")
  })

  it("rejects corrupt or non-canonical prior records without replacement", () => {
    const target = tempTarget()
    fs.writeFileSync(target, "{\"schemaVersion\":1,\"count\":1}", { mode: 0o600 })

    expect(() => readProtectedJson(target, parseCounter)).toThrow(ProtectedStoreCorruptError)
    expect(() => mutateProtectedJson({
      targetPath: target,
      owner,
      proveOwnerState: state("alive"),
      parse: parseCounter,
      initial: { schemaVersion: 1, count: 0 },
      mutate: (prior) => ({ ...prior, count: prior.count + 1 }),
    })).toThrow(ProtectedStoreCorruptError)
    expect(fs.readFileSync(target, "utf8")).toBe("{\"schemaVersion\":1,\"count\":1}")
  })
})
