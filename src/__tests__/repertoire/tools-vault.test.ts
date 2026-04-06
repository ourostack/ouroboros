import { describe, it, expect, vi, beforeEach } from "vitest"

// Track nerves events
const nervesEvents: Array<Record<string, unknown>> = []
vi.mock("../../nerves/runtime", () => ({
  emitNervesEvent: vi.fn((event: Record<string, unknown>) => {
    nervesEvents.push(event)
  }),
}))

// Mock identity
const mockGetAgentName = vi.fn().mockReturnValue("ouroboros")
const mockLoadAgentConfig = vi.fn().mockReturnValue({
  vault: { email: "ouroboros@ouro.bot", serverUrl: "https://vault.ouro.bot" },
})

vi.mock("../../heart/identity", () => ({
  getAgentName: () => mockGetAgentName(),
  loadAgentConfig: () => mockLoadAgentConfig(),
  resolveVaultConfig: (name: string, config: any) => ({
    email: config?.email ?? `${name}@ouro.bot`,
    serverUrl: config?.serverUrl ?? "https://vault.ouro.bot",
  }),
  getAgentSecretsPath: (name: string) => `/tmp/.agentsecrets/${name}/secrets.json`,
}))

// Mock vault setup
const mockCreateVaultAccount = vi.fn()

vi.mock("../../repertoire/vault-setup", () => ({
  createVaultAccount: (...args: any[]) => mockCreateVaultAccount(...args),
}))

// Mock fs
const mockReadFileSync = vi.fn()
const mockWriteFileSync = vi.fn()
const mockExistsSync = vi.fn()
const mockMkdirSync = vi.fn()

vi.mock("node:fs", () => ({
  readFileSync: (...args: any[]) => mockReadFileSync(...args),
  writeFileSync: (...args: any[]) => mockWriteFileSync(...args),
  existsSync: (...args: any[]) => mockExistsSync(...args),
  mkdirSync: (...args: any[]) => mockMkdirSync(...args),
}))

import { vaultToolDefinitions } from "../../repertoire/tools-vault"

function findTool(name: string) {
  const def = vaultToolDefinitions.find((d) => d.tool.function.name === name)
  if (!def) throw new Error(`Tool "${name}" not found`)
  return def
}

