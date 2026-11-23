/**
 * The sandbox on another Docker host, reached over ssh, with the model served from this side. The remote host runs
 * `remote-entry.js`, which reads one `job` (the case and the paths of its bundle, seed bundle, work folder and oracle
 * on that host), runs `runSandboxed` there with a proxy provider over the ssh channel, and answers `done` with the
 * observation. Credentials and the budget stay here: this side serves the real runtime with `serveProxyRuntime`, so
 * each remote model call takes this side's budget first, and the first 402 or 429 stops the run here.
 */
import { spawn } from "node:child_process"
import type { Readable, Writable } from "node:stream"
import type { ProviderRuntime } from "../../heart/core"
import { emitNervesEvent } from "../../nerves/runtime"
import type { Case, Observation } from "../domain/case"
import { createProxyRuntime, createStreamChannel, serveProxyRuntime, type GuestOutcome, type ProxyMessage } from "../transport/provider-proxy"

export type SandboxRun = Observation & { gaps: string[] }
export type RemotePaths = { bundleDir: string; seedBundleDir: string; workRoot?: string; oracleBooks?: string }
export type RemoteJob = RemotePaths & { case: Case }
export type RemoteProcess = { stdin: Writable; stdout: Readable; exited: Promise<number>; stderr(): string; kill?(): void }
export type RunCase = (input: { case: Case; host: ProviderRuntime; budget: { take(): boolean } }) => Promise<SandboxRun>

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null

/** Remote side: waits for the job, runs it with the model served over the same channel, and answers `done`. */
export async function serveRemoteJob(input: { stdin: Readable; stdout: Writable; run(job: RemoteJob, host: ProviderRuntime): Promise<SandboxRun> }): Promise<GuestOutcome> {
  const channel = createStreamChannel(input.stdin, input.stdout)
  const job = await new Promise<Record<string, unknown> | undefined>((resolve) => {
    channel.onMessage((msg: ProxyMessage) => {
      if (msg.type === "job") resolve(msg.job)
      if (msg.type === "closed") resolve(undefined)
    })
  })
  let outcome: GuestOutcome
  if (!job) {
    outcome = { ok: false, error: "the channel closed before a job arrived" }
  } else if (!isObject(job.case) || typeof job.bundleDir !== "string" || typeof job.seedBundleDir !== "string") {
    outcome = { ok: false, error: "the job names no case, bundle or seed bundle" }
  } else {
    emitNervesEvent({ component: "eval", event: "eval.remote_job_start", message: "running a remote sandbox job", meta: { caseId: String(job.case.id) } })
    try {
      const host = await createProxyRuntime(channel)
      outcome = { ok: true, result: await input.run(job as RemoteJob, host) }
      emitNervesEvent({ component: "eval", event: "eval.remote_job_end", message: "finished a remote sandbox job", meta: {} })
    } catch (error) {
      outcome = { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }
  if (!outcome.ok) emitNervesEvent({ component: "eval", level: "error", event: "eval.remote_job_error", message: "a remote sandbox job failed", meta: { error: outcome.error } })
  channel.send({ type: "done", outcome })
  await new Promise<void>((resolve) => input.stdout.write("", () => resolve()))
  return outcome
}

function isObservation(value: unknown): value is SandboxRun {
  return isObject(value) && Array.isArray(value.timeline) && typeof value.outcome === "string" && typeof value.finalReply === "string"
    && Array.isArray(value.library) && Array.isArray(value.mail) && Array.isArray(value.created) && Array.isArray(value.gaps)
}

/** This side: each run starts the remote process, sends the job, serves the model and waits for the observation. */
export function remoteRunCase(options: { start(): RemoteProcess; paths: RemotePaths; timeoutMs?: number }): RunCase {
  const timeoutMs = options.timeoutMs ?? 900_000
  return async ({ case: c, host, budget }) => {
    emitNervesEvent({ component: "eval", event: "eval.remote_run_start", message: "starting a run on the remote sandbox host", meta: { caseId: c.id } })
    const remote = options.start()
    const channel = createStreamChannel(remote.stdout, remote.stdin)
    serveProxyRuntime(channel, host, budget)
    const outcome = await new Promise<GuestOutcome>((resolve) => {
      const timer = setTimeout(() => { remote.kill?.(); resolve({ ok: false, error: `the remote run did not finish within ${timeoutMs} ms` }) }, timeoutMs)
      channel.onMessage((msg) => { if (msg.type === "done") { clearTimeout(timer); resolve(msg.outcome) } })
      void remote.exited.then((code) => { clearTimeout(timer); resolve({ ok: false, error: `the remote process exited (${code}) before the run finished: ${remote.stderr().trim()}` }) })
      channel.send({ type: "job", job: { case: c, ...options.paths } })
    })
    if (!outcome.ok) {
      emitNervesEvent({ component: "eval", level: "error", event: "eval.remote_run_error", message: "the remote sandbox run failed", meta: { caseId: c.id, error: outcome.error } })
      throw new Error(`remote sandbox failed: ${outcome.error}`)
    }
    if (!isObservation(outcome.result)) throw new Error("remote sandbox failed: its result is not an observation")
    emitNervesEvent({ component: "eval", event: "eval.remote_run_end", message: "finished a run on the remote sandbox host", meta: { caseId: c.id, outcome: outcome.result.outcome } })
    return outcome.result
  }
}

/* v8 ignore start -- process wiring: the channel and its lifecycle are tested above through in-memory pipes @preserve */
/** `ssh -T <host> node <entry>`, with its stdin and stdout as the channel. */
export function sshStart(host: string, entry: string): () => RemoteProcess {
  return () => {
    const child = spawn("ssh", ["-T", "-o", "BatchMode=yes", "-o", "ServerAliveInterval=30", host, "node", entry], { stdio: ["pipe", "pipe", "pipe"] })
    let err = ""
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { err = (err + chunk).slice(-4000) })
    const exited = new Promise<number>((resolve) => {
      child.on("error", () => resolve(-1))
      child.on("close", (code) => resolve(code ?? -1))
    })
    return { stdin: child.stdin, stdout: child.stdout, exited, stderr: () => err, kill: () => { child.kill("SIGTERM") } }
  }
}
/* v8 ignore stop */
