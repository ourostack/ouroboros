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

function makeJob(overrides: Partial<ScheduledTaskJob> = {}): ScheduledTaskJob {
  return {
    id: "slugger:heartbeat:cadence",
    agent: "slugger",
    taskId: "heartbeat",
    schedule: "*/30 * * * *",
    lastRun: null,
    command: "ouro poke slugger --task heartbeat",
    taskPath: "/bundles/slugger.ouro/tasks/habits/heartbeat.md",
    ...overrides,
  }
}

function makeLaunchdDeps(overrides: Partial<OsCronDeps> = {}): OsCronDeps {
  return {
    exec: vi.fn(),
    writeFile: vi.fn(),
    removeFile: vi.fn(),
    existsFile: vi.fn(() => true),
    listDir: vi.fn(() => []),
    mkdirp: vi.fn(),
    homeDir: "/Users/testuser",
    ...overrides,
  }
}

function makeCrontabDeps(overrides: Partial<CrontabCronDeps> = {}): CrontabCronDeps {
  return {
    execOutput: vi.fn(() => ""),
    execWrite: vi.fn(),
    ...overrides,
  }
}

describe("os-cron helpers", () => {
  it("cadenceToSeconds converts minute intervals", () => {
    expect(cadenceToSeconds("*/30 * * * *")).toBe(1800)
    expect(cadenceToSeconds("*/5 * * * *")).toBe(300)
  })

  it("cadenceToSeconds converts hour intervals", () => {
    expect(cadenceToSeconds("0 */2 * * *")).toBe(7200)
  })

  it("cadenceToSeconds returns null for non-interval schedules", () => {
    expect(cadenceToSeconds("30 8 15 3 *")).toBeNull()
    expect(cadenceToSeconds("bad")).toBeNull()
  })

  it("cadenceToSeconds returns null for complex schedules with day/month/weekday", () => {
    expect(cadenceToSeconds("0 0 */3 * *")).toBeNull()
  })

  it("cadenceToSeconds returns null for fixed-time schedules without interval patterns", () => {
    expect(cadenceToSeconds("30 8 * * *")).toBeNull()
  })

  it("scheduleToCalendarInterval extracts time components", () => {
    expect(scheduleToCalendarInterval("30 8 15 3 *")).toEqual({
      Minute: 30,
      Hour: 8,
      Day: 15,
      Month: 3,
    })
  })

  it("scheduleToCalendarInterval returns null for all-wildcard", () => {
    expect(scheduleToCalendarInterval("* * * * *")).toBeNull()
  })

  it("scheduleToCalendarInterval returns null for bad input", () => {
    expect(scheduleToCalendarInterval("bad")).toBeNull()
  })

  it("scheduleToCalendarInterval skips interval patterns", () => {
    expect(scheduleToCalendarInterval("*/30 * * * *")).toBeNull()
  })

  it("plistLabel generates correct label", () => {
    expect(plistLabel(makeJob())).toBe("bot.ouro.slugger.heartbeat")
  })

  it("generatePlistXml contains StartInterval for cadence schedules", () => {
    const xml = generatePlistXml(makeJob())
    expect(xml).toContain("<key>Label</key>")
    expect(xml).toContain("bot.ouro.slugger.heartbeat")
    expect(xml).toContain("<key>StartInterval</key>")
    expect(xml).toContain("<integer>1800</integer>")
    expect(xml).toContain("<string>ouro</string>")
    expect(xml).toContain("<string>poke</string>")
    expect(xml).toContain("<string>slugger</string>")
  })

  it("generatePlistXml includes PATH environment variables when provided", () => {
    const xml = generatePlistXml(makeJob(), "/opt/homebrew/bin:/usr/bin:/bin")

    expect(xml).toContain("<key>EnvironmentVariables</key>")
    expect(xml).toContain("<key>PATH</key>")
    expect(xml).toContain("<string>/opt/homebrew/bin:/usr/bin:/bin</string>")
  })

  it("generatePlistXml omits environment variables when PATH is not provided", () => {
    const xml = generatePlistXml(makeJob(), "")

    expect(xml).not.toContain("<key>EnvironmentVariables</key>")
    expect(xml).not.toContain("<key>PATH</key>")
  })

  it("generatePlistXml uses StartCalendarInterval for scheduledAt", () => {
    const xml = generatePlistXml(makeJob({ schedule: "30 8 15 3 *" }))
    expect(xml).toContain("<key>StartCalendarInterval</key>")
    expect(xml).toContain("<key>Minute</key>")
    expect(xml).toContain("<integer>30</integer>")
    expect(xml).toContain("<key>Hour</key>")
    expect(xml).toContain("<integer>8</integer>")
  })

  it("generatePlistXml falls back to 1800s interval for unparseable schedules", () => {
    const xml = generatePlistXml(makeJob({ schedule: "bad schedule" }))
    expect(xml).toContain("<key>StartInterval</key>")
    expect(xml).toContain("<integer>1800</integer>")
  })

  it("crontabLine generates marker + schedule line", () => {
    const line = crontabLine(makeJob())
    expect(line).toBe("# ouro:slugger:heartbeat:cadence\n*/30 * * * * ouro poke slugger --task heartbeat")
  })
})