describe("vault_setup tool", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    nervesEvents.length = 0
    mockExistsSync.mockReturnValue(true)
    mockReadFileSync.mockReturnValue(JSON.stringify({}))
    mockCreateVaultAccount.mockResolvedValue({
      success: true,
      email: "ouroboros@ouro.bot",
      serverUrl: "https://vault.ouro.bot",
    })
  })

  it("is registered with the correct name", () => {
    const tool = findTool("vault_setup")
    expect(tool.tool.function.name).toBe("vault_setup")
  })

  it("does not require confirmation", () => {
    const tool = findTool("vault_setup")
    expect(tool.confirmationRequired).toBeUndefined()
  })

  it("calls createVaultAccount with resolved config", async () => {
    const tool = findTool("vault_setup")
    await tool.handler({})

    expect(mockCreateVaultAccount).toHaveBeenCalledTimes(1)
    const [agentName, serverUrl, email, password] = mockCreateVaultAccount.mock.calls[0]
    expect(agentName).toBe("ouroboros")
    expect(serverUrl).toBe("https://vault.ouro.bot")
    expect(email).toBe("ouroboros@ouro.bot")
    expect(typeof password).toBe("string")
    expect(password.length).toBeGreaterThan(20) // random base64 password
  })

  it("stores master password in secrets.json", async () => {
    const tool = findTool("vault_setup")
    await tool.handler({})

    // Should write updated secrets.json
    expect(mockWriteFileSync).toHaveBeenCalled()
    const writeCall = mockWriteFileSync.mock.calls[0]
    expect(writeCall[0]).toContain("secrets.json")
    const written = JSON.parse(writeCall[1])
    expect(written.vault).toBeDefined()
    expect(written.vault.masterPassword).toBeDefined()
    expect(typeof written.vault.masterPassword).toBe("string")
  })

  it("returns success message", async () => {
    const tool = findTool("vault_setup")
    const result = await tool.handler({})

    expect(result).toContain("Vault created")
    expect(result).toContain("vault.ouro.bot")
    expect(result).toContain("ouroboros@ouro.bot")
  })

  it("returns error message on failure", async () => {
    mockCreateVaultAccount.mockResolvedValue({
      success: false,
      email: "ouroboros@ouro.bot",
      serverUrl: "https://vault.ouro.bot",
      error: "Email already taken",
    })

    const tool = findTool("vault_setup")
    const result = await tool.handler({})

    expect(result).toContain("Email already taken")
  })

  it("creates secrets directory if it does not exist", async () => {
    mockExistsSync.mockReturnValue(false)

    const tool = findTool("vault_setup")
    await tool.handler({})

    expect(mockMkdirSync).toHaveBeenCalled()
  })

  it("preserves existing secrets.json fields", async () => {
    mockReadFileSync.mockReturnValue(JSON.stringify({
      apiKey: "existing-key",
      other: "data",
    }))

    const tool = findTool("vault_setup")
    await tool.handler({})

    const writeCall = mockWriteFileSync.mock.calls[0]
    const written = JSON.parse(writeCall[1])
    expect(written.apiKey).toBe("existing-key")
    expect(written.other).toBe("data")
    expect(written.vault.masterPassword).toBeDefined()
  })

  it("emits nerves events", async () => {
    const tool = findTool("vault_setup")
    await tool.handler({})

    expect(nervesEvents.some((e) => e.event === "repertoire.vault_tool_call")).toBe(true)
  })

  it("preserves existing vault object fields when updating secrets", async () => {
    mockExistsSync.mockReturnValue(true)
    mockReadFileSync.mockReturnValue(JSON.stringify({
      vault: { customField: "keep-me", oldPassword: "old" },
    }))

    const tool = findTool("vault_setup")
    const result = await tool.handler({})

    expect(result).toContain("Vault created")
    const written = JSON.parse(mockWriteFileSync.mock.calls[0][1])
    // Existing vault fields should be preserved via spread
    expect(written.vault.customField).toBe("keep-me")
    // New fields should overwrite
    expect(written.vault.masterPassword).toBeDefined()
    expect(written.vault.email).toBe("ouroboros@ouro.bot")
  })

  it("handles secrets.json with non-object vault field", async () => {
    mockExistsSync.mockReturnValue(true)
    mockReadFileSync.mockReturnValue(JSON.stringify({ vault: "not-an-object" }))

    const tool = findTool("vault_setup")
    const result = await tool.handler({})

    expect(result).toContain("Vault created")
    const written = JSON.parse(mockWriteFileSync.mock.calls[0][1])
    // vault should be overwritten with proper object, not spread a string
    expect(written.vault.masterPassword).toBeDefined()
    expect(written.vault.email).toBe("ouroboros@ouro.bot")
  })

  it("handles corrupt secrets.json gracefully", async () => {
    mockExistsSync.mockReturnValue(true)
    mockReadFileSync.mockReturnValue("not valid json {{{")

    const tool = findTool("vault_setup")
    const result = await tool.handler({})

    // Should still succeed — corrupt file is treated as empty
    expect(result).toContain("Vault created")
    // Should still write updated secrets
    expect(mockWriteFileSync).toHaveBeenCalled()
    const written = JSON.parse(mockWriteFileSync.mock.calls[0][1])
    expect(written.vault).toBeDefined()
  })

  it("returns error message when handler throws a non-Error value", async () => {
    // Make loadAgentConfig throw a string (not an Error instance)
    mockLoadAgentConfig.mockImplementation(() => {
      throw "config-not-found"
    })

    const tool = findTool("vault_setup")
    const result = await tool.handler({})

    expect(result).toContain("Vault setup error:")
    expect(result).toContain("config-not-found")
  })
})
