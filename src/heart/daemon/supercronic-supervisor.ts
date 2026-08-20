import { spawn, type ChildProcess } from "node:child_process"
import * as fs from "node:fs"
import * as path from "node:path"

import { emitNervesEvent } from "../../nerves/runtime"
import type { OsCronManager } from "./os-cron"
import type { ScheduledTaskJob } from "./task-scheduler"

interface SupercronicChild extends Pick<ChildProcess, "pid" | "kill" | "once" | "on"> {}

export interface SupercronicSupervisorDeps {
  mkdir(path: string): void
  readFile(path: string): string
  durableWrite(path: string, content: string, mode: number): void
  removeFile(path: string): void
  processAlive(pid: number): boolean
  spawn(binary: string, args: string[]): SupercronicChild
  setTimer(callback: () => void, delayMs: number): ReturnType<typeof setTimeout>
  clearTimer(timer: ReturnType<typeof setTimeout>): void
}

export interface SupercronicSupervisorOptions {
  binaryPath: string
  crontabPath: string
  pidPath?: string
  deps?: SupercronicSupervisorDeps
  onFatal?: (error: Error) => void
}

const NAMESPACE = /^(?:habit|await):[a-z0-9](?:[a-z0-9._-]{0,62})$/u
const SAFE_JOB = /^[^\r\n\0]+$/u
const RESTART_DELAYS_MS = [1_000, 5_000, 15_000] as const

function defaultDurableWrite(filePath: string, content: string, mode: number): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  const temporary = `${filePath}.${process.pid}.tmp`
  const fd = fs.openSync(temporary, "w", mode)
  try {
    fs.writeFileSync(fd, content, "utf8")
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
  fs.chmodSync(temporary, mode)
  fs.renameSync(temporary, filePath)
  const directory = fs.openSync(path.dirname(filePath), "r")
  try { fs.fsyncSync(directory) } finally { fs.closeSync(directory) }
}

function defaultDeps(): SupercronicSupervisorDeps {
  return {
    mkdir: (target) => fs.mkdirSync(target, { recursive: true }),
    readFile: (target) => fs.readFileSync(target, "utf8"),
    durableWrite: defaultDurableWrite,
    removeFile: (target) => { try { fs.unlinkSync(target) } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error } },
    processAlive: (pid) => { try { process.kill(pid, 0); return true } catch { return false } },
    spawn: (binary, args) => spawn(binary, args, { stdio: ["ignore", "inherit", "inherit"] }),
    setTimer: (callback, delayMs) => setTimeout(callback, delayMs),
    clearTimer: (timer) => clearTimeout(timer),
  }
}

export class SupercronicSupervisor {
  readonly deps: SupercronicSupervisorDeps
  private readonly binaryPath: string
  private readonly crontabPath: string
  private readonly pidPath: string
  private readonly onFatal: (error: Error) => void
  private readonly manifests = new Map<string, Map<string, ScheduledTaskJob>>()
  private child: SupercronicChild | null = null
  private restartTimer: ReturnType<typeof setTimeout> | null = null
  private restartCount = 0
  private stopping = false

  constructor(options: SupercronicSupervisorOptions) {
    this.binaryPath = options.binaryPath
    this.crontabPath = options.crontabPath
    this.pidPath = options.pidPath ?? `${options.crontabPath}.pid`
    this.deps = options.deps ?? defaultDeps()
    this.onFatal = options.onFatal ?? ((error) => { throw error })
  }

  start(): void {
    if (this.child || this.restartTimer) return
    this.deps.mkdir(path.dirname(this.crontabPath))
    const priorPid = this.readPriorPid()
    if (priorPid !== null && this.deps.processAlive(priorPid)) throw new Error(`Supercronic is already running with PID ${priorPid}`)
    this.render()
    this.stopping = false
    this.spawnChild()
    emitNervesEvent({ component: "daemon", event: "daemon.supercronic_state", message: "Supercronic supervisor started", meta: { crontabPath: this.crontabPath } })
  }

