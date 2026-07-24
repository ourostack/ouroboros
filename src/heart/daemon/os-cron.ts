import { createHash } from "crypto"
import * as os from "os"
import * as path from "path"
import { parse as parseShellWords, type ParseEntry } from "shell-quote"
import { emitNervesEvent } from "../../nerves/runtime"
import { sha256CanonicalJson } from "../runtime/canonical-json"
import type { ScheduledTaskJob } from "./task-scheduler"

const COMMAND_TIMEOUT_MS = 10_000
const LAUNCHCTL_PATH = "/bin/launchctl"
const DEFAULT_CRONTAB_PATH = "/usr/bin/crontab"
const PLIST_PREFIX = "bot.ouro."
const DAEMON_PLIST_FILENAME = "bot.ouro.daemon.plist"
const CONSUMER = /^[a-z][a-z0-9-]{0,31}$/
const MODERN_LABEL = /^bot\.ouro\.([a-z][a-z0-9-]{0,31})\.([A-Za-z0-9_-]{43})\.([A-Za-z0-9_-]{43})$/
const MODERN_MARKER = /^# ouro:v1:([a-z][a-z0-9-]{0,31}):([A-Za-z0-9_-]{43}):([A-Za-z0-9_-]{43})$/
const LEGACY_MARKER = /^# ouro:(?!v1:)(.+)$/

export interface OsCommandResult {
  status: number | null
  stdout: string
  stderr: string
  timedOut: boolean
}

export interface OsCommandOptions {
  stdin?: string
  timeoutMs?: number
}

export interface OsCronError {
  code: string
  message: string
  meta: Record<string, string | number | boolean | null>
}

export interface OsCronRegistrationIdentity {
  consumer: string
  agentKey: string
  jobKey: string
}

export type OsCronProof =
  | {
    backend: "launchd"
    domain: string
    label: string
    expectedProgramArgumentsSha256: string
    observedProgramArgumentsSha256: string
    plistSha256: string
    scheduleRevision: string
  }
  | {
    backend: "crontab"
    markerId: string
    expectedEntrySha256: string
    observedEntrySha256: string
  }

export interface OsCronJobResult {
  jobId: string
  outcome: "verified_unchanged" | "repaired_verified" | "failed"
  proof: OsCronProof | null
  error: OsCronError | null
}

export interface OsCronRemovalResult {
  outcome: "verified_unchanged" | "repaired_verified" | "failed"
  error: OsCronError | null
}

export interface OsCronSyncResult {
  jobs: Record<string, OsCronJobResult>
  removal: OsCronRemovalResult
}

export interface OsCronManager {
  sync(jobs: ScheduledTaskJob[]): OsCronSyncResult
  removeAll(): OsCronRemovalResult
  list(): string[]
}

export interface OsCronDeps {
  exec: (executable: string, argv: string[], options?: OsCommandOptions) => OsCommandResult
  writeFileAtomic: (filePath: string, content: string) => void
  readFile: (filePath: string) => string
  removeFile: (filePath: string) => void
  existsFile: (filePath: string) => boolean
  listDir: (dir: string) => string[]
  mkdirp: (dir: string) => void
  homeDir: string
  envPath?: string
  uid?: number
}

export interface OsCronRegistrationOptions {
  consumer: string
  ownsRegistration: (identity: OsCronRegistrationIdentity) => boolean
}

export interface LaunchdCronManagerOptions extends OsCronRegistrationOptions {
  uid?: number
}

export interface CrontabCronDeps {
  exec: (executable: string, argv: string[], options?: OsCommandOptions) => OsCommandResult
  crontabPath?: string
}

export type CrontabCronManagerOptions = OsCronRegistrationOptions

function sha256Utf8(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex")
}

function schedulerKey(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("base64url")
}

function requireConsumer(consumer: string): string {
  if (!CONSUMER.test(consumer)) throw new Error("scheduler consumer must be a lowercase identifier")
  return consumer
}

function registrationIdentity(job: ScheduledTaskJob, consumer: string): OsCronRegistrationIdentity {
  return {
    consumer: requireConsumer(consumer),
    agentKey: schedulerKey(job.agent),
    jobKey: schedulerKey(job.id),
  }
}

function parseRegistrationLabel(label: string): OsCronRegistrationIdentity | null {
  const match = MODERN_LABEL.exec(label)
  if (!match) return null
  return { consumer: match[1]!, agentKey: match[2]!, jobKey: match[3]! }
}

