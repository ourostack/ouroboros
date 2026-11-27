import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto"
import * as fs from "node:fs"
import * as path from "node:path"

import { getAgentBundlesRoot, getAgentRoot } from "../identity"
import { productHabit } from "../product/active"
import type { ProductHabit } from "../product/types"
import { emitNervesEvent } from "../../nerves/runtime"
import { readOrCreateTelegramIdentityKey } from "../../senses/telegram-identity-key"

/**
 * Scheduler attestation: proof that a cron `ouro poke` came from the container's own scheduler (Supercronic), not from a
 * person or process that typed the same command. A product marks a habit `requiresSchedulerAttestation`; the cron poke's
 * CLI process then signs its process ancestry, the daemon checks it against the Supercronic child it supervises, consumes the
 * fire once, and refuses an unattested cron poke of that habit.
 */

const SUPERCRONIC = "/usr/local/bin/supercronic"
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const SHA256 = /^[0-9a-f]{64}$/u
const SLOT_MS = 15 * 60 * 1_000

export interface SchedulerOrigin {
  slot: string
  schedulerRunId: string
  invocationPid: number
  parentPid: number
  parentStartTime: string
  invocationStartTime: string
  proofMac: string
  scenarioHandleDigest: string | null
  occurrenceId: string
}

export interface SchedulerFireCommand extends SchedulerOrigin {
  kind: "habit.scheduler-fire"
  agent: string
  habitName: string
  trigger: "cron"
}

export interface SchedulerAttestationCreateDeps {
  platform: NodeJS.Platform
  pid: number
  ppid: number
  /** The crontab the supervised Supercronic runs; its command line names it. */
  crontabPath: string
  now(): Date
  readFile(path: string): string
  readLink(path: string): string
  identityKey(): string
  /** The acceptance scenario this fire binds to now, or null. */
  scenario(): string | null
  randomId(): string
}

export interface SchedulerAttestationVerifyDeps {
  childPid: number
  crontabPath: string
  identityKey: string
  scenarioHandleDigest: string | null
  now(): Date
  readFile(path: string): string
  readLink(path: string): string
}

/** The crontab the daemon's Supercronic supervisor writes for this agent's habits. */
export function schedulerCrontabPath(agent: string): string {
  return path.join(getAgentBundlesRoot(), "..", ".ouro-cli", "scheduler", `${agent}.crontab`)
}

/** The product habit a cron fire of `habitName` must prove came from the scheduler, or null when none needs to. */
export function attestedHabit(agent: string, habitName: string): ProductHabit | null {
  const habit = productHabit(agent, habitName)
  return habit?.requiresSchedulerAttestation ? habit : null
}

function processIdentity(stat: string): { parentPid: number; startTime: string } {
  const close = stat.lastIndexOf(")")
  if (close < 1) throw new Error("scheduler process identity is invalid")
  const fields = stat.slice(close + 2).trim().split(/\s+/u)
  const parentPid = Number(fields[1])
  const startTime = fields[19]
  if (!Number.isSafeInteger(parentPid) || parentPid < 0 || !startTime || !/^[0-9]+$/u.test(startTime)) throw new Error("scheduler process identity is invalid")
  return { parentPid, startTime }
}

function slotFor(now: Date): string {
  return new Date(Math.floor(now.getTime() / SLOT_MS) * SLOT_MS).toISOString()
}

function unsigned(command: Omit<SchedulerFireCommand, "proofMac"> | SchedulerFireCommand): Record<string, unknown> {
  return Object.fromEntries(Object.entries(command).filter(([key]) => key !== "proofMac"))
}

function mac(key: string, command: Omit<SchedulerFireCommand, "proofMac"> | SchedulerFireCommand): string {
  return createHmac("sha256", key).update(JSON.stringify(unsigned(command))).digest("hex")
}

function safeEqual(left: string, right: string): boolean {
  if (!SHA256.test(left) || !SHA256.test(right)) return false
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"))
}

function isSupercronicProcess(crontabPath: string, pid: number, deps: Pick<SchedulerAttestationCreateDeps, "readFile" | "readLink">): boolean {
  const cmdline = `${SUPERCRONIC}\0-split-logs\0-inotify\0${crontabPath}\0`
  return deps.readLink(`/proc/${pid}/exe`) === SUPERCRONIC && deps.readFile(`/proc/${pid}/cmdline`) === cmdline
}

export function defaultSchedulerAttestationDeps(agent: string, habit: Pick<ProductHabit, "attestationScenario">, agentRoot = getAgentRoot(agent)): SchedulerAttestationCreateDeps {
  return {
    platform: process.platform, pid: process.pid, ppid: process.ppid, crontabPath: schedulerCrontabPath(agent), now: () => new Date(),
    readFile: (target) => fs.readFileSync(target, "utf8"), readLink: (target) => fs.readlinkSync(target),
    identityKey: () => readOrCreateTelegramIdentityKey(agentRoot), scenario: () => habit.attestationScenario?.(agent) ?? null, randomId: () => randomUUID(),
  }
}

/**
 * Turns a cron poke of an attested habit into a signed scheduler fire when this process is a live Supercronic job. Anything
 * else (another habit, another trigger, off Linux, or a parent that is not Supercronic) stays the plain poke, which the daemon
 * then refuses for an attested habit.
 */
