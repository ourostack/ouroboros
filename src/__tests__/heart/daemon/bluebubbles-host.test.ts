import { execFileSync } from "child_process"
import { mkdtempSync, readFileSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  BLUEBUBBLES_APP_PATH,
  BLUEBUBBLES_EXECUTABLE_PATH,
  BLUEBUBBLES_LAUNCH_AGENT_LABEL,
  blueBubblesLaunchAgentPlist,
  blueBubblesLaunchAgentPath,
  createDefaultBlueBubblesHostDeps,
  inspectBlueBubblesHost,
  runBlueBubblesHostAction,
  type BlueBubblesHostDeps,
} from "../../../heart/daemon/bluebubbles-host"

vi.mock("child_process", () => ({ execFileSync: vi.fn() }))

const OFFICIAL_BLUEBUBBLES_1_9_9_PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
    <dict>
        <key>AssociatedBundleIdentifiers</key>
        <array>
            <string>com.BlueBubbles.BlueBubbles-Server</string>
        </array>
        <key>Label</key>
        <string>com.bluebubbles.server</string>
        <key>Program</key>
        <string>/Applications/BlueBubbles.app/Contents/MacOS/BlueBubbles</string>
        <key>RunAtLoad</key>
        <true/>
        <key>KeepAlive</key>
        <dict>
	        <key>SuccessfulExit</key>
	        <false/>
            <key>Crashed</key>
            <true/>
	    </dict>
    </dict>
