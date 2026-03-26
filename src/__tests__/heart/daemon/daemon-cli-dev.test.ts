import { describe, expect, it, vi } from "vitest"

import {
  runOuroCli,
  parseOuroCommand,
  type OuroCliDeps,
} from "../../../heart/daemon/daemon-cli"

vi.mock("../../../heart/identity", () => ({
  getRepoRoot: () => "/mock/repo",
  getAgentBundlesRoot: () => "/mock/AgentBundles",
  getAgentName: () => "test",
  getAgentRoot: () => "/mock/AgentBundles/test.ouro",
  getAgentDaemonLogsDir: () => "/mock/logs",
  HARNESS_CANONICAL_REPO_URL: "https://github.com/ouroborosbot/ouroboros.git",
}))

function makeDeps(overrides: Partial<OuroCliDeps> = {}): OuroCliDeps {
  return {
    socketPath: "/tmp/ouro-test.sock",
    sendCommand: vi.fn(async () => ({ ok: true })),
    startDaemonProcess: vi.fn(async () => ({ pid: 42 })),
    writeStdout: vi.fn(),
    checkSocketAlive: vi.fn(async () => false),
    cleanupStaleSocket: vi.fn(),
    fallbackPendingMessage: vi.fn(() => "/tmp/pending.jsonl"),
    ...overrides,
  }
}

describe("ouro dev command handler", () => {
  it("starts daemon in dev mode when dist entry exists", async () => {
    const deps = makeDeps({
      existsSync: vi.fn(() => true),
      getRepoCwd: vi.fn(() => "/my/dev/repo"),
      ensureDaemonBootPersistence: vi.fn(),
    })

    const result = await runOuroCli(["dev"], deps)

    expect(result).toContain("dev mode")
    expect(result).toContain("/my/dev/repo")
    expect(deps.ensureDaemonBootPersistence).toHaveBeenCalledWith("/tmp/ouro-test.sock")
    expect(deps.startDaemonProcess).toHaveBeenCalled()
    // Must NOT call checkForCliUpdate
    expect(deps.checkForCliUpdate).toBeUndefined()
  })

  it("prints error and exits when dist entry is missing", async () => {
    const deps = makeDeps({
      existsSync: vi.fn(() => false),
      getRepoCwd: vi.fn(() => "/my/dev/repo"),
    })

    const result = await runOuroCli(["dev"], deps)

    expect(result).toContain("no harness repo found")
    expect(result).toContain("--repo-path")
    expect(result).toContain("--clone")
    expect(deps.startDaemonProcess).not.toHaveBeenCalled()
  })

  it("does not call checkForCliUpdate in dev mode", async () => {
    const checkForCliUpdate = vi.fn()
    const deps = makeDeps({
      existsSync: vi.fn(() => true),
      getRepoCwd: vi.fn(() => "/my/dev/repo"),
      ensureDaemonBootPersistence: vi.fn(),
      checkForCliUpdate,
    })

    await runOuroCli(["dev"], deps)

    expect(checkForCliUpdate).not.toHaveBeenCalled()
  })

  it("does not call performSystemSetup deps in dev mode", async () => {
    const installOuroCommand = vi.fn()
    const registerOuroBundleType = vi.fn()
    const syncGlobalOuroBotWrapper = vi.fn()
    const ensureSkillManagement = vi.fn()
    const ensureCurrentVersionInstalled = vi.fn()
    const deps = makeDeps({
      existsSync: vi.fn(() => true),
      getRepoCwd: vi.fn(() => "/my/dev/repo"),
      ensureDaemonBootPersistence: vi.fn(),
      installOuroCommand,
      registerOuroBundleType,
      syncGlobalOuroBotWrapper,
      ensureSkillManagement,
      ensureCurrentVersionInstalled,
    })

    await runOuroCli(["dev"], deps)

    expect(installOuroCommand).not.toHaveBeenCalled()
    expect(registerOuroBundleType).not.toHaveBeenCalled()
    expect(syncGlobalOuroBotWrapper).not.toHaveBeenCalled()
    expect(ensureSkillManagement).not.toHaveBeenCalled()
    expect(ensureCurrentVersionInstalled).not.toHaveBeenCalled()
  })

  it("rejects when cwd has dist/ but no .git (installed package, not a repo)", async () => {
    const deps = makeDeps({
      existsSync: vi.fn((p: string) => {
        if (p.includes(".git")) return false
        if (p.includes("dist")) return true
        return false
      }),
      getRepoCwd: vi.fn(() => "/installed/npm/package"),
    })

    const result = await runOuroCli(["dev"], deps)

    expect(result).toContain("no harness repo found")
    expect(result).toContain("--repo-path")
    expect(deps.startDaemonProcess).not.toHaveBeenCalled()
  })

  it("uses --repo-path when provided", async () => {
    const deps = makeDeps({
      existsSync: vi.fn((p: string) => p.includes("/custom/repo")),
      ensureDaemonBootPersistence: vi.fn(),
    })

    const result = await runOuroCli(["dev", "--repo-path", "/custom/repo"], deps)

    expect(result).toContain("dev mode")
    expect(result).toContain("/custom/repo")
  })
})

