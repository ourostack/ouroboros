import { describe, expect, it, vi } from "vitest"
import { emitNervesEvent } from "../../../nerves/runtime"
import {
  COMMAND_REGISTRY,
  getGroupedHelp,
  getCommandHelp,
  levenshteinDistance,
  suggestCommand,
  type CommandHelp,
  type CommandCategory,
} from "../../../heart/daemon/cli-help"
import { parseOuroCommand } from "../../../heart/daemon/cli-parse"
import { runOuroCli } from "../../../heart/daemon/cli-exec"
import type { OuroCliDeps } from "../../../heart/daemon/cli-types"

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

  it("omits example section when example is undefined", () => {
    // Temporarily remove example to test the branch
    const original = COMMAND_REGISTRY["up"].example
    delete (COMMAND_REGISTRY["up"] as Record<string, unknown>).example
    try {
      const result = getCommandHelp("up")!
      expect(result).not.toContain("Example:")
    } finally {
      COMMAND_REGISTRY["up"].example = original
    }
  })

  it("returns focused help for vault recover", () => {
    const result = getCommandHelp("vault recover")

    expect(result).not.toBeNull()
    expect(result).toContain("vault recover")
    expect(result).toContain("--from <json> [--from <json> ...]")
    expect(result).not.toContain("--generate-unlock-secret")
  })

  it("returns focused help for vault replace", () => {
    const result = getCommandHelp("vault replace")

    expect(result).not.toBeNull()
    expect(result).toContain("vault replace")
    expect(result).toContain("no unlock secret or JSON export exists")
    expect(result).not.toContain("--from <json>")
    expect(result).not.toContain("--generate-unlock-secret")
  })
})

// ── Unit 1a: Levenshtein distance + "did you mean?" ──

describe("levenshteinDistance()", () => {
  it("returns 0 for identical strings", () => {
    emitNervesEvent({ component: "daemon", event: "cli_help_levenshtein_test", message: "testing levenshtein" })
    expect(levenshteinDistance("stop", "stop")).toBe(0)
  })

  it("returns 1 for single character substitution", () => {
    expect(levenshteinDistance("stop", "stap")).toBe(1)
  })

  it("returns 1 for single character insertion", () => {
    expect(levenshteinDistance("stop", "stopp")).toBe(1)
  })

  it("returns 1 for single character deletion", () => {
    expect(levenshteinDistance("stop", "sto")).toBe(1)
  })

  it("returns correct distance for transposition-like change", () => {
    // "stpo" -> "stop" is 2 operations (transpose = delete + insert)
    expect(levenshteinDistance("stpo", "stop")).toBeLessThanOrEqual(2)
  })

  it("returns string length when compared to empty string", () => {
    expect(levenshteinDistance("", "stop")).toBe(4)
    expect(levenshteinDistance("stop", "")).toBe(4)
  })

  it("returns 0 for two empty strings", () => {
    expect(levenshteinDistance("", "")).toBe(0)
  })

  it("handles completely different strings", () => {
    expect(levenshteinDistance("abc", "xyz")).toBe(3)
  })
})

describe("suggestCommand()", () => {
  it("suggests 'stop' for 'stpo'", () => {
    emitNervesEvent({ component: "daemon", event: "cli_help_suggest_test", message: "testing suggestions" })
    expect(suggestCommand("stpo")).toBe("stop")
  })

  it("suggests 'status' for 'statu'", () => {
    expect(suggestCommand("statu")).toBe("status")
  })

  it("suggests 'logs' for 'lgs'", () => {
    expect(suggestCommand("lgs")).toBe("logs")
  })

  it("returns null for input with no close match", () => {
    expect(suggestCommand("xyzzy")).toBeNull()
  })

  it("returns null for empty input", () => {
    expect(suggestCommand("")).toBeNull()
  })

  it("returns exact match command name for distance 0", () => {
    expect(suggestCommand("stop")).toBe("stop")
  })
})

// ── Unit 2a: help command kind ──

describe("parseOuroCommand help handling", () => {
  it("parses 'help' as { kind: 'help' }", () => {
    emitNervesEvent({ component: "daemon", event: "cli_help_parse_test", message: "testing help parse" })
    expect(parseOuroCommand(["help"])).toEqual({ kind: "help" })
  })

  it("parses 'help chat' as { kind: 'help', command: 'chat' }", () => {
    expect(parseOuroCommand(["help", "chat"])).toEqual({ kind: "help", command: "chat" })
  })

  it("parses 'help task' as { kind: 'help', command: 'task' }", () => {
    expect(parseOuroCommand(["help", "task"])).toEqual({ kind: "help", command: "task" })
  })

  it("parses 'chat --help' as { kind: 'help', command: 'chat' }", () => {
    expect(parseOuroCommand(["chat", "--help"])).toEqual({ kind: "help", command: "chat" })
  })

  it("parses 'task --help' as { kind: 'help', command: 'task' }", () => {
    expect(parseOuroCommand(["task", "--help"])).toEqual({ kind: "help", command: "task" })
  })

  it("parses 'status --help' as { kind: 'help', command: 'status' }", () => {
    expect(parseOuroCommand(["status", "--help"])).toEqual({ kind: "help", command: "status" })
  })

  it("parses top-level -h as grouped help", () => {
    expect(parseOuroCommand(["-h"])).toEqual({ kind: "help" })
  })

  it("parses nested command help before flags", () => {
    expect(parseOuroCommand(["vault", "replace", "--help"])).toEqual({ kind: "help", command: "vault replace" })
    expect(parseOuroCommand(["vault", "replace", "--agent", "slugger", "--help"]))
      .toEqual({ kind: "help", command: "vault replace" })
    expect(parseOuroCommand(["help", "vault", "replace"])).toEqual({ kind: "help", command: "vault replace" })
    expect(parseOuroCommand(["vault", "recover", "--help"])).toEqual({ kind: "help", command: "vault recover" })
    expect(parseOuroCommand(["vault", "recover", "--agent", "slugger", "--help"]))
      .toEqual({ kind: "help", command: "vault recover" })
    expect(parseOuroCommand(["help", "vault", "recover"])).toEqual({ kind: "help", command: "vault recover" })
    expect(parseOuroCommand(["help", "auth", "verify"])).toEqual({ kind: "help", command: "auth verify" })
    expect(parseOuroCommand(["auth", "switch", "--help"])).toEqual({ kind: "help", command: "auth switch" })
    expect(parseOuroCommand(["provider", "refresh", "--help"])).toEqual({ kind: "help", command: "provider refresh" })
    expect(parseOuroCommand(["use", "--help"])).toEqual({ kind: "help", command: "use" })
  })
})

