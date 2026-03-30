import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("../../heart/identity", () => ({
  getAgentName: vi.fn(() => "testagent"),
  getAgentSecretsPath: vi.fn(() => "/tmp/.agentsecrets/testagent/secrets.json"),
}))

describe("createCommandRegistry", () => {
  beforeEach(() => { vi.resetModules() })

  it("register and get a command", async () => {
    const { createCommandRegistry } = await import("../../senses/commands")
    const registry = createCommandRegistry()
    const handler = vi.fn().mockReturnValue({ action: "response", message: "ok" })
    registry.register({ name: "test", description: "a test command", channels: ["cli"], handler })
    const cmd = registry.get("test")
    expect(cmd).toBeDefined()
    expect(cmd!.name).toBe("test")
    expect(cmd!.description).toBe("a test command")
  })

  it("get returns undefined for unknown command", async () => {
    const { createCommandRegistry } = await import("../../senses/commands")
    const registry = createCommandRegistry()
    expect(registry.get("nonexistent")).toBeUndefined()
  })

  it("list returns commands filtered by channel", async () => {
    const { createCommandRegistry } = await import("../../senses/commands")
    const registry = createCommandRegistry()
    const handler = vi.fn()
    registry.register({ name: "clionly", description: "cli", channels: ["cli"], handler })
    registry.register({ name: "both", description: "both", channels: ["cli", "teams"], handler })
    registry.register({ name: "teamsonly", description: "teams", channels: ["teams"], handler })

    const cliCmds = registry.list("cli")
    expect(cliCmds.map((c) => c.name)).toEqual(["clionly", "both"])

    const teamsCmds = registry.list("teams")
    expect(teamsCmds.map((c) => c.name)).toEqual(["both", "teamsonly"])
  })

  it("dispatch calls handler and returns handled:true", async () => {
    const { createCommandRegistry } = await import("../../senses/commands")
    const registry = createCommandRegistry()
    const handler = vi.fn().mockReturnValue({ action: "exit" })
    registry.register({ name: "quit", description: "quit", channels: ["cli"], handler })

    const result = registry.dispatch("quit", { channel: "cli" })
    expect(result).toEqual({ handled: true, result: { action: "exit" } })
    expect(handler).toHaveBeenCalledWith({ channel: "cli" })
  })

  it("dispatch returns handled:false for unknown command", async () => {
    const { createCommandRegistry } = await import("../../senses/commands")
    const registry = createCommandRegistry()
    const result = registry.dispatch("unknown", { channel: "cli" })
    expect(result).toEqual({ handled: false })
  })
})

describe("registerDefaultCommands", () => {
  beforeEach(() => { vi.resetModules() })

  it("registers exit, new, and commands", async () => {
    const { createCommandRegistry, registerDefaultCommands } = await import("../../senses/commands")
    const registry = createCommandRegistry()
    registerDefaultCommands(registry)

    expect(registry.get("exit")).toBeDefined()
    expect(registry.get("new")).toBeDefined()
    expect(registry.get("commands")).toBeDefined()
  })

  it("/exit handler returns action:exit", async () => {
    const { createCommandRegistry, registerDefaultCommands } = await import("../../senses/commands")
    const registry = createCommandRegistry()
    registerDefaultCommands(registry)

    const result = registry.dispatch("exit", { channel: "cli" })
    expect(result).toEqual({ handled: true, result: { action: "exit" } })
  })

  it("/new handler returns action:new", async () => {
    const { createCommandRegistry, registerDefaultCommands } = await import("../../senses/commands")
    const registry = createCommandRegistry()
    registerDefaultCommands(registry)

    const result = registry.dispatch("new", { channel: "cli" })
    expect(result).toEqual({ handled: true, result: { action: "new" } })
  })

  it("/commands handler returns formatted list for cli channel with em dash separators", async () => {
    const { createCommandRegistry, registerDefaultCommands } = await import("../../senses/commands")
    const registry = createCommandRegistry()
    registerDefaultCommands(registry)

    const result = registry.dispatch("commands", { channel: "cli" })
    expect(result.handled).toBe(true)
    expect(result.result!.action).toBe("response")
    expect(result.result!.message).toContain("/exit")
    expect(result.result!.message).toContain("/new")
    expect(result.result!.message).toContain("/commands")
    // Each line uses em dash separator between name and description
    expect(result.result!.message).toContain("/new \u2014 start a new conversation")
    expect(result.result!.message).toContain("/commands \u2014 list available commands")
  })

  it("/commands handler for teams does NOT include /exit", async () => {
    const { createCommandRegistry, registerDefaultCommands } = await import("../../senses/commands")
    const registry = createCommandRegistry()
    registerDefaultCommands(registry)

    const result = registry.dispatch("commands", { channel: "teams" })
    expect(result.handled).toBe(true)
    expect(result.result!.message).not.toContain("/exit")
    expect(result.result!.message).toContain("/new")
  })

  it("/exit description uses agent name", async () => {
    const { createCommandRegistry, registerDefaultCommands } = await import("../../senses/commands")
    const registry = createCommandRegistry()
    registerDefaultCommands(registry)

    const cmd = registry.get("exit")
    expect(cmd).toBeDefined()
    expect(cmd!.description).toContain("testagent")
  })

  it("/exit is NOT available in teams channel list", async () => {
    const { createCommandRegistry, registerDefaultCommands } = await import("../../senses/commands")
    const registry = createCommandRegistry()
    registerDefaultCommands(registry)

    const teamsCmds = registry.list("teams")
    expect(teamsCmds.map((c) => c.name)).not.toContain("exit")
  })
})

