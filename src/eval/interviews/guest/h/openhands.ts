/**
 * H's `openhands` arm (pre-registration v2 product H): the OpenHands Software Agent SDK at `ecea9a91d8d0` with its
 * terminal and file-editor tools, its own agent loop unchanged, on the H wire's chat-completions route as its only
 * provider. Every call goes through the wire to the host's runtime, so the host still rewrites, scans, gates and
 * meters it.
 *
 * What stays the same as in every arm: the Butler's persona and the label line (here the agent context's system
 * message suffix, after the SDK's own system prompt), the case's conversation (put before the job by the wire), the
 * bundle's skills (installed as user skills, which the SDK loads), the books command line and the household.
 *
 * One conversation runs in a Python supervisor (`deploy/eval/openhands/supervise.py`), given one message at a time:
 * the job, then each follow-up as the owner's next message. OpenHands ends a turn with its `finish` tool, whose
 * message is the turn's reply, so the trace shows it as one. The SDK's retries are off, since a retried call would
 * be metered twice. It runs in the same neutral home and workdir as the codex arm.
 */
import { spawn } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { emitNervesEvent } from "../../../../nerves/runtime"
import type { TraceCall, TraceReply } from "../../../domain/case"
import type { TelegramTurns } from "../../../transport/telegram-turn"
import { withoutThinking } from "../loop"
import { personaPrompt } from "../run"
import { CODEX_HOME_DIR, installSkills } from "./codex"
import type { HArmRunner } from "./run"
import { createWire, serveWire } from "./wire"

/** A running supervisor: one message at a time, each answered with its status line, or null once it has exited. */
export type Supervisor = {
  send(message: string): Promise<{ status?: string; error?: string } | null>
  close(): Promise<{ code: number; stderr: string }>
}

export type StartSupervisor = (specFile: string, options: { cwd: string; env: NodeJS.ProcessEnv }) => Supervisor

/** Where the arm's image installs the SDK and the supervisor, under a path with no brand word. */
const SDK_DIR = "/opt/agent-sdk"

/* v8 ignore start -- process wiring: what the arm does with the supervisor's lines and exit is tested with an injected supervisor @preserve */
const startPython: StartSupervisor = (specFile, options) => {
  const child = spawn(path.join(SDK_DIR, "venv/bin/python"), [path.join(SDK_DIR, "supervise.py"), specFile], { cwd: options.cwd, env: options.env, stdio: ["pipe", "pipe", "pipe"] })
  let stderr = ""
  let buffered = ""
  const lines: string[] = []
  let waiting: ((line: string | null) => void) | null = null
  let ended = false
  const exited = new Promise<number>((resolve) => {
    child.on("error", (error) => { stderr += `${error.message}\n`; resolve(127) })
    child.on("close", (code) => resolve(code ?? 137))
  })
  child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8") })
  // A supervisor that died between turns breaks the pipe; its exit says why, so the write's error is not thrown.
  child.stdin.on("error", () => undefined)
  child.stdout.on("data", (chunk: Buffer) => {
    buffered += chunk.toString("utf8")
    let at: number
    while ((at = buffered.indexOf("\n")) >= 0) {
      const line = buffered.slice(0, at)
      buffered = buffered.slice(at + 1)
      if (waiting) { const take = waiting; waiting = null; take(line) } else lines.push(line)
    }
  })
  void exited.then(() => { ended = true; if (waiting) { const take = waiting; waiting = null; take(null) } })
  const next = (): Promise<string | null> => lines.length > 0 ? Promise.resolve(lines.shift()!) : ended ? Promise.resolve(null) : new Promise((resolve) => { waiting = resolve })
  // Inside the host's 600-second guest deadline, so a stuck supervisor ends as this arm's failure, not the guest's.
  const timer = setTimeout(() => child.kill("SIGKILL"), 540_000)
  return {
    send: async (message) => {
      if (!ended) child.stdin.write(`${JSON.stringify(message)}\n`)
      const line = await next()
      if (line === null) return null
      try {
        return JSON.parse(line) as { status?: string; error?: string }
      } catch {
        return { error: `the supervisor printed ${line.slice(0, 200)}` }
      }
    },
    close: async () => {
      child.stdin.end()
      const code = await exited
      clearTimeout(timer)
      return { code, stderr }
    },
  }
}
/* v8 ignore stop */

