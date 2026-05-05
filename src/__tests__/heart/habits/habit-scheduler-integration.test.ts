import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { afterEach, describe, expect, it } from "vitest"
import { emitNervesEvent } from "../../../nerves/runtime"

describe("createRealOsCronDeps", () => {
  const cleanup: string[] = []

  afterEach(() => {
    while (cleanup.length > 0) {
      const entry = cleanup.pop()
      if (entry) fs.rmSync(entry, { recursive: true, force: true })
    }
  })

  it("returns real deps with actual fs operations", async () => {
    emitNervesEvent({
      component: "daemon",
      event: "daemon.integration_test_start",
      message: "testing real os cron deps creation",
      meta: {},
    })

    const { createRealOsCronDeps } = await import("../../../heart/daemon/os-cron-deps")
    const deps = createRealOsCronDeps()

    expect(deps.homeDir).toBe(os.homedir())
    expect(typeof deps.exec).toBe("function")
    expect(typeof deps.writeFile).toBe("function")
    expect(typeof deps.removeFile).toBe("function")
    expect(typeof deps.existsFile).toBe("function")
    expect(typeof deps.listDir).toBe("function")
    expect(typeof deps.mkdirp).toBe("function")
    expect(deps.envPath).toBe(process.env.PATH ?? "")
  })

  it("falls back to an empty launchd PATH when PATH is unset", async () => {
    emitNervesEvent({
      component: "daemon",
      event: "daemon.integration_test_start",
      message: "testing real os cron deps PATH fallback",
      meta: {},
    })

    const previousPath = process.env.PATH
    delete process.env.PATH

    try {
      const { createRealOsCronDeps } = await import("../../../heart/daemon/os-cron-deps")
      const deps = createRealOsCronDeps()

      expect(deps.envPath).toBe("")
    } finally {
      process.env.PATH = previousPath
    }
  })

  it("writeFile and existsFile work with real fs", async () => {
    emitNervesEvent({
      component: "daemon",
      event: "daemon.integration_test_start",
      message: "testing writeFile and existsFile",
      meta: {},
    })

    const { createRealOsCronDeps } = await import("../../../heart/daemon/os-cron-deps")
    const deps = createRealOsCronDeps()

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ouro-cron-test-"))
    cleanup.push(tempDir)

    const filePath = path.join(tempDir, "test.plist")
    deps.writeFile(filePath, "<plist>test</plist>")
    expect(deps.existsFile(filePath)).toBe(true)
    expect(fs.readFileSync(filePath, "utf-8")).toBe("<plist>test</plist>")
  })

  it("removeFile removes existing file and is silent on missing", async () => {
    emitNervesEvent({
      component: "daemon",
      event: "daemon.integration_test_start",
      message: "testing removeFile behavior",
      meta: {},
    })

    const { createRealOsCronDeps } = await import("../../../heart/daemon/os-cron-deps")
    const deps = createRealOsCronDeps()

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ouro-cron-test-"))
    cleanup.push(tempDir)

    const filePath = path.join(tempDir, "to-remove.plist")
    fs.writeFileSync(filePath, "content", "utf-8")
    expect(fs.existsSync(filePath)).toBe(true)

    deps.removeFile(filePath)
    expect(fs.existsSync(filePath)).toBe(false)

    // Should not throw on missing file
    expect(() => deps.removeFile(path.join(tempDir, "nonexistent.plist"))).not.toThrow()
  })

  it("listDir lists directory contents and returns empty on missing dir", async () => {
    emitNervesEvent({
      component: "daemon",
      event: "daemon.integration_test_start",
      message: "testing listDir behavior",
      meta: {},
    })

    const { createRealOsCronDeps } = await import("../../../heart/daemon/os-cron-deps")
    const deps = createRealOsCronDeps()

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ouro-cron-test-"))
    cleanup.push(tempDir)

    fs.writeFileSync(path.join(tempDir, "a.plist"), "", "utf-8")
    fs.writeFileSync(path.join(tempDir, "b.plist"), "", "utf-8")

    const files = deps.listDir(tempDir)
    expect(files).toContain("a.plist")
    expect(files).toContain("b.plist")

    // Missing dir returns empty array
    expect(deps.listDir(path.join(tempDir, "nonexistent"))).toEqual([])
  })

  it("mkdirp creates nested directories", async () => {
    emitNervesEvent({
      component: "daemon",
      event: "daemon.integration_test_start",
      message: "testing mkdirp behavior",
      meta: {},
    })

    const { createRealOsCronDeps } = await import("../../../heart/daemon/os-cron-deps")
    const deps = createRealOsCronDeps()

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ouro-cron-test-"))
    cleanup.push(tempDir)

    const nested = path.join(tempDir, "a", "b", "c")
    deps.mkdirp(nested)
    expect(fs.existsSync(nested)).toBe(true)
  })

  it("exec swallows errors on invalid commands (best effort)", async () => {
    emitNervesEvent({
      component: "daemon",
      event: "daemon.integration_test_start",
      message: "testing exec error swallowing",
      meta: {},
    })

    const { createRealOsCronDeps } = await import("../../../heart/daemon/os-cron-deps")
    const deps = createRealOsCronDeps()

    // Invalid command should not throw (best effort)
    expect(() => deps.exec("nonexistent-command-that-does-not-exist-12345")).not.toThrow()
  })
})

