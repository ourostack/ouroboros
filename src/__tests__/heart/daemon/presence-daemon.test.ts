import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"

import { PEER_RECORD_INTERVAL_MS, PresenceTicker, describeOs } from "../../../heart/daemon/presence-daemon"
import { readPeerRecords, readPresence, writeLocalPresenceSettings, type PeerRecord, type Presence } from "../../../heart/daemon/presence"

const LAPTOP = "machine_laptop"
const MINI = "machine_mini"
const V = "0.1.0-alpha.1003"

function presenceWith(owners: Record<string, string>, records: PeerRecord[] = [rec(LAPTOP), rec(MINI)]): Presence {
  return readPresence({
    home: { machineId: LAPTOP, machineName: "lap" },
    presence: {
      schema: 1,
      minVersion: V,
      machines: [{ machineId: LAPTOP, name: "Aris-MacBook-Pro", role: "laptop" }, { machineId: MINI, name: "aris-mac-mini", role: "always-on" }],
      owners,
    },
  }, true, records)!
}

function rec(machineId: string): PeerRecord {
  return { machineId, version: V, seenAt: "2026-11-10T03:00:00.000Z" }
}

describe("describeOs", () => {
  it("names macOS from the Darwin release, and other platforms plainly", () => {
    expect(describeOs("darwin", "25.1.0")).toBe("macOS 26")
    expect(describeOs("darwin", "24.6.0")).toBe("macOS 15")
    expect(describeOs("darwin", "20.1.0")).toBe("macOS 11")
    expect(describeOs("darwin", "19.6.0")).toBe("macOS (Darwin 19.6.0)")
    expect(describeOs("linux", "6.1.0")).toBe("Linux 6.1.0")
    expect(describeOs("win32", "10.0")).toBe("Windows 10.0")
    expect(describeOs("freebsd", "14")).toBe("freebsd 14")
    expect(describeOs()).toMatch(/\S/)
  })
})

