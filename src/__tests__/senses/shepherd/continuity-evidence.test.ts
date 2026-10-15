import { createHash } from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  reserveContinuityReceiptSlot, readContinuityReceipt, verifyContinuityCheckpoint,
  continuityEvidenceAssurance,
} from "../../../senses/shepherd/continuity-evidence"
import type { ContinuityBinding, ContinuityReceipt } from "../../../senses/shepherd/continuity-types"

function fixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "continuity-evidence-")))
  const stat = fs.statSync(root)
  const binding: ContinuityBinding = {
    id: "binding1", agent: "ouro", host: "cmux", incarnation: "host1", surfaceId: "surface1",
    surfaceGeneration: "generation1", nativeSessionId: "native1", runner: "copilot",
    process: { pid: 100, birth: "1:1234", uid: process.getuid!() }, wrapper: null,
    launchCwd: root, worktree: root, rootId: "desk", taskRef: "track/task", taskKey: `${root}:track/task`,
    root: { id: "desk", path: root, namespace: "track", receiptBase: ".receipts",
      launchRoots: [root], worktreeRoots: [root], identity: { dev: stat.dev, ino: stat.ino } },
    profileId: null, profileFingerprint: null, configFingerprint: "a".repeat(64), enrollmentEpoch: "epoch1",
  }
  const slot = reserveContinuityReceiptSlot(binding, "batch1", 1, "followup", "attempt1")
  fs.mkdirSync(path.dirname(slot.path), { recursive: true, mode: 0o700 })
  const checkpoint = {
    goal: "Ship safely", scope: "This task", decisions: ["Preserve work"], nextAction: "Run the targeted test",
    knownJobs: [], uncertainMutations: [], references: ["task.md"],
  }
  const checkpointFile = path.join(root, "track/task/checkpoint.json")
  fs.mkdirSync(path.dirname(checkpointFile), { recursive: true, mode: 0o700 })
  fs.writeFileSync(checkpointFile, JSON.stringify(checkpoint), { mode: 0o600 })
  const receipt: ContinuityReceipt = {
    ...slot.correlation, checkpoint: { rootId: "desk", relativePath: "track/task/checkpoint.json",
      sha256: createHash("sha256").update(fs.readFileSync(checkpointFile)).digest("hex") },
    task: { ref: binding.taskRef, rootId: "desk", launchCwd: root, worktree: root,
      branch: "worker/test", head: "b".repeat(40), nextAction: checkpoint.nextAction },
    confirmation: true, knownJobs: [], uncertainMutations: [],
  }
  const write = () => fs.writeFileSync(slot.path, JSON.stringify(receipt), { mode: 0o600 })
  write()
  const verify = () => verifyContinuityCheckpoint(readContinuityReceipt(slot, slot.correlation), binding)
  return { root, binding, slot, checkpoint, checkpointFile, receipt, write, verify }
}

