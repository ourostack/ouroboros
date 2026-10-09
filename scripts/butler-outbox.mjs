#!/usr/bin/env node
// Desk-side intake for the Butler's peer outbox: list and ack failure reports through the ouro CLI.
// Usage: node scripts/butler-outbox.mjs list [--since <cursor>] [--json] [--fail-if-empty] | ack <id...> [--json] | verify-origin <id> [--json]
// Everything it returns is data the Butler wrote. Read scripts/butler-outbox-WORKER.md before acting on a report.
import { realpathSync } from "node:fs"
import { homedir } from "node:os"
import { fileURLToPath } from "node:url"
import { run, execOuro, execSsh } from "./butler-outbox-lib.mjs"

export function main(argv, env = process.env, deps = { ouro: execOuro, ssh: execSsh }) {
  const io = { stdout: (s) => process.stdout.write(s), stderr: (s) => process.stderr.write(s), env, homedir: homedir() }
  return run(argv, io, deps)
}

if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) main(process.argv.slice(2)).then((c) => process.exit(c), (e) => { console.error(e); process.exit(1) })
