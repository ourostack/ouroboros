import { describe, expect, it } from "vitest"
import { emitNervesEvent } from "../../../nerves/runtime"
import {
  COMMAND_REGISTRY,
  getGroupedHelp,
  getCommandHelp,
  type CommandHelp,
  type CommandCategory,
} from "../../../heart/daemon/cli-help"

// ── Unit 0a: Command metadata registry ──

describe("COMMAND_REGISTRY", () => {
  it("exports a registry object", () => {
    emitNervesEvent({ component: "daemon", event: "cli_help_test_start", message: "testing registry export" })
    expect(COMMAND_REGISTRY).toBeDefined()
    expect(typeof COMMAND_REGISTRY).toBe("object")
  })

  it("contains all top-level commands from parseOuroCommand", () => {
    const expectedCommands = [
      "up", "stop", "down", "status", "logs", "dev", "hatch", "rollback", "versions",
      "doctor", "outlook", "whoami", "config", "changelog", "chat", "msg", "task",
      "reminder", "habit", "poke", "friend", "link", "auth", "thoughts", "inner",
      "attention", "session", "mcp", "mcp-serve", "setup", "hook", "bluebubbles",
    ]
    for (const cmd of expectedCommands) {
      expect(COMMAND_REGISTRY).toHaveProperty(cmd)
    }
  })

  it("each entry has required fields", () => {
    for (const [name, entry] of Object.entries(COMMAND_REGISTRY)) {
      expect(entry).toHaveProperty("description")
      expect(entry).toHaveProperty("usage")
      expect(entry).toHaveProperty("category")
      expect(typeof entry.description).toBe("string")
      expect(typeof entry.usage).toBe("string")
      expect(entry.description.length).toBeGreaterThan(0)
      expect(entry.usage.length).toBeGreaterThan(0)
      // category must be a valid CommandCategory
      const validCategories: CommandCategory[] = [
        "Lifecycle", "Agents", "Chat", "Tasks", "Habits",
        "Friends", "Auth", "Internal", "System",
      ]
      expect(validCategories).toContain(entry.category)
    }
  })

  it("entries with subcommands have a non-empty array", () => {
    // task, friend, habit, auth, attention, mcp should have subcommands
    const commandsWithSubcommands = ["task", "friend", "habit", "auth", "attention", "mcp"]
    for (const cmd of commandsWithSubcommands) {
      const entry = COMMAND_REGISTRY[cmd]
      expect(entry.subcommands).toBeDefined()
      expect(Array.isArray(entry.subcommands)).toBe(true)
      expect(entry.subcommands!.length).toBeGreaterThan(0)
    }
  })

  it("entries without subcommands omit the field or have undefined", () => {
    // Simple commands like "up", "stop", "status" should not have subcommands
    const simpleCommands = ["up", "stop", "status", "doctor", "versions"]
    for (const cmd of simpleCommands) {
      const entry = COMMAND_REGISTRY[cmd]
      expect(entry.subcommands === undefined || entry.subcommands === undefined).toBe(true)
    }
  })
})

describe("getGroupedHelp()", () => {
  it("returns a string", () => {
    emitNervesEvent({ component: "daemon", event: "cli_help_grouped_test", message: "testing grouped help" })
    const result = getGroupedHelp()
    expect(typeof result).toBe("string")
    expect(result.length).toBeGreaterThan(0)
  })

  it("contains all category headers", () => {
    const result = getGroupedHelp()
    const categories = [
      "Lifecycle", "Agents", "Chat", "Tasks", "Habits",
      "Friends", "Auth", "Internal", "System",
    ]
    for (const cat of categories) {
      expect(result).toContain(cat)
    }
  })

  it("contains command names within their category sections", () => {
    const result = getGroupedHelp()
    // up should appear in the Lifecycle section
    expect(result).toContain("up")
    expect(result).toContain("stop")
    // chat should appear in the Chat section
    expect(result).toContain("chat")
    // task should appear in the Tasks section
    expect(result).toContain("task")
  })

  it("includes a Usage header line", () => {
    const result = getGroupedHelp()
    expect(result).toMatch(/usage:/i)
  })

  it("groups commands under category headers not as a flat list", () => {
    const result = getGroupedHelp()
    const lines = result.split("\n")
    // There should be multiple category headers (lines that contain a category name)
    const categoryLines = lines.filter((l) =>
      ["Lifecycle", "Agents", "Chat", "Tasks", "Habits", "Friends", "Auth", "Internal", "System"].some((c) => l.includes(c)),
    )
    expect(categoryLines.length).toBeGreaterThanOrEqual(9)
  })
})

describe("getCommandHelp()", () => {
  it("returns help text for a known command", () => {
    emitNervesEvent({ component: "daemon", event: "cli_help_command_test", message: "testing per-command help" })
    const result = getCommandHelp("chat")
    expect(result).not.toBeNull()
    expect(typeof result).toBe("string")
    expect(result!).toContain("chat")
  })

  it("returns null for an unknown command", () => {
    const result = getCommandHelp("xyzzy")
    expect(result).toBeNull()
  })

  it("includes description for known command", () => {
    const result = getCommandHelp("up")!
    expect(result).toContain(COMMAND_REGISTRY["up"].description)
  })

  it("includes usage for known command", () => {
    const result = getCommandHelp("task")!
    expect(result).toContain(COMMAND_REGISTRY["task"].usage)
  })

  it("includes subcommands when present", () => {
    const result = getCommandHelp("task")!
    const taskEntry = COMMAND_REGISTRY["task"]
    for (const sub of taskEntry.subcommands!) {
      expect(result).toContain(sub)
    }
  })

  it("includes example when present", () => {
    const result = getCommandHelp("chat")!
    // If chat has an example, it should be included
    if (COMMAND_REGISTRY["chat"].example) {
      expect(result).toContain(COMMAND_REGISTRY["chat"].example)
    }
  })
})
