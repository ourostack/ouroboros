// Reports what `ouro chat` is doing to the terminal it runs in, through the Program Status
// Protocol (OSC 7501): idle, working, blocked, done or error, with one line of text.
// Orca reads these reports from the terminal stream and shows the chat as an agent with live
// status in its sidebar, Agent Dashboard, notifications and `orca agent list`.
// Spec: https://www.superlogical.com/rex/docs/build/program-status
// Orca's reader: https://github.com/stablyai/orca/blob/main/src/shared/program-status/protocol.ts
import type { ChannelCallbacks } from "../heart/core"
import { emitNervesEvent } from "../nerves/runtime"

export type ProgramStatusState = "idle" | "working" | "blocked" | "done" | "error"
export type ProgramStatusKind = "permission" | "question" | "auth"

export interface ProgramStatusReport {
  state: ProgramStatusState | "clear"
  kind?: ProgramStatusKind
  msg?: string
  title?: string
}

/** The `app` id Orca shows as the agent's type. */
export const PROGRAM_STATUS_APP = "ouro"

// The protocol caps msg at 2048 decoded bytes and title at 192; these stay well inside both.
const MAX_MSG_CHARS = 240
const MAX_TITLE_CHARS = 48

// The protocol drops a report whose text holds C0, DEL or C1 controls.
// eslint-disable-next-line no-control-regex -- matching the controls the protocol refuses
const CONTROLS = /[\u0000-\u001f\u007f-\u009f]+/g

/** One line of plain text, or undefined when nothing is left. */
export function programStatusText(text: string | undefined, maxChars: number): string | undefined {
  if (!text) return undefined
  const line = text.replace(CONTROLS, " ").replace(/\s+/g, " ").trim()
  if (!line) return undefined
  const chars = Array.from(line)
  return chars.length <= maxChars ? line : `${chars.slice(0, maxChars - 1).join("").trimEnd()}…`
}

/** The OSC 7501 sequence for one report. */
export function formatProgramStatus(report: ProgramStatusReport, app = PROGRAM_STATUS_APP): string {
  const pairs = [`state=${report.state}`]
  if (report.state !== "clear") {
    pairs.push(`app=${app}`)
    if (report.state === "blocked" && report.kind) pairs.push(`kind=${report.kind}`)
    const msg = programStatusText(report.msg, MAX_MSG_CHARS)
    if (msg) pairs.push(`msg=${Buffer.from(msg, "utf8").toString("base64")}`)
    const title = programStatusText(report.title, MAX_TITLE_CHARS)
    if (title) pairs.push(`title=${Buffer.from(title, "utf8").toString("base64")}`)
  }
  return `\x1b]7501;${pairs.join(":")}\x1b\\`
}

/** Whether this terminal reads OSC 7501. Only Orca is known to, so other terminals get nothing. */
export function terminalReadsProgramStatus(env: Readonly<Record<string, string | undefined>>, isTTY: boolean): boolean {
  if (!isTTY) return false
  return env.TERM_PROGRAM === "Orca" || Boolean(env.ORCA_PANE_KEY)
}

export interface ProgramStatusReporter {
  readonly enabled: boolean
  /** Waiting for the person to type. */
  idle(): void
  /** Working on a turn; `msg` says on what. */
  working(msg?: string): void
  /** The turn finished; `reply` is what the agent said. */
  done(reply?: string): void
  /** The turn failed. */
  error(msg: string): void
  /** Waiting on the person, such as for an approval. */
  blocked(kind: ProgramStatusKind, msg: string): void
  /** The chat is closing: remove its row. */
  clear(): void
  /** Reports how a turn ended, from its outcome and the reply it added. */
  turnEnded(end: ProgramStatusTurnEnd): void
  /** The same callbacks, reporting tool use and failures as they happen. */
  wrap<T extends ChannelCallbacks>(callbacks: T): T
}

