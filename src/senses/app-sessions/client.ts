import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { execFile } from "node:child_process"
import { emitNervesEvent } from "../../nerves/runtime"

/**
 * The shapes the app-sessions sense works from, the state-folder path its digest reads a session's task from, and
 * Housesitter's restart. The app's sessions come from Shepherd (`shepherd-rows.ts`); nothing here talks to the app.
 */
export type RunFile = (file: string, args: string[], timeoutMs: number) => Promise<{ code: number; stdout: string; stderr: string }>

export interface AppSessionsOptions {
  /** The app's state folder, `~/.copilot` unless a test says otherwise. */
  stateDir?: string
  /** Runs Housesitter; tests replace it. */
  runFile?: RunFile
  /** Where to look for Housesitter's `bin/housesitter.mjs` (or an executable named housesitter), first match wins; tests replace it. */
  housesitterPaths?: string[]
  /** The home folder whose `code/housesitter` checkout is looked in, `os.homedir()` unless a test says otherwise. */
  homeDir?: string
}

export type AppSessionState = "working" | "waiting" | "stuck" | "idle"

export interface AppSessionRow {
  id: string
  name: string
  kind: "workspace" | "chat"
  workspaceId: string | null
  workspaceType: string | null
  project: string | null
  projectId: string | null
  projectRepo: string | null
  branch: string | null
  path: string | null
  parentSessionId: string | null
  creatorSessionId: string | null
  coordinatingCreatorSessionId: string | null
  state: AppSessionState
  /** What the session's own state rests on, in a few words. */
  detail: string
  isRunning: boolean
  wasInterrupted: boolean
  remote: boolean
  createdAt: string | null
  updatedAt: string | null
  lastActivity: string | null
  /** What the session waits on: a question, a plan approval or a permission. */
  awaiting?: "input" | "plan" | "permission"
  /** The permission request the person has not answered yet. */
  prompt?: PermissionPrompt
}

/** A permission request the person has not answered yet. */
export interface PermissionPrompt {
  requestId: string
  /** What is being asked, in a few plain words. */
  what: string
  /** When the app recorded the request, if it says; Shepherd does not. */
  at: string | null
}

export interface AppSessionsSnapshot {
  at: string
  appRunning: boolean
  counts: Record<AppSessionState, number>
  sessions: Array<{ id: string; name: string; state: AppSessionState }>
}

export interface AppMessage {
  at: string | null
  role: "user" | "assistant"
  text: string
  truncated?: boolean
}

/** Names the Housesitter command to run: the path of its `bin/housesitter.mjs`, or of an executable. */
export const HOUSESITTER_ENV = "HOUSESITTER_BIN"
const HOUSESITTER_WAIT_MS = 30_000
const SESSION_ID = /^[A-Za-z0-9-]+$/

/** The app's sessions as the sidebar lists them, counted by state, with each one's id, name and state. */
export function snapshot(rows: AppSessionRow[], now: number): AppSessionsSnapshot {
  const counts: Record<AppSessionState, number> = { working: 0, idle: 0, waiting: 0, stuck: 0 }
  for (const row of rows) counts[row.state] += 1
  return {
    at: new Date(now).toISOString(),
    appRunning: true,
    counts,
    sessions: rows.map(row => ({ id: row.id, name: row.name, state: row.state })),
  }
}

/** The link that opens a session in the app. */
export const appUrl = (id: string): string => `ghapp://sessions/${id}`

export function assertSessionId(id: string): string {
  if (!SESSION_ID.test(id)) throw new Error(`'${id}' is not a Copilot app session id`)
  return id
}

/** A session's event log in the app's state folder; the digest reads a task declaration from it (see `digest-cards.ts`). */
export function eventLogPath(id: string, options: AppSessionsOptions = {}): string {
  return path.join(options.stateDir ?? path.join(os.homedir(), ".copilot"), "session-state", assertSessionId(id), "events.jsonl")
}

// ---------- restarting the app (Housesitter) ----------

export const realRunFile: RunFile = (file, args, timeoutMs) => new Promise((resolve) => {
  execFile(file, args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
    resolve({ code: error ? 1 : 0, stdout: String(stdout), stderr: String(stderr) || (error?.message ?? "") })
  })
})

export type HousesitterResult<T> = { installed: false; message: string } | ({ installed: true } & T)

/** Housesitter's command on this Mac: `HOUSESITTER_BIN`, the checkout at `~/code/housesitter`, or `housesitter` on PATH. */
export function findHousesitter(options: AppSessionsOptions = {}): { file: string; args: string[] } | null {
  const onPath = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean).map(dir => path.join(dir, "housesitter"))
  const candidates = options.housesitterPaths ?? [process.env[HOUSESITTER_ENV] ?? "", path.join(options.homeDir ?? os.homedir(), "code", "housesitter", "bin", "housesitter.mjs"), ...onPath]
  const found = candidates.find(candidate => candidate && fs.existsSync(candidate))
  if (!found) return null
  return found.endsWith(".mjs") ? { file: process.execPath, args: [found] } : { file: found, args: [] }
}

const housesitterMissing = (): { installed: false; message: string } => ({
  installed: false,
  message: `Housesitter is not on this Mac, so the app was not restarted. Clone https://github.com/ourostack/housesitter to ~/code/housesitter, put \`housesitter\` on PATH, or set ${HOUSESITTER_ENV} to its bin/housesitter.mjs.`,
})

async function runHousesitter(args: string[], options: AppSessionsOptions): Promise<HousesitterResult<{ output: Record<string, unknown> }>> {
  const run = options.runFile ?? realRunFile
  const command = findHousesitter(options)
  if (!command) return housesitterMissing()
  const result = await run(command.file, [...command.args, "restart-copilot", ...args, "--json"], HOUSESITTER_WAIT_MS)
  let output: Record<string, unknown> | null = null
  try { output = JSON.parse(result.stdout) as Record<string, unknown> } catch { /* not JSON: housesitter refused or failed */ }
  // `--status` exits 1 for a failed run and `--detach` for a job launchd would not start; both still answer on stdout.
  const answered = output !== null && ("state" in output || output.ok === false)
  if (!output || (result.code !== 0 && !answered)) throw new Error(`housesitter failed: ${(result.stderr || result.stdout).trim().slice(0, 300)}`)
  return { installed: true, output }
}

/** Restart the app now, as a launchd job that outlives the app: Housesitter asks working sessions to reach a safe point, quits the app through its Quit menu (waiting while a person is using the Mac), relaunches it and resumes every session that was working. Read the outcome with {@link restartStatus}. */
export async function restartEnqueue(why: string, by: string, options: AppSessionsOptions = {}): Promise<HousesitterResult<{ request: unknown }>> {
  const result = await runHousesitter(["--resume", "--detach", "--why", `${why} (asked by ${by})`], options)
  emitNervesEvent({ component: "senses", event: "senses.app_sessions_restart_enqueued", message: "asked housesitter to restart the app", meta: { installed: result.installed, why } })
  if (!result.installed) return result
  if (result.output.ok === false) throw new Error(`housesitter did not start the restart: ${String(result.output.error ?? "no reason given")}`)
  return { installed: true, request: result.output }
}

/** The restart in progress or the last one: state (running, done, failed, none), step, start time, result, log. */
export async function restartStatus(options: AppSessionsOptions = {}): Promise<HousesitterResult<{ status: unknown }>> {
  const result = await runHousesitter(["--status"], options)
  emitNervesEvent({ component: "senses", event: "senses.app_sessions_restart_status", message: "read housesitter's restart status", meta: { installed: result.installed } })
  return result.installed ? { installed: true, status: result.output } : result
}