describe("LaunchdCronManager", () => {
  it("sync writes plists and loads them", () => {
    const deps = makeLaunchdDeps({ envPath: "/opt/homebrew/bin:/usr/bin:/bin" } as Partial<OsCronDeps>)
    const manager = new LaunchdCronManager(deps)
    const job = makeJob()

    manager.sync([job])

    expect(deps.mkdirp).toHaveBeenCalledWith("/Users/testuser/Library/LaunchAgents")
    expect(deps.writeFile).toHaveBeenCalledWith(
      "/Users/testuser/Library/LaunchAgents/bot.ouro.slugger.heartbeat.plist",
      expect.stringContaining("<string>/opt/homebrew/bin:/usr/bin:/bin</string>"),
    )
    expect(deps.exec).toHaveBeenCalledWith(
      expect.stringContaining("launchctl load"),
    )
  })

  it("sync removes stale plists not in job list", () => {
    const deps = makeLaunchdDeps({
      listDir: vi.fn(() => ["bot.ouro.slugger.heartbeat.plist", "bot.ouro.slugger.old-task.plist"]),
    })
    const manager = new LaunchdCronManager(deps)

    manager.sync([makeJob()])

    expect(deps.removeFile).toHaveBeenCalledWith(
      "/Users/testuser/Library/LaunchAgents/bot.ouro.slugger.old-task.plist",
    )
    expect(deps.removeFile).toHaveBeenCalledTimes(1)
  })

  it("removeAll unloads and removes all ouro plists", () => {
    const deps = makeLaunchdDeps({
      listDir: vi.fn(() => ["bot.ouro.slugger.heartbeat.plist", "bot.ouro.ouroboros.task.plist"]),
    })
    const manager = new LaunchdCronManager(deps)

    manager.removeAll()

    expect(deps.exec).toHaveBeenCalledTimes(2)
    expect(deps.removeFile).toHaveBeenCalledTimes(2)
  })

  it("list returns labels of existing plists", () => {
    const deps = makeLaunchdDeps({
      listDir: vi.fn(() => ["bot.ouro.slugger.heartbeat.plist", "com.other.plist"]),
    })
    const manager = new LaunchdCronManager(deps)

    expect(manager.list()).toEqual(["bot.ouro.slugger.heartbeat"])
  })

  it("list returns empty when LaunchAgents dir missing", () => {
    const deps = makeLaunchdDeps({ existsFile: vi.fn(() => false) })
    const manager = new LaunchdCronManager(deps)

    expect(manager.list()).toEqual([])
  })

  it("sync tolerates launchctl errors", () => {
    const deps = makeLaunchdDeps({
      exec: vi.fn(() => { throw new Error("launchctl failed") }),
    })
    const manager = new LaunchdCronManager(deps)

    expect(() => manager.sync([makeJob()])).not.toThrow()
  })

  it("removeAll tolerates launchctl errors", () => {
    const deps = makeLaunchdDeps({
      listDir: vi.fn(() => ["bot.ouro.slugger.heartbeat.plist"]),
      exec: vi.fn(() => { throw new Error("launchctl failed") }),
    })
    const manager = new LaunchdCronManager(deps)

    expect(() => manager.removeAll()).not.toThrow()
  })
})

