import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { afterEach, describe, expect, it, vi } from "vitest"

import { configureDaemonRuntimeLogger } from "../../../heart/daemon/runtime-logging"
import { emitNervesEvent, setRuntimeLogger } from "../../../nerves/runtime"

function waitFor(predicate: () => boolean): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now()
    const timer = setInterval(() => {
      if (predicate()) {
        clearInterval(timer)
        resolve()
        return
      }
      if (Date.now() - start > 1000) {
        clearInterval(timer)
        reject(new Error("timed out"))
      }
    }, 10)
  })
}

describe("daemon runtime logging", () => {
  let tmpRoot = ""

  afterEach(() => {
    setRuntimeLogger(null)
    vi.restoreAllMocks()
    if (tmpRoot && fs.existsSync(tmpRoot)) {
      fs.rmSync(tmpRoot, { recursive: true, force: true })
    }
    tmpRoot = ""
  })

  it("uses daemon logging config to disable terminal sink", async () => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "daemon-logging-"))
    const configPath = path.join(tmpRoot, "AgentBundles", "slugger.ouro", "state", "daemon", "logging.json")
    fs.mkdirSync(path.dirname(configPath), { recursive: true })
    fs.writeFileSync(
      configPath,
      JSON.stringify({ level: "info", sinks: ["ndjson"] }, null, 2) + "\n",
      "utf-8",
    )

    const stderrChunks: string[] = []
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: any) => {
      stderrChunks.push(String(chunk))
      return true
    })
    configureDaemonRuntimeLogger("daemon", { homeDir: tmpRoot })
    emitNervesEvent({
      component: "daemon",
      event: "daemon.custom_event",
      message: "ndjson only",
      meta: {},
    })

    const logFile = path.join(tmpRoot, "AgentBundles", "slugger.ouro", "state", "daemon", "logs", "daemon.ndjson")
    await waitFor(() => fs.existsSync(logFile))
    const body = fs.readFileSync(logFile, "utf-8")
    expect(body).toContain("\"event\":\"daemon.custom_event\"")
    expect(stderrChunks.join("")).not.toContain("INFO [daemon] ndjson only")
  })

  it("uses quiet ndjson defaults for ouro when config is missing", async () => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "daemon-logging-"))

    const stderrChunks: string[] = []
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation((chunk: any) => {
      stderrChunks.push(String(chunk))
      return true
    })

    configureDaemonRuntimeLogger("ouro", { homeDir: tmpRoot })
    emitNervesEvent({
      level: "info",
      component: "daemon",
      event: "daemon.default_sink_test",
      message: "default sinks",
      meta: { ok: true },
    })

    const logFile = path.join(tmpRoot, "AgentBundles", "slugger.ouro", "state", "daemon", "logs", "ouro.ndjson")
    await waitFor(() => fs.existsSync(logFile))
    const body = fs.readFileSync(logFile, "utf-8")
    expect(body).toContain("\"event\":\"daemon.default_sink_test\"")
    expect(stderrChunks.join("")).not.toContain("INFO [daemon] default sinks")

    stderrSpy.mockRestore()
  })

  it("treats the legacy shared-default logging config as process defaults for ouro", async () => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "daemon-logging-"))
    const configPath = path.join(tmpRoot, ".agentstate", "daemon", "logging.json")
    fs.mkdirSync(path.dirname(configPath), { recursive: true })
    fs.writeFileSync(
      configPath,
      JSON.stringify({ level: "info", sinks: ["terminal", "ndjson"] }, null, 2) + "\n",
      "utf-8",
    )

    const stderrChunks: string[] = []
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: any) => {
      stderrChunks.push(String(chunk))
      return true
    })

    configureDaemonRuntimeLogger("ouro", { homeDir: tmpRoot, configPath, agentName: "slugger" })
    emitNervesEvent({
      level: "info",
      component: "daemon",
      event: "daemon.legacy_shared_default",
      message: "legacy shared default",
      meta: {},
    })

    const logFile = path.join(tmpRoot, "AgentBundles", "slugger.ouro", "state", "daemon", "logs", "ouro.ndjson")
    await waitFor(() => fs.existsSync(logFile))
    const body = fs.readFileSync(logFile, "utf-8")
    expect(body).toContain("\"event\":\"daemon.legacy_shared_default\"")
    expect(stderrChunks.join("")).not.toContain("INFO [daemon] legacy shared default")
  })

  it("falls back when logging config JSON is not an object", async () => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "daemon-logging-"))
    const configPath = path.join(tmpRoot, "AgentBundles", "slugger.ouro", "state", "daemon", "logging.json")
    fs.mkdirSync(path.dirname(configPath), { recursive: true })
    fs.writeFileSync(configPath, "42\n", "utf-8")

    const stderrChunks: string[] = []
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: any) => {
      stderrChunks.push(String(chunk))
      return true
    })

    configureDaemonRuntimeLogger("daemon", { homeDir: tmpRoot })
    emitNervesEvent({
      component: "daemon",
      event: "daemon.non_object_config",
      message: "non-object config fallback",
      meta: {},
    })

    const logFile = path.join(tmpRoot, "AgentBundles", "slugger.ouro", "state", "daemon", "logs", "daemon.ndjson")
    await waitFor(() => fs.existsSync(logFile))
    expect(fs.readFileSync(logFile, "utf-8")).toContain("\"event\":\"daemon.non_object_config\"")
    expect(stderrChunks.join("")).toContain("INFO [daemon] non-object config fallback")
  })

  it("accepts every valid level and falls back from invalid level/sink entries", async () => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "daemon-logging-"))
    const configPath = path.join(tmpRoot, "AgentBundles", "slugger.ouro", "state", "daemon", "logging.json")
    fs.mkdirSync(path.dirname(configPath), { recursive: true })

    const stderrChunks: string[] = []
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: any) => {
      stderrChunks.push(String(chunk))
      return true
    })

    for (const level of ["debug", "info", "warn", "error"] as const) {
      fs.writeFileSync(
        configPath,
        JSON.stringify({ level, sinks: ["ndjson"] }, null, 2) + "\n",
        "utf-8",
      )
      configureDaemonRuntimeLogger("daemon", { homeDir: tmpRoot, configPath })
      emitNervesEvent({
        component: "daemon",
        event: `daemon.level_${level}`,
        level,
        message: `${level} level event`,
        meta: {},
      })
    }

    fs.writeFileSync(
      configPath,
      JSON.stringify({ level: "verbose", sinks: ["unsupported"] }, null, 2) + "\n",
      "utf-8",
    )
    configureDaemonRuntimeLogger("daemon", { homeDir: tmpRoot, configPath })
    emitNervesEvent({
      component: "daemon",
      event: "daemon.invalid_entries_fallback",
      message: "invalid entries fallback",
      meta: {},
    })

    fs.writeFileSync(
      configPath,
      JSON.stringify({ level: "info", sinks: "terminal" }, null, 2) + "\n",
      "utf-8",
    )
    configureDaemonRuntimeLogger("daemon", { homeDir: tmpRoot, configPath })
    emitNervesEvent({
      component: "daemon",
      event: "daemon.non_array_sinks",
      message: "non-array sinks fallback",
      meta: {},
    })

    const logFile = path.join(tmpRoot, "AgentBundles", "slugger.ouro", "state", "daemon", "logs", "daemon.ndjson")
    await waitFor(() => fs.existsSync(logFile))
    const body = fs.readFileSync(logFile, "utf-8")
    expect(body).toContain("\"event\":\"daemon.level_debug\"")
    expect(body).toContain("\"event\":\"daemon.level_warn\"")
    expect(body).toContain("\"event\":\"daemon.level_error\"")
    expect(body).toContain("\"event\":\"daemon.invalid_entries_fallback\"")
    expect(body).toContain("\"event\":\"daemon.non_array_sinks\"")
    expect(stderrChunks.join("")).toContain("INFO [daemon] invalid entries fallback")
  })

  it("uses os.homedir when homeDir option is omitted", async () => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "daemon-logging-"))
    const configPath = path.join(tmpRoot, "custom-logging.json")
    fs.writeFileSync(
      configPath,
      JSON.stringify({ level: "info", sinks: ["terminal"] }, null, 2) + "\n",
      "utf-8",
    )

    const stderrChunks: string[] = []
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: any) => {
      stderrChunks.push(String(chunk))
      return true
    })

    configureDaemonRuntimeLogger("ouro", { configPath })
    emitNervesEvent({
      component: "daemon",
      event: "daemon.default_homedir_used",
      message: "default homedir used",
      meta: {},
    })

    expect(stderrChunks.join("")).toContain("INFO [daemon] default homedir used")
  })

  it("supports BlueBubbles runtime logging defaults and writes to a dedicated process log", async () => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "daemon-logging-"))

    const stderrChunks: string[] = []
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: any) => {
      stderrChunks.push(String(chunk))
      return true
    })

    configureDaemonRuntimeLogger("bluebubbles", { homeDir: tmpRoot })
    emitNervesEvent({
      level: "warn",
      component: "daemon",
      event: "daemon.bluebubbles_runtime_default",
      message: "bluebubbles logger default",
      meta: {},
    })

    const logFile = path.join(tmpRoot, "AgentBundles", "slugger.ouro", "state", "daemon", "logs", "bluebubbles.ndjson")
    await waitFor(() => fs.existsSync(logFile))
    expect(fs.readFileSync(logFile, "utf-8")).toContain("\"event\":\"daemon.bluebubbles_runtime_default\"")
    expect(stderrChunks.join("")).toContain("WARN [daemon] bluebubbles logger default")
  })
})