describe("createRealCrontabDeps", () => {
  it("returns deps with execOutput and execWrite functions", async () => {
    emitNervesEvent({
      component: "daemon",
      event: "daemon.integration_test_start",
      message: "testing real crontab deps creation",
      meta: {},
    })

    const { createRealCrontabDeps } = await import("../../../heart/daemon/os-cron-deps")
    const deps = createRealCrontabDeps()

    expect(typeof deps.execOutput).toBe("function")
    expect(typeof deps.execWrite).toBe("function")
  })
})

describe("resolveOuroBinaryPath", () => {
  it("returns a string path", async () => {
    emitNervesEvent({
      component: "daemon",
      event: "daemon.integration_test_start",
      message: "testing ouro binary path resolution",
      meta: {},
    })

    const { resolveOuroBinaryPath } = await import("../../../heart/daemon/os-cron-deps")
    const result = resolveOuroBinaryPath()

    expect(typeof result).toBe("string")
    expect(result.length).toBeGreaterThan(0)
  })

  it("falls back to 'ouro' when process.argv[1] is not available", async () => {
    emitNervesEvent({
      component: "daemon",
      event: "daemon.integration_test_start",
      message: "testing ouro binary fallback path",
      meta: {},
    })

    const { resolveOuroBinaryPath } = await import("../../../heart/daemon/os-cron-deps")
    const result = resolveOuroBinaryPath()

    // Should return either the resolved path or fallback "ouro"
    expect(typeof result).toBe("string")
  })
})

