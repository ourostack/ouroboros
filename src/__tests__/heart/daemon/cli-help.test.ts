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
import { parseOuroCommand, usage } from "../../../heart/daemon/cli-parse"
import { runOuroCli } from "../../../heart/daemon/cli-exec"
import { CLI_COMMANDS, CLI_ENTRY_POINTS, cliHelpJson, entryPointHelp, helpEntry } from "../../../heart/daemon/cli-manifest"
import { getRepoRoot } from "../../../heart/identity"
import type { OuroCliDeps } from "../../../heart/daemon/cli-types"

// ── Unit 0a: Command metadata registry ──

describe("COMMAND_REGISTRY", () => {
  it("documents agent-qualified daemon log pruning", () => {
    expect(COMMAND_REGISTRY.logs.usage).toContain("prune --agent <name>")
  })

  it("exports a registry object", () => {
    emitNervesEvent({ component: "daemon", event: "cli_help_test_start", message: "testing registry export" })
    expect(COMMAND_REGISTRY).toBeDefined()
    expect(typeof COMMAND_REGISTRY).toBe("object")
  })

  it("contains all top-level commands from parseOuroCommand", () => {
    // W6 Unit 8b retired the legacy `task` and `reminder` umbrella verbs
    // alongside the built-in task module; W6 Unit 10 restored `task` as
    // an alias that routes through the desk MCP server (verb-and-router
    // layer — no business logic in the harness).
    const expectedCommands = [
      "up", "stop", "down", "status", "logs", "dev", "hatch", "rollback", "versions",
      "doctor", "whoami", "config", "changelog", "chat", "msg",
      "habit", "poke", "friend", "link", "auth", "thoughts", "private", "inner",
      "attention", "session", "mcp", "mcp-serve", "acp-serve", "setup", "hook", "connect", "bluebubbles",
      // desk umbrella CLI + task alias
      "desk", "task",
      // legacy-tasks-to-desk migrator
      "migrate-to-desk",
    ]
    for (const cmd of expectedCommands) {
      expect(COMMAND_REGISTRY).toHaveProperty(cmd)
    }
    expect(COMMAND_REGISTRY).not.toHaveProperty("reminder")
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
    // friend, habit, auth, attention, mcp, desk, task should have subcommands
    // (legacy task umbrella retired in W6 Unit 8b; restored as alias in W6 Unit 10)
    const commandsWithSubcommands = ["friend", "habit", "auth", "attention", "mcp", "desk", "task"]
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
  it("fits one screen, every line within the kit's 100 columns", () => {
    emitNervesEvent({ component: "daemon", event: "cli_help_grouped_test", message: "testing grouped help" })
    const lines = getGroupedHelp().split("\n")
    expect(lines[0]).toBe("Usage: ouro <command> [options]")
    expect(lines.length).toBeLessThanOrEqual(60)
    for (const line of lines) expect([...line].length).toBeLessThanOrEqual(100)
  })

  it("names the first word of every listed command, once, under its card's group", () => {
    const result = getGroupedHelp()
    const listed = CLI_COMMANDS.filter((command) => !command.hidden && command.ax)
    for (const command of listed) expect(result).toMatch(new RegExp(`[ ,]${command.name.split(" ")[0]}(,|\n|$)`))
    expect(result).toMatch(/\n  lifecycle +clone, dev, /)
    expect(result).toMatch(/\n  mailbox +mailbox/)
    expect(result.match(/[ ,]up(,|\n)/g)).toHaveLength(1)
  })

  it("keeps a word whose commands are all hidden out of the overview", () => {
    const hiddenOnly = [...new Set(CLI_COMMANDS.filter((command) => command.hidden).map((command) => command.name.split(" ")[0]!))]
      .filter((word) => !CLI_COMMANDS.some((command) => !command.hidden && command.name.split(" ")[0] === word))
    const result = getGroupedHelp()
    for (const word of hiddenOnly) expect(result).not.toMatch(new RegExp(`[ ,]${word}(,|\n)`))
  })

  it("documents the inner command only as a private-status legacy alias", () => {
    const result = getCommandHelp("inner")!
    expect(result).toContain("Legacy alias for `ouro private status`")
    expect(result).toContain("ouro inner [--agent <name>]")
  })

  it("ends by naming the per-command help and the help as data", () => {
    expect(getGroupedHelp()).toMatch(/Run ouro <command> --help for one command, or ouro help --json for every command as data\.$/)
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

  it("has no help for the removed outlook alias, and mailbox help names only the generated words", () => {
    expect(getCommandHelp("mailbox")).toContain("ouro mailbox <send|list|read|wait|withdraw|deliver> [--json]")
    expect(getCommandHelp("mailbox")).not.toMatch(/--open|--port|browser/)
    expect(getCommandHelp("outlook")).toBeNull()
  })

  it("includes Sentinel read and refresh help under work commands", () => {
    const workHelp = getCommandHelp("work")!
    const sentinelHelp = getCommandHelp("work sentinel")!
    expect(workHelp).toContain("card|gauntlet|sentinel")
    expect(workHelp).toContain("sentinel")
    expect(sentinelHelp).toContain("ouro work sentinel [refresh]")
    expect(sentinelHelp).toContain("--agent <name>")
    expect(sentinelHelp).toContain("--format text|json")
    expect(sentinelHelp).toContain("--json")
    expect(sentinelHelp).toContain("read-only")
    expect(sentinelHelp).toContain("explicitly refresh")
  })

  it("documents grounded offline habit cancellation at parent and nested help", () => {
    expect(COMMAND_REGISTRY.habit.subcommands).toContain("cancel")
    const parent = getCommandHelp("habit")!
    const nested = getCommandHelp("habit cancel")!
    expect(parent).toContain("cancel")
    expect(nested).toContain(
      "ouro habit cancel --agent <name> --habit <name> --evidence <bridge-id>",
    )
    expect(nested).toContain("offline")
    expect(nested).toContain("evidence bridge")
    expect(nested).not.toContain("--actor")
    expect(nested).not.toContain("--request")
    expect(nested).not.toContain("--trust")
  })

  it("documents ouro as the nerves-review default process", () => {
    const result = getCommandHelp("nerves-review")!
    expect(result).toContain("default: ouro")
    expect(result).not.toContain("default: daemon")
  })

  it("describes `up` in plain language instead of leaning on house metaphor", () => {
    expect(COMMAND_REGISTRY["up"].description).toContain("Start and check Ouro")
  })

  it("documents exact version intent and its explicit latest escape hatch", () => {
    expect(getCommandHelp("up")).toContain("--latest")
    expect(getCommandHelp("rollback")).toContain("pinned")
    expect(getCommandHelp("rollback")).toContain("ouro up --latest")
    expect(getCommandHelp("versions")).toContain("intent")
  })

  it("documents truthful MCP freeze diagnostics", () => {
    const help = getCommandHelp("mcp doctor")!
    expect(help).toContain("--host-stall-observed")
    expect(help).toContain("host-stall-unexplained")
    expect(help).toContain("does not prove")
  })

  it("documents BlueBubbles host and webhook setup as standard connect behavior", () => {
    const connectHelp = getCommandHelp("connect bluebubbles")!
    const hostHelp = getCommandHelp("bluebubbles host")!
    expect(connectHelp).toContain("host")
    expect(connectHelp).toContain("webhook")
    expect(hostHelp).toContain("human-required")
    expect(hostHelp).toContain("collect --request-id")
    expect(COMMAND_REGISTRY.bluebubbles.subcommands).toContain("host")
  })

  it("describes connect subcommands in terms of what travels with the agent versus this machine", () => {
    expect(COMMAND_REGISTRY["connect"].description).toContain("guided screen")
    expect(getCommandHelp("connect perplexity")).toContain("portable")
    expect(getCommandHelp("connect embeddings")).toContain("portable")
    expect(getCommandHelp("connect teams")).toContain("portable")
    expect(getCommandHelp("connect bluebubbles")).toContain("this machine only")
    expect(getCommandHelp("connect mail")).toContain("portable")
  })

  it("includes usage for known command", () => {
    const result = getCommandHelp("friend")!
    expect(result).toContain(COMMAND_REGISTRY["friend"].usage)
  })

  it("includes subcommands when present", () => {
    const result = getCommandHelp("friend")!
    const friendEntry = COMMAND_REGISTRY["friend"]
    for (const sub of friendEntry.subcommands!) {
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

  it("shows generic vault item help before compatibility aliases", () => {
    const result = getCommandHelp("vault")

    expect(result).not.toBeNull()
    expect(result).toContain("vault item set")
    expect(result).toContain("vault item status")
    expect(result).toContain("vault item list")
    expect(result).toContain("vault ops porkbun set")
    expect(result!.indexOf("vault item set")).toBeLessThan(result!.indexOf("vault ops porkbun set"))

    expect(getCommandHelp("vault item set")).toContain("ordinary vault item")
    expect(getCommandHelp("vault item set")).toContain("no assumed use")
    expect(getCommandHelp("vault item set")).toContain("notes")
    expect(getCommandHelp("vault item set")).toContain("secret values are not printed")

    expect(getCommandHelp("vault ops porkbun set")).toContain("deprecated compatibility alias")
    expect(getCommandHelp("vault ops porkbun set")).toContain("ouro vault item set --template porkbun-api")
    expect(getCommandHelp("vault ops porkbun set")).not.toContain("ops vault item")
  })

  it("returns focused help for connect", () => {
    const result = getCommandHelp("connect")

    expect(result).not.toBeNull()
    expect(result).toContain("ouro connect [providers|perplexity|embeddings|teams|bluebubbles|mail|voice|a2a|workbench] [--agent <name>]")
    expect(result).toContain("providers")
    expect(result).toContain("perplexity")
    expect(result).toContain("embeddings")
    expect(result).toContain("teams")
    expect(result).toContain("bluebubbles")
    expect(result).toContain("mail")
    expect(result).toContain("voice")
    expect(result).toContain("a2a")
    expect(result).toContain("workbench")
    expect(getCommandHelp("connect workbench")).toContain("ouro connect workbench [--agent <name>]")
  })

  it("returns focused help for A2A subcommands", () => {
    expect(getCommandHelp("a2a card")).toContain("ouro a2a card [--agent <name>]")
    expect(getCommandHelp("a2a onboard")).toContain("ouro a2a onboard [--agent <name>] (--card-url <url>|--did <did:key> --name <name>)")
    expect(getCommandHelp("a2a serve")).toContain("ouro a2a serve [--agent <name>]")
  })

  it("returns focused help for mail import-mbox", () => {
    const result = getCommandHelp("mail import-mbox")

    expect(result).not.toBeNull()
    expect(result).toContain("ouro mail import-mbox (--file <path>|--discover)")
    expect(result).toContain("--owner-email <email>")
  })

  it("returns focused help for foreground hosted mail cache convergence", () => {
    const result = getCommandHelp("mail sync-cache")
    expect(result).toContain("ouro mail sync-cache [--agent <name>]")
    expect(result).toContain("foreground")
    expect(result).toContain("hosted")
    expect(result).toContain("three")
    expect(result).toContain("20")
    expect(result).toContain("30-second")
    expect(result).toContain("missing-key receipts")
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
    expect(parseOuroCommand(["a2a", "card", "--help"])).toEqual({ kind: "help", command: "a2a card" })
    expect(parseOuroCommand(["a2a", "onboard", "--help"])).toEqual({ kind: "help", command: "a2a onboard" })
    expect(parseOuroCommand(["a2a", "serve", "--help"])).toEqual({ kind: "help", command: "a2a serve" })
    expect(parseOuroCommand(["habit", "cancel", "--help"])).toEqual({ kind: "help", command: "habit cancel" })
    expect(parseOuroCommand(["help", "habit", "cancel"])).toEqual({ kind: "help", command: "habit cancel" })
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
    expect(result).toContain("\n  lifecycle  ")
    expect(result).toContain("\n  mind  ")
    expect(deps.writeStdout).toHaveBeenCalledWith(result)
  })

  it("ouro help --json lists every declared command with who sees its effect, and the exit codes", async () => {
    const result = await runOuroCli(["help", "--json"], makeDeps())
    const help = JSON.parse(result) as {
      commands: Array<{ name: string; effect: string }>
      exitCodes: Array<{ code: number }>
    }
    expect(help.commands.map((command) => command.name)).toEqual(CLI_COMMANDS.map((command) => command.name))
    expect(help.commands.every((command) => command.effect === "private" || command.effect === "others")).toBe(true)
    expect(help.exitCodes.map((exit) => exit.code)).toEqual([0, 1])
  })

  it("ouro help --json gives each command its own usage lines, so an agent sees the flags a command needs", async () => {
    const help = JSON.parse(await runOuroCli(["help", "--json"], makeDeps())) as { commands: Array<{ name: string; usage: string[] }> }
    const usageOf = (name: string) => help.commands.find((command) => command.name === name)!.usage
    expect(usageOf("check")).toEqual(["ouro check [--agent <name>] --lane outward|inner"])
    expect(usageOf("vault")).toEqual(["ouro vault"])
  })

  it("ouro help --json serves each command's Ouro AX card, the entry points, and the unknown-command card", async () => {
    const help = JSON.parse(await runOuroCli(["help", "--json"], makeDeps())) as {
      commands: Array<Record<string, unknown>>
      entryPoints: unknown[]
      errors: Array<{ code: string }>
    }
    // The old page's bare `mailbox` command is gone; `mailbox` now names the generated group, carded read-only.
    expect(help.commands.find((command) => command.name === "mailbox")).toMatchObject({ consent: "read", errors: [expect.objectContaining({ code: "usage" }), expect.objectContaining({ code: "unknown-flag" }), expect.objectContaining({ code: "person-only" })] })
    expect(help.commands.find((command) => command.name === "check")).toMatchObject({ example: "ouro check --lane inner" })
    expect(help.entryPoints).toHaveLength(CLI_ENTRY_POINTS.length)
    expect(help.errors.map((error) => error.code)).toEqual(["unknown-door"])
  })

  it("ouro help --json lists every declared command and every entry point by name, each entry point with its card", async () => {
    const help = JSON.parse(await runOuroCli(["help", "--json"], makeDeps())) as {
      commands: Array<{ name: string }>
      entryPoints: Array<{ name: string; usage: string[]; group?: string; errors?: Array<{ code: string }> }>
    }
    expect(new Set(help.commands.map((command) => command.name))).toEqual(new Set(CLI_COMMANDS.map((command) => command.name)))
    expect(help.entryPoints.map((entry) => entry.name)).toEqual(CLI_ENTRY_POINTS.map((entry) => entry.name.replace("node dist/", `node ${getRepoRoot()}/dist/`)))
    expect(help.entryPoints.length).toBeGreaterThan(0)
    for (const entry of help.entryPoints) {
      expect(entry.name.startsWith(`node ${getRepoRoot()}/dist/`)).toBe(true)
      expect(entry.usage).toEqual([entry.name])
      expect(entry.group).toEqual(expect.any(String))
      expect(entry.errors?.length).toBeGreaterThan(0)
    }
  })

  it("renders each entry point's command line with the installed package's absolute path, never a relative node dist/", () => {
    const entry = {
      name: "node dist/x.js", effect: "private" as const, summary: "Run x.",
      ax: { id: "cli:node dist/x.js", group: "entry-points", when: "Start node dist/x.js by hand.", effect: "write" as const,
        errors: [{ code: "usage", means: "node dist/x.js needs a flag.", fix: "Run node dist/x.js --flag." }] },
    }
    expect(entryPointHelp(entry, "/opt/ouro")).toMatchObject({
      name: "node /opt/ouro/dist/x.js", usage: ["node /opt/ouro/dist/x.js"], when: "Start node /opt/ouro/dist/x.js by hand.",
      errors: [{ code: "usage", means: "node /opt/ouro/dist/x.js needs a flag.", fix: "Run node /opt/ouro/dist/x.js --flag." }],
    })
    // The card itself keeps its source text and id; only the rendered help changes.
    expect(entry.name).toBe("node dist/x.js")
    expect(entry.ax.errors[0]!.fix).toBe("Run node dist/x.js --flag.")
    const help = JSON.parse(cliHelpJson("/opt/ouro")) as { entryPoints: Array<{ name: string }> }
    expect(JSON.stringify(help.entryPoints)).not.toContain("node dist/")
    expect(help.entryPoints.every((e) => e.name.startsWith("node /opt/ouro/dist/"))).toBe(true)
    // By default the root is the running package's own.
    expect((JSON.parse(cliHelpJson()) as { entryPoints: Array<{ name: string }> }).entryPoints[0]!.name.startsWith(`node ${getRepoRoot()}/dist/`)).toBe(true)
  })

  it("tags the parser's refusals with the codes the cards name: usage for bad words, unknown-door for no command", async () => {
    await expect(runOuroCli(["check"], makeDeps())).rejects.toMatchObject({ code: "usage" })
    await expect(runOuroCli(["xyzzy-no-such-command"], makeDeps())).rejects.toMatchObject({ code: "unknown-door" })
  })

  it("describes an entry point by its own command line, and a command with no card by its name alone", () => {
    expect(entryPointHelp({ name: "node dist/x.js", effect: "private", summary: "Run x." }, "/opt/ouro")).toEqual({
      name: "node /opt/ouro/dist/x.js", effect: "private", summary: "Run x.", usage: ["node /opt/ouro/dist/x.js"],
    })
  })

  it.each([["--help"], ["-h"]])("%s --json prints the same help as data", async (flag) => {
    const result = await runOuroCli([flag, "--json"], makeDeps())
    expect(JSON.parse(result)).toMatchObject({ tool: "ouro" })
  })

  it("every declared command is one the usage text lists, except a hidden legacy spelling", () => {
    const lines = usage().split("\n")
    expect(CLI_COMMANDS.filter((command) => command.hidden).map((command) => command.name)).toEqual(["inner"])
    expect(helpEntry(CLI_COMMANDS.find((command) => command.hidden)!)).toMatchObject({ hidden: true })
    for (const command of CLI_COMMANDS.filter((declared) => !declared.hidden)) {
      const words = command.name.split(" ")
      const last = words.pop()!
      const prefix = `  ouro ${[...words, ""].join(" ")}`
      const line = lines.find((text) => text.startsWith(prefix) && text.slice(prefix.length).split(/[\s[<(]/)[0]!.split("|").includes(last))
      expect(line, command.name).toBeDefined()
    }
  })

  it("ouro -h outputs grouped help", async () => {
    const deps = makeDeps()
    const result = await runOuroCli(["-h"], deps)
    expect(result).toContain("\n  lifecycle  ")
    expect(result).not.toContain("config model")
    expect(result).not.toContain("auth switch")
  })

  it("ouro help outputs grouped help via command routing", async () => {
    const deps = makeDeps()
    const result = await runOuroCli(["help"], deps)
    expect(result).toContain("\n  lifecycle  ")
    expect(result).toContain("\n  mind  ")
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

    await expect(runOuroCli(["help", "auth", "verify"], deps)).resolves.toContain("ouro auth verify [--agent <name>]")
    await expect(runOuroCli(["help", "auth", "switch"], deps)).resolves.toContain("ouro auth switch [--agent <name>]")
    await expect(runOuroCli(["help", "provider", "refresh"], deps)).resolves.toContain("ouro provider refresh [--agent <name>]")
    await expect(runOuroCli(["help", "use"], deps)).resolves.toContain("ouro use [--agent <name>]")
  })

  it("ouro help covers documented A2A subcommands", async () => {
    const deps = makeDeps()

    await expect(runOuroCli(["help", "a2a", "card"], deps)).resolves.toContain("ouro a2a card [--agent <name>]")
    await expect(runOuroCli(["a2a", "onboard", "--help"], deps)).resolves.toContain("ouro a2a onboard [--agent <name>] (--card-url <url>|--did <did:key> --name <name>)")
    await expect(runOuroCli(["a2a", "serve", "--help"], deps)).resolves.toContain("ouro a2a serve [--agent <name>]")
  })

  it("ouro help <unknown> outputs fallback grouped help", async () => {
    const deps = makeDeps()
    const result = await runOuroCli(["help", "xyzzy"], deps)
    expect(result).toContain("Unknown command: xyzzy")
    expect(result).toContain("\n  lifecycle  ")
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
    expect(() => parseOuroCommand(["xyzzy"])).toThrow(expect.objectContaining({ code: "unknown-door" }))
    try {
      parseOuroCommand(["xyzzy"])
    } catch (e: unknown) {
      expect((e as Error).message).not.toContain("Did you mean")
    }
  })
})
