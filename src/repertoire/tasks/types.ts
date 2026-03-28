export type TaskStatus =
  | "drafting"
  | "processing"
  | "validating"
  | "collaborating"
  | "paused"
  | "blocked"
  | "done"

export type CanonicalTaskType = "one-shot" | "ongoing"

export type CanonicalTaskCollection = "one-shots" | "ongoing"

export interface TaskFile {
  path: string
  name: string
  stem: string
  type: CanonicalTaskType
  collection: CanonicalTaskCollection
  category: string
  title: string
  status: TaskStatus
  created: string
  updated: string
  frontmatter: Record<string, unknown>
  body: string
}

export interface TaskIndex {
  root: string
  tasks: TaskFile[]
  invalidFilenames: string[]
  parseErrors: string[]
  fingerprint: string
}

export interface TransitionResult {
  ok: boolean
  from: TaskStatus
  to: TaskStatus
  reason?: string
}

export interface ValidationResult {
  ok: boolean
  reason?: string
  missingFields?: string[]
}

export interface SpawnValidation {
  ok: boolean
  reason?: string
}

export interface BoardResult {
  compact: string
  full: string
  byStatus: Record<TaskStatus, string[]>
  actionRequired: string[]
  unresolvedDependencies: string[]
  activeSessions: string[]
  activeBridges: string[]
}

export interface CreateTaskInput {
  title: string
  type: CanonicalTaskType | string
  category: string
  body: string
  status?: TaskStatus | string
  validator?: string | null
  requester?: string | null
  cadence?: string | null
  scheduledAt?: string | null
  lastRun?: string | null
  activeBridge?: string | null
  bridgeSessions?: string[] | null
}

export interface BindBridgeResult {
  ok: boolean
  path?: string
  reason?: string
}

export interface TaskModule {
  scan(): TaskIndex
  getBoard(): BoardResult
  getTask(name: string): TaskFile | null
  createTask(input: CreateTaskInput): string
  bindBridge(name: string, input: { bridgeId: string; sessionRefs: string[] }): BindBridgeResult
  updateStatus(name: string, toStatus: string): TransitionResult & { path?: string; archived?: string[] }
  validateWrite(filePath: string, content: string): ValidationResult
  validateTransition(from: TaskStatus, to: TaskStatus): TransitionResult
  validateSpawn(taskName: string, spawnType: string): SpawnValidation
  detectStale(thresholdDays: number): TaskFile[]
  boardStatus(status: string): string[]
  boardAction(): string[]
  boardDeps(): string[]
  boardSessions(): string[]
}