describe("registerDefaultCommands includes tool-required", () => {
  beforeEach(() => { vi.resetModules() })

  it("/tool-required command toggles between ON and OFF", async () => {
    const { createCommandRegistry, registerDefaultCommands } = await import("../../senses/commands")
    const registry = createCommandRegistry()
    registerDefaultCommands(registry)

    // First call: should toggle ON
    const result1 = registry.dispatch("tool-required", { channel: "cli" })
    expect(result1.handled).toBe(true)
    expect(result1.result!.action).toBe("response")
    expect(result1.result!.message).toContain("ON")

    // Second call: should toggle OFF
    const result2 = registry.dispatch("tool-required", { channel: "cli" })
    expect(result2.handled).toBe(true)
    expect(result2.result!.action).toBe("response")
    expect(result2.result!.message).toContain("OFF")
  })

  it("getToolChoiceRequired returns toggle state", async () => {
    const { createCommandRegistry, registerDefaultCommands, getToolChoiceRequired, resetToolChoiceRequired } = await import("../../senses/commands")
    resetToolChoiceRequired() // ensure clean state
    const registry = createCommandRegistry()
    registerDefaultCommands(registry)

    expect(getToolChoiceRequired()).toBe(false)
    registry.dispatch("tool-required", { channel: "cli" })
    expect(getToolChoiceRequired()).toBe(true)
    registry.dispatch("tool-required", { channel: "cli" })
    expect(getToolChoiceRequired()).toBe(false)
  })

  it("resetToolChoiceRequired resets the toggle to false", async () => {
    const { createCommandRegistry, registerDefaultCommands, getToolChoiceRequired, resetToolChoiceRequired } = await import("../../senses/commands")
    const registry = createCommandRegistry()
    registerDefaultCommands(registry)

    registry.dispatch("tool-required", { channel: "cli" }) // toggle ON
    expect(getToolChoiceRequired()).toBe(true)
    resetToolChoiceRequired()
    expect(getToolChoiceRequired()).toBe(false)
  })

  it("/tool-required is CLI-only", async () => {
    const { createCommandRegistry, registerDefaultCommands } = await import("../../senses/commands")
    const registry = createCommandRegistry()
    registerDefaultCommands(registry)

    const cmd = registry.get("tool-required")
    expect(cmd).toBeDefined()
    expect(cmd!.channels).toEqual(["cli"])
  })

  it("/tool-required appears in /commands for cli", async () => {
    const { createCommandRegistry, registerDefaultCommands } = await import("../../senses/commands")
    const registry = createCommandRegistry()
    registerDefaultCommands(registry)

    const result = registry.dispatch("commands", { channel: "cli" })
    expect(result.result!.message).toContain("/tool-required")
  })

  it("/tool-required does NOT appear in /commands for teams", async () => {
    const { createCommandRegistry, registerDefaultCommands } = await import("../../senses/commands")
    const registry = createCommandRegistry()
    registerDefaultCommands(registry)

    const result = registry.dispatch("commands", { channel: "teams" })
    expect(result.result!.message).not.toContain("/tool-required")
  })
})

describe("parseSlashCommand", () => {
  beforeEach(() => { vi.resetModules() })

  it("parses /exit as command 'exit'", async () => {
    const { parseSlashCommand } = await import("../../senses/commands")
    const result = parseSlashCommand("/exit")
    expect(result).toEqual({ command: "exit", args: "" })
  })

  it("parses /new with no args", async () => {
    const { parseSlashCommand } = await import("../../senses/commands")
    const result = parseSlashCommand("/new")
    expect(result).toEqual({ command: "new", args: "" })
  })

  it("parses command with arguments", async () => {
    const { parseSlashCommand } = await import("../../senses/commands")
    const result = parseSlashCommand("/search hello world")
    expect(result).toEqual({ command: "search", args: "hello world" })
  })

  it("returns null for regular text", async () => {
    const { parseSlashCommand } = await import("../../senses/commands")
    expect(parseSlashCommand("hello")).toBeNull()
  })

  it("returns null for text with / in the middle", async () => {
    const { parseSlashCommand } = await import("../../senses/commands")
    expect(parseSlashCommand("use /new to reset")).toBeNull()
  })

  it("trims leading spaces before checking", async () => {
    const { parseSlashCommand } = await import("../../senses/commands")
    const result = parseSlashCommand("  /exit")
    expect(result).toEqual({ command: "exit", args: "" })
  })

  it("is case insensitive", async () => {
    const { parseSlashCommand } = await import("../../senses/commands")
    const result = parseSlashCommand("/Exit")
    expect(result).toEqual({ command: "exit", args: "" })
  })

  it("returns null for / alone", async () => {
    const { parseSlashCommand } = await import("../../senses/commands")
    expect(parseSlashCommand("/")).toBeNull()
  })

  it("returns null for //double", async () => {
    const { parseSlashCommand } = await import("../../senses/commands")
    expect(parseSlashCommand("//double")).toBeNull()
  })
})

describe("commands observability contract", () => {
  it("emits repertoire.load_start event when registering default commands", async () => {
    vi.resetModules()
    const emitNervesEvent = vi.fn()
    vi.doMock("../../nerves/runtime", () => ({
      emitNervesEvent,
    }))
    const { createCommandRegistry, registerDefaultCommands } = await import("../../senses/commands")
    const registry = createCommandRegistry()

    registerDefaultCommands(registry)

    expect(emitNervesEvent).toHaveBeenCalledWith(expect.objectContaining({
      event: "repertoire.load_start",
      component: "repertoire",
    }))
  })
})
