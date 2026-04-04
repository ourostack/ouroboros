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
  statSync: vi.fn(() => ({ mtimeMs: Date.now() })),
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
    version: 2,
    enabled: true,
    humanFacing: { provider: "anthropic", model: "claude-opus-4-6" },
    agentFacing: { provider: "anthropic", model: "claude-opus-4-6" },
    phrases: {
      thinking: ["working"],
      tool: ["running tool"],
      followup: ["processing"],
    },
  })),
  DEFAULT_AGENT_CONTEXT: { maxTokens: 80000, contextMargin: 20 },
  getAgentName: vi.fn(() => "testagent"),
  getAgentSecretsPath: vi.fn(() => "/tmp/.agentsecrets/testagent/secrets.json"),
  getAgentRoot: vi.fn(() => "/mock/agent/testagent.ouro"),
  getRepoRoot: vi.fn(() => "/mock/repo"),
  resetIdentity: vi.fn(),
}))

import * as fs from "fs"

const SAMPLE_AGENT_JSON = {
  version: 2,
  enabled: true,
  humanFacing: { provider: "anthropic", model: "claude-opus-4-6" },
  agentFacing: { provider: "anthropic", model: "claude-opus-4-6" },
  context: { maxTokens: 80000, contextMargin: 20 },
  logging: { level: "info", sinks: ["terminal"] },
  senses: {
    cli: { enabled: true },
    teams: { enabled: false },
    bluebubbles: { enabled: false },
  },
  phrases: {
    thinking: ["working"],
    tool: ["running tool"],
    followup: ["processing"],
  },
  shell: { defaultTimeout: 30000 },
  sync: { enabled: false, remote: "origin" },
}

