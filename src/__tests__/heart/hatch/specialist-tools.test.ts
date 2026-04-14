import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { afterEach, describe, it, expect, vi } from "vitest"

const mockPlayHatchAnimation = vi.fn(async (
  hatchlingName: string,
  writer?: (text: string) => void,
) => {
  writer?.(`\nmock hatch ${hatchlingName}\n`)
})

const mockCreateVaultAccount = vi.hoisted(() => vi.fn(async (
  _agentName: string,
  serverUrl: string,
  email: string,
) => ({ success: true, email, serverUrl })))

const mockStoreVaultUnlockSecret = vi.hoisted(() => vi.fn())

const mockStoreProviderCredentials = vi.hoisted(() =>
  vi.fn(async (agentName: string, provider: string) => ({
    credentialPath: `vault:${agentName}:providers/${provider}`,
  })),
)

vi.mock("../../../heart/hatch/hatch-animation", () => ({
  playHatchAnimation: mockPlayHatchAnimation,
}))

vi.mock("../../../repertoire/vault-setup", () => ({
  createVaultAccount: mockCreateVaultAccount,
}))

vi.mock("../../../repertoire/vault-unlock", () => ({
  storeVaultUnlockSecret: mockStoreVaultUnlockSecret,
}))

vi.mock("../../../heart/auth/auth-flow", () => ({
  storeProviderCredentials: mockStoreProviderCredentials,
}))

function makeTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`))
}

function resetCredentialMocks(): void {
  mockPlayHatchAnimation.mockClear()
  mockCreateVaultAccount.mockClear()
  mockStoreVaultUnlockSecret.mockClear()
  mockStoreProviderCredentials.mockReset()
  mockStoreProviderCredentials.mockImplementation(async (agentName: string, provider: string) => ({
    credentialPath: `vault:${agentName}:providers/${provider}`,
  }))
}

describe("getSpecialistTools", () => {
  it("returns exactly 5 tool schemas", async () => {
    const { getSpecialistTools } = await import("../../../heart/hatch/specialist-tools")
    const tools = getSpecialistTools()
    expect(tools).toHaveLength(5)
  })

  it("includes complete_adoption with name, handoff_message, and optional contact params", async () => {
    const { getSpecialistTools } = await import("../../../heart/hatch/specialist-tools")
    const tools = getSpecialistTools()
    const adoptTool = tools.find((t) => t.function.name === "complete_adoption")
    expect(adoptTool).toBeDefined()
    const params = adoptTool!.function.parameters as any
    expect(params.required).toEqual(["name", "handoff_message"])
    expect(params.properties.name).toBeDefined()
    expect(params.properties.handoff_message).toBeDefined()
    expect(params.properties.phone).toBeDefined()
    expect(params.properties.teams_handle).toBeDefined()
  })

  it("includes settle tool", async () => {
    const { getSpecialistTools } = await import("../../../heart/hatch/specialist-tools")
    const tools = getSpecialistTools()
    const faTool = tools.find((t) => t.function.name === "settle")
    expect(faTool).toBeDefined()
  })

  it("includes read_file, write_file, and list_directory tools", async () => {
    const { getSpecialistTools } = await import("../../../heart/hatch/specialist-tools")
    const tools = getSpecialistTools()
    const names = tools.map((t) => t.function.name).sort()
    expect(names).toEqual(["complete_adoption", "list_directory", "read_file", "settle", "write_file"])
  })
})

describe("createSpecialistExecTool", () => {
  const cleanup: string[] = []

  afterEach(() => {
    resetCredentialMocks()
    while (cleanup.length > 0) {
      const entry = cleanup.pop()
      if (!entry) continue
      fs.rmSync(entry, { recursive: true, force: true })
    }
  })

  it("read_file returns file content", async () => {
    const tmpDir = makeTempDir("spec-tools-rf")
    cleanup.push(tmpDir)
    const filePath = path.join(tmpDir, "test.txt")
    fs.writeFileSync(filePath, "hello world", "utf-8")

    const { createSpecialistExecTool } = await import("../../../heart/hatch/specialist-tools")
    const execTool = createSpecialistExecTool({
      tempDir: tmpDir,
      credentials: { setupToken: "test" },
      provider: "anthropic",
      bundlesRoot: tmpDir,
      secretsRoot: tmpDir,
      animationWriter: () => {},
    })

    const result = await execTool("read_file", { path: filePath })
    expect(result).toBe("hello world")
  })

  it("read_file returns error for missing file", async () => {
    const tmpDir = makeTempDir("spec-tools-rf-err")
    cleanup.push(tmpDir)

    const { createSpecialistExecTool } = await import("../../../heart/hatch/specialist-tools")
    const execTool = createSpecialistExecTool({
      tempDir: tmpDir,
      credentials: { setupToken: "test" },
      provider: "anthropic",
      bundlesRoot: tmpDir,
      secretsRoot: tmpDir,
      animationWriter: () => {},
    })

    const result = await execTool("read_file", { path: "/nonexistent/path.txt" })
    expect(result).toContain("error:")
  })

  it("write_file writes content to file", async () => {
    const tmpDir = makeTempDir("spec-tools-wf")
    cleanup.push(tmpDir)
    const filePath = path.join(tmpDir, "output.txt")

    const { createSpecialistExecTool } = await import("../../../heart/hatch/specialist-tools")
    const execTool = createSpecialistExecTool({
      tempDir: tmpDir,
      credentials: { setupToken: "test" },
      provider: "anthropic",
      bundlesRoot: tmpDir,
      secretsRoot: tmpDir,
      animationWriter: () => {},
    })

    const result = await execTool("write_file", { path: filePath, content: "test content" })
    expect(result).toContain("wrote")
    expect(fs.readFileSync(filePath, "utf-8")).toBe("test content")
  })

  it("write_file coerces non-string content to JSON", async () => {
    const tmpDir = makeTempDir("spec-tools-wf-obj")
    cleanup.push(tmpDir)
    const filePath = path.join(tmpDir, "agent.json")

    const { createSpecialistExecTool } = await import("../../../heart/hatch/specialist-tools")
    const execTool = createSpecialistExecTool({
      tempDir: tmpDir,
      credentials: { setupToken: "test" },
      provider: "anthropic",
      bundlesRoot: tmpDir,
      secretsRoot: tmpDir,
      animationWriter: () => {},
    })

    // Simulate model sending content as an object (parsed from JSON args)
    const result = await execTool("write_file", {
      path: filePath,
      content: { name: "TestAgent", provider: "anthropic" } as unknown as string,
    })
    expect(result).toContain("wrote")
    const written = fs.readFileSync(filePath, "utf-8")
    expect(JSON.parse(written)).toEqual({ name: "TestAgent", provider: "anthropic" })
  })

  it("write_file creates parent directories", async () => {
    const tmpDir = makeTempDir("spec-tools-wf-nested")
    cleanup.push(tmpDir)
    const filePath = path.join(tmpDir, "a", "b", "c.txt")

    const { createSpecialistExecTool } = await import("../../../heart/hatch/specialist-tools")
    const execTool = createSpecialistExecTool({
      tempDir: tmpDir,
      credentials: { setupToken: "test" },
      provider: "anthropic",
      bundlesRoot: tmpDir,
      secretsRoot: tmpDir,
      animationWriter: () => {},
    })

    const result = await execTool("write_file", { path: filePath, content: "nested" })
    expect(result).toContain("wrote")
    expect(fs.readFileSync(filePath, "utf-8")).toBe("nested")
  })

  it("list_directory returns listing", async () => {
    const tmpDir = makeTempDir("spec-tools-ld")
    cleanup.push(tmpDir)
    fs.writeFileSync(path.join(tmpDir, "file1.txt"), "a", "utf-8")
    fs.mkdirSync(path.join(tmpDir, "subdir"))

    const { createSpecialistExecTool } = await import("../../../heart/hatch/specialist-tools")
    const execTool = createSpecialistExecTool({
      tempDir: tmpDir,
      credentials: { setupToken: "test" },
      provider: "anthropic",
      bundlesRoot: tmpDir,
      secretsRoot: tmpDir,
      animationWriter: () => {},
    })

    const result = await execTool("list_directory", { path: tmpDir })
    expect(result).toContain("file1.txt")
    expect(result).toContain("subdir")
  })

  it("list_directory returns error for missing directory", async () => {
    const tmpDir = makeTempDir("spec-tools-ld-err")
    cleanup.push(tmpDir)

    const { createSpecialistExecTool } = await import("../../../heart/hatch/specialist-tools")
    const execTool = createSpecialistExecTool({
      tempDir: tmpDir,
      credentials: { setupToken: "test" },
      provider: "anthropic",
      bundlesRoot: tmpDir,
      secretsRoot: tmpDir,
      animationWriter: () => {},
    })

    const result = await execTool("list_directory", { path: "/nonexistent/dir" })
    expect(result).toContain("error:")
  })

  it("write_file returns error on failure", async () => {
    const tmpDir = makeTempDir("spec-tools-wf-err")
    cleanup.push(tmpDir)

    const { createSpecialistExecTool } = await import("../../../heart/hatch/specialist-tools")
    const execTool = createSpecialistExecTool({
      tempDir: tmpDir,
      credentials: { setupToken: "test" },
      provider: "anthropic",
      bundlesRoot: tmpDir,
      secretsRoot: tmpDir,
      animationWriter: () => {},
    })

    // /dev/null is a file, not a dir, so mkdirSync for a child path will fail
    const result = await execTool("write_file", { path: "/dev/null/impossible.txt", content: "fail" })
    expect(result).toContain("error:")
  })

  it("unknown tool returns error", async () => {
    const tmpDir = makeTempDir("spec-tools-unk")
    cleanup.push(tmpDir)

    const { createSpecialistExecTool } = await import("../../../heart/hatch/specialist-tools")
    const execTool = createSpecialistExecTool({
      tempDir: tmpDir,
      credentials: { setupToken: "test" },
      provider: "anthropic",
      bundlesRoot: tmpDir,
      secretsRoot: tmpDir,
      animationWriter: () => {},
    })

    const result = await execTool("unknown_tool", {})
    expect(result).toContain("error")
    expect(result).toContain("unknown")
  })
})

describe("complete_adoption via createSpecialistExecTool", () => {
  const cleanup: string[] = []

  afterEach(() => {
    resetCredentialMocks()
    while (cleanup.length > 0) {
      const entry = cleanup.pop()
      if (!entry) continue
      fs.rmSync(entry, { recursive: true, force: true })
    }
  })

  function setupTempDir(): string {
    const tmpDir = makeTempDir("spec-tools-adopt")
    cleanup.push(tmpDir)
    // Create psyche dir and 5 psyche files
    const psycheDir = path.join(tmpDir, "psyche")
    fs.mkdirSync(psycheDir, { recursive: true })
    fs.writeFileSync(path.join(psycheDir, "SOUL.md"), "# SOUL\nI am me.", "utf-8")
    fs.writeFileSync(path.join(psycheDir, "IDENTITY.md"), "# IDENTITY\nI am TestAgent.", "utf-8")
    fs.writeFileSync(path.join(psycheDir, "LORE.md"), "# LORE\nMy backstory.", "utf-8")
    fs.writeFileSync(path.join(psycheDir, "TACIT.md"), "# TACIT\nMy tacit knowledge.", "utf-8")
    fs.writeFileSync(path.join(psycheDir, "ASPIRATIONS.md"), "# ASPIRATIONS\nMy goals.", "utf-8")
    // Create agent.json
    fs.writeFileSync(path.join(tmpDir, "agent.json"), JSON.stringify({
      name: "TestAgent",
      provider: "anthropic",
      enabled: true,
    }, null, 2), "utf-8")
    return tmpDir
  }

  it("succeeds with valid bundle: scaffolds, moves, writes secrets, plays animation", async () => {
    const tmpDir = setupTempDir()
    const bundlesRoot = makeTempDir("spec-tools-adopt-bundles")
    const secretsRoot = makeTempDir("spec-tools-adopt-secrets")
    cleanup.push(bundlesRoot, secretsRoot)

    const animChunks: string[] = []
    const { createSpecialistExecTool } = await import("../../../heart/hatch/specialist-tools")
    const execTool = createSpecialistExecTool({
      tempDir: tmpDir,
      credentials: { setupToken: `sk-ant-oat01-${"a".repeat(80)}` },
      provider: "anthropic",
      bundlesRoot,
      secretsRoot,
      animationWriter: (text: string) => animChunks.push(text),
    })

    const result = await execTool("complete_adoption", {
      name: "TestAgent",
      handoff_message: "Welcome to the world!",
    })

    expect(result).toContain("success")
    expect(result).toContain("TestAgent")

    // Bundle should be moved to final location
    const finalBundle = path.join(bundlesRoot, "TestAgent.ouro")
    expect(fs.existsSync(finalBundle)).toBe(true)

    // Scaffold dirs should exist
    expect(fs.existsSync(path.join(finalBundle, "notes"))).toBe(true)
    expect(fs.existsSync(path.join(finalBundle, "friends"))).toBe(true)
    expect(fs.existsSync(path.join(finalBundle, "tasks"))).toBe(true)
    expect(fs.existsSync(path.join(finalBundle, "skills"))).toBe(true)
    expect(fs.existsSync(path.join(finalBundle, "senses"))).toBe(true)

    // habits/ at bundle root (not tasks/habits/)
    expect(fs.existsSync(path.join(finalBundle, "habits"))).toBe(true)
    expect(fs.existsSync(path.join(finalBundle, "habits", "README.md"))).toBe(true)
    expect(fs.existsSync(path.join(finalBundle, "tasks", "habits"))).toBe(false)

    // Psyche files should be present
    expect(fs.existsSync(path.join(finalBundle, "psyche", "SOUL.md"))).toBe(true)

    // bundle-meta.json should exist
    expect(fs.existsSync(path.join(finalBundle, "bundle-meta.json"))).toBe(true)

    // Provider credentials should be written to the hatchling vault, not a legacy secrets file.
    expect(mockCreateVaultAccount).toHaveBeenCalledWith(
      "TestAgent",
      expect.any(String),
      expect.any(String),
      expect.any(String),
    )
    expect(mockStoreVaultUnlockSecret).toHaveBeenCalledWith(
      expect.objectContaining({ agentName: "TestAgent" }),
      expect.any(String),
    )
    expect(mockStoreProviderCredentials).toHaveBeenCalledWith(
      "TestAgent",
      "anthropic",
      { setupToken: `sk-ant-oat01-${"a".repeat(80)}` },
    )
    const secretsFile = path.join(secretsRoot, "TestAgent", "secrets.json")
    expect(fs.existsSync(secretsFile)).toBe(false)

    // Animation should have played
    expect(animChunks.join("")).toContain("TestAgent")
  }, 20000)

  it("returns error when psyche files are missing", async () => {
    const tmpDir = makeTempDir("spec-tools-adopt-missing")
    cleanup.push(tmpDir)
    // No psyche files
    fs.writeFileSync(path.join(tmpDir, "agent.json"), JSON.stringify({
      name: "TestAgent",
      provider: "anthropic",
    }, null, 2), "utf-8")

    const bundlesRoot = makeTempDir("spec-tools-adopt-bundles2")
    const secretsRoot = makeTempDir("spec-tools-adopt-secrets2")
    cleanup.push(bundlesRoot, secretsRoot)

    const { createSpecialistExecTool } = await import("../../../heart/hatch/specialist-tools")
    const execTool = createSpecialistExecTool({
      tempDir: tmpDir,
      credentials: { setupToken: "test" },
      provider: "anthropic",
      bundlesRoot,
      secretsRoot,
      animationWriter: () => {},
    })

    const result = await execTool("complete_adoption", {
      name: "TestAgent",
      handoff_message: "Hello",
    })

    expect(result).toContain("error")
    expect(result).toContain("psyche")
  })

  it("returns error when name is not PascalCase", async () => {
    const tmpDir = setupTempDir()
    const bundlesRoot = makeTempDir("spec-tools-adopt-bundles3")
    const secretsRoot = makeTempDir("spec-tools-adopt-secrets3")
    cleanup.push(bundlesRoot, secretsRoot)

    const { createSpecialistExecTool } = await import("../../../heart/hatch/specialist-tools")
    const execTool = createSpecialistExecTool({
      tempDir: tmpDir,
      credentials: { setupToken: "test" },
      provider: "anthropic",
      bundlesRoot,
      secretsRoot,
      animationWriter: () => {},
    })

    const result = await execTool("complete_adoption", {
      name: "not-pascal-case",
      handoff_message: "Hello",
    })

    expect(result).toContain("error")
    expect(result).toContain("PascalCase")
  })

  it("returns error when target bundle already exists", async () => {
    const tmpDir = setupTempDir()
    const bundlesRoot = makeTempDir("spec-tools-adopt-bundles4")
    const secretsRoot = makeTempDir("spec-tools-adopt-secrets4")
    cleanup.push(bundlesRoot, secretsRoot)

    // Pre-create the target bundle
    fs.mkdirSync(path.join(bundlesRoot, "TestAgent.ouro"), { recursive: true })

    const { createSpecialistExecTool } = await import("../../../heart/hatch/specialist-tools")
    const execTool = createSpecialistExecTool({
      tempDir: tmpDir,
      credentials: { setupToken: "test" },
      provider: "anthropic",
      bundlesRoot,
      secretsRoot,
      animationWriter: () => {},
    })

    const result = await execTool("complete_adoption", {
      name: "TestAgent",
      handoff_message: "Hello",
    })

    expect(result).toContain("error")
    expect(result).toContain("already exists")
  })

  it("returns error when agent.json is missing", async () => {
    const tmpDir = makeTempDir("spec-tools-adopt-noagent")
    cleanup.push(tmpDir)
    // Create psyche files but no agent.json
    const psycheDir = path.join(tmpDir, "psyche")
    fs.mkdirSync(psycheDir, { recursive: true })
    for (const f of ["SOUL.md", "IDENTITY.md", "LORE.md", "TACIT.md", "ASPIRATIONS.md"]) {
      fs.writeFileSync(path.join(psycheDir, f), `# ${f}\ncontent`, "utf-8")
    }

    const bundlesRoot = makeTempDir("spec-tools-adopt-bundles5")
    const secretsRoot = makeTempDir("spec-tools-adopt-secrets5")
    cleanup.push(bundlesRoot, secretsRoot)

    const { createSpecialistExecTool } = await import("../../../heart/hatch/specialist-tools")
    const execTool = createSpecialistExecTool({
      tempDir: tmpDir,
      credentials: { setupToken: "test" },
      provider: "anthropic",
      bundlesRoot,
      secretsRoot,
      animationWriter: () => {},
    })

    const result = await execTool("complete_adoption", {
      name: "TestAgent",
      handoff_message: "Hello",
    })

    expect(result).toContain("error")
    expect(result).toContain("agent.json")
  })

  it("rolls back moved bundle when secrets write fails", async () => {
    const tmpDir = setupTempDir()
    const bundlesRoot = makeTempDir("spec-tools-adopt-bundles-rollback")
    cleanup.push(bundlesRoot)

    const secretsRoot = "/nonexistent/readonly/secrets"
    mockStoreProviderCredentials.mockRejectedValueOnce(new Error("mock secret write failed"))

    const { createSpecialistExecTool } = await import("../../../heart/hatch/specialist-tools")
    const execTool = createSpecialistExecTool({
      tempDir: tmpDir,
      credentials: { setupToken: `sk-ant-oat01-${"a".repeat(80)}` },
      provider: "anthropic",
      bundlesRoot,
      secretsRoot,
      animationWriter: () => {},
    })

    const result = await execTool("complete_adoption", {
      name: "TestAgent",
      handoff_message: "Hello",
    })

    expect(result).toContain("error")
    // Bundle should be rolled back (removed)
    const finalBundle = path.join(bundlesRoot, "TestAgent.ouro")
    expect(fs.existsSync(finalBundle)).toBe(false)
  })

  it("returns error when name parameter is missing", async () => {
    const tmpDir = makeTempDir("spec-tools-adopt-noname")
    cleanup.push(tmpDir)

    const { createSpecialistExecTool } = await import("../../../heart/hatch/specialist-tools")
    const execTool = createSpecialistExecTool({
      tempDir: tmpDir,
      credentials: { setupToken: "test" },
      provider: "anthropic",
      bundlesRoot: tmpDir,
      secretsRoot: tmpDir,
      animationWriter: () => {},
    })

    const result = await execTool("complete_adoption", {
      handoff_message: "Hello",
    })

    expect(result).toContain("error")
    expect(result).toContain("name")
  })

  it("creates initial friend record with phone externalId when provided", async () => {
    const tmpDir = setupTempDir()
    const bundlesRoot = makeTempDir("spec-tools-phone-bundles")
    const secretsRoot = makeTempDir("spec-tools-phone-secrets")
    cleanup.push(bundlesRoot, secretsRoot)

    const { createSpecialistExecTool } = await import("../../../heart/hatch/specialist-tools")
    const execTool = createSpecialistExecTool({
      tempDir: tmpDir,
      credentials: { setupToken: `sk-ant-oat01-${"a".repeat(80)}` },
      provider: "anthropic",
      bundlesRoot,
      secretsRoot,
      animationWriter: () => {},
      humanName: "Ari",
    })

    const result = await execTool("complete_adoption", {
      name: "PhoneAgent",
      handoff_message: "Hello!",
      phone: "+1234567890",
    })

    expect(result).toContain("success")
    const finalBundle = path.join(bundlesRoot, "PhoneAgent.ouro")
    const friendsDir = path.join(finalBundle, "friends")
    const friendFiles = fs.readdirSync(friendsDir).filter((f) => f.endsWith(".json"))
    expect(friendFiles.length).toBe(1)
    const friend = JSON.parse(fs.readFileSync(path.join(friendsDir, friendFiles[0]), "utf-8"))
    expect(friend.externalIds).toEqual(expect.arrayContaining([
      expect.objectContaining({ provider: "imessage-handle", externalId: "+1234567890" }),
    ]))
    expect(friend.name).toBe("Ari")
  }, 20000)

  it("creates initial friend record with teams handle when provided", async () => {
    const tmpDir = setupTempDir()
    const bundlesRoot = makeTempDir("spec-tools-teams-bundles")
    const secretsRoot = makeTempDir("spec-tools-teams-secrets")
    cleanup.push(bundlesRoot, secretsRoot)

    const { createSpecialistExecTool } = await import("../../../heart/hatch/specialist-tools")
    const execTool = createSpecialistExecTool({
      tempDir: tmpDir,
      credentials: { setupToken: `sk-ant-oat01-${"a".repeat(80)}` },
      provider: "anthropic",
      bundlesRoot,
      secretsRoot,
      animationWriter: () => {},
      humanName: "Ari",
    })

    const result = await execTool("complete_adoption", {
      name: "TeamsAgent",
      handoff_message: "Hello!",
      teams_handle: "ari@company.com",
    })

    expect(result).toContain("success")
    const finalBundle = path.join(bundlesRoot, "TeamsAgent.ouro")
    const friendsDir = path.join(finalBundle, "friends")
    const friendFiles = fs.readdirSync(friendsDir).filter((f) => f.endsWith(".json"))
    expect(friendFiles.length).toBe(1)
    const friend = JSON.parse(fs.readFileSync(path.join(friendsDir, friendFiles[0]), "utf-8"))
    expect(friend.externalIds).toEqual(expect.arrayContaining([
      expect.objectContaining({ provider: "aad", externalId: "ari@company.com" }),
    ]))
  }, 20000)

  it("uses 'primary' as friend name when humanName not provided", async () => {
    const tmpDir = setupTempDir()
    const bundlesRoot = makeTempDir("spec-tools-noname-bundles")
    const secretsRoot = makeTempDir("spec-tools-noname-secrets")
    cleanup.push(bundlesRoot, secretsRoot)

    const { createSpecialistExecTool } = await import("../../../heart/hatch/specialist-tools")
    const execTool = createSpecialistExecTool({
      tempDir: tmpDir,
      credentials: { setupToken: `sk-ant-oat01-${"a".repeat(80)}` },
      provider: "anthropic",
      bundlesRoot,
      secretsRoot,
      animationWriter: () => {},
      // humanName intentionally omitted
    })

    const result = await execTool("complete_adoption", {
      name: "NoNameAgent",
      handoff_message: "Hello!",
      phone: "+1234567890",
    })

    expect(result).toContain("success")
    const finalBundle = path.join(bundlesRoot, "NoNameAgent.ouro")
    const friendsDir = path.join(finalBundle, "friends")
    const friendFiles = fs.readdirSync(friendsDir).filter((f) => f.endsWith(".json"))
    expect(friendFiles.length).toBe(1)
    const friend = JSON.parse(fs.readFileSync(path.join(friendsDir, friendFiles[0]), "utf-8"))
    expect(friend.name).toBe("primary")
  }, 20000)

  it("does not create friend record when no contact info provided", async () => {
    const tmpDir = setupTempDir()
    const bundlesRoot = makeTempDir("spec-tools-nocontact-bundles")
    const secretsRoot = makeTempDir("spec-tools-nocontact-secrets")
    cleanup.push(bundlesRoot, secretsRoot)

    const { createSpecialistExecTool } = await import("../../../heart/hatch/specialist-tools")
    const execTool = createSpecialistExecTool({
      tempDir: tmpDir,
      credentials: { setupToken: `sk-ant-oat01-${"a".repeat(80)}` },
      provider: "anthropic",
      bundlesRoot,
      secretsRoot,
      animationWriter: () => {},
    })

    const result = await execTool("complete_adoption", {
      name: "NoContactAgent",
      handoff_message: "Hello!",
    })

    expect(result).toContain("success")
    const finalBundle = path.join(bundlesRoot, "NoContactAgent.ouro")
    const friendsDir = path.join(finalBundle, "friends")
    // Only README.md should be there, no friend JSON files
    const friendFiles = fs.readdirSync(friendsDir).filter((f) => f.endsWith(".json"))
    expect(friendFiles.length).toBe(0)
  }, 20000)
})
