import { EventEmitter } from "node:events"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

import { describe, expect, it, vi } from "vitest"

import { recordSanctuarySchedulerLivenessReceipt } from "../../../heart/daemon/sanctuary-scheduler-liveness"
import { SupercronicSupervisor } from "../../../heart/daemon/supercronic-supervisor"

const scenarioHandleDigest = "a".repeat(64)

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

describe("Sanctuary scheduler liveness receipt", () => {
  it("records one scheduler-origin unchanged sweep with daemon and supervisor provenance", () => {
    const f = setup()
    const sweep = { sweepId: "sweep-1", startedAt: "2026-08-18T17:00:00.000Z", completedAt: "2026-08-18T17:00:01.000Z", incidentDigest: "b".repeat(64), opened: 0, recovered: 0, digestDue: false, scenarioHandleDigest }
    const state = JSON.parse(fs.readFileSync(f.statePath, "utf8"))
    state.sweepReceipts.push(sweep)
    fs.writeFileSync(f.statePath, `${JSON.stringify(state)}\n`)
    try {
      const receipt = recordSanctuarySchedulerLivenessReceipt({
        agentRoot: f.agentRoot, trigger: "cron", occurrenceId: "cron:slot-1", runnerId: "11111111-1111-4111-8111-111111111111",
        scenario: { label: "unit-16f-cron-fingerprint", scenarioHandleDigest }, supervisor: f.supervisor.authenticatedSnapshot("habit:sanctuary"),
        before: { sweepCount: 0, deliveryCount: 0 }, providerInvocationCount: 0, privateTurnCount: 0,
      })
      expect(receipt).toMatchObject({ schemaVersion: "sanctuary-scheduler-liveness-receipt-v1", trigger: "cron", occurrenceId: "cron:slot-1", scenarioHandleDigest, sweepDelta: 1, deliveryDelta: 0, providerInvocationCount: 0, privateTurnCount: 0, nonReplay: true })
      expect(receipt.supervisor).toMatchObject({ daemonPid: process.pid, childCount: 1, childPid: 42, healthy: true, namespace: "habit:sanctuary", args: ["-split-logs", "-inotify", "/home/ouro/.ouro-cli/scheduler/sanctuary.crontab"] })
      expect(receipt.sweep).toMatchObject({ opened: 0, recovered: 0, digestDue: false })
    } finally { fs.rmSync(f.agentRoot, { recursive: true, force: true }) }
  })

  it.each(["manual", "poke"])("rejects %s provenance", (trigger) => {
    const f = setup()
    try {
      expect(() => recordSanctuarySchedulerLivenessReceipt({
        agentRoot: f.agentRoot, trigger, occurrenceId: `${trigger}:1`, runnerId: "11111111-1111-4111-8111-111111111111",
        scenario: { label: "unit-16f-cron-fingerprint", scenarioHandleDigest }, supervisor: f.supervisor.authenticatedSnapshot("habit:sanctuary"),
        before: { sweepCount: 0, deliveryCount: 0 }, providerInvocationCount: 0, privateTurnCount: 0,
      })).toThrow(/cron/u)
    } finally { fs.rmSync(f.agentRoot, { recursive: true, force: true }) }
  })
})
