import { afterEach, describe, expect, it, vi } from "vitest"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"

function writeAgentJson(root: string, agent: string, payload: unknown): void {
  const agentRoot = path.join(root, `${agent}.ouro`)
  fs.mkdirSync(agentRoot, { recursive: true })
  fs.writeFileSync(path.join(agentRoot, "agent.json"), JSON.stringify(payload, null, 2) + "\n", "utf-8")
}

function writeSecrets(root: string, agent: string, payload: unknown): void {
  const secretsDir = path.join(root, agent)
  fs.mkdirSync(secretsDir, { recursive: true })
  fs.writeFileSync(path.join(secretsDir, "secrets.json"), JSON.stringify(payload, null, 2) + "\n", "utf-8")
}

describe("daemon sense manager", () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.resetModules()
  })

  it("delegates lifecycle to the injected process manager and falls back to default senses when agent config is missing", async () => {
    const bundlesRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sense-manager-bundles-"))
    const secretsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sense-manager-secrets-"))
    const processManager = {
      startAutoStartAgents: vi.fn(async () => undefined),
      stopAll: vi.fn(async () => undefined),
      listAgentSnapshots: vi.fn(() => []),
    }

    const { DaemonSenseManager } = await import("../../../heart/daemon/sense-manager")
    const manager = new DaemonSenseManager({
      agents: ["slugger"],
      bundlesRoot,
      secretsRoot,
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

  it("reports needs_config for enabled senses when secrets.json is missing", async () => {
    const bundlesRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sense-manager-bundles-"))
    const secretsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sense-manager-secrets-"))
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
      secretsRoot,
      processManager: {
        startAutoStartAgents: async () => undefined,
        stopAll: async () => undefined,
        listAgentSnapshots: () => [],
      },
    })

    expect(manager.listSenseRows()).toEqual([
      expect.objectContaining({ sense: "cli", status: "interactive" }),
      expect.objectContaining({ sense: "teams", status: "needs_config", detail: "missing secrets.json (slugger)" }),
      expect.objectContaining({ sense: "bluebubbles", status: "needs_config", detail: "missing secrets.json (slugger)" }),
    ])
  })

  it("uses configured details, ignores malformed snapshot ids, and marks non-running daemon senses as error", async () => {
    const bundlesRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sense-manager-bundles-"))
    const secretsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sense-manager-secrets-"))
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
    writeSecrets(secretsRoot, "slugger", {
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
      secretsRoot,
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
    const secretsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sense-manager-secrets-"))
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
    writeSecrets(secretsRoot, "slugger", {
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
        pendingRecoveryCount: 2,
      }, null, 2) + "\n",
      "utf-8",
    )

    const { DaemonSenseManager } = await import("../../../heart/daemon/sense-manager")
    const manager = new DaemonSenseManager({
      agents: ["slugger"],
      bundlesRoot,
      secretsRoot,
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
    const secretsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sense-manager-secrets-"))
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
    writeSecrets(secretsRoot, "slugger", {
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
      secretsRoot,
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
    const secretsRoot = path.join(homeRoot, ".agentsecrets")
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
    writeSecrets(secretsRoot, "slugger", {
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
          expect.objectContaining({ name: "slugger:bluebubbles", agentArg: "slugger", entry: "senses/bluebubbles-entry.js" }),
        ],
      }),
    )
    expect(manager.listSenseRows().find((row) => row.agent === "ouroboros" && row.sense === "teams")).toEqual(
      expect.objectContaining({ status: "disabled" }),
    )
  })

  it("treats invalid secrets payload objects as missing required config", async () => {
    const bundlesRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sense-manager-bundles-"))
    const secretsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sense-manager-secrets-"))
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
    const secretsDir = path.join(secretsRoot, "slugger")
    fs.mkdirSync(secretsDir, { recursive: true })
    fs.writeFileSync(path.join(secretsDir, "secrets.json"), "[]\n", "utf-8")

    const { DaemonSenseManager } = await import("../../../heart/daemon/sense-manager")
    const manager = new DaemonSenseManager({
      agents: ["slugger"],
      bundlesRoot,
      secretsRoot,
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
    const secretsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sense-manager-secrets-"))
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
      secretsRoot,
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

  it("handles non-Error secrets read failures defensively", async () => {
    const bundlesRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sense-manager-bundles-"))
    const secretsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sense-manager-secrets-"))
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

    vi.doMock("fs", async () => {
      const actual = await vi.importActual<typeof import("fs")>("fs")
      return {
        ...actual,
        readFileSync: ((target: fs.PathOrFileDescriptor, encoding?: BufferEncoding) => {
          if (typeof target === "string" && target.endsWith(path.join("slugger", "secrets.json"))) {
            throw "string-read-failure"
          }
          return actual.readFileSync(target, encoding as BufferEncoding)
        }) as typeof fs.readFileSync,
      }
    })

    const { DaemonSenseManager } = await import("../../../heart/daemon/sense-manager")
    const manager = new DaemonSenseManager({
      agents: ["slugger"],
      bundlesRoot,
      secretsRoot,
      processManager: {
        startAutoStartAgents: async () => undefined,
        stopAll: async () => undefined,
        listAgentSnapshots: () => [],
      },
    })

    expect(manager.listSenseRows().find((row) => row.sense === "teams")).toEqual(
      expect.objectContaining({
        status: "needs_config",
        detail: "missing secrets.json (slugger)",
      }),
    )
  })

  it("handles non-Error agent config read failures defensively", async () => {
    const bundlesRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sense-manager-bundles-"))
    const secretsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sense-manager-secrets-"))

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
      secretsRoot,
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
