import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto"
import * as fs from "node:fs"
import * as path from "node:path"

import { emitNervesEvent } from "../../nerves/runtime"
import type { SupercronicSupervisorSnapshot } from "./supercronic-supervisor"
import type { SanctuarySchedulerOrigin } from "./sanctuary-scheduler-origin"

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
  schedulerOrigin: SanctuarySchedulerOrigin
  nonReplay: true
  receiptMac: string
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
  schedulerOrigin: SanctuarySchedulerOrigin
  identityKey: string
  now?: () => Date
}

export function readSanctuaryHealthCursor(agentRoot: string): SanctuarySchedulerLivenessCursor {
  const state = JSON.parse(fs.readFileSync(path.join(agentRoot, "state", "health", "sanctuary-health.json"), "utf8")) as HealthState
  if (!Array.isArray(state.sweepReceipts) || !Array.isArray(state.deliveredReceipts)) throw new Error("Sanctuary health cursor state is invalid")
  return { sweepCount: state.sweepReceipts.length, deliveryCount: state.deliveredReceipts.length }
}

type DurableFs = Pick<typeof fs, "mkdirSync" | "openSync" | "writeFileSync" | "fsyncSync" | "closeSync" | "linkSync" | "unlinkSync">

function fsyncDirectory(directory: string, deps: DurableFs): void {
  const descriptor = deps.openSync(directory, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW)
  try { deps.fsyncSync(descriptor) } finally { deps.closeSync(descriptor) }
}

function ensureDurableDirectory(directory: string, deps: DurableFs): void {
  try {
    deps.mkdirSync(directory, { mode: 0o700 })
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === "EEXIST") {
      fsyncDirectory(directory, deps)
      fsyncDirectory(path.dirname(directory), deps)
      return
    }
    if (code !== "ENOENT") throw error
    const parent = path.dirname(directory)
    if (parent === directory) throw error
    ensureDurableDirectory(parent, deps)
    try { deps.mkdirSync(directory, { mode: 0o700 }) }
    catch (retryError) { if ((retryError as NodeJS.ErrnoException).code !== "EEXIST") throw retryError }
  }
  fsyncDirectory(directory, deps)
  fsyncDirectory(path.dirname(directory), deps)
}

export function durableExclusiveJson(filePath: string, value: unknown, deps: DurableFs = fs): void {
  const directory = path.dirname(filePath)
  ensureDurableDirectory(directory, deps)
  const temporary = `${filePath}.tmp-${process.pid}-${randomUUID()}`
  let handle: number | null = null
  try {
    handle = deps.openSync(temporary, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW, 0o600)
    deps.writeFileSync(handle, `${JSON.stringify(value)}\n`, "utf8")
    deps.fsyncSync(handle)
    deps.closeSync(handle)
    handle = null
    deps.linkSync(temporary, filePath)
    fsyncDirectory(directory, deps)
  } finally {
    if (handle !== null) deps.closeSync(handle)
    try { deps.unlinkSync(temporary) } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error }
    finally { fsyncDirectory(directory, deps) }
  }
}

export function consumeSanctuarySchedulerFire(agentRoot: string, origin: SanctuarySchedulerOrigin): void {
  if (!UUID.test(origin.schedulerRunId) || origin.occurrenceId !== `cron:${origin.slot}`) throw new Error("Sanctuary scheduler fire claim is invalid")
  const claimId = createHash("sha256").update(`sanctuary\0sanctuary-health\0${origin.slot}\0${origin.occurrenceId}`).digest("hex")
  const claimPath = path.join(agentRoot, "state", "scheduler", "sanctuary-fire-claims", `${claimId}.json`)
  try {
    durableExclusiveJson(claimPath, { schemaVersion: "sanctuary-scheduler-fire-claim-v1", ...origin })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      emitNervesEvent({ level: "warn", component: "daemon", event: "daemon.sanctuary_scheduler_fire_rejected", message: "Rejected replayed Sanctuary scheduler fire", meta: { occurrenceId: origin.occurrenceId, schedulerRunId: origin.schedulerRunId } })
      throw new Error("Sanctuary scheduler fire replay rejected")
    }
    throw error
  }
  emitNervesEvent({ component: "daemon", event: "daemon.sanctuary_scheduler_fire_consumed", message: "Consumed Sanctuary scheduler fire before execution", meta: { occurrenceId: origin.occurrenceId, schedulerRunId: origin.schedulerRunId } })
}

