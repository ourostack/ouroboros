import { createHmac } from "node:crypto"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

import { afterEach, beforeEach, describe, expect, it } from "vitest"

import {
  consumeSchedulerFire,
  createSchedulerFireCommand as create,
  defaultSchedulerAttestationDeps,
  schedulerCrontabPath,
  verifySchedulerFireCommand as verifyWith,
  type SchedulerAttestationVerifyDeps,
  type SchedulerFireCommand,
} from "../../../heart/daemon/scheduler-attestation"
import { getAgentBundlesRoot } from "../../../heart/identity"
import { loadProduct } from "../../../heart/product/active"
import type { OuroProduct } from "../../../heart/product/types"

const identityKey = "k".repeat(43)
const scenarioHandleDigest = "a".repeat(64)
const slot = "2026-08-21T07:15:00.000Z"
const crontabPath = "/home/ouro/.ouro-cli/scheduler/sanctuary.crontab"
const parentCmdline = `/usr/local/bin/supercronic\0-split-logs\0-inotify\0${crontabPath}\0`

// A product whose `sanctuary-health` must prove it came from the scheduler, and whose `notes` need not.
const product: OuroProduct = {
  seamVersion: 1, id: "fixture", agents: ["butler", "sanctuary"],
  habits: {
    "sanctuary-health": { run: async () => ({ ok: true }), requiresSchedulerAttestation: true },
    notes: { run: async () => ({ ok: true }), requiresSchedulerAttestation: false },
  },
}

// The cases below give each process its own procfs; the crontab Supercronic runs follows the agent's name, as the daemon's
// supervisor writes it, and the acceptance scenario comes from the marker each case supplies.
function mint(command: { agent: string; habitName: string; trigger: string }, deps?: Record<string, unknown>) {
  if (!deps) return create(command)
  const { marker, ...rest } = deps as { marker: () => { scenarioHandleDigest: string } | null }
  return create(command, { crontabPath: `/home/ouro/.ouro-cli/scheduler/${command.agent}.crontab`, ...rest, scenario: () => marker()?.scenarioHandleDigest ?? null } as never)
}

function verify(command: SchedulerFireCommand, deps: Omit<SchedulerAttestationVerifyDeps, "crontabPath"> & { crontabPath?: string }) {
  return verifyWith(command, { crontabPath: deps.crontabPath ?? `/home/ouro/.ouro-cli/scheduler/${command.agent}.crontab`, ...deps })
}

function procStat(pid: number, parentPid: number, startTime: string): string {
  return `${pid} (process name) S ${parentPid} 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 ${startTime} 0 0`
}

