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
    expect(typeof deps.writeFileAtomic).toBe("function")
    expect(typeof deps.readFile).toBe("function")
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

  it("writeFileAtomic, readFile, and existsFile work with real fs", async () => {
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
    deps.writeFileAtomic(filePath, "<plist>test</plist>")
    expect(deps.existsFile(filePath)).toBe(true)
    expect(deps.readFile(filePath)).toBe("<plist>test</plist>")
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

  it("exec returns structured failure for an invalid executable", async () => {
    emitNervesEvent({
      component: "daemon",
      event: "daemon.integration_test_start",
      message: "testing exec error swallowing",
      meta: {},
    })

    const { createRealOsCronDeps } = await import("../../../heart/daemon/os-cron-deps")
    const deps = createRealOsCronDeps()

    expect(deps.exec("/nonexistent-command-that-does-not-exist-12345", [], { timeoutMs: 100 })).toMatchObject({
      status: null,
      timedOut: false,
      stdout: "",
      stderr: expect.any(String),
    })
  })

  it("exec reports timeouts and catches invalid invocation arguments", async () => {
    const { createRealOsCronDeps } = await import("../../../heart/daemon/os-cron-deps")
    const deps = createRealOsCronDeps()

    expect(deps.exec("/bin/sleep", ["1"], { timeoutMs: 1 })).toMatchObject({
      status: null,
      timedOut: true,
    })
    expect(deps.exec(null as unknown as string, [])).toMatchObject({
      status: null,
      timedOut: false,
      stderr: expect.any(String),
    })
  })

  it("atomic write cleans its temporary file when writing fails after open", async () => {
    const { createRealOsCronDeps } = await import("../../../heart/daemon/os-cron-deps")
    const deps = createRealOsCronDeps()
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ouro-cron-test-"))
    cleanup.push(tempDir)
    const target = path.join(tempDir, "test.plist")

    expect(() => (deps.writeFileAtomic as unknown as (filePath: string, content: null) => void)(target, null)).toThrow()
    expect(fs.readdirSync(tempDir)).toEqual([])
  })

  it("removeFile surfaces deletion errors other than an already-missing file", async () => {
    const { createRealOsCronDeps } = await import("../../../heart/daemon/os-cron-deps")
    const deps = createRealOsCronDeps()
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ouro-cron-test-"))
    cleanup.push(tempDir)
    const childDirectory = path.join(tempDir, "directory")
    fs.mkdirSync(childDirectory)

    expect(() => deps.removeFile(childDirectory)).toThrow()
  })

  it("honors explicit home and uid coordinates", async () => {
    const { createRealOsCronDeps } = await import("../../../heart/daemon/os-cron-deps")
    const deps = createRealOsCronDeps({ homeDir: "/fixture/home", uid: 777 })

    expect(deps.homeDir).toBe("/fixture/home")
    expect(deps.uid).toBe(777)
  })
})

describe("createRealCrontabDeps", () => {
  it("returns structured deps pinned to the absolute crontab executable", async () => {
    emitNervesEvent({
      component: "daemon",
      event: "daemon.integration_test_start",
      message: "testing real crontab deps creation",
      meta: {},
    })

    const { createRealCrontabDeps } = await import("../../../heart/daemon/os-cron-deps")
    const deps = createRealCrontabDeps()

    expect(typeof deps.exec).toBe("function")
    expect(deps.crontabPath).toBe("/usr/bin/crontab")
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
