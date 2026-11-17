import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import {
  appSessionsSenseStatus, appSessionsStateDir, readSnapshot, readWatches, snapshotSummary,
  unwatchSession, updateWatches, WATCH_MS, watchSession, writeSnapshot, type SenseSnapshot,
} from "../../../senses/app-sessions/store"

const NOW = Date.parse("2026-11-10T03:00:00Z")
const T0 = "2026-11-10T01:00:00.000Z"
const T1 = "2026-11-10T02:00:00.000Z"
const T2 = "2026-11-10T02:30:00.000Z"
let agentRoot: string

beforeEach(() => {
  agentRoot = fs.mkdtempSync(path.join(os.tmpdir(), "app-sessions-store-"))
})

afterEach(() => {
  fs.rmSync(agentRoot, { recursive: true, force: true })
})

const picture = (extra: Partial<SenseSnapshot> = {}): SenseSnapshot => ({
  at: new Date(NOW).toISOString(), appRunning: true, counts: { working: 2, idle: 5, waiting: 1, stuck: 1 },
  sessions: [], stuck: [{ id: "s1", name: "Babysitter" }], ...extra,
})

describe("app-sessions store", () => {
  it("keeps its files in the agent's state", () => {
    expect(appSessionsStateDir(agentRoot)).toBe(path.join(agentRoot, "state", "senses", "app-sessions"))
  })

  it("watches a session, extends the watch on another write, and stops watching", () => {
    expect(readWatches(agentRoot)).toEqual({})
    expect(watchSession(agentRoot, "s1", "Babysitter", T1, NOW)).toEqual({ name: "Babysitter", after: T1, until: NOW + WATCH_MS })
    // A later write keeps the earlier cursor (its reply is not yet read) and the known name.
    expect(watchSession(agentRoot, "s1", null, T2, NOW + 1)).toEqual({ name: "Babysitter", after: T1, until: NOW + 1 + WATCH_MS })
    expect(watchSession(agentRoot, "s2", null, T0, NOW)).toEqual({ name: null, after: T0, until: NOW + WATCH_MS })
    expect(unwatchSession(agentRoot, "s2")).toBe(true)
    expect(unwatchSession(agentRoot, "s2")).toBe(false)
    expect(Object.keys(readWatches(agentRoot))).toEqual(["s1"])
  })

  it("moves cursors forward only and drops expired watches", () => {
    watchSession(agentRoot, "s1", null, T1, NOW)
    watchSession(agentRoot, "s2", null, T1, NOW - WATCH_MS)
    watchSession(agentRoot, "s3", null, T1, NOW)
    updateWatches(agentRoot, { s1: T2, s3: T0, gone: T2 }, NOW)
    expect(readWatches(agentRoot)).toEqual({ s1: { name: null, after: T2, until: NOW + WATCH_MS }, s3: { name: null, after: T1, until: NOW + WATCH_MS } })
  })

  it("writes and reads the snapshot", () => {
    expect(readSnapshot(agentRoot)).toBeNull()
    writeSnapshot(agentRoot, picture())
    expect(readSnapshot(agentRoot)).toEqual(picture())
  })

  it("summarizes the snapshot for the prompt and health", () => {
    expect(snapshotSummary(null, NOW)).toBe("no snapshot yet")
    expect(snapshotSummary(picture(), NOW)).toBe("2 working, 1 waiting, 1 stuck, 5 idle; stuck: s1 (Babysitter), as of 2026-11-10T03:00:00.000Z")
    expect(snapshotSummary(picture({ stuck: [], appRunning: false }), NOW + 10 * 60_000)).toBe("app not running; 2 working, 1 waiting, 1 stuck, 5 idle, as of 2026-11-10T03:00:00.000Z (stale)")
    const many = Array.from({ length: 10 }, (_, index) => ({ id: `s${index}`, name: `n${index}` }))
    expect(snapshotSummary(picture({ stuck: many }), NOW)).toContain("s7 (n7) and 2 more")
    expect(snapshotSummary(picture({ error: "no database" }), NOW)).toBe("could not read the Copilot app: no database, as of 2026-11-10T03:00:00.000Z")
  })

  it("renders the prompt's sense row", () => {
    expect(appSessionsSenseStatus(false, agentRoot, NOW)).toBe("disabled")
    expect(appSessionsSenseStatus(true, agentRoot, NOW)).toBe("ready (no snapshot yet; app_sessions_* tools read and write them)")
  })
})
