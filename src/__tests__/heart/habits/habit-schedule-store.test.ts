import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { afterEach, describe, expect, it } from "vitest"

import { HabitScheduleStore } from "../../../heart/habits/habit-schedule-store"
import type { ExactProcessState, ProcessIdentity } from "../../../heart/runtime/process-identity"

const roots: string[] = []
const owner: ProcessIdentity & { daemonInstanceId: string } = {
  uid: 501,
  pid: 1234,
  startIdentity: "start-1",
  bootId: "boot-1",
  daemonInstanceId: "daemon-1",
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

function createStore(bundleRoot?: string, now = "2026-07-24T10:00:00.000Z"): HabitScheduleStore {
  const root = bundleRoot ?? fs.mkdtempSync(path.join(os.tmpdir(), "habit-schedule-"))
  if (!bundleRoot) roots.push(root)
  return new HabitScheduleStore({
    bundleRoot: root,
    agent: "slugger",
    owner,
    machineTimezone: "America/Los_Angeles",
    now: () => now,
    proveOwnerState: (candidate): ExactProcessState => candidate.pid === owner.pid
      ? { state: "alive", observed: candidate }
      : { state: "dead", reason: "process-absent" },
  })
}

describe("habit schedule store", () => {
  it("persists one stable first-seen interval anchor across store instances", () => {
    const firstStore = createStore()
    const first = firstStore.reconcile({ habitId: "pulse", cadence: "30m", cadenceTimezone: null, created: null })
    const secondStore = createStore(firstStore.options.bundleRoot, "2026-07-24T11:00:00.000Z")
    const second = secondStore.reconcile({ habitId: "pulse", cadence: "30m", cadenceTimezone: null, created: null })

    expect(second).toEqual(first)
    expect(second.normalized).toMatchObject({
      kind: "interval",
      anchorUtc: "2026-07-24T10:00:00.000Z",
      anchorSource: "schedule-state-first-seen",
    })
    expect(fs.statSync(path.join(firstStore.options.bundleRoot, "state", "habits", "schedules", "pulse.json")).mode & 0o777).toBe(0o600)
  })

  it("persists the first machine timezone and keeps it through a cadence revision", () => {
    const authority = createStore()
    const first = authority.reconcile({ habitId: "daily", cadence: "0 10 * * *", cadenceTimezone: null, created: null })
    const changed = authority.reconcile({ habitId: "daily", cadence: "30 10 * * *", cadenceTimezone: null, created: null })

    expect(first.normalized).toMatchObject({ kind: "cron", timezone: "America/Los_Angeles", timezoneSource: "machine-first-seen" })
    expect(changed.normalized).toMatchObject({ kind: "cron", timezone: "America/Los_Angeles", timezoneSource: "machine-first-seen" })
    expect(changed.recordVersion).toBe(2)
    expect(changed.firstSeenAt).toBe(first.firstSeenAt)
  })

  it("fails closed when persisted schedule provenance is tampered", () => {
    const authority = createStore()
    authority.reconcile({ habitId: "daily", cadence: "0 10 * * *", cadenceTimezone: "UTC", created: null })
    const target = path.join(authority.options.bundleRoot, "state", "habits", "schedules", "daily.json")
    const value = JSON.parse(fs.readFileSync(target, "utf8")) as Record<string, unknown>
    value.scheduleRevision = "z".repeat(43)
    fs.writeFileSync(target, JSON.stringify(value), { mode: 0o600 })
    expect(() => authority.read("daily")).toThrow(/corrupt|invalid|revision/i)
  })

  it("rejects cross-agent and path-escaping schedule ownership", () => {
    const authority = createStore()
    authority.reconcile({ habitId: "daily", cadence: "0 10 * * *", cadenceTimezone: "UTC", created: null })
    const otherAgent = new HabitScheduleStore({ ...authority.options, agent: "other-agent" })
    expect(() => otherAgent.reconcile({ habitId: "daily", cadence: "0 10 * * *", cadenceTimezone: "UTC", created: null })).toThrow(/another agent/)
    expect(() => authority.read("../daily")).toThrow(/path-safe/)
  })
})
