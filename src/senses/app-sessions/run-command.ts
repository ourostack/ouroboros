import { execFile } from "node:child_process"
import * as path from "node:path"

const MAX_LINE = 300
const MAX_OUTPUT = 10 * 1024 * 1024

export interface CommandResult { ok: boolean; stdout: string; error: string | null }
export type RunCommand = (argv: string[], timeoutMs: number) => Promise<CommandResult>

/** Runs an argv with no shell, returning what it printed. A non-zero exit, a timeout or a missing program is a failure with its reason. */
export const runCommand: RunCommand = (argv, timeoutMs) => new Promise(resolve => {
  const [program, ...args] = argv
  execFile(program!, args, { encoding: "utf8", timeout: timeoutMs, maxBuffer: MAX_OUTPUT, env: process.env }, (error, stdout, stderr) => {
    if (!error) return resolve({ ok: true, stdout, error: null })
    const reason = String(stderr).trim().split("\n")[0] || error.message
    resolve({ ok: false, stdout, error: `${path.basename(program!)} failed: ${reason}`.slice(0, MAX_LINE) })
  })
})