const lastLine = (text: string): string => text.trim().split("\n").at(-1)!.trim()

/** The message of a `finish` call: its `message` argument, or its arguments as they are. */
function finishMessage(args: string): string {
  try {
    const message = (JSON.parse(args) as { message?: unknown }).message
    if (typeof message === "string") return message
  } catch {
    // Not JSON: the arguments are the message.
  }
  return args
}

export function openhandsArm(options: { start?: StartSupervisor; home?: string; workdir?: string } = {}): HArmRunner {
  const start = options.start ?? startPython
  const home = options.home ?? CODEX_HOME_DIR
  const workdir = options.workdir ?? path.join(home, "AgentBundles", "sanctuary.agent")
  return async ({ turn, bundle, providerRuntime }) => {
    fs.mkdirSync(path.dirname(workdir), { recursive: true })
    if (!fs.existsSync(workdir)) fs.symlinkSync(bundle, workdir)
    installSkills(bundle, home)
    const wire = createWire({ runtime: providerRuntime, prefix: turn.prefix })
    const served = await serveWire(wire)
    try {
      const specFile = path.join(home, ".arm-spec.json")
      fs.writeFileSync(specFile, JSON.stringify({ baseUrl: served.url, workdir, systemSuffix: `${personaPrompt(bundle)}\n\n${turn.labelLine}` }))
      // The SDK reads the model cost map it ships with rather than fetching one; the container has no route out.
      // The terminal's tmux keeps the neutral workdir as given; PWD keeps it too if the SDK falls back to a plain shell.
      // AI_AGENT is set to a neutral name, since the SDK otherwise puts its own brand there for the shell.
      const supervisor = start(specFile, { cwd: workdir, env: { HOME: home, PWD: workdir, PATH: process.env.PATH, LITELLM_LOCAL_MODEL_COST_MAP: "True", AI_AGENT: "agent" } })
      // OpenHands' `finish` call is the turn's reply.
      const traced = (): Array<TraceCall | TraceReply> => wire.timeline().map((entry) => entry.kind === "call" && entry.name === "finish"
        ? { kind: "reply", text: withoutThinking(finishMessage(entry.args)) }
        : entry.kind === "reply" ? { kind: "reply", text: withoutThinking(entry.text) } : entry)
      const turns: TelegramTurns = []
      let closed: { code: number; stderr: string } | null = null
      // The supervisor is closed however the turns end, so Python never outlives the arm.
      try {
      for (const [index, text] of [turn.userText, ...turn.followUps].entries()) {
        const record = { start: traced().length, finalReply: "", outcome: "settled", calls: 0 }
        turns.push(record)
        emitNervesEvent({ component: "eval", event: "eval.h_openhands_turn_start", message: "openhands is taking a turn", meta: { index } })
        const callsBefore = wire.calls()
        const line = await supervisor.send(text)
        record.calls = wire.calls() - callsBefore
        const reply = traced().slice(record.start).filter((entry): entry is TraceReply => entry.kind === "reply").at(-1)
        if (reply) record.finalReply = reply.text
        // A failed call ends the conversation, so any failure the wire remembers is this turn's.
        const failure = wire.error()
        if (failure !== null) {
          record.outcome = `provider-error: ${failure}`
        } else if (line === null) {
          closed = await supervisor.close()
          record.outcome = `harness-error: openhands exited ${closed.code}${closed.stderr.trim() ? `: ${lastLine(closed.stderr)}` : ""}`
        } else if (line.error !== undefined) {
          record.outcome = `harness-error: openhands failed: ${line.error}`
        } else if (line.status !== "finished") {
          record.outcome = `harness-error: openhands stopped the turn ${line.status}`
        } else if (!reply) {
          record.outcome = "harness-error: openhands ended the turn with no reply"
        }
        emitNervesEvent({ component: "eval", event: "eval.h_openhands_turn_end", message: "openhands ended a turn", meta: { index, outcome: record.outcome, calls: record.calls } })
        if (record.outcome !== "settled") break
      }
      } finally {
        if (!closed) await supervisor.close()
      }
      return { timeline: traced(), finalReply: turns[0]!.finalReply, outcome: turns[0]!.outcome, steps: wire.calls(), turns }
    } finally {
      await served.close()
    }
  }
}
