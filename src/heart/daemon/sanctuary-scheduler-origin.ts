import { createHmac, randomUUID, timingSafeEqual } from "node:crypto"
import * as fs from "node:fs"

import { getAgentRoot } from "../identity"
import { emitNervesEvent } from "../../nerves/runtime"
import { readOrCreateTelegramIdentityKey } from "../../senses/telegram"
import { readSanctuaryAcceptanceMarker, type SanctuaryAcceptanceMarker } from "./sanctuary-acceptance-marker"

const CRONTAB_PATH = "/home/ouro/.ouro-cli/scheduler/sanctuary.crontab"
const SUPERCRONIC = "/usr/local/bin/supercronic"
const SUPERCRONIC_CMDLINE = `${SUPERCRONIC}\0-split-logs\0-inotify\0${CRONTAB_PATH}\0`
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const SHA256 = /^[0-9a-f]{64}$/u
const SLOT_MS = 15 * 60 * 1_000

export interface SanctuarySchedulerOrigin {
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

export interface SanctuarySchedulerFireCommand extends SanctuarySchedulerOrigin {
  kind: "habit.scheduler-fire"
  agent: "sanctuary"
  habitName: "sanctuary-health"
  trigger: "cron"
}

interface CreateDeps {
  platform: NodeJS.Platform
  pid: number
  ppid: number
  now(): Date
  readFile(path: string): string
  readLink(path: string): string
  identityKey(): string
  marker(): SanctuaryAcceptanceMarker | null
  randomId(): string
}

interface VerifyDeps {
  childPid: number
  identityKey: string
  scenarioHandleDigest: string | null
  now(): Date
  readFile(path: string): string
  readLink(path: string): string
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

function unsigned(command: Omit<SanctuarySchedulerFireCommand, "proofMac"> | SanctuarySchedulerFireCommand): Record<string, unknown> {
  return Object.fromEntries(Object.entries(command).filter(([key]) => key !== "proofMac"))
}

function mac(key: string, command: Omit<SanctuarySchedulerFireCommand, "proofMac"> | SanctuarySchedulerFireCommand): string {
  return createHmac("sha256", key).update(JSON.stringify(unsigned(command))).digest("hex")
}

function safeEqual(left: string, right: string): boolean {
  if (!SHA256.test(left) || !SHA256.test(right)) return false
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"))
}

function isSupercronicProcess(pid: number, deps: Pick<CreateDeps | VerifyDeps, "readFile" | "readLink">): boolean {
  return deps.readLink(`/proc/${pid}/exe`) === SUPERCRONIC && deps.readFile(`/proc/${pid}/cmdline`) === SUPERCRONIC_CMDLINE
}

export function defaultSanctuarySchedulerOriginDeps(
  agentRoot = getAgentRoot("sanctuary"),
  markerReader: () => SanctuaryAcceptanceMarker | null = () => readSanctuaryAcceptanceMarker("sanctuary"),
): CreateDeps {
  return {
    platform: process.platform, pid: process.pid, ppid: process.ppid, now: () => new Date(),
    readFile: (target) => fs.readFileSync(target, "utf8"), readLink: (target) => fs.readlinkSync(target),
    identityKey: () => readOrCreateTelegramIdentityKey(agentRoot), marker: markerReader, randomId: () => randomUUID(),
  }
}

export function createSanctuarySchedulerFireCommand(
  command: { agent: string; habitName: string; trigger: string },
  deps: CreateDeps = defaultSanctuarySchedulerOriginDeps(),
): SanctuarySchedulerFireCommand | null {
  if (command.agent !== "sanctuary" || command.habitName !== "sanctuary-health" || command.trigger !== "cron" || deps.platform !== "linux") return null
  try {
    const invocation = processIdentity(deps.readFile(`/proc/${deps.pid}/stat`))
    const parent = processIdentity(deps.readFile(`/proc/${deps.ppid}/stat`))
    if (!isSupercronicProcess(deps.ppid, deps) && !isSupercronicProcess(parent.parentPid, deps)) return null
    const marker = deps.marker()
    if (invocation.parentPid !== deps.ppid) return null
    const slot = slotFor(deps.now())
    const value: Omit<SanctuarySchedulerFireCommand, "proofMac"> = {
      kind: "habit.scheduler-fire", agent: "sanctuary", habitName: "sanctuary-health", trigger: "cron",
      slot, occurrenceId: `cron:${slot}`, schedulerRunId: deps.randomId(), invocationPid: deps.pid, parentPid: deps.ppid,
      parentStartTime: parent.startTime, invocationStartTime: invocation.startTime,
      scenarioHandleDigest: marker?.label === "unit-16f-cron-fingerprint" ? marker.scenarioHandleDigest : null,
    }
    return { ...value, proofMac: mac(deps.identityKey(), value) }
  } catch {
    return null
  }
}

export function verifySanctuarySchedulerFireCommand(command: SanctuarySchedulerFireCommand, deps: VerifyDeps): SanctuarySchedulerOrigin {
  if (!command || command.kind !== "habit.scheduler-fire" || command.agent !== "sanctuary" || command.habitName !== "sanctuary-health" || command.trigger !== "cron"
    || !UUID.test(command.schedulerRunId) || (command.scenarioHandleDigest !== null && !SHA256.test(command.scenarioHandleDigest)) || command.scenarioHandleDigest !== deps.scenarioHandleDigest
    || command.slot !== slotFor(deps.now()) || command.occurrenceId !== `cron:${command.slot}`) throw new Error("scheduler fire slot or binding is invalid")
  if (!safeEqual(command.proofMac, mac(deps.identityKey, command))) throw new Error("scheduler fire authentication failed")
  const invocation = processIdentity(deps.readFile(`/proc/${command.invocationPid}/stat`))
  const parent = processIdentity(deps.readFile(`/proc/${command.parentPid}/stat`))
  if (invocation.parentPid !== command.parentPid || invocation.startTime !== command.invocationStartTime
    || parent.startTime !== command.parentStartTime) throw new Error("scheduler fire ancestry is invalid")
  if (command.parentPid !== deps.childPid && parent.parentPid !== deps.childPid) throw new Error("scheduler fire ancestry is invalid")
  if (command.parentPid === deps.childPid ? !isSupercronicProcess(command.parentPid, deps) : !isSupercronicProcess(parent.parentPid, deps)) throw new Error("scheduler fire ancestry is invalid")
  emitNervesEvent({ component: "daemon", event: "daemon.sanctuary_scheduler_origin_authenticated", message: "Sanctuary scheduler origin authenticated", meta: { schedulerRunId: command.schedulerRunId, slot: command.slot } })
  return {
    slot: command.slot, schedulerRunId: command.schedulerRunId, invocationPid: command.invocationPid, parentPid: command.parentPid,
    parentStartTime: command.parentStartTime, invocationStartTime: command.invocationStartTime, proofMac: command.proofMac,
    scenarioHandleDigest: command.scenarioHandleDigest, occurrenceId: command.occurrenceId,
  }
}
