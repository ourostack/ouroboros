import { createHash } from "crypto"
import { describe, expect, it, vi } from "vitest"
import type { ScheduledTaskJob } from "../../../heart/daemon/task-scheduler"
import {
  LaunchdCronManager,
  CrontabCronManager,
  createOsCronManager,
  cadenceToSeconds,
  scheduleToCalendarInterval,
  generatePlistXml,
  plistLabel,
  crontabLine,
  type OsCronDeps,
  type CrontabCronDeps,
} from "../../../heart/daemon/os-cron"

type CommandResult = {
  status: number | null
  stdout: string
  stderr: string
  timedOut: boolean
}

type CommandCall = {
  executable: string
  argv: string[]
  options?: { stdin?: string; timeoutMs?: number }
}

const ok = (stdout = ""): CommandResult => ({ status: 0, stdout, stderr: "", timedOut: false })
const missing = (): CommandResult => ({ status: 113, stdout: "", stderr: "Could not find service", timedOut: false })
const failed = (status = 1, stderr = "failed"): CommandResult => ({ status, stdout: "", stderr, timedOut: false })

function makeJob(overrides: Partial<ScheduledTaskJob> = {}): ScheduledTaskJob {
  return {
    id: "a:heartbeat:cadence",
    agent: "a",
    taskId: "heartbeat",
    schedule: "*/30 * * * *",
    lastRun: null,
    command: '"/Applications/Ouro Bot/ouro" poke a --habit "heartbeat & calm" --trigger launchd',
    taskPath: "/Users/test/AgentBundles/a.ouro/habits/heartbeat.md",
    ...overrides,
  }
}

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("base64url")
}

function identity(consumer: string, job: ScheduledTaskJob) {
  return {
    consumer,
    agentKey: digest(job.agent),
    jobKey: digest(job.id),
  }
}

function exactOwner(consumer: string, agent: string) {
  const expectedAgentKey = digest(agent)
  return (candidate: { consumer: string; agentKey: string; jobKey: string }) =>
    candidate.consumer === consumer
    && candidate.agentKey === expectedAgentKey
    && /^[A-Za-z0-9_-]{43}$/.test(candidate.jobKey)
}

function expectedLabel(job: ScheduledTaskJob, consumer = "habit"): string {
  const registration = identity(consumer, job)
  return `bot.ouro.${registration.consumer}.${registration.agentKey}.${registration.jobKey}`
}

function expectedMarker(job: ScheduledTaskJob, consumer = "habit"): string {
  const registration = identity(consumer, job)
  return `# ouro:v1:${registration.consumer}:${registration.agentKey}:${registration.jobKey}`
}

function launchctlPrint(label: string, argv: string[], path = `/Users/test/Library/LaunchAgents/${label}.plist`): string {
  return [
    `gui/501/${label} = {`,
    `\tpath = ${path}`,
    "\ttype = LaunchAgent",
    "\tstate = not running",
    "",
    `\tprogram = ${argv[0]}`,
    "\targuments = {",
    ...argv.map((arg) => `\t\t${arg}`),
    "\t}",
    "",
    "\tdomain = gui/501 [100002]",
    "}",
  ].join("\n")
}

function legacyPlist(label: string, argv: string[]): string {
  const escaped = (value: string) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<plist version="1.0">',
    "<dict>",
    "  <key>Label</key>",
    `  <string>${escaped(label)}</string>`,
    "  <key>ProgramArguments</key>",
    "  <array>",
    ...argv.map((arg) => `    <string>${escaped(arg)}</string>`),
    "  </array>",
    "</dict>",
    "</plist>",
    "",
  ].join("\n")
}

function expectedArgv(job: ScheduledTaskJob): string[] {
  return [
    "/Applications/Ouro Bot/ouro",
    "poke",
    job.agent,
    "--habit",
    "heartbeat & calm",
    "--trigger",
    "launchd",
  ]
}

