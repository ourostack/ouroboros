import { EventEmitter } from "node:events"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

import { describe, expect, it, vi } from "vitest"

import { consumeSanctuarySchedulerFire, durableExclusiveJson, publishSanctuarySchedulerReceipt, readSanctuaryHealthCursor, recordSanctuarySchedulerLivenessReceipt, verifySanctuarySchedulerLivenessReceiptMac } from "../../../heart/daemon/sanctuary-scheduler-liveness"
import { SupercronicSupervisor } from "../../../heart/daemon/supercronic-supervisor"

const scenarioHandleDigest = "a".repeat(64)
const authenticated = {
  identityKey: "k".repeat(43),
  schedulerOrigin: { slot: "2026-08-18T17:00:00.000Z", occurrenceId: "cron:2026-08-18T17:00:00.000Z", schedulerRunId: "22222222-2222-4222-8222-222222222222", invocationPid: 43, parentPid: 42, parentStartTime: "8001", invocationStartTime: "9001", proofMac: "c".repeat(64), scenarioHandleDigest },
}
const durableFs = { mkdirSync: fs.mkdirSync, openSync: fs.openSync, writeFileSync: fs.writeFileSync, fsyncSync: fs.fsyncSync, closeSync: fs.closeSync, linkSync: fs.linkSync, unlinkSync: fs.unlinkSync }

function setup() {
  const agentRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sanctuary-scheduler-liveness-"))
  const statePath = path.join(agentRoot, "state/health/sanctuary-health.json")
  fs.mkdirSync(path.dirname(statePath), { recursive: true })
  const files = new Map<string, string>()
  const child = Object.assign(new EventEmitter(), { pid: 42, kill: vi.fn() })
  const supervisor = new SupercronicSupervisor({
    binaryPath: "/usr/local/bin/supercronic",
    crontabPath: "/home/ouro/.ouro-cli/scheduler/sanctuary.crontab",
    deps: {
      mkdir: vi.fn(), readFile: (target) => files.get(target)!, durableWrite: (target, content) => { files.set(target, content) },
      removeFile: (target) => { files.delete(target) }, processAlive: () => true, spawn: () => child,
      setTimer: vi.fn(), clearTimer: vi.fn(),
    },
  })
  supervisor.namespace("habit:sanctuary").sync([{
    id: "sanctuary:sanctuary-health", agent: "sanctuary", taskId: "sanctuary-health", schedule: "*/15 * * * *", lastRun: null,
    command: "/usr/local/bin/node /opt/ouro/dist/heart/daemon/ouro-entry.js poke sanctuary --habit sanctuary-health --trigger cron",
    taskPath: "/home/ouro/AgentBundles/sanctuary.ouro/habits/sanctuary-health.md",
  }])
  supervisor.start()
  const before = { incidents: {}, lastDigestDay: "2026-08-18", updatedAt: "2026-08-18T15:00:00.000Z", outbox: null, indeterminateDeliveries: [], deliveredReceipts: [], sweepReceipts: [] }
  fs.writeFileSync(statePath, `${JSON.stringify(before)}\n`)
  return { agentRoot, statePath, supervisor }
}

function readyInput(f: ReturnType<typeof setup>) {
  const state = JSON.parse(fs.readFileSync(f.statePath, "utf8"))
  state.sweepReceipts.push({ sweepId: "sweep-1", opened: 0, recovered: 0, digestDue: false, scenarioHandleDigest })
  fs.writeFileSync(f.statePath, `${JSON.stringify(state)}\n`)
  return { agentRoot: f.agentRoot, trigger: "cron" as const, occurrenceId: "cron:2026-08-18T17:00:00.000Z", runnerId: "11111111-1111-4111-8111-111111111111", scenario: { label: "unit-16f-cron-fingerprint", scenarioHandleDigest }, supervisor: f.supervisor.authenticatedSnapshot("habit:sanctuary"), before: { sweepCount: 0, deliveryCount: 0 }, providerInvocationCount: 0, privateTurnCount: 0, ...authenticated }
}

