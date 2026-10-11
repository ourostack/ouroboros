import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"

import { parseOuroCommand, runOuroCli, type OuroCliDeps } from "../../../heart/daemon/daemon-cli"

function writeAgent(bundlesRoot: string, agent: string, config: Record<string, unknown>): void {
  fs.mkdirSync(path.join(bundlesRoot, `${agent}.ouro`), { recursive: true })
  fs.writeFileSync(
    path.join(bundlesRoot, `${agent}.ouro`, "agent.json"),
    JSON.stringify({ enabled: true, vault: { email: `${agent}@ouro.bot`, serverUrl: "https://vault.ouro.bot" }, ...config }),
  )
}

describe("ouro move: parsing", () => {
  it("parses `ouro move <agent> here`", () => {
    expect(parseOuroCommand(["move", "slugger", "here"])).toEqual({ kind: "agent.move", agent: "slugger" })
  })

  it("rejects anything but `here` as the destination", () => {
    expect(() => parseOuroCommand(["move", "slugger"])).toThrow("Usage: ouro move <agent> here")
    expect(() => parseOuroCommand(["move", "slugger", "there"])).toThrow("Usage: ouro move <agent> here")
    expect(() => parseOuroCommand(["move", "slugger", "here", "now"])).toThrow("Usage: ouro move <agent> here")
  })
})

describe("ouro move: execution", () => {
  let tmp: string
  let bundlesRoot: string
  let homeDir: string

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ouro-move-"))
    bundlesRoot = path.join(tmp, "AgentBundles")
    homeDir = path.join(tmp, "home")
    fs.mkdirSync(bundlesRoot)
    fs.mkdirSync(homeDir)
  })

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  function deps(): OuroCliDeps {
    return {
      socketPath: "/tmp/ouro-test.sock",
      sendCommand: vi.fn(),
      startDaemonProcess: vi.fn(async () => ({ pid: 1 })),
      writeStdout: vi.fn(),
      checkSocketAlive: vi.fn(async () => false),
      cleanupStaleSocket: vi.fn(),
      fallbackPendingMessage: vi.fn(() => "/tmp/pending.jsonl"),
      setExitCode: vi.fn(),
      bundlesRoot,
      homeDir,
      now: () => Date.parse("2026-10-10T12:00:00.000Z"),
    }
  }

  it("homes the agent here and names the unclaimed agents that stop running here", async () => {
    writeAgent(bundlesRoot, "ouroboros", {})
    writeAgent(bundlesRoot, "slugger", {})
    writeAgent(bundlesRoot, "away", { home: { machineId: "machine_other", machineName: "other-mac" } })

    const result = await runOuroCli(["move", "ouroboros", "here"], deps())

    const config = JSON.parse(fs.readFileSync(path.join(bundlesRoot, "ouroboros.ouro", "agent.json"), "utf-8"))
    const identity = JSON.parse(fs.readFileSync(path.join(homeDir, ".ouro-cli", "machine.json"), "utf-8"))
    expect(config.home).toEqual(expect.objectContaining({ machineId: identity.machineId, since: "2026-10-10T12:00:00.000Z" }))
    expect(result).toContain(`ouroboros now lives on ${config.home.machineName}`)
    expect(result).toContain("Run `ouro up` to start it here.")
    expect(result).toContain("these unclaimed agents stop here at the next `ouro up`: slugger.")
    expect(result).not.toContain("away")
  })

  it("says nothing more when the agent already lives here", async () => {
    writeAgent(bundlesRoot, "ouroboros", {})
    await runOuroCli(["move", "ouroboros", "here"], deps())

    const result = await runOuroCli(["move", "ouroboros", "here"], deps())

    expect(result).toMatch(/^ouroboros already lives on this machine \(.+\)$/)
  })

  it("fails with exit code 1 when the agent has no bundle", async () => {
    const cliDeps = deps()

    const result = await runOuroCli(["move", "ghost", "here"], cliDeps)

    expect(result).toContain("cannot read")
    expect(cliDeps.setExitCode).toHaveBeenCalledWith(1)
  })
})

describe("ouro status: agent homes", () => {
  it("shows where each agent runs", async () => {
    const cliDeps: OuroCliDeps = {
      socketPath: "/tmp/ouro-test.sock",
      sendCommand: vi.fn(async () => ({
        ok: true,
        summary: "daemon=running",
        data: {
          overview: {},
          senses: [],
          workers: [],
          sync: [],
          agents: [
            { name: "ouroboros", enabled: true, homeState: "here", homeMachine: "this-mac" },
            { name: "slugger", enabled: true, homeState: "elsewhere", homeMachine: "other-mac" },
            { name: "stray", enabled: true, homeState: "unclaimed" },
            { name: "legacy", enabled: true, homeState: "fallback" },
          ],
        },
      })),
      startDaemonProcess: vi.fn(async () => ({ pid: 1 })),
      writeStdout: vi.fn(),
      checkSocketAlive: vi.fn(async () => true),
      cleanupStaleSocket: vi.fn(),
      fallbackPendingMessage: vi.fn(() => "/tmp/pending.jsonl"),
    }

    const result = await runOuroCli(["status"], cliDeps)

    expect(result).toContain("home: this machine")
    expect(result).toContain("home: other-mac, not run here")
    expect(result).toContain("no home; not run here (claim: ouro move stray here)")
    expect(result).toContain("no home; runs here until a machine claims it (claim: ouro move legacy here)")
  })
})