describe("read_config tool", () => {
  beforeEach(() => {
    vi.resetModules()
    vi.mocked(fs.readFileSync).mockImplementation((filePath: unknown) => {
      const p = String(filePath)
      if (p.endsWith("agent.json")) {
        return JSON.stringify(SAMPLE_AGENT_JSON)
      }
      return ""
    })
  })

  it("exists in baseToolDefinitions", async () => {
    emitTestEvent("read_config exists")
    const { baseToolDefinitions } = await import("../../repertoire/tools-base")
    const def = baseToolDefinitions.find(d => d.tool.function.name === "read_config")
    expect(def).toBeDefined()
  })

  it("has optional related_to parameter", async () => {
    emitTestEvent("read_config has related_to parameter")
    const { baseToolDefinitions } = await import("../../repertoire/tools-base")
    const def = baseToolDefinitions.find(d => d.tool.function.name === "read_config")
    expect(def).toBeDefined()
    const params = def!.tool.function.parameters as Record<string, unknown>
    const props = (params as { properties: Record<string, unknown> }).properties
    expect(props).toHaveProperty("related_to")
    // related_to should not be required
    const required = (params as { required?: string[] }).required
    expect(required ?? []).not.toContain("related_to")
  })

  it("returns all config entries when no related_to given", async () => {
    emitTestEvent("read_config returns all entries")
    const { baseToolDefinitions } = await import("../../repertoire/tools-base")
    const def = baseToolDefinitions.find(d => d.tool.function.name === "read_config")
    const result = await def!.handler({})
    const parsed = JSON.parse(result)
    expect(Array.isArray(parsed.entries)).toBe(true)
    expect(parsed.entries.length).toBeGreaterThan(0)
  })

  it("filters entries by topic when related_to is provided", async () => {
    emitTestEvent("read_config filters by topic")
    const { baseToolDefinitions } = await import("../../repertoire/tools-base")
    const def = baseToolDefinitions.find(d => d.tool.function.name === "read_config")
    const result = await def!.handler({ related_to: "model" })
    const parsed = JSON.parse(result)
    expect(Array.isArray(parsed.entries)).toBe(true)
    expect(parsed.entries.length).toBeGreaterThan(0)
    // All returned entries should be related to "model"
    for (const entry of parsed.entries) {
      expect(entry.topics.some((t: string) => t.toLowerCase().includes("model"))).toBe(true)
    }
  })

  it("each entry includes path, currentValue, tier, description, default, effects", async () => {
    emitTestEvent("read_config entry has all fields")
    const { baseToolDefinitions } = await import("../../repertoire/tools-base")
    const def = baseToolDefinitions.find(d => d.tool.function.name === "read_config")
    const result = await def!.handler({})
    const parsed = JSON.parse(result)
    for (const entry of parsed.entries) {
      expect(entry).toHaveProperty("path")
      expect(entry).toHaveProperty("currentValue")
      expect(entry).toHaveProperty("tier")
      expect(entry).toHaveProperty("description")
      expect(entry).toHaveProperty("default")
      expect(entry).toHaveProperty("effects")
    }
  })

  it("current values are read from raw agent.json (includes shell and sync fields)", async () => {
    emitTestEvent("read_config reads raw agent.json")
    const { baseToolDefinitions } = await import("../../repertoire/tools-base")
    const def = baseToolDefinitions.find(d => d.tool.function.name === "read_config")
    const result = await def!.handler({ related_to: "shell" })
    const parsed = JSON.parse(result)
    const shellEntry = parsed.entries.find((e: Record<string, unknown>) => e.path === "shell.defaultTimeout")
    expect(shellEntry).toBeDefined()
    expect(shellEntry.currentValue).toBe(30000)
  })

  it("returns empty results gracefully when topic matches nothing", async () => {
    emitTestEvent("read_config empty results for no match")
    const { baseToolDefinitions } = await import("../../repertoire/tools-base")
    const def = baseToolDefinitions.find(d => d.tool.function.name === "read_config")
    const result = await def!.handler({ related_to: "xyznonexistent" })
    const parsed = JSON.parse(result)
    expect(parsed.entries).toEqual([])
  })

  it("handles dot-path traversal when intermediate value is not an object", async () => {
    emitTestEvent("read_config handles non-object intermediate")
    // Mock config where 'shell' is a string instead of an object
    vi.mocked(fs.readFileSync).mockImplementation((filePath: unknown) => {
      const p = String(filePath)
      if (p.endsWith("agent.json")) {
        return JSON.stringify({ ...SAMPLE_AGENT_JSON, shell: "broken" })
      }
      return ""
    })
    const { baseToolDefinitions } = await import("../../repertoire/tools-base")
    const def = baseToolDefinitions.find(d => d.tool.function.name === "read_config")
    const result = await def!.handler({ related_to: "shell" })
    const parsed = JSON.parse(result)
    const shellEntry = parsed.entries.find((e: Record<string, unknown>) => e.path === "shell.defaultTimeout")
    expect(shellEntry).toBeDefined()
    // Should fall back to default since the path couldn't be traversed
    expect(shellEntry.currentValue).toBeNull()
  })

  // Source field tests (Major 5)
  it("includes source field: explicit for values in agent.json", async () => {
    emitTestEvent("read_config source explicit")
    const { baseToolDefinitions } = await import("../../repertoire/tools-base")
    const def = baseToolDefinitions.find(d => d.tool.function.name === "read_config")
    const result = await def!.handler({ related_to: "context" })
    const parsed = JSON.parse(result)
    const marginEntry = parsed.entries.find((e: Record<string, unknown>) => e.path === "context.contextMargin")
    expect(marginEntry).toBeDefined()
    expect(marginEntry.source).toBe("explicit")
  })

  it("includes source field: default for values not in agent.json but with defaults", async () => {
    emitTestEvent("read_config source default")
    // Mock config without logging section
    vi.mocked(fs.readFileSync).mockImplementation((filePath: unknown) => {
      const p = String(filePath)
      if (p.endsWith("agent.json")) {
        return JSON.stringify({ version: 2, enabled: true, humanFacing: { provider: "anthropic", model: "x" }, agentFacing: { provider: "anthropic", model: "x" }, phrases: { thinking: [], tool: [], followup: [] } })
      }
      return ""
    })
    const { baseToolDefinitions } = await import("../../repertoire/tools-base")
    const def = baseToolDefinitions.find(d => d.tool.function.name === "read_config")
    const result = await def!.handler({ related_to: "context" })
    const parsed = JSON.parse(result)
    const maxTokensEntry = parsed.entries.find((e: Record<string, unknown>) => e.path === "context.maxTokens")
    expect(maxTokensEntry).toBeDefined()
    expect(maxTokensEntry.source).toBe("default")
    expect(maxTokensEntry.currentValue).toBe(80000)
  })

  it("includes source field: unset for values not in agent.json and with no default", async () => {
    emitTestEvent("read_config source unset")
    // Mock config without shell section
    vi.mocked(fs.readFileSync).mockImplementation((filePath: unknown) => {
      const p = String(filePath)
      if (p.endsWith("agent.json")) {
        return JSON.stringify({ version: 2, enabled: true, humanFacing: { provider: "anthropic", model: "x" }, agentFacing: { provider: "anthropic", model: "x" }, phrases: { thinking: [], tool: [], followup: [] } })
      }
      return ""
    })
    const { baseToolDefinitions } = await import("../../repertoire/tools-base")
    const def = baseToolDefinitions.find(d => d.tool.function.name === "read_config")
    const result = await def!.handler({ related_to: "shell" })
    const parsed = JSON.parse(result)
    const shellEntry = parsed.entries.find((e: Record<string, unknown>) => e.path === "shell.defaultTimeout")
    expect(shellEntry).toBeDefined()
    expect(shellEntry.source).toBe("unset")
    expect(shellEntry.currentValue).toBeNull()
  })

  it("includes available-but-disabled features", async () => {
    emitTestEvent("read_config includes disabled features")
    const { baseToolDefinitions } = await import("../../repertoire/tools-base")
    const def = baseToolDefinitions.find(d => d.tool.function.name === "read_config")
    const result = await def!.handler({ related_to: "senses" })
    const parsed = JSON.parse(result)
    const teamsEntry = parsed.entries.find((e: Record<string, unknown>) => e.path === "senses.teams")
    expect(teamsEntry).toBeDefined()
    // Teams is disabled in our sample config
    expect(teamsEntry.currentValue).toEqual({ enabled: false })
  })
})