export interface ProgramStatusTurnEnd {
  /** The turn's outcome, as `runAgent` or the pipeline names it; undefined when none was given. */
  outcome?: string
  /** Whether the person interrupted the turn. */
  aborted: boolean
  /** What the agent said in this turn, if anything. */
  reply?: string
}

export interface ProgramStatusReporterOptions {
  agentName: string
  env?: Readonly<Record<string, string | undefined>>
  isTTY?: boolean
  write?: (chunk: string) => void
}

/** "query_calendar" → "query calendar". */
function toolLabel(name: string): string {
  return name.replace(/[_-]+/g, " ").trim() || name
}

export function createProgramStatusReporter(options: ProgramStatusReporterOptions): ProgramStatusReporter {
  const env = options.env ?? process.env
  const isTTY = options.isTTY ?? process.stdout.isTTY === true
  const enabled = terminalReadsProgramStatus(env, isTTY)
  const write = options.write ?? ((chunk: string) => { process.stdout.write(chunk) })
  const title = options.agentName
  let last: string | null = null
  let lastState: ProgramStatusReport["state"] | null = null

  const report = (next: ProgramStatusReport): void => {
    if (!enabled) return
    // A failed turn stays failed: the turn's end must not paint it done.
    if (next.state === "done" && lastState === "error") return
    lastState = next.state
    const sequence = formatProgramStatus({ ...next, title })
    // Repeats carry nothing new, so a busy turn does not flood the terminal.
    if (sequence === last) return
    last = sequence
    try {
      write(sequence)
    } catch (error) {
      // A closed terminal must never break the chat.
      emitNervesEvent({
        level: "warn",
        component: "senses",
        event: "senses.program_status_write_error",
        message: "could not write a program status report",
        meta: { state: next.state, error: error instanceof Error ? error.message : String(error) },
      })
      return
    }
    emitNervesEvent({
      component: "senses",
      event: "senses.program_status_report",
      message: "reported chat status to the terminal",
      meta: { state: next.state },
    })
  }

  const reporter: ProgramStatusReporter = {
    enabled,
    idle: () => report({ state: "idle" }),
    working: (msg) => report({ state: "working", msg }),
    done: (reply) => report({ state: "done", msg: reply }),
    error: (msg) => report({ state: "error", msg }),
    blocked: (kind, msg) => report({ state: "blocked", kind, msg }),
    clear: () => report({ state: "clear" }),
    turnEnded: ({ outcome, aborted, reply }) => {
      const line = firstLine(reply)
      if (aborted || outcome === "aborted") return reporter.idle()
      if (outcome === "errored") return reporter.error(line ?? "The turn failed.")
      // The engine failed closed and said why.
      if (outcome === "blocked") return reporter.error(line ?? "The turn was blocked.")
      if (outcome === "suspended") return reporter.blocked("permission", line ?? "Waiting for your approval.")
      // A turn that was declined, or produced no reply, has nothing to show.
      if (line === undefined) return reporter.idle()
      reporter.done(line)
    },
    wrap: (callbacks) => {
      if (!enabled) return callbacks
      return {
        ...callbacks,
        onToolStart: (name: string, args: Record<string, string>) => {
          reporter.working(`Using ${toolLabel(name)}`)
          callbacks.onToolStart(name, args)
        },
        onError: (error: Error, severity: "transient" | "terminal") => {
          if (severity === "terminal") reporter.error(error.message)
          callbacks.onError(error, severity)
        },
      }
    },
  }
  return reporter
}

/** The first line of text that has something on it. */
function firstLine(text: string | undefined): string | undefined {
  return text?.split(/\r?\n/).find((line) => line.trim())
}

/** The newest assistant text among the messages from `since` on, so a turn never shows an earlier turn's reply. */
export function assistantTextSince(messages: ReadonlyArray<{ role: string; content?: unknown }>, since: number): string | undefined {
  for (let index = messages.length - 1; index >= Math.max(0, since); index -= 1) {
    const message = messages[index]
    if (message.role === "user") return undefined
    if (message.role === "assistant" && typeof message.content === "string" && message.content.trim()) {
      return message.content
    }
  }
  return undefined
}
