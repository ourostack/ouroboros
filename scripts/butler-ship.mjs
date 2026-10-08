#!/usr/bin/env node
// One command ships a Butler release through the replay gate. Runbook: deploy/unraid/README.txt.
// Usage: npm run butler:ship -- <version> [--host sanctuary] [--no-gate] [--plant <case>] [--dry-run]
import { spawnSync } from "node:child_process"
import { mkdtempSync, writeFileSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { parseShipArgs, ship, ShipError } from "./butler-ship-lib.mjs"

const SSH_OPTS = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=15"]

function run(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
  return { code: r.status ?? 1, stdout: r.stdout || "", stderr: r.stderr || "" }
}

export function realDeps() {
  const dir = mkdtempSync(join(tmpdir(), "butler-ship-"))
  return {
    gh: (args) => run("gh", args),
    ssh: (host, cmd) => run("ssh", [...SSH_OPTS, host, cmd]),
    scp: (local, host, remote) => run("scp", [...SSH_OPTS, local, `${host}:${remote}`]),
    writeTemp: (name, content) => { const p = join(dir, name); writeFileSync(p, content); return p },
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    now: () => Date.now(),
    log: (line) => console.log(line),
  }
}

export async function main(argv, env = process.env, deps = realDeps()) {
  let opts
  try { opts = parseShipArgs(argv, env) } catch (e) { console.error(e.message); return 2 }
  try { return (await ship(opts, deps)).exitCode } catch (e) {
    if (!(e instanceof ShipError)) throw e
    console.error(`\nbutler-ship stopped: ${e.message}`)
    console.log(JSON.stringify({ version: opts.version, result: "failed", error: e.message }))
    return 1
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) main(process.argv.slice(2)).then((c) => process.exit(c), (e) => { console.error(e); process.exit(1) })
