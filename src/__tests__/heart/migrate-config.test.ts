import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { emitNervesEvent } from "../../nerves/runtime"

function emitTestEvent(testName: string): void {
  emitNervesEvent({
    component: "config/identity",
    event: "config_identity.test_run",
    message: testName,
    meta: { test: true },
  })
}

function makeTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `migrate-config-${prefix}-`))
}

function writeAgentJson(bundleRoot: string, config: Record<string, unknown>): void {
  fs.writeFileSync(path.join(bundleRoot, "agent.json"), JSON.stringify(config, null, 2) + "\n")
}

function readAgentJson(bundleRoot: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(bundleRoot, "agent.json"), "utf-8"))
}

function writeSecretsJson(secretsDir: string, config: Record<string, unknown>): void {
  fs.mkdirSync(secretsDir, { recursive: true })
  fs.writeFileSync(path.join(secretsDir, "secrets.json"), JSON.stringify(config, null, 2) + "\n")
}

function readSecretsJson(secretsDir: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(secretsDir, "secrets.json"), "utf-8"))
}

function setupV1Bundle(
  bundlesRoot: string,
  agentName: string,
  provider: string,
  secretsRoot: string,
  secrets?: Record<string, unknown>,
): string {
  const bundleRoot = path.join(bundlesRoot, `${agentName}.ouro`)
  fs.mkdirSync(bundleRoot, { recursive: true })
  writeAgentJson(bundleRoot, {
    version: 1,
    enabled: true,
    provider,
    context: { maxTokens: 80000, contextMargin: 20 },
    senses: { cli: { enabled: true }, teams: { enabled: false }, bluebubbles: { enabled: false } },
    phrases: { thinking: ["working"], tool: ["running tool"], followup: ["processing"] },
  })
  if (secrets) {
    writeSecretsJson(path.join(secretsRoot, agentName), secrets)
  }
  return bundleRoot
}

// We import the function dynamically so the test fails at call time, not import time
async function getMigrateFunction() {
  const mod = await import("../../heart/migrate-config")
  return mod.migrateAgentConfigV1ToV2
}

