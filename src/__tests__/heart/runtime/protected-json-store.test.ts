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

function statsWith(stats: fs.Stats, overrides: Partial<Record<"dev" | "ino" | "nlink" | "uid" | "gid" | "mode" | "ctimeMs", number>>): fs.Stats {
  return new Proxy(stats, {
    get(target, property, receiver) {
      if (typeof property === "string" && property in overrides) return overrides[property as keyof typeof overrides]
      return Reflect.get(target, property, receiver)
    },
  })
}

function bigStatsWith(
  stats: fs.BigIntStats,
  overrides: Partial<Record<"dev" | "ino" | "nlink" | "uid" | "gid" | "mode" | "ctimeNs", bigint>>,
): fs.BigIntStats {
  return new Proxy(stats, {
    get(target, property, receiver) {
      if (typeof property === "string" && property in overrides) return overrides[property as keyof typeof overrides]
      return Reflect.get(target, property, receiver)
    },
  })
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

  it("rejects missing records and non-ENOENT filesystem failures", () => {
    const target = tempTarget()
    expect(() => readProtectedJson(target, parseCounter)).toThrow(/missing/i)

    const io: ProtectedStoreIo = {
      ...nodeProtectedStoreIo,
      lstatSync: () => { throw Object.assign(new Error("denied"), { code: "EACCES" }) },
    }
    expect(() => readProtectedJson(target, parseCounter, io)).toThrow("denied")
    const plainFailure: ProtectedStoreIo = {
      ...nodeProtectedStoreIo,
      lstatSync: () => { throw new Error("plain failure") },
    }
    expect(() => readProtectedJson(target, parseCounter, plainFailure)).toThrow("plain failure")
  })

  it("rejects unstable descriptor identity and raw open failures", () => {
    const target = tempTarget()
    fs.writeFileSync(target, "{\"count\":1,\"schemaVersion\":1}", { mode: 0o600 })
    const actual = fs.lstatSync(target)
    let fstatCount = 0
    const changedWhileOpening: ProtectedStoreIo = {
      ...nodeProtectedStoreIo,
      fstatSync: (fd) => {
        fstatCount += 1
        return fstatCount === 1 ? statsWith(fs.fstatSync(fd), { ino: actual.ino + 1 }) : fs.fstatSync(fd)
      },
    }
    expect(() => readProtectedJson(target, parseCounter, changedWhileOpening)).toThrow(/changed while opening/i)

    fstatCount = 0
    const changedWhileReading: ProtectedStoreIo = {
      ...nodeProtectedStoreIo,
      fstatSync: (fd) => {
        fstatCount += 1
        return fstatCount === 2 ? statsWith(fs.fstatSync(fd), { ctimeMs: actual.ctimeMs + 1 }) : fs.fstatSync(fd)
      },
    }
    expect(() => readProtectedJson(target, parseCounter, changedWhileReading)).toThrow(/changed while reading/i)

    const denied: ProtectedStoreIo = {
      ...nodeProtectedStoreIo,
      openSync: () => { throw Object.assign(new Error("denied"), { code: "EACCES" }) },
    }
    expect(() => readProtectedJson(target, parseCounter, denied)).toThrow(/could not be read/i)
  })

  it("rejects malformed lock bytes, schemas, and owners", () => {
    for (const bytes of [
      "not-json",
      "{\"schemaVersion\":1}",
      "{\"owner\":{\"bootId\":\"boot-a\",\"pid\":0,\"startIdentity\":\"start\",\"uid\":501},\"schemaVersion\":1}",
    ]) {
      const target = tempTarget()
      fs.writeFileSync(`${target}.lock`, bytes, { mode: 0o600 })
      expect(() => acquireProtectedLock(target, owner, state("dead"))).toThrow(ProtectedStoreCorruptError)
    }

    const wrongModeTarget = tempTarget()
    fs.writeFileSync(`${wrongModeTarget}.lock`, "{}", { mode: 0o644 })
    expect(() => acquireProtectedLock(wrongModeTarget, owner, state("dead"))).toThrow(/mode 0600/i)
  })

  it("cleans partial lock and temporary writes that fail or make no progress", () => {
    const target = tempTarget()
    let writes = 0
    const noProgress: ProtectedStoreIo = {
      ...nodeProtectedStoreIo,
      writeSync: (fd, buffer, offset, length) => {
        writes += 1
        return writes === 2 ? 0 : nodeProtectedStoreIo.writeSync(fd, buffer, offset, length)
      },
    }
    expect(() => mutateProtectedJson({
      targetPath: target,
      owner,
      proveOwnerState: state("alive"),
      parse: parseCounter,
      initial: { schemaVersion: 1, count: 0 },
      mutate: (prior) => ({ ...prior, count: prior.count + 1 }),
      io: noProgress,
    })).toThrow(/no progress/i)
    expect(fs.readdirSync(path.dirname(target))).toEqual([])

    const deniedTarget = tempTarget()
    const denied: ProtectedStoreIo = {
      ...nodeProtectedStoreIo,
      openSync: (filePath, flags, mode) => {
        if (filePath.endsWith(".lock")) throw Object.assign(new Error("denied"), { code: "EACCES" })
        return nodeProtectedStoreIo.openSync(filePath, flags, mode)
      },
    }
    expect(() => acquireProtectedLock(deniedTarget, owner, state("alive"), denied)).toThrow("denied")
  })

  it("fails closed across exact lock reclaim races", () => {
    const target = tempTarget()
    const held = acquireProtectedLock(target, owner, state("alive"))
    const lockPath = `${target}.lock`
    const replacement = { ...owner, pid: 6161, startIdentity: "darwin-proc:1770000001:000001" }
    let lockLstatCount = 0
    const disappears: ProtectedStoreIo = {
      ...nodeProtectedStoreIo,
      lstatSync: (filePath) => {
        if (filePath === lockPath) {
          lockLstatCount += 1
          if (lockLstatCount === 2) {
            fs.unlinkSync(lockPath)
            throw Object.assign(new Error("gone"), { code: "ENOENT" })
          }
        }
        return nodeProtectedStoreIo.lstatSync(filePath)
      },
    }
    const afterDisappear = acquireProtectedLock(target, replacement, state("dead"), disappears)
    held.release()
    afterDisappear.release()

    const targetChanged = tempTarget()
    acquireProtectedLock(targetChanged, owner, state("alive"))
    let changedLstatCount = 0
    const changed: ProtectedStoreIo = {
      ...nodeProtectedStoreIo,
      lstatSync: (filePath) => {
        const observed = nodeProtectedStoreIo.lstatSync(filePath)
        if (filePath === `${targetChanged}.lock`) {
          changedLstatCount += 1
          if (changedLstatCount === 2) return statsWith(observed, { ino: observed.ino + 1 })
        }
        return observed
      },
    }
    expect(() => acquireProtectedLock(targetChanged, replacement, state("dead"), changed)).toThrow(/changed during reclaim/i)

    const unlinkDeniedTarget = tempTarget()
    acquireProtectedLock(unlinkDeniedTarget, owner, state("alive"))
    const unlinkDenied: ProtectedStoreIo = {
      ...nodeProtectedStoreIo,
      unlinkSync: () => { throw new Error("denied") },
    }
    expect(() => acquireProtectedLock(unlinkDeniedTarget, replacement, state("dead"), unlinkDenied)).toThrow(/could not be reclaimed/i)

    const exhaustedTarget = tempTarget()
    acquireProtectedLock(exhaustedTarget, owner, state("alive"))
    let exhaustedLstatCount = 0
    const exhausted: ProtectedStoreIo = {
      ...nodeProtectedStoreIo,
      lstatSync: (filePath) => {
        if (filePath === `${exhaustedTarget}.lock`) {
          exhaustedLstatCount += 1
          if (exhaustedLstatCount % 2 === 0) throw Object.assign(new Error("gone"), { code: "ENOENT" })
        }
        return nodeProtectedStoreIo.lstatSync(filePath)
      },
    }
    expect(() => acquireProtectedLock(exhaustedTarget, replacement, state("dead"), exhausted)).toThrow(/acquisition raced/i)
  })

  it("detects loss, replacement, or owner drift while a lock is held", () => {
    const releasedTarget = tempTarget()
    const released = acquireProtectedLock(releasedTarget, owner, state("alive"))
    released.release()
    expect(() => released.assertHeld()).toThrow(/released/i)

    const missingTarget = tempTarget()
    const missing = acquireProtectedLock(missingTarget, owner, state("alive"))
    fs.unlinkSync(`${missingTarget}.lock`)
    expect(() => missing.assertHeld()).toThrow(/disappeared/i)
    missing.release()

    const changedTarget = tempTarget()
    const changed = acquireProtectedLock(changedTarget, owner, state("alive"))
    fs.utimesSync(`${changedTarget}.lock`, new Date(0), new Date(0))
    expect(() => changed.assertHeld()).toThrow(/identity changed/i)

    const ownerTarget = tempTarget()
    const ownerLockPath = `${ownerTarget}.lock`
    let substitute = false
    const ownerIo: ProtectedStoreIo = {
      ...nodeProtectedStoreIo,
      readFileSync: (pathOrFd) => substitute
        ? Buffer.from("{\"owner\":{\"bootId\":\"boot-a\",\"pid\":9999,\"startIdentity\":\"other\",\"uid\":501},\"schemaVersion\":1}")
        : nodeProtectedStoreIo.readFileSync(pathOrFd),
    }
    const ownerChanged = acquireProtectedLock(ownerTarget, owner, state("alive"), ownerIo)
    substitute = true
    expect(() => ownerChanged.assertHeld()).toThrow(/owner changed/i)
    ownerChanged.release()
    expect(fs.existsSync(ownerLockPath)).toBe(true)
    fs.unlinkSync(ownerLockPath)
  })

  it("detects target appearance, disappearance, and identity drift before rename", () => {
    const appearedTarget = tempTarget()
    let created = false
    const appeared: ProtectedStoreIo = {
      ...nodeProtectedStoreIo,
      lstatDirectorySync: (directoryPath) => {
        if (!created) {
          created = true
          fs.writeFileSync(appearedTarget, "{\"count\":9,\"schemaVersion\":1}", { mode: 0o600 })
        }
        return nodeProtectedStoreIo.lstatDirectorySync(directoryPath)
      },
    }
    expect(() => mutateProtectedJson({
      targetPath: appearedTarget, owner, proveOwnerState: state("alive"), parse: parseCounter,
      initial: { schemaVersion: 1, count: 0 }, mutate: (prior) => prior, io: appeared,
    })).toThrow(/appeared/i)

    const driftTarget = tempTarget()
    const unrelated = path.join(path.dirname(driftTarget), "unrelated")
    let drifted = false
    const drift: ProtectedStoreIo = {
      ...nodeProtectedStoreIo,
      fsyncSync: (fd) => {
        nodeProtectedStoreIo.fsyncSync(fd)
        if (!fs.fstatSync(fd).isDirectory() && !drifted) {
          drifted = true
          fs.writeFileSync(unrelated, "drift")
        }
      },
    }
    expect(() => mutateProtectedJson({
      targetPath: driftTarget, owner, proveOwnerState: state("alive"), parse: parseCounter,
      initial: { schemaVersion: 1, count: 0 }, mutate: (prior) => prior, io: drift,
    })).toThrow(/parent identity/i)
    fs.unlinkSync(unrelated)

    for (const mode of ["missing", "changed"] as const) {
      const target = tempTarget()
      fs.writeFileSync(target, "{\"count\":1,\"schemaVersion\":1}", { mode: 0o600 })
      let targetLstatCount = 0
      const io: ProtectedStoreIo = {
        ...nodeProtectedStoreIo,
        lstatSync: (filePath) => {
          if (filePath === target) {
            targetLstatCount += 1
            if (targetLstatCount === 3) {
              if (mode === "missing") {
                fs.unlinkSync(target)
                throw Object.assign(new Error("gone"), { code: "ENOENT" })
              }
              const observed = nodeProtectedStoreIo.lstatSync(filePath)
              return statsWith(observed, { ino: observed.ino + 1 })
            }
          }
          return nodeProtectedStoreIo.lstatSync(filePath)
        },
      }
      expect(() => mutateProtectedJson({
        targetPath: target, owner, proveOwnerState: state("alive"), parse: parseCounter,
        initial: { schemaVersion: 1, count: 0 }, mutate: (prior) => ({ ...prior, count: 2 }), io,
      })).toThrow(mode === "missing" ? /disappeared/i : /changed/i)
    }
  })

  it("keeps cleanup idempotent when close and unlink report post-effect errors", () => {
    const target = tempTarget()
    let tempFsynced = false
    let closeFailureReported = false
    const io: ProtectedStoreIo = {
      ...nodeProtectedStoreIo,
      fsyncSync: (fd) => {
        tempFsynced = !fs.fstatSync(fd).isDirectory()
        if (tempFsynced) throw new Error("stop after temp write")
        nodeProtectedStoreIo.fsyncSync(fd)
      },
      closeSync: (fd) => {
        nodeProtectedStoreIo.closeSync(fd)
        if (tempFsynced && !closeFailureReported) {
          closeFailureReported = true
          throw new Error("reported close failure")
        }
      },
      unlinkSync: (filePath) => {
        nodeProtectedStoreIo.unlinkSync(filePath)
        if (filePath.includes(".tmp-")) throw new Error("reported unlink failure")
      },
    }
    expect(() => mutateProtectedJson({
      targetPath: target, owner, proveOwnerState: state("alive"), parse: parseCounter,
      initial: { schemaVersion: 1, count: 0 }, mutate: (prior) => prior, io,
    })).toThrow(/temp write/i)
    expect(fs.readdirSync(path.dirname(target))).toEqual([])
  })

  it("updates an existing unchanged record through the same atomic path", () => {
    const target = tempTarget()
    fs.writeFileSync(target, "{\"count\":1,\"schemaVersion\":1}", { mode: 0o600 })
    expect(mutateProtectedJson({
      targetPath: target, owner, proveOwnerState: state("alive"), parse: parseCounter,
      initial: { schemaVersion: 1, count: 0 }, mutate: (prior) => ({ ...prior, count: prior.count + 1 }),
    })).toEqual({ schemaVersion: 1, count: 2 })
  })

  it("rejects symlinked, invalid, or swapped parent directories", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ouro-protected-parent-"))
    roots.push(root)
    const realParent = path.join(root, "real")
    const linkedParent = path.join(root, "linked")
    fs.mkdirSync(realParent)
    fs.symlinkSync(realParent, linkedParent)
    const linkedTarget = path.join(linkedParent, "state.json")
    expect(() => mutateProtectedJson({
      targetPath: linkedTarget, owner, proveOwnerState: state("alive"), parse: parseCounter,
      initial: { schemaVersion: 1, count: 0 }, mutate: (prior) => prior,
    })).toThrow(/real directory/i)

    for (const variant of ["zero-link", "open-swap", "refresh-swap"] as const) {
      const target = tempTarget()
      let descriptorReads = 0
      const io: ProtectedStoreIo = {
        ...nodeProtectedStoreIo,
        lstatDirectorySync: (directoryPath) => {
          const observed = nodeProtectedStoreIo.lstatDirectorySync(directoryPath)
          return variant === "zero-link" ? bigStatsWith(observed, { nlink: 0n }) : observed
        },
        fstatDirectorySync: (fd) => {
          descriptorReads += 1
          const observed = nodeProtectedStoreIo.fstatDirectorySync(fd)
          if (variant === "open-swap" && descriptorReads === 1) return bigStatsWith(observed, { ino: observed.ino + 1n })
          if (variant === "refresh-swap" && descriptorReads === 2) return bigStatsWith(observed, { uid: observed.uid + 1n })
          return observed
        },
      }
      expect(() => mutateProtectedJson({
        targetPath: target, owner, proveOwnerState: state("alive"), parse: parseCounter,
        initial: { schemaVersion: 1, count: 0 }, mutate: (prior) => prior, io,
      })).toThrow(/parent/i)
      expect(fs.readdirSync(path.dirname(target))).toEqual([])
    }
  })
})
