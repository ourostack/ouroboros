import { createHash } from "crypto"
import { describe, expect, it, vi } from "vitest"
import type { ScheduledTaskJob } from "../../../heart/daemon/task-scheduler"
import {
  CrontabCronManager,
  LaunchdCronManager,
  cadenceToSeconds,
  createOsCronManager,
  generatePlistXml,
  parseRegistrationLabel,
  registrationIdentity,
  scheduleToCalendarInterval,
  scheduledArgv,
  type CrontabCronDeps,
  type OsCommandResult,
  type OsCronDeps,
  type OsCronRegistrationIdentity,
} from "../../../heart/daemon/os-cron"

const ok = (stdout = ""): OsCommandResult => ({ status: 0, stdout, stderr: "", timedOut: false })
const missing = (): OsCommandResult => ({ status: 113, stdout: "", stderr: "Could not find service", timedOut: false })
const fail = (status = 1, stderr = "failed"): OsCommandResult => ({ status, stdout: "", stderr, timedOut: false })

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("base64url")
}

function makeJob(overrides: Partial<ScheduledTaskJob> = {}): ScheduledTaskJob {
  return {
    id: "a:heartbeat:cadence",
    agent: "a",
    taskId: "heartbeat",
    schedule: "*/30 * * * *",
    lastRun: null,
    command: '"\/opt/Ouro Bot/ouro" poke a --habit heartbeat --trigger launchd',
    taskPath: "/Users/test/AgentBundles/a.ouro/habits/heartbeat.md",
    ...overrides,
  }
}

function owner(consumer = "habit", agent = "a") {
  const agentKey = digest(agent)
  return (identity: OsCronRegistrationIdentity) =>
    identity.consumer === consumer && identity.agentKey === agentKey
}

function modernLabel(value = makeJob(), consumer = "habit"): string {
  return `bot.ouro.${consumer}.${digest(value.agent)}.${digest(value.id)}`
}

function modernMarker(value = makeJob(), consumer = "habit"): string {
  return `# ouro:v1:${consumer}:${digest(value.agent)}:${digest(value.id)}`
}

function expectedArgv(value = makeJob()): string[] {
  return scheduledArgv(value.command)
}

function printOutput(
  printedLabel: string,
  printedArgv: string[],
  domain = "gui/501",
  plistPath = `/Users/test/Library/LaunchAgents/${printedLabel}.plist`,
): string {
  return [
    `${domain}/${printedLabel} = {`,
    `\tpath = ${plistPath}`,
    `\tprogram = ${printedArgv[0]}`,
    "\targuments = {",
    ...printedArgv.map((entry) => `\t\t${entry}`),
    "\t}",
    "}",
  ].join("\n")
}

function generatedPlist(value = makeJob(), consumer = "habit"): string {
  return generatePlistXml(value, { consumer, envPath: "/usr/bin:/bin" })
}

function legacyPlist(legacyLabel: string, values: string[], includeLabel = true, includeArray = true): string {
  const escape = (value: string) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
  return [
    "<plist><dict>",
    ...(includeLabel ? ["<key>Label</key>", `<string>${escape(legacyLabel)}</string>`] : []),
    ...(includeArray
      ? ["<key>ProgramArguments</key>", "<array>", ...values.map((value) => `<string>${escape(value)}</string>`), "</array>"]
      : []),
    "</dict></plist>",
  ].join("\n")
}

