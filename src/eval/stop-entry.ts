/**
 * `npm run eval:stop -- --sandbox-ssh <host>:<folder>` (see `stop-command.ts`): removes the eval's containers,
 * networks and images on that Docker host, frees an eval's host lock and reads back that none remain. Exits 0 when
 * the read-back is clean, 1 when something remains or a step failed, 2 for bad arguments.
 */
import { spawn } from "node:child_process"
import { emitNervesEvent } from "../nerves/runtime"
import { parseStopArgs, runStopCommand, type HostRun } from "./stop-command"

/** One command over ssh, with no terminal and no password prompt; stderr passes through. */
function sshRun(host: string): HostRun {
  return (argv) => new Promise((resolve) => {
    const child = spawn("ssh", ["-T", "-o", "BatchMode=yes", host, ...argv], { stdio: ["ignore", "pipe", "inherit"] })
    let stdout = ""
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk })
    child.on("error", () => resolve({ code: -1, stdout }))
    child.on("close", (code) => resolve({ code: code ?? -1, stdout }))
  })
}

// stderr's last line names the failure its Ouro AX card lists (cli-commands/entry-points.ts).
const USAGE = "usage"
const INCOMPLETE = "stop-incomplete"
const FAILED = "stop-failed"

async function main(): Promise<number> {
  let target
  try {
    target = parseStopArgs(process.argv.slice(2))
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\ncode: ${USAGE}\n`)
    return 2
  }
  try {
    const { exitCode } = await runStopCommand(target, sshRun(target.host), (text) => { process.stdout.write(`${text}\n`) })
    if (exitCode !== 0) process.stderr.write(`code: ${INCOMPLETE}\n`)
    return exitCode
  } catch (error) {
    emitNervesEvent({ component: "eval", level: "error", event: "eval.stop_entry_error", message: "eval:stop failed", meta: { error: (error as Error).message } })
    process.stderr.write(`eval:stop: ${(error as Error).message}\ncode: ${FAILED}\n`)
    return 1
  }
}

void main().then((code) => { process.exitCode = code })