export function createSchedulerFireCommand(
  command: { agent: string; habitName: string; trigger: string },
  given?: SchedulerAttestationCreateDeps,
): SchedulerFireCommand | null {
  if (command.trigger !== "cron") return null
  const habit = attestedHabit(command.agent, command.habitName)
  if (!habit) return null
  const deps = given ?? defaultSchedulerAttestationDeps(command.agent, habit)
  if (deps.platform !== "linux") return null
  try {
    const invocation = processIdentity(deps.readFile(`/proc/${deps.pid}/stat`))
    const parent = processIdentity(deps.readFile(`/proc/${deps.ppid}/stat`))
    if (!isSupercronicProcess(deps.crontabPath, deps.ppid, deps) && !isSupercronicProcess(deps.crontabPath, parent.parentPid, deps)) return null
    const scenarioHandleDigest = deps.scenario()
    if (invocation.parentPid !== deps.ppid) return null
    const slot = slotFor(deps.now())
    const value: Omit<SchedulerFireCommand, "proofMac"> = {
      kind: "habit.scheduler-fire", agent: command.agent, habitName: command.habitName, trigger: "cron",
      slot, occurrenceId: `cron:${slot}`, schedulerRunId: deps.randomId(), invocationPid: deps.pid, parentPid: deps.ppid,
      parentStartTime: parent.startTime, invocationStartTime: invocation.startTime,
      scenarioHandleDigest,
    }
    return { ...value, proofMac: mac(deps.identityKey(), value) }
  } catch {
    return null
  }
}

/** Checks a scheduler fire's signature, slot and process ancestry against the Supercronic child the daemon supervises. */
export function verifySchedulerFireCommand(command: SchedulerFireCommand, deps: SchedulerAttestationVerifyDeps): SchedulerOrigin {
  if (!command || command.kind !== "habit.scheduler-fire" || typeof command.agent !== "string" || typeof command.habitName !== "string"
    || !attestedHabit(command.agent, command.habitName) || command.trigger !== "cron"
    || !UUID.test(command.schedulerRunId) || (command.scenarioHandleDigest !== null && !SHA256.test(command.scenarioHandleDigest)) || command.scenarioHandleDigest !== deps.scenarioHandleDigest
    || command.slot !== slotFor(deps.now()) || command.occurrenceId !== `cron:${command.slot}`) throw new Error("scheduler fire slot or binding is invalid")
  if (!safeEqual(command.proofMac, mac(deps.identityKey, command))) throw new Error("scheduler fire authentication failed")
  const invocation = processIdentity(deps.readFile(`/proc/${command.invocationPid}/stat`))
  const parent = processIdentity(deps.readFile(`/proc/${command.parentPid}/stat`))
  if (invocation.parentPid !== command.parentPid || invocation.startTime !== command.invocationStartTime
    || parent.startTime !== command.parentStartTime) throw new Error("scheduler fire ancestry is invalid")
  if (command.parentPid !== deps.childPid && parent.parentPid !== deps.childPid) throw new Error("scheduler fire ancestry is invalid")
  if (command.parentPid === deps.childPid ? !isSupercronicProcess(deps.crontabPath, command.parentPid, deps) : !isSupercronicProcess(deps.crontabPath, parent.parentPid, deps)) throw new Error("scheduler fire ancestry is invalid")
  emitNervesEvent({ component: "daemon", event: "daemon.scheduler_fire_authenticated", message: "Scheduler fire authenticated", meta: { agent: command.agent, habitName: command.habitName, schedulerRunId: command.schedulerRunId, slot: command.slot } })
  return {
    slot: command.slot, schedulerRunId: command.schedulerRunId, invocationPid: command.invocationPid, parentPid: command.parentPid,
    parentStartTime: command.parentStartTime, invocationStartTime: command.invocationStartTime, proofMac: command.proofMac,
    scenarioHandleDigest: command.scenarioHandleDigest, occurrenceId: command.occurrenceId,
  }
}

export type DurableFs = Pick<typeof fs, "mkdirSync" | "openSync" | "writeFileSync" | "fsyncSync" | "closeSync" | "linkSync" | "unlinkSync">

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

/** Writes JSON to a new file durably and exactly once: a file already at the path makes it throw EEXIST. */
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

/** Claims an authenticated fire durably before the habit runs, so the same habit's occurrence never runs twice, even across restarts. */
export function consumeSchedulerFire(agentRoot: string, habitName: string, origin: SchedulerOrigin): void {
  if (!UUID.test(origin.schedulerRunId) || origin.occurrenceId !== `cron:${origin.slot}`) throw new Error("scheduler fire claim is invalid")
  const claimId = createHash("sha256").update(`${habitName}\0${origin.slot}\0${origin.occurrenceId}`).digest("hex")
  const claimPath = path.join(agentRoot, "state", "scheduler", "fire-claims", `${claimId}.json`)
  try {
    durableExclusiveJson(claimPath, { schemaVersion: "scheduler-fire-claim-v1", habitName, ...origin })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      emitNervesEvent({ level: "warn", component: "daemon", event: "daemon.scheduler_fire_rejected", message: "Rejected replayed scheduler fire", meta: { habitName, occurrenceId: origin.occurrenceId, schedulerRunId: origin.schedulerRunId } })
      throw new Error("scheduler fire replay rejected")
    }
    throw error
  }
  emitNervesEvent({ component: "daemon", event: "daemon.scheduler_fire_consumed", message: "Consumed scheduler fire before execution", meta: { habitName, occurrenceId: origin.occurrenceId, schedulerRunId: origin.schedulerRunId } })
}