describe("migrateAgentConfigV1ToV2", () => {
  let tempDirs: string[] = []

  afterEach(() => {
    for (const dir of tempDirs) {
      fs.rmSync(dir, { recursive: true, force: true })
    }
    tempDirs = []
    vi.restoreAllMocks()
  })

  function temp(prefix: string): string {
    const dir = makeTempDir(prefix)
    tempDirs.push(dir)
    return dir
  }

  it("migrates v1 anthropic config to v2 with both facings", async () => {
    emitTestEvent("migrate v1 anthropic to v2")
    const bundlesRoot = temp("anthropic")
    const secretsRoot = temp("anthropic-secrets")
    const bundleRoot = setupV1Bundle(bundlesRoot, "TestAgent", "anthropic", secretsRoot, {
      providers: { anthropic: { model: "claude-opus-4-6", setupToken: "sk-ant-123" } },
    })

    const migrate = await getMigrateFunction()
    await migrate(bundleRoot, { secretsRoot })

    const config = readAgentJson(bundleRoot)
    expect(config.version).toBe(2)
    expect(config.humanFacing).toEqual({ provider: "anthropic", model: "claude-opus-4-6" })
    expect(config.agentFacing).toEqual({ provider: "anthropic", model: "claude-opus-4-6" })
    expect(config).not.toHaveProperty("provider")

    // Secrets should have model stripped
    const secrets = readSecretsJson(path.join(secretsRoot, "TestAgent"))
    expect((secrets.providers as any).anthropic).not.toHaveProperty("model")
    expect((secrets.providers as any).anthropic.setupToken).toBe("sk-ant-123")
  })

  it("is idempotent — already v2 config is untouched", async () => {
    emitTestEvent("migrate v2 idempotent")
    const bundlesRoot = temp("idempotent")
    const bundleRoot = path.join(bundlesRoot, "TestAgent.ouro")
    fs.mkdirSync(bundleRoot, { recursive: true })
    const v2Config = {
      version: 2,
      enabled: true,
      humanFacing: { provider: "anthropic", model: "claude-opus-4-6" },
      agentFacing: { provider: "minimax", model: "minimax-text-01" },
      phrases: { thinking: ["working"], tool: ["running tool"], followup: ["processing"] },
    }
    writeAgentJson(bundleRoot, v2Config)
    const originalContent = fs.readFileSync(path.join(bundleRoot, "agent.json"), "utf-8")

    const migrate = await getMigrateFunction()
    await migrate(bundleRoot)

    const afterContent = fs.readFileSync(path.join(bundleRoot, "agent.json"), "utf-8")
    expect(afterContent).toBe(originalContent)
  })

  it("handles missing secrets.json — writes v2 with empty model", async () => {
    emitTestEvent("migrate missing secrets")
    const bundlesRoot = temp("no-secrets")
    const secretsRoot = temp("no-secrets-home")
    const bundleRoot = setupV1Bundle(bundlesRoot, "NoSecrets", "anthropic", secretsRoot)
    // No secrets.json written

    const migrate = await getMigrateFunction()
    await migrate(bundleRoot, { secretsRoot })

    const config = readAgentJson(bundleRoot)
    expect(config.version).toBe(2)
    expect(config.humanFacing).toEqual({ provider: "anthropic", model: "" })
    expect(config.agentFacing).toEqual({ provider: "anthropic", model: "" })
  })

  it("handles empty model in secrets — writes v2 with empty model", async () => {
    emitTestEvent("migrate empty model")
    const bundlesRoot = temp("empty-model")
    const secretsRoot = temp("empty-model-secrets")
    const bundleRoot = setupV1Bundle(bundlesRoot, "EmptyModel", "anthropic", secretsRoot, {
      providers: { anthropic: { model: "", setupToken: "sk-ant-123" } },
    })

    const migrate = await getMigrateFunction()
    await migrate(bundleRoot, { secretsRoot })

    const config = readAgentJson(bundleRoot)
    expect(config.humanFacing).toEqual({ provider: "anthropic", model: "" })
  })

  it("reads azure modelName field (not model)", async () => {
    emitTestEvent("migrate azure modelName")
    const bundlesRoot = temp("azure")
    const secretsRoot = temp("azure-secrets")
    const bundleRoot = setupV1Bundle(bundlesRoot, "AzureAgent", "azure", secretsRoot, {
      providers: { azure: { modelName: "gpt-5.4", apiKey: "k", endpoint: "e", deployment: "d", apiVersion: "v" } },
    })

    const migrate = await getMigrateFunction()
    await migrate(bundleRoot, { secretsRoot })

    const config = readAgentJson(bundleRoot)
    expect(config.humanFacing).toEqual({ provider: "azure", model: "gpt-5.4" })
    expect(config.agentFacing).toEqual({ provider: "azure", model: "gpt-5.4" })

    // Secrets should have modelName stripped
    const secrets = readSecretsJson(path.join(secretsRoot, "AzureAgent"))
    expect((secrets.providers as any).azure).not.toHaveProperty("modelName")
    expect((secrets.providers as any).azure.apiKey).toBe("k")
  })

  it("migrates all 5 providers correctly", async () => {
    emitTestEvent("migrate all providers")
    const providers: Array<{ name: string; provider: string; modelField: string; modelValue: string; secrets: Record<string, unknown> }> = [
      { name: "AnthropicAgent", provider: "anthropic", modelField: "model", modelValue: "claude-opus-4-6", secrets: { model: "claude-opus-4-6", setupToken: "tok" } },
      { name: "AzureAgent", provider: "azure", modelField: "modelName", modelValue: "gpt-5.4", secrets: { modelName: "gpt-5.4", apiKey: "k", endpoint: "e", deployment: "d", apiVersion: "v" } },
      { name: "MinimaxAgent", provider: "minimax", modelField: "model", modelValue: "minimax-text-01", secrets: { model: "minimax-text-01", apiKey: "k" } },
      { name: "CodexAgent", provider: "openai-codex", modelField: "model", modelValue: "gpt-5.4", secrets: { model: "gpt-5.4", oauthAccessToken: "tok" } },
      { name: "CopilotAgent", provider: "github-copilot", modelField: "model", modelValue: "claude-sonnet-4.6", secrets: { model: "claude-sonnet-4.6", githubToken: "tok", baseUrl: "https://api.github.com" } },
    ]

    const migrate = await getMigrateFunction()

    for (const { name, provider, modelField, modelValue, secrets } of providers) {
      const bundlesRoot = temp(`all-${name}`)
      const secretsRoot = temp(`all-${name}-secrets`)
      const bundleRoot = setupV1Bundle(bundlesRoot, name, provider, secretsRoot, {
        providers: { [provider]: secrets },
      })

      await migrate(bundleRoot, { secretsRoot })

      const config = readAgentJson(bundleRoot)
      expect(config.humanFacing).toEqual({ provider, model: modelValue })
      expect(config.agentFacing).toEqual({ provider, model: modelValue })

      const secretsAfter = readSecretsJson(path.join(secretsRoot, name))
      expect((secretsAfter.providers as any)[provider]).not.toHaveProperty(modelField)
    }
  })

  it("preserves all other agent.json fields", async () => {
    emitTestEvent("migrate preserves agent fields")
    const bundlesRoot = temp("preserve-agent")
    const secretsRoot = temp("preserve-agent-secrets")
    const bundleRoot = setupV1Bundle(bundlesRoot, "PreserveAgent", "anthropic", secretsRoot, {
      providers: { anthropic: { model: "claude-opus-4-6", setupToken: "tok" } },
    })

    const migrate = await getMigrateFunction()
    await migrate(bundleRoot, { secretsRoot })

    const config = readAgentJson(bundleRoot)
    expect(config.enabled).toBe(true)
    expect(config.context).toEqual({ maxTokens: 80000, contextMargin: 20 })
    expect(config.senses).toEqual({ cli: { enabled: true }, teams: { enabled: false }, bluebubbles: { enabled: false } })
    expect(config.phrases).toEqual({ thinking: ["working"], tool: ["running tool"], followup: ["processing"] })
  })

  it("preserves all other secrets.json fields", async () => {
    emitTestEvent("migrate preserves secrets fields")
    const bundlesRoot = temp("preserve-secrets")
    const secretsRoot = temp("preserve-secrets-home")
    const bundleRoot = setupV1Bundle(bundlesRoot, "PreserveSecrets", "anthropic", secretsRoot, {
      providers: { anthropic: { model: "claude-opus-4-6", setupToken: "tok" } },
      teams: { clientId: "abc", clientSecret: "def", tenantId: "ghi", managedIdentityClientId: "" },
      integrations: { perplexityApiKey: "pplx-123" },
    })

    const migrate = await getMigrateFunction()
    await migrate(bundleRoot, { secretsRoot })

    const secrets = readSecretsJson(path.join(secretsRoot, "PreserveSecrets"))
    expect((secrets as any).teams.clientId).toBe("abc")
    expect((secrets as any).integrations.perplexityApiKey).toBe("pplx-123")
  })

  it("migrates v1 config with no provider field, defaults humanFacing/agentFacing to anthropic", async () => {
    emitTestEvent("migrate v1 no provider defaults to anthropic")
    const bundlesRoot = temp("no-provider")
    const bundleRoot = path.join(bundlesRoot, "NoProvider.ouro")
    fs.mkdirSync(bundleRoot, { recursive: true })
    writeAgentJson(bundleRoot, {
      version: 1,
      enabled: true,
    })

    const migrate = await getMigrateFunction()
    await migrate(bundleRoot)

    const config = readAgentJson(bundleRoot)
    expect(config.version).toBe(2)
    expect(config.humanFacing).toEqual({ provider: "anthropic", model: "" })
    expect(config.agentFacing).toEqual({ provider: "anthropic", model: "" })
    expect(config.provider).toBeUndefined()
  })

  it("migrates config when version field is missing (treated as v1)", async () => {
    emitTestEvent("migrate no version field")
    const bundlesRoot = temp("no-version")
    const bundleRoot = path.join(bundlesRoot, "NoVersion.ouro")
    fs.mkdirSync(bundleRoot, { recursive: true })
    writeAgentJson(bundleRoot, {
      enabled: true,
      provider: "anthropic",
    })

    const migrate = await getMigrateFunction()
    await migrate(bundleRoot)

    const config = readAgentJson(bundleRoot)
    expect(config.version).toBe(2)
    expect(config.humanFacing).toEqual({ provider: "anthropic", model: "" })
  })

  it("handles provider secrets with no model field (non-string rawModel)", async () => {
    emitTestEvent("migrate non-string model in secrets")
    const bundlesRoot = temp("nonstring-model")
    const secretsRoot = temp("nonstring-model-secrets")
    const bundleRoot = path.join(bundlesRoot, "NonStringModel.ouro")
    fs.mkdirSync(bundleRoot, { recursive: true })
    writeAgentJson(bundleRoot, {
      version: 1,
      enabled: true,
      provider: "anthropic",
    })
    writeSecretsJson(path.join(secretsRoot, "NonStringModel"), {
      providers: { anthropic: { model: 12345, setupToken: "tok" } },
    })

    const migrate = await getMigrateFunction()
    await migrate(bundleRoot, { secretsRoot })

    const config = readAgentJson(bundleRoot)
    expect(config.humanFacing).toEqual({ provider: "anthropic", model: "" })
  })

  it("handles provider entry missing from secrets providers map", async () => {
    emitTestEvent("migrate missing provider secrets entry")
    const bundlesRoot = temp("missing-provider-entry")
    const secretsRoot = temp("missing-provider-entry-secrets")
    const bundleRoot = path.join(bundlesRoot, "MissingEntry.ouro")
    fs.mkdirSync(bundleRoot, { recursive: true })
    writeAgentJson(bundleRoot, {
      version: 1,
      enabled: true,
      provider: "anthropic",
    })
    writeSecretsJson(path.join(secretsRoot, "MissingEntry"), {
      providers: { minimax: { model: "MiniMax-Text-01", apiKey: "key" } },
    })

    const migrate = await getMigrateFunction()
    await migrate(bundleRoot, { secretsRoot })

    const config = readAgentJson(bundleRoot)
    expect(config.humanFacing).toEqual({ provider: "anthropic", model: "" })
  })

  it("skips when version is explicitly set to 2 as a number", async () => {
    emitTestEvent("migrate skip v2 numeric version")
    const bundlesRoot = temp("skip-v2-numeric")
    const bundleRoot = path.join(bundlesRoot, "AlreadyV2.ouro")
    fs.mkdirSync(bundleRoot, { recursive: true })
    writeAgentJson(bundleRoot, {
      version: 2,
      enabled: true,
      humanFacing: { provider: "anthropic", model: "claude-opus-4-6" },
      agentFacing: { provider: "anthropic", model: "claude-opus-4-6" },
    })

    const migrate = await getMigrateFunction()
    await migrate(bundleRoot)

    const config = readAgentJson(bundleRoot)
    expect(config.version).toBe(2)
    expect(config.humanFacing).toEqual({ provider: "anthropic", model: "claude-opus-4-6" })
  })
})
