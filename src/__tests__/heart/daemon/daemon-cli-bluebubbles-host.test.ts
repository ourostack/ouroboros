import * as fs from "fs"
import * as os from "os"
import * as path from "path"
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

function bundlesWithBlueBubblesHosts(hosts: Record<string, { enabled: boolean; hostUsername?: string }>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bb-host-bundles-"))
  for (const [agent, bluebubbles] of Object.entries(hosts)) {
    fs.mkdirSync(path.join(root, `${agent}.ouro`), { recursive: true })
    fs.writeFileSync(path.join(root, `${agent}.ouro`, "agent.json"), JSON.stringify({ version: 2, enabled: true, senses: { bluebubbles } }))
  }
  return root
}

function deps(bundlesRoot = bundlesWithBlueBubblesHosts({ slugger: { enabled: true, hostUsername: "clawdbot" } })): OuroCliDeps {
  return {
    bundlesRoot,
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

  it.each(["install", "repair"] as const)("refuses a same-user %s when no agent declares this account as its host", async (action) => {
    const me = os.userInfo().username
    await expect(runOuroCli(["bluebubbles", "host", action], deps()))
      .rejects.toThrow(`BlueBubbles host setup refused for macOS account "${me}"`)
    expect(hostMocks.runAction).not.toHaveBeenCalled()
  })

  it("allows a same-user install when an enabled agent declares this account as its host", async () => {
    const me = os.userInfo().username
    await runOuroCli(["bluebubbles", "host", "install"], deps(bundlesWithBlueBubblesHosts({ slugger: { enabled: true, hostUsername: me } })))
    expect(hostMocks.runAction).toHaveBeenCalledWith("install", expect.anything())
  })

  it("ignores host accounts declared by agents with BlueBubbles disabled", async () => {
    const me = os.userInfo().username
    await expect(runOuroCli(["bluebubbles", "host", "install"], deps(bundlesWithBlueBubblesHosts({ old: { enabled: false, hostUsername: me } }))))
      .rejects.toThrow("no agent with BlueBubbles enabled declares senses.bluebubbles.hostUsername")
    expect(hostMocks.runAction).not.toHaveBeenCalled()
  })

  it("fails closed when the bundles root is missing", async () => {
    await expect(runOuroCli(["bluebubbles", "host", "install"], deps(path.join(os.tmpdir(), "no-such-bundles-root-xyz"))))
      .rejects.toThrow("no agent with BlueBubbles enabled declares senses.bluebubbles.hostUsername")
  })

  it("skips stray entries, unreadable bundles and blank host names when collecting declared hosts", async () => {
    const root = bundlesWithBlueBubblesHosts({ blank: { enabled: true, hostUsername: "  " } })
    fs.writeFileSync(path.join(root, "README.md"), "not a bundle")
    fs.mkdirSync(path.join(root, "not-a-bundle"))
    fs.mkdirSync(path.join(root, "broken.ouro"))
    fs.writeFileSync(path.join(root, "broken.ouro", "agent.json"), "{ not json")
    fs.mkdirSync(path.join(root, "nosenses.ouro"))
    fs.writeFileSync(path.join(root, "nosenses.ouro", "agent.json"), JSON.stringify({ version: 2 }))
    await expect(runOuroCli(["bluebubbles", "host", "install"], deps(root)))
      .rejects.toThrow("no agent with BlueBubbles enabled declares senses.bluebubbles.hostUsername")
    expect(hostMocks.runAction).not.toHaveBeenCalled()
  })

  it("refuses a cross-user repair handoff for an undeclared account", async () => {
    await expect(runOuroCli([
      "bluebubbles", "host", "repair",
      "--username", "someone", "--uid", "503", "--home", "/Users/someone",
    ], deps())).rejects.toThrow('BlueBubbles host setup refused for macOS account "someone"')
    expect(hostMocks.requestCrossUser).not.toHaveBeenCalled()
    expect(hostMocks.installHelper).not.toHaveBeenCalled()
  })

  it.each(["status", "remove"] as const)("still allows %s on an undeclared account so it can be inspected and cleaned up", async (action) => {
    await runOuroCli(["bluebubbles", "host", action], deps(bundlesWithBlueBubblesHosts({})))
    expect(hostMocks.runAction).toHaveBeenCalledWith(action, expect.anything())
  })

  it("collects one exact request and supports JSON output", async () => {
    const requestId = `502-${"ab".repeat(32)}`
    const output = await runOuroCli(["bluebubbles", "host", "collect", "--request-id", requestId, "--json"], deps())
    expect(hostMocks.collect).toHaveBeenCalledWith({ requestId, originHomeDir: "/Users/ari" })
    expect(JSON.parse(output)).toMatchObject({ requestId, status: "collected" })
  })
})