</plist>`

afterEach(() => {
  vi.restoreAllMocks()
  vi.mocked(execFileSync).mockReset()
})

function harness(overrides: Partial<BlueBubblesHostDeps> = {}) {
  const files = new Map<string, string>([[BLUEBUBBLES_APP_PATH, "app"]])
  const writes: Array<{ path: string; content: string; mode?: number }> = []
  const commands: string[][] = []
  let loaded = false
  let processRunning = true
  let httpOk = true
  const plistPath = "/Users/test/Library/LaunchAgents/com.bluebubbles.server.plist"

  const deps: BlueBubblesHostDeps = {
    platform: "darwin",
    homeDir: "/Users/test",
    uid: 501,
    existsSync: (path) => files.has(path),
    readFileSync: (path) => {
      const value = files.get(path)
      if (value === undefined) throw new Error(`ENOENT: ${path}`)
      return value
    },
    mkdirSync: vi.fn(),
    writeFileSync: (path, content, options) => {
      files.set(path, content)
      writes.push({ path, content, mode: options?.mode })
    },
    unlinkSync: (path) => { files.delete(path) },
    launchctl: (args) => {
      commands.push(args)
      if (args[0] === "print") return { ok: loaded, detail: loaded ? "loaded" : "not found" }
      if (args[0] === "bootstrap") loaded = true
      if (args[0] === "bootout") loaded = false
      return { ok: true, detail: "ok" }
    },
    isProcessRunning: () => processRunning,
    probeHttp: async () => ({ ok: httpOk, detail: httpOk ? "reachable" : "unreachable" }),
    ...overrides,
  }

  return {
    deps,
    files,
    writes,
    commands,
    plistPath,
    setLoaded: (value: boolean) => { loaded = value },
    setProcessRunning: (value: boolean) => { processRunning = value },
    setHttpOk: (value: boolean) => { httpOk = value },
  }
}

describe("native BlueBubbles host lifecycle", () => {
  it("renders the native BlueBubbles 1.9.9 LaunchAgent contract exactly", () => {
    const plist = blueBubblesLaunchAgentPlist()

    expect(plist).toContain("<string>com.BlueBubbles.BlueBubbles-Server</string>")
    expect(plist).toContain(`<string>${BLUEBUBBLES_LAUNCH_AGENT_LABEL}</string>`)
    expect(plist).toContain(`<string>${BLUEBUBBLES_EXECUTABLE_PATH}</string>`)
    expect(plist).toMatch(/<key>RunAtLoad<\/key>\s*<true\/>/)
    expect(plist).toMatch(/<key>SuccessfulExit<\/key>\s*<false\/>/)
    expect(plist).toMatch(/<key>Crashed<\/key>\s*<true\/>/)
    expect(plist).not.toContain("ProgramArguments")
    expect(plist).not.toContain("watchdog")
    expect(plist).toBe(OFFICIAL_BLUEBUBBLES_1_9_9_PLIST)
    expect(blueBubblesLaunchAgentPlist("/custom/BlueBubbles")).toContain("<string>/custom/BlueBubbles</string>")
    expect(blueBubblesLaunchAgentPath("/Users/elsewhere")).toBe(
      "/Users/elsewhere/Library/LaunchAgents/com.bluebubbles.server.plist",
    )
  })

  it("installs and loads the native LaunchAgent idempotently for the current user", async () => {
    const h = harness()

    const first = await runBlueBubblesHostAction("install", h.deps)
    const second = await runBlueBubblesHostAction("install", h.deps)

    expect(first.changed).toBe(true)
    expect(first.state.plist).toBe("current")
    expect(first.state.service).toBe("loaded")
    expect(h.files.get(h.plistPath)).toBe(blueBubblesLaunchAgentPlist())
    expect(h.writes).toEqual([{ path: h.plistPath, content: blueBubblesLaunchAgentPlist(), mode: 0o644 }])
    expect(h.commands.filter(([verb]) => verb === "bootstrap")).toHaveLength(1)
    expect(h.commands).toContainEqual(["disable", "gui/501/com.bluebubbles.server"])
    expect(h.commands).toContainEqual(["enable", "gui/501/com.bluebubbles.server"])
    expect(h.commands).toContainEqual([
      "bootstrap",
      "gui/501",
      "/Users/test/Library/LaunchAgents/com.bluebubbles.server.plist",
    ])
    expect(second.changed).toBe(false)
  })

  it("recognizes an authentic BlueBubbles 1.9.9 plist without rewriting it", async () => {
    const h = harness()
    h.files.set(h.plistPath, OFFICIAL_BLUEBUBBLES_1_9_9_PLIST)
    h.setLoaded(true)

    const result = await runBlueBubblesHostAction("install", h.deps)

    expect(result.changed).toBe(false)
    expect(result.state.plist).toBe("current")
    expect(h.writes).toEqual([])
    expect(h.commands).toEqual([["print", "gui/501/com.bluebubbles.server"]])
  })

  it("reports process and HTTP serving evidence independently", async () => {
    const h = harness()
    h.files.set(h.plistPath, blueBubblesLaunchAgentPlist())
    h.setLoaded(true)
    h.setProcessRunning(false)
    h.setHttpOk(true)

    const state = await inspectBlueBubblesHost(h.deps)

    expect(state).toMatchObject({
      app: "present",
      plist: "current",
      service: "loaded",
      process: "not-running",
      http: { ok: true, detail: "reachable" },
    })
  })

  it("reports unreadable plist drift, absent HTTP configuration, and stopped process separately", async () => {
    const h = harness({
      readFileSync: () => { throw new Error("permission denied") },
      isProcessRunning: () => false,
      probeHttp: undefined,
    })
    h.files.set(h.plistPath, "unreadable")

    await expect(inspectBlueBubblesHost(h.deps)).resolves.toMatchObject({
      plist: "drifted",
      service: "not-loaded",
      serviceDetail: "not found",
      process: "not-running",
      http: { ok: null, detail: "HTTP health was not configured for this host inspection" },
      launchdDomain: "gui/501",
    })
  })

  it("returns status without mutation", async () => {
    const h = harness()

    const result = await runBlueBubblesHostAction("status", h.deps)

    expect(result).toMatchObject({ action: "status", changed: false })
    expect(h.writes).toEqual([])
    expect(h.commands).toEqual([["print", "gui/501/com.bluebubbles.server"]])
  })

  it("loads a current but unloaded plist without booting out an absent service", async () => {
    const h = harness()
    h.files.set(h.plistPath, blueBubblesLaunchAgentPlist())

    const result = await runBlueBubblesHostAction("repair", h.deps)

    expect(result.changed).toBe(true)
    expect(h.writes).toEqual([])
    expect(h.commands.map(([verb]) => verb)).not.toContain("bootout")
    expect(h.commands.map(([verb]) => verb)).toEqual(["print", "disable", "enable", "bootstrap", "print"])
  })

  it("repairs drifted plist content by reloading the native service", async () => {
    const h = harness()
    h.files.set(h.plistPath, "stale plist")
    h.setLoaded(true)

    const result = await runBlueBubblesHostAction("repair", h.deps)

    expect(result.changed).toBe(true)
    expect(h.files.get(h.plistPath)).toBe(blueBubblesLaunchAgentPlist())
    expect(h.commands.map(([verb]) => verb)).toEqual(expect.arrayContaining(["bootout", "disable", "enable", "bootstrap"]))
    expect(h.commands).toContainEqual(["bootout", "gui/501/com.bluebubbles.server"])
    expect(h.commands).toContainEqual(["disable", "gui/501/com.bluebubbles.server"])
    expect(h.commands).toContainEqual(["enable", "gui/501/com.bluebubbles.server"])
    expect(h.commands).toContainEqual([
      "bootstrap",
      "gui/501",
      "/Users/test/Library/LaunchAgents/com.bluebubbles.server.plist",
    ])
    expect(result.state.service).toBe("loaded")
  })

  it("removes the native LaunchAgent idempotently", async () => {
    const h = harness()
    h.files.set(h.plistPath, blueBubblesLaunchAgentPlist())
    h.setLoaded(true)

    const first = await runBlueBubblesHostAction("remove", h.deps)
    const commandCount = h.commands.length
    const second = await runBlueBubblesHostAction("remove", h.deps)

    expect(first.changed).toBe(true)
    expect(first.state.plist).toBe("missing")
    expect(first.state.service).toBe("not-loaded")
    expect(h.commands).toContainEqual(["disable", "gui/501/com.bluebubbles.server"])
    expect(h.commands).toContainEqual(["bootout", "gui/501/com.bluebubbles.server"])
    expect(second.changed).toBe(false)
    expect(h.commands).toHaveLength(commandCount + 1) // status print only
  })

  it("diagnoses an absent app and refuses installation", async () => {
    const h = harness()
    h.files.delete(BLUEBUBBLES_APP_PATH)

    await expect(runBlueBubblesHostAction("install", h.deps)).rejects.toThrow(
      `BlueBubbles app is missing at ${BLUEBUBBLES_APP_PATH}`,
    )
    await expect(inspectBlueBubblesHost(h.deps)).resolves.toMatchObject({ app: "missing" })
  })

  it("surfaces launchctl mutation failures", async () => {
    const h = harness({
      launchctl: (args) => args[0] === "bootstrap"
        ? { ok: false, detail: "bootstrap denied" }
        : args[0] === "print"
          ? { ok: false, detail: "not found" }
          : { ok: true, detail: "ok" },
    })

    await expect(runBlueBubblesHostAction("install", h.deps)).rejects.toThrow("launchctl bootstrap failed: bootstrap denied")
  })

  it.each([
    ["bootout", "repair", true, "stale plist"],
    ["disable", "repair", false, "stale plist"],
    ["enable", "repair", false, "stale plist"],
    ["disable", "remove", true, blueBubblesLaunchAgentPlist()],
    ["bootout", "remove", true, blueBubblesLaunchAgentPlist()],
  ] as const)("surfaces %s failure during %s", async (failedVerb, action, initiallyLoaded, plist) => {
    let loaded = initiallyLoaded
    const h = harness({
      launchctl: (args) => {
        if (args[0] === "print") return { ok: loaded, detail: loaded ? "loaded" : "not found" }
        if (args[0] === failedVerb) return { ok: false, detail: `${failedVerb} denied` }
        if (args[0] === "bootout") loaded = false
        if (args[0] === "bootstrap") loaded = true
        return { ok: true, detail: "ok" }
      },
    })
    h.files.set(h.plistPath, plist)

    await expect(runBlueBubblesHostAction(action, h.deps)).rejects.toThrow(
      `launchctl ${failedVerb} failed: ${failedVerb} denied`,
    )
  })

  it("preserves non-Error launchctl failures", async () => {
    const h = harness({ launchctl: () => { throw "launchctl exploded" } })

    await expect(runBlueBubblesHostAction("status", h.deps)).rejects.toBe("launchctl exploded")
  })

  it("rejects non-macOS hosts without mutating files", async () => {
    const h = harness({ platform: "linux" })

    await expect(runBlueBubblesHostAction("install", h.deps)).rejects.toThrow("BlueBubbles host lifecycle requires macOS")
    expect(h.writes).toEqual([])
  })

  it("provides working default filesystem, launchctl, process, and HTTP adapters", async () => {
    const root = mkdtempSync(join(tmpdir(), "ouro-bluebubbles-host-"))
    const file = join(root, "nested", "test.txt")
    const probeHttp = vi.fn(async () => ({ ok: true, detail: "healthy" }))
    vi.mocked(execFileSync)
      .mockReturnValueOnce("launchctl output\n" as never)
      .mockReturnValueOnce("" as never)
      .mockImplementationOnce(() => { throw new Error("launchctl denied") })
      .mockImplementationOnce(() => { throw "pgrep denied" })

    try {
      const deps = createDefaultBlueBubblesHostDeps({ probeHttp })
      expect(deps.platform).toBe(process.platform)
      expect(deps.homeDir).toBeTruthy()
      expect(deps.uid).toBe(process.getuid())
      expect(deps.existsSync(file)).toBe(false)
      deps.mkdirSync(join(root, "nested"), { recursive: true })
      deps.writeFileSync(file, "hello", { mode: 0o600 })
      expect(deps.existsSync(file)).toBe(true)
      expect(deps.readFileSync(file)).toBe("hello")
      expect(readFileSync(file, "utf8")).toBe("hello")
      expect(deps.launchctl(["print", "gui/501/com.bluebubbles.server"])).toEqual({
        ok: true,
        detail: "launchctl output",
      })
      expect(deps.isProcessRunning()).toBe(true)
      expect(deps.launchctl(["print", "missing"])).toEqual({ ok: false, detail: "launchctl denied" })
      expect(deps.isProcessRunning()).toBe(false)
      await expect(deps.probeHttp?.()).resolves.toEqual({ ok: true, detail: "healthy" })
      deps.unlinkSync(file)
      expect(deps.existsSync(file)).toBe(false)
      expect(execFileSync).toHaveBeenNthCalledWith(
        1,
        "launchctl",
        ["print", "gui/501/com.bluebubbles.server"],
        { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
      )
      expect(execFileSync).toHaveBeenNthCalledWith(
        2,
        "pgrep",
        ["-f", BLUEBUBBLES_EXECUTABLE_PATH],
        { stdio: "ignore" },
      )
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("normalizes default launchctl results and provides a bounded HTTP serving probe", async () => {
    vi.mocked(execFileSync)
      .mockReturnValueOnce("" as never)
      .mockImplementationOnce(() => { throw "launchctl unavailable" })
    const fetchImpl = vi.fn().mockResolvedValue(new Response("unauthorized", { status: 401 }))

    const deps = createDefaultBlueBubblesHostDeps({
      serverUrl: "http://127.0.0.1:4321/",
      requestTimeoutMs: 77,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })

    expect(deps.launchctl([])).toEqual({ ok: true, detail: "ok" })
    expect(deps.launchctl([])).toEqual({ ok: false, detail: "launchctl unavailable" })
    await expect(deps.probeHttp?.()).resolves.toEqual({ ok: true, detail: "HTTP server responded with 401" })
    expect(fetchImpl).toHaveBeenCalledWith("http://127.0.0.1:4321/", {
      method: "GET",
      signal: expect.any(AbortSignal),
    })
  })

  it("reports default HTTP transport failure without throwing", async () => {
    const deps = createDefaultBlueBubblesHostDeps({
      fetchImpl: vi.fn().mockRejectedValue("connection refused") as unknown as typeof fetch,
    })

    await expect(deps.probeHttp?.()).resolves.toEqual({ ok: false, detail: "connection refused" })
  })

  it("uses uid zero when the runtime does not expose getuid", () => {
    const descriptor = Object.getOwnPropertyDescriptor(process, "getuid")
    Object.defineProperty(process, "getuid", { configurable: true, value: undefined })

    try {
      expect(createDefaultBlueBubblesHostDeps().uid).toBe(0)
    } finally {
      if (descriptor) Object.defineProperty(process, "getuid", descriptor)
    }
  })
})