describe("CrontabCronManager", () => {
  it("sync writes job entries to crontab", () => {
    const deps = makeCrontabDeps()
    const manager = new CrontabCronManager(deps)

    manager.sync([makeJob()])

    expect(deps.execWrite).toHaveBeenCalledWith(
      "crontab -",
      expect.stringContaining("# ouro:slugger:heartbeat:cadence"),
    )
    expect(deps.execWrite).toHaveBeenCalledWith(
      "crontab -",
      expect.stringContaining("*/30 * * * * ouro poke slugger --task heartbeat"),
    )
  })

  it("sync preserves non-ouro crontab lines", () => {
    const deps = makeCrontabDeps({
      execOutput: vi.fn(() => "0 * * * * /usr/bin/backup\n"),
    })
    const manager = new CrontabCronManager(deps)

    manager.sync([makeJob()])

    const written = (deps.execWrite as ReturnType<typeof vi.fn>).mock.calls[0][1] as string
    expect(written).toContain("/usr/bin/backup")
    expect(written).toContain("# ouro:")
  })

  it("sync removes stale ouro entries", () => {
    const deps = makeCrontabDeps({
      execOutput: vi.fn(() => "# ouro:old:job:cadence\n*/5 * * * * ouro poke old --task job\n"),
    })
    const manager = new CrontabCronManager(deps)

    manager.sync([makeJob()])

    const written = (deps.execWrite as ReturnType<typeof vi.fn>).mock.calls[0][1] as string
    expect(written).not.toContain("old:job")
    expect(written).toContain("# ouro:slugger:heartbeat:cadence")
  })

  it("sync writes empty crontab when no jobs and no existing entries", () => {
    const deps = makeCrontabDeps()
    const manager = new CrontabCronManager(deps)

    manager.sync([])

    expect(deps.execWrite).toHaveBeenCalledWith("crontab -", "")
  })

  it("removeAll clears all ouro entries", () => {
    const deps = makeCrontabDeps({
      execOutput: vi.fn(() => "0 * * * * /usr/bin/backup\n# ouro:slugger:heartbeat:cadence\n*/30 * * * * ouro poke slugger --task heartbeat\n"),
    })
    const manager = new CrontabCronManager(deps)

    manager.removeAll()

    const written = (deps.execWrite as ReturnType<typeof vi.fn>).mock.calls[0][1] as string
    expect(written).toContain("/usr/bin/backup")
    expect(written).not.toContain("ouro:")
  })

  it("removeAll writes empty crontab when only ouro entries exist", () => {
    const deps = makeCrontabDeps({
      execOutput: vi.fn(() => "# ouro:slugger:heartbeat:cadence\n*/30 * * * * ouro poke slugger --task heartbeat\n"),
    })
    const manager = new CrontabCronManager(deps)

    manager.removeAll()

    expect(deps.execWrite).toHaveBeenCalledWith("crontab -", "")
  })

  it("list returns ouro job IDs", () => {
    const deps = makeCrontabDeps({
      execOutput: vi.fn(() => "# ouro:slugger:heartbeat:cadence\n*/30 * * * * ouro poke\n# ouro:ouroboros:task:scheduledAt\n0 8 * * * ouro poke\n"),
    })
    const manager = new CrontabCronManager(deps)

    expect(manager.list()).toEqual(["slugger:heartbeat:cadence", "ouroboros:task:scheduledAt"])
  })

  it("list returns empty when crontab -l fails", () => {
    const deps = makeCrontabDeps({
      execOutput: vi.fn(() => { throw new Error("no crontab for user") }),
    })
    const manager = new CrontabCronManager(deps)

    expect(manager.list()).toEqual([])
  })
})

describe("createOsCronManager", () => {
  it("uses process.platform when no platform specified", () => {
    const manager = createOsCronManager()
    // On macOS (darwin), should return LaunchdCronManager
    // On Linux, should return CrontabCronManager
    // Either way, it should be an OsCronManager instance
    expect(manager).toBeDefined()
    expect(typeof manager.sync).toBe("function")
    expect(typeof manager.removeAll).toBe("function")
    expect(typeof manager.list).toBe("function")
  })

  it("returns LaunchdCronManager for darwin", () => {
    const manager = createOsCronManager({ platform: "darwin" })
    expect(manager).toBeInstanceOf(LaunchdCronManager)
  })

  it("returns CrontabCronManager for linux", () => {
    const manager = createOsCronManager({ platform: "linux" })
    expect(manager).toBeInstanceOf(CrontabCronManager)
  })

  it("returns CrontabCronManager for unknown platforms", () => {
    const manager = createOsCronManager({ platform: "freebsd" })
    expect(manager).toBeInstanceOf(CrontabCronManager)
  })

  it("uses provided deps for darwin", () => {
    const deps = makeLaunchdDeps()
    const manager = createOsCronManager({ platform: "darwin", launchdDeps: deps })
    manager.sync([makeJob()])
    expect(deps.writeFile).toHaveBeenCalled()
  })

  it("uses provided deps for linux", () => {
    const deps = makeCrontabDeps()
    const manager = createOsCronManager({ platform: "linux", crontabDeps: deps })
    manager.sync([makeJob()])
    expect(deps.execWrite).toHaveBeenCalled()
  })

  it("uses default fallback deps for darwin when no launchdDeps provided", () => {
    const manager = createOsCronManager({ platform: "darwin" })
    expect(manager).toBeInstanceOf(LaunchdCronManager)
    // Exercise default deps: list calls existsFile (returns false), sync calls mkdirp + listDir
    expect(manager.list()).toEqual([])
    expect(() => manager.sync([makeJob()])).not.toThrow()
    expect(() => manager.removeAll()).not.toThrow()
  })

  it("uses default fallback deps for linux when no crontabDeps provided", () => {
    const manager = createOsCronManager({ platform: "linux" })
    expect(manager).toBeInstanceOf(CrontabCronManager)
    expect(manager.list()).toEqual([])
    expect(() => manager.sync([makeJob()])).not.toThrow()
    expect(() => manager.removeAll()).not.toThrow()
  })
})