function generatedPlist(job: ScheduledTaskJob, consumer = "habit"): string {
  return (generatePlistXml as unknown as (
    value: ScheduledTaskJob,
    options: { consumer: string; envPath?: string },
  ) => string)(job, { consumer, envPath: "/opt/homebrew/bin:/usr/bin:/bin" })
}

function makeLaunchdDeps(input: {
  commandResults?: CommandResult[]
  files?: Record<string, string>
  list?: string[]
} = {}) {
  const commandResults = [...(input.commandResults ?? [])]
  const files = new Map(Object.entries(input.files ?? {}))
  const calls: CommandCall[] = []
  const exec = vi.fn((executable: string, argv: string[], options?: CommandCall["options"]): CommandResult => {
    calls.push({ executable, argv, ...(options ? { options } : {}) })
    return commandResults.shift() ?? ok()
  })
  const writeFileAtomic = vi.fn((filePath: string, content: string) => files.set(filePath, content))
  const removeFile = vi.fn((filePath: string) => files.delete(filePath))
  const deps = {
    exec,
    writeFileAtomic,
    writeFile: writeFileAtomic,
    readFile: vi.fn((filePath: string) => {
      const value = files.get(filePath)
      if (value === undefined) throw new Error(`missing file ${filePath}`)
      return value
    }),
    removeFile,
    existsFile: vi.fn((filePath: string) => filePath.endsWith("LaunchAgents") || files.has(filePath)),
    listDir: vi.fn(() => input.list ?? [...files.keys()].map((filePath) => filePath.split("/").pop()!)),
    mkdirp: vi.fn(),
    homeDir: "/Users/test",
    envPath: "/opt/homebrew/bin:/usr/bin:/bin",
    uid: 501,
  } as unknown as OsCronDeps
  return { deps, calls, files, exec, writeFileAtomic, removeFile }
}

function makeCrontabDeps(input: { reads?: Array<CommandResult>; writes?: Array<CommandResult> } = {}) {
  const reads = [...(input.reads ?? [ok("")])]
  const writes = [...(input.writes ?? [])]
  const calls: CommandCall[] = []
  const exec = vi.fn((executable: string, argv: string[], options?: CommandCall["options"]): CommandResult => {
    calls.push({ executable, argv, ...(options ? { options } : {}) })
    if (argv[0] === "-l") return reads.shift() ?? failed(91, "unexpected read")
    return writes.shift() ?? ok()
  })
  const deps = {
    exec,
    execOutput: vi.fn(() => reads.shift()?.stdout ?? ""),
    execWrite: vi.fn(),
  } as unknown as CrontabCronDeps
  return { deps, calls, exec }
}

function launchdManager(deps: OsCronDeps, consumer = "habit", agent = "a") {
  return new LaunchdCronManager(deps, {
    consumer,
    ownsRegistration: exactOwner(consumer, agent),
    uid: 501,
  } as never)
}

function crontabManager(deps: CrontabCronDeps, consumer = "habit", agent = "a") {
  return new CrontabCronManager(deps, {
    consumer,
    ownsRegistration: exactOwner(consumer, agent),
  } as never)
}