// ── Unit 2c: runOuroCli help execution ──

describe("runOuroCli help execution", () => {
  function makeDeps(): OuroCliDeps {
    return {
      socketPath: "/tmp/ouro-test.sock",
      sendCommand: vi.fn(),
      startDaemonProcess: vi.fn(async () => ({ pid: 1 })),
      writeStdout: vi.fn(),
      checkSocketAlive: vi.fn(async () => true),
      cleanupStaleSocket: vi.fn(),
      fallbackPendingMessage: vi.fn(() => "/tmp/pending.jsonl"),
    }
  }

  it("ouro --help outputs grouped help", async () => {
    emitNervesEvent({ component: "daemon", event: "cli_help_exec_test", message: "testing help execution" })
    const deps = makeDeps()
    const result = await runOuroCli(["--help"], deps)
    expect(result).toContain("Lifecycle")
    expect(result).toContain("Chat")
    expect(deps.writeStdout).toHaveBeenCalledWith(result)
  })

  it("ouro -h outputs grouped help", async () => {
    const deps = makeDeps()
    const result = await runOuroCli(["-h"], deps)
    expect(result).toContain("Lifecycle")
  })

  it("ouro help outputs grouped help via command routing", async () => {
    const deps = makeDeps()
    const result = await runOuroCli(["help"], deps)
    expect(result).toContain("Lifecycle")
    expect(result).toContain("Chat")
  })

  it("ouro help chat outputs per-command help for chat", async () => {
    const deps = makeDeps()
    const result = await runOuroCli(["help", "chat"], deps)
    expect(result).toContain("chat")
    expect(result).toContain(COMMAND_REGISTRY["chat"].description)
  })

  it("ouro vault recover --help outputs recovery options", async () => {
    const deps = makeDeps()
    const result = await runOuroCli(["vault", "recover", "--help"], deps)

    expect(result).toContain("vault recover")
    expect(result).toContain("--from <json> [--from <json> ...]")
    expect(result).not.toContain("--generate-unlock-secret")
    expect(deps.writeStdout).toHaveBeenCalledWith(result)
  })

  it("ouro vault replace --help outputs no-export replacement options", async () => {
    const deps = makeDeps()
    const result = await runOuroCli(["vault", "replace", "--help"], deps)

    expect(result).toContain("vault replace")
    expect(result).toContain("no unlock secret or JSON export exists")
    expect(result).not.toContain("--from <json>")
    expect(result).not.toContain("--generate-unlock-secret")
    expect(deps.writeStdout).toHaveBeenCalledWith(result)
  })

  it("ouro help vault recover outputs the same recovery help", async () => {
    const deps = makeDeps()
    const result = await runOuroCli(["help", "vault", "recover"], deps)

    expect(result).toContain("vault recover")
    expect(result).toContain("--from <json> [--from <json> ...]")
    expect(result).not.toContain("--generate-unlock-secret")
  })

  it("ouro help covers documented auth bootstrap commands", async () => {
    const deps = makeDeps()

    await expect(runOuroCli(["help", "auth", "verify"], deps)).resolves.toContain("ouro auth verify --agent <name>")
    await expect(runOuroCli(["help", "auth", "switch"], deps)).resolves.toContain("ouro auth switch --agent <name>")
    await expect(runOuroCli(["help", "provider", "refresh"], deps)).resolves.toContain("ouro provider refresh --agent <name>")
    await expect(runOuroCli(["help", "use"], deps)).resolves.toContain("ouro use --agent <name>")
  })

  it("ouro help <unknown> outputs fallback grouped help", async () => {
    const deps = makeDeps()
    const result = await runOuroCli(["help", "xyzzy"], deps)
    expect(result).toContain("Unknown command: xyzzy")
    expect(result).toContain("Lifecycle")
  })
})

// ── Unit 3a: "Did you mean?" in error path ──

describe("parseOuroCommand typo suggestions", () => {
  it("includes 'Did you mean' for close typo 'stpo'", () => {
    emitNervesEvent({ component: "daemon", event: "cli_help_typo_test", message: "testing typo suggestions" })
    expect(() => parseOuroCommand(["stpo"])).toThrow(/Did you mean 'stop'\?/)
  })

  it("includes 'Did you mean' for close typo 'statu'", () => {
    expect(() => parseOuroCommand(["statu"])).toThrow(/Did you mean 'status'\?/)
  })

  it("does NOT include 'Did you mean' for distant unknown command", () => {
    expect(() => parseOuroCommand(["xyzzy"])).toThrow(/Unknown command/)
    try {
      parseOuroCommand(["xyzzy"])
    } catch (e: unknown) {
      expect((e as Error).message).not.toContain("Did you mean")
    }
  })
})
