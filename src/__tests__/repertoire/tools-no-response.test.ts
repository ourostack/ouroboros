import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("fs", () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  readdirSync: vi.fn(),
  mkdirSync: vi.fn(),
}))

vi.mock("child_process", () => ({
  execSync: vi.fn(),
  spawnSync: vi.fn(),
}))

vi.mock("../../repertoire/skills", () => ({
  listSkills: vi.fn(),
  loadSkill: vi.fn(),
}))

vi.mock("../../heart/identity", () => ({
  loadAgentConfig: vi.fn(() => ({
    name: "testagent",
    configPath: "~/.agentsecrets/testagent/secrets.json",
    provider: "minimax",
  })),
  getAgentName: vi.fn(() => "testagent"),
  getAgentSecretsPath: vi.fn(() => "/tmp/.agentsecrets/testagent/secrets.json"),
  getAgentRoot: vi.fn(() => "/mock/repo/testagent"),
  getRepoRoot: vi.fn(() => "/mock/repo"),
  resetIdentity: vi.fn(),
}))

describe("observeTool", () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it("is exported from tools-base", async () => {
    const { observeTool } = await import("../../repertoire/tools-base")
    expect(observeTool).toBeDefined()
  })

  it("has type 'function'", async () => {
    const { observeTool } = await import("../../repertoire/tools-base")
    expect(observeTool.type).toBe("function")
  })

  it("has function.name 'observe'", async () => {
    const { observeTool } = await import("../../repertoire/tools-base")
    expect(observeTool.function.name).toBe("observe")
  })

  it("has a description mentioning group chat and staying silent", async () => {
    const { observeTool } = await import("../../repertoire/tools-base")
    expect(observeTool.function.description).toMatch(/silent/i)
    expect(observeTool.function.description).toMatch(/group chat/i)
  })

  it("has a reason string parameter", async () => {
    const { observeTool } = await import("../../repertoire/tools-base")
    const params = observeTool.function.parameters as any
    expect(params.type).toBe("object")
    expect(params.properties.reason).toBeDefined()
    expect(params.properties.reason.type).toBe("string")
  })

  it("reason parameter is optional (not in required)", async () => {
    const { observeTool } = await import("../../repertoire/tools-base")
    const params = observeTool.function.parameters as any
    // required should either not exist or not include "reason"
    expect(params.required ?? []).not.toContain("reason")
  })

  it("is exported alongside settleTool", async () => {
    const { observeTool, settleTool } = await import("../../repertoire/tools-base")
    expect(observeTool).toBeDefined()
    expect(settleTool).toBeDefined()
    // They should be different tools
    expect(observeTool.function.name).not.toBe(settleTool.function.name)
  })

  it("is re-exported from tools.ts", async () => {
    const { observeTool } = await import("../../repertoire/tools")
    expect(observeTool).toBeDefined()
    expect(observeTool.function.name).toBe("observe")
  })
})
