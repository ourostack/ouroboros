import * as fs from "fs"
import * as path from "path"
import { slugify } from "../../heart/config"
import { emitNervesEvent } from "../../nerves/runtime"
import { boardAction, boardDeps, boardSessions, boardStatus, buildTaskBoard } from "./board"
import { archiveCompletedTasks, detectStaleTasks } from "./lifecycle"
import { parseTaskFile, renderTaskFile } from "./parser"
import { clearTaskScanCache, getTaskRoot, scanTasks } from "./scanner"
import { validateSpawn, validateStatusTransition, validateWrite } from "./middleware"
import type {
  BoardResult,
  CreateTaskInput,
  SpawnValidation,
  TaskFile,
  TaskIndex,
  TaskModule,
  TaskStatus,
  TransitionResult,
  ValidationResult,
} from "./types"
import {
  canonicalCollectionForTaskType,
  normalizeTaskType,
  normalizeTaskStatus,
  validateTransition as validateTaskTransition,
} from "./transitions"

function formatDate(now = new Date()): string {
  return now.toISOString().slice(0, 10)
}

function formatStemTimestamp(now = new Date()): string {
  const year = now.getFullYear()
  const month = String(now.getMonth() + 1).padStart(2, "0")
  const day = String(now.getDate()).padStart(2, "0")
  const hours = String(now.getHours()).padStart(2, "0")
  const minutes = String(now.getMinutes()).padStart(2, "0")
  return `${year}-${month}-${day}-${hours}${minutes}`
}

function findTask(index: TaskIndex, nameOrStem: string): TaskFile | null {
  return (
    index.tasks.find((task) => task.stem === nameOrStem || task.name === nameOrStem) ??
    index.tasks.find((task) => task.stem.endsWith(nameOrStem)) ??
    null
  )
}

function removeRuntimeFrontmatter(frontmatter: Record<string, unknown>): Record<string, unknown> {
  const { _isCanonicalFilename, ...clean } = frontmatter
  return clean
}

class FileTaskModule implements TaskModule {
  scan(): TaskIndex {
    return scanTasks(getTaskRoot())
  }

  getBoard(): BoardResult {
    return buildTaskBoard(this.scan())
  }

  getTask(name: string): TaskFile | null {
    return findTask(this.scan(), name)
  }

  createTask(input: CreateTaskInput): string {
    emitNervesEvent({
      event: "mind.step_start",
      component: "mind",
      message: "creating task file",
      meta: { type: input.type },
    })

    const type = normalizeTaskType(input.type)
    if (!type) {
      throw new Error(`invalid task type: ${input.type}`)
    }

    const status = normalizeTaskStatus(input.status ?? "drafting")
    if (!status) {
      throw new Error(`invalid task status: ${String(input.status)}`)
    }

    const collection = canonicalCollectionForTaskType(type)
    const stem = `${formatStemTimestamp()}-${slugify(input.title).slice(0, 64) || "task"}`
    const filename = `${stem}.md`
    const root = getTaskRoot()
    const filePath = path.join(root, collection, filename)
    const today = formatDate()

    const frontmatter: Record<string, unknown> = {
      type,
      category: input.category || "infrastructure",
      title: input.title,
      status,
      validator: input.validator ?? null,
      requester: input.requester ?? "agent",
      cadence: input.cadence ?? null,
      scheduledAt: input.scheduledAt ?? null,
      lastRun: input.lastRun ?? null,
      created: today,
      updated: today,
      child_tasks: [],
      artifacts: [],
    }

    if (type === "one-shot") {
      frontmatter.parent_task = null
      frontmatter.depends_on = []
    }
    const content = renderTaskFile(frontmatter, input.body)
    const validation = validateWrite(filePath, content)
    if (!validation.ok) {
      throw new Error(validation.reason ?? "task write validation failed")
    }

    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    fs.writeFileSync(filePath, content, "utf-8")
    clearTaskScanCache()
    return filePath
  }

  updateStatus(name: string, toStatus: string): TransitionResult & { path?: string; archived?: string[] } {
    const normalized = normalizeTaskStatus(toStatus)
    if (!normalized) {
      return { ok: false, from: "drafting", to: "drafting", reason: `invalid target status: ${toStatus}` }
    }

    const index = this.scan()
    const task = findTask(index, name)
    if (!task) {
      return { ok: false, from: "drafting", to: normalized, reason: `task not found: ${name}` }
    }

    const gate = validateStatusTransition(task, normalized)
    if (!gate.ok) {
      return { ok: false, from: task.status, to: normalized, reason: gate.reason }
    }

    const content = fs.readFileSync(task.path, "utf-8")
    const parsed = parseTaskFile(content, task.path)
    const frontmatter = removeRuntimeFrontmatter(parsed.frontmatter)
    frontmatter.status = normalized
    frontmatter.updated = formatDate()

    fs.writeFileSync(task.path, renderTaskFile(frontmatter, parsed.body), "utf-8")
    clearTaskScanCache()

    const transition: TransitionResult = { ok: true, from: task.status, to: normalized }

    const afterIndex = this.scan()
    const archive = archiveCompletedTasks(afterIndex)
    if (archive.archived.length > 0 || archive.failures.length > 0) {
      clearTaskScanCache()
    }

    return {
      ...transition,
      path: task.path,
      archived: archive.archived,
    }
  }

  validateWrite(filePath: string, content: string): ValidationResult {
    return validateWrite(filePath, content)
  }

  validateTransition(from: TaskStatus, to: TaskStatus): TransitionResult {
    return validateTaskTransition(from, to)
  }

  validateSpawn(taskName: string, spawnType: string): SpawnValidation {
    const task = this.getTask(taskName)
    if (!task) {
      return { ok: false, reason: `task not found: ${taskName}` }
    }

    return validateSpawn(task, spawnType)
  }

  detectStale(thresholdDays: number): TaskFile[] {
    return detectStaleTasks(this.scan(), thresholdDays)
  }

  boardStatus(status: string): string[] {
    const normalized = normalizeTaskStatus(status)
    if (!normalized) return []
    return boardStatus(this.getBoard(), normalized)
  }

  boardAction(): string[] {
    return boardAction(this.getBoard())
  }

  boardDeps(): string[] {
    return boardDeps(this.getBoard())
  }

  boardSessions(): string[] {
    return boardSessions(this.getBoard())
  }
}

let taskModule: TaskModule | null = null

export function getTaskModule(): TaskModule {
  if (!taskModule) {
    taskModule = new FileTaskModule()
  }
  return taskModule
}

export function resetTaskModule(): void {
  taskModule = null
  clearTaskScanCache()
}
