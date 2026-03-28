import * as fs from "fs"
import * as path from "path"

import { getAgentBundlesRoot } from "../identity"
import { emitNervesEvent } from "../../nerves/runtime"
import { parseTaskFile, renderTaskFile } from "../../repertoire/tasks/parser"
import type { OsCronManager } from "./os-cron"
import { parseCadenceToCron } from "./cadence"

export interface ScheduledTaskJob {
  id: string
  agent: string
  taskId: string
  schedule: string
  lastRun: string | null
  command: string
  taskPath: string
}

type ExistsSync = (target: string) => boolean
type ReadText = (target: string, encoding: "utf-8") => string
type WriteText = (target: string, content: string, encoding: "utf-8") => void
type Readdir = (target: string, options: { withFileTypes: true }) => fs.Dirent[]

export interface TaskDrivenSchedulerOptions {
  agents: string[]
  bundlesRoot?: string
  nowIso?: () => string
  existsSync?: ExistsSync
  readFileSync?: ReadText
  writeFileSync?: WriteText
  readdirSync?: Readdir
  osCronManager?: OsCronManager
}

function walkMarkdownFiles(
  root: string,
  readdirSync: Readdir,
  existsSync: ExistsSync,
  files: string[],
): void {
  if (!existsSync(root)) return

  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const fullPath = path.join(root, entry.name)
    if (entry.isDirectory()) {
      walkMarkdownFiles(fullPath, readdirSync, existsSync, files)
      continue
    }
    if (entry.name.endsWith(".md")) {
      files.push(fullPath)
    }
  }
}

function parseScheduledAt(raw: unknown): string | null {
  if (typeof raw !== "string") return null
  const value = raw.trim()
  if (!value) return null

  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return null

  const minute = date.getUTCMinutes()
  const hour = date.getUTCHours()
  const day = date.getUTCDate()
  const month = date.getUTCMonth() + 1
  return `${minute} ${hour} ${day} ${month} *`
}

function removeRuntimeFrontmatter(frontmatter: Record<string, unknown>): Record<string, unknown> {
  const { _isCanonicalFilename, ...clean } = frontmatter
  return clean
}

export class TaskDrivenScheduler {
  private readonly agents: string[]
  private readonly bundlesRoot: string
  private readonly nowIso: () => string
  private readonly existsSync: ExistsSync
  private readonly readFileSync: ReadText
  private readonly writeFileSync: WriteText
  private readonly readdirSync: Readdir
  private readonly osCronManager?: OsCronManager
  private readonly jobs = new Map<string, ScheduledTaskJob>()
  private readonly taskPathByKey = new Map<string, string>()

  constructor(options: TaskDrivenSchedulerOptions) {
    this.agents = [...options.agents]
    this.bundlesRoot = options.bundlesRoot ?? getAgentBundlesRoot()
    this.nowIso = options.nowIso ?? (() => new Date().toISOString())
    this.existsSync = options.existsSync ?? fs.existsSync
    this.readFileSync = options.readFileSync ?? fs.readFileSync
    this.writeFileSync = options.writeFileSync ?? fs.writeFileSync
    this.readdirSync = options.readdirSync ?? fs.readdirSync
    this.osCronManager = options.osCronManager
  }

  start(): void {
    void this.reconcile()
  }

  stop(): void {
    this.osCronManager?.removeAll()
  }

  listJobs(): Array<{ id: string; schedule: string; lastRun: string | null }> {
    return [...this.jobs.values()]
      .map((job) => ({ id: job.id, schedule: job.schedule, lastRun: job.lastRun }))
      .sort((a, b) => a.id.localeCompare(b.id))
  }

  async triggerJob(jobId: string): Promise<{ ok: boolean; message: string }> {
    const job = this.jobs.get(jobId)
    if (!job) {
      return { ok: false, message: `unknown scheduled job: ${jobId}` }
    }

    await this.recordTaskRun(job.agent, job.taskId)
    return { ok: true, message: `triggered ${jobId}` }
  }

  async reconcile(): Promise<void> {
    const nextJobs = new Map<string, ScheduledTaskJob>()
    const nextTaskPaths = new Map<string, string>()

    for (const agent of this.agents) {
      const taskRoot = path.join(this.bundlesRoot, `${agent}.ouro`, "tasks")
      const collections = ["one-shots", "ongoing"]
      const files: string[] = []
      for (const collection of collections) {
        walkMarkdownFiles(path.join(taskRoot, collection), this.readdirSync, this.existsSync, files)
      }

      for (const filePath of files) {
        let task: ReturnType<typeof parseTaskFile>
        try {
          task = parseTaskFile(this.readFileSync(filePath, "utf-8"), filePath)
        } catch {
          continue
        }

        const taskId = task.stem
        nextTaskPaths.set(`${agent}:${taskId}`, filePath)

        if (task.status === "done") continue

        const cadence = parseCadenceToCron(task.frontmatter.cadence)
        if (cadence) {
          const id = `${agent}:${taskId}:cadence`
          nextJobs.set(id, {
            id,
            agent,
            taskId,
            schedule: cadence,
            lastRun: typeof task.frontmatter.lastRun === "string" ? task.frontmatter.lastRun : null,
            command: `ouro poke ${agent} --task ${taskId}`,
            taskPath: filePath,
          })
        }

        const scheduledAt = parseScheduledAt(task.frontmatter.scheduledAt)
        if (scheduledAt) {
          const id = `${agent}:${taskId}:scheduledAt`
          nextJobs.set(id, {
            id,
            agent,
            taskId,
            schedule: scheduledAt,
            lastRun: typeof task.frontmatter.lastRun === "string" ? task.frontmatter.lastRun : null,
            command: `ouro poke ${agent} --task ${taskId}`,
            taskPath: filePath,
          })
        }
      }
    }

    this.jobs.clear()
    for (const [id, job] of nextJobs.entries()) {
      this.jobs.set(id, job)
    }

    this.taskPathByKey.clear()
    for (const [key, filePath] of nextTaskPaths.entries()) {
      this.taskPathByKey.set(key, filePath)
    }

    emitNervesEvent({
      component: "daemon",
      event: "daemon.scheduler_reconciled",
      message: "reconciled task-driven schedule jobs",
      meta: { jobCount: this.jobs.size, agents: this.agents.length },
    })

    this.osCronManager?.sync([...this.jobs.values()])
  }

  async recordTaskRun(agent: string, taskId: string): Promise<void> {
    const key = `${agent}:${taskId}`
    let taskPath = this.taskPathByKey.get(key)

    if (!taskPath) {
      await this.reconcile()
      taskPath = this.taskPathByKey.get(key)
      if (!taskPath) return
    }

    let parsed: ReturnType<typeof parseTaskFile>
    try {
      parsed = parseTaskFile(this.readFileSync(taskPath, "utf-8"), taskPath)
    } catch {
      return
    }

    const now = this.nowIso()
    const frontmatter = removeRuntimeFrontmatter(parsed.frontmatter)
    frontmatter.lastRun = now
    if (typeof frontmatter.updated === "string") {
      frontmatter.updated = now.slice(0, 10)
    }

    this.writeFileSync(taskPath, renderTaskFile(frontmatter, parsed.body), "utf-8")

    for (const job of this.jobs.values()) {
      if (job.agent === agent && job.taskId === taskId) {
        job.lastRun = now
      }
    }

    emitNervesEvent({
      component: "daemon",
      event: "daemon.scheduler_task_run_recorded",
      message: "recorded scheduled task run",
      meta: { agent, taskId, at: now },
    })
  }
}