describe("Sanctuary scheduler liveness receipt", () => {
  it("durably consumes one scheduler occurrence before effect and rejects run or occurrence replay across restarts", () => {
    const f = setup()
    try {
      consumeSanctuarySchedulerFire(f.agentRoot, authenticated.schedulerOrigin)
      expect(() => consumeSanctuarySchedulerFire(f.agentRoot, authenticated.schedulerOrigin)).toThrow(/replay/u)
      expect(() => consumeSanctuarySchedulerFire(f.agentRoot, {
        ...authenticated.schedulerOrigin,
        schedulerRunId: "33333333-3333-4333-8333-333333333333",
      })).toThrow(/replay/u)
      expect(() => consumeSanctuarySchedulerFire(f.agentRoot, {
        ...authenticated.schedulerOrigin,
        slot: "2026-08-18T17:15:00.000Z",
        occurrenceId: "cron:2026-08-18T17:15:00.000Z",
        schedulerRunId: "44444444-4444-4444-8444-444444444444",
      })).not.toThrow()
      expect(fs.readdirSync(path.join(f.agentRoot, "state/scheduler/sanctuary-fire-claims"))).toHaveLength(2)
    } finally { fs.rmSync(f.agentRoot, { recursive: true, force: true }) }
  })

  it("reads and validates the durable cursor", () => {
    const f = setup()
    try {
      expect(readSanctuaryHealthCursor(f.agentRoot)).toEqual({ sweepCount: 0, deliveryCount: 0 })
      fs.writeFileSync(f.statePath, "{}\n")
      expect(() => readSanctuaryHealthCursor(f.agentRoot)).toThrow(/cursor state/u)
    } finally { fs.rmSync(f.agentRoot, { recursive: true, force: true }) }
  })
  it("records one scheduler-origin unchanged sweep with daemon and supervisor provenance", () => {
    const f = setup()
    const sweep = { sweepId: "sweep-1", startedAt: "2026-08-18T17:00:00.000Z", completedAt: "2026-08-18T17:00:01.000Z", incidentDigest: "b".repeat(64), opened: 0, recovered: 0, digestDue: false, scenarioHandleDigest }
    const state = JSON.parse(fs.readFileSync(f.statePath, "utf8"))
    state.sweepReceipts.push(sweep)
    fs.writeFileSync(f.statePath, `${JSON.stringify(state)}\n`)
    try {
      const receipt = recordSanctuarySchedulerLivenessReceipt({
        agentRoot: f.agentRoot, trigger: "cron", occurrenceId: "cron:2026-08-18T17:00:00.000Z", runnerId: "11111111-1111-4111-8111-111111111111",
        scenario: { label: "unit-16f-cron-fingerprint", scenarioHandleDigest }, supervisor: f.supervisor.authenticatedSnapshot("habit:sanctuary"),
        before: { sweepCount: 0, deliveryCount: 0 }, providerInvocationCount: 0, privateTurnCount: 0, ...authenticated,
      })
      expect(receipt).toMatchObject({ schemaVersion: "sanctuary-scheduler-liveness-receipt-v1", trigger: "cron", occurrenceId: "cron:2026-08-18T17:00:00.000Z", scenarioHandleDigest, sweepDelta: 1, deliveryDelta: 0, providerInvocationCount: 0, privateTurnCount: 0, nonReplay: true })
      expect(receipt.supervisor).toMatchObject({ daemonPid: process.pid, childCount: 1, childPid: 42, healthy: true, namespace: "habit:sanctuary", args: ["-split-logs", "-inotify", "/home/ouro/.ouro-cli/scheduler/sanctuary.crontab"] })
      expect(receipt.sweep).toMatchObject({ opened: 0, recovered: 0, digestDue: false })
      expect(receipt.receiptMac).toMatch(/^[0-9a-f]{64}$/u)
      expect(verifySanctuarySchedulerLivenessReceiptMac(authenticated.identityKey, {})).toBe(false)
      expect(verifySanctuarySchedulerLivenessReceiptMac(authenticated.identityKey, receipt as unknown as Record<string, unknown>)).toBe(true)
      expect(verifySanctuarySchedulerLivenessReceiptMac(authenticated.identityKey, { ...receipt, occurrenceId: "cron:tampered" })).toBe(false)
    } finally { fs.rmSync(f.agentRoot, { recursive: true, force: true }) }
  })

  it("commits the first receipt without replacement", () => {
    const f = setup()
    const state = JSON.parse(fs.readFileSync(f.statePath, "utf8"))
    state.sweepReceipts.push({ sweepId: "sweep-1", opened: 0, recovered: 0, digestDue: false, scenarioHandleDigest })
    fs.writeFileSync(f.statePath, `${JSON.stringify(state)}\n`)
    const input = { agentRoot: f.agentRoot, trigger: "cron", occurrenceId: "cron:2026-08-18T17:00:00.000Z", runnerId: "11111111-1111-4111-8111-111111111111", scenario: { label: "unit-16f-cron-fingerprint", scenarioHandleDigest }, supervisor: f.supervisor.authenticatedSnapshot("habit:sanctuary"), before: { sweepCount: 0, deliveryCount: 0 }, providerInvocationCount: 0, privateTurnCount: 0, ...authenticated }
    try {
      recordSanctuarySchedulerLivenessReceipt(input)
      const receiptPath = path.join(f.agentRoot, "state/acceptance/scheduler-liveness-receipts", `${scenarioHandleDigest}.json`)
      const first = fs.readFileSync(receiptPath, "utf8")
      expect(() => recordSanctuarySchedulerLivenessReceipt({ ...input, runnerId: "33333333-3333-4333-8333-333333333333" })).toThrow(/already exists/u)
      expect(fs.readFileSync(receiptPath, "utf8")).toBe(first)
    } finally { fs.rmSync(f.agentRoot, { recursive: true, force: true }) }
  })

  it("rejects an origin not bound to the scenario and supervised child", () => {
    const f = setup()
    try {
      expect(() => recordSanctuarySchedulerLivenessReceipt({
        agentRoot: f.agentRoot, trigger: "cron", occurrenceId: "cron:2026-08-18T17:00:00.000Z", runnerId: "11111111-1111-4111-8111-111111111111",
        scenario: { label: "unit-16f-cron-fingerprint", scenarioHandleDigest }, supervisor: f.supervisor.authenticatedSnapshot("habit:sanctuary"),
        before: { sweepCount: 0, deliveryCount: 0 }, providerInvocationCount: 0, privateTurnCount: 0,
        ...authenticated, schedulerOrigin: { ...authenticated.schedulerOrigin, scenarioHandleDigest: "b".repeat(64) },
      })).toThrow(/authenticated origin/u)
    } finally { fs.rmSync(f.agentRoot, { recursive: true, force: true }) }
  })

  it.each([
    ["scenario", { scenario: { label: "wrong", scenarioHandleDigest } }, /scenario/u],
    ["runner", { runnerId: "not-a-uuid" }, /runner/u],
    ["origin occurrence", { schedulerOrigin: { ...authenticated.schedulerOrigin, occurrenceId: "cron:other" } }, /authenticated origin/u],
    ["scheduler run", { schedulerOrigin: { ...authenticated.schedulerOrigin, schedulerRunId: "not-a-uuid" } }, /authenticated origin/u],
    ["provider work", { providerInvocationCount: 1 }, /paid work/u],
    ["private work", { privateTurnCount: 1 }, /paid work/u],
  ])("rejects invalid %s provenance before reading state", (_case, mutation, expected) => {
    const f = setup()
    try {
      const base = { agentRoot: f.agentRoot, trigger: "cron", occurrenceId: "cron:2026-08-18T17:00:00.000Z", runnerId: "11111111-1111-4111-8111-111111111111", scenario: { label: "unit-16f-cron-fingerprint", scenarioHandleDigest }, supervisor: f.supervisor.authenticatedSnapshot("habit:sanctuary"), before: { sweepCount: 0, deliveryCount: 0 }, providerInvocationCount: 0, privateTurnCount: 0, ...authenticated }
      expect(() => recordSanctuarySchedulerLivenessReceipt({ ...base, ...mutation })).toThrow(expected)
    } finally { fs.rmSync(f.agentRoot, { recursive: true, force: true }) }
  })

  it("rejects malformed health state after authenticating the fire", () => {
    const f = setup()
    fs.writeFileSync(f.statePath, "{}\n")
    try {
      expect(() => recordSanctuarySchedulerLivenessReceipt({ agentRoot: f.agentRoot, trigger: "cron", occurrenceId: "cron:2026-08-18T17:00:00.000Z", runnerId: "11111111-1111-4111-8111-111111111111", scenario: { label: "unit-16f-cron-fingerprint", scenarioHandleDigest }, supervisor: f.supervisor.authenticatedSnapshot("habit:sanctuary"), before: { sweepCount: 0, deliveryCount: 0 }, providerInvocationCount: 0, privateTurnCount: 0, ...authenticated })).toThrow(/state is invalid/u)
    } finally { fs.rmSync(f.agentRoot, { recursive: true, force: true }) }
  })

  it("rejects a configured snapshot that is not the exact supervised runtime", () => {
    const f = setup()
    try {
      expect(() => recordSanctuarySchedulerLivenessReceipt({
        agentRoot: f.agentRoot, trigger: "cron", occurrenceId: "cron:2026-08-18T17:00:00.000Z", runnerId: "11111111-1111-4111-8111-111111111111",
        scenario: { label: "unit-16f-cron-fingerprint", scenarioHandleDigest },
        supervisor: { ...f.supervisor.authenticatedSnapshot("habit:sanctuary"), binaryPath: "/tmp/not-supercronic" },
        before: { sweepCount: 0, deliveryCount: 0 }, providerInvocationCount: 0, privateTurnCount: 0, ...authenticated,
      })).toThrow(/supervisor attestation/u)
    } finally { fs.rmSync(f.agentRoot, { recursive: true, force: true }) }
  })

  it("closes and removes the temporary receipt after a write failure", () => {
    const f = setup()
    const failure = Object.assign(new Error("write failed"), { code: "EIO" })
    try { expect(() => durableExclusiveJson(path.join(f.agentRoot, "receipt.json"), {}, { ...durableFs, writeFileSync: () => { throw failure } })).toThrow(failure) }
    finally { fs.rmSync(f.agentRoot, { recursive: true, force: true }) }
  })

  it.each(["ENOENT", "EIO"])("handles temporary unlink %s during durable publication", (code) => {
    const f = setup()
    const failure = Object.assign(new Error("unlink failed"), { code })
    const deps = { ...durableFs, unlinkSync: (target: fs.PathLike) => {
      if (String(target).includes(".tmp-")) throw failure
      return fs.unlinkSync(target)
    } }
    try {
      if (code === "ENOENT") expect(() => durableExclusiveJson(path.join(f.agentRoot, "receipt.json"), {}, deps)).not.toThrow()
      else expect(() => durableExclusiveJson(path.join(f.agentRoot, "receipt.json"), {}, deps)).toThrow(failure)
    } finally { fs.rmSync(f.agentRoot, { recursive: true, force: true }) }
  })

  it("preserves a non-collision publication error", () => {
    const f = setup()
    const failure = Object.assign(new Error("link failed"), { code: "EIO" })
    try { expect(() => publishSanctuarySchedulerReceipt(path.join(f.agentRoot, "receipt.json"), {}, { ...durableFs, linkSync: () => { throw failure } })).toThrow(failure) }
    finally { fs.rmSync(f.agentRoot, { recursive: true, force: true }) }
  })

  it("fsyncs every newly created directory entry and the receipt directory after temporary cleanup", () => {
    const f = setup()
    const receiptPath = path.join(f.agentRoot, "new-parent", "new-child", "receipt.json")
    const descriptorPaths = new Map<number, string>()
    const events: string[] = []
    const deps = {
      ...durableFs,
      mkdirSync: ((target: fs.PathLike, options?: fs.MakeDirectoryOptions & { recursive?: false }) => {
        const existed = fs.existsSync(target)
        const result = fs.mkdirSync(target, options)
        if (!existed) events.push(`mkdir:${String(target)}`)
        return result
      }) as typeof fs.mkdirSync,
      openSync: ((target: fs.PathLike, flags: fs.OpenMode, mode?: fs.Mode) => {
        const descriptor = fs.openSync(target, flags, mode)
        descriptorPaths.set(descriptor, String(target))
        return descriptor
      }) as typeof fs.openSync,
      fsyncSync: (descriptor: number) => {
        events.push(`fsync:${descriptorPaths.get(descriptor)}`)
        fs.fsyncSync(descriptor)
      },
      unlinkSync: (target: fs.PathLike) => {
        events.push(`unlink:${String(target)}`)
        fs.unlinkSync(target)
      },
    }
    try {
      durableExclusiveJson(receiptPath, { ok: true }, deps)
      const parent = path.join(f.agentRoot, "new-parent")
      const child = path.join(parent, "new-child")
      expect(events).toContain(`fsync:${f.agentRoot}`)
      expect(events).toContain(`fsync:${parent}`)
      expect(events.filter((event) => event === `fsync:${child}`).length).toBeGreaterThanOrEqual(3)
      const unlinkIndex = events.findIndex((event) => event.startsWith("unlink:"))
      expect(events.slice(unlinkIndex + 1)).toContain(`fsync:${child}`)
    } finally { fs.rmSync(f.agentRoot, { recursive: true, force: true }) }
  })

  it.each(["manual", "poke"])("rejects %s provenance", (trigger) => {
    const f = setup()
    try {
      expect(() => recordSanctuarySchedulerLivenessReceipt({
        agentRoot: f.agentRoot, trigger, occurrenceId: `${trigger}:1`, runnerId: "11111111-1111-4111-8111-111111111111",
        scenario: { label: "unit-16f-cron-fingerprint", scenarioHandleDigest }, supervisor: f.supervisor.authenticatedSnapshot("habit:sanctuary"),
        before: { sweepCount: 0, deliveryCount: 0 }, providerInvocationCount: 0, privateTurnCount: 0, ...authenticated,
      })).toThrow(/cron/u)
    } finally { fs.rmSync(f.agentRoot, { recursive: true, force: true }) }
  })

  it.each([0, 2])("rejects %i scheduler sweeps after the checkpoint", (sweepCount) => {
    const f = setup()
    const state = JSON.parse(fs.readFileSync(f.statePath, "utf8"))
    for (let index = 0; index < sweepCount; index += 1) state.sweepReceipts.push({
      sweepId: `sweep-${index}`, startedAt: "2026-08-18T17:00:00.000Z", completedAt: "2026-08-18T17:00:01.000Z",
      incidentDigest: "b".repeat(64), opened: 0, recovered: 0, digestDue: false, scenarioHandleDigest,
    })
    fs.writeFileSync(f.statePath, `${JSON.stringify(state)}\n`)
    try {
      expect(() => recordSanctuarySchedulerLivenessReceipt({
        agentRoot: f.agentRoot, trigger: "cron", occurrenceId: "cron:2026-08-18T17:00:00.000Z", runnerId: "11111111-1111-4111-8111-111111111111",
        scenario: { label: "unit-16f-cron-fingerprint", scenarioHandleDigest }, supervisor: f.supervisor.authenticatedSnapshot("habit:sanctuary"),
        before: { sweepCount: 0, deliveryCount: 0 }, providerInvocationCount: 0, privateTurnCount: 0, ...authenticated,
      })).toThrow(/exactly one unchanged sweep/u)
    } finally { fs.rmSync(f.agentRoot, { recursive: true, force: true }) }
  })
})
