import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { afterEach, describe, it, expect, vi } from "vitest"

function makeTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`))
}

describe("getSpecialistTools", () => {
  it("returns exactly 5 tool schemas", async () => {
    const { getSpecialistTools } = await import("../../../heart/daemon/specialist-tools")
    const tools = getSpecialistTools()
    expect(tools).toHaveLength(5)
  })

  it("includes complete_adoption with name and handoff_message parameters", async () => {
    const { getSpecialistTools } = await import("../../../heart/daemon/specialist-tools")
    const tools = getSpecialistTools()
    const adoptTool = tools.find((t) => t.function.name === "complete_adoption")
    expect(adoptTool).toBeDefined()
    const params = adoptTool!.function.parameters as any
    expect(params.required).toEqual(["name", "handoff_message"])
    expect(params.properties.name).toBeDefined()
    expect(params.properties.handoff_message).toBeDefined()
  })

  it("includes final_answer tool", async () => {
    const { getSpecialistTools } = await import("../../../heart/daemon/specialist-tools")
    const tools = getSpecialistTools()
    const faTool = tools.find((t) => t.function.name === "final_answer")
    expect(faTool).toBeDefined()
  })

  it("includes read_file, write_file, and list_directory tools", async () => {
    const { getSpecialistTools } = await import("../../../heart/daemon/specialist-tools")
    const tools = getSpecialistTools()
    const names = tools.map((t) => t.function.name).sort()
    expect(names).toEqual(["complete_adoption", "final_answer", "list_directory", "read_file", "write_file"])
  })
})

describe("createSpecialistExecTool", () => {
  const cleanup: string[] = []

  afterEach(() => {
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

    const { createSpecialistExecTool } = await import("../../../heart/daemon/specialist-tools")
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

    const { createSpecialistExecTool } = await import("../../../heart/daemon/specialist-tools")
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

    const { createSpecialistExecTool } = await import("../../../heart/daemon/specialist-tools")
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

  it("write_file creates parent directories", async () => {
    const tmpDir = makeTempDir("spec-tools-wf-nested")
    cleanup.push(tmpDir)
    const filePath = path.join(tmpDir, "a", "b", "c.txt")

    const { createSpecialistExecTool } = await import("../../../heart/daemon/specialist-tools")
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

    const { createSpecialistExecTool } = await import("../../../heart/daemon/specialist-tools")
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

    const { createSpecialistExecTool } = await import("../../../heart/daemon/specialist-tools")
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

  it("unknown tool returns error", async () => {
    const tmpDir = makeTempDir("spec-tools-unk")
    cleanup.push(tmpDir)

    const { createSpecialistExecTool } = await import("../../../heart/daemon/specialist-tools")
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
    const { createSpecialistExecTool } = await import("../../../heart/daemon/specialist-tools")
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
    expect(fs.existsSync(path.join(finalBundle, "memory"))).toBe(true)
    expect(fs.existsSync(path.join(finalBundle, "friends"))).toBe(true)
    expect(fs.existsSync(path.join(finalBundle, "tasks"))).toBe(true)
    expect(fs.existsSync(path.join(finalBundle, "skills"))).toBe(true)
    expect(fs.existsSync(path.join(finalBundle, "senses"))).toBe(true)

    // Psyche files should be present
    expect(fs.existsSync(path.join(finalBundle, "psyche", "SOUL.md"))).toBe(true)

    // bundle-meta.json should exist
    expect(fs.existsSync(path.join(finalBundle, "bundle-meta.json"))).toBe(true)

    // Secrets should be written
    const secretsFile = path.join(secretsRoot, "TestAgent", "secrets.json")
    expect(fs.existsSync(secretsFile)).toBe(true)

    // Animation should have played
    expect(animChunks.join("")).toContain("TestAgent")
  })

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

    const { createSpecialistExecTool } = await import("../../../heart/daemon/specialist-tools")
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

    const { createSpecialistExecTool } = await import("../../../heart/daemon/specialist-tools")
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

    const { createSpecialistExecTool } = await import("../../../heart/daemon/specialist-tools")
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

    const { createSpecialistExecTool } = await import("../../../heart/daemon/specialist-tools")
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

    // Use a non-writable path for secrets to trigger failure
    const secretsRoot = "/nonexistent/readonly/secrets"

    const { createSpecialistExecTool } = await import("../../../heart/daemon/specialist-tools")
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

    const { createSpecialistExecTool } = await import("../../../heart/daemon/specialist-tools")
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
})