describe("fixed-slot continuity evidence", () => {
  afterEach(() => vi.restoreAllMocks())
  it("reserves independent fixed slots only from the frozen root and returns a bounded projection", () => {
    const f = fixture()
    expect(f.slot.path).toBe(path.join(f.root, ".receipts/batch1/binding1/1-followup-attempt1.json"))
    const other = reserveContinuityReceiptSlot(f.binding, "batch1", 1, "correction", "attempt2")
    expect(other.correlation.nonce).not.toBe(f.slot.correlation.nonce)
    expect(f.verify()).toMatchObject({ goal: "Ship safely", nextAction: f.checkpoint.nextAction,
      checkpointSha256: f.receipt.checkpoint.sha256, knownJobs: [], references: ["task.md"] })
  })
  it.each(["batchId", "bindingId", "generation", "round", "nonce", "launchAttemptId"] as const)(
    "rejects wrong %s correlation", field => {
      const f = fixture()
      Object.assign(f.receipt, { [field]: field === "generation" ? 2 : field === "round" ? "preparation" : "wrong" })
      f.write()
      expect(() => f.verify()).toThrow(/correlation/)
    })
  it("rejects substituted slots and changed expected correlation", () => {
    const f = fixture()
    expect(() => readContinuityReceipt({ ...f.slot, path: f.checkpointFile }, f.slot.correlation)).toThrow(/slot/)
    expect(() => readContinuityReceipt(f.slot, { ...f.slot.correlation, nonce: "wrong" })).toThrow(/correlation/)
  })
  it.each(["../outside", "/absolute", "a//b", "a/./b", "a\\b", "track/other/checkpoint.json"])(
    "rejects checkpoint escape or different task %s", relativePath => {
      const f = fixture()
      f.receipt.checkpoint.relativePath = relativePath
      f.write()
      expect(() => f.verify()).toThrow()
    })
  it.each(["batch/escape", "", "..", "bad\n"])("rejects unsafe slot components %s", batchId => {
    const f = fixture()
    expect(() => reserveContinuityReceiptSlot(f.binding, batchId, 1, "followup", "attempt1")).toThrow()
  })
  it("rejects unknown kinds, invalid generations and inconsistent frozen root", () => {
    const f = fixture()
    for (const generation of [0, -1, NaN, 1.5]) {
      expect(() => reserveContinuityReceiptSlot(f.binding, "batch1", generation, "followup", "attempt1")).toThrow()
    }
    expect(() => reserveContinuityReceiptSlot(f.binding, "batch1", 1, "unknown", "attempt1")).toThrow()
    expect(() => reserveContinuityReceiptSlot({ ...f.binding, rootId: "other" }, "batch1", 1, "followup", "attempt1")).toThrow()
  })
  it.each(["receipt", "checkpoint", "ancestor", "root"])("rejects symlink %s", target => {
    const f = fixture()
    const original = target === "receipt" ? f.slot.path : target === "checkpoint" ? f.checkpointFile
      : target === "ancestor" ? path.dirname(f.checkpointFile) : f.root
    fs.renameSync(original, `${original}-moved`)
    fs.symlinkSync(`${original}-moved`, original)
    expect(() => f.verify()).toThrow()
  })
  it.each(["receipt", "checkpoint"])("rejects hard-linked or absent %s", target => {
    const f = fixture()
    const file = target === "receipt" ? f.slot.path : f.checkpointFile
    fs.linkSync(file, `${file}-alias`)
    expect(() => f.verify()).toThrow()
    fs.renameSync(file, `${file}-moved`)
    expect(() => f.verify()).toThrow()
  })
  it.each(["receipt", "checkpoint"])("rejects writable or nonregular %s", target => {
    const f = fixture()
    const file = target === "receipt" ? f.slot.path : f.checkpointFile
    fs.chmodSync(file, 0o666)
    expect(() => f.verify()).toThrow()
    fs.renameSync(file, `${file}-moved`)
    fs.mkdirSync(file)
    expect(() => f.verify()).toThrow()
  })
  it.each(["root", "file", "content"])("rejects %s replacement during descriptor reads", target => {
    const f = fixture()
    const original = fs.readSync
    let swapped = false
    vi.spyOn(fs, "readSync").mockImplementation((...args: Parameters<typeof fs.readSync>) => {
      const result = Reflect.apply(original, fs, args)
      if (!swapped) {
        swapped = true
        const file = target === "root" ? f.root : f.slot.path
        if (target === "content") fs.appendFileSync(file, " ")
        else {
          fs.renameSync(file, `${file}-moved`)
          if (target === "root") fs.mkdirSync(file, { mode: 0o700 })
          else fs.writeFileSync(file, JSON.stringify(f.receipt), { mode: 0o600 })
        }
      }
      return result
    })
    expect(() => f.verify()).toThrow(/changed/)
  })
  it.each([16384, 16385])("enforces receipt byte boundary %s", bytes => {
    const f = fixture()
    const content = JSON.stringify(f.receipt)
    fs.writeFileSync(f.slot.path, content + " ".repeat(bytes - Buffer.byteLength(content)))
    if (bytes === 16384) expect(f.verify().goal).toBe("Ship safely")
    else expect(() => f.verify()).toThrow(/limit/)
  })
  it.each([65536, 65537])("enforces checkpoint byte boundary %s", bytes => {
    const f = fixture()
    const content = JSON.stringify(f.checkpoint)
    fs.writeFileSync(f.checkpointFile, content + " ".repeat(bytes - Buffer.byteLength(content)))
    f.receipt.checkpoint.sha256 = createHash("sha256").update(fs.readFileSync(f.checkpointFile)).digest("hex")
    f.write()
    if (bytes === 65536) expect(f.verify().goal).toBe("Ship safely")
    else expect(() => f.verify()).toThrow(/limit/)
  })
  it.each(["ref", "rootId", "launchCwd", "worktree"])("rejects mismatched task %s", field => {
    const f = fixture()
    Object.assign(f.receipt.task, { [field]: "other" })
    f.write()
    expect(() => f.verify()).toThrow(/binding/)
  })
  it("rejects wrong hashes, missing next actions, schema additions and unknown checkpoint fields", () => {
    const f = fixture()
    f.receipt.checkpoint.sha256 = "0".repeat(64)
    f.write()
    expect(() => f.verify()).toThrow(/hash/)
    f.receipt.task.nextAction = ""
    f.write()
    expect(() => f.verify()).toThrow()
    fs.writeFileSync(f.slot.path, JSON.stringify({ ...f.receipt, token: "hidden" }))
    expect(() => f.verify()).toThrow()
  })
  it("requires structured bounded handoff evidence and consistent preserved inventories", () => {
    const f = fixture()
    fs.writeFileSync(f.checkpointFile, JSON.stringify({ ...f.checkpoint, rawLogs: "do not project" }))
    f.receipt.checkpoint.sha256 = createHash("sha256").update(fs.readFileSync(f.checkpointFile)).digest("hex")
    f.write()
    expect(() => f.verify()).toThrow(/projection/)
    fs.writeFileSync(f.checkpointFile, JSON.stringify({ ...f.checkpoint, nextAction: "different" }))
    f.receipt.checkpoint.sha256 = createHash("sha256").update(fs.readFileSync(f.checkpointFile)).digest("hex")
    f.write()
    expect(() => f.verify()).toThrow(/inventory|action/)
  })
  it("redacts narrative credentials before projection and refuses secret-bearing authority", () => {
    const f = fixture()
    f.checkpoint.decisions = ["password=not-a-real-secret"]
    fs.writeFileSync(f.checkpointFile, JSON.stringify(f.checkpoint))
    f.receipt.checkpoint.sha256 = createHash("sha256").update(fs.readFileSync(f.checkpointFile)).digest("hex")
    f.write()
    expect(JSON.stringify(f.verify())).not.toContain("not-a-real-secret")
    f.receipt.task.ref = "token=not-a-real-secret"
    f.write()
    expect(() => f.verify()).toThrow()
  })
  it("qualifies confirmation with unknown native coverage, preserves independent jobs and blocks unsafe omissions", () => {
    const f = fixture()
    const projection = f.verify()
    expect(continuityEvidenceAssurance(f.receipt, projection, { round: "followup", observedAt: "2026-10-15T04:00:00Z" }))
      .toMatchObject({ checkpoint: "verified", endReadiness: "agent-confirmed-as-of-native-boundary",
        backgroundCoverage: "unknown", jobInventory: "preserved-agent-reported", reopen: "unverified" })
    const job = { id: "ci1", kind: "CI", owner: "CI-service", effects: "read-only tests",
      status: "running", disposition: "independent", reference: "owner/repo#1" }
    f.receipt.knownJobs = [job]
    Object.assign(f.checkpoint, { knownJobs: [job] })
    fs.writeFileSync(f.checkpointFile, JSON.stringify(f.checkpoint))
    f.receipt.checkpoint.sha256 = createHash("sha256").update(fs.readFileSync(f.checkpointFile)).digest("hex")
    f.write()
    expect(f.verify().knownJobs).toEqual([job])
    expect(continuityEvidenceAssurance(f.receipt, f.verify(), { round: "followup", observedAt: "now", knownUnsafeJobIds: ["missing"] }).endReadiness).toBe("unconfirmed")
    f.receipt.confirmation = false
    expect(continuityEvidenceAssurance(f.receipt, projection, { round: "preparation", observedAt: "now" }).endReadiness).toBe("unconfirmed")
  })
  it("does not upgrade running unsafe jobs or unresolved mutations to readiness", () => {
    const f = fixture()
    const job = { id: "job1", kind: "watcher", owner: "source", effects: "writes",
      status: "running", disposition: "unsafe", reference: "job.json" }
    const projection = { ...f.verify(), knownJobs: [job] }
    f.receipt.knownJobs = [job]
    expect(continuityEvidenceAssurance(f.receipt, projection, { round: "followup", observedAt: "now" }).endReadiness).toBe("unconfirmed")
    const mutation = { id: "write1", operation: "publish", disposition: "unknown", evidence: "reconcile before retry" }
    f.receipt.knownJobs = []
    f.receipt.uncertainMutations = [mutation]
    expect(continuityEvidenceAssurance(f.receipt, { ...projection, knownJobs: [], uncertainMutations: [mutation] },
      { round: "correction", observedAt: "now" }).endReadiness).toBe("unconfirmed")
  })
  it("reserves bootstrap and execute slots with exact launch attempt correlation", () => {
    const f = fixture()
    for (const kind of ["bootstrap", "execute"]) {
      expect(reserveContinuityReceiptSlot(f.binding, "batch1", 1, kind, "launch1").correlation.launchAttemptId).toBe("launch1")
    }
  })
  it("rejects mutated frozen bindings and omitted known inventories", () => {
    const f = fixture()
    const verified = readContinuityReceipt(f.slot, f.slot.correlation)
    expect(() => verifyContinuityCheckpoint(verified, { ...f.binding, configFingerprint: "b".repeat(64) })).toThrow(/binding/)
    f.receipt.knownJobs = [
      { id: "job", kind: "watcher", owner: "source", effects: "writes", status: "running", disposition: "unsafe", reference: "job.json" },
    ]
    f.write()
    expect(() => f.verify()).toThrow(/inventory/)
    f.receipt.knownJobs.push(f.receipt.knownJobs[0])
    f.write()
    expect(() => f.verify()).toThrow(/duplicate/)
  })
  it.each(["namespace", "launch", "worktree", "identity", "root-path", "missing-root"])("rejects invalid frozen %s authority", field => {
    const f = fixture()
    if (field === "namespace") f.binding.root.namespace = "other"
    if (field === "launch") f.binding.root.launchRoots = []
    if (field === "worktree") f.binding.root.worktreeRoots = []
    if (field === "identity") f.binding.root.identity.ino++
    if (field === "root-path") f.binding.root.path += "/.."
    if (field === "missing-root") Object.assign(f.binding, { root: null })
    expect(() => {
      const slot = reserveContinuityReceiptSlot(f.binding, "batch1", 1, "followup", "attempt1")
      readContinuityReceipt(slot, slot.correlation)
    }).toThrow()
  })
  it("rejects unsafe descriptor identity and an open-time replacement", () => {
    const f = fixture()
    const lstat = fs.lstatSync
    vi.spyOn(fs, "lstatSync").mockImplementation((...args: Parameters<typeof fs.lstatSync>) => {
      const stat = Reflect.apply(lstat, fs, args)
      if (String(args[0]) === f.slot.path) stat.ino = Number.MAX_SAFE_INTEGER + 1
      return stat
    })
    expect(() => f.verify()).toThrow(/inexact/)
    vi.restoreAllMocks()
    const open = fs.openSync
    let swapped = false
    vi.spyOn(fs, "openSync").mockImplementation((...args: Parameters<typeof fs.openSync>) => {
      if (!swapped && String(args[0]) === f.slot.path) {
        swapped = true
        fs.renameSync(f.slot.path, `${f.slot.path}-moved`)
        f.write()
      }
      return Reflect.apply(open, fs, args)
    })
    expect(() => f.verify()).toThrow(/opened descriptor/)
  })
  it("rejects a descriptor growing beyond the limit during a short read", () => {
    const f = fixture()
    const original = fs.readSync
    let changed = false
    vi.spyOn(fs, "readSync").mockImplementation((...args: Parameters<typeof fs.readSync>) => {
      if (!changed) {
        changed = true
        fs.appendFileSync(f.slot.path, " ".repeat(16385))
      }
      return Reflect.apply(original, fs, args)
    })
    expect(() => f.verify()).toThrow(/limit/)
  })
  it("rejects non-UTF8 and malformed JSON without exposing raw evidence", () => {
    const f = fixture()
    fs.writeFileSync(f.slot.path, Buffer.from([0xff]))
    expect(() => f.verify()).toThrow(/UTF-8/)
    fs.writeFileSync(f.slot.path, "invalid private evidence")
    expect(() => f.verify()).toThrow("invalid evidence JSON")
  })
  it("uses an explicitly injected local filesystem for bounded reads", () => {
    const f = fixture()
    const verified = readContinuityReceipt(f.slot, f.slot.correlation, { filesystem: fs })
    expect(verifyContinuityCheckpoint(verified, f.binding, { filesystem: fs }).goal).toBe(f.checkpoint.goal)
  })
  it("rejects unowned evidence and changed intermediate directory permissions", () => {
    const f = fixture()
    const lstat = fs.lstatSync
    vi.spyOn(fs, "lstatSync").mockImplementation((...args: Parameters<typeof fs.lstatSync>) => {
      const stat = Reflect.apply(lstat, fs, args)
      if (String(args[0]) === f.slot.path) stat.uid = process.getuid!() + 100
      return stat
    })
    expect(() => f.verify()).toThrow(/untrusted/)
    vi.restoreAllMocks()
    const read = fs.readSync
    let swapped = false
    vi.spyOn(fs, "readSync").mockImplementation((...args: Parameters<typeof fs.readSync>) => {
      const result = Reflect.apply(read, fs, args)
      if (!swapped) {
        swapped = true
        fs.chmodSync(path.dirname(f.slot.path), 0o750)
      }
      return result
    })
    expect(() => f.verify()).toThrow(/path identity changed/)
  })
  it("rejects noncanonical cwd/worktree and unsafe receipt-base authority", () => {
    const f = fixture()
    expect(() => reserveContinuityReceiptSlot({ ...f.binding, launchCwd: `${f.root}/../outside` },
      "batch1", 1, "followup", "attempt1")).toThrow(/binding/)
    expect(() => reserveContinuityReceiptSlot({ ...f.binding, worktree: `${f.root}/./code` },
      "batch1", 1, "followup", "attempt1")).toThrow(/binding/)
    f.binding.root.receiptBase = "token=not-a-real-secret"
    expect(() => reserveContinuityReceiptSlot(f.binding, "batch1", 1, "followup", "attempt1")).toThrow(/binding/)
  })
  it("requires the receipt's final round and noncontradictory job disposition", () => {
    const f = fixture()
    const projection = f.verify()
    f.receipt.round = "preparation"
    expect(continuityEvidenceAssurance(f.receipt, projection, { round: "followup", observedAt: "now" }).endReadiness).toBe("unconfirmed")
    f.receipt.round = "followup"
    const job = { id: "job", kind: "watcher", owner: "source", effects: "writes", status: "running",
      disposition: "stopped", reference: "job.json" }
    f.receipt.knownJobs = [job]
    expect(continuityEvidenceAssurance(f.receipt, { ...projection, knownJobs: [job] },
      { round: "followup", observedAt: "now" }).endReadiness).toBe("unconfirmed")
  })
  it("enforces the projection byte limit after credential redaction expansion", () => {
    const f = fixture()
    const document = { ...f.checkpoint, decisions: Array.from({ length: 20 }, () => "token=x ".repeat(400).trim()) }
    fs.writeFileSync(f.checkpointFile, JSON.stringify(document))
    f.receipt.checkpoint.sha256 = createHash("sha256").update(fs.readFileSync(f.checkpointFile)).digest("hex")
    f.write()
    expect(() => f.verify()).toThrow(/projection byte limit/)
  })
  it("refuses redaction expansion that no longer fits the receipt schema", () => {
    const f = fixture()
    f.receipt.task.nextAction = "token=x ".repeat(400).trim()
    f.write()
    expect(() => readContinuityReceipt(f.slot, f.slot.correlation)).toThrow(/redacted receipt/)
    f.receipt.task.nextAction = f.checkpoint.nextAction
    f.receipt.knownJobs = Array.from({ length: 12 }, (_, index) => ({
      id: `job${index}`, kind: "CI", owner: "service", effects: "token=x ".repeat(100).trim(),
      status: "running", disposition: "independent", reference: "job.json",
    }))
    f.write()
    expect(() => readContinuityReceipt(f.slot, f.slot.correlation)).toThrow(/redacted receipt/)
  })
  it("rejects nanosecond descriptor changes even when rounded millisecond metadata is identical", () => {
    const f = fixture()
    const original = fs.fstatSync
    let calls = 0
    vi.spyOn(fs, "fstatSync").mockImplementation((...args: Parameters<typeof fs.fstatSync>) => {
      const stat = Reflect.apply(original, fs, args)
      if (++calls === 2) Object.assign(stat, { ctimeNs: typeof stat.ctimeNs === "bigint" ? stat.ctimeNs + 1n : 1n })
      return stat
    })
    expect(() => f.verify()).toThrow(/changed/)
  })
})
