import { describe, expect, it, vi } from "vitest"
import * as fs from "fs"
import * as path from "path"

import { checkAgentConfig } from "../../../heart/daemon/agent-config-check"

vi.mock("fs")
vi.mock("../../../heart/identity", async () => {
  const actual = await vi.importActual<typeof import("../../../heart/identity")>("../../../heart/identity")
  return {
    ...actual,
    PROVIDER_CREDENTIALS: {
      azure: ["apiKey", "endpoint", "deployment"],
      minimax: ["apiKey"],
      anthropic: ["setupToken"],
      "openai-codex": ["oauthAccessToken"],
      "github-copilot": ["githubToken", "baseUrl"],
    },
  }
})

const mockReadFileSync = vi.mocked(fs.readFileSync)

const BUNDLES = "/bundles"
const SECRETS = "/secrets"

function agentJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({ humanFacing: { provider: "anthropic" }, ...overrides })
}

function secretsJson(provider: string, fields: Record<string, string>): string {
  return JSON.stringify({ providers: { [provider]: fields } })
}

describe("checkAgentConfig", () => {
  it("returns ok when agent.json and secrets are valid", () => {
    mockReadFileSync
      .mockReturnValueOnce(agentJson()) // agent.json
      .mockReturnValueOnce(secretsJson("anthropic", { setupToken: "tok" })) // secrets.json

    const result = checkAgentConfig("myagent", BUNDLES, SECRETS)
    expect(result).toEqual({ ok: true })
  })

  it("returns error when agent.json is missing", () => {
    mockReadFileSync.mockImplementationOnce(() => { throw new Error("ENOENT") })

    const result = checkAgentConfig("myagent", BUNDLES, SECRETS)
    expect(result.ok).toBe(false)
    expect(result.error).toContain("agent.json not found")
    expect(result.fix).toContain("ouro hatch")
  })

  it("returns error when agent.json is invalid JSON", () => {
    mockReadFileSync.mockReturnValueOnce("not json{{{")

    const result = checkAgentConfig("myagent", BUNDLES, SECRETS)
    expect(result.ok).toBe(false)
    expect(result.error).toContain("invalid JSON")
  })

  it("returns ok when agent is disabled", () => {
    mockReadFileSync.mockReturnValueOnce(JSON.stringify({ enabled: false }))

    const result = checkAgentConfig("myagent", BUNDLES, SECRETS)
    expect(result).toEqual({ ok: true })
  })

  it("returns error when no provider configured", () => {
    mockReadFileSync.mockReturnValueOnce(JSON.stringify({}))

    const result = checkAgentConfig("myagent", BUNDLES, SECRETS)
    expect(result.ok).toBe(false)
    expect(result.error).toContain("no provider configured")
  })

  it("returns error for unknown provider", () => {
    mockReadFileSync.mockReturnValueOnce(agentJson({ humanFacing: { provider: "fake-provider" } }))

    const result = checkAgentConfig("myagent", BUNDLES, SECRETS)
    expect(result.ok).toBe(false)
    expect(result.error).toContain("Unknown provider")
  })

  it("returns error when secrets.json is missing", () => {
    mockReadFileSync
      .mockReturnValueOnce(agentJson())
      .mockImplementationOnce(() => { throw new Error("ENOENT") })

    const result = checkAgentConfig("myagent", BUNDLES, SECRETS)
    expect(result.ok).toBe(false)
    expect(result.error).toContain("secrets.json not found")
    expect(result.fix).toContain("ouro auth")
  })

  it("returns error when provider section is missing from secrets", () => {
    mockReadFileSync
      .mockReturnValueOnce(agentJson())
      .mockReturnValueOnce(JSON.stringify({ providers: {} }))

    const result = checkAgentConfig("myagent", BUNDLES, SECRETS)
    expect(result.ok).toBe(false)
    expect(result.error).toContain("missing providers.anthropic")
  })

  it("returns error when required fields are missing", () => {
    mockReadFileSync
      .mockReturnValueOnce(agentJson())
      .mockReturnValueOnce(secretsJson("anthropic", {}))

    const result = checkAgentConfig("myagent", BUNDLES, SECRETS)
    expect(result.ok).toBe(false)
    expect(result.error).toContain("missing required anthropic credentials: setupToken")
  })

  it("returns error when required fields are empty strings", () => {
    mockReadFileSync
      .mockReturnValueOnce(agentJson())
      .mockReturnValueOnce(secretsJson("anthropic", { setupToken: "" }))

    const result = checkAgentConfig("myagent", BUNDLES, SECRETS)
    expect(result.ok).toBe(false)
    expect(result.error).toContain("setupToken")
  })

  it("falls back to config.provider when humanFacing.provider is absent", () => {
    mockReadFileSync
      .mockReturnValueOnce(JSON.stringify({ provider: "minimax" }))
      .mockReturnValueOnce(secretsJson("minimax", { apiKey: "key123" }))

    const result = checkAgentConfig("myagent", BUNDLES, SECRETS)
    expect(result).toEqual({ ok: true })
  })

  it("accepts azure managed identity (no apiKey needed)", () => {
    mockReadFileSync
      .mockReturnValueOnce(agentJson({ humanFacing: { provider: "azure" } }))
      .mockReturnValueOnce(secretsJson("azure", {
        endpoint: "https://my.openai.azure.com",
        deployment: "gpt-4",
        managedIdentityClientId: "abc-123",
      }))

    const result = checkAgentConfig("myagent", BUNDLES, SECRETS)
    expect(result).toEqual({ ok: true })
  })

  it("requires apiKey for azure without managed identity", () => {
    mockReadFileSync
      .mockReturnValueOnce(agentJson({ humanFacing: { provider: "azure" } }))
      .mockReturnValueOnce(secretsJson("azure", {
        endpoint: "https://my.openai.azure.com",
        deployment: "gpt-4",
      }))

    const result = checkAgentConfig("myagent", BUNDLES, SECRETS)
    expect(result.ok).toBe(false)
    expect(result.error).toContain("apiKey")
  })

  it("validates github-copilot requires both githubToken and baseUrl", () => {
    mockReadFileSync
      .mockReturnValueOnce(agentJson({ humanFacing: { provider: "github-copilot" } }))
      .mockReturnValueOnce(secretsJson("github-copilot", { githubToken: "tok" }))

    const result = checkAgentConfig("myagent", BUNDLES, SECRETS)
    expect(result.ok).toBe(false)
    expect(result.error).toContain("baseUrl")
  })

  it("reads from correct file paths", () => {
    mockReadFileSync
      .mockReturnValueOnce(agentJson())
      .mockReturnValueOnce(secretsJson("anthropic", { setupToken: "tok" }))

    checkAgentConfig("slugger", BUNDLES, SECRETS)

    expect(mockReadFileSync).toHaveBeenCalledWith(
      path.join(BUNDLES, "slugger.ouro", "agent.json"),
      "utf-8",
    )
    expect(mockReadFileSync).toHaveBeenCalledWith(
      path.join(SECRETS, "slugger", "secrets.json"),
      "utf-8",
    )
  })
})
