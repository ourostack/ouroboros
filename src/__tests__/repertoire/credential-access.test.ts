import { beforeEach, describe, expect, it, vi } from "vitest"

const mockEmitNervesEvent = vi.fn()
vi.mock("../../nerves/runtime", () => ({
  emitNervesEvent: (...args: unknown[]) => mockEmitNervesEvent(...args),
}))

const mockClearVaultUnlockSecret = vi.fn()
const mockNoteVaultUnlockSelfHeal = vi.fn()
const mockReadVaultUnlockSecret = vi.fn(() => ({ secret: "unlock-secret" }))
const mockStoreVaultUnlockSecret = vi.fn()
vi.mock("../../repertoire/vault-unlock", () => ({
  clearVaultUnlockSecret: (...args: unknown[]) => mockClearVaultUnlockSecret(...args),
  credentialVaultNotConfiguredError: (agentName: string, configPath: string) =>
    `credential vault is not configured in ${configPath}. Run 'ouro vault create --agent ${agentName}' to create this agent's vault before loading or storing credentials.`,
  noteVaultUnlockSelfHeal: (...args: unknown[]) => mockNoteVaultUnlockSelfHeal(...args),
  readVaultUnlockSecret: (...args: unknown[]) => mockReadVaultUnlockSecret(...args),
  storeVaultUnlockSecret: (...args: unknown[]) => mockStoreVaultUnlockSecret(...args),
}))

const mockReadFileSync = vi.fn()
vi.mock("node:fs", () => ({
  readFileSync: (...args: unknown[]) => mockReadFileSync(...args),
}))

const mockHomedir = vi.fn(() => "/home/tester")
vi.mock("node:os", () => ({
  homedir: () => mockHomedir(),
}))

const mockBitwardenCtor = vi.fn()
const mockBitwardenGet = vi.fn(async () => null)
vi.mock("../../repertoire/bitwarden-store", () => ({
  BitwardenCredentialStore: class MockBitwardenCredentialStore {
    constructor(...args: unknown[]) {
      mockBitwardenCtor(...args)
    }
    get = (...args: unknown[]) => mockBitwardenGet(...args)
    getRawSecret = vi.fn()
    store = vi.fn()
    list = vi.fn()
    delete = vi.fn()
    isReady = vi.fn(() => true)
  },
}))

const mockGetAgentName = vi.fn(() => "slugger")
const mockGetAgentRoot = vi.fn((agentName?: string) => `/bundles/${agentName ?? "slugger"}.ouro`)
vi.mock("../../heart/identity", async () => {
  const actual = await vi.importActual<typeof import("../../heart/identity")>("../../heart/identity")
  return {
    ...actual,
    getAgentName: () => mockGetAgentName(),
    getAgentRoot: (agentName?: string) => mockGetAgentRoot(agentName),
  }
})

import { getCredentialStore, probeCredentialVaultAccess, resetCredentialStore } from "../../repertoire/credential-access"