describe("update_config tool (T1 only)", () => {
  beforeEach(() => {
    vi.resetModules()
    vi.mocked(fs.readFileSync).mockReset()
    vi.mocked(fs.writeFileSync).mockReset()
    vi.mocked(fs.readFileSync).mockImplementation((filePath: unknown) => {
      const p = String(filePath)
      if (p.endsWith("agent.json")) {
        return JSON.stringify(SAMPLE_AGENT_JSON)
      }
      return ""
    })
    vi.mocked(fs.writeFileSync).mockImplementation(() => {})
  })

  it("exists in baseToolDefinitions", async () => {
    emitTestEvent("update_config exists")
    const { baseToolDefinitions } = await import("../../repertoire/tools-base")
    const def = baseToolDefinitions.find(d => d.tool.function.name === "update_config")
    expect(def).toBeDefined()
  })

  it("has required path and value parameters, no confirmed parameter", async () => {
    emitTestEvent("update_config has correct parameters")
    const { baseToolDefinitions } = await import("../../repertoire/tools-base")
    const def = baseToolDefinitions.find(d => d.tool.function.name === "update_config")
    expect(def).toBeDefined()
    const params = def!.tool.function.parameters as { properties: Record<string, unknown>; required: string[] }
    expect(params.properties).toHaveProperty("path")
    expect(params.properties).toHaveProperty("value")
    expect(params.properties).not.toHaveProperty("confirmed")
    expect(params.required).toContain("path")
    expect(params.required).toContain("value")
  })

  it("does NOT have confirmationRequired (T1 is self-service)", async () => {
    emitTestEvent("update_config no confirmationRequired")
    const { baseToolDefinitions } = await import("../../repertoire/tools-base")
    const def = baseToolDefinitions.find(d => d.tool.function.name === "update_config")
    expect(def).toBeDefined()
    expect(def!.confirmationRequired).toBeFalsy()
  })

  // Tier 1 tests
  it("T1: updates key immediately, writes to agent.json, returns success", async () => {
    emitTestEvent("update_config T1 immediate update")
    const { baseToolDefinitions } = await import("../../repertoire/tools-base")
    const def = baseToolDefinitions.find(d => d.tool.function.name === "update_config")
    const result = await def!.handler({ path: "context.contextMargin", value: "25" })
    expect(result.toLowerCase()).toContain("success")
    expect(vi.mocked(fs.writeFileSync)).toHaveBeenCalled()
    // Verify the written JSON has the updated value
    const writeCall = vi.mocked(fs.writeFileSync).mock.calls[0]
    const written = JSON.parse(writeCall[1] as string)
    expect(written.context.contextMargin).toBe(25)
  })

  it("T1: validates value type matches expected type", async () => {
    emitTestEvent("update_config T1 validates type")
    const { baseToolDefinitions } = await import("../../repertoire/tools-base")
    const def = baseToolDefinitions.find(d => d.tool.function.name === "update_config")
    const result = await def!.handler({ path: "logging.level", value: '"debug"' })
    expect(result.toLowerCase()).toContain("success")
  })

  // T2 keys are refused by update_config (must use propose_config)
  it("T2: refuses T2 key with guidance to use propose_config", async () => {
    emitTestEvent("update_config refuses T2")
    const { baseToolDefinitions } = await import("../../repertoire/tools-base")
    const def = baseToolDefinitions.find(d => d.tool.function.name === "update_config")
    const result = await def!.handler({ path: "context.maxTokens", value: "120000" })
    expect(result.toLowerCase()).toContain("propose_config")
    expect(vi.mocked(fs.writeFileSync)).not.toHaveBeenCalled()
  })

  // Tier 3 tests
  it("T3: refuses change with clear explanation", async () => {
    emitTestEvent("update_config T3 refuses change")
    const { baseToolDefinitions } = await import("../../repertoire/tools-base")
    const def = baseToolDefinitions.find(d => d.tool.function.name === "update_config")
    const result = await def!.handler({ path: "version", value: "3" })
    expect(result.toLowerCase()).toContain("operator-only")
    // Should NOT have written to disk
    expect(vi.mocked(fs.writeFileSync)).not.toHaveBeenCalled()
  })

  it("T3: does not modify agent.json", async () => {
    emitTestEvent("update_config T3 does not modify")
    const { baseToolDefinitions } = await import("../../repertoire/tools-base")
    const def = baseToolDefinitions.find(d => d.tool.function.name === "update_config")
    await def!.handler({ path: "enabled", value: "false" })
    expect(vi.mocked(fs.writeFileSync)).not.toHaveBeenCalled()
  })

  // General tests
  it("unknown path returns error", async () => {
    emitTestEvent("update_config unknown path error")
    const { baseToolDefinitions } = await import("../../repertoire/tools-base")
    const def = baseToolDefinitions.find(d => d.tool.function.name === "update_config")
    const result = await def!.handler({ path: "nonexistent.key", value: "42" })
    expect(result.toLowerCase()).toContain("unknown")
  })

  it("invalid JSON value returns error", async () => {
    emitTestEvent("update_config invalid JSON error")
    const { baseToolDefinitions } = await import("../../repertoire/tools-base")
    const def = baseToolDefinitions.find(d => d.tool.function.name === "update_config")
    const result = await def!.handler({ path: "context.contextMargin", value: "{invalid json" })
    expect(result.toLowerCase()).toContain("invalid")
  })

  it("read-back after write confirms the change persisted", async () => {
    emitTestEvent("update_config read-back confirms persistence")
    const { baseToolDefinitions } = await import("../../repertoire/tools-base")

    // First, update a T1 value
    const updateDef = baseToolDefinitions.find(d => d.tool.function.name === "update_config")
    await updateDef!.handler({ path: "context.contextMargin", value: "30" })

    // Capture what was written
    const writeCall = vi.mocked(fs.writeFileSync).mock.calls[0]
    const writtenJson = writeCall[1] as string

    // Now mock readFileSync to return the written value
    vi.mocked(fs.readFileSync).mockImplementation((filePath: unknown) => {
      const p = String(filePath)
      if (p.endsWith("agent.json")) return writtenJson
      return ""
    })

    // Read it back
    const readDef = baseToolDefinitions.find(d => d.tool.function.name === "read_config")
    const result = await readDef!.handler({ related_to: "context" })
    const parsed = JSON.parse(result)
    const marginEntry = parsed.entries.find((e: Record<string, unknown>) => e.path === "context.contextMargin")
    expect(marginEntry.currentValue).toBe(30)
  })

  // Validation tests
  it("rejects value with wrong type (string instead of number)", async () => {
    emitTestEvent("update_config rejects wrong type")
    const { baseToolDefinitions } = await import("../../repertoire/tools-base")
    const def = baseToolDefinitions.find(d => d.tool.function.name === "update_config")
    const result = await def!.handler({ path: "context.contextMargin", value: '"not a number"' })
    expect(result.toLowerCase()).toContain("validation failed")
    expect(result).toContain("expected number")
    expect(vi.mocked(fs.writeFileSync)).not.toHaveBeenCalled()
  })

  it("rejects invalid enum value for logging.level", async () => {
    emitTestEvent("update_config rejects invalid log level")
    const { baseToolDefinitions } = await import("../../repertoire/tools-base")
    const def = baseToolDefinitions.find(d => d.tool.function.name === "update_config")
    const result = await def!.handler({ path: "logging.level", value: '"verbose"' })
    expect(result.toLowerCase()).toContain("validation failed")
    expect(result).toContain("expected one of")
    expect(vi.mocked(fs.writeFileSync)).not.toHaveBeenCalled()
  })

  it("rejects array with non-string elements for phrases.thinking", async () => {
    emitTestEvent("update_config rejects bad array elements")
    const { baseToolDefinitions } = await import("../../repertoire/tools-base")
    const def = baseToolDefinitions.find(d => d.tool.function.name === "update_config")
    const result = await def!.handler({ path: "phrases.thinking", value: '["ok", 42]' })
    expect(result.toLowerCase()).toContain("validation failed")
    expect(result).toContain("expected string at index")
    expect(vi.mocked(fs.writeFileSync)).not.toHaveBeenCalled()
  })

  it("T1 creates nested parent objects when they do not exist", async () => {
    emitTestEvent("update_config T1 creates nested parent")
    // Mock config without shell section
    vi.mocked(fs.readFileSync).mockImplementation((filePath: unknown) => {
      const p = String(filePath)
      if (p.endsWith("agent.json")) {
        return JSON.stringify({ version: 2, enabled: true, humanFacing: { provider: "anthropic", model: "x" }, agentFacing: { provider: "anthropic", model: "x" }, phrases: { thinking: [], tool: [], followup: [] } })
      }
      return ""
    })
    const { baseToolDefinitions } = await import("../../repertoire/tools-base")
    const def = baseToolDefinitions.find(d => d.tool.function.name === "update_config")
    const result = await def!.handler({ path: "shell.defaultTimeout", value: "60000" })
    expect(result.toLowerCase()).toContain("success")
    const writeCall = vi.mocked(fs.writeFileSync).mock.calls[0]
    const written = JSON.parse(writeCall[1] as string)
    expect(written.shell.defaultTimeout).toBe(60000)
  })

  // Fix 3: Integer bounds validation
  it("rejects context.contextMargin below min (0)", async () => {
    emitTestEvent("update_config rejects contextMargin below min")
    const { baseToolDefinitions } = await import("../../repertoire/tools-base")
    const def = baseToolDefinitions.find(d => d.tool.function.name === "update_config")
    const result = await def!.handler({ path: "context.contextMargin", value: "-1" })
    expect(result.toLowerCase()).toContain("validation failed")
    expect(vi.mocked(fs.writeFileSync)).not.toHaveBeenCalled()
  })

  it("rejects context.contextMargin above max (100)", async () => {
    emitTestEvent("update_config rejects contextMargin above max")
    const { baseToolDefinitions } = await import("../../repertoire/tools-base")
    const def = baseToolDefinitions.find(d => d.tool.function.name === "update_config")
    const result = await def!.handler({ path: "context.contextMargin", value: "101" })
    expect(result.toLowerCase()).toContain("validation failed")
    expect(vi.mocked(fs.writeFileSync)).not.toHaveBeenCalled()
  })

  it("rejects context.contextMargin with non-integer value", async () => {
    emitTestEvent("update_config rejects contextMargin non-integer")
    const { baseToolDefinitions } = await import("../../repertoire/tools-base")
    const def = baseToolDefinitions.find(d => d.tool.function.name === "update_config")
    const result = await def!.handler({ path: "context.contextMargin", value: "20.5" })
    expect(result.toLowerCase()).toContain("validation failed")
    expect(vi.mocked(fs.writeFileSync)).not.toHaveBeenCalled()
  })

  it("accepts context.contextMargin at boundary (0 and 100)", async () => {
    emitTestEvent("update_config accepts contextMargin at boundaries")
    const { baseToolDefinitions } = await import("../../repertoire/tools-base")
    const def = baseToolDefinitions.find(d => d.tool.function.name === "update_config")
    const result0 = await def!.handler({ path: "context.contextMargin", value: "0" })
    expect(result0.toLowerCase()).toContain("success")
    vi.mocked(fs.writeFileSync).mockClear()
    vi.mocked(fs.readFileSync).mockImplementation((filePath: unknown) => {
      const p = String(filePath)
      if (p.endsWith("agent.json")) return JSON.stringify(SAMPLE_AGENT_JSON)
      return ""
    })
    const result100 = await def!.handler({ path: "context.contextMargin", value: "100" })
    expect(result100.toLowerCase()).toContain("success")
  })

  it("rejects shell.defaultTimeout below min (1000)", async () => {
    emitTestEvent("update_config rejects shell.defaultTimeout below min")
    const { baseToolDefinitions } = await import("../../repertoire/tools-base")
    const def = baseToolDefinitions.find(d => d.tool.function.name === "update_config")
    const result = await def!.handler({ path: "shell.defaultTimeout", value: "999" })
    expect(result.toLowerCase()).toContain("validation failed")
    expect(vi.mocked(fs.writeFileSync)).not.toHaveBeenCalled()
  })

  it("rejects shell.defaultTimeout above max (600000)", async () => {
    emitTestEvent("update_config rejects shell.defaultTimeout above max")
    const { baseToolDefinitions } = await import("../../repertoire/tools-base")
    const def = baseToolDefinitions.find(d => d.tool.function.name === "update_config")
    const result = await def!.handler({ path: "shell.defaultTimeout", value: "600001" })
    expect(result.toLowerCase()).toContain("validation failed")
    expect(vi.mocked(fs.writeFileSync)).not.toHaveBeenCalled()
  })

  it("rejects shell.defaultTimeout with non-integer", async () => {
    emitTestEvent("update_config rejects shell.defaultTimeout non-integer")
    const { baseToolDefinitions } = await import("../../repertoire/tools-base")
    const def = baseToolDefinitions.find(d => d.tool.function.name === "update_config")
    const result = await def!.handler({ path: "shell.defaultTimeout", value: "30000.5" })
    expect(result.toLowerCase()).toContain("validation failed")
    expect(vi.mocked(fs.writeFileSync)).not.toHaveBeenCalled()
  })

  // Fix 3: logging.sinks enum array validation
  it("rejects logging.sinks with invalid sink name", async () => {
    emitTestEvent("update_config rejects invalid sink name")
    const { baseToolDefinitions } = await import("../../repertoire/tools-base")
    const def = baseToolDefinitions.find(d => d.tool.function.name === "update_config")
    const result = await def!.handler({ path: "logging.sinks", value: '["terminal", "invalid"]' })
    expect(result.toLowerCase()).toContain("validation failed")
    expect(result).toContain("expected one of")
    expect(vi.mocked(fs.writeFileSync)).not.toHaveBeenCalled()
  })

  it("accepts logging.sinks with valid sink names", async () => {
    emitTestEvent("update_config accepts valid sinks")
    const { baseToolDefinitions } = await import("../../repertoire/tools-base")
    const def = baseToolDefinitions.find(d => d.tool.function.name === "update_config")
    const result = await def!.handler({ path: "logging.sinks", value: '["terminal", "ndjson"]' })
    expect(result.toLowerCase()).toContain("success")
  })

  it("rejects logging.sinks with non-string elements", async () => {
    emitTestEvent("update_config rejects non-string sinks")
    const { baseToolDefinitions } = await import("../../repertoire/tools-base")
    const def = baseToolDefinitions.find(d => d.tool.function.name === "update_config")
    const result = await def!.handler({ path: "logging.sinks", value: '[42]' })
    expect(result.toLowerCase()).toContain("validation failed")
    expect(vi.mocked(fs.writeFileSync)).not.toHaveBeenCalled()
  })

  it("rejects logging.sinks with non-array value", async () => {
    emitTestEvent("update_config rejects non-array sinks")
    const { baseToolDefinitions } = await import("../../repertoire/tools-base")
    const def = baseToolDefinitions.find(d => d.tool.function.name === "update_config")
    const result = await def!.handler({ path: "logging.sinks", value: '"terminal"' })
    expect(result.toLowerCase()).toContain("validation failed")
    expect(vi.mocked(fs.writeFileSync)).not.toHaveBeenCalled()
  })
})

