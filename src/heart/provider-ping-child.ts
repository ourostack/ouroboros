import { spawn } from "child_process"
import * as path from "path"
import { emitNervesEvent } from "../nerves/runtime"
import type { AgentProvider } from "./identity"
import type { PingResult, ProviderPingOptions, ProviderRuntimeConfig } from "./provider-ping"

type PingConfig = Record<string, unknown>

/** What the parent sends the child on stdin. Credentials never go in argv or the environment. */
export interface ProviderPingChildRequest {
  provider: AgentProvider
  config: PingConfig
  options: Pick<ProviderPingOptions, "model" | "timeoutMs" | "attemptPolicy">
}

export interface ProviderPingChildOutcome {
  code: number | null
  stdout: string
}

type PingProvider = (provider: AgentProvider, config: PingConfig, options?: ProviderPingOptions) => Promise<PingResult>

export interface ProviderPingInChildDeps {
  runChild?: (request: string) => Promise<ProviderPingChildOutcome>
  pingInProcess?: PingProvider
}

const PING_ENTRY = path.join(__dirname, "provider-ping-entry.js")
// Three attempts of the 10 s ping, plus startup, with room to spare.
const CHILD_TIMEOUT_MS = 60_000

const pingInThisProcess: PingProvider = async (provider, config, options) =>
  (await import("./provider-ping")).pingProvider(provider, config as unknown as ProviderRuntimeConfig, options)

/** Run the ping entry with the request on stdin; resolve with its exit code and stdout. */
export function runProviderPingChild(request: string, entry: string = PING_ENTRY, timeoutMs: number = CHILD_TIMEOUT_MS): Promise<ProviderPingChildOutcome> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [entry], { stdio: ["pipe", "pipe", "ignore"], env: process.env })
    let stdout = ""
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs)
    child.stdout.setEncoding("utf8")
    child.stdout.on("data", (chunk: string) => { stdout += chunk })
    /* v8 ignore next -- spawn of this same node binary only fails if the host can't start a process @preserve */
    child.on("error", (error) => { clearTimeout(timer); reject(error) })
    child.on("close", (code) => { clearTimeout(timer); resolve({ code, stdout }) })
    /* v8 ignore next -- EPIPE when the child dies before reading; the close handler reports it @preserve */
    child.stdin.on("error", () => undefined)
    child.stdin.end(request)
  })
}

function parsePingResult(stdout: string): PingResult | null {
  try {
    const value = JSON.parse(stdout.trim()) as PingResult
    return value && typeof value === "object" && typeof value.ok === "boolean" ? value : null
  } catch {
    return null
  }
}

/**
 * Ping a provider from a short-lived child process, so the provider SDK it
 * loads (about 11 MB for openai) leaves with the child instead of staying in a
 * long-lived daemon. Progress callbacks can't cross a process boundary, so a
 * ping that asks for them runs here. If the child can't produce a result, the
 * ping runs here too: this changes where the ping runs, never its answer.
 */
export async function pingProviderInChild(
  provider: AgentProvider,
  config: PingConfig,
  options: ProviderPingOptions = {},
  deps: ProviderPingInChildDeps = {},
): Promise<PingResult> {
  const pingInProcess = deps.pingInProcess ?? pingInThisProcess
  if (options.sleep || options.onAttemptStart || options.onRetry) return pingInProcess(provider, config, options)
  const request: ProviderPingChildRequest = {
    provider,
    config,
    options: { model: options.model, timeoutMs: options.timeoutMs, attemptPolicy: options.attemptPolicy },
  }
  let failure: string
  try {
    const outcome = await (deps.runChild ?? runProviderPingChild)(JSON.stringify(request))
    const result = parsePingResult(outcome.stdout)
    if (result) {
      emitNervesEvent({ component: "engine", event: "engine.provider_ping_child_done", message: "provider ping ran in a child process", meta: { provider, ok: result.ok } })
      return result
    }
    failure = `exit ${outcome.code} without a result`
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error)
  }
  emitNervesEvent({
    level: "warn",
    component: "engine",
    event: "engine.provider_ping_child_fallback",
    message: "provider ping child gave no result; pinging in this process",
    meta: { provider, failure },
  })
  return pingInProcess(provider, config, options)
}

/** The child's side: read one request, ping, write the result as one JSON line. */
export async function serveProviderPingChild(
  input: AsyncIterable<string | Buffer>,
  write: (text: string) => void,
  ping: PingProvider = pingInThisProcess,
): Promise<number> {
  let raw = ""
  for await (const chunk of input) raw += chunk.toString()
  let request: ProviderPingChildRequest
  try {
    request = JSON.parse(raw) as ProviderPingChildRequest
  } catch {
    emitNervesEvent({ level: "error", component: "engine", event: "engine.provider_ping_child_bad_request", message: "provider ping child got an unreadable request", meta: {} })
    return 2
  }
  const result = await ping(request.provider, request.config, request.options)
  write(`${JSON.stringify(result)}\n`)
  return 0
}
