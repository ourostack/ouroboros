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
  evolutionCaseId?: string
  sessionId?: string
  parentAgent?: string
  scopeFile?: string
  stateFile?: string
  autoRestartOnCrash?: boolean
  autoRestartOnStall?: boolean
  stallThresholdMs?: number
  verificationCommands?: string[]
}

export interface CodingFailureDiagnostics {
  command: string
  args: string[]
  code: number | null
  signal: NodeJS.Signals | null
  stdoutTail: string
  stderrTail: string
}

export type CodingVerificationStatus = "not-verified" | "verified-pass" | "verified-fail"

export interface CodingIdentityPacket {
  repoPath: string | null
  worktreePath: string | null
  branch: string | null
  commit: string | null
  dirty: boolean
  dirtyFiles: string[]
  taskRef: string | null
  verificationCommands: string[]
  verificationStatus: CodingVerificationStatus
}

export interface CodingSession {
  id: string
  runner: CodingRunner
  workdir: string
  taskRef?: string
  originSession?: CodingSessionOrigin
  obligationId?: string
  evolutionCaseId?: string
  scopeFile?: string
  stateFile?: string
  checkpoint?: string | null
  artifactPath?: string
  codingIdentity?: CodingIdentityPacket
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

export interface CodingSessionManagerApi {
  spawnSession(request: CodingSessionRequest): Promise<CodingSession>
  listSessions(): CodingSession[]
  getSession(sessionId: string): CodingSession | null
  subscribe(sessionId: string, listener: (update: CodingSessionUpdate) => void | Promise<void>): () => void
  sendInput(sessionId: string, input: string): CodingActionResult | Promise<CodingActionResult>
  killSession(sessionId: string): CodingActionResult | Promise<CodingActionResult>
  checkStalls(nowMs?: number): number | Promise<number>
  shutdown(): void | Promise<void>
}

export interface RefreshableCodingSessionManagerApi extends CodingSessionManagerApi {
  refreshSessions(): Promise<CodingSession[]>
  refreshSession(sessionId: string): Promise<CodingSession | null>
}
