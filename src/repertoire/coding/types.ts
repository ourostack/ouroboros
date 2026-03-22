export type CodingRunner = "claude" | "codex"

export interface CodingSessionOrigin {
  friendId: string
  channel: string
  key: string
}

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
  originSession?: CodingSessionOrigin
  obligationId?: string
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
  originSession?: CodingSessionOrigin
  obligationId?: string
  scopeFile?: string
  stateFile?: string
  checkpoint?: string | null
  artifactPath?: string
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

export type CodingSessionUpdateKind =
  | "spawned"
  | "progress"
  | "waiting_input"
  | "stalled"
  | "completed"
  | "failed"
  | "killed"

export interface CodingSessionUpdate {
  kind: CodingSessionUpdateKind
  session: CodingSession
  stream?: "stdout" | "stderr"
  text?: string
}

export interface CodingActionResult {
  ok: boolean
  message: string
}
