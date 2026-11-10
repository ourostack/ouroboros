import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { execFileSync } from "child_process"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"

import { handoffPresenceSense, joinPresenceRoster, renderPresenceStatus } from "../../../heart/daemon/presence-roster"
import { readPresence, writePeerRecord, type PeerRecord } from "../../../heart/daemon/presence"
import { fetchRemote, pushHeadToBranch } from "../../../heart/sync"

// Record freshness depends on the clock; pin it.
beforeAll(() => { vi.useFakeTimers({ now: Date.parse("2026-11-10T03:05:00.000Z"), toFake: ["Date"] }) })
afterAll(() => { vi.useRealTimers() })

vi.setConfig({ testTimeout: 30_000 })

const LAPTOP = "machine_laptop"
const MINI = "machine_mini"
const V = "0.1.0-alpha.1003"
const HOME = { machineId: LAPTOP, machineName: "Aris-MacBook-Pro", since: "2026-10-10T00:00:00.000Z" }

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, stdio: "pipe" }).toString().trim()
}

function record(machineId: string, version = V): PeerRecord {
  return { machineId, version, seenAt: "2026-11-10T03:00:00.000Z" }
}

function roster(owners: Record<string, string> = { teams: LAPTOP, habits: LAPTOP }): Record<string, unknown> {
  return {
    schema: 1,
    minVersion: V,
    machines: [{ machineId: LAPTOP, name: "Aris-MacBook-Pro", role: "laptop" }, { machineId: MINI, name: "aris-mac-mini", role: "always-on" }],
    owners,
  }
}