describe("propose_config tool (T2 only)", () => {
  beforeEach(() => {
    vi.resetModules()
    vi.mocked(fs.readFileSync).mockReset()
    vi.mocked(fs.writeFileSync).mockReset()
    vi.mocked(fs.readFileSync).mockImplementation((filePath: unknown) => {
      const p = String(filePath)
      if (p.endsWith("agent.json")) {
        return JSON.stringify(SAMPLE_AGENT_JSON)
      }
      return ""
    })
    vi.mocked(fs.writeFileSync).mockImplementation(() => {})
  })

  it("exists in baseToolDefinitions", async () => {
    emitTestEvent("propose_config exists")
    const { baseToolDefinitions } = await import("../../repertoire/tools-base")
    const def = baseToolDefinitions.find(d => d.tool.function.name === "propose_config")
    expect(def).toBeDefined()
  })

  it("has required path and value parameters", async () => {
    emitTestEvent("propose_config has correct parameters")
    const { baseToolDefinitions } = await import("../../repertoire/tools-base")
    const def = baseToolDefinitions.find(d => d.tool.function.name === "propose_config")
    expect(def).toBeDefined()
    const params = def!.tool.function.parameters as { properties: Record<string, unknown>; required: string[] }
    expect(params.properties).toHaveProperty("path")
    expect(params.properties).toHaveProperty("value")
    expect(params.required).toContain("path")
    expect(params.required).toContain("value")
  })

  it("has confirmationAlwaysRequired set to true (non-bypassable)", async () => {
    emitTestEvent("propose_config has confirmationAlwaysRequired")
    const { baseToolDefinitions } = await import("../../repertoire/tools-base")
    const def = baseToolDefinitions.find(d => d.tool.function.name === "propose_config")
    expect(def).toBeDefined()
    expect(def!.confirmationRequired).toBe(true)
    expect(def!.confirmationAlwaysRequired).toBe(true)
  })

  it("T2: applies T2 change when confirmation is obtained", async () => {
    emitTestEvent("propose_config T2 applies change")
    const { baseToolDefinitions } = await import("../../repertoire/tools-base")
    const def = baseToolDefinitions.find(d => d.tool.function.name === "propose_config")
    const result = await def!.handler({ path: "context.maxTokens", value: "120000" })
    expect(result.toLowerCase()).toContain("success")
    expect(vi.mocked(fs.writeFileSync)).toHaveBeenCalled()
    const writeCall = vi.mocked(fs.writeFileSync).mock.calls[0]
    const written = JSON.parse(writeCall[1] as string)
    expect(written.context.maxTokens).toBe(120000)
  })

  it("T1: refuses T1 key with guidance to use update_config", async () => {
    emitTestEvent("propose_config refuses T1")
    const { baseToolDefinitions } = await import("../../repertoire/tools-base")
    const def = baseToolDefinitions.find(d => d.tool.function.name === "propose_config")
    const result = await def!.handler({ path: "context.contextMargin", value: "25" })
    expect(result.toLowerCase()).toContain("update_config")
    expect(vi.mocked(fs.writeFileSync)).not.toHaveBeenCalled()
  })

  it("T3: refuses T3 key with explanation", async () => {
    emitTestEvent("propose_config refuses T3")
    const { baseToolDefinitions } = await import("../../repertoire/tools-base")
    const def = baseToolDefinitions.find(d => d.tool.function.name === "propose_config")
    const result = await def!.handler({ path: "version", value: "3" })
    expect(result.toLowerCase()).toContain("operator-only")
    expect(vi.mocked(fs.writeFileSync)).not.toHaveBeenCalled()
  })

  it("unknown path returns error", async () => {
    emitTestEvent("propose_config unknown path error")
    const { baseToolDefinitions } = await import("../../repertoire/tools-base")
    const def = baseToolDefinitions.find(d => d.tool.function.name === "propose_config")
    const result = await def!.handler({ path: "nonexistent.key", value: "42" })
    expect(result.toLowerCase()).toContain("unknown")
  })

  it("invalid JSON value returns error", async () => {
    emitTestEvent("propose_config invalid JSON error")
    const { baseToolDefinitions } = await import("../../repertoire/tools-base")
    const def = baseToolDefinitions.find(d => d.tool.function.name === "propose_config")
    const result = await def!.handler({ path: "context.maxTokens", value: "{invalid" })
    expect(result.toLowerCase()).toContain("invalid")
  })

  it("validates value against registry validator", async () => {
    emitTestEvent("propose_config validates value")
    const { baseToolDefinitions } = await import("../../repertoire/tools-base")
    const def = baseToolDefinitions.find(d => d.tool.function.name === "propose_config")
    const result = await def!.handler({ path: "humanFacing.provider", value: '"invalid-provider"' })
    expect(result.toLowerCase()).toContain("validation failed")
    expect(vi.mocked(fs.writeFileSync)).not.toHaveBeenCalled()
  })

  it("T2 creates nested parent objects when section does not exist", async () => {
    emitTestEvent("propose_config T2 creates nested parent")
    vi.mocked(fs.readFileSync).mockImplementation((filePath: unknown) => {
      const p = String(filePath)
      if (p.endsWith("agent.json")) {
        return JSON.stringify({ version: 2, enabled: true, humanFacing: { provider: "anthropic", model: "x" }, agentFacing: { provider: "anthropic", model: "x" }, phrases: { thinking: [], tool: [], followup: [] } })
      }
      return ""
    })
    const { baseToolDefinitions } = await import("../../repertoire/tools-base")
    const def = baseToolDefinitions.find(d => d.tool.function.name === "propose_config")
    const result = await def!.handler({ path: "sync.enabled", value: "true" })
    expect(result.toLowerCase()).toContain("success")
    const writeCall = vi.mocked(fs.writeFileSync).mock.calls[0]
    const written = JSON.parse(writeCall[1] as string)
    expect(written.sync.enabled).toBe(true)
  })

  // Fix 3: Integer bounds validation on T2 keys
  it("rejects context.maxTokens below min (1000)", async () => {
    emitTestEvent("propose_config rejects maxTokens below min")
    const { baseToolDefinitions } = await import("../../repertoire/tools-base")
    const def = baseToolDefinitions.find(d => d.tool.function.name === "propose_config")
    const result = await def!.handler({ path: "context.maxTokens", value: "999" })
    expect(result.toLowerCase()).toContain("validation failed")
    expect(vi.mocked(fs.writeFileSync)).not.toHaveBeenCalled()
  })

  it("rejects context.maxTokens above max (1000000)", async () => {
    emitTestEvent("propose_config rejects maxTokens above max")
    const { baseToolDefinitions } = await import("../../repertoire/tools-base")
    const def = baseToolDefinitions.find(d => d.tool.function.name === "propose_config")
    const result = await def!.handler({ path: "context.maxTokens", value: "1000001" })
    expect(result.toLowerCase()).toContain("validation failed")
    expect(vi.mocked(fs.writeFileSync)).not.toHaveBeenCalled()
  })

  it("rejects context.maxTokens with non-integer", async () => {
    emitTestEvent("propose_config rejects maxTokens non-integer")
    const { baseToolDefinitions } = await import("../../repertoire/tools-base")
    const def = baseToolDefinitions.find(d => d.tool.function.name === "propose_config")
    const result = await def!.handler({ path: "context.maxTokens", value: "80000.5" })
    expect(result.toLowerCase()).toContain("validation failed")
    expect(vi.mocked(fs.writeFileSync)).not.toHaveBeenCalled()
  })

  it("rejects object with wrong field type for senses.cli", async () => {
    emitTestEvent("propose_config rejects wrong field type in object")
    const { baseToolDefinitions } = await import("../../repertoire/tools-base")
    const def = baseToolDefinitions.find(d => d.tool.function.name === "propose_config")
    const result = await def!.handler({ path: "senses.cli", value: '{"enabled": "yes"}' })
    expect(result.toLowerCase()).toContain("validation failed")
    expect(result).toContain('field "enabled"')
    expect(vi.mocked(fs.writeFileSync)).not.toHaveBeenCalled()
  })

  it("rejects non-object value for senses.teams", async () => {
    emitTestEvent("propose_config rejects non-object for object key")
    const { baseToolDefinitions } = await import("../../repertoire/tools-base")
    const def = baseToolDefinitions.find(d => d.tool.function.name === "propose_config")
    const result = await def!.handler({ path: "senses.teams", value: '"not an object"' })
    expect(result.toLowerCase()).toContain("validation failed")
    expect(result).toContain("expected object")
    expect(vi.mocked(fs.writeFileSync)).not.toHaveBeenCalled()
  })

  it("rejects array value where object expected for senses.bluebubbles", async () => {
    emitTestEvent("propose_config rejects array for object key")
    const { baseToolDefinitions } = await import("../../repertoire/tools-base")
    const def = baseToolDefinitions.find(d => d.tool.function.name === "propose_config")
    const result = await def!.handler({ path: "senses.bluebubbles", value: '[true]' })
    expect(result.toLowerCase()).toContain("validation failed")
    expect(result).toContain("expected object, got array")
    expect(vi.mocked(fs.writeFileSync)).not.toHaveBeenCalled()
  })

  it("rejects missing required field for senses.cli", async () => {
    emitTestEvent("propose_config rejects missing required field")
    const { baseToolDefinitions } = await import("../../repertoire/tools-base")
    const def = baseToolDefinitions.find(d => d.tool.function.name === "propose_config")
    const result = await def!.handler({ path: "senses.cli", value: '{"foo": "bar"}' })
    expect(result.toLowerCase()).toContain("validation failed")
    expect(result).toContain('missing required field "enabled"')
    expect(vi.mocked(fs.writeFileSync)).not.toHaveBeenCalled()
  })

  it("accepts valid enum value for humanFacing.provider", async () => {
    emitTestEvent("propose_config accepts valid enum")
    const { baseToolDefinitions } = await import("../../repertoire/tools-base")
    const def = baseToolDefinitions.find(d => d.tool.function.name === "propose_config")
    const result = await def!.handler({ path: "humanFacing.provider", value: '"azure"' })
    expect(result.toLowerCase()).toContain("success")
  })
})

describe("confirmationAlwaysRequired on ToolDefinition", () => {
  it("isConfirmationAlwaysRequired returns true for propose_config", async () => {
    emitTestEvent("isConfirmationAlwaysRequired propose_config")
    const { isConfirmationAlwaysRequired } = await import("../../repertoire/tools")
    expect(isConfirmationAlwaysRequired("propose_config")).toBe(true)
  })

  it("isConfirmationAlwaysRequired returns false for update_config", async () => {
    emitTestEvent("isConfirmationAlwaysRequired update_config")
    const { isConfirmationAlwaysRequired } = await import("../../repertoire/tools")
    expect(isConfirmationAlwaysRequired("update_config")).toBe(false)
  })

  it("isConfirmationAlwaysRequired returns false for regular tools", async () => {
    emitTestEvent("isConfirmationAlwaysRequired regular tool")
    const { isConfirmationAlwaysRequired } = await import("../../repertoire/tools")
    expect(isConfirmationAlwaysRequired("shell")).toBe(false)
    expect(isConfirmationAlwaysRequired("read_file")).toBe(false)
  })
})
