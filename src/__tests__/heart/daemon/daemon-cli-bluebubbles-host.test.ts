import * as os from "os"
import { beforeEach, describe, expect, it, vi } from "vitest"

const hostMocks = vi.hoisted(() => ({
  createDefaultDeps: vi.fn(() => ({ platform: "darwin", homeDir: "/Users/ari", uid: 501 })),
  runAction: vi.fn(),
  installHelper: vi.fn(() => ({ changed: false, helperPath: "/Users/Shared/Ouro/bluebubbles-host" })),
  requestCrossUser: vi.fn(),
  collect: vi.fn(),
}))

vi.mock("../../../heart/daemon/bluebubbles-host", () => ({
  createDefaultBlueBubblesHostDeps: (...args: unknown[]) => hostMocks.createDefaultDeps(...args),
  runBlueBubblesHostAction: (...args: unknown[]) => hostMocks.runAction(...args),
  installBlueBubblesHostSharedHelper: (...args: unknown[]) => hostMocks.installHelper(...args),
  requestCrossUserBlueBubblesHostAction: (...args: unknown[]) => hostMocks.requestCrossUser(...args),
  collectCrossUserBlueBubblesHostAction: (...args: unknown[]) => hostMocks.collect(...args),
}))

import { parseOuroCommand, runOuroCli, type OuroCliDeps } from "../../../heart/daemon/daemon-cli"
import { setupBlueBubblesHostForConnect } from "../../../heart/daemon/cli-exec"

function deps(): OuroCliDeps {
  return {
    socketPath: "/tmp/ouro-test.sock",
    sendCommand: vi.fn().mockResolvedValue({ ok: true }),
    startDaemonProcess: vi.fn().mockResolvedValue({ pid: 1 }),
    writeStdout: vi.fn(),
    checkSocketAlive: vi.fn().mockResolvedValue(true),
    cleanupStaleSocket: vi.fn(),
    fallbackPendingMessage: vi.fn().mockReturnValue("pending"),
    homeDir: "/Users/ari",
  }
}

