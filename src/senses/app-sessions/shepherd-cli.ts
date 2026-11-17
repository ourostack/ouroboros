import { spawn } from "node:child_process"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { emitNervesEvent } from "../../nerves/runtime"

/**
 * The GitHub Copilot app's sessions, read and acted on through Shepherd's `shepherd` CLI (github.com/ourostack/shepherd),
 * which owns the app's socket and database. Each verb takes `--json`, prints one JSON result, and a failure exits non-zero
 * with `{ ok: false, code, error }`, where `error` says the problem and the fix. A verb that takes arguments reads one JSON
 * object on stdin with `--input -`.
 *
 * Shepherd is found as Housesitter's restart is: `SHEPHERD_BIN` if set, else `shepherd` on PATH, else the copy Housesitter
 * installs under its releases folder, run with this Node.
 */
export const SHEPHERD_VERSION = "0.8.1"
export const SHEPHERD_BIN_ENV = "SHEPHERD_BIN"
export const SHEPHERD_INSTALL = `npx github:ourostack/shepherd#v${SHEPHERD_VERSION}`
/** Longer than a send's two-minute wait, so a slow send is answered rather than cut off here. */
const SHEPHERD_TIMEOUT_MS = 150_000
const BUNDLED_PATH = ["Library", "Application Support", "housesitter", "releases", "shepherd", "current", "bin", "shepherd.mjs"]

export class ShepherdUnavailableError extends Error {
  constructor(problem: string) {
    super(`${problem}. Fix: install Shepherd with ${SHEPHERD_INSTALL}, or set ${SHEPHERD_BIN_ENV} to its CLI`)
    this.name = "ShepherdUnavailableError"
  }
}

/** A verb that failed, with Shepherd's code; the message is its problem and fix. */
export class ShepherdFailure extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = "ShepherdFailure"
    this.code = code
  }
}

export interface ShepherdCommand { file: string; prefix: string[] }
export interface ShepherdRun { env?: NodeJS.ProcessEnv; home?: string; timeoutMs?: number }

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value)

/** A `.js` or `.mjs` file runs under this Node; anything else is an executable. */
const commandFor = (file: string): ShepherdCommand => (/\.m?js$/.test(file) ? { file: process.execPath, prefix: [file] } : { file, prefix: [] })

function onPath(name: string, pathValue: string): string | null {
  for (const dir of pathValue.split(path.delimiter)) {
    if (!dir) continue
    const candidate = path.join(dir, name)
    try {
      if (fs.statSync(candidate).isFile()) {
        fs.accessSync(candidate, fs.constants.X_OK)
        return candidate
      }
    } catch {
      // not an executable here; keep looking
    }
  }
  return null
}

/** The Shepherd CLI to run, or null when none is installed. */
export function resolveShepherd(env: NodeJS.ProcessEnv = process.env, home: string = os.homedir()): ShepherdCommand | null {
  const explicit = env[SHEPHERD_BIN_ENV]
  if (explicit) {
    if (!fs.existsSync(explicit)) throw new ShepherdUnavailableError(`${SHEPHERD_BIN_ENV} points at ${explicit}, which does not exist`)
    return commandFor(explicit)
  }
  const found = onPath("shepherd", env.PATH ?? "")
  if (found) return { file: found, prefix: [] }
  const bundled = path.join(home, ...BUNDLED_PATH)
  return fs.existsSync(bundled) ? commandFor(bundled) : null
}

function runCommand(command: ShepherdCommand, args: string[], stdin: string | null, timeoutMs: number): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command.file, [...command.prefix, ...args], { stdio: ["pipe", "pipe", "pipe"] })
    let stdout = ""
    let stderr = ""
    const timer = setTimeout(() => {
      child.kill()
      reject(new ShepherdFailure("timeout", `shepherd did not answer within ${Math.round(timeoutMs / 1000)} s. Fix: check the GitHub Copilot app is running, then try again`))
    }, timeoutMs)
    child.stdout.on("data", chunk => { stdout += String(chunk) })
    child.stderr.on("data", chunk => { stderr += String(chunk) })
    child.stdin.on("error", () => undefined)
    child.on("error", error => {
      clearTimeout(timer)
      reject(new ShepherdUnavailableError(`could not start shepherd at ${command.file} (${error.message})`))
    })
    child.on("close", code => {
      clearTimeout(timer)
      resolve({ code, stdout, stderr })
    })
    child.stdin.end(stdin ?? "")
  })
}

/** The last line of stdout as a JSON object, or null when there is none. */
function jsonResult(stdout: string): Record<string, unknown> | null {
  const line = stdout.trim().split("\n").slice(-1).join("")
  try {
    const parsed: unknown = JSON.parse(line)
    return isRecord(parsed) ? parsed : null
  } catch {
    return null
  }
}

/**
 * Runs one Shepherd verb with `--json` and returns its JSON result. `input` is sent as the verb's one JSON object on
 * stdin. Throws ShepherdUnavailableError when no Shepherd is installed, and ShepherdFailure when the verb fails.
 */
export async function shepherd(verb: string[], input?: Record<string, unknown>, options: ShepherdRun = {}): Promise<Record<string, unknown>> {
  const command = resolveShepherd(options.env, options.home)
  if (!command) throw new ShepherdUnavailableError("Shepherd is not installed, so the GitHub Copilot app's sessions cannot be reached")
  const args = [...verb, "--json", ...(input === undefined ? [] : ["--input", "-"])]
  const { code, stdout, stderr } = await runCommand(command, args, input === undefined ? null : JSON.stringify(input), options.timeoutMs ?? SHEPHERD_TIMEOUT_MS)
  const parsed = jsonResult(stdout)
  if (code !== 0 || parsed?.ok === false) {
    const failure = parsed && typeof parsed.error === "string" ? parsed.error : `shepherd ${verb.join(" ")} failed (exit ${code})${stderr.trim() ? `: ${stderr.trim()}` : ""}`
    const reason = parsed && typeof parsed.code === "string" ? parsed.code : `exit-${code}`
    emitNervesEvent({ level: "warn", component: "senses", event: "senses.shepherd_error", message: "a Shepherd verb failed", meta: { verb: verb[0], code: reason } })
    throw new ShepherdFailure(reason, failure)
  }
  if (!parsed) throw new ShepherdFailure("no-json", `shepherd ${verb[0]} printed no JSON. Fix: run it by hand with --json to see its output`)
  emitNervesEvent({ component: "senses", event: "senses.shepherd_call", message: "ran a Shepherd verb", meta: { verb: verb[0] } })
  return parsed
}
