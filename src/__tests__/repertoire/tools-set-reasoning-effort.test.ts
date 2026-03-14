import { describe, it, expect, vi, beforeEach } from "vitest"
import { emitNervesEvent } from "../../nerves/runtime"

function emitTestEvent(testName: string): void {
  emitNervesEvent({
    component: "repertoire",
    event: "repertoire.test_run",
    message: testName,
    meta: { test: true },
  })
}

vi.mock("fs", () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(() => ""),
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
  DEFAULT_AGENT_CONTEXT: { maxTokens: 80000, contextMargin: 20 },
  getAgentName: vi.fn(() => "testagent"),
  getAgentSecretsPath: vi.fn(() => "/tmp/.agentsecrets/testagent/secrets.json"),
  getAgentRoot: vi.fn(() => "/mock/repo/testagent"),
  getRepoRoot: vi.fn(() => "/mock/repo"),
  resetIdentity: vi.fn(),
}))

describe("set_reasoning_effort tool", () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it("exists in baseToolDefinitions with requiredCapability reasoning-effort", async () => {
    emitTestEvent("set_reasoning_effort exists with requiredCapability")
    const { baseToolDefinitions } = await import("../../repertoire/tools-base")
    const def = baseToolDefinitions.find(d => d.tool.function.name === "set_reasoning_effort")
    expect(def).toBeDefined()
    expect(def!.requiredCapability).toBe("reasoning-effort")
  })

  it("has a description communicating self-tuning capability", async () => {
    emitTestEvent("set_reasoning_effort description")
    const { baseToolDefinitions } = await import("../../repertoire/tools-base")
    const def = baseToolDefinitions.find(d => d.tool.function.name === "set_reasoning_effort")
    expect(def).toBeDefined()
    const desc = def!.tool.function.description!
    expect(desc).toContain("reasoning")
  })

  it("handler validates input against supportedReasoningEfforts from context", async () => {
    emitTestEvent("set_reasoning_effort validates input")
    const { baseToolDefinitions } = await import("../../repertoire/tools-base")
    const def = baseToolDefinitions.find(d => d.tool.function.name === "set_reasoning_effort")
    expect(def).toBeDefined()
    const setter = vi.fn()
    const ctx = {
      supportedReasoningEfforts: ["low", "medium", "high"] as readonly string[],
      setReasoningEffort: setter,
      signin: async () => undefined,
    }
    // Valid level
    const result = await def!.handler({ level: "high" }, ctx as any)
    expect(setter).toHaveBeenCalledWith("high")
    expect(result).toContain("high")
  })

  it("handler rejects invalid effort levels", async () => {
    emitTestEvent("set_reasoning_effort rejects invalid")
    const { baseToolDefinitions } = await import("../../repertoire/tools-base")
    const def = baseToolDefinitions.find(d => d.tool.function.name === "set_reasoning_effort")
    expect(def).toBeDefined()
    const setter = vi.fn()
    const ctx = {
      supportedReasoningEfforts: ["low", "medium", "high"] as readonly string[],
      setReasoningEffort: setter,
      signin: async () => undefined,
    }
    const result = await def!.handler({ level: "max" }, ctx as any)
    expect(setter).not.toHaveBeenCalled()
    expect(result).toContain("invalid")
  })

  it("handler mutates effort state via setReasoningEffort", async () => {
    emitTestEvent("set_reasoning_effort mutates state")
    const { baseToolDefinitions } = await import("../../repertoire/tools-base")
    const def = baseToolDefinitions.find(d => d.tool.function.name === "set_reasoning_effort")
    expect(def).toBeDefined()
    let currentEffort = "medium"
    const setter = (level: string) => { currentEffort = level }
    const ctx = {
      supportedReasoningEfforts: ["low", "medium", "high", "max"] as readonly string[],
      setReasoningEffort: setter,
      signin: async () => undefined,
    }
    await def!.handler({ level: "low" }, ctx as any)
    expect(currentEffort).toBe("low")
  })

  it("handler handles missing context gracefully", async () => {
    emitTestEvent("set_reasoning_effort missing context")
    const { baseToolDefinitions } = await import("../../repertoire/tools-base")
    const def = baseToolDefinitions.find(d => d.tool.function.name === "set_reasoning_effort")
    expect(def).toBeDefined()
    const result = await def!.handler({ level: "high" })
    expect(result).toContain("not available")
  })

  it("handler handles empty level argument", async () => {
    emitTestEvent("set_reasoning_effort empty level")
    const { baseToolDefinitions } = await import("../../repertoire/tools-base")
    const def = baseToolDefinitions.find(d => d.tool.function.name === "set_reasoning_effort")
    expect(def).toBeDefined()
    const setter = vi.fn()
    const ctx = {
      supportedReasoningEfforts: ["low", "medium", "high"] as readonly string[],
      setReasoningEffort: setter,
      signin: async () => undefined,
    }
    const result = await def!.handler({}, ctx as any)
    expect(setter).not.toHaveBeenCalled()
    expect(result).toContain("invalid")
  })
})
