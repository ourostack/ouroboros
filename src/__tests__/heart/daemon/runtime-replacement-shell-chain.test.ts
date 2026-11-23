import { spawnSync } from "child_process"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { afterEach, describe, expect, it } from "vitest"

import { detectDaemonLaunchdJob, parseProcessParents } from "../../../heart/daemon/runtime-replacement-handoff"
import { OURO_RECOVERY_LAUNCHER_SCRIPT, OURO_WRAPPER_SCRIPT } from "../../../heart/versioning/ouro-recovery-launcher"

// A stand-in for the CLI entry. Run as `up --latest` it re-execs itself the way
// reExecFromNewVersion does (execFileSync("node", ...), inherited env). Run as
// `up` it records what the real check would see: its env, its pid and the
// process table at that moment.
const FAKE_ENTRY = `
const fs = require("fs")
const cp = require("child_process")
const args = process.argv.slice(2)
if (args[1] === "--latest") {
  cp.execFileSync("node", [__filename, "up"], { stdio: "inherit" })
  process.exit(0)
}
fs.writeFileSync(process.env.CHAIN_RECORD, JSON.stringify({
  xpcServiceName: process.env.XPC_SERVICE_NAME ?? null,
  pid: process.pid,
  ps: cp.execFileSync("ps", ["-axo", "pid=,ppid="], { encoding: "utf8" }),
}))
`

const tempHomes: string[] = []
afterEach(() => {
  for (const home of tempHomes.splice(0)) fs.rmSync(home, { recursive: true, force: true })
})

function installChain(): { home: string; wrapper: string; record: string } {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ouro-shell-chain-"))
  tempHomes.push(home)
  const bin = path.join(home, ".ouro-cli", "bin")
  const entryDir = path.join(home, ".ouro-cli", "CurrentVersion", "node_modules", "@ouro.bot", "cli", "dist", "heart", "daemon")
  fs.mkdirSync(bin, { recursive: true })
  fs.mkdirSync(entryDir, { recursive: true })
  const wrapper = path.join(bin, "ouro")
  fs.writeFileSync(wrapper, OURO_WRAPPER_SCRIPT, { mode: 0o755 })
  fs.writeFileSync(path.join(bin, "ouro-launcher.js"), OURO_RECOVERY_LAUNCHER_SCRIPT)
  fs.writeFileSync(path.join(entryDir, "ouro-entry.js"), FAKE_ENTRY)
  return { home, wrapper, record: path.join(home, "chain-record.json") }
}

// 2026-11-22 live test: Slugger's shell tool ran `...; ouro up --latest 2>&1 | tail -20`
// inside the daemon's launchd job. Apple's /bin/sh, bash and zsh set
// XPC_SERVICE_NAME=0 for every child they fork, so the `ouro up` doing the
// replacement could not tell it was inside the job.
describe.runIf(process.platform === "darwin")("ouro up started by an agent's shell inside the daemon's job", () => {
  it("is recognised as inside the job through the real wrapper, launcher and re-exec", () => {
    const { home, wrapper, record } = installChain()
    const result = spawnSync("/bin/sh", ["-c", `true; "${wrapper}" up --latest 2>&1 | cat`], {
      encoding: "utf8",
      env: {
        PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`,
        HOME: home,
        XPC_SERVICE_NAME: "bot.ouro.daemon",
        CHAIN_RECORD: record,
      },
    })
    expect(result.status, result.stderr + result.stdout).toBe(0)
    const seen = JSON.parse(fs.readFileSync(record, "utf8")) as { xpcServiceName: string | null; pid: number; ps: string }

    const check = (xpcServiceName: string | undefined) => detectDaemonLaunchdJob({
      platform: "darwin",
      env: { XPC_SERVICE_NAME: xpcServiceName },
      pid: seen.pid,
      // This test process plays the daemon.
      readDaemonJobPid: () => process.pid,
      readProcessParents: () => parseProcessParents(seen.ps),
    })

    // On this Mac (and in Slugger's daemon) the shell hands its children "0";
    // whatever it hands them, the `ouro up` it started is inside the job.
    expect(check(seen.xpcServiceName ?? undefined).inside).toBe(true)
    // Ancestry alone recognises the real wrapper -> launcher -> re-exec chain.
    expect(check("0")).toEqual({ inside: true, reason: "daemon_ancestor", xpcServiceName: "0", daemonPid: process.pid })
  })
})