describe("presence roster commands", () => {
  let tmp: string
  let bundlesRoot: string
  let root: string

  const write = (config: Record<string, unknown>): void => {
    fs.mkdirSync(root, { recursive: true })
    fs.writeFileSync(path.join(root, "agent.json"), `${JSON.stringify(config, null, 2)}\n`)
  }
  const read = (): Record<string, unknown> => JSON.parse(fs.readFileSync(path.join(root, "agent.json"), "utf-8")) as Record<string, unknown>

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "presence-roster-"))
    bundlesRoot = path.join(tmp, "AgentBundles")
    root = path.join(bundlesRoot, "slugger.ouro")
  })
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }) })

  describe("join", () => {
    const join = (machineId: string, machineName: string, role: string) => joinPresenceRoster({ agent: "slugger", bundlesRoot, machineId, machineName, role, minVersion: V })

    it("creates a roster that keeps every shared sense with home", async () => {
      write({ home: HOME })
      const result = await join(MINI, "aris-mac-mini", "always-on")
      expect(result).toEqual({ ok: true, changed: true, message: "aris-mac-mini (always-on) is on slugger's roster with no other machine; bundle sync is off, so only this machine sees the change" })
      const presence = read().presence as { owners: Record<string, string>; machines: unknown[]; minVersion: string }
      expect(presence.minVersion).toBe(V)
      expect(presence.machines).toEqual([{ machineId: MINI, name: "aris-mac-mini", role: "always-on" }])
      expect(presence.owners.teams).toBe(LAPTOP)
      expect(presence.owners.habits).toBe(LAPTOP)
    })

    it("gives a new roster's senses to this machine when the agent has no home", async () => {
      write({})
      await join(MINI, "aris-mac-mini", "always-on")
      expect((read().presence as { owners: Record<string, string> }).owners.teams).toBe(MINI)
    })

    it("adds a second machine, renames one, and does nothing when nothing changed", async () => {
      write({ home: HOME, presence: { ...roster(), machines: [{ machineId: LAPTOP, name: "Aris-MacBook-Pro", role: "laptop" }] } })
      expect((await join(MINI, "aris-mac-mini", "always-on")).message).toContain("with Aris-MacBook-Pro")
      expect((await join(MINI, "aris-mac-mini", "always-on"))).toEqual({ ok: true, changed: false, message: "aris-mac-mini is already on slugger's roster as always-on" })
      expect((await join(MINI, "mini", "always-on")).changed).toBe(true)
      expect((read().presence as { machines: Array<{ name: string }> }).machines.map((machine) => machine.name)).toEqual(["Aris-MacBook-Pro", "mini"])
      expect((read().presence as { owners: Record<string, string> }).owners).toEqual({ teams: LAPTOP, habits: LAPTOP })
    })
  })

  describe("handoff", () => {
    const handoff = (sense: string, target: string) => handoffPresenceSense({ agent: "slugger", bundlesRoot, sense, target })

    it("moves a shared sense once every roster machine runs presence", async () => {
      write({ home: HOME, presence: roster() })
      writePeerRecord(root, record(LAPTOP))
      writePeerRecord(root, record(MINI))
      const result = await handoff("teams", "aris-mac-mini")
      expect(result.ok).toBe(true)
      expect(result.message).toContain("aris-mac-mini now owns slugger's teams (from Aris-MacBook-Pro)")
      expect((read().presence as { owners: Record<string, string> }).owners.teams).toBe(MINI)
      expect(read().home).toEqual(HOME)
      expect((await handoff("teams", MINI))).toEqual({ ok: true, changed: false, message: "aris-mac-mini already owns slugger's teams" })
    })

    it("refuses while a roster machine may still run a home-only daemon", async () => {
      write({ home: HOME, presence: roster() })
      writePeerRecord(root, record(LAPTOP))
      writePeerRecord(root, record(MINI, "0.1.0-alpha.988"))
      const result = await handoff("teams", "aris-mac-mini")
      expect(result.ok).toBe(false)
      expect(result.message).toBe("aris-mac-mini may still run a daemon that only knows `home` (no current presence record at 0.1.0-alpha.1003 or later), so every shared sense stays with home and nothing changed; start a presence-aware daemon there first")
      expect((read().presence as { owners: Record<string, string> }).owners.teams).toBe(LAPTOP)
    })

    it("names the legacy machine by id when it is not on the roster by name, and omits minVersion when unset", async () => {
      const block = roster()
      delete block.minVersion
      write({ home: HOME, presence: block })
      writePeerRecord(root, record(LAPTOP))
      expect((await handoff("teams", "aris-mac-mini")).message).toContain("aris-mac-mini may still run a daemon that only knows `home` (no current presence record), so")
    })

    it("refuses machine-scoped senses, agents without a roster, and machines off the roster", async () => {
      write({ home: HOME })
      expect((await handoff("shepherd", "aris-mac-mini")).message).toContain("shepherd runs on every machine in the roster, so it has no owner to hand off")
      expect((await handoff("teams", "aris-mac-mini")).message).toBe("slugger has no presence roster, so nothing changed; run `ouro presence join --agent slugger` on each machine first")
      write({ home: HOME, presence: roster() })
      expect((await handoff("teams", "kitchen")).message).toBe("kitchen is not on slugger's roster (Aris-MacBook-Pro, aris-mac-mini), so nothing changed")
    })

    it("loses cleanly when another machine hands the same sense off at the same time", async () => {
      const remote = path.join(tmp, "remote.git")
      git(tmp, "init", "--bare", "-q", "-b", "main", remote)
      const seed = path.join(tmp, "seed")
      git(tmp, "clone", "-q", remote, seed)
      git(seed, "checkout", "-q", "-b", "main")
      fs.writeFileSync(path.join(seed, "agent.json"), `${JSON.stringify({ sync: { enabled: true, remote: "origin" }, home: HOME, presence: roster() }, null, 2)}\n`)
      writePeerRecord(seed, record(LAPTOP))
      writePeerRecord(seed, record(MINI))
      git(seed, "add", ".")
      git(seed, "-c", "user.email=t@o", "-c", "user.name=t", "commit", "-q", "-m", "seed")
      git(seed, "push", "-q", "origin", "main")
      fs.mkdirSync(bundlesRoot)
      git(tmp, "clone", "-q", remote, root)
      const rivalRoot = path.join(tmp, "rival-bundles")
      fs.mkdirSync(rivalRoot)
      git(tmp, "clone", "-q", remote, path.join(rivalRoot, "slugger.ouro"))
      let raced = false
      let rivalResult: Awaited<ReturnType<typeof handoffPresenceSense>> | null = null
      const result = await handoffPresenceSense({
        agent: "slugger",
        bundlesRoot,
        sense: "teams",
        target: "aris-mac-mini",
        network: {
          fetch: (agentRoot, config) => fetchRemote(agentRoot, config),
          push: async (agentRoot, config) => {
            if (!raced) {
              raced = true
              rivalResult = await handoffPresenceSense({ agent: "slugger", bundlesRoot: rivalRoot, sense: "teams", target: "Aris-MacBook-Pro" })
              const rivalJson = JSON.parse(fs.readFileSync(path.join(rivalRoot, "slugger.ouro", "agent.json"), "utf-8")) as { presence: Record<string, unknown> }
              rivalJson.presence.owners = { ...(rivalJson.presence.owners as Record<string, string>), teams: "machine_other" }
              rivalJson.presence.machines = [...(rivalJson.presence.machines as unknown[]), { machineId: "machine_other", name: "other", role: "peer" }]
              fs.writeFileSync(path.join(rivalRoot, "slugger.ouro", "agent.json"), `${JSON.stringify(rivalJson, null, 2)}\n`)
              git(path.join(rivalRoot, "slugger.ouro"), "-c", "user.email=t@o", "-c", "user.name=t", "commit", "-qam", "rival handoff")
              git(path.join(rivalRoot, "slugger.ouro"), "push", "-q")
            }
            return pushHeadToBranch(agentRoot, config)
          },
        },
      })
      expect(rivalResult).toEqual({ ok: true, changed: false, message: "Aris-MacBook-Pro already owns slugger's teams" })
      expect(result).toEqual({
        ok: false,
        changed: false,
        message: "another machine changed slugger's teams owner while this handoff was being published (it now names other), so this handoff was undone; run `ouro presence handoff teams aris-mac-mini --agent slugger` again to take it over",
      })
      expect(git(root, "status", "--porcelain")).toBe("")
    })

    it("describes a cleared owner as no machine when the race clears it", async () => {
      const remote = path.join(tmp, "remote.git")
      git(tmp, "init", "--bare", "-q", "-b", "main", remote)
      const seed = path.join(tmp, "seed")
      git(tmp, "clone", "-q", remote, seed)
      git(seed, "checkout", "-q", "-b", "main")
      fs.writeFileSync(path.join(seed, "agent.json"), `${JSON.stringify({ sync: { enabled: true, remote: "origin" }, home: HOME, presence: roster() }, null, 2)}\n`)
      writePeerRecord(seed, record(LAPTOP))
      writePeerRecord(seed, record(MINI))
      git(seed, "add", ".")
      git(seed, "-c", "user.email=t@o", "-c", "user.name=t", "commit", "-q", "-m", "seed")
      git(seed, "push", "-q", "origin", "main")
      fs.mkdirSync(bundlesRoot)
      git(tmp, "clone", "-q", remote, root)
      let raced = false
      const result = await handoffPresenceSense({
        agent: "slugger",
        bundlesRoot,
        sense: "teams",
        target: "aris-mac-mini",
        network: {
          fetch: (agentRoot, config) => fetchRemote(agentRoot, config),
          push: async (agentRoot, config) => {
            if (!raced) {
              raced = true
              const cleared = { sync: { enabled: true, remote: "origin" }, home: HOME, presence: roster({ habits: LAPTOP }) }
              fs.writeFileSync(path.join(seed, "agent.json"), `${JSON.stringify(cleared, null, 2)}\n`)
              git(seed, "-c", "user.email=t@o", "-c", "user.name=t", "commit", "-qam", "clear")
              git(seed, "push", "-q", "origin", "main")
            }
            return pushHeadToBranch(agentRoot, config)
          },
        },
      })
      expect(result.message).toContain("(it now names no machine)")
    })
  })

  describe("status", () => {
    const now = new Date("2026-11-10T04:00:00.000Z")
    const agentJson = { home: HOME, presence: roster({ teams: MINI, habits: LAPTOP }) }

    it("says when presence is off here, or the agent has no roster", () => {
      expect(renderPresenceStatus({ agent: "slugger", presence: null, flagEnabled: false, machineId: LAPTOP, now })).toContain("presence is off on this machine")
      expect(renderPresenceStatus({ agent: "slugger", presence: null, flagEnabled: true, machineId: LAPTOP, now })).toContain("slugger has no presence roster")
    })

    it("lists machines, their records and the effective owners", () => {
      const all = readPresence(agentJson, true, [{ ...record(LAPTOP), seenAt: "2026-11-10T03:59:40.000Z" }, { ...record(MINI), seenAt: "2026-11-10T03:00:00.000Z" }])!
      expect(renderPresenceStatus({ agent: "slugger", presence: all, flagEnabled: true, machineId: LAPTOP, now })).toBe([
        "slugger is present on 2 machines:",
        `- Aris-MacBook-Pro (this machine): laptop; ${V}, seen just now`,
        `- aris-mac-mini: always-on; ${V}, seen 60 min ago`,
        "owners:",
        "- teams: aris-mac-mini",
        "- telegram: Aris-MacBook-Pro",
        "- mail: Aris-MacBook-Pro",
        "- bluebubbles: Aris-MacBook-Pro",
        "- voice: Aris-MacBook-Pro",
        "- a2a: Aris-MacBook-Pro",
        "- habits: Aris-MacBook-Pro",
      ].join("\n"))
    })

    it("shows owners held by home while a machine has no record, and old or odd timestamps", () => {
      const mixed = readPresence(agentJson, true, [{ ...record(LAPTOP), seenAt: "2026-11-07T04:00:00.000Z" }])!
      const text = renderPresenceStatus({ agent: "slugger", presence: mixed, flagEnabled: true, machineId: MINI, now })
      expect(text).toContain("- Aris-MacBook-Pro: laptop; 0.1.0-alpha.1003, seen 3 d ago")
      expect(text).toContain("- aris-mac-mini (this machine): always-on; no presence record yet; may run a home-only daemon")
      expect(text).toContain("- teams: Aris-MacBook-Pro (roster names aris-mac-mini; held by home until every machine runs presence)")
      const odd = readPresence({ presence: roster({ teams: "machine_gone" }) }, true, [{ ...record(LAPTOP), seenAt: "2026-11-10T00:00:00.000Z" }, { ...record(MINI), seenAt: "garbage" }])!
      const oddText = renderPresenceStatus({ agent: "slugger", presence: odd, flagEnabled: true, machineId: LAPTOP, now })
      expect(oddText).toContain("seen 4 h ago")
      expect(oddText).toContain("seen unknown")
      expect(oddText).toContain("- teams: machine_gone")
    })

    it("uses a single-machine wording and the clock when no time is given", () => {
      const one = readPresence({ presence: { schema: 1, machines: [{ machineId: LAPTOP, name: "lap", role: "laptop" }], owners: {} } }, true, [record(LAPTOP)])!
      expect(renderPresenceStatus({ agent: "slugger", presence: one, flagEnabled: true, machineId: LAPTOP })).toContain("slugger is present on 1 machine:")
    })
  })
})
