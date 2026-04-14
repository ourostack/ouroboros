import { afterEach, describe, expect, it, vi } from "vitest"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"

function writeAgentJson(root: string, agent: string, payload: unknown): void {
  const agentRoot = path.join(root, `${agent}.ouro`)
  fs.mkdirSync(agentRoot, { recursive: true })
  fs.writeFileSync(path.join(agentRoot, "agent.json"), JSON.stringify(payload, null, 2) + "\n", "utf-8")
}

async function cacheRuntimeConfig(agent: string, payload: Record<string, unknown>): Promise<void> {
  const { cacheRuntimeCredentialConfig } = await import("../../../heart/runtime-credentials")
  cacheRuntimeCredentialConfig(agent, payload, new Date(0))
}

describe("daemon sense manager", () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.resetModules()
  })

  it("delegates lifecycle to the injected process manager and falls back to default senses when agent config is missing", async () => {
    const bundlesRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sense-manager-bundles-"))
    const processManager = {
      startAutoStartAgents: vi.fn(async () => undefined),
      stopAll: vi.fn(async () => undefined),
      listAgentSnapshots: vi.fn(() => []),
    }

    const { DaemonSenseManager } = await import("../../../heart/daemon/sense-manager")
    const manager = new DaemonSenseManager({
      agents: ["slugger"],
      bundlesRoot,
      processManager,
    })

    expect(manager.listSenseRows()).toEqual([
      expect.objectContaining({ agent: "slugger", sense: "cli", status: "interactive", detail: "local interactive terminal" }),
      expect.objectContaining({ agent: "slugger", sense: "teams", status: "disabled", detail: "not enabled in agent.json" }),
      expect.objectContaining({ agent: "slugger", sense: "bluebubbles", status: "disabled", detail: "not enabled in agent.json" }),
    ])

    await manager.startAutoStartSenses()
    await manager.stopAll()

    expect(processManager.startAutoStartAgents).toHaveBeenCalledTimes(1)
    expect(processManager.stopAll).toHaveBeenCalledTimes(1)
  })

  it("reports needs_config for enabled senses when vault runtime/config is missing", async () => {
    const bundlesRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sense-manager-bundles-"))
    writeAgentJson(bundlesRoot, "slugger", {
      version: 1,
      enabled: true,
      provider: "anthropic",
      senses: {
        cli: { enabled: true },
        teams: { enabled: true },
        bluebubbles: { enabled: true },
      },
      phrases: { thinking: ["t"], tool: ["t"], followup: ["f"] },
    })

    const { DaemonSenseManager } = await import("../../../heart/daemon/sense-manager")
    const manager = new DaemonSenseManager({
      agents: ["slugger"],
      bundlesRoot,
      processManager: {
        startAutoStartAgents: async () => undefined,
        stopAll: async () => undefined,
        listAgentSnapshots: () => [],
      },
    })

    expect(manager.listSenseRows()).toEqual([
      expect.objectContaining({ sense: "cli", status: "interactive" }),
      expect.objectContaining({ sense: "teams", status: "needs_config", detail: "missing vault runtime/config (slugger)" }),
      expect.objectContaining({ sense: "bluebubbles", status: "needs_config", detail: "missing vault runtime/config (slugger)" }),
    ])
  })

  it("uses configured details, ignores malformed snapshot ids, and marks non-running daemon senses as error", async () => {
    const bundlesRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sense-manager-bundles-"))
    writeAgentJson(bundlesRoot, "slugger", {
      version: 1,
      enabled: true,
      provider: "anthropic",
      senses: {
        cli: { enabled: true },
        teams: { enabled: true },
        bluebubbles: { enabled: true },
      },
      phrases: { thinking: ["t"], tool: ["t"], followup: ["f"] },
    })
    await cacheRuntimeConfig("slugger", {
      teams: {
        clientId: "cid",
        clientSecret: "secret",
        tenantId: "tenant",
      },
      teamsChannel: {
        port: 5000,
      },
      bluebubbles: {
        serverUrl: "http://localhost:1234",
        password: "pw",
      },
      bluebubblesChannel: {
        port: 18888,
        webhookPath: "/hooks/bb",
      },
    })

    const { DaemonSenseManager } = await import("../../../heart/daemon/sense-manager")
    const manager = new DaemonSenseManager({
      agents: ["slugger"],
      bundlesRoot,
      processManager: {
        startAutoStartAgents: async () => undefined,
        stopAll: async () => undefined,
        listAgentSnapshots: () => [
          { name: "slugger:teams", status: "crashed" },
          { name: "slugger:bluebubbles", status: "running" },
          { name: "slugger:cli", status: "running" },
          { name: "bad-format", status: "running" },
        ],
      },
    })

    expect(manager.listSenseRows()).toEqual([
      expect.objectContaining({ sense: "cli", status: "interactive", detail: "local interactive terminal" }),
      expect.objectContaining({ sense: "teams", status: "error", detail: ":5000" }),
      expect.objectContaining({ sense: "bluebubbles", status: "running", detail: ":18888 /hooks/bb" }),
    ])
  })

  it("surfaces upstream BlueBubbles runtime failures even when the listener process is still running", async () => {
    const bundlesRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sense-manager-bundles-"))
    const freshCheckedAt = new Date().toISOString()
    writeAgentJson(bundlesRoot, "slugger", {
      version: 1,
      enabled: true,
      provider: "anthropic",
      senses: {
        cli: { enabled: true },
        teams: { enabled: false },
        bluebubbles: { enabled: true },
      },
      phrases: { thinking: ["t"], tool: ["t"], followup: ["f"] },
    })
    await cacheRuntimeConfig("slugger", {
      bluebubbles: {
        serverUrl: "http://localhost:1234",
        password: "pw",
      },
      bluebubblesChannel: {
        port: 18888,
        webhookPath: "/hooks/bb",
      },
    })
    const runtimeDir = path.join(bundlesRoot, "slugger.ouro", "state", "senses", "bluebubbles")
    fs.mkdirSync(runtimeDir, { recursive: true })
    fs.writeFileSync(
      path.join(runtimeDir, "runtime.json"),
      JSON.stringify({
        upstreamStatus: "error",
        detail: "upstream unreachable: connect ECONNREFUSED http://localhost:1234",
        lastCheckedAt: freshCheckedAt,
        pendingRecoveryCount: 2,
      }, null, 2) + "\n",
      "utf-8",
    )

    const { DaemonSenseManager } = await import("../../../heart/daemon/sense-manager")
    const manager = new DaemonSenseManager({
      agents: ["slugger"],
      bundlesRoot,
      processManager: {
        startAutoStartAgents: async () => undefined,
        stopAll: async () => undefined,
        listAgentSnapshots: () => [
          { name: "slugger:bluebubbles", status: "running" },
        ],
      },
    })

    expect(manager.listSenseRows()).toEqual([
      expect.objectContaining({ sense: "cli", status: "interactive", detail: "local interactive terminal" }),
      expect.objectContaining({
        sense: "teams",
        status: "disabled",
        detail: "not enabled in agent.json",
      }),
      expect.objectContaining({
        sense: "bluebubbles",
        status: "error",
        detail: expect.stringContaining("upstream unreachable"),
      }),
    ])
  })

  it("keeps BlueBubbles marked running when runtime state reports the upstream as healthy", async () => {
    const bundlesRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sense-manager-bundles-"))
    const freshCheckedAt = new Date().toISOString()
    writeAgentJson(bundlesRoot, "slugger", {
      version: 1,
      enabled: true,
      provider: "anthropic",
      senses: {
        cli: { enabled: true },
        teams: { enabled: false },
        bluebubbles: { enabled: true },
      },
      phrases: { thinking: ["t"], tool: ["t"], followup: ["f"] },
    })
    await cacheRuntimeConfig("slugger", {
      bluebubbles: {
        serverUrl: "http://localhost:1234",
        password: "pw",
      },
      bluebubblesChannel: {
        port: 18888,
        webhookPath: "/hooks/bb",
      },
    })
    const runtimeDir = path.join(bundlesRoot, "slugger.ouro", "state", "senses", "bluebubbles")
    fs.mkdirSync(runtimeDir, { recursive: true })
    fs.writeFileSync(
      path.join(runtimeDir, "runtime.json"),
      JSON.stringify({
        upstreamStatus: "ok",
        detail: "upstream reachable",
        lastCheckedAt: freshCheckedAt,
        pendingRecoveryCount: 0,
      }, null, 2) + "\n",
      "utf-8",
    )

    const { DaemonSenseManager } = await import("../../../heart/daemon/sense-manager")
    const manager = new DaemonSenseManager({
      agents: ["slugger"],
      bundlesRoot,
      processManager: {
        startAutoStartAgents: async () => undefined,
        stopAll: async () => undefined,
        listAgentSnapshots: () => [
          { name: "slugger:bluebubbles", status: "running" },
        ],
      },
    })

    expect(manager.listSenseRows()).toEqual([
      expect.objectContaining({ sense: "cli", status: "interactive", detail: "local interactive terminal" }),
      expect.objectContaining({
        sense: "teams",
        status: "disabled",
        detail: "not enabled in agent.json",
      }),
      expect.objectContaining({
        sense: "bluebubbles",
        status: "running",
        detail: ":18888 /hooks/bb",
      }),
    ])
  })

  it("prefers healthy BlueBubbles runtime state over a stale crashed process snapshot", async () => {
    const bundlesRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sense-manager-bundles-"))
    const freshCheckedAt = new Date().toISOString()
    writeAgentJson(bundlesRoot, "slugger", {
      version: 1,
      enabled: true,
      provider: "anthropic",
      senses: {
        cli: { enabled: true },
        teams: { enabled: false },
        bluebubbles: { enabled: true },
      },
      phrases: { thinking: ["t"], tool: ["t"], followup: ["f"] },
    })
    await cacheRuntimeConfig("slugger", {
      bluebubbles: {
        serverUrl: "http://localhost:1234",
        password: "pw",
      },
      bluebubblesChannel: {
        port: 18888,
        webhookPath: "/hooks/bb",
      },
    })
    const runtimeDir = path.join(bundlesRoot, "slugger.ouro", "state", "senses", "bluebubbles")
    fs.mkdirSync(runtimeDir, { recursive: true })
    fs.writeFileSync(
      path.join(runtimeDir, "runtime.json"),
      JSON.stringify({
        upstreamStatus: "ok",
        detail: "upstream reachable",
        pendingRecoveryCount: 0,
        lastCheckedAt: freshCheckedAt,
      }, null, 2) + "\n",
      "utf-8",
    )

    const { DaemonSenseManager } = await import("../../../heart/daemon/sense-manager")
    const manager = new DaemonSenseManager({
      agents: ["slugger"],
      bundlesRoot,
      processManager: {
        startAutoStartAgents: async () => undefined,
        stopAll: async () => undefined,
        listAgentSnapshots: () => [
          { name: "slugger:bluebubbles", status: "crashed" },
        ],
      },
    })

    expect(manager.listSenseRows()).toEqual([
      expect.objectContaining({ sense: "cli", status: "interactive", detail: "local interactive terminal" }),
      expect.objectContaining({
        sense: "teams",
        status: "disabled",
        detail: "not enabled in agent.json",
      }),
      expect.objectContaining({
        sense: "bluebubbles",
        status: "running",
        detail: ":18888 /hooks/bb",
      }),
    ])
  })

  it("ignores healthy BlueBubbles runtime state when it lacks a freshness timestamp", async () => {
    const bundlesRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sense-manager-bundles-"))
    writeAgentJson(bundlesRoot, "slugger", {
      version: 1,
      enabled: true,
      provider: "anthropic",
      senses: {
        cli: { enabled: true },
        teams: { enabled: false },
        bluebubbles: { enabled: true },
      },
      phrases: { thinking: ["t"], tool: ["t"], followup: ["f"] },
    })
    await cacheRuntimeConfig("slugger", {
      bluebubbles: {
        serverUrl: "http://localhost:1234",
        password: "pw",
      },
      bluebubblesChannel: {
        port: 18888,
        webhookPath: "/hooks/bb",
      },
    })
    const runtimeDir = path.join(bundlesRoot, "slugger.ouro", "state", "senses", "bluebubbles")
    fs.mkdirSync(runtimeDir, { recursive: true })
    fs.writeFileSync(
      path.join(runtimeDir, "runtime.json"),
      JSON.stringify({
        upstreamStatus: "ok",
        detail: "upstream reachable",
        pendingRecoveryCount: 0,
      }, null, 2) + "\n",
      "utf-8",
    )

    const { DaemonSenseManager } = await import("../../../heart/daemon/sense-manager")
    const manager = new DaemonSenseManager({
      agents: ["slugger"],
      bundlesRoot,
      processManager: {
        startAutoStartAgents: async () => undefined,
        stopAll: async () => undefined,
        listAgentSnapshots: () => [
          { name: "slugger:bluebubbles", status: "crashed" },
        ],
      },
    })

    expect(manager.listSenseRows()).toEqual([
      expect.objectContaining({ sense: "cli", status: "interactive", detail: "local interactive terminal" }),
      expect.objectContaining({
        sense: "teams",
        status: "disabled",
        detail: "not enabled in agent.json",
      }),
      expect.objectContaining({
        sense: "bluebubbles",
        status: "error",
        detail: ":18888 /hooks/bb",
      }),
    ])
  })

  it("ignores healthy BlueBubbles runtime state when its freshness timestamp is invalid", async () => {
    const bundlesRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sense-manager-bundles-"))
    writeAgentJson(bundlesRoot, "slugger", {
      version: 1,
      enabled: true,
      provider: "anthropic",
      senses: {
        cli: { enabled: true },
        teams: { enabled: false },
        bluebubbles: { enabled: true },
      },
      phrases: { thinking: ["t"], tool: ["t"], followup: ["f"] },
    })
    await cacheRuntimeConfig("slugger", {
      bluebubbles: {
        serverUrl: "http://localhost:1234",
        password: "pw",
      },
      bluebubblesChannel: {
        port: 18888,
        webhookPath: "/hooks/bb",
      },
    })
    const runtimeDir = path.join(bundlesRoot, "slugger.ouro", "state", "senses", "bluebubbles")
    fs.mkdirSync(runtimeDir, { recursive: true })
    fs.writeFileSync(
      path.join(runtimeDir, "runtime.json"),
      JSON.stringify({
        upstreamStatus: "ok",
        detail: "upstream reachable",
        lastCheckedAt: "not-a-timestamp",
        pendingRecoveryCount: 0,
      }, null, 2) + "\n",
      "utf-8",
    )

    const { DaemonSenseManager } = await import("../../../heart/daemon/sense-manager")
    const manager = new DaemonSenseManager({
      agents: ["slugger"],
      bundlesRoot,
      processManager: {
        startAutoStartAgents: async () => undefined,
        stopAll: async () => undefined,
        listAgentSnapshots: () => [
          { name: "slugger:bluebubbles", status: "crashed" },
        ],
      },
    })

    expect(manager.listSenseRows()).toEqual([
      expect.objectContaining({ sense: "cli", status: "interactive", detail: "local interactive terminal" }),
      expect.objectContaining({
        sense: "teams",
        status: "disabled",
        detail: "not enabled in agent.json",
      }),
      expect.objectContaining({
        sense: "bluebubbles",
        status: "error",
        detail: ":18888 /hooks/bb",
      }),
    ])
  })

  it("falls back to the BlueBubbles process snapshot when runtime state is fresh but inconclusive", async () => {
    const bundlesRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sense-manager-bundles-"))
    const freshCheckedAt = new Date().toISOString()
    writeAgentJson(bundlesRoot, "slugger", {
      version: 1,
      enabled: true,
      provider: "anthropic",
      senses: {
        cli: { enabled: true },
        teams: { enabled: false },
        bluebubbles: { enabled: true },
      },
      phrases: { thinking: ["t"], tool: ["t"], followup: ["f"] },
    })
    await cacheRuntimeConfig("slugger", {
      bluebubbles: {
        serverUrl: "http://localhost:1234",
        password: "pw",
      },
      bluebubblesChannel: {
        port: 18888,
        webhookPath: "/hooks/bb",
      },
    })
    const runtimeDir = path.join(bundlesRoot, "slugger.ouro", "state", "senses", "bluebubbles")
    fs.mkdirSync(runtimeDir, { recursive: true })
    fs.writeFileSync(
      path.join(runtimeDir, "runtime.json"),
      JSON.stringify({
        upstreamStatus: "maybe",
        detail: "startup health probe pending",
        lastCheckedAt: freshCheckedAt,
        pendingRecoveryCount: 0,
      }, null, 2) + "\n",
      "utf-8",
    )

    const { DaemonSenseManager } = await import("../../../heart/daemon/sense-manager")
    const manager = new DaemonSenseManager({
      agents: ["slugger"],
      bundlesRoot,
      processManager: {
        startAutoStartAgents: async () => undefined,
        stopAll: async () => undefined,
        listAgentSnapshots: () => [
          { name: "slugger:bluebubbles", status: "running" },
        ],
      },
    })

    expect(manager.listSenseRows()).toEqual([
      expect.objectContaining({ sense: "cli", status: "interactive", detail: "local interactive terminal" }),
      expect.objectContaining({
        sense: "teams",
        status: "disabled",
        detail: "not enabled in agent.json",
      }),
      expect.objectContaining({
        sense: "bluebubbles",
        status: "running",
        detail: ":18888 /hooks/bb",
      }),
    ])
  })

  it("builds managed sense processes from enabled configured senses when no process manager is injected", async () => {
    const homeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sense-manager-home-"))
    const bundlesRoot = path.join(homeRoot, "AgentBundles")
    writeAgentJson(bundlesRoot, "slugger", {
      version: 1,
      enabled: true,
      provider: "anthropic",
      senses: {
        cli: { enabled: true },
        teams: { enabled: true },
        bluebubbles: { enabled: true },
      },
      phrases: { thinking: ["t"], tool: ["t"], followup: ["f"] },
    })
    writeAgentJson(bundlesRoot, "ouroboros", {
      version: 1,
      enabled: true,
      provider: "anthropic",
      senses: {
        cli: { enabled: true },
        teams: { enabled: false },
        bluebubbles: { enabled: false },
      },
      phrases: { thinking: ["t"], tool: ["t"], followup: ["f"] },
    })
    await cacheRuntimeConfig("slugger", {
      teams: {
        clientId: "cid",
        clientSecret: "secret",
        tenantId: "tenant",
      },
      bluebubbles: {
        serverUrl: "http://localhost:1234",
        password: "pw",
      },
    })

    const processManagerCtor = vi.fn()

    vi.doMock("os", async () => {
      const actual = await vi.importActual<typeof import("os")>("os")
      return {
        ...actual,
        homedir: () => homeRoot,
      }
    })

    vi.doMock("../../../heart/daemon/process-manager", () => ({
      DaemonProcessManager: class MockProcessManager {
        constructor(options: unknown) {
          processManagerCtor(options)
        }
        startAutoStartAgents = vi.fn(async () => undefined)
        stopAll = vi.fn(async () => undefined)
        listAgentSnapshots = vi.fn(() => [])
      },
    }))

    const { DaemonSenseManager } = await import("../../../heart/daemon/sense-manager")
    const manager = new DaemonSenseManager({
      agents: ["slugger", "ouroboros"],
    })

    expect(processManagerCtor).toHaveBeenCalledWith(
      expect.objectContaining({
        agents: [
          expect.objectContaining({ name: "slugger:teams", agentArg: "slugger", entry: "senses/teams-entry.js" }),
          expect.objectContaining({ name: "slugger:bluebubbles", agentArg: "slugger", entry: "senses/bluebubbles/entry.js" }),
        ],
      }),
    )
    expect(manager.listSenseRows().find((row) => row.agent === "ouroboros" && row.sense === "teams")).toEqual(
      expect.objectContaining({ status: "disabled" }),
    )
  })

  it("rechecks runtime/config during default sense config checks and returns sense-specific repair hints", async () => {
    const homeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sense-manager-home-"))
    const bundlesRoot = path.join(homeRoot, "AgentBundles")
    writeAgentJson(bundlesRoot, "slugger", {
      version: 1,
      enabled: true,
      provider: "anthropic",
      senses: {
        cli: { enabled: true },
        teams: { enabled: true },
        bluebubbles: { enabled: true },
      },
      phrases: { thinking: ["t"], tool: ["t"], followup: ["f"] },
    })
    await cacheRuntimeConfig("slugger", {
      teams: {
        clientId: "cid",
        clientSecret: "secret",
        tenantId: "tenant",
      },
      bluebubbles: {
        serverUrl: "http://localhost:1234",
        password: "pw",
      },
    })

    const processManagerCtor = vi.fn()

    vi.doMock("os", async () => {
      const actual = await vi.importActual<typeof import("os")>("os")
      return {
        ...actual,
        homedir: () => homeRoot,
      }
    })

    vi.doMock("../../../heart/daemon/process-manager", () => ({
      DaemonProcessManager: class MockProcessManager {
        constructor(options: unknown) {
          processManagerCtor(options)
        }
        startAutoStartAgents = vi.fn(async () => undefined)
        stopAll = vi.fn(async () => undefined)
        listAgentSnapshots = vi.fn(() => [])
      },
    }))

    const { DaemonSenseManager } = await import("../../../heart/daemon/sense-manager")
    new DaemonSenseManager({
      agents: ["slugger"],
    })

    const options = processManagerCtor.mock.calls[0]?.[0] as {
      configCheck: (name: string) => Promise<{ ok: boolean; error?: string; fix?: string }>
    }

    await expect(options.configCheck("bad-format")).resolves.toEqual({ ok: true })
    await expect(options.configCheck("missing:teams")).resolves.toEqual({ ok: true })
    await expect(options.configCheck("slugger:teams")).resolves.toEqual({ ok: true })

    await cacheRuntimeConfig("slugger", {
      bluebubbles: {
        serverUrl: "http://localhost:1234",
        password: "pw",
      },
    })
    const missingTeams = await options.configCheck("slugger:teams")
    expect(missingTeams).toEqual({
      ok: false,
      error: "teams is enabled for slugger but runtime credentials are not ready: missing teams.clientId/teams.clientSecret/teams.tenantId",
      fix: "Run 'ouro vault config set --agent slugger --key teams.clientId', teams.clientSecret, and teams.tenantId; then run 'ouro up' again.",
    })

    await cacheRuntimeConfig("slugger", {
      teams: {
        clientId: "cid",
        clientSecret: "secret",
        tenantId: "tenant",
      },
    })
    const missingBlueBubbles = await options.configCheck("slugger:bluebubbles")
    expect(missingBlueBubbles).toEqual({
      ok: false,
      error: "bluebubbles is enabled for slugger but runtime credentials are not ready: missing bluebubbles.serverUrl/bluebubbles.password",
      fix: "Run 'ouro vault config set --agent slugger --key bluebubbles.serverUrl' and bluebubbles.password; then run 'ouro up' again.",
    })
  })

  it("treats empty runtime/config objects as missing required config", async () => {
    const bundlesRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sense-manager-bundles-"))
    writeAgentJson(bundlesRoot, "slugger", {
      version: 1,
      enabled: true,
      provider: "anthropic",
      senses: {
        cli: { enabled: true },
        teams: { enabled: true },
        bluebubbles: { enabled: true },
      },
      phrases: { thinking: ["t"], tool: ["t"], followup: ["f"] },
    })
    await cacheRuntimeConfig("slugger", {})

    const { DaemonSenseManager } = await import("../../../heart/daemon/sense-manager")
    const manager = new DaemonSenseManager({
      agents: ["slugger"],
      bundlesRoot,
      processManager: {
        startAutoStartAgents: async () => undefined,
        stopAll: async () => undefined,
        listAgentSnapshots: () => [],
      },
    })

    expect(manager.listSenseRows().find((row) => row.sense === "teams")).toEqual(
      expect.objectContaining({
        status: "needs_config",
        detail: "missing teams.clientId/teams.clientSecret/teams.tenantId",
      }),
    )
    expect(manager.listSenseRows().find((row) => row.sense === "bluebubbles")).toEqual(
      expect.objectContaining({
        status: "needs_config",
        detail: "missing bluebubbles.serverUrl/bluebubbles.password",
      }),
    )
  })

  it("falls back to defaults when senses blocks are malformed", async () => {
    const bundlesRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sense-manager-bundles-"))
    writeAgentJson(bundlesRoot, "slugger", {
      version: 1,
      enabled: true,
      provider: "anthropic",
      senses: [],
      phrases: { thinking: ["t"], tool: ["t"], followup: ["f"] },
    })
    writeAgentJson(bundlesRoot, "ouroboros", {
      version: 1,
      enabled: true,
      provider: "anthropic",
      senses: {
        cli: { enabled: true },
        teams: [],
        bluebubbles: { enabled: "yes" },
      },
      phrases: { thinking: ["t"], tool: ["t"], followup: ["f"] },
    })

    const { DaemonSenseManager } = await import("../../../heart/daemon/sense-manager")
    const manager = new DaemonSenseManager({
      agents: ["slugger", "ouroboros"],
      bundlesRoot,
      processManager: {
        startAutoStartAgents: async () => undefined,
        stopAll: async () => undefined,
        listAgentSnapshots: () => [],
      },
    })

    expect(manager.listSenseRows().filter((row) => row.agent === "slugger")).toEqual([
      expect.objectContaining({ sense: "cli", status: "interactive" }),
      expect.objectContaining({ sense: "teams", status: "disabled" }),
      expect.objectContaining({ sense: "bluebubbles", status: "disabled" }),
    ])
    expect(manager.listSenseRows().filter((row) => row.agent === "ouroboros")).toEqual([
      expect.objectContaining({ sense: "cli", status: "interactive" }),
      expect.objectContaining({ sense: "teams", status: "disabled" }),
      expect.objectContaining({ sense: "bluebubbles", status: "disabled" }),
    ])
  })

  it("handles missing runtime/config defensively", async () => {
    const bundlesRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sense-manager-bundles-"))
    writeAgentJson(bundlesRoot, "slugger", {
      version: 1,
      enabled: true,
      provider: "anthropic",
      senses: {
        cli: { enabled: true },
        teams: { enabled: true },
        bluebubbles: { enabled: false },
      },
      phrases: { thinking: ["t"], tool: ["t"], followup: ["f"] },
    })

    const { DaemonSenseManager } = await import("../../../heart/daemon/sense-manager")
    const manager = new DaemonSenseManager({
      agents: ["slugger"],
      bundlesRoot,
      processManager: {
        startAutoStartAgents: async () => undefined,
        stopAll: async () => undefined,
        listAgentSnapshots: () => [],
      },
    })

    expect(manager.listSenseRows().find((row) => row.sense === "teams")).toEqual(
      expect.objectContaining({
        status: "needs_config",
        detail: "missing vault runtime/config (slugger)",
      }),
    )
  })

  it("reports unavailable runtime/config distinctly from a missing runtime/config item", async () => {
    const bundlesRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sense-manager-bundles-"))
    writeAgentJson(bundlesRoot, "slugger", {
      version: 1,
      enabled: true,
      provider: "anthropic",
      senses: {
        cli: { enabled: true },
        teams: { enabled: true },
        bluebubbles: { enabled: false },
      },
      phrases: { thinking: ["t"], tool: ["t"], followup: ["f"] },
    })

    vi.doMock("../../../heart/runtime-credentials", () => ({
      readRuntimeCredentialConfig: () => ({
        ok: false,
        reason: "unavailable",
        itemPath: "vault:slugger:runtime/config",
        error: "vault locked",
      }),
      refreshRuntimeCredentialConfig: vi.fn(),
    }))

    const { DaemonSenseManager } = await import("../../../heart/daemon/sense-manager")
    const manager = new DaemonSenseManager({
      agents: ["slugger"],
      bundlesRoot,
      processManager: {
        startAutoStartAgents: async () => undefined,
        stopAll: async () => undefined,
        listAgentSnapshots: () => [],
      },
    })

    expect(manager.listSenseRows().find((row) => row.sense === "teams")).toEqual(
      expect.objectContaining({
        status: "needs_config",
        detail: "vault runtime/config unavailable (vault locked)",
      }),
    )
  })

  it("handles non-Error agent config read failures defensively", async () => {
    const bundlesRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sense-manager-bundles-"))

    vi.doMock("fs", async () => {
      const actual = await vi.importActual<typeof import("fs")>("fs")
      return {
        ...actual,
        readFileSync: ((target: fs.PathOrFileDescriptor, encoding?: BufferEncoding) => {
          if (typeof target === "string" && target.endsWith(path.join("slugger.ouro", "agent.json"))) {
            throw "string-agent-read-failure"
          }
          return actual.readFileSync(target, encoding as BufferEncoding)
        }) as typeof fs.readFileSync,
      }
    })

    const { DaemonSenseManager } = await import("../../../heart/daemon/sense-manager")
    const manager = new DaemonSenseManager({
      agents: ["slugger"],
      bundlesRoot,
      processManager: {
        startAutoStartAgents: async () => undefined,
        stopAll: async () => undefined,
        listAgentSnapshots: () => [],
      },
    })

    expect(manager.listSenseRows()).toEqual([
      expect.objectContaining({ sense: "cli", status: "interactive" }),
      expect.objectContaining({ sense: "teams", status: "disabled" }),
      expect.objectContaining({ sense: "bluebubbles", status: "disabled" }),
    ])
  })
})