describe("OS scheduler identity and rendering", () => {
  it("derives collision-safe labels from the complete consumer, agent, and existing job ID", () => {
    const a = makeJob()
    const dotted = makeJob({ agent: "a.b", id: "a.b:heartbeat:cadence" })

    expect((plistLabel as unknown as (job: ScheduledTaskJob, consumer: string) => string)(a, "habit"))
      .toBe(expectedLabel(a))
    expect((plistLabel as unknown as (job: ScheduledTaskJob, consumer: string) => string)(dotted, "habit"))
      .toBe(expectedLabel(dotted))
    expect(expectedLabel(a)).not.toBe(expectedLabel(dotted))
  })

  it("uses an exact tuple marker instead of a human-readable or prefix-owned marker", () => {
    const job = makeJob()
    expect((crontabLine as unknown as (job: ScheduledTaskJob, consumer: string) => string)(job, "habit"))
      .toBe(`${expectedMarker(job)}\n${job.schedule} ${job.command}`)
  })

  it("renders structured quoted argv, XML escaping, and a one-minute fallback for non-exact launchd cron", () => {
    const xml = generatedPlist(makeJob())

    expect(xml).toContain(`<string>${expectedLabel(makeJob())}</string>`)
    expect(xml).toContain("<string>/Applications/Ouro Bot/ouro</string>")
    expect(xml).toContain("<string>heartbeat &amp; calm</string>")
    expect(xml).toContain("<key>StartInterval</key>\n  <integer>60</integer>")
    expect(xml).not.toContain("<integer>1800</integer>")
  })

  it("renders one exact launchd calendar dictionary when the cron expression permits it", () => {
    const xml = generatedPlist(makeJob({ schedule: "30 8 15 3 2" }))

    expect(xml).toContain("<key>StartCalendarInterval</key>")
    expect(xml).toContain("<key>Minute</key>\n      <integer>30</integer>")
    expect(xml).toContain("<key>Hour</key>\n      <integer>8</integer>")
    expect(xml).toContain("<key>Day</key>\n      <integer>15</integer>")
    expect(xml).toContain("<key>Month</key>\n      <integer>3</integer>")
    expect(xml).toContain("<key>Weekday</key>\n      <integer>2</integer>")
  })

  it("rejects shell operators instead of flattening them into launchd argv", () => {
    expect(() => generatedPlist(makeJob({ command: "ouro poke a && touch /tmp/nope" }))).toThrow(
      "scheduled command must contain argv only",
    )
  })

  it("retains helper conversions without using relative intervals as exact cron proof", () => {
    expect(cadenceToSeconds("*/30 * * * *")).toBe(1800)
    expect(cadenceToSeconds("0 */2 * * *")).toBe(7200)
    expect(cadenceToSeconds("30 8 15 3 *")).toBeNull()
    expect(cadenceToSeconds("bad")).toBeNull()
    expect(scheduleToCalendarInterval("30 8 15 3 *")).toEqual({ Minute: 30, Hour: 8, Day: 15, Month: 3 })
    expect(scheduleToCalendarInterval("* * * * *")).toBeNull()
    expect(scheduleToCalendarInterval("bad")).toBeNull()
  })
})