function plistLabel(job: ScheduledTaskJob, consumer: string): string {
  const identity = registrationIdentity(job, consumer)
  return `${PLIST_PREFIX}${identity.consumer}.${identity.agentKey}.${identity.jobKey}`
}

function cadenceToSeconds(schedule: string): number | null {
  const parts = schedule.trim().split(/\s+/)
  if (parts.length !== 5) return null
  const [minute, hour, day, month, weekday] = parts
  if (month !== "*" || weekday !== "*" || day !== "*") return null
  const everyNMinutes = /^\*\/(\d+)$/.exec(minute!)
  if (everyNMinutes && hour === "*") return Number.parseInt(everyNMinutes[1]!, 10) * 60
  const everyNHours = /^\*\/(\d+)$/.exec(hour!)
  if (everyNHours && minute === "0") return Number.parseInt(everyNHours[1]!, 10) * 3600
  return null
}

function scheduleToCalendarInterval(schedule: string): Record<string, number> | null {
  const parts = schedule.trim().split(/\s+/)
  if (parts.length !== 5) return null
  const fields: Array<[string, string, number, number]> = [
    ["Minute", parts[0]!, 0, 59],
    ["Hour", parts[1]!, 0, 23],
    ["Day", parts[2]!, 1, 31],
    ["Month", parts[3]!, 1, 12],
    ["Weekday", parts[4]!, 0, 7],
  ]
  const result: Record<string, number> = {}
  for (const [key, raw, minimum, maximum] of fields) {
    if (raw === "*") continue
    if (!/^\d+$/.test(raw)) return null
    const value = Number.parseInt(raw, 10)
    if (value < minimum || value > maximum) return null
    result[key] = value
  }
  return Object.keys(result).length > 0 ? result : null
}

