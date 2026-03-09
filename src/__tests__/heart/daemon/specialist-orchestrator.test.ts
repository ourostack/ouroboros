import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { afterEach, describe, it, expect, vi, beforeEach } from "vitest"

// Track calls to identity/config/provider functions
const mockSetAgentName = vi.fn()
const mockSetAgentConfigOverride = vi.fn()
const mockResetIdentity = vi.fn()
const mockResetConfigCache = vi.fn()
const mockResetProviderRuntime = vi.fn()
const mockWriteSecretsFile = vi.fn().mockReturnValue("/mock/secrets/path")

// Mock session result
const mockRunSpecialistSession = vi.fn()
const mockCreateProviderRegistry = vi.fn(() => ({
  resolve: () => ({
    id: "anthropic",
    model: "test-model",
    client: {},
    streamTurn: vi.fn(),
    appendToolOutput: vi.fn(),
    resetTurnState: vi.fn(),
  }),
}))
const mockExecSpecialistTool = vi.fn().mockResolvedValue("tool result")

// Mock the modules
vi.mock("../../../heart/identity", () => ({
  setAgentName: (...args: any[]) => mockSetAgentName(...args),
  setAgentConfigOverride: (...args: any[]) => mockSetAgentConfigOverride(...args),
  resetIdentity: (...args: any[]) => mockResetIdentity(...args),
  getAgentName: vi.fn(() => "OriginalAgent"),
  loadAgentConfig: vi.fn(() => ({
    version: 1,
    enabled: true,
    provider: "anthropic",
    phrases: { thinking: ["t"], tool: ["t"], followup: ["f"] },
  })),
  getAgentSecretsPath: vi.fn(() => "/mock/secrets.json"),
  getAgentRoot: vi.fn(() => "/mock/agent-root"),
  getRepoRoot: vi.fn(() => "/mock/repo"),
  getAgentBundlesRoot: vi.fn(() => "/mock/bundles"),
  buildDefaultAgentTemplate: vi.fn(),
  DEFAULT_AGENT_CONTEXT: { maxTokens: 80000, contextMargin: 20 },
  DEFAULT_AGENT_PHRASES: { thinking: ["working"], tool: ["running tool"], followup: ["processing"] },
}))

vi.mock("../../../heart/config", () => ({
  resetConfigCache: (...args: any[]) => mockResetConfigCache(...args),
  loadConfig: vi.fn(() => ({
    providers: {
      anthropic: { model: "test-model", setupToken: "test-token" },
      azure: { modelName: "", apiKey: "", endpoint: "", deployment: "", apiVersion: "" },
      minimax: { model: "", apiKey: "" },
      "openai-codex": { model: "", oauthAccessToken: "" },
    },
    teams: { clientId: "", clientSecret: "", tenantId: "" },
    oauth: { graphConnectionName: "", adoConnectionName: "", githubConnectionName: "" },
    context: { maxTokens: 80000, contextMargin: 20 },
    teamsChannel: { skipConfirmation: true, port: 3978 },
    integrations: { perplexityApiKey: "", openaiEmbeddingsApiKey: "" },
  })),
  getAnthropicConfig: vi.fn(() => ({ model: "test-model", setupToken: "test-token" })),
  getAzureConfig: vi.fn(() => ({ modelName: "", apiKey: "", endpoint: "", deployment: "", apiVersion: "" })),
  getMinimaxConfig: vi.fn(() => ({ model: "", apiKey: "" })),
  getOpenAICodexConfig: vi.fn(() => ({ model: "", oauthAccessToken: "" })),
  getContextConfig: vi.fn(() => ({ maxTokens: 80000, contextMargin: 20 })),
  getTeamsConfig: vi.fn(() => ({ clientId: "", clientSecret: "", tenantId: "" })),
  getOAuthConfig: vi.fn(() => ({ graphConnectionName: "", adoConnectionName: "", githubConnectionName: "" })),
  getTeamsChannelConfig: vi.fn(() => ({ skipConfirmation: true, port: 3978 })),
  getIntegrationsConfig: vi.fn(() => ({ perplexityApiKey: "", openaiEmbeddingsApiKey: "" })),
  getOpenAIEmbeddingsApiKey: vi.fn(() => ""),
  patchRuntimeConfig: vi.fn(),
  sessionPath: vi.fn(() => "/mock/session.json"),
  logPath: vi.fn(() => "/mock/log.ndjson"),
  getLogsDir: vi.fn(() => "/mock/logs"),
  DeepPartial: undefined,
}))

