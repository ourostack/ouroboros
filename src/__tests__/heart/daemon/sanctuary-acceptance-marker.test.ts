import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

import { afterEach, describe, expect, it, vi } from "vitest"

const root = fs.mkdtempSync(path.join(os.tmpdir(), "ouro-acceptance-marker-"))
const fsFaults = vi.hoisted(() => ({
  readFileError: null as Error | null,
  lstatCall: 0,
  lstatErrorAt: 0,
  lstatMutationAt: 0,
  fstatCall: 0,
  fstatMutationAt: 0,
  mutation: "" as "" | "not-directory" | "not-file" | "inode",
}))
const childFaults = vi.hoisted(() => ({ mode: "" as "" | "error" | "status" }))

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs")
  return {
    ...actual,
    readFileSync: ((...args: Parameters<typeof actual.readFileSync>) => {
      if (fsFaults.readFileError) throw fsFaults.readFileError
      return actual.readFileSync(...args)
    }) as typeof actual.readFileSync,
    lstatSync: ((...args: Parameters<typeof actual.lstatSync>) => {
      fsFaults.lstatCall += 1
      if (fsFaults.lstatCall === fsFaults.lstatErrorAt) throw Object.assign(new Error("lstat denied"), { code: "EACCES" })
      const value = actual.lstatSync(...args)
      if (fsFaults.lstatCall !== fsFaults.lstatMutationAt) return value
      if (fsFaults.mutation === "inode") return Object.assign(Object.create(value), { ino: Number(value.ino) + 1 }) as fs.Stats
      if (fsFaults.mutation === "not-directory") return Object.assign(Object.create(value), { isDirectory: () => false }) as fs.Stats
      return Object.assign(Object.create(value), { isFile: () => false }) as fs.Stats
    }) as typeof actual.lstatSync,
    fstatSync: ((...args: Parameters<typeof actual.fstatSync>) => {
      fsFaults.fstatCall += 1
      const value = actual.fstatSync(...args)
      if (fsFaults.fstatCall !== fsFaults.fstatMutationAt) return value
      if (fsFaults.mutation === "inode") return Object.assign(Object.create(value), { ino: Number(value.ino) + 1 }) as fs.Stats
      if (fsFaults.mutation === "not-directory") return Object.assign(Object.create(value), { isDirectory: () => false }) as fs.Stats
      return Object.assign(Object.create(value), { isFile: () => false }) as fs.Stats
    }) as typeof actual.fstatSync,
  }
})

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process")
  return {
    ...actual,
    spawnSync: ((...args: Parameters<typeof actual.spawnSync>) => {
      if (childFaults.mode === "error") return { error: new Error("spawn failed"), status: null }
      if (childFaults.mode === "status") return { status: 1 }
      return actual.spawnSync(...args)
    }) as typeof actual.spawnSync,
  }
})

vi.mock("../../../heart/identity", () => ({
  getAgentRoot: (agentName: string) => path.join(root, `${agentName}.ouro`),
}))

import {
  boundDirectoryEntryPath,
  clearSanctuaryAcceptanceMarker,
  clearSanctuaryAcceptanceGateStatus,
  publishSanctuaryAcceptanceGateStatus,
  quarantineSanctuaryAcceptanceMarker,
  readSanctuaryAcceptanceApproval,
  readSanctuaryAcceptanceMarker,
  runWithSanctuaryAcceptanceApproval,
  secureRenameBoundInodeSync,
  sanctuaryAcceptanceEventMeta,
  writeSanctuaryAcceptanceMarker,
} from "../../../heart/daemon/sanctuary-acceptance-marker"

afterEach(() => {
  fsFaults.readFileError = null
  fsFaults.lstatCall = 0
  fsFaults.lstatErrorAt = 0
  fsFaults.lstatMutationAt = 0
  fsFaults.fstatCall = 0
  fsFaults.fstatMutationAt = 0
  fsFaults.mutation = ""
  childFaults.mode = ""
  fs.rmSync(path.join(root, "sanctuary.ouro"), { recursive: true, force: true })
})