describe("credential access", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetCredentialStore()
    mockGetAgentName.mockReturnValue("slugger")
    mockGetAgentRoot.mockImplementation((agentName?: string) => `/bundles/${agentName ?? "slugger"}.ouro`)
    mockReadFileSync.mockImplementation((filePath: unknown) => {
      if (String(filePath).endsWith("/agent.json")) {
        return JSON.stringify({
          vault: { email: "custom@ouro.bot", serverUrl: "https://custom.vault" },
        })
      }
      throw new Error("ENOENT")
    })
  })

  it("creates a Bitwarden store from the agent vault config and local unlock secret", () => {
    const store = getCredentialStore("slugger")

    expect(store.isReady()).toBe(true)
    expect(mockReadVaultUnlockSecret).toHaveBeenCalledWith({
      agentName: "slugger",
      email: "custom@ouro.bot",
      serverUrl: "https://custom.vault",
    })
    expect(mockBitwardenCtor).toHaveBeenCalledWith(
      "https://custom.vault",
      "custom@ouro.bot",
      "unlock-secret",
      expect.objectContaining({
        appDataDir: expect.stringContaining("/home/tester/.ouro-cli/bitwarden/"),
      }),
    )
    expect(mockEmitNervesEvent).toHaveBeenCalledWith(expect.objectContaining({
      event: "repertoire.credential_store_init",
      meta: expect.objectContaining({
        backend: "bitwarden",
        agentName: "slugger",
        serverUrl: "https://custom.vault",
        email: "custom@ouro.bot",
      }),
    }))
  })

  it("fails fast when agent.json has no vault section yet", () => {
    mockReadFileSync.mockReturnValue(JSON.stringify({ version: 2 }))

    expect(() => getCredentialStore("ouroboros")).toThrow(
      "credential vault is not configured in /bundles/ouroboros.ouro/agent.json. Run 'ouro vault create --agent ouroboros' to create this agent's vault before loading or storing credentials.",
    )
    expect(mockReadVaultUnlockSecret).not.toHaveBeenCalled()
  })

  it("caches stores by agent and vault coordinates until reset", () => {
    const first = getCredentialStore("slugger")
    const second = getCredentialStore("slugger")
    expect(second).toBe(first)
    expect(mockBitwardenCtor).toHaveBeenCalledTimes(1)

    resetCredentialStore()
    const third = getCredentialStore("slugger")
    expect(third).not.toBe(first)
    expect(mockBitwardenCtor).toHaveBeenCalledTimes(2)
  })

  it("probes a candidate unlock secret without reading or replacing the local unlock store", async () => {
    await probeCredentialVaultAccess("slugger", "candidate-unlock", { homeDir: "/tmp/ouro-home" })

    expect(mockReadVaultUnlockSecret).not.toHaveBeenCalled()
    expect(mockBitwardenCtor).toHaveBeenCalledWith(
      "https://custom.vault",
      "custom@ouro.bot",
      "candidate-unlock",
      expect.objectContaining({
        appDataDir: expect.stringContaining("/tmp/ouro-home/.ouro-cli/bitwarden/"),
      }),
    )
    expect(mockBitwardenGet).toHaveBeenCalledWith("__ouro_vault_probe__")
  })

  it("clears a rejected source unlock entry and evicts the cached store", async () => {
    mockReadVaultUnlockSecret.mockReturnValueOnce({
      secret: "unlock-secret",
      source: { email: "custom@ouro.bot", serverUrl: "https://vault.ouro.bot" },
    })
    getCredentialStore("slugger")

    const options = mockBitwardenCtor.mock.calls[0][3] as {
      onInvalidUnlockSecret: (error: Error) => void | Promise<void>
    }
    await options.onInvalidUnlockSecret(new Error("bw CLI rejected the saved vault unlock secret for this machine"))
    await options.onInvalidUnlockSecret(new Error("bw CLI rejected the saved vault unlock secret for this machine"))

    expect(mockClearVaultUnlockSecret).toHaveBeenCalledWith({
      agentName: "slugger",
      email: "custom@ouro.bot",
      serverUrl: "https://vault.ouro.bot",
    })
    expect(mockClearVaultUnlockSecret).toHaveBeenCalledTimes(1)
    expect(mockEmitNervesEvent).toHaveBeenCalledWith(expect.objectContaining({
      event: "repertoire.credential_store_invalid_unlock_cleared",
      meta: expect.objectContaining({ sourceServerUrl: "https://vault.ouro.bot" }),
    }))

    getCredentialStore("slugger")
    expect(mockBitwardenCtor).toHaveBeenCalledTimes(2)
  })

  it("canonicalizes legacy unlock material only after a successful vault login", async () => {
    mockReadVaultUnlockSecret.mockReturnValueOnce({
      secret: "unlock-secret",
      store: { kind: "macos-keychain", secure: true, location: "macOS Keychain" },
      source: { email: "custom@ouro.bot", serverUrl: "https://vault.ouro.bot" },
    })
    getCredentialStore("slugger")

    const options = mockBitwardenCtor.mock.calls[0][3] as {
      onLoginSuccess: () => void | Promise<void>
    }
    await options.onLoginSuccess()
    await options.onLoginSuccess()

    expect(mockStoreVaultUnlockSecret).toHaveBeenCalledWith({
      agentName: "slugger",
      email: "custom@ouro.bot",
      serverUrl: "https://custom.vault",
    }, "unlock-secret")
    expect(mockStoreVaultUnlockSecret).toHaveBeenCalledTimes(1)
    expect(mockNoteVaultUnlockSelfHeal).toHaveBeenCalledWith(
      expect.objectContaining({ serverUrl: "https://custom.vault" }),
      "macos-keychain",
      "https://vault.ouro.bot",
    )
  })

  it("keeps successful vault login alive when canonical unlock rewrite fails", async () => {
    mockReadVaultUnlockSecret.mockReturnValueOnce({
      secret: "unlock-secret",
      store: { kind: "macos-keychain", secure: true, location: "macOS Keychain" },
      source: { email: "custom@ouro.bot", serverUrl: "https://vault.ouro.bot" },
    })
    mockStoreVaultUnlockSecret.mockImplementationOnce(() => {
      throw new Error("keychain denied")
    })
    getCredentialStore("slugger")

    const options = mockBitwardenCtor.mock.calls[0][3] as {
      onLoginSuccess: () => void | Promise<void>
    }
    await options.onLoginSuccess()

    expect(mockEmitNervesEvent).toHaveBeenCalledWith(expect.objectContaining({
      event: "repertoire.vault_unlock_self_heal_failed",
      meta: expect.objectContaining({
        sourceServerUrl: "https://vault.ouro.bot",
        error: "keychain denied",
      }),
    }))
  })

  it("does not rewrite canonical unlock material that was already canonical", async () => {
    mockReadVaultUnlockSecret.mockReturnValueOnce({
      secret: "unlock-secret",
      store: { kind: "macos-keychain", secure: true, location: "macOS Keychain" },
      source: { email: "custom@ouro.bot", serverUrl: "https://custom.vault" },
    })
    getCredentialStore("slugger")

    const options = mockBitwardenCtor.mock.calls[0][3] as {
      onLoginSuccess: () => void | Promise<void>
    }
    await options.onLoginSuccess()

    expect(mockStoreVaultUnlockSecret).not.toHaveBeenCalled()
    expect(mockNoteVaultUnlockSelfHeal).not.toHaveBeenCalled()
  })

  it("reports non-Error canonical unlock rewrite failures", async () => {
    mockReadVaultUnlockSecret.mockReturnValueOnce({
      secret: "unlock-secret",
      store: { kind: "macos-keychain", secure: true, location: "macOS Keychain" },
      source: { email: "custom@ouro.bot", serverUrl: "https://vault.ouro.bot" },
    })
    mockStoreVaultUnlockSecret.mockImplementationOnce(() => {
      throw "keychain denied"
    })
    getCredentialStore("slugger")

    const options = mockBitwardenCtor.mock.calls[0][3] as {
      onLoginSuccess: () => void | Promise<void>
    }
    await options.onLoginSuccess()

    expect(mockEmitNervesEvent).toHaveBeenCalledWith(expect.objectContaining({
      event: "repertoire.vault_unlock_self_heal_failed",
      meta: expect.objectContaining({ error: "keychain denied" }),
    }))
  })

  it("fails fast when probing an agent with no vault section", async () => {
    mockReadFileSync.mockReturnValue(JSON.stringify({ version: 2 }))

    await expect(probeCredentialVaultAccess("slugger", "candidate-unlock")).rejects.toThrow(
      "credential vault is not configured in /bundles/slugger.ouro/agent.json. Run 'ouro vault create --agent slugger' to create this agent's vault before loading or storing credentials.",
    )
    expect(mockBitwardenCtor).not.toHaveBeenCalled()
  })

  it("uses the current agent name when no agent is supplied", () => {
    mockGetAgentName.mockReturnValue("current-agent")
    mockReadFileSync.mockReturnValue(JSON.stringify({
      version: 2,
      vault: { email: "current-agent@ouro.bot" },
    }))

    getCredentialStore()

    expect(mockReadVaultUnlockSecret).toHaveBeenCalledWith(expect.objectContaining({
      agentName: "current-agent",
      email: "current-agent@ouro.bot",
    }))
  })

  it("does not create a persistent vault for SerpentGuide", () => {
    expect(() => getCredentialStore("SerpentGuide")).toThrow(/does not have a persistent credential vault/)
    expect(mockBitwardenCtor).not.toHaveBeenCalled()
  })
})
