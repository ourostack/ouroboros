import { describe, expect, it, vi } from "vitest"
import {
  BLUEBUBBLES_APP_PATH,
  BLUEBUBBLES_EXECUTABLE_PATH,
  BLUEBUBBLES_LAUNCH_AGENT_LABEL,
  blueBubblesLaunchAgentPlist,
  inspectBlueBubblesHost,
  runBlueBubblesHostAction,
  type BlueBubblesHostDeps,
} from "../../../heart/daemon/bluebubbles-host"

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
    expect(second.changed).toBe(false)
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

  it("repairs drifted plist content by reloading the native service", async () => {
    const h = harness()
    h.files.set(h.plistPath, "stale plist")
    h.setLoaded(true)

    const result = await runBlueBubblesHostAction("repair", h.deps)

    expect(result.changed).toBe(true)
    expect(h.files.get(h.plistPath)).toBe(blueBubblesLaunchAgentPlist())
    expect(h.commands.map(([verb]) => verb)).toEqual(expect.arrayContaining(["bootout", "disable", "enable", "bootstrap"]))
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
        : { ok: false, detail: "not found" },
    })

    await expect(runBlueBubblesHostAction("install", h.deps)).rejects.toThrow("launchctl bootstrap failed: bootstrap denied")
  })

  it("rejects non-macOS hosts without mutating files", async () => {
    const h = harness({ platform: "linux" })

    await expect(runBlueBubblesHostAction("install", h.deps)).rejects.toThrow("BlueBubbles host lifecycle requires macOS")
    expect(h.writes).toEqual([])
  })
})
