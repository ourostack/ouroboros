import { describe, expect, it } from "vitest"

import { isAgentProvider } from "../../heart/daemon/cli-parse"
import { PROVIDER_CREDENTIALS, type AgentProvider } from "../../heart/identity"
import { DEFAULT_PROVIDER_MODELS, getProviderDisplayName, isModelClearlyIncompatibleWithProvider } from "../../heart/provider-models"
import { splitProviderCredentialFields } from "../../heart/provider-credentials"
import { collectRuntimeAuthCredentials } from "../../heart/auth/auth-flow"

describe("Sanctuary provider identities", () => {
  it("registers distinct GLM and Gemini OpenAI-compatible identities", () => {
    const glm: AgentProvider = "openai-compatible"
    const gemini: AgentProvider = "openai-compatible-gemini"
    expect(isAgentProvider(glm)).toBe(true)
    expect(isAgentProvider(gemini)).toBe(true)
    expect(PROVIDER_CREDENTIALS[glm].required).toEqual(["apiKey", "baseUrl"])
    expect(PROVIDER_CREDENTIALS[gemini].required).toEqual(["apiKey", "baseUrl"])
  })

  it("locks default models and provider/model compatibility", () => {
    expect(DEFAULT_PROVIDER_MODELS["openai-compatible"]).toBe("glm-5.2")
    expect(DEFAULT_PROVIDER_MODELS["openai-compatible-gemini"]).toBe("gemini-3.6-flash")
    expect(getProviderDisplayName("openai-compatible")).toBe("Z.ai OpenAI-compatible")
    expect(getProviderDisplayName("openai-compatible-gemini")).toBe("Gemini OpenAI-compatible")
    expect(isModelClearlyIncompatibleWithProvider("openai-compatible", "glm-5.2")).toBe(false)
    expect(isModelClearlyIncompatibleWithProvider("openai-compatible", "gemini-3.6-flash")).toBe(true)
    expect(isModelClearlyIncompatibleWithProvider("openai-compatible-gemini", "gemini-3.6-flash")).toBe(false)
    expect(isModelClearlyIncompatibleWithProvider("openai-compatible-gemini", "glm-5.2")).toBe(true)
  })

  it("stores the key as secret credential material and the base URL as provider config", () => {
    expect(splitProviderCredentialFields("openai-compatible", { apiKey: "secret", baseUrl: "https://api.z.ai/api/paas/v4/", ignored: "x" })).toEqual({
      credentials: { apiKey: "secret" },
      config: { baseUrl: "https://api.z.ai/api/paas/v4/" },
    })
    expect(splitProviderCredentialFields("openai-compatible-gemini", { apiKey: "secret", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai/" })).toEqual({
      credentials: { apiKey: "secret" },
      config: { baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai/" },
    })
  })

  it.each([
    ["openai-compatible", "Z.ai API key: ", "https://api.z.ai/api/paas/v4/"],
    ["openai-compatible-gemini", "Gemini API key: ", "https://generativelanguage.googleapis.com/v1beta/openai/"],
  ] as const)("collects %s keys only through hidden input", async (provider, promptLabel, baseUrl) => {
    let asked = ""
    const credentials = await collectRuntimeAuthCredentials({
      agentName: "butler",
      provider,
      promptInput: async () => { throw new Error("visible prompt must not be used") },
      promptSecret: async (question) => { asked = question; return "private-key" },
    }, {})
    expect(asked).toBe(promptLabel)
    expect(credentials).toEqual({ apiKey: "private-key", baseUrl })
  })
})
