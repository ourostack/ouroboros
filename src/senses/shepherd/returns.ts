import * as fs from "node:fs"
import * as path from "node:path"
import { emitNervesEvent } from "../../nerves/runtime"
import type { ReturnKind } from "./judge"

/** The returns log: one line per judgment, read by the sense, the Shepherd tools and the human. */
const LOG_MAX_BYTES = 2 * 1024 * 1024

export type ReturnAction = "respond" | "let_through"

export interface ReturnRecord {
  at: string
  host: string
  session: string
  transition: string
  agent: string | null
  cwd: string | null
  task: string | null
  kind: ReturnKind | "error" | "loop_guard"
  action: ReturnAction
  reason: string
  reply: string | null
  latencyMs: number | null
  inputTokens: number | null
}

export function shepherdStateDir(agentRoot: string): string {
  return path.join(agentRoot, "state", "senses", "shepherd")
}

export function returnsLogPath(agentRoot: string): string {
  return path.join(shepherdStateDir(agentRoot), "returns.jsonl")
}

/** Appends one judgment. The log is machine-local (0700 directory, 0600 file) and rotates once at 2 MB. */
export function appendReturn(agentRoot: string, record: ReturnRecord): void {
  const file = returnsLogPath(agentRoot)
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  try {
    if (fs.statSync(file).size > LOG_MAX_BYTES) fs.renameSync(file, `${file}.1`)
  } catch {
    // No log yet.
  }
  fs.appendFileSync(file, `${JSON.stringify(record)}\n`, { mode: 0o600 })
  emitNervesEvent({ component: "senses", event: "senses.shepherd_return_logged", message: "logged a Shepherd judgment", meta: { kind: record.kind, action: record.action } })
}

export function readReturns(agentRoot: string): ReturnRecord[] {
  try {
    return fs.readFileSync(returnsLogPath(agentRoot), "utf-8").split("\n").flatMap((line) => {
      try {
        return line ? [JSON.parse(line) as ReturnRecord] : []
      } catch {
        return []
      }
    })
  } catch {
    return []
  }
}