describe("PresenceTicker", () => {
  let tmp: string
  let bundlesRoot: string
  let homeDir: string
  let current: Presence | null
  let running: Set<string>
  let clock: number
  let deps: ConstructorParameters<typeof PresenceTicker>[0]

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "presence-ticker-"))
    bundlesRoot = path.join(tmp, "AgentBundles")
    homeDir = path.join(tmp, "home")
    fs.mkdirSync(path.join(bundlesRoot, "slugger.ouro"), { recursive: true })
    current = presenceWith({ habits: MINI })
    running = new Set()
    clock = Date.parse("2026-11-10T04:00:00.000Z")
    deps = {
      agents: ["slugger", "plain"],
      bundlesRoot,
      machineId: MINI,
      version: V,
      homeDir,
      now: () => new Date(clock),
      readPresence: (agentRoot) => (agentRoot.endsWith("slugger.ouro") ? current : null),
      sync: vi.fn(async () => undefined),
      startSchedulers: vi.fn((agent: string) => { running.add(agent) }),
      stopSchedulers: vi.fn((agent: string) => { running.delete(agent) }),
      schedulersRunning: (agent: string) => running.has(agent),
      extraRecord: () => ({ appSessions: { at: "2026-11-10T04:00:00.000Z", counts: { working: 3 } } }),
    }
  })
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }) })

  it("starts schedulers at boot without a roster or when this machine owns habits, and holds them otherwise", () => {
    const ticker = new PresenceTicker(deps)
    expect(ticker.shouldStartSchedulers("plain")).toBe(true)
    expect(ticker.shouldStartSchedulers("slugger")).toBe(true)
    current = presenceWith({ habits: LAPTOP })
    expect(ticker.shouldStartSchedulers("slugger")).toBe(false)
  })

  it("starts held schedulers when habits arrive, and stops them when habits leave", async () => {
    const ticker = new PresenceTicker(deps)
    current = presenceWith({ habits: LAPTOP })
    expect(ticker.shouldStartSchedulers("slugger")).toBe(false)
    await ticker.tick()
    expect(deps.startSchedulers).not.toHaveBeenCalled()
    current = presenceWith({ habits: MINI })
    await ticker.tick()
    expect(deps.startSchedulers).toHaveBeenCalledWith("slugger")
    current = presenceWith({ habits: LAPTOP })
    await ticker.tick()
    expect(deps.stopSchedulers).toHaveBeenCalledWith("slugger")
    expect(running.has("slugger")).toBe(false)
  })

  it("never starts schedulers it did not hold back", async () => {
    const ticker = new PresenceTicker(deps)
    await ticker.tick()
    expect(deps.startSchedulers).not.toHaveBeenCalled()
  })

  it("syncs each minute and publishes this machine's record every 15 minutes", async () => {
    writeLocalPresenceSettings({ enabled: true, location: "home office" }, homeDir)
    const ticker = new PresenceTicker(deps)
    await ticker.tick()
    const root = path.join(bundlesRoot, "slugger.ouro")
    expect(deps.sync).toHaveBeenCalledWith("slugger", root)
    expect(readPeerRecords(root)).toEqual([expect.objectContaining({
      machineId: MINI,
      version: V,
      seenAt: "2026-11-10T04:00:00.000Z",
      name: "aris-mac-mini",
      role: "always-on",
      location: "home office",
      owns: ["habits"],
      appSessions: { at: "2026-11-10T04:00:00.000Z", counts: { working: 3 } },
    })])
    clock += 60_000
    await ticker.tick()
    expect(readPeerRecords(root)[0]!.seenAt).toBe("2026-11-10T04:00:00.000Z")
    clock += PEER_RECORD_INTERVAL_MS
    await ticker.tick()
    expect(readPeerRecords(root)[0]!.seenAt).toBe("2026-11-10T04:16:00.000Z")
    expect(deps.sync).toHaveBeenCalledTimes(3)
  })

  it("defaults the location from the role, and publishes nothing for a machine off the roster", async () => {
    const root = path.join(bundlesRoot, "slugger.ouro")
    await new PresenceTicker({ ...deps, extraRecord: undefined }).tick()
    expect(readPeerRecords(root)[0]).toEqual(expect.objectContaining({ location: "home" }))
    expect(readPeerRecords(root)[0]!.appSessions).toBeUndefined()
    const laptopDeps = { ...deps, machineId: LAPTOP, readPresence: () => presenceWith({}), now: () => new Date(clock) }
    await new PresenceTicker(laptopDeps).tick()
    expect(readPeerRecords(root).find((record) => record.machineId === LAPTOP)?.location).toBe("unknown")
    const strangerRoot = path.join(tmp, "stranger")
    await new PresenceTicker({ ...deps, bundlesRoot: strangerRoot, machineId: "machine_stranger" }).tick()
    expect(fs.existsSync(path.join(strangerRoot, "slugger.ouro", "presence"))).toBe(false)
  })

  it("keeps going when an agent's upkeep fails, and skips agents whose roster disappears after the sync", async () => {
    const failing = new PresenceTicker({ ...deps, sync: async () => { throw new Error("remote gone") } })
    await expect(failing.tick()).resolves.toBeUndefined()
    const failingString = new PresenceTicker({ ...deps, sync: async () => { throw "plain" } })
    await expect(failingString.tick()).resolves.toBeUndefined()
    let reads = 0
    const vanishing = new PresenceTicker({ ...deps, readPresence: () => (reads++ === 0 ? current : null) })
    await vanishing.tick()
    expect(readPeerRecords(path.join(bundlesRoot, "slugger.ouro"))).toEqual([])
  })

  it("works without a sync or a clock", async () => {
    await new PresenceTicker({ ...deps, sync: undefined, now: undefined }).tick()
    expect(readPeerRecords(path.join(bundlesRoot, "slugger.ouro"))).toHaveLength(1)
  })
})
