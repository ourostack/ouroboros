import { describe, it, expect, vi } from "vitest"

vi.mock("../../nerves/runtime", () => ({
  emitNervesEvent: vi.fn(),
}))

import { resolveVaultConfig, DEFAULT_VAULT_SERVER_URL } from "../../heart/identity"

describe("resolveVaultConfig", () => {
  it("returns defaults when vault config is undefined", () => {
    const result = resolveVaultConfig("ouroboros", undefined)
    expect(result.email).toBe("ouroboros@ouro.bot")
    expect(result.serverUrl).toBe(DEFAULT_VAULT_SERVER_URL)
    expect(result.serverUrl).toBe("https://vault.ouroboros.bot")
  })

  it("uses email from config when provided", () => {
    const result = resolveVaultConfig("ouroboros", { email: "custom@ouro.bot" })
    expect(result.email).toBe("custom@ouro.bot")
  })

  it("uses serverUrl from config when provided", () => {
    const result = resolveVaultConfig("ouroboros", { email: "x@y.com", serverUrl: "https://custom.vault.example" })
    expect(result.serverUrl).toBe("https://custom.vault.example")
  })

  it("normalizes known legacy vault hosts and trailing slashes to the canonical host", () => {
    const shortHost = resolveVaultConfig("ouroboros", { email: "x@y.com", serverUrl: "https://vault.ouro.bot/" })
    expect(shortHost.serverUrl).toBe(DEFAULT_VAULT_SERVER_URL)

    const legacyAzureHost = resolveVaultConfig("ouroboros", {
      email: "x@y.com",
      serverUrl: "https://ouro-vault.gentleflower-74452a1e.eastus2.azurecontainerapps.io",
    })
    expect(legacyAzureHost.serverUrl).toBe(DEFAULT_VAULT_SERVER_URL)
  })

  it("falls back to defaults for missing fields", () => {
    const result = resolveVaultConfig("slugger", { email: "slugger@ouro.bot" })
    expect(result.serverUrl).toBe(DEFAULT_VAULT_SERVER_URL)
  })

  it("derives email from agent name when not configured", () => {
    const result = resolveVaultConfig("my-agent", undefined)
    expect(result.email).toBe("my-agent@ouro.bot")
  })

  it("normalizes derived vault emails for stable account identity", () => {
    const result = resolveVaultConfig("Slugger Prime!", undefined)
    expect(result.email).toBe("slugger-prime@ouro.bot")
  })
})
