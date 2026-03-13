import { emitNervesEvent } from "../../nerves/runtime"
import type { BoardResult, TaskFile, TaskIndex, TaskStatus } from "./types"
import { TASK_VALID_STATUSES } from "./transitions"

const BOARD_STATUS_ORDER: readonly TaskStatus[] = [
  "blocked",
  "processing",
  "collaborating",
  "drafting",
  "validating",
  "paused",
  "done",
]

function compactName(task: TaskFile): string {
  const suffix = task.stem.replace(/^\d{4}-\d{2}-\d{2}-\d{4}-/, "")
  return suffix.length > 0 ? suffix : task.stem
}

function groupByStatus(tasks: TaskFile[]): Record<TaskStatus, string[]> {
  const grouped: Record<TaskStatus, string[]> = {
    drafting: [],
    processing: [],
    validating: [],
    collaborating: [],
    paused: [],
    blocked: [],
    done: [],
  }
  for (const task of tasks) {
    grouped[task.status].push(compactName(task))
  }

  for (const status of TASK_VALID_STATUSES) {
    grouped[status].sort()
  }

  return grouped
}

function unresolvedDependencies(index: TaskIndex): string[] {
  const stems = new Set(index.tasks.map((task) => task.stem))
  const unresolved: string[] = []

  for (const task of index.tasks) {
    const deps = Array.isArray(task.frontmatter.depends_on) ? (task.frontmatter.depends_on as unknown[]) : []
    for (const dep of deps) {
      if (typeof dep === "string" && dep.trim() && !stems.has(dep)) {
        unresolved.push(`${task.stem} -> missing ${dep}`)
      }
    }
  }

  return unresolved.sort()
}

function activeSessionLines(tasks: TaskFile[]): string[] {
  const active = tasks.filter((task) => {
    const session = task.frontmatter.active_session
    const codingSession = task.frontmatter.coding_session
    return Boolean(session) || Boolean(codingSession)
  })

  return active.map((task) => task.stem).sort()
}

function activeBridgeLines(tasks: TaskFile[]): string[] {
  return tasks
    .filter((task) => typeof task.frontmatter.active_bridge === "string" && String(task.frontmatter.active_bridge).trim())
    .map((task) => `${task.stem} -> ${String(task.frontmatter.active_bridge).trim()}`)
    .sort()
}

function actionRequired(index: TaskIndex, byStatus: Record<TaskStatus, string[]>): string[] {
  const actions = [...index.parseErrors, ...index.invalidFilenames.map((filePath) => `bad filename: ${filePath}`)]

  if (byStatus.blocked.length > 0) {
    actions.push(`blocked tasks: ${byStatus.blocked.join(", ")}`)
  }

  const missingCategory = index.tasks
    .filter((task) => !task.category || !task.category.trim())
    .map((task) => `missing category: ${task.stem}`)

  return [...actions, ...missingCategory]
}

export function buildTaskBoard(index: TaskIndex): BoardResult {
  emitNervesEvent({
    event: "mind.step_start",
    component: "mind",
    message: "building task board",
    meta: { taskCount: index.tasks.length },
  })

  const byStatus = groupByStatus(index.tasks)
  const counts = TASK_VALID_STATUSES.map((status) => `${status}:${byStatus[status].length}`).join(" ")
  const processing = byStatus.processing.length > 0 ? `\n processing: ${byStatus.processing.join(", ")}` : ""
  const blocked = byStatus.blocked.length > 0 ? `\n blocked: ${byStatus.blocked.join(", ")}` : ""

  const compact = `[Tasks] ${counts}${processing}${blocked}`

  const fullLines: string[] = []
  for (const status of BOARD_STATUS_ORDER) {
    const names = byStatus[status]
    if (status === "done" && names.length === 0) continue
    fullLines.push(`## ${status}`)
    fullLines.push(names.length > 0 ? names.map((name) => `- ${name}`).join("\n") : "- (none)")
  }

  const unresolved = unresolvedDependencies(index)
  if (unresolved.length > 0) {
    fullLines.push("## dependencies")
    fullLines.push(unresolved.map((line) => `- ${line}`).join("\n"))
  }

  const active = activeSessionLines(index.tasks)
  if (active.length > 0) {
    fullLines.push("## active sessions")
    fullLines.push(active.map((line) => `- ${line}`).join("\n"))
  }

  const activeBridges = activeBridgeLines(index.tasks)
  if (activeBridges.length > 0) {
    fullLines.push("## active bridges")
    fullLines.push(activeBridges.map((line) => `- ${line}`).join("\n"))
  }

  return {
    compact,
    full: fullLines.join("\n\n"),
    byStatus,
    actionRequired: actionRequired(index, byStatus),
    unresolvedDependencies: unresolved,
    activeSessions: active,
    activeBridges,
  }
}

export function boardStatus(board: BoardResult, status: TaskStatus): string[] {
  return board.byStatus[status] ?? []
}

export function boardAction(board: BoardResult): string[] {
  return board.actionRequired
}

export function boardDeps(board: BoardResult): string[] {
  return board.unresolvedDependencies
}

export function boardSessions(board: BoardResult): string[] {
  return board.activeSessions
}