describe("LaunchdCronManager reconciliation", () => {
  it("returns verified proof from one matching structured launchctl print without rewriting", () => {
    const job = makeJob()
    const label = expectedLabel(job)
    const plistPath = `/Users/test/Library/LaunchAgents/${label}.plist`
    const xml = generatedPlist(job)
    const { deps, calls, writeFileAtomic } = makeLaunchdDeps({
      files: { [plistPath]: xml },
      commandResults: [ok(launchctlPrint(label, expectedArgv(job), plistPath))],
    })

    const result = launchdManager(deps).sync([job]) as any

    expect(calls).toEqual([{
      executable: "/bin/launchctl",
      argv: ["print", `gui/501/${label}`],
      options: { timeoutMs: 10_000 },
    }])
    expect(writeFileAtomic).not.toHaveBeenCalled()
    expect(result.jobs[job.id]).toMatchObject({
      jobId: job.id,
      outcome: "verified_unchanged",
      error: null,
      proof: {
        backend: "launchd",
        domain: "gui/501",
        label,
      },
    })
  })

  it("repairs a missing loaded job with atomic plist write, modern bootstrap, and post-print proof", () => {
    const job = makeJob()
    const label = expectedLabel(job)
    const plistPath = `/Users/test/Library/LaunchAgents/${label}.plist`
    const { deps, calls, writeFileAtomic } = makeLaunchdDeps({
      commandResults: [missing(), ok(), ok(launchctlPrint(label, expectedArgv(job), plistPath))],
    })

    const result = launchdManager(deps).sync([job]) as any

    expect(calls).toEqual([
      { executable: "/bin/launchctl", argv: ["print", `gui/501/${label}`], options: { timeoutMs: 10_000 } },
      { executable: "/bin/launchctl", argv: ["bootstrap", "gui/501", plistPath], options: { timeoutMs: 10_000 } },
      { executable: "/bin/launchctl", argv: ["print", `gui/501/${label}`], options: { timeoutMs: 10_000 } },
    ])
    expect(writeFileAtomic).toHaveBeenCalledWith(plistPath, generatedPlist(job))
    expect(result.jobs[job.id]).toMatchObject({ outcome: "repaired_verified", error: null })
  })

  it("repairs a changed loaded job with exact bootout, bootstrap, and second print", () => {
    const job = makeJob()
    const label = expectedLabel(job)
    const plistPath = `/Users/test/Library/LaunchAgents/${label}.plist`
    const changedPrint = launchctlPrint(label, ["/usr/bin/false"], plistPath)
    const { deps, calls } = makeLaunchdDeps({
      files: { [plistPath]: "stale plist" },
      commandResults: [ok(changedPrint), ok(), ok(), ok(launchctlPrint(label, expectedArgv(job), plistPath))],
    })

    const result = launchdManager(deps).sync([job]) as any

    expect(calls.map(({ executable, argv }) => [executable, argv])).toEqual([
      ["/bin/launchctl", ["print", `gui/501/${label}`]],
      ["/bin/launchctl", ["bootout", `gui/501/${label}`]],
      ["/bin/launchctl", ["bootstrap", "gui/501", plistPath]],
      ["/bin/launchctl", ["print", `gui/501/${label}`]],
    ])
    expect(result.jobs[job.id]).toMatchObject({ outcome: "repaired_verified", error: null })
  })

  it.each([
    ["unexpected print exit", [failed(5, "I/O error")]],
    ["print timeout", [{ status: null, stdout: "", stderr: "", timedOut: true }]],
    ["malformed print", [ok("not launchctl output")]],
    ["failed bootstrap", [missing(), failed(7, "bootstrap failed")]],
    ["failed post-print", [missing(), ok(), failed(8, "post-print failed")]],
  ])("fails closed for %s", (_name, commandResults) => {
    const job = makeJob()
    const { deps } = makeLaunchdDeps({ commandResults: commandResults as CommandResult[] })

    const result = launchdManager(deps).sync([job]) as any

    expect(result.jobs[job.id]).toMatchObject({ outcome: "failed", proof: null })
    expect(result.jobs[job.id].error).toEqual(expect.any(Object))
  })

  it("does not let overlapping agent names own or remove one another's registrations", () => {
    const job = makeJob()
    const dotted = makeJob({ agent: "a.b", id: "a.b:heartbeat:cadence" })
    const ownLabel = expectedLabel(job)
    const otherLabel = expectedLabel(dotted)
    const { deps, removeFile } = makeLaunchdDeps({
      list: [`${ownLabel}.plist`, `${otherLabel}.plist`],
      files: {
        [`/Users/test/Library/LaunchAgents/${ownLabel}.plist`]: generatedPlist(job),
        [`/Users/test/Library/LaunchAgents/${otherLabel}.plist`]: generatedPlist(dotted),
      },
      commandResults: [ok(), missing()],
    })

    launchdManager(deps).sync([])

    expect(removeFile).toHaveBeenCalledWith(`/Users/test/Library/LaunchAgents/${ownLabel}.plist`)
    expect(removeFile).not.toHaveBeenCalledWith(`/Users/test/Library/LaunchAgents/${otherLabel}.plist`)
  })

  it("migrates a legacy human-readable label only when its plist and loaded argv exactly prove the desired job", () => {
    const job = makeJob()
    const legacyLabel = `bot.ouro.${job.agent}.${job.taskId}`
    const legacyPath = `/Users/test/Library/LaunchAgents/${legacyLabel}.plist`
    const label = expectedLabel(job)
    const plistPath = `/Users/test/Library/LaunchAgents/${label}.plist`
    const { deps, calls, removeFile } = makeLaunchdDeps({
      list: [`${legacyLabel}.plist`],
      files: { [legacyPath]: legacyPlist(legacyLabel, expectedArgv(job)) },
      commandResults: [
        ok(launchctlPrint(legacyLabel, expectedArgv(job), legacyPath)),
        ok(),
        missing(),
        missing(),
        ok(),
        ok(launchctlPrint(label, expectedArgv(job), plistPath)),
      ],
    })

    const result = launchdManager(deps).sync([job]) as any

    expect(calls.map(({ argv }) => argv)).toEqual([
      ["print", `gui/501/${legacyLabel}`],
      ["bootout", `gui/501/${legacyLabel}`],
      ["print", `gui/501/${legacyLabel}`],
      ["print", `gui/501/${label}`],
      ["bootstrap", "gui/501", plistPath],
      ["print", `gui/501/${label}`],
    ])
    expect(removeFile).toHaveBeenCalledWith(legacyPath)
    expect(result.jobs[job.id]).toMatchObject({ outcome: "repaired_verified", error: null })
  })

  it("fails closed and leaves a conflicting legacy registration untouched", () => {
    const job = makeJob()
    const legacyLabel = `bot.ouro.${job.agent}.${job.taskId}`
    const legacyPath = `/Users/test/Library/LaunchAgents/${legacyLabel}.plist`
    const foreignArgv = ["/Applications/Ouro Bot/ouro", "poke", "a.b", "--habit", "heartbeat & calm", "--trigger", "launchd"]
    const { deps, removeFile } = makeLaunchdDeps({
      list: [`${legacyLabel}.plist`],
      files: { [legacyPath]: legacyPlist(legacyLabel, foreignArgv) },
    })

    const result = launchdManager(deps).sync([job]) as any

    expect(removeFile).not.toHaveBeenCalledWith(legacyPath)
    expect(result.jobs[job.id]).toMatchObject({ outcome: "failed", proof: null })
  })

  it("never treats the daemon launch agent as an owned scheduler registration", () => {
    const { deps, removeFile } = makeLaunchdDeps({ list: ["bot.ouro.daemon.plist"] })

    launchdManager(deps).removeAll()

    expect(removeFile).not.toHaveBeenCalled()
  })
})

