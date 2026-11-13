import { execFile } from "node:child_process"
import * as path from "node:path"
import type { WakeRunnerConfig } from "../../heart/identity"
import { emitNervesEvent } from "../../nerves/runtime"
import { sendToAppSession, type AppSessionsOptions } from "./client"
import { writeJson } from "./store"
import { readWakeRunnerStates, wakeRunnerStateFile, type WakeRunnerState } from "./wake-runner-state"

/**
 * Wake runners: a command the agent runs on a cadence and delivers the wakes of to Copilot app sessions. The agent knows
 * nothing about what the command watches. Desk's `drains.js poll` is the one that watches GitHub issues; anything that
 * prints the same JSON works.
 *
 * The command prints one JSON value: `{ "wakes": [{ "session", "message", "done" }], "status": ["…"] }`. Each wake's message
 * is sent to its session (`session` is optional when the runner names one). `done` is the argv that reports the wake's
 * delivery: it runs after a successful send, and with `--error <reason>` added after a failed one, so the command can keep
 * the wake pending until it lands. `status` lines show under the app-sessions row of `ouro status`.
 */
export const WAKE_RUNNER_DEFAULT_SECONDS = 300
export const WAKE_RUNNER_TIMEOUT_MS = 2 * 60_000
const MAX_STATUS_LINES = 20
const MAX_LINE = 300
const MAX_OUTPUT = 10 * 1024 * 1024

export interface Wake { session?: string; message: string; done?: string[] }
export interface WakeOutput { wakes: Wake[]; status: string[] }
export interface CommandResult { ok: boolean; stdout: string; error: string | null }
export type RunCommand = (argv: string[], timeoutMs: number) => Promise<CommandResult>
export type SendWake = (session: string, message: string) => Promise<{ ok: boolean; error: string | null }>

/** The command's output as wakes and status lines, or the reason it is not one. */
export function parseWakeOutput(stdout: string): WakeOutput {
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout)
  } catch {
    throw new Error("the command did not print JSON")
  }
  const record = (parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {}) as Record<string, unknown>
  if (!Array.isArray(record.wakes)) throw new Error('the command printed no "wakes" array')
  const wakes = record.wakes.map((entry, index): Wake => {
    const wake = (entry && typeof entry === "object" ? entry : {}) as Record<string, unknown>
    if (typeof wake.message !== "string" || !wake.message.trim()) throw new Error(`wakes[${index}] has no message`)
    if (wake.session !== undefined && (typeof wake.session !== "string" || !wake.session.trim())) throw new Error(`wakes[${index}].session is not a session id`)
    if (wake.done !== undefined && (!Array.isArray(wake.done) || wake.done.length === 0 || wake.done.some(part => typeof part !== "string"))) throw new Error(`wakes[${index}].done is not an argv`)
    return { message: wake.message, ...(wake.session !== undefined ? { session: wake.session as string } : {}), ...(wake.done !== undefined ? { done: wake.done as string[] } : {}) }
  })
  // eslint-disable-next-line no-control-regex
  const clean = (line: string): string => line.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").trim().slice(0, MAX_LINE)
  const status = Array.isArray(record.status) ? record.status.filter((line): line is string => typeof line === "string").map(clean).filter(Boolean).slice(0, MAX_STATUS_LINES) : []
  return { wakes, status }
}

/** Runs an argv with no shell, returning what it printed. A non-zero exit, a timeout or a missing program is a failure with its reason. */
export const runCommand: RunCommand = (argv, timeoutMs) => new Promise(resolve => {
  const [program, ...args] = argv
  execFile(program!, args, { encoding: "utf8", timeout: timeoutMs, maxBuffer: MAX_OUTPUT, env: process.env }, (error, stdout, stderr) => {
    if (!error) return resolve({ ok: true, stdout, error: null })
    const reason = String(stderr).trim().split("\n")[0] || error.message
    resolve({ ok: false, stdout, error: `${path.basename(program!)} failed: ${reason}`.slice(0, MAX_LINE) })
  })
})

export const sendWake = (client: AppSessionsOptions): SendWake => async (session, message) => {
  const result = await sendToAppSession(session, message, { ...client, delivery: "enqueue" })
  return { ok: result.ok, error: result.error }
}

/** Run one runner's command, deliver its wakes and report each one back. Returns the runner's new state. */
export async function runWakeRunner(runner: WakeRunnerConfig, deps: { run: RunCommand; send: SendWake; now: number }): Promise<WakeRunnerState> {
  const state: WakeRunnerState = { lastRunAt: new Date(deps.now).toISOString() }
  const ran = await deps.run(runner.command, WAKE_RUNNER_TIMEOUT_MS)
  if (!ran.ok) return fail(runner, state, ran.error ?? "the command failed")
  let output: WakeOutput
  try {
    output = parseWakeOutput(ran.stdout)
  } catch (error) {
    return fail(runner, state, (error as Error).message)
  }
  state.status = output.status
  state.lastWakes = output.wakes.length
  state.lastDelivered = 0
  const problems: string[] = []
  for (const wake of output.wakes) {
    const session = wake.session ?? runner.session
    const sent = session
      ? await deps.send(session, wake.message).catch((error: Error) => ({ ok: false, error: error.message }))
      : { ok: false, error: "the wake names no session and the runner has none" }
    const reason = sent.ok ? null : sent.error ?? "the app refused the message"
    if (!reason) state.lastDelivered += 1
    else problems.push(`could not deliver a wake: ${reason}`)
    if (wake.done) {
      const reported = await deps.run(reason === null ? wake.done : [...wake.done, "--error", reason], WAKE_RUNNER_TIMEOUT_MS)
      if (!reported.ok) problems.push(`could not report a wake's delivery: ${reported.error ?? "the command failed"}`)
    }
  }
  if (problems.length) state.lastError = problems[0]
  emitNervesEvent({ level: problems.length ? "warn" : "info", component: "senses", event: "senses.wake_runner_run", message: "ran a wake runner and delivered its wakes", meta: { runner: runner.name, wakes: state.lastWakes, delivered: state.lastDelivered, problems: problems.length } })
  return state
}

function fail(runner: WakeRunnerConfig, state: WakeRunnerState, reason: string): WakeRunnerState {
  state.lastError = reason
  emitNervesEvent({ level: "warn", component: "senses", event: "senses.wake_runner_error", message: "a wake runner's command did not give wakes; nothing was delivered", meta: { runner: runner.name, error: reason } })
  return state
}

/** Run the `only` runners of the configured list (all by default) and write the states. A runner dropped from the config loses its state. */
export async function runWakeRunners(agentRoot: string, runners: WakeRunnerConfig[], deps: { run: RunCommand; send: SendWake; now: number }, only?: Set<string>): Promise<void> {
  const stored = readWakeRunnerStates(agentRoot)
  const states: Record<string, WakeRunnerState> = Object.fromEntries(runners.map(runner => [runner.name, stored[runner.name] ?? {}]))
  for (const runner of runners) if (!only || only.has(runner.name)) states[runner.name] = await runWakeRunner(runner, deps)
  writeJson(wakeRunnerStateFile(agentRoot), states)
}