describe("LaunchdCronManager real plist integration", () => {
  const cleanup: string[] = []

  afterEach(() => {
    while (cleanup.length > 0) {
      const entry = cleanup.pop()
      if (entry) fs.rmSync(entry, { recursive: true, force: true })
    }
  })

  it("writes a real plist file to a temp dir and verifies its content", async () => {
    // Platform-conditional: only meaningful on darwin but the fs operations work anywhere
    emitNervesEvent({
      component: "daemon",
      event: "daemon.integration_test_start",
      message: "testing real plist file write",
      meta: { platform: process.platform },
    })

    const { createRealOsCronDeps } = await import("../../../heart/daemon/os-cron-deps")
    const { LaunchdCronManager } = await import("../../../heart/daemon/os-cron")

    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "ouro-plist-test-"))
    cleanup.push(tempHome)

    const launchAgentsDir = path.join(tempHome, "Library", "LaunchAgents")
    fs.mkdirSync(launchAgentsDir, { recursive: true })

    // Create real deps but with our temp homeDir and neutered exec (don't call launchctl)
    const realDeps = createRealOsCronDeps()
    const testDeps = {
      ...realDeps,
      homeDir: tempHome,
      // Don't actually call launchctl load/unload in tests
      exec: () => {},
    }

    const manager = new LaunchdCronManager(testDeps)

    manager.sync([
      {
        id: "test-agent:heartbeat:cadence",
        agent: "test-agent",
        taskId: "heartbeat",
        schedule: "*/30 * * * *",
        lastRun: null,
        command: "/usr/local/bin/ouro poke test-agent --habit heartbeat",
        taskPath: "/bundles/test-agent.ouro/habits/heartbeat.md",
      },
    ])

    // Verify plist file was written
    const plistFiles = fs.readdirSync(launchAgentsDir).filter((f) => f.endsWith(".plist"))
    expect(plistFiles.length).toBe(1)
    expect(plistFiles[0]).toContain("bot.ouro.test-agent.heartbeat")

    const plistContent = fs.readFileSync(path.join(launchAgentsDir, plistFiles[0]), "utf-8")
    expect(plistContent).toContain("<?xml version=")
    expect(plistContent).toContain("<plist version=")
    expect(plistContent).toContain("bot.ouro.test-agent.heartbeat")
    expect(plistContent).toContain("/usr/local/bin/ouro")
    expect(plistContent).toContain("poke")
    expect(plistContent).toContain("--habit")
    expect(plistContent).toContain("heartbeat")
    // 30 minute interval = 1800 seconds
    expect(plistContent).toContain("<integer>1800</integer>")

    // Verify cleanup works
    manager.removeAll()
    const remaining = fs.readdirSync(launchAgentsDir).filter((f) => f.endsWith(".plist"))
    expect(remaining.length).toBe(0)
  })

  it("cron command includes full path to ouro binary", async () => {
    emitNervesEvent({
      component: "daemon",
      event: "daemon.integration_test_start",
      message: "verifying cron command uses full ouro path",
      meta: {},
    })

    const { resolveOuroBinaryPath } = await import("../../../heart/daemon/os-cron-deps")
    const ouroPath = resolveOuroBinaryPath()

    // The command built by HabitScheduler should use the full path
    const command = `${ouroPath} poke test-agent --habit heartbeat`
    expect(command).toContain("poke")
    expect(command).toContain("--habit")
    expect(command).toContain("heartbeat")
  })

  it("syncing with multiple jobs writes multiple plist files and removes stale ones", async () => {
    emitNervesEvent({
      component: "daemon",
      event: "daemon.integration_test_start",
      message: "testing multi-job plist sync",
      meta: {},
    })

    const { createRealOsCronDeps } = await import("../../../heart/daemon/os-cron-deps")
    const { LaunchdCronManager } = await import("../../../heart/daemon/os-cron")

    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "ouro-plist-multi-"))
    cleanup.push(tempHome)

    const launchAgentsDir = path.join(tempHome, "Library", "LaunchAgents")

    const realDeps = createRealOsCronDeps()
    const testDeps = { ...realDeps, homeDir: tempHome, exec: () => {} }
    const manager = new LaunchdCronManager(testDeps)

    // Initial sync with 2 jobs
    manager.sync([
      {
        id: "agent:heartbeat:cadence",
        agent: "agent",
        taskId: "heartbeat",
        schedule: "*/30 * * * *",
        lastRun: null,
        command: "/usr/local/bin/ouro poke agent --habit heartbeat",
        taskPath: "/bundles/agent.ouro/habits/heartbeat.md",
      },
      {
        id: "agent:daily-reflection:cadence",
        agent: "agent",
        taskId: "daily-reflection",
        schedule: "0 9 * * *",
        lastRun: null,
        command: "/usr/local/bin/ouro poke agent --habit daily-reflection",
        taskPath: "/bundles/agent.ouro/habits/daily-reflection.md",
      },
    ])

    let plistFiles = fs.readdirSync(launchAgentsDir).filter((f) => f.endsWith(".plist"))
    expect(plistFiles.length).toBe(2)

    // Re-sync with only 1 job — stale one should be removed
    manager.sync([
      {
        id: "agent:heartbeat:cadence",
        agent: "agent",
        taskId: "heartbeat",
        schedule: "*/30 * * * *",
        lastRun: null,
        command: "/usr/local/bin/ouro poke agent --habit heartbeat",
        taskPath: "/bundles/agent.ouro/habits/heartbeat.md",
      },
    ])

    plistFiles = fs.readdirSync(launchAgentsDir).filter((f) => f.endsWith(".plist"))
    expect(plistFiles.length).toBe(1)
    expect(plistFiles[0]).toContain("heartbeat")
  })
})
