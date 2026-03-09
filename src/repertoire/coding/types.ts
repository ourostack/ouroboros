export type CodingRunner = "claude" | "codex"

export type CodingSessionStatus =
  | "spawning"
  | "running"
  | "waiting_input"
  | "completed"
  | "failed"
  | "stalled"
  | "killed"

export interface CodingSessionRequest {
  runner: CodingRunner
  workdir: string
  prompt: string
  taskRef?: string
  sessionId?: string
  parentAgent?: string
  scopeFile?: string
  stateFile?: string
  autoRestartOnCrash?: boolean
  autoRestartOnStall?: boolean
  stallThresholdMs?: number
}

export interface CodingFailureDiagnostics {
  command: string
  args: string[]
  code: number | null
  signal: NodeJS.Signals | null
  stdoutTail: string
  stderrTail: string
}

export interface CodingSession {
  id: string
  runner: CodingRunner
  workdir: string
  taskRef?: string
  scopeFile?: string
  stateFile?: string
  status: CodingSessionStatus
  stdoutTail: string
  stderrTail: string
  pid: number | null
  startedAt: string
  lastActivityAt: string
  endedAt: string | null
  restartCount: number
  lastExitCode: number | null
  lastSignal: NodeJS.Signals | null
  failure: CodingFailureDiagnostics | null
}

export interface CodingActionResult {
  ok: boolean
  message: string
}