describe("Sanctuary acceptance marker", () => {
  it("validates bound entry basenames", () => {
    expect(boundDirectoryEntryPath(7, "/tmp/safe", "entry")).toMatch(/entry$/u)
    for (const name of ["", ".", "..", "a/b", "/", "a\0b"]) {
      expect(() => boundDirectoryEntryPath(7, "/tmp/safe", name)).toThrow("basenames")
    }
    const descriptor = Object.getOwnPropertyDescriptor(process, "platform")!
    Object.defineProperty(process, "platform", { value: "linux", configurable: true })
    expect(boundDirectoryEntryPath(7, "/tmp/safe", "entry")).toBe("/proc/self/fd/7/entry")
    Object.defineProperty(process, "platform", descriptor)
  })

  it.each(["error", "status"] as const)("fails closed when the bound rename helper reports %s", (mode) => {
    childFaults.mode = mode
    expect(() => secureRenameBoundInodeSync(3, "source", 4, "destination", { dev: 1, ino: 2 })).toThrow("bound rename failed")
  })

  it("atomically publishes only the redacted scenario digest and enforces ownership on clear", () => {
    const marker = {
      schemaVersion: "sanctuary-acceptance-marker-v1" as const,
      label: "approval-suspend",
      scenarioHandleDigest: "a".repeat(64),
      startedAt: "2026-08-20T12:00:00.000Z",
    }
    writeSanctuaryAcceptanceMarker("sanctuary", marker)

    expect(readSanctuaryAcceptanceMarker("sanctuary")).toEqual(marker)
    expect(sanctuaryAcceptanceEventMeta("sanctuary")).toEqual({ scenarioHandleDigest: "a".repeat(64) })
    expect(fs.statSync(path.join(root, "sanctuary.ouro", "state", "acceptance", "active-scenario.json")).mode & 0o777).toBe(0o600)
    expect(() => clearSanctuaryAcceptanceMarker("sanctuary", "b".repeat(64))).toThrow("ownership mismatch")
    clearSanctuaryAcceptanceMarker("sanctuary", "a".repeat(64))
    expect(readSanctuaryAcceptanceMarker("sanctuary")).toBeNull()
  })

  it("does not read or publish markers for other agents", () => {
    expect(readSanctuaryAcceptanceMarker("slugger")).toBeNull()
    expect(sanctuaryAcceptanceEventMeta("slugger")).toEqual({})
    expect(() => writeSanctuaryAcceptanceMarker("slugger", {
      schemaVersion: "sanctuary-acceptance-marker-v1",
      label: "wrong-agent",
      scenarioHandleDigest: "c".repeat(64),
      startedAt: "2026-08-20T12:00:00.000Z",
    })).toThrow("restricted")
  })

  it("rejects corrupt marker encodings and invalid clear digests", () => {
    const filePath = path.join(root, "sanctuary.ouro", "state", "acceptance", "active-scenario.json")
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    for (const value of [
      null,
      [],
      {},
      { schemaVersion: "wrong", label: "x", scenarioHandleDigest: "a".repeat(64), startedAt: "2026-08-20T12:00:00.000Z" },
      { schemaVersion: "sanctuary-acceptance-marker-v1", label: "", scenarioHandleDigest: "a".repeat(64), startedAt: "2026-08-20T12:00:00.000Z" },
      { schemaVersion: "sanctuary-acceptance-marker-v1", label: "x", scenarioHandleDigest: "bad", startedAt: "2026-08-20T12:00:00.000Z" },
      { schemaVersion: "sanctuary-acceptance-marker-v1", label: "x", scenarioHandleDigest: "a".repeat(64), startedAt: "bad" },
    ]) {
      fs.writeFileSync(filePath, JSON.stringify(value))
      expect(() => readSanctuaryAcceptanceMarker("sanctuary")).toThrow()
    }
    expect(() => clearSanctuaryAcceptanceMarker("sanctuary", "bad")).toThrow("invalid")
    fs.rmSync(filePath, { force: true })
    clearSanctuaryAcceptanceMarker("sanctuary", "a".repeat(64))
  })

  it("propagates non-absence marker read failures", () => {
    fsFaults.readFileError = Object.assign(new Error("denied"), { code: "EACCES" })
    expect(() => readSanctuaryAcceptanceMarker("sanctuary")).toThrow("denied")
  })

  it("quarantines a bound regular marker and treats absence as empty", () => {
    const marker = {
      schemaVersion: "sanctuary-acceptance-marker-v1" as const,
      label: "quarantine",
      scenarioHandleDigest: "d".repeat(64),
      startedAt: "2026-08-20T12:00:00.000Z",
    }
    expect(quarantineSanctuaryAcceptanceMarker("sanctuary")).toBeNull()
    expect(() => quarantineSanctuaryAcceptanceMarker("slugger")).toThrow("restricted")
    writeSanctuaryAcceptanceMarker("sanctuary", marker)
    const quarantined = quarantineSanctuaryAcceptanceMarker("sanctuary")
    expect(quarantined).toMatch(/quarantine\/active-scenario-.*\.json$/u)
    expect(fs.existsSync(quarantined!)).toBe(true)
    expect(readSanctuaryAcceptanceMarker("sanctuary")).toBeNull()
  })

  it("re-homes a hostile non-directory quarantine entry before moving the marker", () => {
    const marker = {
      schemaVersion: "sanctuary-acceptance-marker-v1" as const,
      label: "hostile-quarantine",
      scenarioHandleDigest: "f".repeat(64),
      startedAt: "2026-08-20T12:00:00.000Z",
    }
    writeSanctuaryAcceptanceMarker("sanctuary", marker)
    const quarantineRoot = path.join(root, "sanctuary.ouro", "state", "acceptance", "quarantine")
    fs.writeFileSync(quarantineRoot, "hostile")
    const quarantined = quarantineSanctuaryAcceptanceMarker("sanctuary")!
    expect(fs.readFileSync(quarantined, "utf8")).toContain("hostile-quarantine")
    const entries = fs.readdirSync(quarantineRoot)
    expect(entries.some((entry) => entry.startsWith("quarantine-rejected-"))).toBe(true)
  })

  it("uses an existing quarantine directory", () => {
    writeSanctuaryAcceptanceMarker("sanctuary", {
      schemaVersion: "sanctuary-acceptance-marker-v1", label: "existing", scenarioHandleDigest: "1".repeat(64), startedAt: "2026-08-20T12:00:00.000Z",
    })
    fs.mkdirSync(path.join(root, "sanctuary.ouro", "state", "acceptance", "quarantine"))
    expect(fs.existsSync(quarantineSanctuaryAcceptanceMarker("sanctuary")!)).toBe(true)
  })

  it("quarantines a symlink marker without opening or syncing its target", () => {
    const acceptanceRoot = path.join(root, "sanctuary.ouro", "state", "acceptance")
    fs.mkdirSync(acceptanceRoot, { recursive: true })
    const target = path.join(root, "outside-marker")
    fs.writeFileSync(target, "outside")
    fs.symlinkSync(target, path.join(acceptanceRoot, "active-scenario.json"))
    expect(fs.lstatSync(quarantineSanctuaryAcceptanceMarker("sanctuary")!).isSymbolicLink()).toBe(true)
    expect(fs.readFileSync(target, "utf8")).toBe("outside")
  })

  it("rejects a changed hostile quarantine inode and non-absence lookup failure", () => {
    const marker = { schemaVersion: "sanctuary-acceptance-marker-v1" as const, label: "hostile-race", scenarioHandleDigest: "3".repeat(64), startedAt: "2026-08-20T12:00:00.000Z" }
    writeSanctuaryAcceptanceMarker("sanctuary", marker)
    const quarantineRoot = path.join(root, "sanctuary.ouro", "state", "acceptance", "quarantine")
    fs.writeFileSync(quarantineRoot, "hostile")
    fsFaults.lstatMutationAt = 5
    fsFaults.mutation = "inode"
    expect(() => quarantineSanctuaryAcceptanceMarker("sanctuary")).toThrow("rejection changed")

    fs.rmSync(path.join(root, "sanctuary.ouro"), { recursive: true, force: true })
    fsFaults.lstatCall = 0
    fsFaults.lstatMutationAt = 0
    fsFaults.mutation = ""
    writeSanctuaryAcceptanceMarker("sanctuary", marker)
    fsFaults.lstatErrorAt = 4
    expect(() => quarantineSanctuaryAcceptanceMarker("sanctuary")).toThrow("lstat denied")
  })

  it.each([
    ["initial lstat failure", "lstatErrorAt", 1, "", "lstat denied"],
    ["parent descriptor type", "fstatMutationAt", 1, "not-directory", "parent changed"],
    ["parent path type", "lstatMutationAt", 2, "not-directory", "parent changed"],
    ["parent inode", "lstatMutationAt", 2, "inode", "parent changed"],
    ["marker descriptor type", "fstatMutationAt", 2, "not-file", "marker changed"],
    ["marker path type", "lstatMutationAt", 3, "not-file", "marker changed"],
    ["marker inode", "lstatMutationAt", 3, "inode", "marker changed"],
    ["quarantine descriptor type", "fstatMutationAt", 3, "not-directory", "quarantine root changed"],
    ["quarantine path type", "lstatMutationAt", 5, "not-directory", "quarantine root changed"],
    ["quarantine inode", "lstatMutationAt", 5, "inode", "quarantine root changed"],
    ["marker before move", "lstatMutationAt", 6, "inode", "before quarantine move"],
    ["marker after move", "lstatMutationAt", 7, "inode", "during quarantine move"],
  ] as const)("fails closed on %s races", (_name, counter, call, mutation, message) => {
    writeSanctuaryAcceptanceMarker("sanctuary", {
      schemaVersion: "sanctuary-acceptance-marker-v1", label: "race", scenarioHandleDigest: "2".repeat(64), startedAt: "2026-08-20T12:00:00.000Z",
    })
    fsFaults[counter] = call
    fsFaults.mutation = mutation
    expect(() => quarantineSanctuaryAcceptanceMarker("sanctuary")).toThrow(message)
  })

  it("publishes the exact non-sensitive external gate status and clears it at finalization", () => {
    const filePath = path.join(root, "evidence", "current-scenario-gate.json")
    publishSanctuaryAcceptanceGateStatus({
      label: "approval-approve",
      gate: "telegram-delayed-approve",
      phase: "waiting",
      startedAt: "2026-08-20T12:00:00.000Z",
    }, filePath)
    expect(JSON.parse(fs.readFileSync(filePath, "utf8"))).toEqual({
      label: "approval-approve",
      gate: "telegram-delayed-approve",
      phase: "waiting",
      startedAt: "2026-08-20T12:00:00.000Z",
    })
    expect(fs.statSync(filePath).mode & 0o777).toBe(0o644)
    clearSanctuaryAcceptanceGateStatus(filePath)
    expect(fs.existsSync(filePath)).toBe(false)
  })

  it("rejects invalid gate statuses and makes clear idempotent", () => {
    const filePath = path.join(root, "evidence", "current-scenario-gate.json")
    for (const status of [null, [], {}, { label: "", gate: "g", phase: "waiting", startedAt: "2026-08-20T12:00:00.000Z" }, { label: "x", gate: "", phase: "waiting", startedAt: "2026-08-20T12:00:00.000Z" }, { label: "x", gate: "g", phase: "bad", startedAt: "2026-08-20T12:00:00.000Z" }, { label: "x", gate: "g", phase: "complete", startedAt: "bad" }]) {
      expect(() => publishSanctuaryAcceptanceGateStatus(status as never, filePath)).toThrow()
    }
    clearSanctuaryAcceptanceGateStatus(filePath)
    fs.mkdirSync(filePath, { recursive: true })
    expect(() => clearSanctuaryAcceptanceGateStatus(filePath)).toThrow()
  })

  it("scopes immutable approval context to the operation", () => {
    expect(readSanctuaryAcceptanceApproval()).toBeNull()
    expect(() => runWithSanctuaryAcceptanceApproval({ approvalId: "", argumentDigest: "a".repeat(64) }, () => null)).toThrow("invalid")
    expect(() => runWithSanctuaryAcceptanceApproval({ approvalId: "approval", argumentDigest: "bad" }, () => null)).toThrow("invalid")
    const value = runWithSanctuaryAcceptanceApproval({ approvalId: "approval", argumentDigest: "e".repeat(64) }, () => {
      const first = readSanctuaryAcceptanceApproval()!
      first.approvalId = "mutated"
      return readSanctuaryAcceptanceApproval()
    })
    expect(value).toEqual({ approvalId: "approval", argumentDigest: "e".repeat(64) })
    expect(readSanctuaryAcceptanceApproval()).toBeNull()
  })
})