describe("ouro bluebubbles host CLI", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    hostMocks.runAction.mockResolvedValue({
      action: "status",
      changed: false,
      state: { app: "present", plist: "current", service: "loaded", process: "running", http: { ok: true, detail: "healthy" } },
    })
    hostMocks.requestCrossUser.mockReturnValue({
      classification: "human-required",
      requestId: `502-${"ab".repeat(32)}`,
      helperCommand: `/Users/Shared/Ouro/bluebubbles-host --request /Users/Shared/Ouro/bluebubbles-host-requests/502-${"ab".repeat(32)}.json`,
      collectCommand: `ouro bluebubbles host collect --request-id 502-${"ab".repeat(32)}`,
    })
    hostMocks.collect.mockReturnValue({ requestId: `502-${"ab".repeat(32)}`, status: "collected", detail: "launchd verified at now" })
  })

  it("parses same-user, cross-user, and collect commands", () => {
    expect(parseOuroCommand(["bluebubbles", "host", "status", "--json"])).toEqual({
      kind: "bluebubbles.host",
      action: "status",
      json: true,
    })
    expect(parseOuroCommand([
      "bluebubbles", "host", "repair",
      "--username", "clawdbot", "--uid", "502", "--home", "/Users/clawdbot",
    ])).toEqual({
      kind: "bluebubbles.host",
      action: "repair",
      target: { username: "clawdbot", uid: 502, homeDir: "/Users/clawdbot" },
    })
    const requestId = `502-${"ab".repeat(32)}`
    expect(parseOuroCommand(["bluebubbles", "host", "collect", "--request-id", requestId, "--json"])).toEqual({
      kind: "bluebubbles.host.collect",
      requestId,
      json: true,
    })
    expect(parseOuroCommand(["bluebubbles", "host", "collect", "--request-id", requestId])).toEqual({
      kind: "bluebubbles.host.collect",
      requestId,
    })
  })

  it.each(["install", "status", "repair", "remove"] as const)("parses the %s lifecycle action", (action) => {
    expect(parseOuroCommand(["bluebubbles", "host", action])).toEqual({
      kind: "bluebubbles.host",
      action,
    })
  })

  it("advertises every standard host lifecycle and handoff command", async () => {
    const output = await runOuroCli(["help", "bluebubbles"], deps())
    expect(output).toContain("bluebubbles host <install|status|repair|remove|collect>")
    expect(output).toContain("--username <name> --uid <uid> --home <path>")
    expect(output).toContain("--request-id <id>")
  })

  it("rejects incomplete or invalid host command arguments", () => {
    expect(() => parseOuroCommand(["bluebubbles", "host", "explode"])).toThrow("install|status|repair|remove|collect")
    expect(() => parseOuroCommand(["bluebubbles", "host", "install", "--username", "clawdbot"])).toThrow("--username, --uid, and --home")
    expect(() => parseOuroCommand(["bluebubbles", "host", "install", "--uid", "not-a-number"])).toThrow("--uid")
    expect(() => parseOuroCommand(["bluebubbles", "host", "collect"])).toThrow("--request-id")
    expect(() => parseOuroCommand(["bluebubbles", "host", "collect", "--request-id", "request", "--wat"])).toThrow("install|status|repair|remove|collect")
    expect(() => parseOuroCommand(["bluebubbles", "host", "collect", "--request-id"])).toThrow("install|status|repair|remove|collect")
    expect(() => parseOuroCommand(["bluebubbles", "host", "status", "--wat"])).toThrow("install|status|repair|remove|collect")
    expect(() => parseOuroCommand(["bluebubbles", "host", "status", "--username"])).toThrow("install|status|repair|remove|collect")
    expect(() => parseOuroCommand(["bluebubbles", "host", "status", "--uid"])).toThrow("install|status|repair|remove|collect")
    expect(() => parseOuroCommand(["bluebubbles", "host", "status", "--home"])).toThrow("install|status|repair|remove|collect")
  })

  it("sets up the standard same-user host during connect", async () => {
    hostMocks.runAction.mockResolvedValueOnce({
      action: "install",
      changed: true,
      state: { service: "loaded", process: "running" },
    })

    const result = await setupBlueBubblesHostForConnect(
      "ari",
      "http://127.0.0.1:1234",
      12_000,
      deps(),
      {
        userInfo: () => ({ username: "ari", uid: 501, homedir: "/Users/ari" }),
        execFileSync: vi.fn(),
      },
    )

    expect(hostMocks.installHelper).toHaveBeenCalledOnce()
    expect(hostMocks.createDefaultDeps).toHaveBeenCalledWith(expect.objectContaining({
      serverUrl: "http://127.0.0.1:1234",
      requestTimeoutMs: 12_000,
    }))
    expect(hostMocks.runAction).toHaveBeenCalledWith("install", expect.any(Object))
    expect(result).toEqual({
      summary: "host: native LaunchAgent loaded; process running",
      bridgeUsername: "ari",
      bridgeUid: 501,
      bridgeHomeDir: "/Users/ari",
    })
  })

  it("creates the standard cross-user handoff during connect", async () => {
    const execFileSync = vi.fn()
      .mockReturnValueOnce("502\n")
      .mockReturnValueOnce("NFSHomeDirectory: /Users/clawdbot\n")
    const cliDeps = deps()
    delete cliDeps.homeDir

    const result = await setupBlueBubblesHostForConnect(
      "clawdbot",
      "http://127.0.0.1:1234",
      12_000,
      cliDeps,
      {
        userInfo: () => ({ username: "ari", uid: 501, homedir: "/Users/ari" }),
        execFileSync,
      },
    )

    expect(execFileSync).toHaveBeenNthCalledWith(1, "id", ["-u", "clawdbot"], { encoding: "utf8" })
    expect(execFileSync).toHaveBeenNthCalledWith(2, "dscl", [".", "-read", "/Users/clawdbot", "NFSHomeDirectory"], { encoding: "utf8" })
    expect(hostMocks.requestCrossUser).toHaveBeenCalledWith({
      action: "install",
      username: "clawdbot",
      uid: 502,
      targetHomeDir: "/Users/clawdbot",
      originHomeDir: os.homedir(),
    })
    expect(result.summary).toContain("human-required")
    expect(result.summary).toContain("collect:")
  })

  it.each([
    ["not-a-uid", "NFSHomeDirectory: /Users/clawdbot\n"],
    ["502\n", "NFSHomeDirectory:   \n"],
  ])("rejects an unresolved cross-user account (%s)", async (uidText, homeRecord) => {
    const execFileSync = vi.fn()
      .mockReturnValueOnce(uidText)
      .mockReturnValueOnce(homeRecord)

    await expect(setupBlueBubblesHostForConnect(
      "clawdbot",
      "http://127.0.0.1:1234",
      12_000,
      deps(),
      {
        userInfo: () => ({ username: "ari", uid: 501, homedir: "/Users/ari" }),
        execFileSync,
      },
    )).rejects.toThrow("could not resolve BlueBubbles macOS account clawdbot")
  })

  it("executes a same-user action and renders truthful JSON", async () => {
    const cliDeps = deps()
    const output = await runOuroCli(["bluebubbles", "host", "status", "--json"], cliDeps)

    expect(hostMocks.createDefaultDeps).toHaveBeenCalledOnce()
    expect(hostMocks.runAction).toHaveBeenCalledWith("status", expect.objectContaining({ uid: 501 }))
    expect(JSON.parse(output)).toMatchObject({ action: "status", changed: false, state: { service: "loaded" } })
    expect(cliDeps.writeStdout).toHaveBeenCalledWith(output)
  })

  it("renders actor-aware host diagnostics for every independent state", async () => {
    hostMocks.runAction.mockResolvedValueOnce({
      action: "status",
      changed: false,
      state: {
        app: "missing",
        plist: "drifted",
        service: "not-loaded",
        serviceDetail: "Could not find service",
        process: "not-running",
        http: { ok: false, detail: "connection refused" },
        plistPath: "/Users/ari/Library/LaunchAgents/com.bluebubbles.server.plist",
        launchdDomain: "gui/501",
        launchAgentLabel: "com.bluebubbles.server",
      },
    })

    const output = await runOuroCli(["bluebubbles", "host", "status"], deps())

    expect(output).toContain("actor: agent-runnable")
    expect(output).toContain("app: missing")
    expect(output).toContain("plist: drifted")
    expect(output).toContain("service: not-loaded (Could not find service)")
    expect(output).toContain("process: not-running")
    expect(output).toContain("HTTP: unhealthy (connection refused)")
    expect(output).toContain("repair: ouro bluebubbles host repair")
  })

  it("installs the packaged generic helper before returning one exact cross-user handoff", async () => {
    const cliDeps = deps()
    const output = await runOuroCli([
      "bluebubbles", "host", "repair",
      "--username", "clawdbot", "--uid", "502", "--home", "/Users/clawdbot",
    ], cliDeps)

    expect(hostMocks.installHelper).toHaveBeenCalledWith(expect.objectContaining({
      assetPath: expect.stringMatching(/assets\/bluebubbles-host$/),
    }))
    expect(hostMocks.requestCrossUser).toHaveBeenCalledWith({
      action: "repair",
      username: "clawdbot",
      uid: 502,
      targetHomeDir: "/Users/clawdbot",
      originHomeDir: "/Users/ari",
    })
    expect(output).toContain("human-required")
    expect(output).toContain("collect: ouro bluebubbles host collect")
  })

  it("collects one exact request and supports JSON output", async () => {
    const requestId = `502-${"ab".repeat(32)}`
    const output = await runOuroCli(["bluebubbles", "host", "collect", "--request-id", requestId, "--json"], deps())
    expect(hostMocks.collect).toHaveBeenCalledWith({ requestId, originHomeDir: "/Users/ari" })
    expect(JSON.parse(output)).toMatchObject({ requestId, status: "collected" })
  })
})
