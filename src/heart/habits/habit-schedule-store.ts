import * as fs from "fs"
import * as path from "path"

import { emitNervesEvent } from "../../nerves/runtime"
import { canonicalizeJson } from "../runtime/canonical-json"
import {
  acquireProtectedLock,
  readProtectedJson,
  readProtectedJsonOptional,
  writeProtectedJsonUnderLock,
} from "../runtime/protected-json-store"
import type { ExactProcessState, ProcessIdentity } from "../runtime/process-identity"
import {
  parseScheduleProvenanceV1,
  reconcileScheduleProvenanceV1,
  type ScheduleProvenanceV1,
} from "./habit-cadence-v1"

export interface HabitScheduleStoreOptions {
  bundleRoot: string
  agent: string
  owner: ProcessIdentity & { daemonInstanceId: string }
  machineTimezone: string
  now(): string
  proveOwnerState(owner: ProcessIdentity): ExactProcessState
}

export interface HabitScheduleDefinitionV1 {
  habitId: string
  cadence: string
  cadenceTimezone: string | null
  created: string | null
}

export class HabitScheduleStore {
  private readonly scheduleDir: string
  private readonly lockTarget: string

  constructor(readonly options: HabitScheduleStoreOptions) {
    const stateRoot = path.join(options.bundleRoot, "state", "habits")
    this.scheduleDir = path.join(stateRoot, "schedules")
    this.lockTarget = path.join(stateRoot, "scheduler-authority.json")
    fs.mkdirSync(this.scheduleDir, { recursive: true, mode: 0o700 })
  }

  reconcile(definition: HabitScheduleDefinitionV1): ScheduleProvenanceV1 {
    const { uid, pid, startIdentity, bootId } = this.options.owner
    const lock = acquireProtectedLock(
      this.lockTarget,
      { uid, pid, startIdentity, bootId },
      this.options.proveOwnerState,
    )
    try {
      const targetPath = this.schedulePath(definition.habitId)
      const prior = readProtectedJsonOptional(targetPath, parseScheduleProvenanceV1)
      if (prior && (prior.agent !== this.options.agent || prior.habitId !== definition.habitId)) {
        throw new Error("Habit schedule authority belongs to another agent or habit")
      }
      const next = reconcileScheduleProvenanceV1({
        prior,
        agent: this.options.agent,
        habitId: definition.habitId,
        cadence: definition.cadence,
        cadenceTimezone: definition.cadenceTimezone,
        created: definition.created,
        machineTimezone: this.options.machineTimezone,
        now: this.options.now(),
      })
      if (prior && canonicalizeJson(next) === canonicalizeJson(prior)) return prior
      const persisted = writeProtectedJsonUnderLock(targetPath, next, parseScheduleProvenanceV1, lock)
      emitNervesEvent({
        component: "heart",
        event: "heart.habit_schedule_authority_persisted",
        message: "persisted canonical habit schedule authority",
        meta: {
          agent: persisted.agent,
          habitId: persisted.habitId,
          scheduleRevision: persisted.scheduleRevision,
          recordVersion: persisted.recordVersion,
        },
      })
      return persisted
    } finally {
      lock.release()
    }
  }

  read(habitId: string): ScheduleProvenanceV1 {
    return readProtectedJson(this.schedulePath(habitId), parseScheduleProvenanceV1)
  }

  private schedulePath(habitId: string): string {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(habitId)) throw new Error("Habit schedule ID is not path-safe")
    return path.join(this.scheduleDir, `${habitId}.json`)
  }
}