describe("scheduler attestation", () => {
  beforeEach(() => { loadProduct("/opt/fixture/product.js", () => ({ product })) })
  afterEach(() => { loadProduct(undefined) })

  it("keeps the production default path inert outside Linux Supercronic", () => {
    expect(mint({ agent: "sanctuary", habitName: "sanctuary-health", trigger: "cron" })).toBeNull()
  })

  it("mints nothing off Linux, whatever the host", () => {
    expect(mint({ agent: "butler", habitName: "sanctuary-health", trigger: "cron" }, {
      platform: "darwin", pid: 101, ppid: 42, now: () => new Date(), readFile: () => { throw new Error("not read") }, readLink: () => { throw new Error("not read") },
      identityKey: () => identityKey, marker: () => null, randomId: () => "11111111-1111-4111-8111-111111111111",
    })).toBeNull()
  })

  it("wires every production dependency without ambient configuration", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "scheduler-attestation-defaults-"))
    const file = path.join(root, "file")
    const link = path.join(root, "link")
    fs.writeFileSync(file, "value")
    fs.symlinkSync(file, link)
    const deps = defaultSchedulerAttestationDeps("sanctuary", { attestationScenario: (agent) => agent === "sanctuary" ? scenarioHandleDigest : null }, root)
    try {
      expect(deps.crontabPath).toBe(schedulerCrontabPath("sanctuary"))
      expect(deps.now()).toBeInstanceOf(Date)
      expect(deps.readFile(file)).toBe("value")
      expect(deps.readLink(link)).toBe(file)
      expect(deps.identityKey()).toMatch(/^[A-Za-z0-9_-]{43}$/u)
      expect(deps.scenario()).toBe(scenarioHandleDigest)
      expect(deps.randomId()).toMatch(/^[0-9a-f-]{36}$/u)
    } finally { fs.rmSync(root, { recursive: true, force: true }) }
    // A habit with no acceptance scenario binds none.
    expect(defaultSchedulerAttestationDeps("butler", {}).scenario()).toBeNull()
  })

  it("puts each agent's crontab where the daemon's Supercronic supervisor writes it", () => {
    // Beside the bundles folder: in the image, /home/ouro/.ouro-cli/scheduler/butler.crontab.
    expect(schedulerCrontabPath("butler").startsWith(path.dirname(getAgentBundlesRoot()))).toBe(true)
    expect(schedulerCrontabPath("butler")).toMatch(/\/\.ouro-cli\/scheduler\/butler\.crontab$/u)
  })

  it("mints nothing for a habit, trigger or agent that needs no proof", () => {
    const deps = {
      platform: "linux" as const, pid: 101, ppid: 42, now: () => new Date("2026-08-21T07:16:01.000Z"),
      readFile: (file: string) => file === "/proc/101/stat" ? procStat(101, 42, "9001") : file === "/proc/42/stat" ? procStat(42, 1, "8001") : parentCmdline,
      readLink: () => "/usr/local/bin/supercronic", identityKey: () => identityKey, marker: () => null,
      randomId: () => "11111111-1111-4111-8111-111111111111",
    }
    expect(mint({ agent: "sanctuary", habitName: "sanctuary-health", trigger: "cron" }, deps)).not.toBeNull()
    expect(mint({ agent: "sanctuary", habitName: "sanctuary-health", trigger: "poke" }, deps)).toBeNull()
    expect(mint({ agent: "sanctuary", habitName: "notes", trigger: "cron" }, deps)).toBeNull()
    expect(mint({ agent: "sanctuary", habitName: "constructor", trigger: "cron" }, deps)).toBeNull()
    expect(mint({ agent: "slugger", habitName: "sanctuary-health", trigger: "cron" }, deps)).toBeNull()
    // With no product loaded, nothing needs proof.
    loadProduct(undefined)
    expect(mint({ agent: "sanctuary", habitName: "sanctuary-health", trigger: "cron" }, deps)).toBeNull()
  })

  it("refuses to verify a fire of a habit that needs no proof, or a malformed fire", () => {
    const command = {
      kind: "habit.scheduler-fire", agent: "sanctuary", habitName: "notes", trigger: "cron", slot,
      occurrenceId: `cron:${slot}`, schedulerRunId: "11111111-1111-4111-8111-111111111111", invocationPid: 101, parentPid: 42,
      parentStartTime: "8001", invocationStartTime: "9001", scenarioHandleDigest: null, proofMac: "0".repeat(64),
    } as const
    const deps = { childPid: 42, identityKey, now: () => new Date("2026-08-21T07:16:02.000Z"), readFile: () => "", readLink: () => "", scenarioHandleDigest: null }
    expect(() => verify(command, deps)).toThrow("scheduler fire slot or binding is invalid")
    expect(() => verify({ ...command, habitName: 7 } as never, deps)).toThrow("scheduler fire slot or binding is invalid")
    expect(() => verify({ ...command, agent: 7 } as never, { ...deps, crontabPath })).toThrow("scheduler fire slot or binding is invalid")
    expect(() => verify(null as never, { ...deps, crontabPath })).toThrow("scheduler fire slot or binding is invalid")
  })

  it("durably consumes one occurrence of a habit before it runs, and rejects its replay across restarts", () => {
    const agentRoot = fs.mkdtempSync(path.join(os.tmpdir(), "scheduler-attestation-claims-"))
    const origin = { slot: "2026-08-18T17:00:00.000Z", occurrenceId: "cron:2026-08-18T17:00:00.000Z", schedulerRunId: "22222222-2222-4222-8222-222222222222", invocationPid: 43, parentPid: 42, parentStartTime: "8001", invocationStartTime: "9001", proofMac: "c".repeat(64), scenarioHandleDigest }
    try {
      consumeSchedulerFire(agentRoot, "sanctuary-health", origin)
      expect(() => consumeSchedulerFire(agentRoot, "sanctuary-health", origin)).toThrow("scheduler fire replay rejected")
      expect(() => consumeSchedulerFire(agentRoot, "sanctuary-health", { ...origin, schedulerRunId: "33333333-3333-4333-8333-333333333333" })).toThrow(/replay/u)
      // Another slot, or another habit in the same slot, is its own occurrence.
      expect(() => consumeSchedulerFire(agentRoot, "sanctuary-health", {
        ...origin, slot: "2026-08-18T17:15:00.000Z", occurrenceId: "cron:2026-08-18T17:15:00.000Z", schedulerRunId: "44444444-4444-4444-8444-444444444444",
      })).not.toThrow()
      expect(() => consumeSchedulerFire(agentRoot, "notes", origin)).not.toThrow()
      expect(fs.readdirSync(path.join(agentRoot, "state/scheduler/fire-claims"))).toHaveLength(3)
    } finally { fs.rmSync(agentRoot, { recursive: true, force: true }) }
  })

  it("fails closed when a claim cannot be durably created", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "scheduler-attestation-claim-error-"))
    const nonDirectoryRoot = path.join(root, "not-a-directory")
    fs.writeFileSync(nonDirectoryRoot, "occupied")
    const origin = { slot: "2026-08-18T17:00:00.000Z", occurrenceId: "cron:2026-08-18T17:00:00.000Z", schedulerRunId: "22222222-2222-4222-8222-222222222222", invocationPid: 43, parentPid: 42, parentStartTime: "8001", invocationStartTime: "9001", proofMac: "c".repeat(64), scenarioHandleDigest }
    try {
      expect(() => consumeSchedulerFire(nonDirectoryRoot, "sanctuary-health", origin)).toThrow()
      expect(() => consumeSchedulerFire(root, "sanctuary-health", { ...origin, schedulerRunId: "invalid" })).toThrow("scheduler fire claim is invalid")
    } finally { fs.rmSync(root, { recursive: true, force: true }) }
  })

  it("mints and verifies a slot-bound command only for a live direct Supercronic child", () => {
    const command = mint({ agent: "sanctuary", habitName: "sanctuary-health", trigger: "cron" }, {
      platform: "linux", pid: 101, ppid: 42, now: () => new Date("2026-08-21T07:16:01.000Z"),
      readFile: (file) => file === "/proc/101/stat" ? procStat(101, 42, "9001") : file === "/proc/42/stat" ? procStat(42, 1, "8001") : parentCmdline,
      readLink: () => "/usr/local/bin/supercronic", identityKey: () => identityKey,
      marker: () => ({ schemaVersion: "sanctuary-acceptance-marker-v1", label: "unit-16f-cron-fingerprint", scenarioHandleDigest, startedAt: "2026-08-21T07:14:00.000Z" }),
      randomId: () => "11111111-1111-4111-8111-111111111111",
    })
    expect(command).toMatchObject({ kind: "habit.scheduler-fire", agent: "sanctuary", habitName: "sanctuary-health", slot, occurrenceId: `cron:${slot}`, schedulerRunId: "11111111-1111-4111-8111-111111111111", invocationPid: 101, parentPid: 42, parentStartTime: "8001", invocationStartTime: "9001", scenarioHandleDigest })
    expect(verify(command!, {
      childPid: 42, identityKey, now: () => new Date("2026-08-21T07:16:02.000Z"),
      readFile: (file) => file === "/proc/101/stat" ? procStat(101, 42, "9001") : file === "/proc/42/stat" ? procStat(42, 1, "8001") : parentCmdline,
      readLink: () => "/usr/local/bin/supercronic", scenarioHandleDigest,
    })).toEqual(expect.objectContaining({ slot, occurrenceId: `cron:${slot}`, schedulerRunId: "11111111-1111-4111-8111-111111111111" }))
  })

  it.each(["butler", "sanctuary"])("mints and verifies a command for the Butler named %s, and none for another agent", (agent) => {
    const cmdline = parentCmdline.replace("sanctuary.crontab", `${agent}.crontab`)
    const deps = {
      platform: "linux" as const, pid: 101, ppid: 42, now: () => new Date("2026-08-21T07:16:01.000Z"),
      readFile: (file: string) => file === "/proc/101/stat" ? procStat(101, 42, "9001") : file === "/proc/42/stat" ? procStat(42, 1, "8001") : cmdline,
      readLink: () => "/usr/local/bin/supercronic", identityKey: () => identityKey, marker: () => null,
      randomId: () => "11111111-1111-4111-8111-111111111111",
    }
    const command = mint({ agent, habitName: "sanctuary-health", trigger: "cron" }, deps)
    expect(command).toMatchObject({ agent })
    expect(verify(command!, {
      childPid: 42, identityKey, now: () => new Date("2026-08-21T07:16:02.000Z"), readFile: deps.readFile, readLink: deps.readLink, scenarioHandleDigest: null,
    })).toEqual(expect.objectContaining({ slot }))
    expect(mint({ agent: "slugger", habitName: "sanctuary-health", trigger: "cron" }, deps)).toBeNull()
    const otherName = agent === "butler" ? "sanctuary" : "butler"
    expect(mint({ agent: otherName, habitName: "sanctuary-health", trigger: "cron" }, deps)).toBeNull()
    expect(() => verify({ ...command!, agent: "slugger" as never }, {
      childPid: 42, identityKey, now: () => new Date("2026-08-21T07:16:02.000Z"), readFile: deps.readFile, readLink: deps.readLink, scenarioHandleDigest: null,
    })).toThrow("scheduler fire slot or binding is invalid")
  })

  it("mints and verifies the real shell-mediated Supercronic cron process tree", () => {
    const readFile = (file: string) => {
      if (file === "/proc/101/stat") return procStat(101, 77, "9001")
      if (file === "/proc/77/stat") return procStat(77, 42, "8501")
      if (file === "/proc/42/stat") return procStat(42, 1, "8001")
      return parentCmdline
    }
    const readLink = (file: string) => file === "/proc/42/exe" ? "/usr/local/bin/supercronic" : "/bin/sh"
    const command = mint({ agent: "sanctuary", habitName: "sanctuary-health", trigger: "cron" }, {
      platform: "linux", pid: 101, ppid: 77, now: () => new Date("2026-08-21T07:16:01.000Z"),
      readFile, readLink, identityKey: () => identityKey, marker: () => null,
      randomId: () => "11111111-1111-4111-8111-111111111111",
    })
    expect(command).toMatchObject({ parentPid: 77, parentStartTime: "8501", invocationPid: 101, invocationStartTime: "9001", scenarioHandleDigest: null })
    expect(verify(command!, {
      childPid: 42, identityKey, now: () => new Date("2026-08-21T07:16:02.000Z"),
      readFile, readLink, scenarioHandleDigest: null,
    })).toEqual(expect.objectContaining({ parentPid: 77, slot, occurrenceId: `cron:${slot}` }))
  })

  it("does not mint provenance for an ordinary/manual parent", () => {
    expect(mint({ agent: "sanctuary", habitName: "sanctuary-health", trigger: "cron" }, {
      platform: "linux", pid: 101, ppid: 77, now: () => new Date("2026-08-21T07:16:01.000Z"), readFile: () => procStat(101, 77, "1"),
      readLink: () => "/bin/zsh", identityKey: () => identityKey, marker: () => null, randomId: () => "11111111-1111-4111-8111-111111111111",
    })).toBeNull()
  })

  it("fails closed when procfs cannot be read", () => {
    expect(mint({ agent: "sanctuary", habitName: "sanctuary-health", trigger: "cron" }, {
      platform: "linux", pid: 101, ppid: 42, now: () => new Date(), readFile: () => { throw new Error("gone") },
      readLink: () => "/usr/local/bin/supercronic", identityKey: () => identityKey, marker: () => null, randomId: () => "11111111-1111-4111-8111-111111111111",
    })).toBeNull()
  })

  it("fails closed when the invocation is not the direct child named in procfs", () => {
    expect(mint({ agent: "sanctuary", habitName: "sanctuary-health", trigger: "cron" }, {
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
    const command = mint({ agent: "sanctuary", habitName: "sanctuary-health", trigger: "cron" }, deps)!
    expect(command.scenarioHandleDigest).toBeNull()
    expect(verify(command, { childPid: 42, identityKey, scenarioHandleDigest: null, now: deps.now, readFile: deps.readFile, readLink: deps.readLink })).toMatchObject({ schedulerRunId: command.schedulerRunId })
    expect(() => verify(command, { childPid: 42, identityKey, scenarioHandleDigest, now: deps.now, readFile: deps.readFile, readLink: deps.readLink })).toThrow(/binding/u)
  })

  it("rejects tamper, replayed slots, and a process no longer parented by the supervised child", () => {
    const command = {
      kind: "habit.scheduler-fire", agent: "sanctuary", habitName: "sanctuary-health", trigger: "cron", slot,
      occurrenceId: `cron:${slot}`, schedulerRunId: "11111111-1111-4111-8111-111111111111", invocationPid: 101, parentPid: 42,
      parentStartTime: "8001", invocationStartTime: "9001", scenarioHandleDigest, proofMac: "0".repeat(64),
    } as const
    const deps = { childPid: 42, identityKey, now: () => new Date("2026-08-21T07:16:02.000Z"), readFile: (file: string) => file === "/proc/101/stat" ? procStat(101, 42, "9001") : file === "/proc/42/stat" ? procStat(42, 1, "8001") : parentCmdline, readLink: () => "/usr/local/bin/supercronic", scenarioHandleDigest }
    expect(() => verify(command, deps)).toThrow(/authentication/u)
    expect(() => verify({ ...command, proofMac: "bad" }, deps)).toThrow(/authentication/u)
    const unsigned = { ...command, proofMac: undefined }
    const proofMac = createHmac("sha256", identityKey).update(JSON.stringify(unsigned)).digest("hex")
    expect(() => verify({ ...command, proofMac }, { ...deps, now: () => new Date("2026-08-21T07:45:01.000Z") })).toThrow(/slot/u)
    expect(() => verify({ ...command, proofMac }, { ...deps, readFile: (file) => file === "/proc/101/stat" ? procStat(101, 77, "9001") : deps.readFile(file) })).toThrow(/ancestry/u)
    expect(() => verify({ ...command, proofMac }, { ...deps, childPid: 900 })).toThrow(/ancestry/u)
    expect(() => verify({ ...command, proofMac }, { ...deps, readLink: () => "/bin/sh" })).toThrow(/ancestry/u)
    expect(() => verify({ ...command, proofMac }, { ...deps, readFile: (file) => file === "/proc/101/stat" ? "invalid" : deps.readFile(file) })).toThrow(/process identity/u)
    expect(() => verify({ ...command, proofMac }, { ...deps, readFile: (file) => file === "/proc/101/stat" ? "101 (x) S invalid" : deps.readFile(file) })).toThrow(/process identity/u)
  })
})