function launchdFixture(input: {
  results?: OsCommandResult[]
  files?: Record<string, string>
  list?: string[]
  missingDir?: boolean
  read?: (filePath: string, stored: string | undefined) => string
  write?: (filePath: string, content: string) => void
  remove?: (filePath: string) => void
} = {}) {
  const results = [...(input.results ?? [])]
  const files = new Map(Object.entries(input.files ?? {}))
  const exec = vi.fn((_executable: string, _argv: string[]) => results.shift() ?? ok())
  const deps: OsCronDeps = {
    exec,
    writeFileAtomic: vi.fn((filePath, content) => {
      if (input.write) input.write(filePath, content)
      else files.set(filePath, content)
    }),
    readFile: vi.fn((filePath) => {
      const stored = files.get(filePath)
      if (input.read) return input.read(filePath, stored)
      if (stored === undefined) throw new Error("missing fixture file")
      return stored
    }),
    removeFile: vi.fn((filePath) => {
      if (input.remove) input.remove(filePath)
      else files.delete(filePath)
    }),
    existsFile: vi.fn((filePath) => !input.missingDir && (filePath.endsWith("LaunchAgents") || files.has(filePath))),
    listDir: vi.fn(() => input.list ?? [...files.keys()].map((filePath) => filePath.split("/").pop()!)),
    mkdirp: vi.fn(),
    homeDir: "/Users/test",
    envPath: "/usr/bin:/bin",
    uid: 501,
  }
  return { deps, exec, files }
}

function launchd(deps: OsCronDeps, consumer = "habit", agent = "a", includeUid = true) {
  return new LaunchdCronManager(deps, {
    consumer,
    ownsRegistration: owner(consumer, agent),
    ...(includeUid ? { uid: 501 } : {}),
  })
}

function crontabFixture(reads: OsCommandResult[], writes: OsCommandResult[] = []) {
  const exec = vi.fn((_executable: string, args: string[]) =>
    args[0] === "-l" ? reads.shift() ?? fail(90, "unexpected read") : writes.shift() ?? ok())
  return { deps: { exec } satisfies CrontabCronDeps, exec }
}

function crontab(deps: CrontabCronDeps, consumer = "habit", agent = "a") {
  return new CrontabCronManager(deps, { consumer, ownsRegistration: owner(consumer, agent) })
}

describe("OS cron helper edge contracts", () => {
  it("rejects invalid consumers and parses only complete modern labels", () => {
    expect(() => registrationIdentity(makeJob(), "Habit")).toThrow("scheduler consumer must be a lowercase identifier")
    expect(parseRegistrationLabel("bot.ouro.habit.short.short")).toBeNull()
    expect(parseRegistrationLabel(modernLabel())).toEqual(registrationIdentity(makeJob(), "habit"))
  })

  it.each(["", "ouro\npoke", "ouro\tpoke", "ouro $HOME", "ouro `date`", "ouro && true", "ouro # comment", "''"])(
    "rejects non-argv scheduled command %j",
    (command) => expect(() => scheduledArgv(command)).toThrow(),
  )

  it("covers non-interval and invalid calendar boundaries", () => {
    expect(cadenceToSeconds("15 8 * * *")).toBeNull()
    expect(cadenceToSeconds("15 */2 * * *")).toBeNull()
    for (const schedule of ["60 8 * * *", "0 24 * * *", "0 0 0 * *", "0 0 * 13 *", "0 0 * * 8", "x 0 * * *"]) {
      expect(scheduleToCalendarInterval(schedule)).toBeNull()
    }
  })

  it("renders XML entities, omits PATH, and orients a task path outside a bundle", () => {
    const xml = generatePlistXml(makeJob({
      id: "a:<job>&\"'",
      command: '"\/opt/Ouro & Bot/ouro" poke a --habit "<heartbeat>\'s"',
      taskPath: "/tmp/tasks/heartbeat.md",
    }), { consumer: "habit" })
    expect(xml).toContain("&lt;job&gt;&amp;&quot;&apos;")
    expect(xml).toContain("&lt;heartbeat&gt;&apos;s")
    expect(xml).toContain("<string>/tmp/tasks</string>")
    expect(xml).not.toContain("<key>EnvironmentVariables</key>")
  })

  it("uses dependency and process UID fallbacks", () => {
    const fixture = launchdFixture({ missingDir: true })
    expect(launchd(fixture.deps, "habit", "a", false).list()).toEqual([])
    expect(launchd({ ...fixture.deps, uid: undefined }, "habit", "a", false).list()).toEqual([])
  })

  it("fails fast when explicit ownership has no concrete adapter", () => {
    const options = { consumer: "habit", ownsRegistration: owner() }
    expect(() => createOsCronManager({ platform: "darwin", launchdOptions: options })).toThrow(
      "explicit launchd dependencies",
    )
    expect(() => createOsCronManager({ platform: "linux", crontabOptions: options })).toThrow(
      "explicit crontab dependencies",
    )
  })

  it("selects the current process backend when platform is omitted", () => {
    const options = { consumer: "habit", ownsRegistration: owner() }
    const launchdDeps = launchdFixture({ missingDir: true }).deps
    const crontabDeps = crontabFixture([ok("")]).deps
    const manager = createOsCronManager(process.platform === "darwin"
      ? { launchdOptions: options, launchdDeps }
      : { crontabOptions: options, crontabDeps })
    expect(manager).toBeDefined()
  })
})

