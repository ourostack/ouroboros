import * as fs from "fs"
import * as path from "path"

import { getAgentBundlesRoot } from "../identity"
import { emitNervesEvent } from "../../nerves/runtime"
import { parseFrontmatter } from "../../util/frontmatter"
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

interface ParsedSchedulerTask {
  stem: string
  status: string
  frontmatter: Record<string, unknown>
  body: string
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

/**
 * Parse a task markdown file into the minimum scheduler-relevant projection.
 * Inlines the previous `parseTaskFile` shape (only what the scheduler reads),
 * so we don't depend on `src/repertoire/tasks/parser`. The shared
 * `parseFrontmatter` util handles the YAML-ish frontmatter format.
 */
function parseSchedulerTask(content: string, filePath: string): ParsedSchedulerTask {
  emitNervesEvent({
    event: "daemon.scheduler_task_parse",
    component: "daemon",
    message: "parsing scheduler task file",
    meta: { filePath },
  })

  const lines = content.split(/\r?\n/)
  if (lines[0]?.trim() !== "---") {
    throw new Error("task file missing frontmatter")
  }

  const closing = lines.findIndex((line, index) => index > 0 && line.trim() === "---")
  if (closing === -1) {
    throw new Error("task file has unterminated frontmatter")
  }

  const rawFrontmatter = lines.slice(1, closing).join("\n")
  const body = lines.slice(closing + 1).join("\n").trim()
  const frontmatter = parseFrontmatter(rawFrontmatter)

  const name = path.basename(filePath)
  const stem = name.replace(/\.md$/i, "")
  const rawStatus = typeof frontmatter.status === "string" ? frontmatter.status : ""

  return { stem, status: rawStatus, frontmatter, body }
}

function formatFrontmatterValue(value: unknown): string[] {
  if (Array.isArray(value)) {
    if (value.length === 0) return ["[]"]
    return ["", ...value.map((entry) => `- ${String(entry)}`)]
  }
  if (value === null) return ["null"]
  return [String(value)]
}

/**
 * Render a frontmatter+body markdown file. Inlined from the previous
 * `renderTaskFile` (in `src/repertoire/tasks/parser`) so the scheduler can
 * update `lastRun` without depending on the task module.
 */
function renderSchedulerTask(frontmatter: Record<string, unknown>, body: string): string {
  const keys = Object.keys(frontmatter)
  const lines: string[] = ["---"]

  for (const key of keys) {
    const rendered = formatFrontmatterValue(frontmatter[key])
    if (rendered.length === 1) {
      lines.push(`${key}: ${rendered[0]}`)
    } else {
      lines.push(`${key}:`)
      for (const entry of rendered.slice(1)) {
        lines.push(entry)
      }
    }
  }

  lines.push("---")
  lines.push("")
  lines.push(body.trim())
  lines.push("")
  return lines.join("\n")
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

  /**
   * Discover scheduler-eligible task files across both surfaces:
   * - legacy: `<bundle>/tasks/{one-shots,ongoing}/**\/*.md`
   * - desk:   `<bundle>/desk/<track>/<task-slug>/task.md`
   *
   * Dual-read is intentional during the W6 transition: old harnesses still
   * write to `tasks/`; new harnesses + agents write to `desk/`. The scheduler
   * accepts both.
   */
  private collectTaskFiles(agent: string): string[] {
    const bundleRoot = path.join(this.bundlesRoot, `${agent}.ouro`)
    const files: string[] = []

    // Legacy `tasks/{one-shots,ongoing}/` collections.
    const legacyRoot = path.join(bundleRoot, "tasks")
    for (const collection of ["one-shots", "ongoing"]) {
      walkMarkdownFiles(path.join(legacyRoot, collection), this.readdirSync, this.existsSync, files)
    }

    // New `desk/<track>/<task-slug>/task.md` shape.
    const deskRoot = path.join(bundleRoot, "desk")
    if (this.existsSync(deskRoot)) {
      for (const trackEntry of this.readdirSync(deskRoot, { withFileTypes: true })) {
        if (!trackEntry.isDirectory()) continue
        if (trackEntry.name.startsWith("_") || trackEntry.name.startsWith(".")) continue
        const trackDir = path.join(deskRoot, trackEntry.name)
        for (const taskEntry of this.readdirSync(trackDir, { withFileTypes: true })) {
          if (!taskEntry.isDirectory()) continue
          if (taskEntry.name.startsWith("_") || taskEntry.name.startsWith(".")) continue
          const taskFile = path.join(trackDir, taskEntry.name, "task.md")
          if (this.existsSync(taskFile)) files.push(taskFile)
        }
      }
    }

    return files
  }

  async reconcile(): Promise<void> {
    const nextJobs = new Map<string, ScheduledTaskJob>()
    const nextTaskPaths = new Map<string, string>()

    for (const agent of this.agents) {
      const files = this.collectTaskFiles(agent)

      for (const filePath of files) {
        let task: ParsedSchedulerTask
        try {
          task = parseSchedulerTask(this.readFileSync(filePath, "utf-8"), filePath)
        } catch {
          continue
        }

        // Desk task files live at `desk/<track>/<task-slug>/task.md`, so the
        // markdown basename is "task" — use the parent directory name as the
        // stable slug. Legacy `tasks/<collection>/<stem>.md` keeps the
        // filename stem.
        const isDeskTask = path.basename(filePath) === "task.md"
        const taskId = isDeskTask ? path.basename(path.dirname(filePath)) : task.stem
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

    let parsed: ParsedSchedulerTask
    try {
      parsed = parseSchedulerTask(this.readFileSync(taskPath, "utf-8"), taskPath)
    } catch {
      return
    }

    const now = this.nowIso()
    const frontmatter: Record<string, unknown> = { ...parsed.frontmatter }
    frontmatter.lastRun = now
    if (typeof frontmatter.updated === "string") {
      frontmatter.updated = now.slice(0, 10)
    }

    this.writeFileSync(taskPath, renderSchedulerTask(frontmatter, parsed.body), "utf-8")

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
