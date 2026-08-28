import { createHmac } from "node:crypto"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

import { describe, expect, it } from "vitest"

import {
  createSanctuarySchedulerFireCommand,
  defaultSanctuarySchedulerOriginDeps,
  verifySanctuarySchedulerFireCommand,
} from "../../../heart/daemon/sanctuary-scheduler-origin"

const identityKey = "k".repeat(43)
const scenarioHandleDigest = "a".repeat(64)
const slot = "2026-08-21T07:15:00.000Z"
const parentCmdline = "/usr/local/bin/supercronic\0-split-logs\0-inotify\0/home/ouro/.ouro-cli/scheduler/sanctuary.crontab\0"

function procStat(pid: number, parentPid: number, startTime: string): string {
  return `${pid} (process name) S ${parentPid} 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 ${startTime} 0 0`
}

describe("Sanctuary scheduler origin", () => {
  it("keeps the production default path inert outside Linux Supercronic", () => {
    expect(createSanctuarySchedulerFireCommand({ agent: "sanctuary", habitName: "sanctuary-health", trigger: "cron" })).toBeNull()
  })

  it("wires every production dependency without ambient configuration", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "scheduler-origin-defaults-"))
    const file = path.join(root, "file")
    const link = path.join(root, "link")
    fs.writeFileSync(file, "value")
    fs.symlinkSync(file, link)
    const marker = { schemaVersion: "sanctuary-acceptance-marker-v1" as const, label: "unit-16f-cron-fingerprint", scenarioHandleDigest, startedAt: "2026-08-21T07:14:00.000Z" }
    const deps = defaultSanctuarySchedulerOriginDeps(root, () => marker)
    try {
      expect(deps.now()).toBeInstanceOf(Date)
      expect(deps.readFile(file)).toBe("value")
      expect(deps.readLink(link)).toBe(file)
      expect(deps.identityKey()).toMatch(/^[A-Za-z0-9_-]{43}$/u)
      expect(deps.marker()).toBe(marker)
      expect(deps.randomId()).toMatch(/^[0-9a-f-]{36}$/u)
    } finally { fs.rmSync(root, { recursive: true, force: true }) }
    expect(() => defaultSanctuarySchedulerOriginDeps().marker()).not.toThrow()
  })
  it("mints and verifies a slot-bound command only for a live direct Supercronic child", () => {
    const command = createSanctuarySchedulerFireCommand({ agent: "sanctuary", habitName: "sanctuary-health", trigger: "cron" }, {
      platform: "linux", pid: 101, ppid: 42, now: () => new Date("2026-08-21T07:16:01.000Z"),
      readFile: (file) => file === "/proc/101/stat" ? procStat(101, 42, "9001") : file === "/proc/42/stat" ? procStat(42, 1, "8001") : parentCmdline,
      readLink: () => "/usr/local/bin/supercronic", identityKey: () => identityKey,
      marker: () => ({ schemaVersion: "sanctuary-acceptance-marker-v1", label: "unit-16f-cron-fingerprint", scenarioHandleDigest, startedAt: "2026-08-21T07:14:00.000Z" }),
      randomId: () => "11111111-1111-4111-8111-111111111111",
    })
    expect(command).toMatchObject({ kind: "habit.scheduler-fire", agent: "sanctuary", habitName: "sanctuary-health", slot, occurrenceId: `cron:${slot}`, schedulerRunId: "11111111-1111-4111-8111-111111111111", invocationPid: 101, parentPid: 42, parentStartTime: "8001", invocationStartTime: "9001", scenarioHandleDigest })
    expect(verifySanctuarySchedulerFireCommand(command!, {
      childPid: 42, identityKey, now: () => new Date("2026-08-21T07:16:02.000Z"),
      readFile: (file) => file === "/proc/101/stat" ? procStat(101, 42, "9001") : file === "/proc/42/stat" ? procStat(42, 1, "8001") : parentCmdline,
      readLink: () => "/usr/local/bin/supercronic", scenarioHandleDigest,
    })).toEqual(expect.objectContaining({ slot, occurrenceId: `cron:${slot}`, schedulerRunId: "11111111-1111-4111-8111-111111111111" }))
  })

  it("mints and verifies the real shell-mediated Supercronic cron process tree", () => {
    const readFile = (file: string) => {
      if (file === "/proc/101/stat") return procStat(101, 77, "9001")
      if (file === "/proc/77/stat") return procStat(77, 42, "8501")
      if (file === "/proc/42/stat") return procStat(42, 1, "8001")
      return parentCmdline
    }
    const readLink = (file: string) => file === "/proc/42/exe" ? "/usr/local/bin/supercronic" : "/bin/sh"
    const command = createSanctuarySchedulerFireCommand({ agent: "sanctuary", habitName: "sanctuary-health", trigger: "cron" }, {
      platform: "linux", pid: 101, ppid: 77, now: () => new Date("2026-08-21T07:16:01.000Z"),
      readFile, readLink, identityKey: () => identityKey, marker: () => null,
      randomId: () => "11111111-1111-4111-8111-111111111111",
    })
    expect(command).toMatchObject({ parentPid: 77, parentStartTime: "8501", invocationPid: 101, invocationStartTime: "9001", scenarioHandleDigest: null })
    expect(verifySanctuarySchedulerFireCommand(command!, {
      childPid: 42, identityKey, now: () => new Date("2026-08-21T07:16:02.000Z"),
      readFile, readLink, scenarioHandleDigest: null,
    })).toEqual(expect.objectContaining({ parentPid: 77, slot, occurrenceId: `cron:${slot}` }))
  })

  it("does not mint provenance for an ordinary/manual parent", () => {
    expect(createSanctuarySchedulerFireCommand({ agent: "sanctuary", habitName: "sanctuary-health", trigger: "cron" }, {
      platform: "linux", pid: 101, ppid: 77, now: () => new Date("2026-08-21T07:16:01.000Z"), readFile: () => procStat(101, 77, "1"),
      readLink: () => "/bin/zsh", identityKey: () => identityKey, marker: () => null, randomId: () => "11111111-1111-4111-8111-111111111111",
    })).toBeNull()
  })

  it("fails closed when procfs cannot be read", () => {
    expect(createSanctuarySchedulerFireCommand({ agent: "sanctuary", habitName: "sanctuary-health", trigger: "cron" }, {
      platform: "linux", pid: 101, ppid: 42, now: () => new Date(), readFile: () => { throw new Error("gone") },
      readLink: () => "/usr/local/bin/supercronic", identityKey: () => identityKey, marker: () => null, randomId: () => "11111111-1111-4111-8111-111111111111",
    })).toBeNull()
  })

  it("fails closed when the invocation is not the direct child named in procfs", () => {
    expect(createSanctuarySchedulerFireCommand({ agent: "sanctuary", habitName: "sanctuary-health", trigger: "cron" }, {
      platform: "linux", pid: 101, ppid: 42, now: () => new Date(),
      readFile: (file) => file === "/proc/101/stat" ? procStat(101, 77, "9001") : file === "/proc/42/stat" ? procStat(42, 1, "8001") : parentCmdline,
      readLink: () => "/usr/local/bin/supercronic", identityKey: () => identityKey, marker: () => null, randomId: () => "11111111-1111-4111-8111-111111111111",
    })).toBeNull()
  })

  it("authenticates production cron without a marker and rejects replay after a marker begins", () => {
    const deps = {
      platform: "linux" as const, pid: 101, ppid: 42, now: () => new Date("2026-08-21T07:16:01.000Z"),
      readFile: (file: string) => file === "/proc/101/stat" ? procStat(101, 42, "9001") : file === "/proc/42/stat" ? procStat(42, 1, "8001") : parentCmdline,
      readLink: () => "/usr/local/bin/supercronic", identityKey: () => identityKey, marker: () => null,
      randomId: () => "11111111-1111-4111-8111-111111111111",
    }
    const command = createSanctuarySchedulerFireCommand({ agent: "sanctuary", habitName: "sanctuary-health", trigger: "cron" }, deps)!
    expect(command.scenarioHandleDigest).toBeNull()
    expect(verifySanctuarySchedulerFireCommand(command, { childPid: 42, identityKey, scenarioHandleDigest: null, now: deps.now, readFile: deps.readFile, readLink: deps.readLink })).toMatchObject({ schedulerRunId: command.schedulerRunId })
    expect(() => verifySanctuarySchedulerFireCommand(command, { childPid: 42, identityKey, scenarioHandleDigest, now: deps.now, readFile: deps.readFile, readLink: deps.readLink })).toThrow(/binding/u)
  })

  it("rejects tamper, replayed slots, and a process no longer parented by the supervised child", () => {
    const command = {
      kind: "habit.scheduler-fire", agent: "sanctuary", habitName: "sanctuary-health", trigger: "cron", slot,
      occurrenceId: `cron:${slot}`, schedulerRunId: "11111111-1111-4111-8111-111111111111", invocationPid: 101, parentPid: 42,
      parentStartTime: "8001", invocationStartTime: "9001", scenarioHandleDigest, proofMac: "0".repeat(64),
    } as const
    const deps = { childPid: 42, identityKey, now: () => new Date("2026-08-21T07:16:02.000Z"), readFile: (file: string) => file === "/proc/101/stat" ? procStat(101, 42, "9001") : file === "/proc/42/stat" ? procStat(42, 1, "8001") : parentCmdline, readLink: () => "/usr/local/bin/supercronic", scenarioHandleDigest }
    expect(() => verifySanctuarySchedulerFireCommand(command, deps)).toThrow(/authentication/u)
    expect(() => verifySanctuarySchedulerFireCommand({ ...command, proofMac: "bad" }, deps)).toThrow(/authentication/u)
    const unsigned = { ...command, proofMac: undefined }
    const proofMac = createHmac("sha256", identityKey).update(JSON.stringify(unsigned)).digest("hex")
    expect(() => verifySanctuarySchedulerFireCommand({ ...command, proofMac }, { ...deps, now: () => new Date("2026-08-21T07:45:01.000Z") })).toThrow(/slot/u)
    expect(() => verifySanctuarySchedulerFireCommand({ ...command, proofMac }, { ...deps, readFile: (file) => file === "/proc/101/stat" ? procStat(101, 77, "9001") : deps.readFile(file) })).toThrow(/ancestry/u)
    expect(() => verifySanctuarySchedulerFireCommand({ ...command, proofMac }, { ...deps, childPid: 900 })).toThrow(/ancestry/u)
    expect(() => verifySanctuarySchedulerFireCommand({ ...command, proofMac }, { ...deps, readLink: () => "/bin/sh" })).toThrow(/ancestry/u)
    expect(() => verifySanctuarySchedulerFireCommand({ ...command, proofMac }, { ...deps, readFile: (file) => file === "/proc/101/stat" ? "invalid" : deps.readFile(file) })).toThrow(/process identity/u)
    expect(() => verifySanctuarySchedulerFireCommand({ ...command, proofMac }, { ...deps, readFile: (file) => file === "/proc/101/stat" ? "101 (x) S invalid" : deps.readFile(file) })).toThrow(/process identity/u)
  })
})
