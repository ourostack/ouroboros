import { createHash, randomUUID } from "node:crypto"
import * as fs from "node:fs"
import * as path from "node:path"

import { emitNervesEvent } from "../../nerves/runtime"
import type { SupercronicSupervisorSnapshot } from "./supercronic-supervisor"

const SHA256 = /^[0-9a-f]{64}$/u
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const CRONTAB_PATH = "/home/ouro/.ouro-cli/scheduler/sanctuary.crontab"
const COMMAND = "/usr/local/bin/node /opt/ouro/dist/heart/daemon/ouro-entry.js poke sanctuary --habit sanctuary-health --trigger cron"

interface HealthSweepRecord {
  sweepId: string
  opened: number
  recovered: number
  digestDue: boolean
  deliveryId?: string
  scenarioHandleDigest?: string
  [key: string]: unknown
}

interface HealthState {
  deliveredReceipts: unknown[]
  sweepReceipts: HealthSweepRecord[]
}

export interface SanctuarySchedulerLivenessCursor {
  sweepCount: number
  deliveryCount: number
}

export interface SanctuarySchedulerLivenessReceipt {
  schemaVersion: "sanctuary-scheduler-liveness-receipt-v1"
  label: "unit-16f-cron-fingerprint"
  scenarioHandleDigest: string
  trigger: "cron"
  occurrenceId: string
  runnerId: string
  recordedAt: string
  before: SanctuarySchedulerLivenessCursor
  after: SanctuarySchedulerLivenessCursor
  sweepDelta: 1
  deliveryDelta: 0
  providerInvocationCount: 0
  privateTurnCount: 0
  sweep: { recordDigest: string; opened: 0; recovered: 0; digestDue: false; deliveryId: null }
  supervisor: SupercronicSupervisorSnapshot
  nonReplay: true
}

export interface RecordSanctuarySchedulerLivenessInput {
  agentRoot: string
  trigger: string
  occurrenceId: string
  runnerId: string
  scenario: { label: string; scenarioHandleDigest: string }
  supervisor: SupercronicSupervisorSnapshot
  before: SanctuarySchedulerLivenessCursor
  providerInvocationCount: number
  privateTurnCount: number
  now?: () => Date
}

export function readSanctuaryHealthCursor(agentRoot: string): SanctuarySchedulerLivenessCursor {
  const state = JSON.parse(fs.readFileSync(path.join(agentRoot, "state", "health", "sanctuary-health.json"), "utf8")) as HealthState
  if (!Array.isArray(state.sweepReceipts) || !Array.isArray(state.deliveredReceipts)) throw new Error("Sanctuary health cursor state is invalid")
  return { sweepCount: state.sweepReceipts.length, deliveryCount: state.deliveredReceipts.length }
}

function durableExclusiveJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 })
  const temporary = `${filePath}.tmp-${process.pid}-${randomUUID()}`
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(value)}\n`, { flag: "wx", mode: 0o600 })
    fs.renameSync(temporary, filePath)
    fs.chmodSync(filePath, 0o600)
  } finally {
    try { fs.unlinkSync(temporary) } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error }
  }
}

function validateSupervisor(snapshot: SupercronicSupervisorSnapshot): void {
  const manifest = snapshot.manifest
  if (snapshot.schemaVersion !== "supercronic-supervisor-snapshot-v1" || snapshot.daemonPid !== process.pid
    || snapshot.childCount !== 1 || snapshot.healthy !== true || !Number.isSafeInteger(snapshot.childPid) || snapshot.childPid <= 1
    || snapshot.binaryPath !== "/usr/local/bin/supercronic" || snapshot.crontabPath !== CRONTAB_PATH
    || JSON.stringify(snapshot.args) !== JSON.stringify(["-split-logs", "-inotify", CRONTAB_PATH])
    || snapshot.namespace !== "habit:sanctuary" || manifest.length !== 1
    || manifest[0]?.id !== "sanctuary:sanctuary-health" || manifest[0].agent !== "sanctuary"
    || manifest[0].taskId !== "sanctuary-health" || manifest[0].schedule !== "*/15 * * * *"
    || manifest[0].command !== COMMAND || !snapshot.renderedCrontab.includes(`# ouro:habit:sanctuary:sanctuary:sanctuary-health\n*/15 * * * * ${COMMAND}\n`)) {
    throw new Error("Sanctuary scheduler supervisor attestation is invalid")
  }
}

