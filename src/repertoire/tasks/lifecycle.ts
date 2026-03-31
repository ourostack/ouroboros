import * as fs from "fs"
import * as path from "path"
import { emitNervesEvent } from "../../nerves/runtime"
import type { TaskFile, TaskIndex } from "./types"

export interface ArchiveResult {
  archived: string[]
  failures: string[]
}

export function archiveCompletedTasks(index: TaskIndex): ArchiveResult {
  emitNervesEvent({
    event: "mind.step_start",
    component: "mind",
    message: "archiving completed tasks",
    meta: { root: index.root },
  })

  const archived: string[] = []
  const failures: string[] = []

  for (const task of index.tasks) {
    if (task.status !== "done" && task.status !== "cancelled") continue

    const archiveDir = path.join(index.root, "archive", task.collection)
    const archiveFile = path.join(archiveDir, task.name)

    try {
      fs.mkdirSync(archiveDir, { recursive: true })
      fs.renameSync(task.path, archiveFile)

      const taskArtifactDir = task.path.replace(/\.md$/i, "")
      if (fs.existsSync(taskArtifactDir)) {
        fs.renameSync(taskArtifactDir, path.join(archiveDir, path.basename(taskArtifactDir)))
      }

      archived.push(archiveFile)
    } catch (error) {
      failures.push(`${task.path}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  return { archived, failures }
}

export function detectStaleTasks(index: TaskIndex, thresholdDays: number, now = new Date()): TaskFile[] {
  const staleCutoffMs = now.getTime() - thresholdDays * 24 * 60 * 60 * 1000
  return index.tasks.filter((task) => {
    const updated = Date.parse(task.updated)
    if (Number.isNaN(updated)) return false
    if (task.status === "done" || task.status === "cancelled") return false
    return updated < staleCutoffMs
  })
}