function scheduledArgv(command: string): string[] {
  if (command.length === 0 || /[\u0000\r\n`$]/.test(command)) {
    throw new Error("scheduled command must contain argv only")
  }
  const parsed = parseShellWords(command)
  if (parsed.length === 0 || parsed.some((entry: ParseEntry) => typeof entry !== "string")) {
    throw new Error("scheduled command must contain argv only")
  }
  const argv = parsed as string[]
  if (argv.some((entry) => entry.length === 0 || /[\u0000\r\n]/.test(entry))) {
    throw new Error("scheduled command must contain non-empty argv")
  }
  return argv
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;")
}

function bundleRootFromTaskPath(taskPath: string): string {
  const parts = path.resolve(taskPath).split(path.sep)
  const bundleIndex = parts.findIndex((part) => part.endsWith(".ouro"))
  return bundleIndex < 0 ? path.dirname(path.resolve(taskPath)) : parts.slice(0, bundleIndex + 1).join(path.sep) || path.sep
}

function generatePlistXml(
  job: ScheduledTaskJob,
  options: { consumer: string; envPath?: string },
): string {
  const identity = registrationIdentity(job, options.consumer)
  const label = plistLabel(job, options.consumer)
  const argv = scheduledArgv(job.command)
  const calendar = scheduleToCalendarInterval(job.schedule)
  const triggerXml = calendar === null
    ? "  <key>StartInterval</key>\n  <integer>60</integer>"
    : `  <key>StartCalendarInterval</key>\n  <dict>\n${Object.entries(calendar)
      .map(([key, value]) => `      <key>${key}</key>\n      <integer>${value}</integer>`)
      .join("\n")}\n  </dict>`
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    "  <key>Label</key>",
    `  <string>${escapeXml(label)}</string>`,
    "  <key>ProgramArguments</key>",
    "  <array>",
    ...argv.map((arg) => `    <string>${escapeXml(arg)}</string>`),
    "  </array>",
    triggerXml,
    "  <key>RunAtLoad</key>",
    "  <false/>",
    "  <key>OuroConsumer</key>",
    `  <string>${identity.consumer}</string>`,
    "  <key>OuroAgentKey</key>",
    `  <string>${identity.agentKey}</string>`,
    "  <key>OuroJobKey</key>",
    `  <string>${identity.jobKey}</string>`,
    "  <key>OuroJobId</key>",
    `  <string>${escapeXml(job.id)}</string>`,
    "  <key>OuroBundleRoot</key>",
    `  <string>${escapeXml(bundleRootFromTaskPath(job.taskPath))}</string>`,
    "  <key>OuroScheduleRevision</key>",
    `  <string>${sha256CanonicalJson({ schedule: job.schedule })}</string>`,
  ]
  if (options.envPath) {
    lines.push(
      "  <key>EnvironmentVariables</key>",
      "  <dict>",
      "    <key>PATH</key>",
      `    <string>${escapeXml(options.envPath)}</string>`,
      "  </dict>",
    )
  }
  lines.push(
    "  <key>StandardOutPath</key>",
    `  <string>/tmp/${label}.stdout.log</string>`,
    "  <key>StandardErrorPath</key>",
    `  <string>/tmp/${label}.stderr.log</string>`,
    "</dict>",
    "</plist>",
    "",
  )
  return lines.join("\n")
}

function decodeXml(value: string): string {
  return value
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&gt;", ">")
    .replaceAll("&lt;", "<")
    .replaceAll("&amp;", "&")
}

function parsePlistIdentity(xml: string): { label: string; argv: string[] } | null {
  const labelMatch = /<key>Label<\/key>\s*<string>([\s\S]*?)<\/string>/.exec(xml)
  const argvMatch = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(xml)
  if (!labelMatch || !argvMatch) return null
  const argv = [...argvMatch[1]!.matchAll(/<string>([\s\S]*?)<\/string>/g)].map((match) => decodeXml(match[1]!))
  if (argv.length === 0) return null
  return { label: decodeXml(labelMatch[1]!), argv }
}

function parseLaunchctlPrint(stdout: string): { domain: string; label: string; argv: string[] } | null {
  const firstLine = /^(gui\/\d+)\/([^\s]+) = \{$/m.exec(stdout)
  const argumentsMatch = /\n\targuments = \{\n([\s\S]*?)\n\t\}(?:\n|$)/.exec(stdout)
  if (!firstLine || !argumentsMatch) return null
  const argv = argumentsMatch[1]!.split("\n").map((line) => line.replace(/^\t\t/, ""))
  if (argv.length === 0 || argv.some((arg) => arg.length === 0)) return null
  return { domain: firstLine[1]!, label: firstLine[2]!, argv }
}

function argvEqual(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function cronError(code: string, message: string, meta: OsCronError["meta"] = {}): OsCronError {
  return { code, message, meta }
}

function failedJob(job: ScheduledTaskJob, error: OsCronError): OsCronJobResult {
  return { jobId: job.id, outcome: "failed", proof: null, error }
}

function missingLaunchd(result: OsCommandResult): boolean {
  return result.status === 113 || (result.status !== 0 && /could not find service|domain not found/i.test(result.stderr))
}

function commandFailed(result: OsCommandResult): boolean {
  return result.timedOut || result.status !== 0
}

function launchdProof(job: ScheduledTaskJob, label: string, argv: string[], xml: string): OsCronProof {
  const argumentsSha256 = sha256CanonicalJson(argv)
  return {
    backend: "launchd",
    domain: `gui/${process.getuid?.() ?? 0}`,
    label,
    expectedProgramArgumentsSha256: argumentsSha256,
    observedProgramArgumentsSha256: argumentsSha256,
    plistSha256: sha256Utf8(xml),
    scheduleRevision: sha256CanonicalJson({ schedule: job.schedule }),
  }
}

export class LaunchdCronManager implements OsCronManager {
  public readonly ownsRegistration: (identity: OsCronRegistrationIdentity) => boolean
  private readonly consumer: string
  private readonly uid: number

  constructor(private readonly deps: OsCronDeps, options: LaunchdCronManagerOptions) {
    this.consumer = requireConsumer(options.consumer)
    this.ownsRegistration = options.ownsRegistration
    this.uid = options.uid ?? deps.uid ?? process.getuid?.() ?? 0
  }

  private get launchAgentsDir(): string {
    return path.join(this.deps.homeDir, "Library", "LaunchAgents")
  }

  sync(jobs: ScheduledTaskJob[]): OsCronSyncResult {
    this.deps.mkdirp(this.launchAgentsDir)
    const results: Record<string, OsCronJobResult> = {}
    const duplicate = jobs.find((job, index) => jobs.findIndex((candidate) => candidate.id === job.id) !== index)
    if (duplicate) {
      const error = cronError("duplicate_job_id", "scheduler job IDs must be unique", { jobId: duplicate.id })
      for (const job of jobs) results[job.id] = failedJob(job, error)
      return { jobs: results, removal: { outcome: "failed", error } }
    }

    const desiredLabels = new Set(jobs.map((job) => plistLabel(job, this.consumer)))
    let removal: OsCronRemovalResult = { outcome: "verified_unchanged", error: null }

    for (const job of jobs) {
      const migration = this.migrateLegacy(job)
      if (migration.outcome === "failed") {
        results[job.id] = failedJob(job, migration.error!)
      } else if (migration.outcome === "repaired_verified") {
        removal = migration
      }
    }

    for (const filename of this.listModernPlistFiles()) {
      const label = filename.slice(0, -".plist".length)
      if (desiredLabels.has(label)) continue
      const removed = this.removeLoadedRegistration(label, path.join(this.launchAgentsDir, filename))
      if (removed.outcome === "failed") removal = removed
      else if (removed.outcome === "repaired_verified" && removal.outcome !== "failed") removal = removed
    }

    for (const job of jobs) {
      if (results[job.id]?.outcome === "failed") continue
      results[job.id] = this.reconcileJob(job)
    }

    emitNervesEvent({
      component: "daemon",
      event: "daemon.os_cron_synced",
      message: "reconciled launchd scheduler registrations",
      meta: {
        platform: "darwin",
        jobCount: jobs.length,
        failedCount: Object.values(results).filter((result) => result.outcome === "failed").length,
      },
    })
    return { jobs: results, removal }
  }

  removeAll(): OsCronRemovalResult {
    let result: OsCronRemovalResult = { outcome: "verified_unchanged", error: null }
    for (const filename of this.listModernPlistFiles()) {
      const label = filename.slice(0, -".plist".length)
      const removed = this.removeLoadedRegistration(label, path.join(this.launchAgentsDir, filename))
      if (removed.outcome === "failed") return removed
      result = removed
    }
    return result
  }

  list(): string[] {
    return this.listModernPlistFiles().map((filename) => filename.slice(0, -".plist".length))
  }

  private reconcileJob(job: ScheduledTaskJob): OsCronJobResult {
    let argv: string[]
    let xml: string
    try {
      argv = scheduledArgv(job.command)
      xml = generatePlistXml(job, { consumer: this.consumer, envPath: this.deps.envPath })
    } catch (error) {
      return failedJob(job, cronError("invalid_registration", error instanceof Error ? error.message : String(error)))
    }
    const label = plistLabel(job, this.consumer)
    const plistPath = path.join(this.launchAgentsDir, `${label}.plist`)
    const printed = this.print(label)
    if (printed.timedOut) return failedJob(job, cronError("launchctl_timeout", "launchctl print timed out", { label }))
    if (missingLaunchd(printed)) return this.repairJob(job, label, plistPath, argv, xml, false)
    if (printed.status !== 0) {
      return failedJob(job, cronError("launchctl_print_failed", "launchctl print failed", { label, status: printed.status }))
    }
    const observed = parseLaunchctlPrint(printed.stdout)
    if (!observed) return failedJob(job, cronError("launchctl_print_malformed", "launchctl print output was malformed", { label }))
    if (observed.label !== label || observed.domain !== `gui/${this.uid}`) {
      return failedJob(job, cronError("launchd_ownership_conflict", "loaded launchd identity conflicts with the requested registration", { label }))
    }
    let plistMatches = false
    try {
      plistMatches = this.deps.existsFile(plistPath) && this.deps.readFile(plistPath) === xml
    } catch {
      plistMatches = false
    }
    if (argvEqual(observed.argv, argv) && plistMatches) {
      return { jobId: job.id, outcome: "verified_unchanged", proof: this.proof(job, label, argv, xml), error: null }
    }
    return this.repairJob(job, label, plistPath, argv, xml, true)
  }

  private repairJob(
    job: ScheduledTaskJob,
    label: string,
    plistPath: string,
    argv: string[],
    xml: string,
    bootoutFirst: boolean,
  ): OsCronJobResult {
    if (bootoutFirst) {
      const bootout = this.runLaunchctl(["bootout", `gui/${this.uid}/${label}`])
      if (commandFailed(bootout)) {
        return failedJob(job, cronError("launchctl_bootout_failed", "launchctl bootout failed", { label, status: bootout.status }))
      }
    }
    try {
      this.deps.writeFileAtomic(plistPath, xml)
    } catch (error) {
      return failedJob(job, cronError("plist_write_failed", error instanceof Error ? error.message : String(error), { label }))
    }
    const bootstrap = this.runLaunchctl(["bootstrap", `gui/${this.uid}`, plistPath])
    if (commandFailed(bootstrap)) {
      return failedJob(job, cronError("launchctl_bootstrap_failed", "launchctl bootstrap failed", { label, status: bootstrap.status }))
    }
    const verified = this.print(label)
    if (commandFailed(verified)) {
      return failedJob(job, cronError("launchctl_post_print_failed", "launchctl post-repair print failed", { label, status: verified.status }))
    }
    const observed = parseLaunchctlPrint(verified.stdout)
    if (!observed || observed.label !== label || observed.domain !== `gui/${this.uid}` || !argvEqual(observed.argv, argv)) {
      return failedJob(job, cronError("launchctl_post_print_mismatch", "launchctl post-repair proof did not match", { label }))
    }
    try {
      if (this.deps.readFile(plistPath) !== xml) {
        return failedJob(job, cronError("plist_post_write_mismatch", "plist bytes changed after repair", { label }))
      }
    } catch (error) {
      return failedJob(job, cronError("plist_post_write_read_failed", error instanceof Error ? error.message : String(error), { label }))
    }
    return { jobId: job.id, outcome: "repaired_verified", proof: this.proof(job, label, argv, xml), error: null }
  }

  private migrateLegacy(job: ScheduledTaskJob): OsCronRemovalResult {
    const label = `${PLIST_PREFIX}${job.agent}.${job.taskId}`
    const plistPath = path.join(this.launchAgentsDir, `${label}.plist`)
    if (!this.deps.existsFile(plistPath)) return { outcome: "verified_unchanged", error: null }
    let expectedArgv: string[]
    let parsed: { label: string; argv: string[] } | null
    try {
      expectedArgv = scheduledArgv(job.command)
      parsed = parsePlistIdentity(this.deps.readFile(plistPath))
    } catch (error) {
      return { outcome: "failed", error: cronError("legacy_plist_read_failed", error instanceof Error ? error.message : String(error), { label }) }
    }
    if (!parsed || parsed.label !== label || !argvEqual(parsed.argv, expectedArgv) || !this.legacyArgvProvesJob(job, parsed.argv)) {
      return { outcome: "failed", error: cronError("legacy_registration_conflict", "legacy registration did not exactly prove the desired job", { label }) }
    }
    const printed = this.print(label)
    if (!missingLaunchd(printed)) {
      if (printed.status !== 0) {
        return { outcome: "failed", error: cronError("legacy_print_failed", "legacy launchd print failed", { label, status: printed.status }) }
      }
      const observed = parseLaunchctlPrint(printed.stdout)
      if (!observed || observed.label !== label || observed.domain !== `gui/${this.uid}` || !argvEqual(observed.argv, expectedArgv)) {
        return { outcome: "failed", error: cronError("legacy_loaded_conflict", "loaded legacy registration did not exactly match", { label }) }
      }
      const bootout = this.runLaunchctl(["bootout", `gui/${this.uid}/${label}`])
      if (commandFailed(bootout)) {
        return { outcome: "failed", error: cronError("legacy_bootout_failed", "legacy launchd bootout failed", { label, status: bootout.status }) }
      }
      if (!missingLaunchd(this.print(label))) {
        return { outcome: "failed", error: cronError("legacy_removal_unverified", "legacy launchd removal could not be verified", { label }) }
      }
    }
    try {
      this.deps.removeFile(plistPath)
    } catch (error) {
      return { outcome: "failed", error: cronError("legacy_plist_remove_failed", error instanceof Error ? error.message : String(error), { label }) }
    }
    return { outcome: "repaired_verified", error: null }
  }

  private legacyArgvProvesJob(job: ScheduledTaskJob, argv: string[]): boolean {
    const pokeIndex = argv.indexOf("poke")
    if (pokeIndex < 0 || argv[pokeIndex + 1] !== job.agent) return false
    const flag = this.consumer === "habit" ? "--habit" : this.consumer === "await" ? "--await" : "--task"
    const flagIndex = argv.indexOf(flag)
    if (flagIndex < 0) return false
    const expectedTarget = this.consumer === "await" && job.taskId.startsWith("await.") ? job.taskId.slice("await.".length) : job.taskId
    if (argv[flagIndex + 1] !== expectedTarget) return false
    const bundleRoot = bundleRootFromTaskPath(job.taskPath)
    return path.basename(bundleRoot) === `${job.agent}.ouro`
  }

  private removeLoadedRegistration(label: string, plistPath: string): OsCronRemovalResult {
    const bootout = this.runLaunchctl(["bootout", `gui/${this.uid}/${label}`])
    if (commandFailed(bootout) && !missingLaunchd(bootout)) {
      return { outcome: "failed", error: cronError("launchctl_remove_failed", "launchctl bootout failed during removal", { label, status: bootout.status }) }
    }
    if (!missingLaunchd(this.print(label))) {
      return { outcome: "failed", error: cronError("launchctl_remove_unverified", "launchd registration remained loaded after removal", { label }) }
    }
    try {
      this.deps.removeFile(plistPath)
    } catch (error) {
      return { outcome: "failed", error: cronError("plist_remove_failed", error instanceof Error ? error.message : String(error), { label }) }
    }
    return { outcome: "repaired_verified", error: null }
  }

  private proof(job: ScheduledTaskJob, label: string, argv: string[], xml: string): OsCronProof {
    const proof = launchdProof(job, label, argv, xml) as Extract<OsCronProof, { backend: "launchd" }>
    return { ...proof, domain: `gui/${this.uid}` }
  }

  private print(label: string): OsCommandResult {
    return this.runLaunchctl(["print", `gui/${this.uid}/${label}`])
  }

  private runLaunchctl(argv: string[]): OsCommandResult {
    return this.deps.exec(LAUNCHCTL_PATH, argv, { timeoutMs: COMMAND_TIMEOUT_MS })
  }

  private listModernPlistFiles(): string[] {
    if (!this.deps.existsFile(this.launchAgentsDir)) return []
    return this.deps.listDir(this.launchAgentsDir).filter((filename) => {
      if (!filename.endsWith(".plist") || filename === DAEMON_PLIST_FILENAME) return false
      const identity = parseRegistrationLabel(filename.slice(0, -".plist".length))
      return identity !== null && this.ownsRegistration(identity)
    })
  }
}

function crontabMarker(job: ScheduledTaskJob, consumer: string): string {
  const identity = registrationIdentity(job, consumer)
  return `# ouro:v1:${identity.consumer}:${identity.agentKey}:${identity.jobKey}`
}

function crontabLine(job: ScheduledTaskJob, consumer: string): string {
  return `${crontabMarker(job, consumer)}\n${job.schedule} ${job.command}`
}

interface CrontabBlock {
  start: number
  end: number
  marker: string
  entry: string | null
  identity: OsCronRegistrationIdentity | null
  legacyJobId: string | null
}

function crontabBlocks(bytes: string): CrontabBlock[] {
  const lines: Array<{ start: number; end: number; content: string }> = []
  let cursor = 0
  while (cursor < bytes.length) {
    const newline = bytes.indexOf("\n", cursor)
    const end = newline < 0 ? bytes.length : newline + 1
    const raw = bytes.slice(cursor, newline < 0 ? bytes.length : newline)
    lines.push({ start: cursor, end, content: raw.endsWith("\r") ? raw.slice(0, -1) : raw })
    cursor = end
  }
  const blocks: CrontabBlock[] = []
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!
    const modern = MODERN_MARKER.exec(line.content)
    const legacy = LEGACY_MARKER.exec(line.content)
    if (!modern && !legacy) continue
    const entry = lines[index + 1] ?? null
    blocks.push({
      start: line.start,
      end: entry?.end ?? line.end,
      marker: line.content,
      entry: entry?.content ?? null,
      identity: modern ? { consumer: modern[1]!, agentKey: modern[2]!, jobKey: modern[3]! } : null,
      legacyJobId: legacy?.[1] ?? null,
    })
    if (entry) index += 1
  }
  return blocks
}

function removeSpans(bytes: string, spans: Array<{ start: number; end: number }>): string {
  let cursor = 0
  let result = ""
  for (const span of [...spans].sort((left, right) => left.start - right.start)) {
    result += bytes.slice(cursor, span.start)
    cursor = span.end
  }
  return result + bytes.slice(cursor)
}

function appendCrontabPairs(bytes: string, pairs: string[]): string {
  if (pairs.length === 0) return bytes
  const separator = bytes.length === 0 || bytes.endsWith("\n") ? "" : "\n"
  return `${bytes}${separator}${pairs.join("\n")}\n`
}

function crontabProof(job: ScheduledTaskJob, consumer: string): OsCronProof {
  const entry = `${job.schedule} ${job.command}`
  const entrySha256 = sha256Utf8(entry)
  return {
    backend: "crontab",
    markerId: crontabMarker(job, consumer).slice(2),
    expectedEntrySha256: entrySha256,
    observedEntrySha256: entrySha256,
  }
}

export class CrontabCronManager implements OsCronManager {
  public readonly ownsRegistration: (identity: OsCronRegistrationIdentity) => boolean
  private readonly consumer: string
  private readonly crontabPath: string

  constructor(private readonly deps: CrontabCronDeps, options: CrontabCronManagerOptions) {
    this.consumer = requireConsumer(options.consumer)
    this.ownsRegistration = options.ownsRegistration
    this.crontabPath = deps.crontabPath ?? DEFAULT_CRONTAB_PATH
  }

  sync(jobs: ScheduledTaskJob[]): OsCronSyncResult {
    const duplicate = jobs.find((job, index) => jobs.findIndex((candidate) => candidate.id === job.id) !== index)
    if (duplicate) return this.globalFailure(jobs, cronError("duplicate_job_id", "scheduler job IDs must be unique", { jobId: duplicate.id }))
    const read = this.readCrontab()
    if (read.error) return this.globalFailure(jobs, read.error)
    const plan = this.plan(read.bytes, jobs)
    if (plan.error) return this.globalFailure(jobs, plan.error)
    if (plan.bytes === read.bytes) {
      const results = Object.fromEntries(jobs.map((job) => [job.id, {
        jobId: job.id,
        outcome: "verified_unchanged",
        proof: crontabProof(job, this.consumer),
        error: null,
      } satisfies OsCronJobResult]))
      return { jobs: results, removal: { outcome: "verified_unchanged", error: null } }
    }
    const written = this.deps.exec(this.crontabPath, ["-"], { stdin: plan.bytes, timeoutMs: COMMAND_TIMEOUT_MS })
    if (commandFailed(written)) {
      return this.globalFailure(jobs, cronError("crontab_write_failed", "crontab write failed", { status: written.status }))
    }
    const verified = this.readCrontab()
    if (verified.error) return this.globalFailure(jobs, verified.error)
    if (verified.bytes !== plan.bytes) {
      return this.globalFailure(jobs, cronError("crontab_post_read_changed", "crontab bytes changed after write"))
    }
    const results = Object.fromEntries(jobs.map((job) => [job.id, {
      jobId: job.id,
      outcome: "repaired_verified",
      proof: crontabProof(job, this.consumer),
      error: null,
    } satisfies OsCronJobResult]))
    emitNervesEvent({
      component: "daemon",
      event: "daemon.os_cron_synced",
      message: "reconciled crontab scheduler registrations",
      meta: { platform: "crontab", jobCount: jobs.length, failedCount: 0 },
    })
    return { jobs: results, removal: { outcome: "repaired_verified", error: null } }
  }

  removeAll(): OsCronRemovalResult {
    const read = this.readCrontab()
    if (read.error) return { outcome: "failed", error: read.error }
    const blocks = crontabBlocks(read.bytes)
    const conflict = blocks.find((block) => block.identity && this.ownsRegistration(block.identity) && block.entry === null)
    if (conflict) return { outcome: "failed", error: cronError("crontab_partial_owned_entry", "owned crontab marker has no entry") }
    const owned = blocks.filter((block) => block.identity && this.ownsRegistration(block.identity))
    if (owned.length === 0) return { outcome: "verified_unchanged", error: null }
    const expected = removeSpans(read.bytes, owned)
    const written = this.deps.exec(this.crontabPath, ["-"], { stdin: expected, timeoutMs: COMMAND_TIMEOUT_MS })
    if (commandFailed(written)) return { outcome: "failed", error: cronError("crontab_write_failed", "crontab write failed", { status: written.status }) }
    const verified = this.readCrontab()
    if (verified.error) return { outcome: "failed", error: verified.error }
    if (verified.bytes !== expected) return { outcome: "failed", error: cronError("crontab_post_read_changed", "crontab bytes changed after write") }
    return { outcome: "repaired_verified", error: null }
  }

  list(): string[] {
    const read = this.readCrontab()
    if (read.error) return []
    return crontabBlocks(read.bytes)
      .filter((block) => block.identity && this.ownsRegistration(block.identity))
      .map((block) => block.marker.slice(2))
  }

  private readCrontab(): { bytes: string; error: null } | { bytes: ""; error: OsCronError } {
    const result = this.deps.exec(this.crontabPath, ["-l"], { timeoutMs: COMMAND_TIMEOUT_MS })
    if (commandFailed(result)) {
      return { bytes: "", error: cronError("crontab_read_failed", "crontab read failed", { status: result.status, timedOut: result.timedOut }) }
    }
    return { bytes: result.stdout, error: null }
  }

  private plan(bytes: string, jobs: ScheduledTaskJob[]): { bytes: string; error: null } | { bytes: ""; error: OsCronError } {
    const blocks = crontabBlocks(bytes)
    const desired = new Map(jobs.map((job) => [job.id, job]))
    const owned = blocks.filter((block) => block.identity && this.ownsRegistration(block.identity))
    const malformedOwned = owned.find((block) => block.entry === null)
    if (malformedOwned) return { bytes: "", error: cronError("crontab_partial_owned_entry", "owned crontab marker has no entry") }
    for (const job of jobs) {
      const identity = registrationIdentity(job, this.consumer)
      const matches = owned.filter((block) => block.identity?.consumer === identity.consumer
        && block.identity.agentKey === identity.agentKey
        && block.identity.jobKey === identity.jobKey)
      if (matches.length > 1) return { bytes: "", error: cronError("crontab_duplicate_owned_entry", "owned crontab marker is duplicated", { jobId: job.id }) }
    }

    const legacyOwned: CrontabBlock[] = []
    for (const block of blocks.filter((candidate) => candidate.legacyJobId !== null)) {
      const job = desired.get(block.legacyJobId!)
      if (!job) continue
      const expectedEntry = `${job.schedule} ${job.command}`
      if (block.entry !== expectedEntry || !this.legacyEntryProvesJob(job)) {
        return { bytes: "", error: cronError("legacy_crontab_conflict", "legacy crontab entry did not exactly prove the desired job", { jobId: job.id }) }
      }
      legacyOwned.push(block)
    }

    const stripped = removeSpans(bytes, [...owned, ...legacyOwned])
    return { bytes: appendCrontabPairs(stripped, jobs.map((job) => crontabLine(job, this.consumer))), error: null }
  }

  private legacyEntryProvesJob(job: ScheduledTaskJob): boolean {
    let argv: string[]
    try {
      argv = scheduledArgv(job.command)
    } catch {
      return false
    }
    const pokeIndex = argv.indexOf("poke")
    if (pokeIndex < 0 || argv[pokeIndex + 1] !== job.agent) return false
    const flag = this.consumer === "habit" ? "--habit" : this.consumer === "await" ? "--await" : "--task"
    return argv.includes(flag) && path.basename(bundleRootFromTaskPath(job.taskPath)) === `${job.agent}.ouro`
  }

  private globalFailure(jobs: ScheduledTaskJob[], error: OsCronError): OsCronSyncResult {
    return {
      jobs: Object.fromEntries(jobs.map((job) => [job.id, failedJob(job, error)])),
      removal: { outcome: "failed", error },
    }
  }
}

export interface CreateOsCronManagerOptions {
  platform?: string
  launchdDeps?: OsCronDeps
  launchdOptions?: LaunchdCronManagerOptions
  crontabDeps?: CrontabCronDeps
  crontabOptions?: CrontabCronManagerOptions
}

export function createOsCronManager(options: CreateOsCronManagerOptions = {}): OsCronManager {
  const platform = options.platform ?? process.platform
  if (platform === "darwin") {
    if (!options.launchdOptions) throw new Error("OS cron manager requires explicit registration ownership")
    /* v8 ignore start -- no-op defaults are exercised only when no runtime adapter is wired @preserve */
    const deps = options.launchdDeps ?? {
      exec: () => ({ status: 113, stdout: "", stderr: "not configured", timedOut: false }),
      writeFileAtomic: () => {},
      readFile: () => "",
      removeFile: () => {},
      existsFile: () => false,
      listDir: () => [],
      mkdirp: () => {},
      homeDir: os.homedir(),
      envPath: process.env.PATH ?? "",
    }
    /* v8 ignore stop */
    return new LaunchdCronManager(deps, options.launchdOptions)
  }
  if (!options.crontabOptions) throw new Error("OS cron manager requires explicit registration ownership")
  /* v8 ignore start -- no-op defaults are exercised only when no runtime adapter is wired @preserve */
  const deps = options.crontabDeps ?? {
    exec: (_executable: string, argv: string[]) => argv[0] === "-l"
      ? { status: 0, stdout: "", stderr: "", timedOut: false }
      : { status: 0, stdout: "", stderr: "", timedOut: false },
  }
  /* v8 ignore stop */
  return new CrontabCronManager(deps, options.crontabOptions)
}

export {
  cadenceToSeconds,
  scheduleToCalendarInterval,
  generatePlistXml,
  plistLabel,
  crontabLine,
  crontabMarker,
  registrationIdentity,
  parseRegistrationLabel,
  scheduledArgv,
}
