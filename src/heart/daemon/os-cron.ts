import * as os from "os"
import { emitNervesEvent } from "../../nerves/runtime"
import type { ScheduledTaskJob } from "./task-scheduler"

export interface OsCronManager {
  sync(jobs: ScheduledTaskJob[]): void
  removeAll(): void
  list(): string[]
}

export interface OsCronDeps {
  exec: (cmd: string) => void
  writeFile: (filePath: string, content: string) => void
  removeFile: (filePath: string) => void
  existsFile: (filePath: string) => boolean
  listDir: (dir: string) => string[]
  mkdirp: (dir: string) => void
  homeDir: string
  envPath?: string
}

export interface CrontabCronDeps {
  execOutput: (cmd: string) => string
  execWrite: (cmd: string, stdin: string) => void
}

const PLIST_PREFIX = "bot.ouro."

function plistLabel(job: ScheduledTaskJob): string {
  return `${PLIST_PREFIX}${job.agent}.${job.taskId}`
}

function cadenceToSeconds(schedule: string): number | null {
  const parts = schedule.trim().split(/\s+/)
  if (parts.length !== 5) return null

  const [minute, hour, day, month, weekday] = parts

  // Simple interval patterns only
  if (month !== "*" || weekday !== "*" || day !== "*") return null

  const everyNMinutes = /^\*\/(\d+)$/.exec(minute!)
  if (everyNMinutes && hour === "*") {
    return parseInt(everyNMinutes[1], 10) * 60
  }

  const everyNHours = /^\*\/(\d+)$/.exec(hour!)
  if (everyNHours && minute === "0") {
    return parseInt(everyNHours[1], 10) * 3600
  }

  return null
}