  namespace(namespace: string): OsCronManager {
    if (!NAMESPACE.test(namespace)) throw new Error(`invalid Supercronic namespace: ${namespace}`)
    return {
      sync: (jobs) => {
        const next = new Map<string, ScheduledTaskJob>()
        for (const job of jobs) {
          if (!SAFE_JOB.test(job.id) || !SAFE_JOB.test(job.taskId) || !SAFE_JOB.test(job.schedule) || !SAFE_JOB.test(job.command)) {
            throw new Error("invalid Supercronic job")
          }
          if (next.has(job.id)) throw new Error(`duplicate Supercronic job: ${job.id}`)
          next.set(job.id, structuredClone(job))
        }
        this.manifests.set(namespace, next)
        this.render()
        emitNervesEvent({ component: "daemon", event: "daemon.supercronic_state", message: "Supercronic manifest synchronized", meta: { namespace, jobCount: jobs.length } })
      },
      removeAll: () => {
        this.manifests.delete(namespace)
        this.render()
      },
      list: () => [...(this.manifests.get(namespace)?.values() ?? [])].map((job) => job.taskId).sort(),
    }
  }

  verifyNamespace(namespace: string, jobs: ScheduledTaskJob[]): boolean {
    if (!this.isHealthy()) return false
    const manifest = this.manifests.get(namespace)
    if (!manifest || manifest.size !== jobs.length) return false
    for (const job of jobs) {
      const existing = manifest.get(job.id)
      if (!existing || existing.schedule !== job.schedule || existing.command !== job.command) return false
    }
    try { return this.deps.readFile(this.crontabPath) === this.renderedContent() } catch { return false }
  }

  verificationOutput(): string {
    if (!this.isHealthy()) return ""
    const expected = this.renderedContent()
    try { return this.deps.readFile(this.crontabPath) === expected ? expected : "" } catch { return "" }
  }

  isHealthy(): boolean {
    return this.child !== null && typeof this.child.pid === "number" && this.deps.processAlive(this.child.pid)
  }

  async stop(): Promise<void> {
    this.stopping = true
    if (this.restartTimer) this.deps.clearTimer(this.restartTimer)
    this.restartTimer = null
    const child = this.child
    if (!child) { this.deps.removeFile(this.pidPath); return }
    await new Promise<void>((resolve) => {
      let settled = false
      const finish = (): void => { if (settled) return; settled = true; resolve() }
      child.once("exit", finish)
      const timer = this.deps.setTimer(() => { child.kill("SIGKILL"); finish() }, 10_000)
      child.once("exit", () => this.deps.clearTimer(timer))
      child.kill("SIGTERM")
    })
    this.child = null
    this.deps.removeFile(this.pidPath)
    emitNervesEvent({ component: "daemon", event: "daemon.supercronic_state", message: "Supercronic supervisor stopped", meta: { crontabPath: this.crontabPath } })
  }

  private readPriorPid(): number | null {
    try {
      const value = Number(this.deps.readFile(this.pidPath).trim())
      return Number.isSafeInteger(value) && value > 0 ? value : null
    } catch { return null }
  }

  private renderedContent(): string {
    const lines: string[] = []
    for (const namespace of [...this.manifests.keys()].sort()) {
      const jobs = [...this.manifests.get(namespace)!.values()].sort((left, right) => left.id.localeCompare(right.id))
      for (const job of jobs) lines.push(`# ouro:${namespace}:${job.id}`, `${job.schedule} ${job.command}`)
    }
    return lines.length > 0 ? `${lines.join("\n")}\n` : ""
  }

  private render(): void {
    this.deps.durableWrite(this.crontabPath, this.renderedContent(), 0o600)
  }

  private spawnChild(): void {
    const child = this.deps.spawn(this.binaryPath, ["-split-logs", "-inotify", this.crontabPath])
    if (!child.pid || child.pid <= 0) throw new Error("Supercronic did not return a child PID")
    this.child = child
    this.deps.durableWrite(this.pidPath, `${child.pid}\n`, 0o600)
    child.once("exit", (code, signal) => {
      if (this.child !== child) return
      this.child = null
      this.deps.removeFile(this.pidPath)
      if (this.stopping) return
      if (this.restartCount >= RESTART_DELAYS_MS.length) {
        this.onFatal(new Error(`Supercronic exited repeatedly (code=${String(code)}, signal=${String(signal)})`))
        return
      }
      const delay = RESTART_DELAYS_MS[this.restartCount++]!
      this.restartTimer = this.deps.setTimer(() => { this.restartTimer = null; this.spawnChild() }, delay)
    })
  }
}
