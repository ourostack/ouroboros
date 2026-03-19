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

describe("noResponseTool", () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it("is exported from tools-base", async () => {
    const { noResponseTool } = await import("../../repertoire/tools-base")
    expect(noResponseTool).toBeDefined()
  })

  it("has type 'function'", async () => {
    const { noResponseTool } = await import("../../repertoire/tools-base")
    expect(noResponseTool.type).toBe("function")
  })

  it("has function.name 'no_response'", async () => {
    const { noResponseTool } = await import("../../repertoire/tools-base")
    expect(noResponseTool.function.name).toBe("no_response")
  })

  it("has a description mentioning group chat and staying silent", async () => {
    const { noResponseTool } = await import("../../repertoire/tools-base")
    expect(noResponseTool.function.description).toMatch(/silent/i)
    expect(noResponseTool.function.description).toMatch(/group chat/i)
  })

  it("has a reason string parameter", async () => {
    const { noResponseTool } = await import("../../repertoire/tools-base")
    const params = noResponseTool.function.parameters as any
    expect(params.type).toBe("object")
    expect(params.properties.reason).toBeDefined()
    expect(params.properties.reason.type).toBe("string")
  })

  it("reason parameter is optional (not in required)", async () => {
    const { noResponseTool } = await import("../../repertoire/tools-base")
    const params = noResponseTool.function.parameters as any
    // required should either not exist or not include "reason"
    expect(params.required ?? []).not.toContain("reason")
  })

  it("is exported alongside finalAnswerTool", async () => {
    const { noResponseTool, finalAnswerTool } = await import("../../repertoire/tools-base")
    expect(noResponseTool).toBeDefined()
    expect(finalAnswerTool).toBeDefined()
    // They should be different tools
    expect(noResponseTool.function.name).not.toBe(finalAnswerTool.function.name)
  })

  it("is re-exported from tools.ts", async () => {
    const { noResponseTool } = await import("../../repertoire/tools")
    expect(noResponseTool).toBeDefined()
    expect(noResponseTool.function.name).toBe("no_response")
  })
})
