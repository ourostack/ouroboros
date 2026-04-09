import type { TaskStatus, TransitionResult } from "../../arc/task-lifecycle"

export type { TaskStatus, TransitionResult } from "../../arc/task-lifecycle"

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
  hasWorkDir: boolean
  workDirFiles: string[]
  derivedChildren: string[]
}

export interface TaskIndex {
  root: string
  tasks: TaskFile[]
  issues: TaskIssue[]
  fingerprint: string
}

export interface TaskIssue {
  target: string
  code: string
  description: string
  fix: string
  confidence: "safe" | "needs_review"
  category: "live" | "migration"
}

export interface FixOptions {
  mode: "dry-run" | "safe" | "single"
  issueId?: string
  option?: number
}

export interface FixResult {
  applied: TaskIssue[]
  remaining: TaskIssue[]
  skipped: TaskIssue[]
  health: string
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
  issues: TaskIssue[]
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
  fix(options: FixOptions): FixResult
  detectStale(thresholdDays: number): TaskFile[]
  boardStatus(status: string): string[]
  boardAction(): string[]
  boardDeps(): string[]
  boardSessions(): string[]
}