describe("parseOuroCommand dev flags", () => {
  it("parses --repo-path", () => {
    const cmd = parseOuroCommand(["dev", "--repo-path", "/my/repo"])
    expect(cmd).toEqual({ kind: "daemon.dev", repoPath: "/my/repo", clone: false, clonePath: undefined })
  })

  it("parses --clone", () => {
    const cmd = parseOuroCommand(["dev", "--clone"])
    expect(cmd).toEqual({ kind: "daemon.dev", repoPath: undefined, clone: true, clonePath: undefined })
  })

  it("parses --clone --clone-path", () => {
    const cmd = parseOuroCommand(["dev", "--clone", "--clone-path", "/tmp/ouro"])
    expect(cmd).toEqual({ kind: "daemon.dev", repoPath: undefined, clone: true, clonePath: "/tmp/ouro" })
  })

  it("ignores --clone-path without a value", () => {
    const cmd = parseOuroCommand(["dev", "--clone", "--clone-path"])
    expect(cmd).toEqual({ kind: "daemon.dev", repoPath: undefined, clone: true, clonePath: undefined })
  })

  it("parses bare dev", () => {
    const cmd = parseOuroCommand(["dev"])
    expect(cmd).toEqual({ kind: "daemon.dev", repoPath: undefined, clone: false, clonePath: undefined })
  })
})

describe("ouro up from dev context", () => {
  it("delegates to installed binary when running from dev mode", async () => {
    const execInstalledBinary = vi.fn(() => { throw new Error("exec replaced process") }) as unknown as (binaryPath: string, args: string[]) => never
    const deps = makeDeps({
      detectMode: vi.fn(() => "dev" as const),
      getInstalledBinaryPath: vi.fn(() => "/Users/me/.ouro-cli/bin/ouro"),
      execInstalledBinary,
    })

    await expect(runOuroCli(["up"], deps)).rejects.toThrow("exec replaced process")

    expect(execInstalledBinary).toHaveBeenCalledWith(
      "/Users/me/.ouro-cli/bin/ouro",
      ["up"],
    )
    // Should NOT start daemon directly
    expect(deps.startDaemonProcess).not.toHaveBeenCalled()
  })

  it("prints error when no installed binary exists in dev mode", async () => {
    const deps = makeDeps({
      detectMode: vi.fn(() => "dev" as const),
      getInstalledBinaryPath: vi.fn(() => null),
    })

    const result = await runOuroCli(["up"], deps)

    expect(result).toContain("no installed version found")
    expect(result).toContain("npx @ouro.bot/cli@alpha")
    expect(deps.startDaemonProcess).not.toHaveBeenCalled()
  })

  it("proceeds normally when running from production mode", async () => {
    const deps = makeDeps({
      detectMode: vi.fn(() => "production" as const),
      ensureDaemonBootPersistence: vi.fn(),
    })

    const result = await runOuroCli(["up"], deps)

    expect(result).toContain("daemon started")
    expect(deps.startDaemonProcess).toHaveBeenCalled()
  })
})