describe("CrontabCronManager reconciliation", () => {
  it("uses only structured crontab argv and returns proof for an exact unchanged pair", () => {
    const job = makeJob()
    const bytes = `${expectedMarker(job)}\n${job.schedule} ${job.command}\n`
    const { deps, calls } = makeCrontabDeps({ reads: [ok(bytes)] })

    const result = crontabManager(deps).sync([job]) as any

    expect(calls).toEqual([{
      executable: "/usr/bin/crontab",
      argv: ["-l"],
      options: { timeoutMs: 10_000 },
    }])
    expect(result.jobs[job.id]).toMatchObject({
      jobId: job.id,
      outcome: "verified_unchanged",
      error: null,
      proof: { backend: "crontab", markerId: expectedMarker(job).slice(2) },
    })
  })

  it("preserves every unowned byte while adding one pair and proves it with a second read", () => {
    const job = makeJob()
    const original = "MAILTO=ops@example.com\n\n# human comment  \r\n0 * * * * /usr/bin/backup\n"
    const expected = `${original}${expectedMarker(job)}\n${job.schedule} ${job.command}\n`
    const { deps, calls } = makeCrontabDeps({ reads: [ok(original), ok(expected)] })

    const result = crontabManager(deps).sync([job]) as any

    expect(calls).toEqual([
      { executable: "/usr/bin/crontab", argv: ["-l"], options: { timeoutMs: 10_000 } },
      { executable: "/usr/bin/crontab", argv: ["-"], options: { stdin: expected, timeoutMs: 10_000 } },
      { executable: "/usr/bin/crontab", argv: ["-l"], options: { timeoutMs: 10_000 } },
    ])
    expect(result.jobs[job.id]).toMatchObject({ outcome: "repaired_verified", error: null })
  })

  it("replaces only the exact caller-owned pair and preserves another consumer and overlapping agent", () => {
    const job = makeJob()
    const stale = makeJob({ id: "a:stale:cadence", taskId: "stale", command: "ouro poke a --habit stale" })
    const dotted = makeJob({ agent: "a.b", id: "a.b:heartbeat:cadence" })
    const awaitJob = makeJob({ id: "a:await.vendor:cadence", taskId: "await.vendor", command: "ouro poke a --await vendor" })
    const unowned = `${expectedMarker(dotted)}\n${dotted.schedule} ${dotted.command}\n${expectedMarker(awaitJob, "await")}\n${awaitJob.schedule} ${awaitJob.command}\n`
    const original = `${expectedMarker(stale)}\n${stale.schedule} ${stale.command}\n${unowned}`
    const expected = `${unowned}${expectedMarker(job)}\n${job.schedule} ${job.command}\n`
    const { deps, calls } = makeCrontabDeps({ reads: [ok(original), ok(expected)] })

    crontabManager(deps).sync([job])

    expect(calls[1]?.options?.stdin).toBe(expected)
  })

  it.each([
    ["read failure", [failed(2, "permission denied")], []],
    ["duplicate exact marker", [ok(`${expectedMarker(makeJob())}\nentry one\n${expectedMarker(makeJob())}\nentry two\n`)], []],
    ["partial exact marker", [ok(expectedMarker(makeJob()))], []],
    ["write failure", [ok("")], [failed(3, "write failed")]],
    ["changed post-read", [ok(""), ok("changed by another writer\n")], [ok()]],
  ])("fails closed for %s", (_name, reads, writes) => {
    const job = makeJob()
    const { deps } = makeCrontabDeps({ reads: reads as CommandResult[], writes: writes as CommandResult[] })

    const result = crontabManager(deps).sync([job]) as any

    expect(result.jobs[job.id]).toMatchObject({ outcome: "failed", proof: null })
    expect(result.jobs[job.id].error).toEqual(expect.any(Object))
  })

  it("removeAll removes exact owned pairs without trimming or normalizing unowned bytes", () => {
    const job = makeJob()
    const unowned = "# keep me  \n17 4 * * * /bin/backup\n\n"
    const original = `${unowned}${expectedMarker(job)}\n${job.schedule} ${job.command}\n`
    const { deps, calls } = makeCrontabDeps({ reads: [ok(original), ok(unowned)] })

    const result = crontabManager(deps).removeAll() as any

    expect(calls[1]?.options?.stdin).toBe(unowned)
    expect(result.outcome).toBe("repaired_verified")
  })
})

describe("createOsCronManager", () => {
  it("requires explicit exact ownership for every backend", () => {
    expect(() => createOsCronManager({ platform: "darwin" })).toThrow("explicit registration ownership")
    expect(() => createOsCronManager({ platform: "linux" })).toThrow("explicit registration ownership")
  })

  it("creates only the selected backend with caller-supplied disjoint ownership", () => {
    const launchd = makeLaunchdDeps()
    const crontab = makeCrontabDeps()
    const options = { consumer: "habit", ownsRegistration: exactOwner("habit", "a"), uid: 501 }

    expect(createOsCronManager({
      platform: "darwin",
      launchdDeps: launchd.deps,
      launchdOptions: options,
    } as never)).toBeInstanceOf(LaunchdCronManager)
    expect(createOsCronManager({
      platform: "linux",
      crontabDeps: crontab.deps,
      crontabOptions: options,
    } as never)).toBeInstanceOf(CrontabCronManager)
  })
})