describe("Launchd exhaustive reconciliation branches", () => {
  it("fails duplicate job IDs before invoking launchctl", () => {
    const fixture = launchdFixture()
    const result = launchd(fixture.deps).sync([makeJob(), makeJob({ taskId: "other" })])
    expect(result.jobs[makeJob().id].error?.code).toBe("duplicate_job_id")
    expect(fixture.exec).not.toHaveBeenCalled()
  })

  it("lists only exact owned modern registrations", () => {
    const own = modernLabel()
    const foreign = modernLabel(makeJob({ agent: "a.b", id: "a.b:heartbeat:cadence" }))
    const fixture = launchdFixture({
      list: [`${own}.plist`, `${foreign}.plist`, "bot.ouro.daemon.plist", "bot.ouro.habit.bad.plist", "notes.txt"],
    })
    expect(launchd(fixture.deps).list()).toEqual([own])
  })

  it("reports an invalid desired command without touching launchctl", () => {
    const fixture = launchdFixture()
    const invalid = makeJob({ command: "ouro && true" })
    expect(launchd(fixture.deps).sync([invalid]).jobs[invalid.id].error?.code).toBe("invalid_registration")
    expect(fixture.exec).not.toHaveBeenCalled()
  })

  it.each([
    ["label", printOutput("wrong.label", expectedArgv())],
    ["domain", printOutput(modernLabel(), expectedArgv(), "gui/999")],
  ])("fails closed on a loaded %s identity conflict", (_name, stdout) => {
    const fixture = launchdFixture({ results: [ok(stdout)] })
    expect(launchd(fixture.deps).sync([makeJob()]).jobs[makeJob().id].error?.code).toBe("launchd_ownership_conflict")
  })

  it("rejects a launchctl arguments block containing an empty argument", () => {
    const stdout = `gui/501/${modernLabel()} = {\n\targuments = {\n\n\t}\n}`
    const fixture = launchdFixture({ results: [ok(stdout)] })
    expect(launchd(fixture.deps).sync([makeJob()]).jobs[makeJob().id].error?.code).toBe("launchctl_print_malformed")
  })

  it("repairs when reading the existing plist throws", () => {
    let reads = 0
    const target = `/Users/test/Library/LaunchAgents/${modernLabel()}.plist`
    const fixture = launchdFixture({
      files: { [target]: generatedPlist() },
      results: [ok(printOutput(modernLabel(), expectedArgv())), ok(), ok(), ok(printOutput(modernLabel(), expectedArgv()))],
      read: (_path, stored) => {
        reads += 1
        if (reads === 1) throw new Error("transient read")
        return stored!
      },
    })
    expect(launchd(fixture.deps).sync([makeJob()]).jobs[makeJob().id].outcome).toBe("repaired_verified")
  })

  it("fails when changed-state bootout fails", () => {
    const target = `/Users/test/Library/LaunchAgents/${modernLabel()}.plist`
    const fixture = launchdFixture({
      files: { [target]: "stale" },
      results: [ok(printOutput(modernLabel(), ["/usr/bin/false"])), fail(4)],
    })
    expect(launchd(fixture.deps).sync([makeJob()]).jobs[makeJob().id].error?.code).toBe("launchctl_bootout_failed")
  })

  it.each([[new Error("disk full"), "disk full"], ["string failure", "string failure"]])(
    "surfaces atomic plist write failure %p",
    (thrown, message) => {
      const fixture = launchdFixture({ results: [missing()], write: () => { throw thrown } })
      expect(launchd(fixture.deps).sync([makeJob()]).jobs[makeJob().id].error).toMatchObject({
        code: "plist_write_failed",
        message,
      })
    },
  )

  it.each([
    ["malformed", "garbage"],
    ["wrong label", printOutput("wrong.label", expectedArgv())],
    ["wrong domain", printOutput(modernLabel(), expectedArgv(), "gui/999")],
    ["wrong argv", printOutput(modernLabel(), ["/usr/bin/false"])],
  ])("fails when post-repair proof is %s", (_name, stdout) => {
    const fixture = launchdFixture({ results: [missing(), ok(), ok(stdout)] })
    expect(launchd(fixture.deps).sync([makeJob()]).jobs[makeJob().id].error?.code).toBe("launchctl_post_print_mismatch")
  })

  it("fails when post-write plist bytes differ", () => {
    const fixture = launchdFixture({
      results: [missing(), ok(), ok(printOutput(modernLabel(), expectedArgv()))],
      read: () => "changed",
    })
    expect(launchd(fixture.deps).sync([makeJob()]).jobs[makeJob().id].error?.code).toBe("plist_post_write_mismatch")
  })

  it.each([new Error("read failed"), "string read failure"])("surfaces post-write read failure %p", (thrown) => {
    const fixture = launchdFixture({
      results: [missing(), ok(), ok(printOutput(modernLabel(), expectedArgv()))],
      read: () => { throw thrown },
    })
    expect(launchd(fixture.deps).sync([makeJob()]).jobs[makeJob().id].error?.code).toBe("plist_post_write_read_failed")
  })

  it("removeAll is unchanged with no owned files and verifies successful removal", () => {
    expect(launchd(launchdFixture().deps).removeAll().outcome).toBe("verified_unchanged")
    const target = `/Users/test/Library/LaunchAgents/${modernLabel()}.plist`
    const fixture = launchdFixture({ files: { [target]: generatedPlist() }, results: [ok(), missing()] })
    expect(launchd(fixture.deps).removeAll().outcome).toBe("repaired_verified")
    expect(fixture.files.has(target)).toBe(false)
  })

  it.each([
    ["bootout", [fail(4)], undefined, "launchctl_remove_failed"],
    ["verification", [ok(), ok(printOutput(modernLabel(), expectedArgv()))], undefined, "launchctl_remove_unverified"],
    ["delete Error", [ok(), missing()], new Error("delete failed"), "plist_remove_failed"],
    ["delete string", [ok(), missing()], "delete failed", "plist_remove_failed"],
  ])("fails closed on stale removal %s", (_name, results, removeFailure, code) => {
    const target = `/Users/test/Library/LaunchAgents/${modernLabel()}.plist`
    const fixture = launchdFixture({
      files: { [target]: generatedPlist() },
      results: results as OsCommandResult[],
      remove: removeFailure === undefined ? undefined : () => { throw removeFailure },
    })
    expect(launchd(fixture.deps).removeAll().error?.code).toBe(code)
  })

  it("keeps an earlier stale-removal failure when a later stale registration is removed", () => {
    const first = makeJob({ id: "a:first:cadence", taskId: "first", command: "ouro poke a --habit first" })
    const second = makeJob({ id: "a:second:cadence", taskId: "second", command: "ouro poke a --habit second" })
    const firstPath = `/Users/test/Library/LaunchAgents/${modernLabel(first)}.plist`
    const secondPath = `/Users/test/Library/LaunchAgents/${modernLabel(second)}.plist`
    const fixture = launchdFixture({
      files: { [firstPath]: generatedPlist(first), [secondPath]: generatedPlist(second) },
      results: [fail(4), ok(), missing()],
    })

    expect(launchd(fixture.deps).sync([]).removal.error?.code).toBe("launchctl_remove_failed")
  })
})