export function recordSanctuarySchedulerLivenessReceipt(input: RecordSanctuarySchedulerLivenessInput): SanctuarySchedulerLivenessReceipt {
  if (input.trigger !== "cron") throw new Error("Sanctuary scheduler liveness requires cron provenance")
  if (input.scenario.label !== "unit-16f-cron-fingerprint" || !SHA256.test(input.scenario.scenarioHandleDigest)) throw new Error("Sanctuary scheduler liveness scenario is invalid")
  if (input.occurrenceId.length === 0 || !UUID.test(input.runnerId)) throw new Error("Sanctuary scheduler liveness runner provenance is invalid")
  if (input.providerInvocationCount !== 0 || input.privateTurnCount !== 0) throw new Error("Sanctuary scheduler liveness performed paid work")
  validateSupervisor(input.supervisor)
  const statePath = path.join(input.agentRoot, "state", "health", "sanctuary-health.json")
  const state = JSON.parse(fs.readFileSync(statePath, "utf8")) as HealthState
  if (!Array.isArray(state.sweepReceipts) || !Array.isArray(state.deliveredReceipts)) throw new Error("Sanctuary scheduler liveness state is invalid")
  const after = { sweepCount: state.sweepReceipts.length, deliveryCount: state.deliveredReceipts.length }
  const matching = state.sweepReceipts.slice(input.before.sweepCount).filter((row) => row.scenarioHandleDigest === input.scenario.scenarioHandleDigest)
  const sweep = matching[0]
  if (after.sweepCount - input.before.sweepCount !== 1 || matching.length !== 1 || !sweep
    || after.deliveryCount - input.before.deliveryCount !== 0 || sweep.opened !== 0 || sweep.recovered !== 0 || sweep.digestDue !== false || sweep.deliveryId !== undefined) {
    throw new Error("Sanctuary scheduler liveness requires exactly one unchanged sweep")
  }
  const receipt: SanctuarySchedulerLivenessReceipt = {
    schemaVersion: "sanctuary-scheduler-liveness-receipt-v1",
    label: "unit-16f-cron-fingerprint",
    scenarioHandleDigest: input.scenario.scenarioHandleDigest,
    trigger: "cron",
    occurrenceId: input.occurrenceId,
    runnerId: input.runnerId,
    recordedAt: (input.now ?? (() => new Date()))().toISOString(),
    before: input.before,
    after,
    sweepDelta: 1,
    deliveryDelta: 0,
    providerInvocationCount: 0,
    privateTurnCount: 0,
    sweep: { recordDigest: createHash("sha256").update(JSON.stringify(sweep)).digest("hex"), opened: 0, recovered: 0, digestDue: false, deliveryId: null },
    supervisor: input.supervisor,
    nonReplay: true,
  }
  const receiptPath = path.join(input.agentRoot, "state", "acceptance", "scheduler-liveness-receipts", `${input.scenario.scenarioHandleDigest}.json`)
  if (fs.existsSync(receiptPath)) throw new Error("Sanctuary scheduler liveness receipt already exists")
  durableExclusiveJson(receiptPath, receipt)
  emitNervesEvent({ component: "daemon", event: "daemon.sanctuary_scheduler_liveness", message: "Scheduler-origin Sanctuary health sweep attested", meta: { scenarioHandleDigest: input.scenario.scenarioHandleDigest, occurrenceId: input.occurrenceId, runnerId: input.runnerId } })
  return receipt
}