export function publishSanctuarySchedulerReceipt(filePath: string, value: unknown, deps: DurableFs = fs): void {
  try { durableExclusiveJson(filePath, value, deps) }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error("Sanctuary scheduler liveness receipt already exists"); throw error }
}

function unsignedReceipt(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([key]) => key !== "receiptMac"))
}

export function sanctuarySchedulerLivenessReceiptMac(identityKey: string, value: Record<string, unknown>): string {
  return createHmac("sha256", identityKey).update(`sanctuary-scheduler-liveness-receipt-v2\0${JSON.stringify(unsignedReceipt(value))}`).digest("hex")
}

export function verifySanctuarySchedulerLivenessReceiptMac(identityKey: string, value: Record<string, unknown>): boolean {
  const observed = value.receiptMac
  if (typeof observed !== "string" || !SHA256.test(observed)) return false
  return timingSafeEqual(Buffer.from(observed, "hex"), Buffer.from(sanctuarySchedulerLivenessReceiptMac(identityKey, value), "hex"))
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
    || manifest[0].taskPath !== "/home/ouro/AgentBundles/sanctuary.ouro/habits/sanctuary-health.md"
    || manifest[0].command !== COMMAND || !snapshot.renderedCrontab.includes(`# ouro:habit:sanctuary:sanctuary:sanctuary-health\n*/15 * * * * ${COMMAND}\n`)) {
    throw new Error("Sanctuary scheduler supervisor attestation is invalid")
  }
}

export function recordSanctuarySchedulerLivenessReceipt(input: RecordSanctuarySchedulerLivenessInput): SanctuarySchedulerLivenessReceipt {
  if (input.trigger !== "cron") throw new Error("Sanctuary scheduler liveness requires cron provenance")
  if (input.scenario.label !== "unit-16f-cron-fingerprint" || !SHA256.test(input.scenario.scenarioHandleDigest)) throw new Error("Sanctuary scheduler liveness scenario is invalid")
  if (input.occurrenceId.length === 0 || !UUID.test(input.runnerId)) throw new Error("Sanctuary scheduler liveness runner provenance is invalid")
  if (!/^[A-Za-z0-9_-]{43}$/u.test(input.identityKey) || input.schedulerOrigin.parentPid !== input.supervisor.childPid
    || input.schedulerOrigin.scenarioHandleDigest !== input.scenario.scenarioHandleDigest || input.occurrenceId !== input.schedulerOrigin.occurrenceId
    || input.occurrenceId !== `cron:${input.schedulerOrigin.slot}`
    || !UUID.test(input.schedulerOrigin.schedulerRunId)
    || input.schedulerOrigin.slot.length === 0 || !SHA256.test(input.schedulerOrigin.proofMac)) throw new Error("Sanctuary scheduler liveness authenticated origin is invalid")
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
  const unsigned: Omit<SanctuarySchedulerLivenessReceipt, "receiptMac"> = {
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
    schedulerOrigin: input.schedulerOrigin,
    nonReplay: true,
  }
  const receipt: SanctuarySchedulerLivenessReceipt = { ...unsigned, receiptMac: sanctuarySchedulerLivenessReceiptMac(input.identityKey, unsigned as unknown as Record<string, unknown>) }
  const receiptPath = path.join(input.agentRoot, "state", "acceptance", "scheduler-liveness-receipts", `${input.scenario.scenarioHandleDigest}.json`)
  publishSanctuarySchedulerReceipt(receiptPath, receipt)
  emitNervesEvent({ component: "daemon", event: "daemon.sanctuary_scheduler_liveness", message: "Scheduler-origin Sanctuary health sweep attested", meta: { scenarioHandleDigest: input.scenario.scenarioHandleDigest, occurrenceId: input.occurrenceId, runnerId: input.runnerId } })
  return receipt
}