describe("Launchd legacy migration failure matrix", () => {
  function legacyFixture(input: {
    value?: ScheduledTaskJob
    xml?: string
    results?: OsCommandResult[]
    readFailure?: unknown
    removeFailure?: unknown
  } = {}) {
    const value = input.value ?? makeJob()
    const legacyLabel = `bot.ouro.${value.agent}.${value.taskId}`
    const legacyPath = `/Users/test/Library/LaunchAgents/${legacyLabel}.plist`
    const fixture = launchdFixture({
      files: { [legacyPath]: input.xml ?? legacyPlist(legacyLabel, expectedArgv(value)) },
      results: input.results,
      read: input.readFailure === undefined ? undefined : () => { throw input.readFailure },
      remove: input.removeFailure === undefined ? undefined : () => { throw input.removeFailure },
    })
    return { value, legacyLabel, fixture }
  }

  it.each([new Error("read failed"), "read failed"])("surfaces legacy plist read failure %p", (readFailure) => {
    const { value, fixture } = legacyFixture({ readFailure })
    expect(launchd(fixture.deps).sync([value]).jobs[value.id].error?.code).toBe("legacy_plist_read_failed")
  })

  it.each([
    ["missing label", (legacyLabel: string) => legacyPlist(legacyLabel, expectedArgv(), false, true)],
    ["missing array", (legacyLabel: string) => legacyPlist(legacyLabel, expectedArgv(), true, false)],
    ["empty argv", (legacyLabel: string) => legacyPlist(legacyLabel, [])],
  ])("rejects malformed legacy plist: %s", (_name, build) => {
    const base = legacyFixture()
    const { value, fixture } = legacyFixture({ xml: build(base.legacyLabel) })
    expect(launchd(fixture.deps).sync([value]).jobs[value.id].error?.code).toBe("legacy_registration_conflict")
  })

  it("migrates an exact legacy plist that is already unloaded", () => {
    const value = makeJob()
    const modernPath = `/Users/test/Library/LaunchAgents/${modernLabel(value)}.plist`
    const { fixture } = legacyFixture({
      value,
      results: [missing(), missing(), ok(), ok(printOutput(modernLabel(value), expectedArgv(value), "gui/501", modernPath))],
    })
    expect(launchd(fixture.deps).sync([value]).jobs[value.id].outcome).toBe("repaired_verified")
  })

  it.each([
    ["print failure", [fail(5)], "legacy_print_failed"],
    ["loaded malformed", [ok("garbage")], "legacy_loaded_conflict"],
    ["loaded label", [ok(printOutput("wrong.label", expectedArgv()))], "legacy_loaded_conflict"],
    ["loaded domain", [ok(printOutput("bot.ouro.a.heartbeat", expectedArgv(), "gui/999"))], "legacy_loaded_conflict"],
    ["loaded argv", [ok(printOutput("bot.ouro.a.heartbeat", ["/usr/bin/false"]))], "legacy_loaded_conflict"],
    ["bootout failure", [ok(printOutput("bot.ouro.a.heartbeat", expectedArgv())), fail(6)], "legacy_bootout_failed"],
    [
      "removal unverified",
      [ok(printOutput("bot.ouro.a.heartbeat", expectedArgv())), ok(), ok(printOutput("bot.ouro.a.heartbeat", expectedArgv()))],
      "legacy_removal_unverified",
    ],
  ])("fails closed on legacy loaded state: %s", (_name, results, code) => {
    const { value, fixture } = legacyFixture({ results: results as OsCommandResult[] })
    expect(launchd(fixture.deps).sync([value]).jobs[value.id].error?.code).toBe(code)
  })

  it.each([new Error("remove failed"), "remove failed"])("surfaces legacy plist removal failure %p", (removeFailure) => {
    const { value, fixture } = legacyFixture({ results: [missing()], removeFailure })
    expect(launchd(fixture.deps).sync([value]).jobs[value.id].error?.code).toBe("legacy_plist_remove_failed")
  })

  it.each([
    ["no poke", makeJob({ command: '"/opt/Ouro Bot/ouro" run a --habit heartbeat' })],
    ["wrong agent", makeJob({ command: '"/opt/Ouro Bot/ouro" poke a.b --habit heartbeat' })],
    ["missing flag", makeJob({ command: '"/opt/Ouro Bot/ouro" poke a heartbeat' })],
    ["wrong target", makeJob({ command: '"/opt/Ouro Bot/ouro" poke a --habit other' })],
    ["wrong bundle", makeJob({ taskPath: "/tmp/heartbeat.md" })],
  ])("rejects legacy proof with %s", (_name, value) => {
    const { fixture } = legacyFixture({ value })
    expect(launchd(fixture.deps).sync([value]).jobs[value.id].error?.code).toBe("legacy_registration_conflict")
  })

  it.each([
    ["await", makeJob({ id: "a:await.vendor:cadence", taskId: "await.vendor", command: "ouro poke a --await vendor" }), "await"],
    ["task", makeJob({ id: "a:task:cadence", taskId: "task", command: "ouro poke a --task task" }), "task"],
  ])("proves and migrates exact %s legacy argv", (_name, value, consumer) => {
    const modernPath = `/Users/test/Library/LaunchAgents/${modernLabel(value, consumer)}.plist`
    const { fixture } = legacyFixture({
      value,
      results: [missing(), missing(), ok(), ok(printOutput(modernLabel(value, consumer), expectedArgv(value), "gui/501", modernPath))],
    })
    expect(launchd(fixture.deps, consumer, "a").sync([value]).jobs[value.id].outcome).toBe("repaired_verified")
  })
})

