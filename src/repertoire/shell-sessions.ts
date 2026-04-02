import { spawn, type ChildProcess } from "child_process"
import { randomUUID } from "crypto"
import { emitNervesEvent } from "../nerves/runtime"

export interface ShellSession {
  id: string
  command: string
  status: "running" | "exited"
  exitCode: number | null
  pid: number | undefined
  startedAt: number
  output: string[]
}

interface LiveSession {
  process: ChildProcess
  info: ShellSession
}

const sessions = new Map<string, LiveSession>()
const MAX_OUTPUT_LINES = 200

export function spawnBackgroundShell(command: string): ShellSession {
  const id = randomUUID()
  const proc = spawn("sh", ["-c", command], {
    stdio: ["pipe", "pipe", "pipe"],
  })

  const session: LiveSession = {
    process: proc,
    info: {
      id,
      command,
      status: "running",
      exitCode: null,
      pid: proc.pid,
      startedAt: Date.now(),
      output: [],
    },
  }

  const appendOutput = (data: Buffer) => {
    const lines = data.toString().split("\n")
    for (const line of lines) {
      if (line.length > 0 || session.info.output.length > 0) {
        session.info.output.push(line)
      }
    }
    // Keep only the last MAX_OUTPUT_LINES
    if (session.info.output.length > MAX_OUTPUT_LINES) {
      session.info.output = session.info.output.slice(-MAX_OUTPUT_LINES)
    }
  }

  proc.stdout?.on("data", appendOutput)
  proc.stderr?.on("data", appendOutput)

  proc.on("close", (code) => {
    session.info.status = "exited"
    session.info.exitCode = code
    emitNervesEvent({
      component: "repertoire",
      event: "repertoire.shell.process_exit",
      message: "background shell process exited",
      meta: { id, command, exitCode: code, pid: proc.pid },
    })
  })

  sessions.set(id, session)

  emitNervesEvent({
    component: "repertoire",
    event: "repertoire.shell.spawn",
    message: "spawned background shell session",
    meta: { id, command, pid: proc.pid },
  })

  return { ...session.info }
}

export function getShellSession(id: string): ShellSession | undefined {
  const session = sessions.get(id)
  if (!session) return undefined
  emitNervesEvent({
    component: "repertoire",
    event: "repertoire.shell.status_check",
    message: "checked shell session status",
    meta: { id, status: session.info.status, exitCode: session.info.exitCode },
  })
  return { ...session.info }
}

export function listShellSessions(): ShellSession[] {
  return Array.from(sessions.values()).map((s) => ({
    id: s.info.id,
    command: s.info.command,
    status: s.info.status,
    exitCode: s.info.exitCode,
    pid: s.info.pid,
    startedAt: s.info.startedAt,
    output: [], // Don't include full output in listing
  }))
}

export function tailShellSession(id: string, lines = 50): string | undefined {
  const session = sessions.get(id)
  if (!session) return undefined
  const tail = session.info.output.slice(-lines)
  emitNervesEvent({
    component: "repertoire",
    event: "repertoire.shell.tail",
    message: "tailed shell session output",
    meta: { id, requestedLines: lines, returnedLines: tail.length },
  })
  return tail.join("\n")
}

/** Reset all sessions (for testing) */
export function resetShellSessions(): void {
  for (const session of sessions.values()) {
    if (session.info.status === "running") {
      session.process.kill()
    }
  }
  sessions.clear()
}

// ── Destructive Pattern Detection ──

interface DestructivePattern {
  name: string
  regex: RegExp
}

const DESTRUCTIVE_PATTERNS: DestructivePattern[] = [
  { name: "rm -rf root/home", regex: /rm\s+-rf\s+[/~]/ },
  { name: "git push --force", regex: /git\s+push\s+--force/ },
  { name: "git reset --hard", regex: /git\s+reset\s+--hard/ },
  { name: "git clean -f", regex: /git\s+clean\s+-f/ },
  { name: "git branch -D", regex: /git\s+branch\s+-D/ },
  { name: "fork bomb", regex: /:\(\)\s*\{/ },
  { name: "write to raw device", regex: />\s*\/dev\/sd/ },
  { name: "git checkout .", regex: /git\s+checkout\s+\./ },
  { name: "git stash drop", regex: /git\s+stash\s+drop/ },
]

/**
 * Detect destructive patterns in a shell command.
 * Returns list of matched pattern names. Empty array = safe.
 * This is a friction layer, not a hard block.
 */
export function detectDestructivePatterns(command: string): string[] {
  const matched: string[] = []
  for (const pattern of DESTRUCTIVE_PATTERNS) {
    if (pattern.regex.test(command)) {
      matched.push(pattern.name)
    }
  }
  return matched
}
