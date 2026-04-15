import { beforeEach, describe, expect, it, vi } from "vitest"

const mockEmitNervesEvent = vi.fn()
vi.mock("../../nerves/runtime", () => ({
  emitNervesEvent: (...args: unknown[]) => mockEmitNervesEvent(...args),
}))

const mockReadVaultUnlockSecret = vi.fn(() => ({ secret: "unlock-secret" }))
vi.mock("../../repertoire/vault-unlock", () => ({
  readVaultUnlockSecret: (...args: unknown[]) => mockReadVaultUnlockSecret(...args),
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
vi.mock("../../repertoire/bitwarden-store", () => ({
  BitwardenCredentialStore: class MockBitwardenCredentialStore {
    constructor(...args: unknown[]) {
      mockBitwardenCtor(...args)
    }
    get = vi.fn()
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

import { getCredentialStore, resetCredentialStore } from "../../repertoire/credential-access"

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

  it("defaults the vault coordinates from the agent name when agent.json has no vault section", () => {
    mockReadFileSync.mockReturnValue(JSON.stringify({ version: 2 }))

    getCredentialStore("ouroboros")

    expect(mockReadVaultUnlockSecret).toHaveBeenCalledWith({
      agentName: "ouroboros",
      email: "ouroboros@ouro.bot",
      serverUrl: "https://vault.ouroboros.bot",
    })
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

  it("uses the current agent name when no agent is supplied", () => {
    mockGetAgentName.mockReturnValue("current-agent")
    mockReadFileSync.mockReturnValue(JSON.stringify({ version: 2 }))

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