describe("Crontab exhaustive reconciliation branches", () => {
  it("fails duplicate job IDs before reading", () => {
    const fixture = crontabFixture([])
    expect(crontab(fixture.deps).sync([makeJob(), makeJob()]).jobs[makeJob().id].error?.code).toBe("duplicate_job_id")
    expect(fixture.exec).not.toHaveBeenCalled()
  })

  it("lists exact owned registrations and returns empty on read failure", () => {
    const foreign = makeJob({ agent: "a.b", id: "a.b:heartbeat:cadence" })
    const bytes = `${modernMarker()}\nentry\n${modernMarker(foreign)}\nforeign\n# human\n`
    expect(crontab(crontabFixture([ok(bytes)]).deps).list()).toEqual([modernMarker().slice(2)])
    expect(crontab(crontabFixture([fail(2)]).deps).list()).toEqual([])
  })

  it("uses the configured executable and adds a separator to unterminated bytes", () => {
    const original = "# human"
    const expected = `${original}\n${modernMarker()}\n${makeJob().schedule} ${makeJob().command}\n`
    const reads = [ok(original), ok(expected)]
    const exec = vi.fn((_executable: string, args: string[]) => args[0] === "-l" ? reads.shift()! : ok())
    crontab({ exec, crontabPath: "/fixture/crontab" }).sync([makeJob()])
    expect(exec).toHaveBeenCalledWith("/fixture/crontab", ["-"], { stdin: expected, timeoutMs: 10_000 })
  })

  it("fails when the post-write read itself fails", () => {
    const fixture = crontabFixture([ok(""), fail(2)], [ok()])
    expect(crontab(fixture.deps).sync([makeJob()]).jobs[makeJob().id].error?.code).toBe("crontab_read_failed")
  })

  it.each([
    ["read", [fail(2)], [], "crontab_read_failed"],
    ["partial", [ok(modernMarker())], [], "crontab_partial_owned_entry"],
    ["duplicate", [ok(`${modernMarker()}\nentry\n${modernMarker()}\nentry\n`)], [], "crontab_duplicate_owned_entry"],
    ["write", [ok(`${modernMarker()}\nentry\n`)], [fail(3)], "crontab_write_failed"],
    ["verify read", [ok(`${modernMarker()}\nentry\n`), fail(2)], [ok()], "crontab_read_failed"],
    ["verify changed", [ok(`${modernMarker()}\nentry\n`), ok("changed\n")], [ok()], "crontab_post_read_changed"],
  ])("removeAll fails closed on %s", (_name, reads, writes, code) => {
    const fixture = crontabFixture(reads as OsCommandResult[], writes as OsCommandResult[])
    expect(crontab(fixture.deps).removeAll().error?.code).toBe(code)
  })

  it("removeAll is unchanged when only unowned entries exist", () => {
    expect(crontab(crontabFixture([ok("# human\n")]).deps).removeAll().outcome).toBe("verified_unchanged")
  })

  it("removes multiple distinct owned spans without reordering unowned bytes", () => {
    const second = makeJob({ id: "a:second:cadence", taskId: "second", command: "ouro poke a --habit second" })
    const original = `${modernMarker()}\nentry one\n# human\n${modernMarker(second)}\nentry two\n`
    const expected = "# human\n"
    const fixture = crontabFixture([ok(original), ok(expected)], [ok()])

    expect(crontab(fixture.deps).removeAll().outcome).toBe("repaired_verified")
  })

  it("migrates an exact legacy pair while preserving an unknown legacy pair", () => {
    const unknown = "# ouro:other:job:cadence\n0 0 * * * ouro poke other --habit job\n"
    const legacy = `# ouro:${makeJob().id}\n${makeJob().schedule} ${makeJob().command}\n`
    const expected = `${unknown}${modernMarker()}\n${makeJob().schedule} ${makeJob().command}\n`
    const fixture = crontabFixture([ok(unknown + legacy), ok(expected)], [ok()])
    expect(crontab(fixture.deps).sync([makeJob()]).jobs[makeJob().id].outcome).toBe("repaired_verified")
  })

  it("ignores unrelated legacy markers during an unchanged empty sync", () => {
    const bytes = "# ouro:other:job:cadence\nentry\n"
    expect(crontab(crontabFixture([ok(bytes)]).deps).sync([]).removal.outcome).toBe("verified_unchanged")
  })

  it("rejects conflicting legacy entry bytes", () => {
    const bytes = `# ouro:${makeJob().id}\nwrong entry\n`
    expect(crontab(crontabFixture([ok(bytes)]).deps).sync([makeJob()]).jobs[makeJob().id].error?.code).toBe(
      "legacy_crontab_conflict",
    )
  })

  it.each([
    ["invalid command", makeJob({ command: "ouro && true" }), "habit"],
    ["no poke", makeJob({ command: "ouro run a --habit heartbeat" }), "habit"],
    ["wrong agent", makeJob({ command: "ouro poke a.b --habit heartbeat" }), "habit"],
    ["missing habit flag", makeJob({ command: "ouro poke a heartbeat" }), "habit"],
    ["wrong bundle", makeJob({ taskPath: "/tmp/heartbeat.md" }), "habit"],
    ["missing await flag", makeJob({ id: "a:await.vendor:cadence", taskId: "await.vendor", command: "ouro poke a --habit vendor" }), "await"],
    ["missing task flag", makeJob({ id: "a:task:cadence", taskId: "task", command: "ouro poke a --habit task" }), "task"],
  ])("rejects legacy crontab proof with %s", (_name, value, consumer) => {
    const bytes = `# ouro:${value.id}\n${value.schedule} ${value.command}\n`
    expect(crontab(crontabFixture([ok(bytes)]).deps, consumer).sync([value]).jobs[value.id].error?.code).toBe(
      "legacy_crontab_conflict",
    )
  })

  it.each([
    ["await", makeJob({ id: "a:await.vendor:cadence", taskId: "await.vendor", command: "ouro poke a --await vendor" }), "await"],
    ["task", makeJob({ id: "a:task:cadence", taskId: "task", command: "ouro poke a --task task" }), "task"],
  ])("migrates exact %s legacy crontab proof", (_name, value, consumer) => {
    const legacy = `# ouro:${value.id}\n${value.schedule} ${value.command}\n`
    const expected = `${modernMarker(value, consumer)}\n${value.schedule} ${value.command}\n`
    const fixture = crontabFixture([ok(legacy), ok(expected)], [ok()])
    expect(crontab(fixture.deps, consumer).sync([value]).jobs[value.id].outcome).toBe("repaired_verified")
  })
})
