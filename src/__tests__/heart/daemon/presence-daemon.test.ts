import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"

import { PEER_RECORD_INTERVAL_MS, PresenceTicker, describeOs } from "../../../heart/daemon/presence-daemon"
import { readLocalPresenceSettings, readPeerRecords, readPresence, writeLocalPresenceSettings, type PeerRecord, type Presence } from "../../../heart/daemon/presence"

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

describe("arrival", () => {
  let tmp: string
  let bundlesRoot: string
  let homeDir: string
  let where: string
  let clock: number
  let notify: ReturnType<typeof vi.fn>
  let run: ReturnType<typeof vi.fn>

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "presence-arrival-"))
    bundlesRoot = path.join(tmp, "AgentBundles")
    homeDir = path.join(tmp, "home")
    fs.mkdirSync(path.join(bundlesRoot, "ouroboros.ouro"), { recursive: true })
    where = JSON.stringify({ location: "home", why: "home router", at: "x" })
    clock = new Date(2026, 10, 10, 8, 0).getTime()
    notify = vi.fn(async () => undefined)
    run = vi.fn(async (argv: string[]) => (argv[1] === "where" ? where : JSON.stringify({ ok: true, teams: "All green from the office." })))
    writeLocalPresenceSettings({ enabled: true, location: "home", locationCommand: ["mac", "where", "--json"], onArrive: { office: ["mac", "arrival", "--json"] } }, homeDir)
  })
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }) })

  const ticker = () => new PresenceTicker({
    agents: ["ouroboros"],
    bundlesRoot,
    machineId: LAPTOP,
    version: V,
    homeDir,
    now: () => new Date(clock),
    readPresence: () => presenceWith({}),
    startSchedulers: () => undefined,
    stopSchedulers: () => undefined,
    schedulersRunning: () => true,
    run,
    notify,
  })

  it("announces the first arrival at the office exactly once, even across restarts", async () => {
    const first = ticker()
    await first.tick()
    expect(notify).not.toHaveBeenCalled()
    where = JSON.stringify({ location: "office" })
    await first.tick()
    await first.tick()
    expect(notify).toHaveBeenCalledTimes(1)
    expect(notify).toHaveBeenCalledWith("ouroboros", "Aris-MacBook-Pro just arrived at office for the first time today. Tell Ari on Teams now, once, with this arrival check as written:\n\nAll green from the office.")
    expect(readLocalPresenceSettings(homeDir, {}).location).toBe("office")
    expect(readPeerRecords(path.join(bundlesRoot, "ouroboros.ouro"))[0]!.location).toBe("office")
    // Back home and in again the same day, after a daemon restart: no second post.
    where = "home"
    await ticker().tick()
    where = JSON.stringify({ location: "office" })
    await ticker().tick()
    expect(notify).toHaveBeenCalledTimes(1)
    // The next day it announces again.
    clock += 24 * 3600_000
    where = "home"
    await ticker().tick()
    where = JSON.stringify({ location: "office" })
    await ticker().tick()
    expect(notify).toHaveBeenCalledTimes(2)
  })

  it("passes on a failed arrival check, and keeps the last location when the location command fails or says nothing", async () => {
    run = vi.fn(async (argv: string[]) => {
      if (argv[1] === "where") return where
      throw new Error("bus down")
    })
    where = "office"
    await ticker().tick()
    expect(notify.mock.calls[0]![1]).toContain("the arrival check failed: bus down")
    run = vi.fn(async () => { throw new Error("no gateway") })
    await ticker().tick()
    run = vi.fn(async () => { throw "odd" })
    await ticker().tick()
    run = vi.fn(async () => "")
    await ticker().tick()
    expect(readLocalPresenceSettings(homeDir, {}).location).toBe("office")
  })

  it("records a new location without announcing when no arrival command is set for it", async () => {
    where = "elsewhere"
    await ticker().tick()
    expect(readLocalPresenceSettings(homeDir, {}).location).toBe("elsewhere")
    expect(notify).not.toHaveBeenCalled()
  })

  it("does nothing without a location command, or for a machine off the roster", async () => {
    writeLocalPresenceSettings({ enabled: true, location: "home" }, homeDir)
    await ticker().tick()
    expect(run).not.toHaveBeenCalled()
    writeLocalPresenceSettings({ enabled: true, location: "home", locationCommand: ["mac", "where"], onArrive: { office: ["mac", "arrival"] } }, homeDir)
    where = "office"
    await new PresenceTicker({ ...ticker()["deps"], machineId: "machine_stranger" } as ConstructorParameters<typeof PresenceTicker>[0]).tick()
    expect(notify).not.toHaveBeenCalled()
  })

  it("works without a notifier", async () => {
    where = "office"
    await new PresenceTicker({ ...ticker()["deps"], notify: undefined } as ConstructorParameters<typeof PresenceTicker>[0]).tick()
    expect(fs.existsSync(path.join(bundlesRoot, "ouroboros.ouro", "state", "presence-arrivals.json"))).toBe(true)
  })
})

describe("command output", () => {
  it("reads a location from JSON or a first line, and refuses anything else", async () => {
    const { parseLocationOutput, arrivalText } = await import("../../../heart/daemon/presence-daemon")
    expect(parseLocationOutput('{"location":"office","why":"x"}')).toBe("office")
    expect(parseLocationOutput('{"location":""}')).toBeNull()
    expect(parseLocationOutput("home\nmore")).toBe("home")
    expect(parseLocationOutput("  ")).toBeNull()
    expect(parseLocationOutput("<html>")).toBeNull()
    expect(arrivalText('{"teams":" hi "}')).toBe("hi")
    expect(arrivalText('{"text":"yo"}')).toBe("yo")
    expect(arrivalText('{"ok":true}')).toBe('{"ok":true}')
    expect(arrivalText("plain\n")).toBe("plain")
  })
})
