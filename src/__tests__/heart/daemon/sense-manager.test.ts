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

async function cacheMachineRuntimeConfig(agent: string, payload: Record<string, unknown>): Promise<void> {
  const { cacheMachineRuntimeCredentialConfig } = await import("../../../heart/runtime-credentials")
  cacheMachineRuntimeCredentialConfig(agent, payload, new Date(0), "machine_test")
}

async function cacheProviderCredentials(agent: string): Promise<void> {
  const { cacheProviderCredentialRecords, createProviderCredentialRecord } = await import("../../../heart/provider-credentials")
  cacheProviderCredentialRecords(agent, [
    createProviderCredentialRecord({
      provider: "openai-codex",
      credentials: { oauthAccessToken: "codex-token" },
      config: {},
      provenance: { source: "auth-flow" },
      now: new Date(0),
    }),
  ], new Date(0))
}

describe("daemon sense manager", () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.doUnmock("../../../heart/runtime-credentials")
    vi.doUnmock("../../../heart/daemon/http-health-probe")
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
      expect.objectContaining({ agent: "slugger", sense: "mail", status: "disabled", detail: "not enabled in agent.json" }),
      expect.objectContaining({ agent: "slugger", sense: "voice", status: "disabled", detail: "not enabled in agent.json" }),
    ])

    await manager.startAutoStartSenses()
    await manager.stopAll()

    expect(processManager.startAutoStartAgents).toHaveBeenCalledTimes(1)
    expect(processManager.stopAll).toHaveBeenCalledTimes(1)
  })

  it("uses the process-manager trigger hook for nonblocking sense autostart", async () => {
    const bundlesRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sense-manager-bundles-"))
    const processManager = {
      startAutoStartAgents: vi.fn(async () => undefined),
      triggerAutoStartAgents: vi.fn(),
      stopAll: vi.fn(async () => undefined),
      listAgentSnapshots: vi.fn(() => []),
    }

    const { DaemonSenseManager } = await import("../../../heart/daemon/sense-manager")
    const manager = new DaemonSenseManager({
      agents: ["slugger"],
      bundlesRoot,
      processManager,
    })

    manager.triggerAutoStartSenses()

    expect(processManager.triggerAutoStartAgents).toHaveBeenCalledTimes(1)
    expect(processManager.startAutoStartAgents).not.toHaveBeenCalled()
  })

  it("restarts managed sense workers through the process manager when available", async () => {
    const bundlesRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sense-manager-bundles-"))
    const processManager = {
      startAutoStartAgents: vi.fn(async () => undefined),
      restartAgent: vi.fn(async () => undefined),
      startAgent: vi.fn(async () => undefined),
      stopAll: vi.fn(async () => undefined),
      listAgentSnapshots: vi.fn(() => []),
    }

    const { DaemonSenseManager } = await import("../../../heart/daemon/sense-manager")
    const manager = new DaemonSenseManager({
      agents: ["slugger"],
      bundlesRoot,
      processManager,
    })

    await manager.restartSense("slugger:bluebubbles")

    expect(processManager.restartAgent).toHaveBeenCalledWith("slugger:bluebubbles")
    expect(processManager.startAgent).not.toHaveBeenCalled()
  })

  it("falls back to starting a managed sense worker when restart is unavailable", async () => {
    const bundlesRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sense-manager-bundles-"))
    const processManager = {
      startAutoStartAgents: vi.fn(async () => undefined),
      startAgent: vi.fn(async () => undefined),
      stopAll: vi.fn(async () => undefined),
      listAgentSnapshots: vi.fn(() => []),
    }

    const { DaemonSenseManager } = await import("../../../heart/daemon/sense-manager")
    const manager = new DaemonSenseManager({
      agents: ["slugger"],
      bundlesRoot,
      processManager,
    })

    await manager.restartSense("slugger:bluebubbles")

    expect(processManager.startAgent).toHaveBeenCalledWith("slugger:bluebubbles")
  })

  it("contains fallback sense autostart errors", async () => {
    const bundlesRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sense-manager-bundles-"))
    const firstProcessManager = {
      startAutoStartAgents: vi.fn(async () => {
        throw new Error("sense worker start boom")
      }),
      stopAll: vi.fn(async () => undefined),
      listAgentSnapshots: vi.fn(() => []),
    }
    const secondProcessManager = {
      startAutoStartAgents: vi.fn(async () => {
        throw "sense worker start raw"
      }),
      stopAll: vi.fn(async () => undefined),
      listAgentSnapshots: vi.fn(() => []),
    }

    const { DaemonSenseManager } = await import("../../../heart/daemon/sense-manager")
    const first = new DaemonSenseManager({
      agents: ["slugger"],
      bundlesRoot,
      processManager: firstProcessManager,
    })
    const second = new DaemonSenseManager({
      agents: ["slugger"],
      bundlesRoot,
      processManager: secondProcessManager,
    })

    first.triggerAutoStartSenses()
    second.triggerAutoStartSenses()
    await Promise.resolve()
    await Promise.resolve()

    expect(firstProcessManager.startAutoStartAgents).toHaveBeenCalledTimes(1)
    expect(secondProcessManager.startAutoStartAgents).toHaveBeenCalledTimes(1)
  })

  it("reports needs_config for Teams and not_attached for local BlueBubbles when vault runtime/config is missing", async () => {
    const bundlesRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sense-manager-bundles-"))
    writeAgentJson(bundlesRoot, "slugger", {
      version: 1,
      enabled: true,
      provider: "anthropic",
      senses: {
        cli: { enabled: true },
        teams: { enabled: true },
        bluebubbles: { enabled: true },
        mail: { enabled: true },
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
      expect.objectContaining({ sense: "bluebubbles", status: "not_attached", detail: "not attached on this machine" }),
      expect.objectContaining({ sense: "mail", status: "needs_config", detail: "missing vault runtime/config (slugger)" }),
      expect.objectContaining({ sense: "voice", status: "disabled", detail: "not enabled in agent.json" }),
    ])
  })

  it("builds BlueBubbles health probes from the machine-local listener config", async () => {
    const bundlesRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sense-manager-bundles-"))
    writeAgentJson(bundlesRoot, "slugger", {
      version: 1,
      enabled: true,
      provider: "anthropic",
      senses: {
        cli: { enabled: true },
        bluebubbles: { enabled: true },
      },
      phrases: { thinking: ["t"], tool: ["t"], followup: ["f"] },
    })
    await cacheMachineRuntimeConfig("slugger", {
      bluebubbles: {
        serverUrl: "http://localhost:1234",
        password: "bb-secret",
      },
      bluebubblesChannel: {
        port: 18888,
        webhookPath: "/bb-hook",
      },
    })
    const createHttpHealthProbe = vi.fn((name: string, port: number) => ({
      name,
      check: async () => ({ ok: true, detail: String(port) }),
    }))
    vi.doMock("../../../heart/daemon/http-health-probe", () => ({ createHttpHealthProbe }))

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

    const probes = manager.listHealthProbes()
    expect(createHttpHealthProbe).toHaveBeenCalledWith("bluebubbles:slugger", 18888)
    expect(probes).toHaveLength(1)
    await expect(probes[0]!.check()).resolves.toEqual({ ok: true, detail: "18888" })
  })

  it("skips BlueBubbles health probes when this machine is not attached", async () => {
    const bundlesRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sense-manager-bundles-"))
    writeAgentJson(bundlesRoot, "slugger", {
      version: 1,
      enabled: true,
      provider: "anthropic",
      senses: {
        cli: { enabled: true },
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

    expect(manager.listHealthProbes()).toEqual([])
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
        mail: { enabled: true },
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
      mailroom: {
        mailboxAddress: "slugger@ouro.bot",
        privateKeys: {
          mail_slugger_primary: "secret",
        },
      },
    })
    await cacheMachineRuntimeConfig("slugger", {
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
      expect.objectContaining({ sense: "mail", status: "ready", detail: "slugger@ouro.bot" }),
      expect.objectContaining({ sense: "voice", status: "disabled", detail: "not enabled in agent.json" }),
    ])
  })

  it("reports voice as running when ElevenLabs and local Whisper.cpp settings are configured", async () => {
    const bundlesRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sense-manager-bundles-"))
    writeAgentJson(bundlesRoot, "slugger", {
      version: 1,
      enabled: true,
      provider: "anthropic",
      senses: {
        cli: { enabled: true },
        voice: { enabled: true },
      },
      phrases: { thinking: ["t"], tool: ["t"], followup: ["f"] },
    })
    await cacheRuntimeConfig("slugger", {
      integrations: {
        elevenLabsApiKey: "eleven-key",
        elevenLabsVoiceId: "voice_123",
      },
    })
    await cacheMachineRuntimeConfig("slugger", {
      voice: {
        whisperCliPath: "/opt/whisper.cpp/main",
        whisperModelPath: "/models/ggml-base.en.bin",
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
          { name: "slugger:voice", status: "running" },
        ],
      },
    })

    expect(manager.listSenseRows()).toEqual([
      expect.objectContaining({ sense: "cli", status: "interactive", detail: "local interactive terminal" }),
      expect.objectContaining({ sense: "teams", status: "disabled", detail: "not enabled in agent.json" }),
      expect.objectContaining({ sense: "bluebubbles", status: "disabled", detail: "not enabled in agent.json" }),
      expect.objectContaining({ sense: "mail", status: "disabled", detail: "not enabled in agent.json" }),
      expect.objectContaining({ sense: "voice", status: "running", detail: "local Whisper.cpp STT + ElevenLabs TTS" }),
    ])
  })

  it("reports when the managed Twilio phone transport is attached to voice", async () => {
    const bundlesRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sense-manager-bundles-"))
    writeAgentJson(bundlesRoot, "slugger", {
      version: 1,
      enabled: true,
      provider: "anthropic",
      senses: {
        cli: { enabled: true },
        voice: { enabled: true },
      },
      phrases: { thinking: ["t"], tool: ["t"], followup: ["f"] },
    })
    await cacheRuntimeConfig("slugger", {
      integrations: {
        elevenLabsApiKey: "eleven-key",
        elevenLabsVoiceId: "voice_123",
      },
    })
    await cacheMachineRuntimeConfig("slugger", {
      voice: {
        whisperCliPath: "/opt/whisper.cpp/main",
        whisperModelPath: "/models/ggml-base.en.bin",
        twilioPublicUrl: "https://voice.example.test",
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
          { name: "slugger:voice", status: "running" },
        ],
      },
    })

    expect(manager.listSenseRows()).toContainEqual(
      expect.objectContaining({
        sense: "voice",
        status: "running",
        detail: "local Whisper.cpp STT + ElevenLabs TTS; Twilio phone transport attached",
      }),
    )
  })

  it("reports voice setup gaps from portable and machine runtime config separately", async () => {
    const bundlesRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sense-manager-bundles-"))
    writeAgentJson(bundlesRoot, "slugger", {
      version: 1,
      enabled: true,
      provider: "anthropic",
      senses: {
        cli: { enabled: true },
        voice: { enabled: true },
      },
      phrases: { thinking: ["t"], tool: ["t"], followup: ["f"] },
    })
    await cacheRuntimeConfig("slugger", {
      integrations: {
        elevenLabsApiKey: "eleven-key",
        elevenLabsVoiceId: "voice_123",
      },
    })
    await cacheMachineRuntimeConfig("slugger", {
      voice: {
        whisperCliPath: "/opt/whisper.cpp/main",
      },
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

    expect(manager.listSenseRows().find((row) => row.sense === "voice")).toEqual(
      expect.objectContaining({
        status: "needs_config",
        detail: "missing voice.whisperModelPath",
      }),
    )
  })

  it("reports voice portable runtime trouble after the local Whisper.cpp attachment exists", async () => {
    const bundlesRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sense-manager-bundles-"))
    writeAgentJson(bundlesRoot, "slugger", {
      version: 1,
      enabled: true,
      provider: "anthropic",
      senses: {
        cli: { enabled: true },
        voice: { enabled: true },
      },
      phrases: { thinking: ["t"], tool: ["t"], followup: ["f"] },
    })
    await cacheMachineRuntimeConfig("slugger", {
      voice: {
        whisperCliPath: "/opt/whisper.cpp/main",
        whisperModelPath: "/models/ggml-base.en.bin",
      },
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

    expect(manager.listSenseRows().find((row) => row.sense === "voice")).toEqual(
      expect.objectContaining({
        status: "needs_config",
        detail: "missing vault runtime/config (slugger)",
      }),
    )
  })

  it("reports voice machine runtime trouble after the portable ElevenLabs credential exists", async () => {
    const bundlesRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sense-manager-bundles-"))
    writeAgentJson(bundlesRoot, "slugger", {
      version: 1,
      enabled: true,
      provider: "anthropic",
      senses: {
        cli: { enabled: true },
        voice: { enabled: true },
      },
      phrases: { thinking: ["t"], tool: ["t"], followup: ["f"] },
    })

    vi.doMock("../../../heart/runtime-credentials", () => ({
      readRuntimeCredentialConfig: () => ({
        ok: true,
        itemPath: "vault:slugger:runtime/config",
        revision: "runtime_voice",
        updatedAt: "2026-05-07T08:00:00.000Z",
        config: {
          integrations: {
            elevenLabsApiKey: "eleven-key",
            elevenLabsVoiceId: "voice_123",
          },
        },
      }),
      readMachineRuntimeCredentialConfig: () => ({
        ok: false,
        reason: "unavailable",
        itemPath: "vault:slugger:runtime/machines/machine_test/config",
        error: "machine runtime config is malformed",
      }),
      refreshRuntimeCredentialConfig: vi.fn(),
      refreshMachineRuntimeCredentialConfig: vi.fn(),
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

    expect(manager.listSenseRows().find((row) => row.sense === "voice")).toEqual(
      expect.objectContaining({
        status: "needs_config",
        detail: "vault runtime/machines/machine_test/config unavailable (machine runtime config is malformed)",
      }),
    )
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
    await cacheMachineRuntimeConfig("slugger", {
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
      expect.objectContaining({
        sense: "mail",
        status: "disabled",
        detail: "not enabled in agent.json",
      }),
      expect.objectContaining({
        sense: "voice",
        status: "disabled",
        detail: "not enabled in agent.json",
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
    await cacheMachineRuntimeConfig("slugger", {
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
      expect.objectContaining({
        sense: "mail",
        status: "disabled",
        detail: "not enabled in agent.json",
      }),
      expect.objectContaining({
        sense: "voice",
        status: "disabled",
        detail: "not enabled in agent.json",
      }),
    ])
  })

  it("marks BlueBubbles unhealthy when fresh healthy runtime state has no running listener snapshot", async () => {
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
    await cacheMachineRuntimeConfig("slugger", {
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
        listAgentSnapshots: () => [],
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
        detail: "BlueBubbles listener is not running",
      }),
      expect.objectContaining({
        sense: "mail",
        status: "disabled",
        detail: "not enabled in agent.json",
      }),
      expect.objectContaining({
        sense: "voice",
        status: "disabled",
        detail: "not enabled in agent.json",
      }),
    ])
  })

  it("marks BlueBubbles unhealthy when fresh runtime state has pending recovery", async () => {
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
    await cacheMachineRuntimeConfig("slugger", {
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
        detail: "upstream reachable but iMessage is not caught up; 3 recovery item(s) queued",
        lastCheckedAt: freshCheckedAt,
        pendingRecoveryCount: 3,
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
        detail: "upstream reachable but iMessage is not caught up; 3 recovery item(s) queued",
      }),
      expect.objectContaining({
        sense: "mail",
        status: "disabled",
        detail: "not enabled in agent.json",
      }),
      expect.objectContaining({
        sense: "voice",
        status: "disabled",
        detail: "not enabled in agent.json",
      }),
    ])
  })

  it("surfaces BlueBubbles proof metadata and oldest pending recovery age", async () => {
    const bundlesRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sense-manager-bundles-"))
    const freshCheckedAt = new Date().toISOString()
    const oldestPendingAt = new Date(Date.now() - 120_000).toISOString()
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
    await cacheMachineRuntimeConfig("slugger", {
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
        detail: "upstream reachable but iMessage is not caught up; 1 recovery item(s) queued",
        lastCheckedAt: freshCheckedAt,
        proofMethod: "bluebubbles.checkHealth",
        pendingRecoveryCount: 1,
        failedRecoveryCount: 0,
        oldestPendingRecoveryAt: oldestPendingAt,
        oldestPendingRecoveryAgeMs: 120_000,
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

    expect(manager.listSenseRows().find((row) => row.sense === "bluebubbles")).toEqual(
      expect.objectContaining({
        status: "error",
        proofMethod: "bluebubbles.checkHealth",
        lastProofAt: freshCheckedAt,
        oldestPendingRecoveryAt: oldestPendingAt,
        oldestPendingRecoveryAgeMs: 120_000,
        pendingRecoveryCount: 1,
        recoveryAction: "queued recovery will retry; inspect BlueBubbles inbound/recovery sidecar logs if age keeps growing",
      }),
    )
  })

  it("marks BlueBubbles unhealthy when a fresh runtime state reports a stalled live turn", async () => {
    const bundlesRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sense-manager-bundles-"))
    const freshCheckedAt = new Date().toISOString()
    const oldestActiveTurnStartedAt = new Date(Date.now() - 180_000).toISOString()
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
    await cacheMachineRuntimeConfig("slugger", {
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
        detail: "iMessage live turn appears stalled; 1 active turn(s) older than 90000ms",
        lastCheckedAt: freshCheckedAt,
        proofMethod: "bluebubbles.checkHealth",
        pendingRecoveryCount: 0,
        failedRecoveryCount: 0,
        activeTurnCount: 1,
        stalledTurnCount: 1,
        oldestActiveTurnStartedAt,
        oldestActiveTurnAgeMs: 180_000,
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

    expect(manager.listSenseRows().find((row) => row.sense === "bluebubbles")).toEqual(
      expect.objectContaining({
        status: "error",
        failureLayer: "live_turn_stall",
        activeTurnCount: 1,
        stalledTurnCount: 1,
        oldestActiveTurnStartedAt,
        oldestActiveTurnAgeMs: 180_000,
      }),
    )
  })

  it("keeps BlueBubbles running while surfacing quarantined recovery failures", async () => {
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
    await cacheMachineRuntimeConfig("slugger", {
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
        detail: "2 message(s) unrecoverable this cycle; upstream ok",
        lastCheckedAt: freshCheckedAt,
        pendingRecoveryCount: 0,
        failedRecoveryCount: 2,
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
        detail: "2 message(s) unrecoverable this cycle; upstream ok",
      }),
      expect.objectContaining({
        sense: "mail",
        status: "disabled",
        detail: "not enabled in agent.json",
      }),
      expect.objectContaining({
        sense: "voice",
        status: "disabled",
        detail: "not enabled in agent.json",
      }),
    ])
  })

  it("marks BlueBubbles unhealthy when fresh healthy runtime state has a crashed listener snapshot", async () => {
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
    await cacheMachineRuntimeConfig("slugger", {
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
        status: "error",
        detail: "BlueBubbles listener is not running",
      }),
      expect.objectContaining({
        sense: "mail",
        status: "disabled",
        detail: "not enabled in agent.json",
      }),
      expect.objectContaining({
        sense: "voice",
        status: "disabled",
        detail: "not enabled in agent.json",
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
    await cacheMachineRuntimeConfig("slugger", {
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
      expect.objectContaining({
        sense: "mail",
        status: "disabled",
        detail: "not enabled in agent.json",
      }),
      expect.objectContaining({
        sense: "voice",
        status: "disabled",
        detail: "not enabled in agent.json",
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
    await cacheMachineRuntimeConfig("slugger", {
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
      expect.objectContaining({
        sense: "mail",
        status: "disabled",
        detail: "not enabled in agent.json",
      }),
      expect.objectContaining({
        sense: "voice",
        status: "disabled",
        detail: "not enabled in agent.json",
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
    await cacheMachineRuntimeConfig("slugger", {
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
      expect.objectContaining({
        sense: "mail",
        status: "disabled",
        detail: "not enabled in agent.json",
      }),
      expect.objectContaining({
        sense: "voice",
        status: "disabled",
        detail: "not enabled in agent.json",
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
        mail: { enabled: true },
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
      mailroom: {
        mailboxAddress: "slugger@ouro.bot",
        privateKeys: {
          mail_slugger_primary: "secret",
        },
      },
    })
    await cacheMachineRuntimeConfig("slugger", {
      bluebubbles: {
        serverUrl: "http://localhost:1234",
        password: "pw",
      },
    })
    await cacheProviderCredentials("slugger")

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
          expect.objectContaining({ name: "slugger:mail", agentArg: "slugger", entry: "senses/mail-entry.js" }),
        ],
      }),
    )
    const bluebubblesAgent = (processManagerCtor.mock.calls[0]?.[0] as {
      agents: Array<{ name: string; getRuntimeCredentialBootstrap?: () => unknown }>
    }).agents.find((agent) => agent.name === "slugger:bluebubbles")
    expect(bluebubblesAgent?.getRuntimeCredentialBootstrap?.()).toEqual({
      agentName: "slugger",
      runtimeConfig: {
        teams: {
          clientId: "cid",
          clientSecret: "secret",
          tenantId: "tenant",
        },
        mailroom: {
          mailboxAddress: "slugger@ouro.bot",
          privateKeys: {
            mail_slugger_primary: "secret",
          },
        },
      },
      machineRuntimeConfig: {
        bluebubbles: {
          serverUrl: "http://localhost:1234",
          password: "pw",
        },
      },
      machineId: expect.stringMatching(/^machine_/),
      providerCredentialRecords: [
        expect.objectContaining({
          provider: "openai-codex",
          credentials: { oauthAccessToken: "codex-token" },
          config: {},
          provenance: expect.objectContaining({ source: "auth-flow" }),
        }),
      ],
    })
    expect(manager.listSenseRows().find((row) => row.agent === "ouroboros" && row.sense === "teams")).toEqual(
      expect.objectContaining({ status: "disabled" }),
    )
  })

  it("returns no runtime credential bootstrap when no cached config is available", async () => {
    const homeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sense-manager-home-"))
    const bundlesRoot = path.join(homeRoot, "AgentBundles")
    writeAgentJson(bundlesRoot, "slugger", {
      version: 1,
      enabled: true,
      provider: "anthropic",
      senses: {
        cli: { enabled: true },
        mail: { enabled: true },
      },
      phrases: { thinking: ["t"], tool: ["t"], followup: ["f"] },
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

    const mailAgent = (processManagerCtor.mock.calls[0]?.[0] as {
      agents: Array<{ name: string; getRuntimeCredentialBootstrap?: () => unknown }>
    }).agents.find((agent) => agent.name === "slugger:mail")
    expect(mailAgent?.getRuntimeCredentialBootstrap?.()).toBeNull()
  })

  it("uses cached runtime config for default sense checks, refreshes in the background, and returns sense-specific repair hints", async () => {
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
        mail: { enabled: true },
        voice: { enabled: true },
      },
      phrases: { thinking: ["t"], tool: ["t"], followup: ["f"] },
    })
    let runtimeConfig: Record<string, unknown> = {
      teams: {
        clientId: "cid",
        clientSecret: "secret",
        tenantId: "tenant",
      },
      mailroom: {
        mailboxAddress: "slugger@ouro.bot",
        privateKeys: {
          mail_slugger_primary: "secret",
        },
      },
      integrations: {
        elevenLabsApiKey: "eleven-key",
        elevenLabsVoiceId: "voice_123",
      },
    }
    let machineRuntimeConfig: Record<string, unknown> | null = {
      bluebubbles: {
        serverUrl: "http://localhost:1234",
        password: "pw",
      },
      voice: {
        whisperCliPath: "/opt/whisper.cpp/main",
        whisperModelPath: "/models/ggml-base.en.bin",
      },
    }

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

    const refreshRuntimeCredentialConfig = vi.fn(async (agentName: string) => ({
      ok: true,
      itemPath: `vault:${agentName}:runtime/config`,
      config: runtimeConfig,
      revision: "runtime_test",
      updatedAt: new Date(0).toISOString(),
    }))
    const refreshMachineRuntimeCredentialConfig = vi.fn(async (agentName: string) => machineRuntimeConfig
      ? {
          ok: true,
          itemPath: `vault:${agentName}:runtime/machines/machine_test/config`,
          config: machineRuntimeConfig,
          revision: "runtime_machine_test",
          updatedAt: new Date(0).toISOString(),
        }
      : {
          ok: false,
          reason: "missing",
          itemPath: `vault:${agentName}:runtime/machines/machine_test/config`,
          error: "missing",
        })

    vi.doMock("../../../heart/runtime-credentials", () => ({
      readRuntimeCredentialConfig: (agentName: string) => ({
        ok: true,
        itemPath: `vault:${agentName}:runtime/config`,
        config: runtimeConfig,
        revision: "runtime_test",
        updatedAt: new Date(0).toISOString(),
      }),
      refreshRuntimeCredentialConfig,
      readMachineRuntimeCredentialConfig: (agentName: string) => machineRuntimeConfig
        ? {
            ok: true,
            itemPath: `vault:${agentName}:runtime/machines/machine_test/config`,
            config: machineRuntimeConfig,
            revision: "runtime_machine_test",
            updatedAt: new Date(0).toISOString(),
          }
        : {
            ok: false,
            reason: "missing",
            itemPath: `vault:${agentName}:runtime/machines/machine_test/config`,
            error: "missing",
          },
      refreshMachineRuntimeCredentialConfig,
    }))

    const { DaemonSenseManager } = await import("../../../heart/daemon/sense-manager")
    new DaemonSenseManager({
      agents: ["slugger"],
    })

    const options = processManagerCtor.mock.calls[0]?.[0] as {
      configCheck: (name: string) => Promise<{ ok: boolean; error?: string; fix?: string; skip?: boolean }>
    }

    await expect(options.configCheck("bad-format")).resolves.toEqual({ ok: true })
    await expect(options.configCheck("missing:teams")).resolves.toEqual({ ok: true })
    await expect(options.configCheck("slugger:teams")).resolves.toEqual({ ok: true })
    await expect(options.configCheck("slugger:mail")).resolves.toEqual({ ok: true })
    await expect(options.configCheck("slugger:voice")).resolves.toEqual({ ok: true })

    runtimeConfig = {
    }
    const missingTeams = await options.configCheck("slugger:teams")
    expect(missingTeams).toEqual({
      ok: false,
      skip: true,
      error: "teams is enabled for slugger but runtime credentials are not ready: missing teams.clientId/teams.clientSecret/teams.tenantId",
      fix: "Run 'ouro vault config set --agent slugger --key teams.clientId', teams.clientSecret, and teams.tenantId; then run 'ouro up' again.",
    })
    const missingMail = await options.configCheck("slugger:mail")
    expect(missingMail).toEqual({
      ok: false,
      skip: true,
      error: "mail is enabled for slugger but runtime credentials are not ready: missing mailroom.mailboxAddress/mailroom.privateKeys",
      fix: "Agent-runnable: provision Mailroom access with 'ouro connect mail --agent slugger', then restart with 'ouro up'.",
    })
    await vi.waitFor(() => {
      expect(refreshRuntimeCredentialConfig).toHaveBeenCalledWith("slugger", { preserveCachedOnFailure: true })
    })

    runtimeConfig = {
      teams: {
        clientId: "cid",
        clientSecret: "secret",
        tenantId: "tenant",
      },
    }
    machineRuntimeConfig = null
    const missingBlueBubbles = await options.configCheck("slugger:bluebubbles")
    expect(missingBlueBubbles).toEqual({
      ok: false,
      skip: true,
      error: "bluebubbles is enabled for slugger but not attached on this machine",
    })

    machineRuntimeConfig = {
      bluebubbles: {
        serverUrl: "http://localhost:1234",
      },
    }
    const incompleteBlueBubbles = await options.configCheck("slugger:bluebubbles")
    expect(incompleteBlueBubbles).toEqual({
      ok: false,
      skip: true,
      error: "bluebubbles is enabled for slugger but runtime credentials are not ready: missing bluebubbles.password",
      fix: "Run 'ouro connect bluebubbles --agent slugger' to attach BlueBubbles on this machine; then run 'ouro up' again.",
    })
    runtimeConfig = {
      integrations: {},
    }
    machineRuntimeConfig = {
      voice: {
        whisperCliPath: "/opt/whisper.cpp/main",
      },
    }
    const incompleteVoice = await options.configCheck("slugger:voice")
    expect(incompleteVoice).toEqual({
      ok: false,
      skip: true,
      error: "voice is enabled for slugger but runtime credentials are not ready: missing integrations.elevenLabsApiKey/integrations.elevenLabsVoiceId/voice.whisperModelPath",
      fix: "Agent-runnable: run 'ouro connect voice --agent slugger' for config guidance, save ElevenLabs and local Whisper.cpp settings, then run 'ouro up' again.",
    })
    await vi.waitFor(() => {
      expect(refreshMachineRuntimeCredentialConfig).toHaveBeenCalledWith("slugger", expect.any(String), { preserveCachedOnFailure: true })
    })
  })

  it("retries skipped sense startup when background runtime refresh restores config", async () => {
    const homeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sense-manager-home-"))
    const bundlesRoot = path.join(homeRoot, "AgentBundles")
    writeAgentJson(bundlesRoot, "slugger", {
      version: 1,
      enabled: true,
      provider: "anthropic",
      senses: {
        cli: { enabled: true },
        mail: { enabled: true },
      },
      phrases: { thinking: ["t"], tool: ["t"], followup: ["f"] },
    })

    const processManagerCtor = vi.fn()
    const startAgent = vi.fn(async () => undefined)
    const refreshedConfig = {
      ok: true as const,
      itemPath: "vault:slugger:runtime/config",
      config: {
        mailroom: {
          mailboxAddress: "slugger@ouro.bot",
          privateKeys: {
            mail_slugger_primary: "secret",
          },
        },
      },
      revision: "runtime_test",
      updatedAt: new Date(0).toISOString(),
    }
    let resolveRefresh!: (value: typeof refreshedConfig) => void
    const refreshRuntimeCredentialConfig = vi.fn(() => new Promise<typeof refreshedConfig>((resolve) => {
      resolveRefresh = resolve
    }))

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
        startAgent = startAgent
        startAutoStartAgents = vi.fn(async () => undefined)
        stopAll = vi.fn(async () => undefined)
        listAgentSnapshots = vi.fn(() => [])
      },
    }))
    vi.doMock("../../../heart/runtime-credentials", () => ({
      readRuntimeCredentialConfig: (agentName: string) => ({
        ok: false,
        reason: "missing",
        itemPath: `vault:${agentName}:runtime/config`,
        error: "missing",
      }),
      readMachineRuntimeCredentialConfig: (agentName: string) => ({
        ok: false,
        reason: "missing",
        itemPath: `vault:${agentName}:runtime/machines/machine_test/config`,
        error: "missing",
      }),
      refreshRuntimeCredentialConfig,
      refreshMachineRuntimeCredentialConfig: vi.fn(),
    }))

    const { DaemonSenseManager } = await import("../../../heart/daemon/sense-manager")
    new DaemonSenseManager({
      agents: ["slugger"],
    })

    const options = processManagerCtor.mock.calls[0]?.[0] as {
      configCheck: (name: string) => Promise<{ ok: boolean; error?: string; fix?: string; skip?: boolean }>
    }

    await expect(options.configCheck("slugger:mail")).resolves.toMatchObject({ ok: false, skip: true })
    await expect(options.configCheck("slugger:mail")).resolves.toMatchObject({ ok: false, skip: true })
    expect(refreshRuntimeCredentialConfig).toHaveBeenCalledTimes(1)

    resolveRefresh(refreshedConfig)

    await vi.waitFor(() => {
      expect(startAgent).toHaveBeenCalledWith("slugger:mail")
    })
  })

  it("contains background runtime refresh failures for skipped sense startup", async () => {
    const homeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sense-manager-home-"))
    const bundlesRoot = path.join(homeRoot, "AgentBundles")
    writeAgentJson(bundlesRoot, "slugger", {
      version: 1,
      enabled: true,
      provider: "anthropic",
      senses: {
        cli: { enabled: true },
        mail: { enabled: true },
      },
      phrases: { thinking: ["t"], tool: ["t"], followup: ["f"] },
    })

    const processManagerCtor = vi.fn()
    const emitNervesEvent = vi.fn()
    const refreshRuntimeCredentialConfig = vi.fn(async () => {
      throw new Error("vault offline")
    })

    vi.doMock("os", async () => {
      const actual = await vi.importActual<typeof import("os")>("os")
      return {
        ...actual,
        homedir: () => homeRoot,
      }
    })
    vi.doMock("../../../nerves/runtime", () => ({
      emitNervesEvent,
    }))
    vi.doMock("../../../heart/daemon/process-manager", () => ({
      DaemonProcessManager: class MockProcessManager {
        constructor(options: unknown) {
          processManagerCtor(options)
        }
        startAgent = vi.fn(async () => undefined)
        startAutoStartAgents = vi.fn(async () => undefined)
        stopAll = vi.fn(async () => undefined)
        listAgentSnapshots = vi.fn(() => [])
      },
    }))
    vi.doMock("../../../heart/runtime-credentials", () => ({
      readRuntimeCredentialConfig: (agentName: string) => ({
        ok: false,
        reason: "missing",
        itemPath: `vault:${agentName}:runtime/config`,
        error: "missing",
      }),
      readMachineRuntimeCredentialConfig: (agentName: string) => ({
        ok: false,
        reason: "missing",
        itemPath: `vault:${agentName}:runtime/machines/machine_test/config`,
        error: "missing",
      }),
      refreshRuntimeCredentialConfig,
      refreshMachineRuntimeCredentialConfig: vi.fn(),
    }))

    const { DaemonSenseManager } = await import("../../../heart/daemon/sense-manager")
    new DaemonSenseManager({
      agents: ["slugger"],
    })

    const options = processManagerCtor.mock.calls[0]?.[0] as {
      configCheck: (name: string) => Promise<{ ok: boolean; error?: string; fix?: string; skip?: boolean }>
    }

    await expect(options.configCheck("slugger:mail")).resolves.toMatchObject({ ok: false, skip: true })

    await vi.waitFor(() => {
      expect(emitNervesEvent).toHaveBeenCalledWith(expect.objectContaining({
        event: "channel.daemon_sense_autostart_error",
        message: "sense config refresh failed",
      }))
    })
  })

  it("contains sense start failures after a background runtime refresh restores config", async () => {
    const homeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sense-manager-home-"))
    const bundlesRoot = path.join(homeRoot, "AgentBundles")
    writeAgentJson(bundlesRoot, "slugger", {
      version: 1,
      enabled: true,
      provider: "anthropic",
      senses: {
        cli: { enabled: true },
        mail: { enabled: true },
      },
      phrases: { thinking: ["t"], tool: ["t"], followup: ["f"] },
    })

    const processManagerCtor = vi.fn()
    const emitNervesEvent = vi.fn()
    const startAgent = vi.fn(async () => {
      throw new Error("start failed")
    })
    const refreshRuntimeCredentialConfig = vi.fn(async () => ({
      ok: true as const,
      itemPath: "vault:slugger:runtime/config",
      config: {
        mailroom: {
          mailboxAddress: "slugger@ouro.bot",
          privateKeys: {
            mail_slugger_primary: "secret",
          },
        },
      },
      revision: "runtime_test",
      updatedAt: new Date(0).toISOString(),
    }))

    vi.doMock("os", async () => {
      const actual = await vi.importActual<typeof import("os")>("os")
      return {
        ...actual,
        homedir: () => homeRoot,
      }
    })
    vi.doMock("../../../nerves/runtime", () => ({
      emitNervesEvent,
    }))
    vi.doMock("../../../heart/daemon/process-manager", () => ({
      DaemonProcessManager: class MockProcessManager {
        constructor(options: unknown) {
          processManagerCtor(options)
        }
        startAgent = startAgent
        startAutoStartAgents = vi.fn(async () => undefined)
        stopAll = vi.fn(async () => undefined)
        listAgentSnapshots = vi.fn(() => [])
      },
    }))
    vi.doMock("../../../heart/runtime-credentials", () => ({
      readRuntimeCredentialConfig: (agentName: string) => ({
        ok: false,
        reason: "missing",
        itemPath: `vault:${agentName}:runtime/config`,
        error: "missing",
      }),
      readMachineRuntimeCredentialConfig: (agentName: string) => ({
        ok: false,
        reason: "missing",
        itemPath: `vault:${agentName}:runtime/machines/machine_test/config`,
        error: "missing",
      }),
      refreshRuntimeCredentialConfig,
      refreshMachineRuntimeCredentialConfig: vi.fn(),
    }))

    const { DaemonSenseManager } = await import("../../../heart/daemon/sense-manager")
    new DaemonSenseManager({
      agents: ["slugger"],
    })

    const options = processManagerCtor.mock.calls[0]?.[0] as {
      configCheck: (name: string) => Promise<{ ok: boolean; error?: string; fix?: string; skip?: boolean }>
    }

    await expect(options.configCheck("slugger:mail")).resolves.toMatchObject({ ok: false, skip: true })

    await vi.waitFor(() => {
      expect(emitNervesEvent).toHaveBeenCalledWith(expect.objectContaining({
        event: "channel.daemon_sense_autostart_error",
        message: "sense autostart failed",
      }))
    })
  })

  it("does not wait for a slow runtime config refresh before skipping a sense startup", async () => {
    const homeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sense-manager-home-"))
    const bundlesRoot = path.join(homeRoot, "AgentBundles")
    writeAgentJson(bundlesRoot, "slugger", {
      version: 1,
      enabled: true,
      provider: "anthropic",
      senses: {
        cli: { enabled: true },
        mail: { enabled: true },
      },
      phrases: { thinking: ["t"], tool: ["t"], followup: ["f"] },
    })

    const processManagerCtor = vi.fn()
    const refreshRuntimeCredentialConfig = vi.fn(() => new Promise(() => undefined))

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
    vi.doMock("../../../heart/runtime-credentials", () => ({
      readRuntimeCredentialConfig: (agentName: string) => ({
        ok: false,
        reason: "missing",
        itemPath: `vault:${agentName}:runtime/config`,
        error: "missing",
      }),
      readMachineRuntimeCredentialConfig: (agentName: string) => ({
        ok: false,
        reason: "missing",
        itemPath: `vault:${agentName}:runtime/machines/machine_test/config`,
        error: "missing",
      }),
      refreshRuntimeCredentialConfig,
      refreshMachineRuntimeCredentialConfig: vi.fn(),
    }))

    const { DaemonSenseManager } = await import("../../../heart/daemon/sense-manager")
    new DaemonSenseManager({
      agents: ["slugger"],
    })

    const options = processManagerCtor.mock.calls[0]?.[0] as {
      configCheck: (name: string) => Promise<{ ok: boolean; error?: string; fix?: string; skip?: boolean }>
    }

    await expect(options.configCheck("slugger:mail")).resolves.toEqual({
      ok: false,
      skip: true,
      error: "mail is enabled for slugger but runtime credentials are not ready: missing vault runtime/config (slugger)",
      fix: "Agent-runnable: provision Mailroom access with 'ouro connect mail --agent slugger', then restart with 'ouro up'.",
    })
    expect(refreshRuntimeCredentialConfig).toHaveBeenCalledWith("slugger", { preserveCachedOnFailure: true })
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
        mail: { enabled: true },
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
        status: "not_attached",
        detail: "not attached on this machine",
      }),
    )
    expect(manager.listSenseRows().find((row) => row.sense === "mail")).toEqual(
      expect.objectContaining({
        status: "needs_config",
        detail: "missing mailroom.mailboxAddress/mailroom.privateKeys",
      }),
    )
  })

  it("reports incomplete BlueBubbles machine attachments as needs_config", async () => {
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
    await cacheMachineRuntimeConfig("slugger", {
      bluebubbles: {
        serverUrl: "http://localhost:1234",
      },
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

    expect(manager.listSenseRows().find((row) => row.sense === "bluebubbles")).toEqual(
      expect.objectContaining({
        status: "needs_config",
        detail: "missing bluebubbles.password",
      }),
    )
  })

  it("reports unavailable BlueBubbles machine attachments distinctly from not_attached", async () => {
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

    vi.doMock("../../../heart/runtime-credentials", () => ({
      readRuntimeCredentialConfig: () => ({
        ok: false,
        reason: "missing",
        itemPath: "vault:slugger:runtime/config",
        error: "missing",
      }),
      readMachineRuntimeCredentialConfig: () => ({
        ok: false,
        reason: "unavailable",
        itemPath: "vault:slugger:runtime/machines/machine_test/config",
        error: "machine vault locked",
      }),
      refreshRuntimeCredentialConfig: vi.fn(),
      refreshMachineRuntimeCredentialConfig: vi.fn(),
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

    expect(manager.listSenseRows().find((row) => row.sense === "bluebubbles")).toEqual(
      expect.objectContaining({
        status: "needs_config",
        detail: "vault runtime/machines/machine_test/config unavailable (vault locked; run 'ouro vault unlock --agent slugger' if you have the saved secret, or 'ouro vault replace --agent slugger' if none was saved)",
      }),
    )
  })

  it("falls back to runtime/config wording for unavailable runtime item paths without a vault prefix", async () => {
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

    vi.doMock("../../../heart/runtime-credentials", () => ({
      readRuntimeCredentialConfig: () => ({
        ok: false,
        reason: "missing",
        itemPath: "runtime/config",
        error: "missing",
      }),
      readMachineRuntimeCredentialConfig: () => ({
        ok: false,
        reason: "unavailable",
        itemPath: "runtime/machines/machine_test/config",
        error: "machine vault not ready",
      }),
      refreshRuntimeCredentialConfig: vi.fn(),
      refreshMachineRuntimeCredentialConfig: vi.fn(),
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

    expect(manager.listSenseRows().find((row) => row.sense === "bluebubbles")).toEqual(
      expect.objectContaining({
        status: "needs_config",
        detail: "vault runtime/config unavailable (machine vault not ready)",
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
      expect.objectContaining({ sense: "mail", status: "disabled" }),
      expect.objectContaining({ sense: "voice", status: "disabled" }),
    ])
    expect(manager.listSenseRows().filter((row) => row.agent === "ouroboros")).toEqual([
      expect.objectContaining({ sense: "cli", status: "interactive" }),
      expect.objectContaining({ sense: "teams", status: "disabled" }),
      expect.objectContaining({ sense: "bluebubbles", status: "disabled" }),
      expect.objectContaining({ sense: "mail", status: "disabled" }),
      expect.objectContaining({ sense: "voice", status: "disabled" }),
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
        error: [
          "Ouro credential vault is locked on this machine for slugger.",
          "",
          "Vault: slugger@ouro.bot at https://vault.ouro.bot",
          "Run `ouro vault unlock --agent slugger` and enter the saved agent vault unlock secret.",
        ].join("\n"),
      }),
      readMachineRuntimeCredentialConfig: () => ({
        ok: false,
        reason: "missing",
        itemPath: "vault:slugger:runtime/machines/machine_test/config",
        error: "missing",
      }),
      refreshRuntimeCredentialConfig: vi.fn(),
      refreshMachineRuntimeCredentialConfig: vi.fn(),
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
        detail: "vault runtime/config unavailable (vault locked; run 'ouro vault unlock --agent slugger' if you have the saved secret, or 'ouro vault replace --agent slugger' if none was saved)",
      }),
    )
  })

  it("keeps non-lock runtime/config errors compact in sense details", async () => {
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
        error: "runtime credential payload\nis malformed",
      }),
      readMachineRuntimeCredentialConfig: () => ({
        ok: false,
        reason: "missing",
        itemPath: "vault:slugger:runtime/machines/machine_test/config",
        error: "missing",
      }),
      refreshRuntimeCredentialConfig: vi.fn(),
      refreshMachineRuntimeCredentialConfig: vi.fn(),
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
        detail: "vault runtime/config unavailable (runtime credential payload is malformed)",
      }),
    )
  })

  it("uses a stable placeholder when unavailable runtime/config errors are blank", async () => {
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
        error: "  \n\t ",
      }),
      readMachineRuntimeCredentialConfig: () => ({
        ok: false,
        reason: "missing",
        itemPath: "vault:slugger:runtime/machines/machine_test/config",
        error: "missing",
      }),
      refreshRuntimeCredentialConfig: vi.fn(),
      refreshMachineRuntimeCredentialConfig: vi.fn(),
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
        detail: "vault runtime/config unavailable (unavailable)",
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
      expect.objectContaining({ sense: "mail", status: "disabled" }),
      expect.objectContaining({ sense: "voice", status: "disabled" }),
    ])
  })
})
