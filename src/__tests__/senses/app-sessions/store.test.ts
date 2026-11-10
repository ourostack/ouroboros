import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import {
  addProbe, appSessionsSenseStatus, appSessionsStateDir, readProbes, readSnapshot, readWatches, removeProbe, snapshotSummary,
  unwatchSession, updateWatches, WATCH_MS, watchSession, writeSnapshot, type SenseSnapshot,
} from "../../../senses/app-sessions/store"

const NOW = Date.parse("2026-11-10T03:00:00Z")
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
    expect(watchSession(agentRoot, "s1", "Babysitter", 100, NOW)).toEqual({ name: "Babysitter", offset: 100, until: NOW + WATCH_MS })
    // A second write keeps the earlier offset (its reply is not yet read) and the known name.
    expect(watchSession(agentRoot, "s1", null, 300, NOW + 1)).toEqual({ name: "Babysitter", offset: 100, until: NOW + 1 + WATCH_MS })
    expect(watchSession(agentRoot, "s2", null, 5, NOW)).toEqual({ name: null, offset: 5, until: NOW + WATCH_MS })
    expect(unwatchSession(agentRoot, "s2")).toBe(true)
    expect(unwatchSession(agentRoot, "s2")).toBe(false)
    expect(Object.keys(readWatches(agentRoot))).toEqual(["s1"])
  })

  it("moves offsets forward only and drops expired watches", () => {
    watchSession(agentRoot, "s1", null, 100, NOW)
    watchSession(agentRoot, "s2", null, 100, NOW - WATCH_MS)
    watchSession(agentRoot, "s3", null, 100, NOW)
    updateWatches(agentRoot, { s1: 250, s3: 50, gone: 9 }, NOW)
    expect(readWatches(agentRoot)).toEqual({ s1: { name: null, offset: 250, until: NOW + WATCH_MS }, s3: { name: null, offset: 100, until: NOW + WATCH_MS } })
  })

  it("remembers the probe sessions the agent opened", () => {
    expect(readProbes(agentRoot)).toEqual({})
    addProbe(agentRoot, "p1", "Probe", NOW)
    addProbe(agentRoot, "p2", null, NOW)
    removeProbe(agentRoot, "p2")
    expect(readProbes(agentRoot)).toEqual({ p1: { name: "Probe", at: new Date(NOW).toISOString() } })
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
