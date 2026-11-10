import { spawn, spawnSync } from "node:child_process"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, describe, expect, it } from "vitest"

// What starting Ouro may cost. `ouro --version` and an agentless daemon must
// not load product SDKs that only some agents use; those load on the path that
// needs them. The caps are a ratchet: when a change makes startup leaner, lower
// them to the new numbers plus a little headroom; never raise one to make a
// change pass. The edge-benchmark workflow reports the same numbers per host.
const PRODUCT_SDKS = [
  "stripe",
  "@azure/storage-blob",
  "@azure/identity",
  "@azure/core-rest-pipeline",
  "mailparser",
  "smtp-server",
  "@microsoft/teams.apps",
  "@microsoft/teams.api",
  "@microsoft/teams.graph",
  // Model SDKs and the agent tool registry's libraries load with the first
  // turn or ping, in the process that runs it.
  "openai",
  "@anthropic-ai/sdk",
  "ajv",
  "fast-glob",
  "ws",
]
const CAPS = {
  version: { modules: 280, maxRssMb: 125 },
  daemon: { modules: 290, maxRssMb: 130 },
}

const REPO_ROOT = process.cwd()
const CENSUS = path.resolve(__dirname, "fixtures", "module-census.cjs")
const ENTRY = path.join(REPO_ROOT, "dist", "heart", "daemon", "ouro-entry.js")
const DAEMON_ENTRY = path.join(REPO_ROOT, "dist", "heart", "daemon", "daemon-entry.js")

interface Census {
  modules: number
  packages: Record<string, number>
  maxRssKb: number
}

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

function sandbox(): { root: string; home: string; env: NodeJS.ProcessEnv; censusPath: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ouro-lean-startup-"))
  roots.push(root)
  const home = path.join(root, "home")
  fs.mkdirSync(home)
  const censusPath = path.join(root, "census.json")
  return { root, home, censusPath, env: { ...process.env, HOME: home, OURO_CENSUS_OUT: censusPath } }
}

function readCensus(file: string): Census {
  return JSON.parse(fs.readFileSync(file, "utf8")) as Census
}

function expectLean(census: Census, cap: { modules: number; maxRssMb: number }): void {
  const loadedSdks = PRODUCT_SDKS.filter((name) => census.packages[name])
  expect(loadedSdks, "product SDKs loaded at startup").toEqual([])
  expect(census.modules, `modules loaded (${JSON.stringify(census.packages)})`).toBeLessThanOrEqual(cap.modules)
  // maxRSS is kilobytes on Linux and bytes on macOS.
  const maxRssMb = process.platform === "darwin" ? census.maxRssKb / 1024 / 1024 : census.maxRssKb / 1024
  expect(maxRssMb, "peak RSS in MB").toBeLessThanOrEqual(cap.maxRssMb)
}

describe("lean startup", () => {
  it("`ouro --version` loads no product SDKs and stays under its module and memory caps", () => {
    const { home, env, censusPath } = sandbox()
    const result = spawnSync(process.execPath, ["--require", CENSUS, ENTRY, "--version"], { cwd: home, env, encoding: "utf8" })
    expect(result.status, result.stderr).toBe(0)
    expectLean(readCensus(censusPath), CAPS.version)
  })

  it("an agentless daemon loads no product SDKs and stays under its module and memory caps", async () => {
    const { root, home, env, censusPath } = sandbox()
    // Its own socket in the sandbox, never the machine's daemon socket.
    const socketPath = path.join(root, "daemon.sock")
    const child = spawn(process.execPath, ["--require", CENSUS, DAEMON_ENTRY, "--socket", socketPath], { cwd: home, env, stdio: "ignore" })
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()))
    const started = Date.now()
    while (!fs.existsSync(socketPath) && Date.now() - started < 60_000) await new Promise((resolve) => setTimeout(resolve, 100))
    expect(fs.existsSync(socketPath), "daemon opened its socket").toBe(true)
    child.kill("SIGTERM")
    await exited
    expectLean(readCensus(censusPath), CAPS.daemon)
  })
})