function scheduleToCalendarInterval(schedule: string): Record<string, number> | null {
  const parts = schedule.trim().split(/\s+/)
  if (parts.length !== 5) return null

  const [minute, hour, day, month] = parts
  const result: Record<string, number> = {}

  if (minute !== "*" && !/^\*\//.test(minute!)) result.Minute = parseInt(minute!, 10)
  if (hour !== "*" && !/^\*\//.test(hour!)) result.Hour = parseInt(hour!, 10)
  if (day !== "*") result.Day = parseInt(day!, 10)
  if (month !== "*") result.Month = parseInt(month!, 10)

  return Object.keys(result).length > 0 ? result : null
}

function generatePlistXml(job: ScheduledTaskJob, envPath?: string): string {
  const label = plistLabel(job)
  const seconds = cadenceToSeconds(job.schedule)
  const calendar = seconds === null ? scheduleToCalendarInterval(job.schedule) : null

  let triggerXml: string
  if (seconds !== null) {
    triggerXml = `  <key>StartInterval</key>\n  <integer>${seconds}</integer>`
  } else if (calendar !== null) {
    const entries = Object.entries(calendar)
      .map(([k, v]) => `      <key>${k}</key>\n      <integer>${v}</integer>`)
      .join("\n")
    triggerXml = `  <key>StartCalendarInterval</key>\n  <dict>\n${entries}\n  </dict>`
  } else {
    triggerXml = `  <key>StartInterval</key>\n  <integer>1800</integer>`
  }

  const lines = [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">`,
    `<plist version="1.0">`,
    `<dict>`,
    `  <key>Label</key>`,
    `  <string>${label}</string>`,
    `  <key>ProgramArguments</key>`,
    `  <array>`,
    `    <string>${job.command.split(" ")[0]}</string>`,
    ...job.command.split(" ").slice(1).map((arg) => `    <string>${arg}</string>`),
    `  </array>`,
    triggerXml,
  ]

  if (envPath) {
    lines.push(
      `  <key>EnvironmentVariables</key>`,
      `  <dict>`,
      `    <key>PATH</key>`,
      `    <string>${envPath}</string>`,
      `  </dict>`,
    )
  }

  lines.push(
    `  <key>StandardOutPath</key>`,
    `  <string>/tmp/${label}.stdout.log</string>`,
    `  <key>StandardErrorPath</key>`,
    `  <string>/tmp/${label}.stderr.log</string>`,
    `</dict>`,
    `</plist>`,
    ``,
  )

  return lines.join("\n")
}

export class LaunchdCronManager implements OsCronManager {
  private readonly deps: OsCronDeps

  constructor(deps: OsCronDeps) {
    this.deps = deps
  }

  private get launchAgentsDir(): string {
    return `${this.deps.homeDir}/Library/LaunchAgents`
  }

  sync(jobs: ScheduledTaskJob[]): void {
    this.deps.mkdirp(this.launchAgentsDir)

    const desiredLabels = new Set(jobs.map(plistLabel))

    // Remove stale plists
    const existing = this.listPlistFiles()
    for (const filename of existing) {
      const label = filename.replace(".plist", "")
      if (!desiredLabels.has(label)) {
        const fullPath = `${this.launchAgentsDir}/${filename}`
        try { this.deps.exec(`launchctl unload "${fullPath}"`) } catch { /* best effort */ }
        this.deps.removeFile(fullPath)
      }
    }

    // Write current plists
    for (const job of jobs) {
      const label = plistLabel(job)
      const filename = `${label}.plist`
      const fullPath = `${this.launchAgentsDir}/${filename}`
      const xml = generatePlistXml(job, this.deps.envPath)
      try { this.deps.exec(`launchctl unload "${fullPath}"`) } catch { /* best effort */ }
      this.deps.writeFile(fullPath, xml)
      try { this.deps.exec(`launchctl load "${fullPath}"`) } catch { /* best effort */ }
    }

    emitNervesEvent({ component: "daemon", event: "daemon.os_cron_synced", message: "synced OS cron entries", meta: { platform: "darwin", jobCount: jobs.length } })
  }

  removeAll(): void {
    const existing = this.listPlistFiles()
    for (const filename of existing) {
      const fullPath = `${this.launchAgentsDir}/${filename}`
      try { this.deps.exec(`launchctl unload "${fullPath}"`) } catch { /* best effort */ }
      this.deps.removeFile(fullPath)
    }
  }

  list(): string[] {
    return this.listPlistFiles().map((f) => f.replace(".plist", ""))
  }

  private listPlistFiles(): string[] {
    if (!this.deps.existsFile(this.launchAgentsDir)) return []
    return this.deps.listDir(this.launchAgentsDir).filter((f) => f.startsWith(PLIST_PREFIX) && f.endsWith(".plist"))
  }
}

const CRONTAB_MARKER_PREFIX = "# ouro:"

function crontabLine(job: ScheduledTaskJob): string {
  return `${CRONTAB_MARKER_PREFIX}${job.id}\n${job.schedule} ${job.command}`
}

export class CrontabCronManager implements OsCronManager {
  private readonly deps: CrontabCronDeps

  constructor(deps: CrontabCronDeps) {
    this.deps = deps
  }

  sync(jobs: ScheduledTaskJob[]): void {
    const currentLines = this.readCrontab()
    const cleaned = this.removeOuroLines(currentLines)
    const newLines = jobs.map(crontabLine)
    const combined = [...cleaned, ...newLines].join("\n").trim()
    this.deps.execWrite("crontab -", combined ? `${combined}\n` : "")
  }

  removeAll(): void {
    const currentLines = this.readCrontab()
    const cleaned = this.removeOuroLines(currentLines)
    const combined = cleaned.join("\n").trim()
    this.deps.execWrite("crontab -", combined ? `${combined}\n` : "")
  }

  list(): string[] {
    const lines = this.readCrontab()
    return lines
      .filter((l) => l.startsWith(CRONTAB_MARKER_PREFIX))
      .map((l) => l.slice(CRONTAB_MARKER_PREFIX.length))
  }

  private readCrontab(): string[] {
    try {
      return this.deps.execOutput("crontab -l").split("\n")
    } catch {
      return []
    }
  }

  private removeOuroLines(lines: string[]): string[] {
    const result: string[] = []
    let skipNext = false
    for (const line of lines) {
      if (line.startsWith(CRONTAB_MARKER_PREFIX)) {
        skipNext = true
        continue
      }
      if (skipNext) {
        skipNext = false
        continue
      }
      result.push(line)
    }
    return result
  }
}

export interface CreateOsCronManagerOptions {
  platform?: string
  launchdDeps?: OsCronDeps
  crontabDeps?: CrontabCronDeps
}

export function createOsCronManager(options: CreateOsCronManagerOptions = {}): OsCronManager {
  const platform = options.platform ?? process.platform
  if (platform === "darwin") {
    /* v8 ignore start -- integration: default stubs for real OS operations @preserve */
    const deps: OsCronDeps = options.launchdDeps ?? {
      exec: () => {},
      writeFile: () => {},
      removeFile: () => {},
      existsFile: () => false,
      listDir: () => [],
      mkdirp: () => {},
      homeDir: os.homedir(),
      envPath: process.env.PATH ?? "",
    }
    /* v8 ignore stop */
    return new LaunchdCronManager(deps)
  }

  const deps: CrontabCronDeps = options.crontabDeps ?? {
    execOutput: () => "",
    execWrite: () => {},
  }
  return new CrontabCronManager(deps)
}

export { cadenceToSeconds, scheduleToCalendarInterval, generatePlistXml, plistLabel, crontabLine }
