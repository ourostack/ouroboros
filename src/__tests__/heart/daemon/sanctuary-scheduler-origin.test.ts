import { createHmac } from "node:crypto"

import { describe, expect, it } from "vitest"

import {
  createSanctuarySchedulerFireCommand,
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

  it("does not mint provenance for an ordinary/manual parent", () => {
    expect(createSanctuarySchedulerFireCommand({ agent: "sanctuary", habitName: "sanctuary-health", trigger: "cron" }, {
      platform: "linux", pid: 101, ppid: 77, now: () => new Date("2026-08-21T07:16:01.000Z"), readFile: () => procStat(101, 77, "1"),
      readLink: () => "/bin/zsh", identityKey: () => identityKey, marker: () => null, randomId: () => "11111111-1111-4111-8111-111111111111",
    })).toBeNull()
  })

  it("rejects tamper, replayed slots, and a process no longer parented by the supervised child", () => {
    const command = {
      kind: "habit.scheduler-fire", agent: "sanctuary", habitName: "sanctuary-health", trigger: "cron", slot,
      occurrenceId: `cron:${slot}`, schedulerRunId: "11111111-1111-4111-8111-111111111111", invocationPid: 101, parentPid: 42,
      parentStartTime: "8001", invocationStartTime: "9001", scenarioHandleDigest, proofMac: "0".repeat(64),
    } as const
    const deps = { childPid: 42, identityKey, now: () => new Date("2026-08-21T07:16:02.000Z"), readFile: (file: string) => file === "/proc/101/stat" ? procStat(101, 42, "9001") : file === "/proc/42/stat" ? procStat(42, 1, "8001") : parentCmdline, readLink: () => "/usr/local/bin/supercronic", scenarioHandleDigest }
    expect(() => verifySanctuarySchedulerFireCommand(command, deps)).toThrow(/authentication/u)
    const unsigned = { ...command, proofMac: undefined }
    const proofMac = createHmac("sha256", identityKey).update(JSON.stringify(unsigned)).digest("hex")
    expect(() => verifySanctuarySchedulerFireCommand({ ...command, proofMac }, { ...deps, now: () => new Date("2026-08-21T07:45:01.000Z") })).toThrow(/slot/u)
    expect(() => verifySanctuarySchedulerFireCommand({ ...command, proofMac }, { ...deps, readFile: (file) => file === "/proc/101/stat" ? procStat(101, 77, "9001") : deps.readFile(file) })).toThrow(/ancestry/u)
  })
})