vi.mock("../../../heart/core", () => ({
  resetProviderRuntime: (...args: any[]) => mockResetProviderRuntime(...args),
  createProviderRegistry: (...args: any[]) => mockCreateProviderRegistry(...args),
}))

vi.mock("../../../heart/daemon/hatch-flow", () => ({
  writeSecretsFile: (...args: any[]) => mockWriteSecretsFile(...args),
  runHatchFlow: vi.fn(),
}))

vi.mock("../../../heart/daemon/specialist-tools", () => ({
  getSpecialistTools: vi.fn(() => []),
  execSpecialistTool: (...args: any[]) => mockExecSpecialistTool(...args),
}))

vi.mock("../../../heart/daemon/specialist-session", () => ({
  runSpecialistSession: (...args: any[]) => mockRunSpecialistSession(...args),
}))

function makeTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`))
}

describe("runAdoptionSpecialist", () => {
  const cleanup: string[] = []

  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    while (cleanup.length > 0) {
      const entry = cleanup.pop()
      if (!entry) continue
      fs.rmSync(entry, { recursive: true, force: true })
    }
  })

  function createBundleSource(): string {
    const dir = makeTempDir("specialist-bundle")
    cleanup.push(dir)

    // Create psyche/SOUL.md
    const psycheDir = path.join(dir, "psyche")
    fs.mkdirSync(psycheDir, { recursive: true })
    fs.writeFileSync(path.join(psycheDir, "SOUL.md"), "# Soul\nI help humans hatch agents.", "utf-8")

    // Create psyche/identities/
    const identitiesDir = path.join(psycheDir, "identities")
    fs.mkdirSync(identitiesDir, { recursive: true })
    fs.writeFileSync(path.join(identitiesDir, "medusa.md"), "# Medusa\nI am Medusa.", "utf-8")
    fs.writeFileSync(path.join(identitiesDir, "python.md"), "# Python\nI am Python.", "utf-8")

    return dir
  }

  function makeDeps(overrides?: Record<string, unknown>) {
    const bundleSourceDir = createBundleSource()
    const bundlesRoot = makeTempDir("specialist-bundles-root")
    const secretsRoot = makeTempDir("specialist-secrets-root")
    cleanup.push(bundlesRoot, secretsRoot)

    return {
      bundleSourceDir,
      bundlesRoot,
      secretsRoot,
      provider: "anthropic" as const,
      credentials: { setupToken: "test-token" },
      humanName: "Ari",
      random: () => 0.5,
      createReadline: () => ({
        question: vi.fn().mockResolvedValue("test input"),
        close: vi.fn(),
      }),
      callbacks: {
        onModelStart: vi.fn(),
        onModelStreamStart: vi.fn(),
        onTextChunk: vi.fn(),
        onReasoningChunk: vi.fn(),
        onToolStart: vi.fn(),
        onToolEnd: vi.fn(),
        onError: vi.fn(),
      },
      ...overrides,
    }
  }

  it("reads SOUL.md and picks a random identity from bundled AdoptionSpecialist.ouro", async () => {
    mockRunSpecialistSession.mockResolvedValue({ hatchedAgentName: null })

    const { runAdoptionSpecialist } = await import("../../../heart/daemon/specialist-orchestrator")
    const deps = makeDeps()

    await runAdoptionSpecialist(deps)

    // Session should have been called with a system prompt containing soul and identity text
    expect(mockRunSpecialistSession).toHaveBeenCalledTimes(1)
    const sessionDeps = mockRunSpecialistSession.mock.calls[0][0]
    expect(sessionDeps.systemPrompt).toContain("I help humans hatch agents")
    // Identity should be either medusa or python (depends on random)
    expect(
      sessionDeps.systemPrompt.includes("Medusa") || sessionDeps.systemPrompt.includes("Python"),
    ).toBe(true)
  })

  it("sets agent name to AdoptionSpecialist and overrides agent config", async () => {
    mockRunSpecialistSession.mockResolvedValue({ hatchedAgentName: null })

    const { runAdoptionSpecialist } = await import("../../../heart/daemon/specialist-orchestrator")
    const deps = makeDeps()

    await runAdoptionSpecialist(deps)

    expect(mockSetAgentName).toHaveBeenCalledWith("AdoptionSpecialist")
    expect(mockSetAgentConfigOverride).toHaveBeenCalled()
    const overrideConfig = mockSetAgentConfigOverride.mock.calls[0][0]
    expect(overrideConfig.provider).toBe("anthropic")
  })

  it("writes specialist secrets via writeSecretsFile", async () => {
    mockRunSpecialistSession.mockResolvedValue({ hatchedAgentName: null })

    const { runAdoptionSpecialist } = await import("../../../heart/daemon/specialist-orchestrator")
    const deps = makeDeps()

    await runAdoptionSpecialist(deps)

    expect(mockWriteSecretsFile).toHaveBeenCalledWith(
      "AdoptionSpecialist",
      "anthropic",
      { setupToken: "test-token" },
      deps.secretsRoot,
    )
  })

  it("resets provider runtime before creating specialist provider", async () => {
    mockRunSpecialistSession.mockResolvedValue({ hatchedAgentName: null })

    const { runAdoptionSpecialist } = await import("../../../heart/daemon/specialist-orchestrator")
    const deps = makeDeps()

    await runAdoptionSpecialist(deps)

    expect(mockResetProviderRuntime).toHaveBeenCalled()
    expect(mockResetConfigCache).toHaveBeenCalled()
  })

  it("builds system prompt with soul, identity, and existing bundles", async () => {
    mockRunSpecialistSession.mockResolvedValue({ hatchedAgentName: null })

    const { runAdoptionSpecialist } = await import("../../../heart/daemon/specialist-orchestrator")
    const deps = makeDeps()

    // Create some existing bundles in bundlesRoot
    const existingBundle = path.join(deps.bundlesRoot, "ExistingBot.ouro")
    fs.mkdirSync(existingBundle, { recursive: true })
    fs.writeFileSync(
      path.join(existingBundle, "agent.json"),
      JSON.stringify({ version: 1, enabled: true, provider: "anthropic" }),
      "utf-8",
    )

    await runAdoptionSpecialist(deps)

    const sessionDeps = mockRunSpecialistSession.mock.calls[0][0]
    expect(sessionDeps.systemPrompt).toContain("ExistingBot")
  })

  it("runs the specialist session and returns hatchling name", async () => {
    mockRunSpecialistSession.mockResolvedValue({ hatchedAgentName: "MyBot" })

    const { runAdoptionSpecialist } = await import("../../../heart/daemon/specialist-orchestrator")
    const deps = makeDeps()

    const result = await runAdoptionSpecialist(deps)

    expect(result).toBe("MyBot")
  })

  it("restores identity/config state after session (cleanup)", async () => {
    mockRunSpecialistSession.mockResolvedValue({ hatchedAgentName: null })

    const { runAdoptionSpecialist } = await import("../../../heart/daemon/specialist-orchestrator")
    const deps = makeDeps()

    await runAdoptionSpecialist(deps)

    // After session, override should be cleared
    expect(mockSetAgentConfigOverride).toHaveBeenCalledWith(null)
    // Provider runtime should be reset again for cleanup
    expect(mockResetProviderRuntime.mock.calls.length).toBeGreaterThanOrEqual(2)
    expect(mockResetConfigCache.mock.calls.length).toBeGreaterThanOrEqual(2)
  })

  it("cleanup runs even if session throws", async () => {
    mockRunSpecialistSession.mockRejectedValue(new Error("session exploded"))

    const { runAdoptionSpecialist } = await import("../../../heart/daemon/specialist-orchestrator")
    const deps = makeDeps()

    await expect(runAdoptionSpecialist(deps)).rejects.toThrow("session exploded")

    // Cleanup should still have run
    expect(mockSetAgentConfigOverride).toHaveBeenCalledWith(null)
    expect(mockResetProviderRuntime.mock.calls.length).toBeGreaterThanOrEqual(2)
  })

  it("returns null when session returns no hatchling", async () => {
    mockRunSpecialistSession.mockResolvedValue({ hatchedAgentName: null })

    const { runAdoptionSpecialist } = await import("../../../heart/daemon/specialist-orchestrator")
    const deps = makeDeps()

    const result = await runAdoptionSpecialist(deps)

    expect(result).toBeNull()
  })

  it("handles non-existent bundlesRoot gracefully (empty bundle list)", async () => {
    mockRunSpecialistSession.mockResolvedValue({ hatchedAgentName: null })

    const { runAdoptionSpecialist } = await import("../../../heart/daemon/specialist-orchestrator")
    const deps = makeDeps({ bundlesRoot: "/nonexistent/bundles/path" })

    await runAdoptionSpecialist(deps)

    const sessionDeps = mockRunSpecialistSession.mock.calls[0][0]
    // With no bundles found, should say "no agents yet"
    expect(sessionDeps.systemPrompt).toContain("no agents yet")
  })

  it("handles empty identities directory with default identity", async () => {
    mockRunSpecialistSession.mockResolvedValue({ hatchedAgentName: null })

    // Create a bundle source with empty identities dir
    const dir = makeTempDir("specialist-empty-identities")
    cleanup.push(dir)
    const psycheDir = path.join(dir, "psyche")
    fs.mkdirSync(psycheDir, { recursive: true })
    fs.writeFileSync(path.join(psycheDir, "SOUL.md"), "# Soul\nTest soul.", "utf-8")
    const identitiesDir = path.join(psycheDir, "identities")
    fs.mkdirSync(identitiesDir, { recursive: true })
    // No .md files in identities dir

    const { runAdoptionSpecialist } = await import("../../../heart/daemon/specialist-orchestrator")
    const deps = makeDeps({ bundleSourceDir: dir })

    await runAdoptionSpecialist(deps)

    const sessionDeps = mockRunSpecialistSession.mock.calls[0][0]
    expect(sessionDeps.systemPrompt).toContain("I am the adoption specialist")
  })

  it("throws when provider registry returns null", async () => {
    mockCreateProviderRegistry.mockReturnValueOnce({ resolve: () => null })

    const { runAdoptionSpecialist } = await import("../../../heart/daemon/specialist-orchestrator")
    const deps = makeDeps()

    await expect(runAdoptionSpecialist(deps)).rejects.toThrow(
      "Failed to create provider runtime for adoption specialist",
    )

    // Cleanup should still run even after provider creation failure
    expect(mockSetAgentConfigOverride).toHaveBeenCalledWith(null)
  })

  it("filters non-.ouro entries and non-directories from bundle listing", async () => {
    mockRunSpecialistSession.mockResolvedValue({ hatchedAgentName: null })

    const { runAdoptionSpecialist } = await import("../../../heart/daemon/specialist-orchestrator")
    const deps = makeDeps()

    // Create a mix of entries: .ouro dirs, non-.ouro dir, file with .ouro extension
    fs.mkdirSync(path.join(deps.bundlesRoot, "RealBot.ouro"), { recursive: true })
    fs.mkdirSync(path.join(deps.bundlesRoot, "AlphaBot.ouro"), { recursive: true })
    fs.mkdirSync(path.join(deps.bundlesRoot, "not-a-bundle"), { recursive: true })
    fs.writeFileSync(path.join(deps.bundlesRoot, "fake.ouro"), "not a dir", "utf-8")

    await runAdoptionSpecialist(deps)

    const sessionDeps = mockRunSpecialistSession.mock.calls[0][0]
    expect(sessionDeps.systemPrompt).toContain("RealBot")
    expect(sessionDeps.systemPrompt).toContain("AlphaBot")
    expect(sessionDeps.systemPrompt).not.toContain("not-a-bundle")
    expect(sessionDeps.systemPrompt).not.toContain("fake")
  })

  it("uses Math.random when no random function provided", async () => {
    mockRunSpecialistSession.mockResolvedValue({ hatchedAgentName: null })

    const { runAdoptionSpecialist } = await import("../../../heart/daemon/specialist-orchestrator")
    // Create deps without the random override
    const bundleSourceDir = createBundleSource()
    const bundlesRoot = makeTempDir("specialist-bundles-root")
    const secretsRoot = makeTempDir("specialist-secrets-root")
    cleanup.push(bundlesRoot, secretsRoot)

    const deps = {
      bundleSourceDir,
      bundlesRoot,
      secretsRoot,
      provider: "anthropic" as const,
      credentials: { setupToken: "test-token" },
      humanName: "Ari",
      // No random function -- should use Math.random
      createReadline: () => ({
        question: vi.fn().mockResolvedValue("test input"),
        close: vi.fn(),
      }),
      callbacks: {
        onModelStart: vi.fn(),
        onModelStreamStart: vi.fn(),
        onTextChunk: vi.fn(),
        onReasoningChunk: vi.fn(),
        onToolStart: vi.fn(),
        onToolEnd: vi.fn(),
        onError: vi.fn(),
      },
    }

    await runAdoptionSpecialist(deps)

    // Should succeed -- the identity will be randomly picked using Math.random
    expect(mockRunSpecialistSession).toHaveBeenCalledTimes(1)
  })

  it("passes inputController hooks and flushMarkdown when readline has inputController", async () => {
    mockRunSpecialistSession.mockResolvedValue({ hatchedAgentName: null })

    const { runAdoptionSpecialist } = await import("../../../heart/daemon/specialist-orchestrator")
    const mockCtrl = { suppress: vi.fn(), restore: vi.fn() }
    const mockFlushMarkdown = vi.fn()
    const deps = makeDeps({
      createReadline: () => ({
        question: vi.fn().mockResolvedValue("test input"),
        close: vi.fn(),
        inputController: mockCtrl,
      }),
      callbacks: {
        onModelStart: vi.fn(),
        onModelStreamStart: vi.fn(),
        onTextChunk: vi.fn(),
        onReasoningChunk: vi.fn(),
        onToolStart: vi.fn(),
        onToolEnd: vi.fn(),
        onError: vi.fn(),
        flushMarkdown: mockFlushMarkdown,
      },
    })

    await runAdoptionSpecialist(deps)

    const sessionDeps = mockRunSpecialistSession.mock.calls[0][0]
    // suppressInput, restoreInput, writePrompt should be defined (truthy ctrl branch)
    expect(sessionDeps.suppressInput).toBeDefined()
    expect(sessionDeps.restoreInput).toBeDefined()
    expect(sessionDeps.writePrompt).toBeDefined()
    expect(sessionDeps.flushMarkdown).toBe(mockFlushMarkdown)

    // Invoke them to cover the lambda bodies
    sessionDeps.suppressInput(() => {})
    expect(mockCtrl.suppress).toHaveBeenCalled()
    sessionDeps.restoreInput()
    expect(mockCtrl.restore).toHaveBeenCalled()
    sessionDeps.writePrompt()
  })

  it("loads identity-specific phrases from agent.json when available", async () => {
    mockRunSpecialistSession.mockResolvedValue({ hatchedAgentName: null })

    const { runAdoptionSpecialist } = await import("../../../heart/daemon/specialist-orchestrator")
    const deps = makeDeps()

    // Write agent.json with identityPhrases into the bundle source
    // random=0.5 picks python.md (second of two files)
    fs.writeFileSync(
      path.join(deps.bundleSourceDir, "agent.json"),
      JSON.stringify({
        phrases: { thinking: ["base thinking"], tool: ["base tool"], followup: ["base followup"] },
        identityPhrases: {
          python: {
            thinking: ["the oracle contemplates", "reading the signs"],
            tool: ["consulting the sacred texts"],
            followup: ["the prophecy takes shape"],
          },
        },
      }),
    )

    await runAdoptionSpecialist(deps)

    // Config override should use identity-specific phrases
    const overrideConfig = mockSetAgentConfigOverride.mock.calls[0][0]
    expect(overrideConfig.phrases.thinking).toContain("the oracle contemplates")
  })

  it("falls back to base phrases from agent.json when identity phrases not found", async () => {
    mockRunSpecialistSession.mockResolvedValue({ hatchedAgentName: null })

    const { runAdoptionSpecialist } = await import("../../../heart/daemon/specialist-orchestrator")
    const deps = makeDeps()

    // agent.json with base phrases but no matching identity
    fs.writeFileSync(
      path.join(deps.bundleSourceDir, "agent.json"),
      JSON.stringify({
        phrases: { thinking: ["base thinking"], tool: ["base tool"], followup: ["base followup"] },
        identityPhrases: {
          nonexistent: { thinking: ["nope"], tool: ["nope"], followup: ["nope"] },
        },
      }),
    )

    await runAdoptionSpecialist(deps)

    const overrideConfig = mockSetAgentConfigOverride.mock.calls[0][0]
    expect(overrideConfig.phrases.thinking).toContain("base thinking")
  })

  it("falls back to DEFAULT_AGENT_PHRASES when agent.json is missing", async () => {
    mockRunSpecialistSession.mockResolvedValue({ hatchedAgentName: null })

    const { runAdoptionSpecialist } = await import("../../../heart/daemon/specialist-orchestrator")
    const deps = makeDeps()
    // No agent.json written — should fall back to defaults

    await runAdoptionSpecialist(deps)

    const overrideConfig = mockSetAgentConfigOverride.mock.calls[0][0]
    expect(overrideConfig.phrases.thinking).toContain("working")
  })

  it("falls back to DEFAULT_AGENT_PHRASES when base phrases are incomplete", async () => {
    mockRunSpecialistSession.mockResolvedValue({ hatchedAgentName: null })

    const { runAdoptionSpecialist } = await import("../../../heart/daemon/specialist-orchestrator")
    const deps = makeDeps()
    // agent.json with incomplete base phrases (missing followup) and no matching identity
    fs.writeFileSync(
      path.join(deps.bundleSourceDir, "agent.json"),
      JSON.stringify({
        phrases: { thinking: ["partial"], tool: ["partial"] },
        identityPhrases: {},
      }),
    )

    await runAdoptionSpecialist(deps)

    const overrideConfig = mockSetAgentConfigOverride.mock.calls[0][0]
    expect(overrideConfig.phrases.thinking).toContain("working")
  })

  it("falls back to DEFAULT_AGENT_PHRASES when agent.json is malformed", async () => {
    mockRunSpecialistSession.mockResolvedValue({ hatchedAgentName: null })

    const { runAdoptionSpecialist } = await import("../../../heart/daemon/specialist-orchestrator")
    const deps = makeDeps()
    fs.writeFileSync(path.join(deps.bundleSourceDir, "agent.json"), "not-json{{{")

    await runAdoptionSpecialist(deps)

    const overrideConfig = mockSetAgentConfigOverride.mock.calls[0][0]
    expect(overrideConfig.phrases.thinking).toContain("working")
  })

  it("wires execTool lambda to execSpecialistTool with correct deps", async () => {
    // Capture the session deps to invoke the execTool lambda
    mockRunSpecialistSession.mockImplementation(async (sessionDeps: any) => {
      // Invoke the execTool lambda that the orchestrator passed in
      await sessionDeps.execTool("read_file", { path: "/tmp/test.txt" })
      return { hatchedAgentName: null }
    })

    const { runAdoptionSpecialist } = await import("../../../heart/daemon/specialist-orchestrator")
    const deps = makeDeps()

    await runAdoptionSpecialist(deps)

    // execSpecialistTool should have been called with correct arguments
    expect(mockExecSpecialistTool).toHaveBeenCalledWith(
      "read_file",
      { path: "/tmp/test.txt" },
      expect.objectContaining({
        humanName: "Ari",
        provider: "anthropic",
        credentials: { setupToken: "test-token" },
        bundlesRoot: deps.bundlesRoot,
        secretsRoot: deps.secretsRoot,
      }),
    )
  })
})
