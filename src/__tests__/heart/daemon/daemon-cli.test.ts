import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { afterAll, describe, expect, it, vi } from "vitest"

// Mock provider-ping for auth verify/switch tests
vi.mock("../../../heart/provider-ping", () => ({
  pingProvider: vi.fn().mockResolvedValue({ ok: true }),
}))

import {
  createDefaultOuroCliDeps,
  discoverExistingCredentials,
  parseOuroCommand,
  runOuroCli,
  type OuroCliDeps,
} from "../../../heart/daemon/daemon-cli"
import { OuroDaemon } from "../../../heart/daemon/daemon"
import * as identity from "../../../heart/identity"
import * as sessionActivity from "../../../heart/session-activity"

const PACKAGE_VERSION = JSON.parse(
  fs.readFileSync(path.join(process.cwd(), "package.json"), "utf-8"),
) as { version: string }

describe("ouro CLI parsing", () => {
  it("parses primary daemon commands", () => {
    expect(parseOuroCommand([])).toEqual({ kind: "daemon.up" })
    expect(parseOuroCommand(["up"])).toEqual({ kind: "daemon.up" })
    expect(parseOuroCommand(["stop"])).toEqual({ kind: "daemon.stop" })
    expect(parseOuroCommand(["down"])).toEqual({ kind: "daemon.stop" })
    expect(parseOuroCommand(["status"])).toEqual({ kind: "daemon.status" })
    expect(parseOuroCommand(["logs"])).toEqual({ kind: "daemon.logs" })
    expect(parseOuroCommand(["hatch"])).toEqual({ kind: "hatch.start" })
    expect(
      parseOuroCommand([
        "hatch",
        "--agent",
        "Sprout",
        "--human",
        "Ari",
        "--provider",
        "anthropic",
        "--setup-token",
        "sk-ant-oat01-test-token",
      ]),
    ).toEqual({
      kind: "hatch.start",
      agentName: "Sprout",
      humanName: "Ari",
      provider: "anthropic",
      credentials: {
        setupToken: "sk-ant-oat01-test-token",
      },
    })
    expect(
      parseOuroCommand([
        "hatch",
        "--agent",
        "Sprout",
        "--human",
        "Ari",
        "--provider",
        "openai-codex",
        "--oauth-token",
        "oauth-token-1",
        "--api-key",
        "api-key-1",
        "--endpoint",
        "https://example.openai.azure.com",
        "--deployment",
        "gpt-4o-mini",
        "--migration-path",
        "/tmp/legacy-agent",
      ]),
    ).toEqual({
      kind: "hatch.start",
      agentName: "Sprout",
      humanName: "Ari",
      provider: "openai-codex",
      credentials: {
        oauthAccessToken: "oauth-token-1",
        apiKey: "api-key-1",
        endpoint: "https://example.openai.azure.com",
        deployment: "gpt-4o-mini",
      },
      migrationPath: "/tmp/legacy-agent",
    })

    expect(parseOuroCommand(["hatch", "--unknown-flag", "noop"])).toEqual({
      kind: "hatch.start",
    })
  })

  it("parses hook command with event name and agent", () => {
    expect(parseOuroCommand(["hook", "session-start", "--agent", "slugger"])).toEqual({ kind: "hook", event: "session-start", agent: "slugger" })
    expect(parseOuroCommand(["hook", "stop", "--agent", "slugger"])).toEqual({ kind: "hook", event: "stop", agent: "slugger" })
    expect(parseOuroCommand(["hook", "post-tool-use", "--agent", "slugger"])).toEqual({ kind: "hook", event: "post-tool-use", agent: "slugger" })
  })

  it("throws when hook command has no event name", () => {
    expect(() => parseOuroCommand(["hook"])).toThrow("hook requires an event name")
  })

  it("throws when hook command has no agent", () => {
    expect(() => parseOuroCommand(["hook", "stop"])).toThrow("hook requires --agent")
  })

  it("strips leading --agent flag and parses underlying command", () => {
    expect(parseOuroCommand(["--agent", "ouroboros", "status"])).toEqual({
      kind: "daemon.status",
    })
    expect(parseOuroCommand(["--agent", "ouroboros", "mcp", "list"])).toEqual({
      kind: "mcp.list",
    })
    expect(parseOuroCommand(["--agent", "ouroboros", "whoami"])).toEqual({
      kind: "whoami",
    })
    expect(parseOuroCommand(["--agent", "ouroboros"])).toEqual({
      kind: "daemon.up",
    })
  })

  it("parses auth commands and rejects malformed auth input", () => {
    expect(parseOuroCommand(["auth", "--agent", "slugger"])).toEqual({
      kind: "auth.run",
      agent: "slugger",
    })

    expect(parseOuroCommand(["auth", "--agent", "slugger", "--note", "ignored"])).toEqual({
      kind: "auth.run",
      agent: "slugger",
    })

    expect(parseOuroCommand(["auth", "--agent", "slugger", "--provider", "openai-codex"])).toEqual({
      kind: "auth.run",
      agent: "slugger",
      provider: "openai-codex",
    })

    expect(() => parseOuroCommand(["auth"])).toThrow("ouro auth --agent <name> [--provider <provider>]")
    expect(() => parseOuroCommand(["auth", "--agent", "slugger", "--provider", "not-real"])).toThrow("Usage")
  })

  it("parses auth verify and auth switch subcommands", () => {
    expect(parseOuroCommand(["auth", "verify", "--agent", "foo"])).toEqual({
      kind: "auth.verify",
      agent: "foo",
    })
    expect(parseOuroCommand(["auth", "verify", "--agent", "foo", "--provider", "azure"])).toEqual({
      kind: "auth.verify",
      agent: "foo",
      provider: "azure",
    })
    expect(parseOuroCommand(["auth", "switch", "--agent", "foo", "--provider", "github-copilot"])).toEqual({
      kind: "auth.switch",
      agent: "foo",
      provider: "github-copilot",
    })
    expect(() => parseOuroCommand(["auth", "switch", "--agent", "foo"])).toThrow()

    // --switch and --verify flag forms (Bug 1: user typed --switch instead of switch)
    expect(parseOuroCommand(["auth", "--switch", "--agent", "foo", "--provider", "github-copilot"])).toEqual({
      kind: "auth.switch",
      agent: "foo",
      provider: "github-copilot",
    })
    expect(parseOuroCommand(["auth", "--verify", "--agent", "foo"])).toEqual({
      kind: "auth.verify",
      agent: "foo",
    })
    expect(parseOuroCommand(["auth", "--verify", "--agent", "foo", "--provider", "azure"])).toEqual({
      kind: "auth.verify",
      agent: "foo",
      provider: "azure",
    })
    expect(() => parseOuroCommand(["auth", "--switch", "--agent", "foo"])).toThrow("auth switch requires --provider")
  })

  it("parses chat, message, and poke commands", () => {
    expect(parseOuroCommand(["chat", "slugger"])).toEqual({
      kind: "chat.connect",
      agent: "slugger",
    })

    expect(parseOuroCommand([
      "msg",
      "--session",
      "session-1",
      "--to",
      "slugger",
      "--task",
      "habit-heartbeat",
      "status update",
    ])).toEqual({
      kind: "message.send",
      from: "ouro-cli",
      to: "slugger",
      content: "status update",
      sessionId: "session-1",
      taskRef: "habit-heartbeat",
    })

    expect(parseOuroCommand(["poke", "slugger", "--task", "habit-heartbeat"])).toEqual({
      kind: "task.poke",
      agent: "slugger",
      taskId: "habit-heartbeat",
    })

    expect(parseOuroCommand([
      "link",
      "slugger",
      "--friend",
      "friend-1",
      "--provider",
      "aad",
      "--external-id",
      "aad-user-123",
    ])).toEqual({
      kind: "friend.link",
      agent: "slugger",
      friendId: "friend-1",
      provider: "aad",
      externalId: "aad-user-123",
    })
  })

  it("parses task subcommands", () => {
    // ouro task board (no status filter)
    expect(parseOuroCommand(["task", "board"])).toEqual({ kind: "task.board" })

    // ouro task board <status> (positional status filter -- maps from task_board_status)
    expect(parseOuroCommand(["task", "board", "processing"])).toEqual({
      kind: "task.board",
      status: "processing",
    })

    // ouro task create <title> --type <type>
    expect(parseOuroCommand(["task", "create", "My Task", "--type", "feature"])).toEqual({
      kind: "task.create",
      title: "My Task",
      type: "feature",
    })

    // ouro task create <title> with defaults (type defaults to one-shot)
    expect(parseOuroCommand(["task", "create", "Quick Task"])).toEqual({
      kind: "task.create",
      title: "Quick Task",
    })

    // ouro task create <title> --type without value (ignores incomplete flag)
    expect(parseOuroCommand(["task", "create", "Quick Task", "--type"])).toEqual({
      kind: "task.create",
      title: "Quick Task",
    })

    // ouro task update <id> <status>
    expect(parseOuroCommand(["task", "update", "task-123", "in-progress"])).toEqual({
      kind: "task.update",
      id: "task-123",
      status: "in-progress",
    })

    // ouro task show <id> (NEW -- read and format a task file)
    expect(parseOuroCommand(["task", "show", "task-123"])).toEqual({
      kind: "task.show",
      id: "task-123",
    })

    // ouro task actionable
    expect(parseOuroCommand(["task", "actionable"])).toEqual({ kind: "task.actionable" })

    // ouro task deps
    expect(parseOuroCommand(["task", "deps"])).toEqual({ kind: "task.deps" })

    // ouro task sessions
    expect(parseOuroCommand(["task", "sessions"])).toEqual({ kind: "task.sessions" })

    // ouro task fix (dry-run by default)
    expect(parseOuroCommand(["task", "fix"])).toEqual({ kind: "task.fix", mode: "dry-run" })

    // ouro task fix --safe (apply safe fixes)
    expect(parseOuroCommand(["task", "fix", "--safe"])).toEqual({ kind: "task.fix", mode: "safe" })

    // ouro task fix --all (alias for --safe)
    expect(parseOuroCommand(["task", "fix", "--all"])).toEqual({ kind: "task.fix", mode: "safe" })

    // ouro task fix <id> (single issue detail)
    expect(parseOuroCommand(["task", "fix", "schema-missing-kind:one-shots/foo.md"])).toEqual({
      kind: "task.fix",
      mode: "single",
      issueId: "schema-missing-kind:one-shots/foo.md",
    })

    // ouro task fix <id> --option <N> (apply specific option)
    expect(parseOuroCommand(["task", "fix", "schema-missing-kind:one-shots/foo.md", "--option", "1"])).toEqual({
      kind: "task.fix",
      mode: "single",
      issueId: "schema-missing-kind:one-shots/foo.md",
      option: 1,
    })

    // ouro task fix <id> --option without value (ignores incomplete flag)
    expect(parseOuroCommand(["task", "fix", "schema-missing-kind:one-shots/foo.md", "--option"])).toEqual({
      kind: "task.fix",
      mode: "single",
      issueId: "schema-missing-kind:one-shots/foo.md",
    })

    // ouro task fix with --agent flag
    expect(parseOuroCommand(["task", "fix", "--agent", "slugger"])).toEqual({
      kind: "task.fix",
      mode: "dry-run",
      agent: "slugger",
    })

    // ouro task fix --safe with --agent flag
    expect(parseOuroCommand(["task", "fix", "--safe", "--agent", "slugger"])).toEqual({
      kind: "task.fix",
      mode: "safe",
      agent: "slugger",
    })

    // ouro task fix <id> with --agent flag
    expect(parseOuroCommand(["task", "fix", "schema-missing-kind:one-shots/foo.md", "--agent", "slugger"])).toEqual({
      kind: "task.fix",
      mode: "single",
      issueId: "schema-missing-kind:one-shots/foo.md",
      agent: "slugger",
    })
  })

  it("rejects malformed task subcommands", () => {
    // bare "task" with no subcommand
    expect(() => parseOuroCommand(["task"])).toThrow("Usage")

    // task create with no title
    expect(() => parseOuroCommand(["task", "create"])).toThrow("Usage")

    // task update with no id
    expect(() => parseOuroCommand(["task", "update"])).toThrow("Usage")

    // task update with no status
    expect(() => parseOuroCommand(["task", "update", "task-123"])).toThrow("Usage")

    // task show with no id
    expect(() => parseOuroCommand(["task", "show"])).toThrow("Usage")

    // unknown task subcommand
    expect(() => parseOuroCommand(["task", "unknown"])).toThrow("Usage")
  })

  it("parses reminder subcommands", () => {
    // ouro reminder create <title> --body <body> --at <iso>
    expect(parseOuroCommand(["reminder", "create", "Ping Ari", "--body", "Check daemon status", "--at", "2026-03-10T17:00:00.000Z"])).toEqual({
      kind: "reminder.create",
      title: "Ping Ari",
      body: "Check daemon status",
      scheduledAt: "2026-03-10T17:00:00.000Z",
    })

    // ouro reminder create <title> --body <body> --cadence <cadence>
    expect(parseOuroCommand(["reminder", "create", "Heartbeat", "--body", "Run heartbeat", "--cadence", "30m"])).toEqual({
      kind: "reminder.create",
      title: "Heartbeat",
      body: "Run heartbeat",
      cadence: "30m",
    })

    // ouro reminder create <title> --body <body> --cadence <cadence> --category <category>
    expect(parseOuroCommand(["reminder", "create", "Heartbeat", "--body", "Run heartbeat", "--cadence", "30m", "--category", "operations"])).toEqual({
      kind: "reminder.create",
      title: "Heartbeat",
      body: "Run heartbeat",
      cadence: "30m",
      category: "operations",
    })

    // ouro reminder create <title> --body <body> --at <iso> (one-shot with no cadence)
    expect(parseOuroCommand(["reminder", "create", "Wake up", "--body", "Morning alarm", "--at", "2026-03-11T08:00:00.000Z"])).toEqual({
      kind: "reminder.create",
      title: "Wake up",
      body: "Morning alarm",
      scheduledAt: "2026-03-11T08:00:00.000Z",
    })

    // ouro reminder create --agent slugger <title> --body <body> --cadence <cadence>
    expect(parseOuroCommand(["reminder", "create", "--agent", "slugger", "Heartbeat", "--body", "Run heartbeat", "--cadence", "30m"])).toEqual({
      kind: "reminder.create",
      title: "Heartbeat",
      body: "Run heartbeat",
      cadence: "30m",
      agent: "slugger",
    })

    // ouro reminder create with --requester flag
    expect(parseOuroCommand(["reminder", "create", "PR Review", "--body", "Check PR #47", "--at", "2026-03-12T09:00:00.000Z", "--requester", "arimendelow/cli"])).toEqual({
      kind: "reminder.create",
      title: "PR Review",
      body: "Check PR #47",
      scheduledAt: "2026-03-12T09:00:00.000Z",
      requester: "arimendelow/cli",
    })
  })

  it("rejects malformed reminder subcommands", () => {
    // bare "reminder" with no subcommand
    expect(() => parseOuroCommand(["reminder"])).toThrow("Usage")

    // reminder create with no title
    expect(() => parseOuroCommand(["reminder", "create"])).toThrow("Usage")

    // reminder create with no --body
    expect(() => parseOuroCommand(["reminder", "create", "Title only"])).toThrow("Usage")

    // reminder create with --body but no schedule
    expect(() => parseOuroCommand(["reminder", "create", "Title", "--body", "body text"])).toThrow("Usage")

    // reminder create with --category but no value (ignores incomplete flag)
    expect(parseOuroCommand(["reminder", "create", "Title", "--body", "body text", "--at", "2026-03-10T17:00:00.000Z", "--category"])).toEqual({
      kind: "reminder.create",
      title: "Title",
      body: "body text",
      scheduledAt: "2026-03-10T17:00:00.000Z",
    })

    // reminder create with --cadence but no value (ignores incomplete flag, then fails on missing schedule)
    expect(() => parseOuroCommand(["reminder", "create", "Title", "--body", "body text", "--cadence"])).toThrow("Usage")

    // reminder create with --at but no value (ignores incomplete flag, then fails on missing schedule)
    expect(() => parseOuroCommand(["reminder", "create", "Title", "--body", "body text", "--at"])).toThrow("Usage")

    // unknown reminder subcommand
    expect(() => parseOuroCommand(["reminder", "unknown"])).toThrow("Usage")
  })

  it("parses whoami and session subcommands", () => {
    // ouro whoami
    expect(parseOuroCommand(["whoami"])).toEqual({ kind: "whoami" })

    // ouro session list
    expect(parseOuroCommand(["session", "list"])).toEqual({ kind: "session.list" })
  })

  it("parses thoughts command", () => {
    expect(parseOuroCommand(["thoughts"])).toEqual({ kind: "thoughts" })
  })

  it("parses thoughts command with --last flag", () => {
    expect(parseOuroCommand(["thoughts", "--last", "5"])).toEqual({ kind: "thoughts", last: 5 })
  })

  it("parses thoughts command with --json flag", () => {
    expect(parseOuroCommand(["thoughts", "--json"])).toEqual({ kind: "thoughts", json: true })
  })

  it("parses thoughts command with --agent flag", () => {
    expect(parseOuroCommand(["thoughts", "--agent", "slugger"])).toEqual({ kind: "thoughts", agent: "slugger" })
  })

  it("parses thoughts command with --follow flag", () => {
    expect(parseOuroCommand(["thoughts", "--follow"])).toEqual({ kind: "thoughts", follow: true })
  })

  it("parses thoughts command with -f shorthand", () => {
    expect(parseOuroCommand(["thoughts", "-f"])).toEqual({ kind: "thoughts", follow: true })
  })

  it("parses thoughts command with all flags", () => {
    expect(parseOuroCommand(["thoughts", "--agent", "slugger", "--last", "20", "--json", "--follow"])).toEqual({
      kind: "thoughts",
      agent: "slugger",
      last: 20,
      json: true,
      follow: true,
    })
  })

  it("parses attention command (list)", () => {
    expect(parseOuroCommand(["attention"])).toEqual({ kind: "attention.list" })
  })

  it("parses attention command with --agent flag", () => {
    expect(parseOuroCommand(["attention", "--agent", "slugger"])).toEqual({ kind: "attention.list", agent: "slugger" })
  })

  it("parses attention show <id>", () => {
    expect(parseOuroCommand(["attention", "show", "obl-123"])).toEqual({ kind: "attention.show", id: "obl-123" })
  })

  it("parses attention show <id> with --agent", () => {
    expect(parseOuroCommand(["attention", "show", "obl-123", "--agent", "slugger"])).toEqual({ kind: "attention.show", id: "obl-123", agent: "slugger" })
  })

  it("parses attention history", () => {
    expect(parseOuroCommand(["attention", "history"])).toEqual({ kind: "attention.history" })
  })

  it("parses attention history with --agent", () => {
    expect(parseOuroCommand(["attention", "history", "--agent", "slugger"])).toEqual({ kind: "attention.history", agent: "slugger" })
  })

  it("rejects malformed session subcommands", () => {
    // bare "session" with no subcommand
    expect(() => parseOuroCommand(["session"])).toThrow("Usage")

    // unknown session subcommand
    expect(() => parseOuroCommand(["session", "unknown"])).toThrow("Usage")
  })

  it("parses friend subcommands", () => {
    // ouro friend list
    expect(parseOuroCommand(["friend", "list"])).toEqual({ kind: "friend.list" })

    // ouro friend show <id>
    expect(parseOuroCommand(["friend", "show", "abc-123"])).toEqual({
      kind: "friend.show",
      friendId: "abc-123",
    })
  })

  it("parses friend link subcommand", () => {
    expect(parseOuroCommand([
      "friend", "link", "slugger",
      "--friend", "friend-1",
      "--provider", "aad",
      "--external-id", "aad-user-123",
    ])).toEqual({
      kind: "friend.link",
      agent: "slugger",
      friendId: "friend-1",
      provider: "aad",
      externalId: "aad-user-123",
    })
  })

  it("parses friend unlink subcommand", () => {
    expect(parseOuroCommand([
      "friend", "unlink", "slugger",
      "--friend", "friend-1",
      "--provider", "aad",
      "--external-id", "aad-user-123",
    ])).toEqual({
      kind: "friend.unlink",
      agent: "slugger",
      friendId: "friend-1",
      provider: "aad",
      externalId: "aad-user-123",
    })
  })

  it("ouro link still works as backward compat alias", () => {
    expect(parseOuroCommand([
      "link", "slugger",
      "--friend", "friend-1",
      "--provider", "aad",
      "--external-id", "ext-1",
    ])).toEqual({
      kind: "friend.link",
      agent: "slugger",
      friendId: "friend-1",
      provider: "aad",
      externalId: "ext-1",
    })
  })

  it("rejects malformed friend subcommands", () => {
    // bare "friend" with no subcommand
    expect(() => parseOuroCommand(["friend"])).toThrow("Usage")

    // friend show with no id
    expect(() => parseOuroCommand(["friend", "show"])).toThrow("Usage")

    // unknown friend subcommand
    expect(() => parseOuroCommand(["friend", "unknown"])).toThrow("Usage")

    // friend link with no agent
    expect(() => parseOuroCommand(["friend", "link"])).toThrow("Usage")

    // friend unlink with no agent
    expect(() => parseOuroCommand(["friend", "unlink"])).toThrow("Usage")
  })

  it("rejects deprecated command families", () => {
    expect(() => parseOuroCommand(["agent", "start", "slugger"])).toThrow("Unknown command")
    expect(() => parseOuroCommand(["cron", "list"])).toThrow("Unknown command")
  })

  it("throws on malformed command shapes", () => {
    expect(() => parseOuroCommand(["chat"])).toThrow("Usage")
    expect(() => parseOuroCommand(["msg", "--to", "slugger"])).toThrow("Usage")
    expect(() => parseOuroCommand(["poke"])).toThrow("Usage")
    expect(() => parseOuroCommand(["link"])).toThrow("Usage")
    expect(() => parseOuroCommand(["link", "slugger", "--friend", "friend-1", "--provider", "aad"])).toThrow("Usage")
    expect(() =>
      parseOuroCommand([
        "link",
        "slugger",
        "--friend",
        "friend-1",
        "--provider",
        "unknown-provider",
        "--external-id",
        "ext-1",
      ]),
    ).toThrow("Unknown identity provider")
    expect(parseOuroCommand([
      "link",
      "slugger",
      "--external-id",
      "ext-1",
      "--provider",
      "aad",
      "--friend",
      "friend-1",
    ])).toEqual({
      kind: "friend.link",
      agent: "slugger",
      friendId: "friend-1",
      provider: "aad",
      externalId: "ext-1",
    })
    expect(parseOuroCommand([
      "link",
      "slugger",
      "--friend",
      "friend-1",
      "--provider",
      "aad",
      "--external-id",
      "ext-1",
      "--ignored",
      "value",
    ])).toEqual({
      kind: "friend.link",
      agent: "slugger",
      friendId: "friend-1",
      provider: "aad",
      externalId: "ext-1",
    })
    expect(parseOuroCommand(["poke", "slugger", "extra", "--task", "habit-heartbeat"])).toEqual({
      kind: "task.poke",
      agent: "slugger",
      taskId: "habit-heartbeat",
    })
    expect(() => parseOuroCommand(["poke", "slugger"])).toThrow("Usage")
    expect(() =>
      parseOuroCommand(["hatch", "--agent", "Sprout", "--human", "Ari", "--provider", "invalid-provider"]),
    ).toThrow("Unknown provider")
    expect(() => parseOuroCommand(["mystery"])).toThrow("Unknown command")
  })

  it("parses dev command", () => {
    expect(parseOuroCommand(["dev"])).toEqual({ kind: "daemon.dev", repoPath: undefined, clone: false, clonePath: undefined })
  })
})

describe("ouro CLI execution", () => {
  it("prints the runtime version for short and long version flags", async () => {
    const deps: OuroCliDeps = {
      socketPath: "/tmp/ouro-test.sock",
      sendCommand: vi.fn(),
      startDaemonProcess: vi.fn(async () => ({ pid: 1 })),
      writeStdout: vi.fn(),
      checkSocketAlive: vi.fn(async () => true),
      cleanupStaleSocket: vi.fn(),
      fallbackPendingMessage: vi.fn(() => "/tmp/pending.jsonl"),

    }

    const shortResult = await runOuroCli(["-v"], deps)
    const longResult = await runOuroCli(["--version"], deps)

    expect(shortResult).toContain(PACKAGE_VERSION.version)
    expect(longResult).toContain(PACKAGE_VERSION.version)
    expect(deps.writeStdout).toHaveBeenNthCalledWith(1, expect.stringContaining(PACKAGE_VERSION.version))
    expect(deps.writeStdout).toHaveBeenNthCalledWith(2, expect.stringContaining(PACKAGE_VERSION.version))
    expect(deps.sendCommand).not.toHaveBeenCalled()
  })

  it("starts daemon on `up` when socket is not live", async () => {
    const deps: OuroCliDeps = {
      socketPath: "/tmp/ouro-test.sock",
      sendCommand: vi.fn(),
      startDaemonProcess: vi.fn(async () => ({ pid: 12345 })),
      writeStdout: vi.fn(),
      checkSocketAlive: vi.fn(async () => false),
      cleanupStaleSocket: vi.fn(),
      fallbackPendingMessage: vi.fn(() => "/tmp/pending.jsonl"),
    }

    const result = await runOuroCli(["up"], deps)

    expect(result).toContain("daemon started")
    expect(deps.startDaemonProcess).toHaveBeenCalledWith("/tmp/ouro-test.sock")
    expect(deps.sendCommand).not.toHaveBeenCalled()
  })

  it("runs `auth` locally with provider autodetected from agent.json", async () => {
    const agentName = `auth-local-${Date.now()}`
    const agentRoot = path.join(os.homedir(), "AgentBundles", `${agentName}.ouro`)
    fs.mkdirSync(agentRoot, { recursive: true })
    fs.writeFileSync(
      path.join(agentRoot, "agent.json"),
      JSON.stringify({
        version: 2,
        enabled: true,
        provider: "anthropic",
        humanFacing: { provider: "anthropic", model: "claude-opus-4-6" },
        agentFacing: { provider: "anthropic", model: "claude-opus-4-6" },
        phrases: {
          thinking: ["working"],
          tool: ["running tool"],
          followup: ["processing"],
        },
      }, null, 2) + "\n",
      "utf-8",
    )

    const runAuthFlow = vi.fn(async () => ({ message: `authenticated ${agentName} with anthropic` }))
    const deps = {
      socketPath: "/tmp/ouro-test.sock",
      sendCommand: vi.fn(async () => ({ ok: true, message: "unexpected daemon call" })),
      startDaemonProcess: vi.fn(async () => ({ pid: 1 })),
      writeStdout: vi.fn(),
      checkSocketAlive: vi.fn(async () => true),
      cleanupStaleSocket: vi.fn(),
      fallbackPendingMessage: vi.fn(() => "/tmp/pending.jsonl"),

      runAuthFlow,
    } as OuroCliDeps & {
      runAuthFlow: typeof runAuthFlow
    }

    try {
      const result = await runOuroCli(["auth", "--agent", agentName], deps)

      expect(result).toBe(`authenticated ${agentName} with anthropic`)
      expect(runAuthFlow).toHaveBeenCalledWith(expect.objectContaining({
        agentName,
        provider: "anthropic",
      }))
      expect(deps.sendCommand).not.toHaveBeenCalled()
    } finally {
      fs.rmSync(agentRoot, { recursive: true, force: true })
    }
  })

  it("ouro auth --provider stores credentials without switching provider", async () => {
    const agentName = `auth-store-${Date.now()}`
    const agentRoot = path.join(os.homedir(), "AgentBundles", `${agentName}.ouro`)
    const agentConfigPath = path.join(agentRoot, "agent.json")
    fs.mkdirSync(agentRoot, { recursive: true })
    fs.writeFileSync(
      agentConfigPath,
      JSON.stringify({
        version: 2,
        enabled: true,
        provider: "anthropic",
        humanFacing: { provider: "anthropic", model: "claude-opus-4-6" },
        agentFacing: { provider: "anthropic", model: "claude-opus-4-6" },
        phrases: {
          thinking: ["working"],
          tool: ["running tool"],
          followup: ["processing"],
        },
      }, null, 2) + "\n",
      "utf-8",
    )

    const runAuthFlow = vi.fn(async () => ({ message: `authenticated ${agentName} with openai-codex` }))
    const deps = {
      socketPath: "/tmp/ouro-test.sock",
      sendCommand: vi.fn(async () => ({ ok: true, message: "unexpected daemon call" })),
      startDaemonProcess: vi.fn(async () => ({ pid: 1 })),
      writeStdout: vi.fn(),
      checkSocketAlive: vi.fn(async () => true),
      cleanupStaleSocket: vi.fn(),
      fallbackPendingMessage: vi.fn(() => "/tmp/pending.jsonl"),

      runAuthFlow,
    } as OuroCliDeps & {
      runAuthFlow: typeof runAuthFlow
    }

    try {
      const result = await runOuroCli(["auth", "--agent", agentName, "--provider", "openai-codex"], deps)

      expect(result).toBe(`authenticated ${agentName} with openai-codex`)
      expect(runAuthFlow).toHaveBeenCalledWith(expect.objectContaining({
        agentName,
        provider: "openai-codex",
      }))
      // Behavior change: auth stores credentials but does NOT switch
      const updated = JSON.parse(fs.readFileSync(agentConfigPath, "utf-8")) as { provider: string }
      expect(updated.provider).toBe("anthropic")
      expect(deps.sendCommand).not.toHaveBeenCalled()
    } finally {
      fs.rmSync(agentRoot, { recursive: true, force: true })
    }
  })

  it("uses the default runtime auth flow when no auth runner is injected", async () => {
    vi.resetModules()

    const defaultRunRuntimeAuthFlow = vi.fn(async () => ({
      message: "authenticated slugger with minimax",
    }))
    const readAgentConfigForAgent = vi.fn(() => ({
      config: {
        provider: "minimax",
        humanFacing: { provider: "minimax", model: "minimax-text-01" },
        agentFacing: { provider: "minimax", model: "minimax-text-01" },
      },
    }))
    const writeAgentProviderSelection = vi.fn()

    vi.doMock("../../../heart/daemon/auth-flow", async () => {
      const actual = await vi.importActual<typeof import("../../../heart/daemon/auth-flow")>("../../../heart/daemon/auth-flow")
      return {
        ...actual,
        runRuntimeAuthFlow: defaultRunRuntimeAuthFlow,
        readAgentConfigForAgent,
        writeAgentProviderSelection,
      }
    })

    try {
      const { runOuroCli: runFreshOuroCli } = await import("../../../heart/daemon/daemon-cli")
      const deps: OuroCliDeps = {
        socketPath: "/tmp/ouro-test.sock",
        sendCommand: vi.fn(async () => ({ ok: true, message: "unexpected daemon call" })),
        startDaemonProcess: vi.fn(async () => ({ pid: 1 })),
        writeStdout: vi.fn(),
        checkSocketAlive: vi.fn(async () => true),
        cleanupStaleSocket: vi.fn(),
        fallbackPendingMessage: vi.fn(() => "/tmp/pending.jsonl"),
  
        promptInput: vi.fn(async () => ""),
      }

      const result = await runFreshOuroCli(["auth", "--agent", "slugger"], deps)

      expect(result).toBe("authenticated slugger with minimax")
      expect(readAgentConfigForAgent).toHaveBeenCalledWith("slugger")
      expect(defaultRunRuntimeAuthFlow).toHaveBeenCalledWith({
        agentName: "slugger",
        provider: "minimax",
        promptInput: deps.promptInput,
      })
      expect(writeAgentProviderSelection).not.toHaveBeenCalled()
    } finally {
      vi.doUnmock("../../../heart/daemon/auth-flow")
      vi.resetModules()
    }
  })

  it("ouro auth --provider stores credentials but does NOT switch provider", async () => {
    const agentName = `auth-no-switch-${Date.now()}`
    const agentRoot = path.join(os.homedir(), "AgentBundles", `${agentName}.ouro`)
    const agentConfigPath = path.join(agentRoot, "agent.json")
    fs.mkdirSync(agentRoot, { recursive: true })
    fs.writeFileSync(
      agentConfigPath,
      JSON.stringify({
        version: 2, enabled: true, provider: "anthropic",
        humanFacing: { provider: "anthropic", model: "claude-opus-4-6" },
        agentFacing: { provider: "anthropic", model: "claude-opus-4-6" },
        phrases: { thinking: ["working"], tool: ["running tool"], followup: ["processing"] },
      }, null, 2) + "\n",
      "utf-8",
    )
    const runAuthFlow = vi.fn(async () => ({ message: `authenticated ${agentName} with github-copilot` }))
    const deps = {
      socketPath: "/tmp/ouro-test.sock",
      sendCommand: vi.fn(async () => ({ ok: true, message: "ok" })),
      startDaemonProcess: vi.fn(async () => ({ pid: 1 })),
      writeStdout: vi.fn(),
      checkSocketAlive: vi.fn(async () => true),
      cleanupStaleSocket: vi.fn(),
      fallbackPendingMessage: vi.fn(() => "/tmp/pending.jsonl"),
      runAuthFlow,
    } as OuroCliDeps & { runAuthFlow: typeof runAuthFlow }
    try {
      await runOuroCli(["auth", "--agent", agentName, "--provider", "github-copilot"], deps)
      const updated = JSON.parse(fs.readFileSync(agentConfigPath, "utf-8")) as { provider: string }
      expect(updated.provider).toBe("anthropic")
    } finally {
      fs.rmSync(agentRoot, { recursive: true, force: true })
    }
  })

  it("ouro auth verify reports provider status", async () => {
    const agentName = `auth-verify-${Date.now()}`
    const agentRoot = path.join(os.homedir(), "AgentBundles", `${agentName}.ouro`)
    fs.mkdirSync(agentRoot, { recursive: true })
    fs.writeFileSync(
      path.join(agentRoot, "agent.json"),
      JSON.stringify({
        version: 2, enabled: true, provider: "anthropic",
        humanFacing: { provider: "anthropic", model: "claude-opus-4-6" },
        agentFacing: { provider: "anthropic", model: "claude-opus-4-6" },
        phrases: { thinking: ["working"], tool: ["running tool"], followup: ["processing"] },
      }, null, 2) + "\n",
      "utf-8",
    )
    const deps: OuroCliDeps = {
      socketPath: "/tmp/ouro-test.sock",
      sendCommand: vi.fn(async () => ({ ok: true, message: "ok" })),
      startDaemonProcess: vi.fn(async () => ({ pid: 1 })),
      writeStdout: vi.fn(),
      checkSocketAlive: vi.fn(async () => true),
      cleanupStaleSocket: vi.fn(),
      fallbackPendingMessage: vi.fn(() => "/tmp/pending.jsonl"),
    }
    try {
      const result = await runOuroCli(["auth", "verify", "--agent", agentName], deps)
      expect(typeof result).toBe("string")
      expect(result).toContain("anthropic")
    } finally {
      fs.rmSync(agentRoot, { recursive: true, force: true })
    }
  })

  it("ouro auth switch updates provider in agent.json", async () => {
    const agentName = `auth-switch-new-${Date.now()}`
    const agentRoot = path.join(os.homedir(), "AgentBundles", `${agentName}.ouro`)
    const agentConfigPath = path.join(agentRoot, "agent.json")
    fs.mkdirSync(agentRoot, { recursive: true })
    const secretsDir = path.join(os.homedir(), ".agentsecrets", agentName)
    fs.mkdirSync(secretsDir, { recursive: true })
    fs.writeFileSync(
      path.join(secretsDir, "secrets.json"),
      JSON.stringify({
        providers: { "github-copilot": { model: "claude-sonnet-4.6", githubToken: "ghp_test", baseUrl: "https://api.test.com" } },
      }, null, 2) + "\n",
      "utf-8",
    )
    fs.writeFileSync(
      agentConfigPath,
      JSON.stringify({
        version: 2, enabled: true, provider: "anthropic",
        humanFacing: { provider: "anthropic", model: "claude-opus-4-6" },
        agentFacing: { provider: "anthropic", model: "claude-opus-4-6" },
        phrases: { thinking: ["working"], tool: ["running tool"], followup: ["processing"] },
      }, null, 2) + "\n",
      "utf-8",
    )
    const deps: OuroCliDeps = {
      socketPath: "/tmp/ouro-test.sock",
      sendCommand: vi.fn(async () => ({ ok: true, message: "ok" })),
      startDaemonProcess: vi.fn(async () => ({ pid: 1 })),
      writeStdout: vi.fn(),
      checkSocketAlive: vi.fn(async () => true),
      cleanupStaleSocket: vi.fn(),
      fallbackPendingMessage: vi.fn(() => "/tmp/pending.jsonl"),
    }
    try {
      const result = await runOuroCli(["auth", "switch", "--agent", agentName, "--provider", "github-copilot"], deps)
      expect(result).toContain("switched")
      expect(result).toContain("github-copilot")
      const updated = JSON.parse(fs.readFileSync(agentConfigPath, "utf-8")) as any
      expect(updated.humanFacing.provider).toBe("github-copilot")
      expect(updated.agentFacing.provider).toBe("github-copilot")
    } finally {
      fs.rmSync(agentRoot, { recursive: true, force: true })
      fs.rmSync(secretsDir, { recursive: true, force: true })
    }
  })

  it("ouro auth --switch flag form updates provider in agent.json", async () => {
    const agentName = `auth-flag-switch-${Date.now()}`
    const agentRoot = path.join(os.homedir(), "AgentBundles", `${agentName}.ouro`)
    const agentConfigPath = path.join(agentRoot, "agent.json")
    fs.mkdirSync(agentRoot, { recursive: true })
    const secretsDir = path.join(os.homedir(), ".agentsecrets", agentName)
    fs.mkdirSync(secretsDir, { recursive: true })
    fs.writeFileSync(
      path.join(secretsDir, "secrets.json"),
      JSON.stringify({
        providers: { "github-copilot": { model: "claude-sonnet-4.6", githubToken: "ghp_test", baseUrl: "https://api.test.com" } },
      }, null, 2) + "\n",
      "utf-8",
    )
    fs.writeFileSync(
      agentConfigPath,
      JSON.stringify({
        version: 2, enabled: true, provider: "openai-codex",
        humanFacing: { provider: "openai-codex", model: "gpt-5.4" },
        agentFacing: { provider: "openai-codex", model: "gpt-5.4" },
        phrases: { thinking: ["working"], tool: ["running tool"], followup: ["processing"] },
      }, null, 2) + "\n",
      "utf-8",
    )
    const deps: OuroCliDeps = {
      socketPath: "/tmp/ouro-test.sock",
      sendCommand: vi.fn(async () => ({ ok: true, message: "ok" })),
      startDaemonProcess: vi.fn(async () => ({ pid: 1 })),
      writeStdout: vi.fn(),
      checkSocketAlive: vi.fn(async () => true),
      cleanupStaleSocket: vi.fn(),
      fallbackPendingMessage: vi.fn(() => "/tmp/pending.jsonl"),
    }
    try {
      const result = await runOuroCli(["auth", "--switch", "--agent", agentName, "--provider", "github-copilot"], deps)
      expect(result).toContain("switched")
      expect(result).toContain("github-copilot")
      const updated = JSON.parse(fs.readFileSync(agentConfigPath, "utf-8")) as any
      expect(updated.humanFacing.provider).toBe("github-copilot")
      expect(updated.agentFacing.provider).toBe("github-copilot")
    } finally {
      fs.rmSync(agentRoot, { recursive: true, force: true })
      fs.rmSync(secretsDir, { recursive: true, force: true })
    }
  })

  it("ouro auth verify uses pingProvider for github-copilot", async () => {
    const agentName = `auth-verify-ghcp-${Date.now()}`
    const agentRoot = path.join(os.homedir(), "AgentBundles", `${agentName}.ouro`)
    const secretsDir = path.join(os.homedir(), ".agentsecrets", agentName)
    fs.mkdirSync(agentRoot, { recursive: true })
    fs.mkdirSync(secretsDir, { recursive: true })
    fs.writeFileSync(
      path.join(agentRoot, "agent.json"),
      JSON.stringify({
        version: 2, enabled: true, provider: "github-copilot",
        humanFacing: { provider: "github-copilot", model: "claude-sonnet-4.6" },
        agentFacing: { provider: "github-copilot", model: "claude-sonnet-4.6" },
        phrases: { thinking: ["working"], tool: ["running tool"], followup: ["processing"] },
      }, null, 2) + "\n",
      "utf-8",
    )
    fs.writeFileSync(
      path.join(secretsDir, "secrets.json"),
      JSON.stringify({
        providers: { "github-copilot": { model: "claude-sonnet-4.6", githubToken: "ghp_valid_token", baseUrl: "https://api.test.com" } },
      }, null, 2) + "\n",
      "utf-8",
    )
    const deps: OuroCliDeps = {
      socketPath: "/tmp/ouro-test.sock",
      sendCommand: vi.fn(async () => ({ ok: true, message: "ok" })),
      startDaemonProcess: vi.fn(async () => ({ pid: 1 })),
      writeStdout: vi.fn(),
      checkSocketAlive: vi.fn(async () => true),
      cleanupStaleSocket: vi.fn(),
      fallbackPendingMessage: vi.fn(() => "/tmp/pending.jsonl"),
    }
    try {
      // pingProvider is mocked to return { ok: true } at the top of this file
      const result = await runOuroCli(["auth", "verify", "--agent", agentName, "--provider", "github-copilot"], deps)
      expect(result).toBe("github-copilot: ok")
    } finally {
      fs.rmSync(agentRoot, { recursive: true, force: true })
      fs.rmSync(secretsDir, { recursive: true, force: true })
    }
  })

  it("ouro auth verify reports failure from pingProvider", async () => {
    const { pingProvider } = await import("../../../heart/provider-ping")
    vi.mocked(pingProvider).mockResolvedValueOnce({ ok: false, classification: "auth-failure", message: "token expired" })
    const agentName = `auth-verify-ghcp-fail-${Date.now()}`
    const agentRoot = path.join(os.homedir(), "AgentBundles", `${agentName}.ouro`)
    const secretsDir = path.join(os.homedir(), ".agentsecrets", agentName)
    fs.mkdirSync(agentRoot, { recursive: true })
    fs.mkdirSync(secretsDir, { recursive: true })
    fs.writeFileSync(
      path.join(agentRoot, "agent.json"),
      JSON.stringify({
        version: 2, enabled: true, provider: "github-copilot",
        humanFacing: { provider: "github-copilot", model: "claude-sonnet-4.6" },
        agentFacing: { provider: "github-copilot", model: "claude-sonnet-4.6" },
        phrases: { thinking: ["working"], tool: ["running tool"], followup: ["processing"] },
      }, null, 2) + "\n",
      "utf-8",
    )
    fs.writeFileSync(
      path.join(secretsDir, "secrets.json"),
      JSON.stringify({
        providers: { "github-copilot": { model: "claude-sonnet-4.6", githubToken: "ghp_expired", baseUrl: "https://api.test.com" } },
      }, null, 2) + "\n",
      "utf-8",
    )
    const deps: OuroCliDeps = {
      socketPath: "/tmp/ouro-test.sock",
      sendCommand: vi.fn(async () => ({ ok: true, message: "ok" })),
      startDaemonProcess: vi.fn(async () => ({ pid: 1 })),
      writeStdout: vi.fn(),
      checkSocketAlive: vi.fn(async () => true),
      cleanupStaleSocket: vi.fn(),
      fallbackPendingMessage: vi.fn(() => "/tmp/pending.jsonl"),
    }
    try {
      const result = await runOuroCli(["auth", "verify", "--agent", agentName, "--provider", "github-copilot"], deps)
      expect(result).toBe("github-copilot: failed (token expired)")
    } finally {
      fs.rmSync(agentRoot, { recursive: true, force: true })
      fs.rmSync(secretsDir, { recursive: true, force: true })
    }
  })

  it("ouro auth verify checks all providers when no --provider given", async () => {
    const agentName = `auth-verify-all-${Date.now()}`
    const agentRoot = path.join(os.homedir(), "AgentBundles", `${agentName}.ouro`)
    const secretsDir = path.join(os.homedir(), ".agentsecrets", agentName)
    fs.mkdirSync(agentRoot, { recursive: true })
    fs.mkdirSync(secretsDir, { recursive: true })
    fs.writeFileSync(
      path.join(agentRoot, "agent.json"),
      JSON.stringify({
        version: 2, enabled: true, provider: "anthropic",
        humanFacing: { provider: "anthropic", model: "claude-opus-4-6" },
        agentFacing: { provider: "anthropic", model: "claude-opus-4-6" },
        phrases: { thinking: ["working"], tool: ["running tool"], followup: ["processing"] },
      }, null, 2) + "\n",
      "utf-8",
    )
    fs.writeFileSync(
      path.join(secretsDir, "secrets.json"),
      JSON.stringify({
        providers: {
          azure: { endpoint: "https://az.test.com", apiKey: "az-key" },
          minimax: { apiKey: "" },
          anthropic: { setupToken: "sk-ant-abc" },
          "openai-codex": { oauthAccessToken: "tok" },
          "github-copilot": { githubToken: "ghp_test", baseUrl: "https://api.test.com" },
        },
      }, null, 2) + "\n",
      "utf-8",
    )
    const deps: OuroCliDeps = {
      socketPath: "/tmp/ouro-test.sock",
      sendCommand: vi.fn(async () => ({ ok: true, message: "ok" })),
      startDaemonProcess: vi.fn(async () => ({ pid: 1 })),
      writeStdout: vi.fn(),
      checkSocketAlive: vi.fn(async () => true),
      cleanupStaleSocket: vi.fn(),
      fallbackPendingMessage: vi.fn(() => "/tmp/pending.jsonl"),
    }
    try {
      // pingProvider is mocked to return { ok: true } — all providers with creds pass
      const result = await runOuroCli(["auth", "verify", "--agent", agentName], deps)
      expect(result).toContain("azure: ok")
      // minimax has empty apiKey — pingProvider still returns ok (mock), but empty creds
      // are detected by pingProvider's hasEmptyCredentials before the mock is called
      expect(result).toContain("minimax:")
      expect(result).toContain("anthropic: ok")
      expect(result).toContain("openai-codex: ok")
      expect(result).toContain("github-copilot: ok")
      // Verify it checked all 5 providers
      const lines = (result as string).split("\n")
      expect(lines.length).toBe(5)
    } finally {
      fs.rmSync(agentRoot, { recursive: true, force: true })
      fs.rmSync(secretsDir, { recursive: true, force: true })
    }
  })

  it("is idempotent for `up` when daemon already running", async () => {
    const deps: OuroCliDeps = {
      socketPath: "/tmp/ouro-test.sock",
      sendCommand: vi.fn(),
      startDaemonProcess: vi.fn(async () => ({ pid: 1 })),
      writeStdout: vi.fn(),
      checkSocketAlive: vi.fn(async () => true),
      cleanupStaleSocket: vi.fn(),
      fallbackPendingMessage: vi.fn(() => "/tmp/pending.jsonl"),
    }

    const result = await runOuroCli(["up"], deps)

    expect(result).toContain("already running")
    expect(deps.startDaemonProcess).not.toHaveBeenCalled()
    expect(deps.sendCommand).toHaveBeenCalledWith("/tmp/ouro-test.sock", { kind: "daemon.status" })
  })

  it("attempts .ouro UTI registration during `up` setup", async () => {
    const registerOuroBundleType = vi.fn(async () => ({ attempted: true, registered: true }))
    const ensureDaemonBootPersistence = vi.fn(async () => undefined)
    const deps: OuroCliDeps = {
      socketPath: "/tmp/ouro-test.sock",
      sendCommand: vi.fn(),
      startDaemonProcess: vi.fn(async () => ({ pid: 4321 })),
      writeStdout: vi.fn(),
      checkSocketAlive: vi.fn(async () => false),
      cleanupStaleSocket: vi.fn(),
      fallbackPendingMessage: vi.fn(() => "/tmp/pending.jsonl"),

      registerOuroBundleType,
      ensureDaemonBootPersistence,
    }

    await runOuroCli(["up"], deps)

    expect(registerOuroBundleType).toHaveBeenCalledTimes(1)
    expect(ensureDaemonBootPersistence).toHaveBeenCalledTimes(1)
  })

  it("continues `up` flow when .ouro UTI registration throws", async () => {
    const registerOuroBundleType = vi.fn(async () => {
      throw new Error("registration failed")
    })
    const deps: OuroCliDeps = {
      socketPath: "/tmp/ouro-test.sock",
      sendCommand: vi.fn(),
      startDaemonProcess: vi.fn(async () => ({ pid: 5678 })),
      writeStdout: vi.fn(),
      checkSocketAlive: vi.fn(async () => false),
      cleanupStaleSocket: vi.fn(),
      fallbackPendingMessage: vi.fn(() => "/tmp/pending.jsonl"),

      registerOuroBundleType,
    }

    const result = await runOuroCli(["up"], deps)

    expect(registerOuroBundleType).toHaveBeenCalledTimes(1)
    expect(result).toContain("daemon started")
  })

  it("continues `up` flow when boot persistence throws a non-Error value", async () => {
    const ensureDaemonBootPersistence = vi.fn(async () => {
      throw "boot persistence failed"
    })
    const deps: OuroCliDeps = {
      socketPath: "/tmp/ouro-test.sock",
      sendCommand: vi.fn(),
      startDaemonProcess: vi.fn(async () => ({ pid: 6789 })),
      writeStdout: vi.fn(),
      checkSocketAlive: vi.fn(async () => false),
      cleanupStaleSocket: vi.fn(),
      fallbackPendingMessage: vi.fn(() => "/tmp/pending.jsonl"),

      ensureDaemonBootPersistence,
    }

    const result = await runOuroCli(["up"], deps)

    expect(ensureDaemonBootPersistence).toHaveBeenCalledTimes(1)
    expect(result).toContain("daemon started")
  })

  it("continues `up` flow when boot persistence throws an Error", async () => {
    const ensureDaemonBootPersistence = vi.fn(async () => {
      throw new Error("boot persistence exploded")
    })
    const deps: OuroCliDeps = {
      socketPath: "/tmp/ouro-test.sock",
      sendCommand: vi.fn(),
      startDaemonProcess: vi.fn(async () => ({ pid: 6790 })),
      writeStdout: vi.fn(),
      checkSocketAlive: vi.fn(async () => false),
      cleanupStaleSocket: vi.fn(),
      fallbackPendingMessage: vi.fn(() => "/tmp/pending.jsonl"),

      ensureDaemonBootPersistence,
    }

    const result = await runOuroCli(["up"], deps)

    expect(ensureDaemonBootPersistence).toHaveBeenCalledTimes(1)
    expect(result).toContain("daemon started")
  })

  it("routes status command through daemon socket", async () => {
    const deps: OuroCliDeps = {
      socketPath: "/tmp/ouro-test.sock",
      sendCommand: vi.fn(async () => ({ ok: true, summary: "running" })),
      startDaemonProcess: vi.fn(async () => ({ pid: 1 })),
      writeStdout: vi.fn(),
      checkSocketAlive: vi.fn(async () => true),
      cleanupStaleSocket: vi.fn(),
      fallbackPendingMessage: vi.fn(() => "/tmp/pending.jsonl"),

    }

    const result = await runOuroCli(["status"], deps)

    expect(deps.sendCommand).toHaveBeenCalledWith(
      "/tmp/ouro-test.sock",
      expect.objectContaining({ kind: "daemon.status" }),
    )
    expect(result).toContain("running")
  })

  it("renders overview defaults when daemon status omits optional overview fields", async () => {
    const deps: OuroCliDeps = {
      socketPath: "/tmp/ouro-test.sock",
      sendCommand: vi.fn(async () => ({
        ok: true,
        summary: "daemon=running\tworkers=0\tsenses=0\thealth=ok",
        data: {
          overview: {},
          senses: [],
          workers: [],
        },
      })),
      startDaemonProcess: vi.fn(async () => ({ pid: 1 })),
      writeStdout: vi.fn(),
      checkSocketAlive: vi.fn(async () => true),
      cleanupStaleSocket: vi.fn(),
      fallbackPendingMessage: vi.fn(() => "/tmp/pending.jsonl"),

    }

    const result = await runOuroCli(["status"], deps)

    expect(result).toContain("| Daemon       | unknown |")
    expect(result).toContain("| Socket       | unknown |")
    expect(result).toContain("| Version      | unknown |")
    expect(result).toContain("| Last Updated | unknown |")
    expect(result).toContain("| Workers      | 0")
    expect(result).toContain("| Senses       | 0")
    expect(result).toContain("| Health       | unknown |")
    expect(result).toContain("| Entry Path   | unknown |")
    expect(result).toContain("| Mode         | unknown |")
  })

  it("renders daemon status with Overview, Senses, and Workers sections", async () => {
    const deps: OuroCliDeps = {
      socketPath: "/tmp/ouro-test.sock",
      sendCommand: vi.fn(async () => ({
        ok: true,
        summary: "daemon=running\tworkers=1\tsenses=3\thealth=ok",
        data: {
          overview: {
            daemon: "running",
            socketPath: "/tmp/ouro-test.sock",
            version: PACKAGE_VERSION.version,
            lastUpdated: "2026-03-08T23:50:00.000Z",
            workerCount: 1,
            senseCount: 3,
            health: "ok",
            entryPath: "/usr/local/lib/node_modules/@ouro.bot/cli/dist/heart/daemon/daemon-entry.js",
            mode: "production",
          },
          senses: [
            {
              agent: "slugger",
              sense: "cli",
              label: "CLI",
              enabled: true,
              status: "interactive",
              detail: "local interactive terminal",
            },
            {
              agent: "slugger",
              sense: "bluebubbles",
              enabled: true,
              status: "running",
              detail: ":18790 /bluebubbles-webhook",
            },
            {
              agent: "slugger",
              sense: "teams",
              enabled: false,
              status: "disabled",
              detail: "not enabled in agent.json",
            },
          ],
          workers: [
            {
              agent: "slugger",
              worker: "inner-dialog",
              status: "running",
              pid: null,
              restartCount: 0,
            },
          ],
        },
      })),
      startDaemonProcess: vi.fn(async () => ({ pid: 1 })),
      writeStdout: vi.fn(),
      checkSocketAlive: vi.fn(async () => true),
      cleanupStaleSocket: vi.fn(),
      fallbackPendingMessage: vi.fn(() => "/tmp/pending.jsonl"),

    }

    const result = await runOuroCli(["status"], deps)

    expect(result).toContain("Overview")
    expect(result).toContain("Senses")
    expect(result).toContain("Workers")
    expect(result).toContain(PACKAGE_VERSION.version)
    expect(result).toContain("2026-03-08T23:50:00.000Z")
    expect(result).toContain("BlueBubbles")
    expect(result).toContain("interactive")
    expect(result).toContain("/bluebubbles-webhook")
    expect(result).toContain("inner-dialog")
    expect(result).toContain("n/a")
    expect(result).toContain("| Entry Path")
    expect(result).toContain("/usr/local/lib/node_modules/@ouro.bot/cli/dist/heart/daemon/daemon-entry.js")
    expect(result).toContain("| Mode")
    expect(result).toContain("production")
  })

  it("falls back to the raw sense name when daemon status includes an unknown sense label", async () => {
    const deps: OuroCliDeps = {
      socketPath: "/tmp/ouro-test.sock",
      sendCommand: vi.fn(async () => ({
        ok: true,
        summary: "daemon=running\tworkers=0\tsenses=1\thealth=ok",
        data: {
          overview: {
            daemon: "running",
            socketPath: "/tmp/ouro-test.sock",
            workerCount: 0,
            senseCount: 1,
            health: "ok",
          },
          senses: [
            {
              agent: "slugger",
              sense: "pagerduty",
              enabled: true,
              status: "running",
              detail: "custom bridge",
            },
          ],
          workers: [],
        },
      })),
      startDaemonProcess: vi.fn(async () => ({ pid: 1 })),
      writeStdout: vi.fn(),
      checkSocketAlive: vi.fn(async () => true),
      cleanupStaleSocket: vi.fn(),
      fallbackPendingMessage: vi.fn(() => "/tmp/pending.jsonl"),

    }

    const result = await runOuroCli(["status"], deps)

    expect(result).toContain("pagerduty")
    expect(result).toContain("custom bridge")
  })

  it("humanizes built-in sense names and renders numeric worker pids", async () => {
    const deps: OuroCliDeps = {
      socketPath: "/tmp/ouro-test.sock",
      sendCommand: vi.fn(async () => ({
        ok: true,
        summary: "daemon=running\tworkers=1\tsenses=2\thealth=ok",
        data: {
          overview: {
            daemon: "running",
            socketPath: "/tmp/ouro-test.sock",
            workerCount: 1,
            senseCount: 2,
            health: "ok",
          },
          senses: [
            {
              agent: "slugger",
              sense: "cli",
              enabled: true,
              status: "interactive",
              detail: "open with ouro chat slugger",
            },
            {
              agent: "slugger",
              sense: "teams",
              enabled: false,
              status: "disabled",
              detail: "not enabled in agent.json",
            },
          ],
          workers: [
            {
              agent: "slugger",
              worker: "inner-dialog",
              status: "running",
              pid: 12345,
              restartCount: 2,
            },
          ],
        },
      })),
      startDaemonProcess: vi.fn(async () => ({ pid: 1 })),
      writeStdout: vi.fn(),
      checkSocketAlive: vi.fn(async () => true),
      cleanupStaleSocket: vi.fn(),
      fallbackPendingMessage: vi.fn(() => "/tmp/pending.jsonl"),

    }

    const result = await runOuroCli(["status"], deps)

    expect(result).toContain("CLI")
    expect(result).toContain("Teams")
    expect(result).toContain("12345")
    expect(result).toContain("2")
  })

  it("falls back to the raw daemon summary when a sense row is malformed", async () => {
    const deps: OuroCliDeps = {
      socketPath: "/tmp/ouro-test.sock",
      sendCommand: vi.fn(async () => ({
        ok: true,
        summary: "malformed-sense-row",
        data: {
          overview: {
            daemon: "running",
            socketPath: "/tmp/ouro-test.sock",
            workerCount: 0,
            senseCount: 1,
            health: "ok",
          },
          senses: ["bad-row"],
          workers: [],
        },
      })),
      startDaemonProcess: vi.fn(async () => ({ pid: 1 })),
      writeStdout: vi.fn(),
      checkSocketAlive: vi.fn(async () => true),
      cleanupStaleSocket: vi.fn(),
      fallbackPendingMessage: vi.fn(() => "/tmp/pending.jsonl"),

    }

    const result = await runOuroCli(["status"], deps)

    expect(result).toBe("malformed-sense-row")
  })

  it("falls back to the raw daemon summary when overview is malformed", async () => {
    const deps: OuroCliDeps = {
      socketPath: "/tmp/ouro-test.sock",
      sendCommand: vi.fn(async () => ({
        ok: true,
        summary: "malformed-overview",
        data: {
          overview: [],
          senses: [],
          workers: [],
        },
      })),
      startDaemonProcess: vi.fn(async () => ({ pid: 1 })),
      writeStdout: vi.fn(),
      checkSocketAlive: vi.fn(async () => true),
      cleanupStaleSocket: vi.fn(),
      fallbackPendingMessage: vi.fn(() => "/tmp/pending.jsonl"),

    }

    const result = await runOuroCli(["status"], deps)

    expect(result).toBe("malformed-overview")
  })

  it("falls back to the raw daemon summary when senses or workers are not arrays", async () => {
    const deps: OuroCliDeps = {
      socketPath: "/tmp/ouro-test.sock",
      sendCommand: vi.fn(async () => ({
        ok: true,
        summary: "malformed-sense-worker-arrays",
        data: {
          overview: {
            daemon: "running",
            socketPath: "/tmp/ouro-test.sock",
            workerCount: 0,
            senseCount: 0,
            health: "ok",
          },
          senses: {},
          workers: {},
        },
      })),
      startDaemonProcess: vi.fn(async () => ({ pid: 1 })),
      writeStdout: vi.fn(),
      checkSocketAlive: vi.fn(async () => true),
      cleanupStaleSocket: vi.fn(),
      fallbackPendingMessage: vi.fn(() => "/tmp/pending.jsonl"),

    }

    const result = await runOuroCli(["status"], deps)

    expect(result).toBe("malformed-sense-worker-arrays")
  })

  it("falls back to the raw daemon summary when a sense row is missing a required field", async () => {
    const deps: OuroCliDeps = {
      socketPath: "/tmp/ouro-test.sock",
      sendCommand: vi.fn(async () => ({
        ok: true,
        summary: "sense-row-missing-field",
        data: {
          overview: {
            daemon: "running",
            socketPath: "/tmp/ouro-test.sock",
            workerCount: 0,
            senseCount: 1,
            health: "ok",
          },
          senses: [
            {
              agent: "slugger",
              sense: "bluebubbles",
              status: "running",
              detail: "missing enabled",
            },
          ],
          workers: [],
        },
      })),
      startDaemonProcess: vi.fn(async () => ({ pid: 1 })),
      writeStdout: vi.fn(),
      checkSocketAlive: vi.fn(async () => true),
      cleanupStaleSocket: vi.fn(),
      fallbackPendingMessage: vi.fn(() => "/tmp/pending.jsonl"),

    }

    const result = await runOuroCli(["status"], deps)

    expect(result).toBe("sense-row-missing-field")
  })

  it("falls back to the raw daemon summary when a worker row is malformed", async () => {
    const deps: OuroCliDeps = {
      socketPath: "/tmp/ouro-test.sock",
      sendCommand: vi.fn(async () => ({
        ok: true,
        summary: "malformed-worker-row",
        data: {
          overview: {
            daemon: "running",
            socketPath: "/tmp/ouro-test.sock",
            workerCount: 1,
            senseCount: 0,
            health: "ok",
          },
          senses: [],
          workers: ["bad-row"],
        },
      })),
      startDaemonProcess: vi.fn(async () => ({ pid: 1 })),
      writeStdout: vi.fn(),
      checkSocketAlive: vi.fn(async () => true),
      cleanupStaleSocket: vi.fn(),
      fallbackPendingMessage: vi.fn(() => "/tmp/pending.jsonl"),

    }

    const result = await runOuroCli(["status"], deps)

    expect(result).toBe("malformed-worker-row")
  })

  it("falls back to the raw daemon summary when a worker row is missing pid", async () => {
    const deps: OuroCliDeps = {
      socketPath: "/tmp/ouro-test.sock",
      sendCommand: vi.fn(async () => ({
        ok: true,
        summary: "worker-row-missing-pid",
        data: {
          overview: {
            daemon: "running",
            socketPath: "/tmp/ouro-test.sock",
            workerCount: 1,
            senseCount: 0,
            health: "ok",
          },
          senses: [],
          workers: [
            {
              agent: "slugger",
              worker: "inner-dialog",
              status: "running",
              restartCount: 0,
            },
          ],
        },
      })),
      startDaemonProcess: vi.fn(async () => ({ pid: 1 })),
      writeStdout: vi.fn(),
      checkSocketAlive: vi.fn(async () => true),
      cleanupStaleSocket: vi.fn(),
      fallbackPendingMessage: vi.fn(() => "/tmp/pending.jsonl"),

    }

    const result = await runOuroCli(["status"], deps)

    expect(result).toBe("worker-row-missing-pid")
  })

  it("routes bare ouro to hatch when no agents are discovered", async () => {
    const deps = {
      socketPath: "/tmp/ouro-test.sock",
      sendCommand: vi.fn(async () => ({ ok: true, message: "hatch started" })),
      startDaemonProcess: vi.fn(async () => ({ pid: 1 })),
      writeStdout: vi.fn(),
      checkSocketAlive: vi.fn(async () => true),
      cleanupStaleSocket: vi.fn(),
      fallbackPendingMessage: vi.fn(() => "/tmp/pending.jsonl"),

      listDiscoveredAgents: vi.fn(async () => []),
    } as OuroCliDeps & {
      listDiscoveredAgents: () => Promise<string[]>
    }

    await runOuroCli([], deps)

    expect(deps.sendCommand).toHaveBeenCalledWith(
      "/tmp/ouro-test.sock",
      expect.objectContaining({ kind: "hatch.start" }),
    )
  })

  it("routes bare ouro to chat when exactly one agent is discovered", async () => {
    const deps = {
      socketPath: "/tmp/ouro-test.sock",
      sendCommand: vi.fn(async () => ({ ok: true, message: "connected to slugger" })),
      startDaemonProcess: vi.fn(async () => ({ pid: 1 })),
      writeStdout: vi.fn(),
      checkSocketAlive: vi.fn(async () => true),
      cleanupStaleSocket: vi.fn(),
      fallbackPendingMessage: vi.fn(() => "/tmp/pending.jsonl"),

      listDiscoveredAgents: vi.fn(async () => ["slugger"]),
    } as OuroCliDeps & {
      listDiscoveredAgents: () => Promise<string[]>
    }

    await runOuroCli([], deps)

    expect(deps.sendCommand).toHaveBeenCalledWith(
      "/tmp/ouro-test.sock",
      expect.objectContaining({ kind: "chat.connect", agent: "slugger" }),
    )
  })

  it("prompts selection on bare ouro when multiple agents are discovered", async () => {
    const deps = {
      socketPath: "/tmp/ouro-test.sock",
      sendCommand: vi.fn(async () => ({ ok: true, message: "unexpected socket call" })),
      startDaemonProcess: vi.fn(async () => ({ pid: 1 })),
      writeStdout: vi.fn(),
      checkSocketAlive: vi.fn(async () => true),
      cleanupStaleSocket: vi.fn(),
      fallbackPendingMessage: vi.fn(() => "/tmp/pending.jsonl"),

      listDiscoveredAgents: vi.fn(async () => ["ouroboros", "slugger"]),
    } as OuroCliDeps & {
      listDiscoveredAgents: () => Promise<string[]>
    }

    const result = await runOuroCli([], deps)

    expect(result).toContain("who do you want to talk to?")
    expect(result).toContain("ouroboros")
    expect(result).toContain("slugger")
    expect(deps.sendCommand).not.toHaveBeenCalled()
  })

  it("routes msg command through daemon socket", async () => {
    const deps: OuroCliDeps = {
      socketPath: "/tmp/ouro-test.sock",
      sendCommand: vi.fn(async () => ({ ok: true, message: "queued" })),
      startDaemonProcess: vi.fn(async () => ({ pid: 1 })),
      writeStdout: vi.fn(),
      checkSocketAlive: vi.fn(async () => true),
      cleanupStaleSocket: vi.fn(),
      fallbackPendingMessage: vi.fn(() => "/tmp/pending.jsonl"),

    }

    await runOuroCli(["msg", "--to", "slugger", "hi"], deps)

    expect(deps.sendCommand).toHaveBeenCalledWith(
      "/tmp/ouro-test.sock",
      expect.objectContaining({
        kind: "message.send",
        from: "ouro-cli",
        to: "slugger",
        content: "hi",
      }),
    )
  })

  it("routes link command through friend store instead of daemon socket", async () => {
    const friendRecord = {
      id: "friend-1",
      name: "Ari",
      trustLevel: "family" as const,
      externalIds: [{ provider: "local" as const, externalId: "ari", linkedAt: "2026-01-01T00:00:00.000Z" }],
      tenantMemberships: [],
      toolPreferences: {},
      notes: {},
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      schemaVersion: 1,
    }
    const mockFriendStore = {
      get: vi.fn(async () => friendRecord),
      put: vi.fn(),
      delete: vi.fn(),
      findByExternalId: vi.fn(async () => null),
      listAll: vi.fn(),
    }
    const deps: OuroCliDeps = {
      socketPath: "/tmp/ouro-test.sock",
      sendCommand: vi.fn(async () => ({ ok: true, message: "unexpected daemon call" })),
      startDaemonProcess: vi.fn(async () => ({ pid: 1 })),
      writeStdout: vi.fn(),
      checkSocketAlive: vi.fn(async () => true),
      cleanupStaleSocket: vi.fn(),
      fallbackPendingMessage: vi.fn(() => "/tmp/pending.jsonl"),

      friendStore: mockFriendStore as any,
    }

    const result = await runOuroCli([
      "link",
      "slugger",
      "--friend",
      "friend-1",
      "--provider",
      "aad",
      "--external-id",
      "aad-user-123",
    ], deps)

    expect(result).toContain("linked aad:aad-user-123 to friend-1")
    expect(mockFriendStore.put).toHaveBeenCalled()
    expect(deps.sendCommand).not.toHaveBeenCalled()
  })

  it("falls back to pending inbox when msg cannot reach daemon", async () => {
    const deps: OuroCliDeps = {
      socketPath: "/tmp/ouro-test.sock",
      sendCommand: vi.fn(async () => {
        throw new Error("connect ECONNREFUSED")
      }),
      startDaemonProcess: vi.fn(async () => ({ pid: 1 })),
      writeStdout: vi.fn(),
      checkSocketAlive: vi.fn(async () => true),
      cleanupStaleSocket: vi.fn(),
      fallbackPendingMessage: vi.fn(() => "/tmp/AgentBundles/slugger.ouro/inbox/pending.jsonl"),

    }

    const result = await runOuroCli(["msg", "--to", "slugger", "hi"], deps)

    expect(deps.fallbackPendingMessage).toHaveBeenCalledWith(expect.objectContaining({
      kind: "message.send",
      to: "slugger",
      content: "hi",
    }))
    expect(result).toContain("queued message fallback")
  })

  it("prompts for missing minimax credentials in local hatch flow", async () => {
    const runHatchFlow = vi.fn(async () => ({
      bundleRoot: "/tmp/AgentBundles/Mini.ouro",
      selectedIdentity: "python.md",
      specialistSecretsPath: "/tmp/.agentsecrets/AdoptionSpecialist/secrets.json",
      hatchlingSecretsPath: "/tmp/.agentsecrets/Mini/secrets.json",
    }))
    const promptInput = vi.fn(async (question: string) => {
      if (question === "MiniMax API key: ") return "minimax-key"
      return ""
    })

    const deps = {
      socketPath: "/tmp/ouro-test.sock",
      sendCommand: vi.fn(async () => ({ ok: true, message: "unexpected sendCommand call" })),
      startDaemonProcess: vi.fn(async () => ({ pid: 101 })),
      writeStdout: vi.fn(),
      checkSocketAlive: vi.fn(async () => false),
      cleanupStaleSocket: vi.fn(),
      fallbackPendingMessage: vi.fn(() => "/tmp/pending.jsonl"),

      registerOuroBundleType: vi.fn(async () => ({ attempted: true, registered: true })),
      runHatchFlow,
      promptInput,
    } as OuroCliDeps & {
      runHatchFlow: typeof runHatchFlow
      promptInput: typeof promptInput
    }

    await runOuroCli([
      "hatch",
      "--agent",
      "Mini",
      "--human",
      "Ari",
      "--provider",
      "minimax",
    ], deps)

    expect(promptInput).toHaveBeenCalledWith("MiniMax API key: ")
    expect(runHatchFlow).toHaveBeenCalledWith({
      agentName: "Mini",
      humanName: "Ari",
      provider: "minimax",
      credentials: {
        apiKey: "minimax-key",
      },
    })
  })

  it("prompts for missing anthropic setup token in local hatch flow", async () => {
    const runHatchFlow = vi.fn(async () => ({
      bundleRoot: "/tmp/AgentBundles/ClaudeSprout.ouro",
      selectedIdentity: "medusa.md",
      specialistSecretsPath: "/tmp/.agentsecrets/AdoptionSpecialist/secrets.json",
      hatchlingSecretsPath: "/tmp/.agentsecrets/ClaudeSprout/secrets.json",
    }))
    const promptInput = vi.fn(async (question: string) => {
      if (question === "Anthropic setup-token: ") return "sk-ant-oat01-test-token"
      return ""
    })

    const deps = {
      socketPath: "/tmp/ouro-test.sock",
      sendCommand: vi.fn(async () => ({ ok: true, message: "unexpected sendCommand call" })),
      startDaemonProcess: vi.fn(async () => ({ pid: 111 })),
      writeStdout: vi.fn(),
      checkSocketAlive: vi.fn(async () => false),
      cleanupStaleSocket: vi.fn(),
      fallbackPendingMessage: vi.fn(() => "/tmp/pending.jsonl"),

      registerOuroBundleType: vi.fn(async () => ({ attempted: true, registered: true })),
      runHatchFlow,
      promptInput,
    } as OuroCliDeps & {
      runHatchFlow: typeof runHatchFlow
      promptInput: typeof promptInput
    }

    await runOuroCli([
      "hatch",
      "--agent",
      "ClaudeSprout",
      "--human",
      "Ari",
      "--provider",
      "anthropic",
    ], deps)

    expect(promptInput).toHaveBeenCalledWith("Anthropic setup-token: ")
    expect(runHatchFlow).toHaveBeenCalledWith({
      agentName: "ClaudeSprout",
      humanName: "Ari",
      provider: "anthropic",
      credentials: {
        setupToken: "sk-ant-oat01-test-token",
      },
    })
  })

  it("prompts for missing openai oauth token in local hatch flow", async () => {
    const runHatchFlow = vi.fn(async () => ({
      bundleRoot: "/tmp/AgentBundles/CodexSprout.ouro",
      selectedIdentity: "python.md",
      specialistSecretsPath: "/tmp/.agentsecrets/AdoptionSpecialist/secrets.json",
      hatchlingSecretsPath: "/tmp/.agentsecrets/CodexSprout/secrets.json",
    }))
    const promptInput = vi.fn(async (question: string) => {
      if (question === "OpenAI Codex OAuth token: ") return "oauth-token-abc"
      return ""
    })

    const deps = {
      socketPath: "/tmp/ouro-test.sock",
      sendCommand: vi.fn(async () => ({ ok: true, message: "unexpected sendCommand call" })),
      startDaemonProcess: vi.fn(async () => ({ pid: 222 })),
      writeStdout: vi.fn(),
      checkSocketAlive: vi.fn(async () => false),
      cleanupStaleSocket: vi.fn(),
      fallbackPendingMessage: vi.fn(() => "/tmp/pending.jsonl"),

      registerOuroBundleType: vi.fn(async () => ({ attempted: true, registered: true })),
      runHatchFlow,
      promptInput,
    } as OuroCliDeps & {
      runHatchFlow: typeof runHatchFlow
      promptInput: typeof promptInput
    }

    await runOuroCli([
      "hatch",
      "--agent",
      "CodexSprout",
      "--human",
      "Ari",
      "--provider",
      "openai-codex",
    ], deps)

    expect(promptInput).toHaveBeenCalledWith("OpenAI Codex OAuth token: ")
    expect(runHatchFlow).toHaveBeenCalledWith({
      agentName: "CodexSprout",
      humanName: "Ari",
      provider: "openai-codex",
      credentials: {
        oauthAccessToken: "oauth-token-abc",
      },
    })
  })

  it("uses the shared anthropic auth flow for hatch when runtime auth is available", async () => {
    const runHatchFlow = vi.fn(async () => ({
      bundleRoot: "/tmp/AgentBundles/ClaudeSprout.ouro",
      selectedIdentity: "medusa.md",
      specialistSecretsPath: "/tmp/.agentsecrets/AdoptionSpecialist/secrets.json",
      hatchlingSecretsPath: "/tmp/.agentsecrets/ClaudeSprout/secrets.json",
    }))
    const runAuthFlow = vi.fn(async () => ({
      agentName: "ClaudeSprout",
      provider: "anthropic",
      message: "authenticated ClaudeSprout with anthropic",
      secretsPath: "/tmp/.agentsecrets/ClaudeSprout/secrets.json",
      credentials: {
        setupToken: `sk-ant-oat01-${"a".repeat(90)}`,
      },
    } as any))
    const promptInput = vi.fn(async () => "unexpected")

    const deps = {
      socketPath: "/tmp/ouro-test.sock",
      sendCommand: vi.fn(async () => ({ ok: true, message: "unexpected sendCommand call" })),
      startDaemonProcess: vi.fn(async () => ({ pid: 111 })),
      writeStdout: vi.fn(),
      checkSocketAlive: vi.fn(async () => false),
      cleanupStaleSocket: vi.fn(),
      fallbackPendingMessage: vi.fn(() => "/tmp/pending.jsonl"),

      registerOuroBundleType: vi.fn(async () => ({ attempted: true, registered: true })),
      runHatchFlow,
      runAuthFlow,
      promptInput,
    } as OuroCliDeps & {
      runHatchFlow: typeof runHatchFlow
      runAuthFlow: typeof runAuthFlow
      promptInput: typeof promptInput
    }

    await runOuroCli([
      "hatch",
      "--agent",
      "ClaudeSprout",
      "--human",
      "Ari",
      "--provider",
      "anthropic",
    ], deps)

    expect(runAuthFlow).toHaveBeenCalledWith({
      agentName: "ClaudeSprout",
      provider: "anthropic",
      promptInput,
    })
    expect(promptInput).not.toHaveBeenCalledWith("Anthropic setup-token: ")
    expect(runHatchFlow).toHaveBeenCalledWith({
      agentName: "ClaudeSprout",
      humanName: "Ari",
      provider: "anthropic",
      credentials: {
        setupToken: `sk-ant-oat01-${"a".repeat(90)}`,
      },
    })
  })

  it("uses the shared codex auth flow for hatch when runtime auth is available", async () => {
    const runHatchFlow = vi.fn(async () => ({
      bundleRoot: "/tmp/AgentBundles/CodexSprout.ouro",
      selectedIdentity: "python.md",
      specialistSecretsPath: "/tmp/.agentsecrets/AdoptionSpecialist/secrets.json",
      hatchlingSecretsPath: "/tmp/.agentsecrets/CodexSprout/secrets.json",
    }))
    const runAuthFlow = vi.fn(async () => ({
      agentName: "CodexSprout",
      provider: "openai-codex",
      message: "authenticated CodexSprout with openai-codex",
      secretsPath: "/tmp/.agentsecrets/CodexSprout/secrets.json",
      credentials: {
        oauthAccessToken: "oauth-token-abc",
      },
    } as any))
    const promptInput = vi.fn(async () => "unexpected")

    const deps = {
      socketPath: "/tmp/ouro-test.sock",
      sendCommand: vi.fn(async () => ({ ok: true, message: "unexpected sendCommand call" })),
      startDaemonProcess: vi.fn(async () => ({ pid: 222 })),
      writeStdout: vi.fn(),
      checkSocketAlive: vi.fn(async () => false),
      cleanupStaleSocket: vi.fn(),
      fallbackPendingMessage: vi.fn(() => "/tmp/pending.jsonl"),

      registerOuroBundleType: vi.fn(async () => ({ attempted: true, registered: true })),
      runHatchFlow,
      runAuthFlow,
      promptInput,
    } as OuroCliDeps & {
      runHatchFlow: typeof runHatchFlow
      runAuthFlow: typeof runAuthFlow
      promptInput: typeof promptInput
    }

    await runOuroCli([
      "hatch",
      "--agent",
      "CodexSprout",
      "--human",
      "Ari",
      "--provider",
      "openai-codex",
    ], deps)

    expect(runAuthFlow).toHaveBeenCalledWith({
      agentName: "CodexSprout",
      provider: "openai-codex",
      promptInput,
    })
    expect(promptInput).not.toHaveBeenCalledWith("OpenAI Codex OAuth token: ")
    expect(runHatchFlow).toHaveBeenCalledWith({
      agentName: "CodexSprout",
      humanName: "Ari",
      provider: "openai-codex",
      credentials: {
        oauthAccessToken: "oauth-token-abc",
      },
    })
  })

  it("throws usage when hatch input cannot resolve required values", async () => {
    const deps: OuroCliDeps = {
      socketPath: "/tmp/ouro-test.sock",
      sendCommand: vi.fn(async () => ({ ok: true })),
      startDaemonProcess: vi.fn(async () => ({ pid: 1 })),
      writeStdout: vi.fn(),
      checkSocketAlive: vi.fn(async () => true),
      cleanupStaleSocket: vi.fn(),
      fallbackPendingMessage: vi.fn(() => "/tmp/pending.jsonl"),

      registerOuroBundleType: vi.fn(async () => ({ attempted: true, registered: true })),
      runHatchFlow: vi.fn(async () => ({
        bundleRoot: "/tmp/unused",
        selectedIdentity: "unused.md",
        specialistSecretsPath: "/tmp/unused-specialist.json",
        hatchlingSecretsPath: "/tmp/unused-hatchling.json",
      })),
      promptInput: vi.fn(async () => ""),
    }

    await expect(runOuroCli(["hatch"], deps)).rejects.toThrow("Usage")
  })

  it("throws usage when hatch input is unresolved and promptInput is unavailable", async () => {
    const deps: OuroCliDeps = {
      socketPath: "/tmp/ouro-test.sock",
      sendCommand: vi.fn(async () => ({ ok: true })),
      startDaemonProcess: vi.fn(async () => ({ pid: 1 })),
      writeStdout: vi.fn(),
      checkSocketAlive: vi.fn(async () => true),
      cleanupStaleSocket: vi.fn(),
      fallbackPendingMessage: vi.fn(() => "/tmp/pending.jsonl"),

      registerOuroBundleType: vi.fn(async () => ({ attempted: true, registered: true })),
      runHatchFlow: vi.fn(async () => ({
        bundleRoot: "/tmp/unused",
        selectedIdentity: "unused.md",
        specialistSecretsPath: "/tmp/unused-specialist.json",
        hatchlingSecretsPath: "/tmp/unused-hatchling.json",
      })),
    }

    await expect(runOuroCli(["hatch"], deps)).rejects.toThrow("Usage")
  })

  it("does not re-prompt azure credentials when they are provided on CLI", async () => {
    const runHatchFlow = vi.fn(async () => ({
      bundleRoot: "/tmp/AgentBundles/AzureProvided.ouro",
      selectedIdentity: "medusa.md",
      specialistSecretsPath: "/tmp/.agentsecrets/AdoptionSpecialist/secrets.json",
      hatchlingSecretsPath: "/tmp/.agentsecrets/AzureProvided/secrets.json",
    }))
    const promptInput = vi.fn(async () => "unexpected")

    const deps = {
      socketPath: "/tmp/ouro-test.sock",
      sendCommand: vi.fn(async () => ({ ok: true, message: "unexpected sendCommand call" })),
      startDaemonProcess: vi.fn(async () => ({ pid: 303 })),
      writeStdout: vi.fn(),
      checkSocketAlive: vi.fn(async () => true),
      cleanupStaleSocket: vi.fn(),
      fallbackPendingMessage: vi.fn(() => "/tmp/pending.jsonl"),

      registerOuroBundleType: vi.fn(async () => ({ attempted: true, registered: true })),
      runHatchFlow,
      promptInput,
    } as OuroCliDeps & {
      runHatchFlow: typeof runHatchFlow
      promptInput: typeof promptInput
    }

    await runOuroCli([
      "hatch",
      "--agent",
      "AzureProvided",
      "--human",
      "Ari",
      "--provider",
      "azure",
      "--api-key",
      "provided-key",
      "--endpoint",
      "https://provided.endpoint",
      "--deployment",
      "provided-deployment",
    ], deps)

    expect(promptInput).not.toHaveBeenCalledWith("Azure API key: ")
    expect(promptInput).not.toHaveBeenCalledWith("Azure endpoint: ")
    expect(promptInput).not.toHaveBeenCalledWith("Azure deployment: ")
  })

  it("continues `up` flow when UTI registration throws a non-Error value", async () => {
    const deps: OuroCliDeps = {
      socketPath: "/tmp/ouro-test.sock",
      sendCommand: vi.fn(),
      startDaemonProcess: vi.fn(async () => ({ pid: 404 })),
      writeStdout: vi.fn(),
      checkSocketAlive: vi.fn(async () => false),
      cleanupStaleSocket: vi.fn(),
      fallbackPendingMessage: vi.fn(() => "/tmp/pending.jsonl"),

      registerOuroBundleType: vi.fn(async () => {
        throw "registration failed string"
      }),
    }

    const result = await runOuroCli(["up"], deps)
    expect(result).toContain("daemon started")
  })

  it("continues hatch flow when subagent install throws a non-Error value", async () => {
    const runHatchFlow = vi.fn(async () => ({
      bundleRoot: "/tmp/AgentBundles/StringInstall.ouro",
      selectedIdentity: "python.md",
      specialistSecretsPath: "/tmp/.agentsecrets/AdoptionSpecialist/secrets.json",
      hatchlingSecretsPath: "/tmp/.agentsecrets/StringInstall/secrets.json",
    }))

    const deps = {
      socketPath: "/tmp/ouro-test.sock",
      sendCommand: vi.fn(async () => ({ ok: true })),
      startDaemonProcess: vi.fn(async () => ({ pid: 505 })),
      writeStdout: vi.fn(),
      checkSocketAlive: vi.fn(async () => false),
      cleanupStaleSocket: vi.fn(),
      fallbackPendingMessage: vi.fn(() => "/tmp/pending.jsonl"),
      registerOuroBundleType: vi.fn(async () => ({ attempted: true, registered: true })),
      runHatchFlow,
    } as OuroCliDeps & {
      runHatchFlow: typeof runHatchFlow
    }

    const result = await runOuroCli([
      "hatch",
      "--agent",
      "StringInstall",
      "--human",
      "Ari",
      "--provider",
      "anthropic",
      "--setup-token",
      "sk-ant-oat01-test-token",
    ], deps)
    expect(result).toContain("hatched StringInstall")
  })

  it("reports daemon already running in local hatch flow when socket is alive", async () => {
    const runHatchFlow = vi.fn(async () => ({
      bundleRoot: "/tmp/AgentBundles/Alive.ouro",
      selectedIdentity: "python.md",
      specialistSecretsPath: "/tmp/.agentsecrets/AdoptionSpecialist/secrets.json",
      hatchlingSecretsPath: "/tmp/.agentsecrets/Alive/secrets.json",
    }))
    const deps = {
      socketPath: "/tmp/ouro-test.sock",
      sendCommand: vi.fn(async () => ({ ok: true })),
      startDaemonProcess: vi.fn(async () => ({ pid: 606 })),
      writeStdout: vi.fn(),
      checkSocketAlive: vi.fn(async () => true),
      cleanupStaleSocket: vi.fn(),
      fallbackPendingMessage: vi.fn(() => "/tmp/pending.jsonl"),

      registerOuroBundleType: vi.fn(async () => ({ attempted: true, registered: true })),
      runHatchFlow,
    } as OuroCliDeps & {
      runHatchFlow: typeof runHatchFlow
    }

    const result = await runOuroCli([
      "hatch",
      "--agent",
      "Alive",
      "--human",
      "Ari",
      "--provider",
      "anthropic",
      "--setup-token",
      "sk-ant-oat01-test-token",
    ], deps)

    expect(deps.startDaemonProcess).not.toHaveBeenCalled()
    expect(result).toContain("daemon already running")
  })

  it("formats unknown pid in hatch flow start message when daemon pid is null", async () => {
    const runHatchFlow = vi.fn(async () => ({
      bundleRoot: "/tmp/AgentBundles/UnknownPid.ouro",
      selectedIdentity: "python.md",
      specialistSecretsPath: "/tmp/.agentsecrets/AdoptionSpecialist/secrets.json",
      hatchlingSecretsPath: "/tmp/.agentsecrets/UnknownPid/secrets.json",
    }))
    const deps = {
      socketPath: "/tmp/ouro-test.sock",
      sendCommand: vi.fn(async () => ({ ok: true })),
      startDaemonProcess: vi.fn(async () => ({ pid: null })),
      writeStdout: vi.fn(),
      checkSocketAlive: vi.fn(async () => false),
      cleanupStaleSocket: vi.fn(),
      fallbackPendingMessage: vi.fn(() => "/tmp/pending.jsonl"),

      registerOuroBundleType: vi.fn(async () => ({ attempted: true, registered: true })),
      runHatchFlow,
    } as OuroCliDeps & {
      runHatchFlow: typeof runHatchFlow
    }

    const result = await runOuroCli([
      "hatch",
      "--agent",
      "UnknownPid",
      "--human",
      "Ari",
      "--provider",
      "anthropic",
      "--setup-token",
      "sk-ant-oat01-test-token",
    ], deps)

    expect(result).toContain("daemon started (pid unknown)")
  })

  it("formats hatch daemon-proxy responses across summary/message/ok/error shapes", async () => {
    const baseDeps: OuroCliDeps = {
      socketPath: "/tmp/ouro-test.sock",
      sendCommand: vi.fn(async () => ({ ok: true, summary: "summary response" })),
      startDaemonProcess: vi.fn(async () => ({ pid: 1 })),
      writeStdout: vi.fn(),
      checkSocketAlive: vi.fn(async () => true),
      cleanupStaleSocket: vi.fn(),
      fallbackPendingMessage: vi.fn(() => "/tmp/pending.jsonl"),

      runHatchFlow: undefined,
    }

    const summary = await runOuroCli(["hatch"], {
      ...baseDeps,
      sendCommand: vi.fn(async () => ({ ok: true, summary: "summary response" })),
    })
    const ok = await runOuroCli(["hatch"], {
      ...baseDeps,
      sendCommand: vi.fn(async () => ({ ok: true })),
    })
    const error = await runOuroCli(["hatch"], {
      ...baseDeps,
      sendCommand: vi.fn(async () => ({ ok: false })),
    })

    expect(summary).toBe("summary response")
    expect(ok).toBe("ok")
    expect(error).toContain("unknown error")
  })

  it("prompts azure credentials and continues hatch when subagent install throws", async () => {
    const runHatchFlow = vi.fn(async () => ({
      bundleRoot: "/tmp/AgentBundles/AzureSprout.ouro",
      selectedIdentity: "medusa.md",
      specialistSecretsPath: "/tmp/.agentsecrets/AdoptionSpecialist/secrets.json",
      hatchlingSecretsPath: "/tmp/.agentsecrets/AzureSprout/secrets.json",
    }))
    const promptInput = vi.fn(async (question: string) => {
      if (question === "Azure API key: ") return "azure-key"
      if (question === "Azure endpoint: ") return "https://example.openai.azure.com"
      if (question === "Azure deployment: ") return "gpt-4o-mini"
      return ""
    })

    const deps = {
      socketPath: "/tmp/ouro-test.sock",
      sendCommand: vi.fn(async () => ({ ok: true, message: "unexpected sendCommand call" })),
      startDaemonProcess: vi.fn(async () => ({ pid: 202 })),
      writeStdout: vi.fn(),
      checkSocketAlive: vi.fn(async () => false),
      cleanupStaleSocket: vi.fn(),
      fallbackPendingMessage: vi.fn(() => "/tmp/pending.jsonl"),
      registerOuroBundleType: vi.fn(async () => ({ attempted: true, registered: true })),
      runHatchFlow,
      promptInput,
    } as OuroCliDeps & {
      runHatchFlow: typeof runHatchFlow
      promptInput: typeof promptInput
    }

    const result = await runOuroCli([
      "hatch",
      "--agent",
      "AzureSprout",
      "--human",
      "Ari",
      "--provider",
      "azure",
    ], deps)

    expect(promptInput).toHaveBeenCalledWith("Azure API key: ")
    expect(promptInput).toHaveBeenCalledWith("Azure endpoint: ")
    expect(promptInput).toHaveBeenCalledWith("Azure deployment: ")
    expect(runHatchFlow).toHaveBeenCalledWith({
      agentName: "AzureSprout",
      humanName: "Ari",
      provider: "azure",
      credentials: {
        apiKey: "azure-key",
        endpoint: "https://example.openai.azure.com",
        deployment: "gpt-4o-mini",
      },
    })
    expect(result).toContain("hatched AzureSprout")
  })

  it("executes hatch flow locally and starts daemon after auth verification", async () => {
    const runHatchFlow = vi.fn(async () => ({
      bundleRoot: "/tmp/AgentBundles/Sprout.ouro",
      selectedIdentity: "medusa.md",
      specialistSecretsPath: "/tmp/.agentsecrets/AdoptionSpecialist/secrets.json",
      hatchlingSecretsPath: "/tmp/.agentsecrets/Sprout/secrets.json",
    }))

    const deps = {
      socketPath: "/tmp/ouro-test.sock",
      sendCommand: vi.fn(async () => ({ ok: true, message: "unexpected sendCommand call" })),
      startDaemonProcess: vi.fn(async () => ({ pid: 999 })),
      writeStdout: vi.fn(),
      checkSocketAlive: vi.fn(async () => false),
      cleanupStaleSocket: vi.fn(),
      fallbackPendingMessage: vi.fn(() => "/tmp/pending.jsonl"),

      registerOuroBundleType: vi.fn(async () => ({ attempted: true, registered: true })),
      runHatchFlow,
    } as OuroCliDeps & {
      runHatchFlow: typeof runHatchFlow
    }

    const result = await runOuroCli([
      "hatch",
      "--agent",
      "Sprout",
      "--human",
      "Ari",
      "--provider",
      "anthropic",
      "--setup-token",
      "sk-ant-oat01-test-token",
    ], deps)

    expect(runHatchFlow).toHaveBeenCalledWith({
      agentName: "Sprout",
      humanName: "Ari",
      provider: "anthropic",
      credentials: {
        setupToken: "sk-ant-oat01-test-token",
      },
    })
    expect(deps.registerOuroBundleType).toHaveBeenCalledTimes(1)
    expect(deps.startDaemonProcess).toHaveBeenCalledWith("/tmp/ouro-test.sock")
    expect(result).toContain("hatched Sprout")
    expect(result).toContain("/tmp/AgentBundles/Sprout.ouro")
    expect(result).toContain("medusa.md")
  })
})

describe("multi-agent prompt, agent-name shortcut, and help", () => {
  it("prompts for agent selection and starts chat with chosen agent", async () => {
    const startChat = vi.fn(async () => {})
    const promptInput = vi.fn(async () => "slugger")
    const deps = {
      socketPath: "/tmp/ouro-test.sock",
      sendCommand: vi.fn(async () => ({ ok: true })),
      startDaemonProcess: vi.fn(async () => ({ pid: 1 })),
      writeStdout: vi.fn(),
      checkSocketAlive: vi.fn(async () => true),
      cleanupStaleSocket: vi.fn(),
      fallbackPendingMessage: vi.fn(() => "/tmp/pending.jsonl"),

      listDiscoveredAgents: vi.fn(async () => ["ouroboros", "slugger"]),
      startChat,
      promptInput,
    } as OuroCliDeps & {
      listDiscoveredAgents: () => Promise<string[]>
      startChat: typeof startChat
      promptInput: typeof promptInput
    }

    await runOuroCli([], deps)

    expect(promptInput).toHaveBeenCalled()
    expect(startChat).toHaveBeenCalledWith("slugger")
    expect(deps.sendCommand).toHaveBeenCalledWith("/tmp/ouro-test.sock", { kind: "daemon.status" })
  })

  it("routes ouro <agent-name> to startChat when agent is discovered", async () => {
    const startChat = vi.fn(async () => {})
    const deps = {
      socketPath: "/tmp/ouro-test.sock",
      sendCommand: vi.fn(async () => ({ ok: true })),
      startDaemonProcess: vi.fn(async () => ({ pid: 1 })),
      writeStdout: vi.fn(),
      checkSocketAlive: vi.fn(async () => true),
      cleanupStaleSocket: vi.fn(),
      fallbackPendingMessage: vi.fn(() => "/tmp/pending.jsonl"),

      listDiscoveredAgents: vi.fn(async () => ["ouroboros", "slugger"]),
      startChat,
    } as OuroCliDeps & {
      listDiscoveredAgents: () => Promise<string[]>
      startChat: typeof startChat
    }

    await runOuroCli(["slugger"], deps)

    expect(startChat).toHaveBeenCalledWith("slugger")
  })

  it("throws error for ouro <name> when agent is not discovered", async () => {
    const startChat = vi.fn(async () => {})
    const deps = {
      socketPath: "/tmp/ouro-test.sock",
      sendCommand: vi.fn(async () => ({ ok: true })),
      startDaemonProcess: vi.fn(async () => ({ pid: 1 })),
      writeStdout: vi.fn(),
      checkSocketAlive: vi.fn(async () => true),
      cleanupStaleSocket: vi.fn(),
      fallbackPendingMessage: vi.fn(() => "/tmp/pending.jsonl"),

      listDiscoveredAgents: vi.fn(async () => ["ouroboros"]),
      startChat,
    } as OuroCliDeps & {
      listDiscoveredAgents: () => Promise<string[]>
      startChat: typeof startChat
    }

    await expect(runOuroCli(["slugger"], deps)).rejects.toThrow("Unknown command")
  })

  it("selects agent by number in multi-agent prompt", async () => {
    const startChat = vi.fn(async () => {})
    const promptInput = vi.fn(async () => "2")
    const deps = {
      socketPath: "/tmp/ouro-test.sock",
      sendCommand: vi.fn(async () => ({ ok: true })),
      startDaemonProcess: vi.fn(async () => ({ pid: 1 })),
      writeStdout: vi.fn(),
      checkSocketAlive: vi.fn(async () => true),
      cleanupStaleSocket: vi.fn(),
      fallbackPendingMessage: vi.fn(() => "/tmp/pending.jsonl"),

      listDiscoveredAgents: vi.fn(async () => ["ouroboros", "slugger"]),
      startChat,
      promptInput,
    } as OuroCliDeps & {
      listDiscoveredAgents: () => Promise<string[]>
      startChat: typeof startChat
      promptInput: typeof promptInput
    }

    await runOuroCli([], deps)

    expect(startChat).toHaveBeenCalledWith("slugger")
  })

  it("throws on invalid selection in multi-agent prompt", async () => {
    const startChat = vi.fn(async () => {})
    const promptInput = vi.fn(async () => "invalid")
    const deps = {
      socketPath: "/tmp/ouro-test.sock",
      sendCommand: vi.fn(async () => ({ ok: true })),
      startDaemonProcess: vi.fn(async () => ({ pid: 1 })),
      writeStdout: vi.fn(),
      checkSocketAlive: vi.fn(async () => true),
      cleanupStaleSocket: vi.fn(),
      fallbackPendingMessage: vi.fn(() => "/tmp/pending.jsonl"),

      listDiscoveredAgents: vi.fn(async () => ["ouroboros", "slugger"]),
      startChat,
      promptInput,
    } as OuroCliDeps & {
      listDiscoveredAgents: () => Promise<string[]>
      startChat: typeof startChat
      promptInput: typeof promptInput
    }

    await expect(runOuroCli([], deps)).rejects.toThrow("Invalid selection")
  })

  it("re-throws parse error when startChat is not provided", async () => {
    const deps: OuroCliDeps = {
      socketPath: "/tmp/ouro-test.sock",
      sendCommand: vi.fn(async () => ({ ok: true })),
      startDaemonProcess: vi.fn(async () => ({ pid: 1 })),
      writeStdout: vi.fn(),
      checkSocketAlive: vi.fn(async () => true),
      cleanupStaleSocket: vi.fn(),
      fallbackPendingMessage: vi.fn(() => "/tmp/pending.jsonl"),

    }

    await expect(runOuroCli(["unknown-cmd"], deps)).rejects.toThrow("Unknown command")
  })

  it("returns usage text for --help flag", async () => {
    const deps: OuroCliDeps = {
      socketPath: "/tmp/ouro-test.sock",
      sendCommand: vi.fn(async () => ({ ok: true })),
      startDaemonProcess: vi.fn(async () => ({ pid: 1 })),
      writeStdout: vi.fn(),
      checkSocketAlive: vi.fn(async () => true),
      cleanupStaleSocket: vi.fn(),
      fallbackPendingMessage: vi.fn(() => "/tmp/pending.jsonl"),

    }

    const result = await runOuroCli(["--help"], deps)

    expect(result).toContain("Usage:")
    expect(deps.sendCommand).not.toHaveBeenCalled()
  })
})

describe("ouro --help completeness (H10)", () => {
  function makeHelpDeps(): OuroCliDeps {
    return {
      socketPath: "/tmp/ouro-test.sock",
      sendCommand: vi.fn(async () => ({ ok: true })),
      startDaemonProcess: vi.fn(async () => ({ pid: 1 })),
      writeStdout: vi.fn(),
      checkSocketAlive: vi.fn(async () => true),
      cleanupStaleSocket: vi.fn(),
      fallbackPendingMessage: vi.fn(() => "/tmp/pending.jsonl"),

    }
  }

  it("includes task subcommands in help output", async () => {
    const deps = makeHelpDeps()
    const result = await runOuroCli(["--help"], deps)

    expect(result).toContain("ouro task board")
    expect(result).toContain("ouro task create")
    expect(result).toContain("ouro task update")
    expect(result).toContain("ouro task show")
    expect(result).toContain("ouro task fix")
    // actionable, deps, sessions are grouped on one line
    expect(result).toContain("actionable")
    expect(result).toContain("deps")
    expect(result).toContain("sessions")
  })

  it("includes reminder subcommand in help output", async () => {
    const deps = makeHelpDeps()
    const result = await runOuroCli(["--help"], deps)

    expect(result).toContain("ouro reminder create")
  })

  it("includes friend subcommands in help output", async () => {
    const deps = makeHelpDeps()
    const result = await runOuroCli(["--help"], deps)

    expect(result).toContain("ouro friend list")
    expect(result).toContain("ouro friend show")
  })

  it("includes whoami in help output", async () => {
    const deps = makeHelpDeps()
    const result = await runOuroCli(["--help"], deps)

    expect(result).toContain("ouro whoami")
  })

  it("includes session subcommand in help output", async () => {
    const deps = makeHelpDeps()
    const result = await runOuroCli(["--help"], deps)

    expect(result).toContain("ouro session list")
  })

  it("includes all core daemon commands in help output", async () => {
    const deps = makeHelpDeps()
    const result = await runOuroCli(["--help"], deps)

    expect(result).toContain("ouro [up]")
    expect(result).toContain("stop")
    expect(result).toContain("down")
    expect(result).toContain("status")
    expect(result).toContain("logs")
    expect(result).toContain("hatch")
    expect(result).toContain("chat")
    expect(result).toContain("msg")
    expect(result).toContain("poke")
    expect(result).toContain("link")
    expect(result).toContain("-v|--version")
  })
})

describe("single agent → chat via startChat", () => {
  it("calls ensureDaemonRunning then startChat when explicit chat command is used", async () => {
    const startChat = vi.fn(async () => {})
    const deps = {
      socketPath: "/tmp/ouro-test.sock",
      sendCommand: vi.fn(async () => ({ ok: true, message: "unexpected" })),
      startDaemonProcess: vi.fn(async () => ({ pid: 42 })),
      writeStdout: vi.fn(),
      checkSocketAlive: vi.fn(async () => false),
      cleanupStaleSocket: vi.fn(),
      fallbackPendingMessage: vi.fn(() => "/tmp/pending.jsonl"),

      listDiscoveredAgents: vi.fn(async () => ["slugger"]),
      startChat,
    } as OuroCliDeps & {
      listDiscoveredAgents: () => Promise<string[]>
      startChat: typeof startChat
    }

    await runOuroCli(["chat", "slugger"], deps)

    expect(startChat).toHaveBeenCalledWith("slugger")
    expect(deps.cleanupStaleSocket).toHaveBeenCalled()
    expect(deps.startDaemonProcess).toHaveBeenCalled()
    expect(deps.sendCommand).not.toHaveBeenCalled()
    expect(deps.writeStdout).not.toHaveBeenCalled()
  })

  it("calls ensureDaemonRunning then startChat when single agent discovered", async () => {
    const startChat = vi.fn(async () => {})
    const deps = {
      socketPath: "/tmp/ouro-test.sock",
      sendCommand: vi.fn(async () => ({ ok: true, message: "unexpected" })),
      startDaemonProcess: vi.fn(async () => ({ pid: 42 })),
      writeStdout: vi.fn(),
      checkSocketAlive: vi.fn(async () => false),
      cleanupStaleSocket: vi.fn(),
      fallbackPendingMessage: vi.fn(() => "/tmp/pending.jsonl"),

      listDiscoveredAgents: vi.fn(async () => ["slugger"]),
      startChat,
    } as OuroCliDeps & {
      listDiscoveredAgents: () => Promise<string[]>
      startChat: typeof startChat
    }

    await runOuroCli([], deps)

    expect(startChat).toHaveBeenCalledWith("slugger")
    expect(deps.cleanupStaleSocket).toHaveBeenCalled()
    expect(deps.startDaemonProcess).toHaveBeenCalled()
    expect(deps.sendCommand).not.toHaveBeenCalled()
  })

  it("skips daemon start when already running before chat", async () => {
    const startChat = vi.fn(async () => {})
    const deps = {
      socketPath: "/tmp/ouro-test.sock",
      sendCommand: vi.fn(async () => ({ ok: true, message: "unexpected" })),
      startDaemonProcess: vi.fn(async () => ({ pid: 1 })),
      writeStdout: vi.fn(),
      checkSocketAlive: vi.fn(async () => true),
      cleanupStaleSocket: vi.fn(),
      fallbackPendingMessage: vi.fn(() => "/tmp/pending.jsonl"),

      listDiscoveredAgents: vi.fn(async () => ["slugger"]),
      startChat,
    } as OuroCliDeps & {
      listDiscoveredAgents: () => Promise<string[]>
      startChat: typeof startChat
    }

    await runOuroCli([], deps)

    expect(startChat).toHaveBeenCalledWith("slugger")
    expect(deps.startDaemonProcess).not.toHaveBeenCalled()
    expect(deps.sendCommand).toHaveBeenCalledWith("/tmp/ouro-test.sock", { kind: "daemon.status" })
  })

  it("falls back to chat.connect daemon command when startChat not provided", async () => {
    const deps = {
      socketPath: "/tmp/ouro-test.sock",
      sendCommand: vi.fn(async () => ({ ok: true, message: "connected to slugger" })),
      startDaemonProcess: vi.fn(async () => ({ pid: 1 })),
      writeStdout: vi.fn(),
      checkSocketAlive: vi.fn(async () => true),
      cleanupStaleSocket: vi.fn(),
      fallbackPendingMessage: vi.fn(() => "/tmp/pending.jsonl"),

      listDiscoveredAgents: vi.fn(async () => ["slugger"]),
    } as OuroCliDeps & {
      listDiscoveredAgents: () => Promise<string[]>
    }

    await runOuroCli([], deps)

    expect(deps.sendCommand).toHaveBeenCalledWith(
      "/tmp/ouro-test.sock",
      expect.objectContaining({ kind: "chat.connect", agent: "slugger" }),
    )
  })
})

describe("hatch → auto-chat", () => {
  it("calls startChat with hatched agent name after hatch completes", async () => {
    const startChat = vi.fn(async () => {})
    const runHatchFlow = vi.fn(async () => ({
      bundleRoot: "/tmp/AgentBundles/Sprout.ouro",
      selectedIdentity: "medusa.md",
      specialistSecretsPath: "/tmp/.agentsecrets/AdoptionSpecialist/secrets.json",
      hatchlingSecretsPath: "/tmp/.agentsecrets/Sprout/secrets.json",
    }))

    const deps = {
      socketPath: "/tmp/ouro-test.sock",
      sendCommand: vi.fn(async () => ({ ok: true })),
      startDaemonProcess: vi.fn(async () => ({ pid: 99 })),
      writeStdout: vi.fn(),
      checkSocketAlive: vi.fn(async () => false),
      cleanupStaleSocket: vi.fn(),
      fallbackPendingMessage: vi.fn(() => "/tmp/pending.jsonl"),

      registerOuroBundleType: vi.fn(async () => ({ attempted: true, registered: true })),
      runHatchFlow,
      startChat,
    } as OuroCliDeps & {
      runHatchFlow: typeof runHatchFlow
      startChat: typeof startChat
    }

    await runOuroCli([
      "hatch",
      "--agent",
      "Sprout",
      "--human",
      "Ari",
      "--provider",
      "anthropic",
      "--setup-token",
      "sk-ant-oat01-test-token",
    ], deps)

    expect(runHatchFlow).toHaveBeenCalled()
    expect(startChat).toHaveBeenCalledWith("Sprout")
  })

  it("ensures daemon is running before starting chat after hatch", async () => {
    const startChat = vi.fn(async () => {})
    const runHatchFlow = vi.fn(async () => ({
      bundleRoot: "/tmp/AgentBundles/Sprout.ouro",
      selectedIdentity: "medusa.md",
      specialistSecretsPath: "/tmp/.agentsecrets/AdoptionSpecialist/secrets.json",
      hatchlingSecretsPath: "/tmp/.agentsecrets/Sprout/secrets.json",
    }))

    const deps = {
      socketPath: "/tmp/ouro-test.sock",
      sendCommand: vi.fn(async () => ({ ok: true })),
      startDaemonProcess: vi.fn(async () => ({ pid: 99 })),
      writeStdout: vi.fn(),
      checkSocketAlive: vi.fn(async () => false),
      cleanupStaleSocket: vi.fn(),
      fallbackPendingMessage: vi.fn(() => "/tmp/pending.jsonl"),

      registerOuroBundleType: vi.fn(async () => ({ attempted: true, registered: true })),
      runHatchFlow,
      startChat,
    } as OuroCliDeps & {
      runHatchFlow: typeof runHatchFlow
      startChat: typeof startChat
    }

    await runOuroCli([
      "hatch",
      "--agent",
      "Sprout",
      "--human",
      "Ari",
      "--provider",
      "anthropic",
      "--setup-token",
      "sk-ant-oat01-test-token",
    ], deps)

    expect(deps.startDaemonProcess).toHaveBeenCalled()
    expect(startChat).toHaveBeenCalledWith("Sprout")
  })

  it("does not call startChat when startChat is not provided", async () => {
    const runHatchFlow = vi.fn(async () => ({
      bundleRoot: "/tmp/AgentBundles/Sprout.ouro",
      selectedIdentity: "medusa.md",
      specialistSecretsPath: "/tmp/.agentsecrets/AdoptionSpecialist/secrets.json",
      hatchlingSecretsPath: "/tmp/.agentsecrets/Sprout/secrets.json",
    }))

    const deps = {
      socketPath: "/tmp/ouro-test.sock",
      sendCommand: vi.fn(async () => ({ ok: true })),
      startDaemonProcess: vi.fn(async () => ({ pid: 99 })),
      writeStdout: vi.fn(),
      checkSocketAlive: vi.fn(async () => false),
      cleanupStaleSocket: vi.fn(),
      fallbackPendingMessage: vi.fn(() => "/tmp/pending.jsonl"),

      registerOuroBundleType: vi.fn(async () => ({ attempted: true, registered: true })),
      runHatchFlow,
    } as OuroCliDeps & {
      runHatchFlow: typeof runHatchFlow
    }

    const result = await runOuroCli([
      "hatch",
      "--agent",
      "Sprout",
      "--human",
      "Ari",
      "--provider",
      "anthropic",
      "--setup-token",
      "sk-ant-oat01-test-token",
    ], deps)

    expect(result).toContain("hatched Sprout")
  })
})

describe("ensureDaemonRunning", () => {
  it("is a no-op when daemon is already running", async () => {
    const { ensureDaemonRunning } = await import("../../../heart/daemon/daemon-cli")

    const deps: OuroCliDeps = {
      socketPath: "/tmp/ouro-test.sock",
      sendCommand: vi.fn(),
      startDaemonProcess: vi.fn(async () => ({ pid: 1 })),
      writeStdout: vi.fn(),
      checkSocketAlive: vi.fn(async () => true),
      cleanupStaleSocket: vi.fn(),
      fallbackPendingMessage: vi.fn(() => "/tmp/pending.jsonl"),

    }

    const result = await ensureDaemonRunning(deps)

    expect(result.alreadyRunning).toBe(true)
    expect(result.message).toContain("already running")
    expect(deps.startDaemonProcess).not.toHaveBeenCalled()
    expect(deps.cleanupStaleSocket).not.toHaveBeenCalled()
  })

  it("replaces a running daemon when its version is older than the local runtime", async () => {
    vi.resetModules()
    vi.doMock("../../../heart/daemon/runtime-metadata", () => ({
      getRuntimeMetadata: () => ({
        version: "0.1.0-alpha.20",
        lastUpdated: "2026-03-09T11:00:00.000Z",
      }),
    }))

    const { ensureDaemonRunning } = await import("../../../heart/daemon/daemon-cli")

    const sendCommand = vi.fn(async (_socketPath, command) => {
      if (command.kind === "daemon.status") {
        return {
          ok: true,
          summary: "running",
          data: {
            overview: {
              daemon: "running",
              health: "ok",
              socketPath: "/tmp/ouro-test.sock",
              version: "0.1.0-alpha.6",
              lastUpdated: "2026-03-08T00:00:00.000Z",
              workerCount: 0,
              senseCount: 0,
            },
            senses: [],
            workers: [],
          },
        }
      }
      if (command.kind === "daemon.stop") {
        return { ok: true, message: "daemon stopped" }
      }
      throw new Error(`unexpected command ${command.kind}`)
    })

    const deps: OuroCliDeps = {
      socketPath: "/tmp/ouro-test.sock",
      sendCommand,
      startDaemonProcess: vi.fn(async () => ({ pid: 777 })),
      writeStdout: vi.fn(),
      checkSocketAlive: vi.fn(async () => true),
      cleanupStaleSocket: vi.fn(),
      fallbackPendingMessage: vi.fn(() => "/tmp/pending.jsonl"),

    }

    const result = await ensureDaemonRunning(deps)

    expect(result.alreadyRunning).toBe(false)
    expect(result.message).toContain("restarted stale daemon")
    expect(result.message).toContain("0.1.0-alpha.6")
    expect(result.message).toContain("0.1.0-alpha.20")
    expect(sendCommand).toHaveBeenNthCalledWith(1, "/tmp/ouro-test.sock", { kind: "daemon.status" })
    expect(sendCommand).toHaveBeenNthCalledWith(2, "/tmp/ouro-test.sock", { kind: "daemon.stop" })
    expect(deps.cleanupStaleSocket).toHaveBeenCalledWith("/tmp/ouro-test.sock")
    expect(deps.startDaemonProcess).toHaveBeenCalledWith("/tmp/ouro-test.sock")
  })

  it("passes runtime path and config drift signals into the daemon runtime sync check", async () => {
    vi.resetModules()
    const ensureCurrentDaemonRuntime = vi.fn(async () => ({
      alreadyRunning: false,
      message: "restarted drifted daemon",
    }))
    vi.doMock("../../../heart/daemon/runtime-metadata", () => ({
      getRuntimeMetadata: () => ({
        version: "0.1.0-alpha.20",
        lastUpdated: "2026-03-09T11:00:00.000Z",
        repoRoot: "/Users/arimendelow/Projects/ouroboros-agent-harness-bb-health-status",
        configFingerprint: "cfg-local",
      }),
    }))
    vi.doMock("../../../heart/daemon/daemon-runtime-sync", () => ({
      ensureCurrentDaemonRuntime,
    }))

    const { ensureDaemonRunning } = await import("../../../heart/daemon/daemon-cli")
    vi.doUnmock("../../../heart/daemon/daemon-runtime-sync")
    vi.doUnmock("../../../heart/daemon/runtime-metadata")

    const deps: OuroCliDeps = {
      socketPath: "/tmp/ouro-test.sock",
      sendCommand: vi.fn(async () => ({
        ok: true,
        summary: "running",
        data: {
          overview: {
            daemon: "running",
            health: "ok",
            socketPath: "/tmp/ouro-test.sock",
            version: "0.1.0-alpha.20",
            lastUpdated: "2026-03-09T11:00:00.000Z",
            repoRoot: "/Users/arimendelow/Projects/ouroboros-agent-harness-cross-chat-bridge-orchestration",
            configFingerprint: "cfg-running",
            workerCount: 0,
            senseCount: 0,
          },
          senses: [],
          workers: [],
        },
      })),
      startDaemonProcess: vi.fn(async () => ({ pid: 777 })),
      writeStdout: vi.fn(),
      checkSocketAlive: vi.fn(async () => true),
      cleanupStaleSocket: vi.fn(),
      fallbackPendingMessage: vi.fn(() => "/tmp/pending.jsonl"),

    }

    const result = await ensureDaemonRunning(deps)
    const syncDeps = ensureCurrentDaemonRuntime.mock.calls[0]?.[0] as {
      localLastUpdated?: string
      localRepoRoot?: string
      localConfigFingerprint?: string
      fetchRunningRuntimeMetadata?: () => Promise<unknown>
    }

    expect(result).toEqual({
      alreadyRunning: false,
      message: "restarted drifted daemon",
    })
    expect(ensureCurrentDaemonRuntime).toHaveBeenCalledWith(expect.objectContaining({
      socketPath: "/tmp/ouro-test.sock",
      localVersion: "0.1.0-alpha.20",
      localLastUpdated: "2026-03-09T11:00:00.000Z",
      localRepoRoot: "/Users/arimendelow/Projects/ouroboros-agent-harness-bb-health-status",
      localConfigFingerprint: "cfg-local",
    }))
    await expect(syncDeps.fetchRunningRuntimeMetadata?.()).resolves.toEqual({
      version: "0.1.0-alpha.20",
      lastUpdated: "2026-03-09T11:00:00.000Z",
      repoRoot: "/Users/arimendelow/Projects/ouroboros-agent-harness-cross-chat-bridge-orchestration",
      configFingerprint: "cfg-running",
    })
  })

  it("keeps a running daemon when version verification fails", async () => {
    vi.resetModules()
    vi.doMock("../../../heart/daemon/runtime-metadata", () => ({
      getRuntimeMetadata: () => ({
        version: "0.1.0-alpha.20",
        lastUpdated: "2026-03-09T11:00:00.000Z",
      }),
    }))

    const { ensureDaemonRunning } = await import("../../../heart/daemon/daemon-cli")

    const deps: OuroCliDeps = {
      socketPath: "/tmp/ouro-test.sock",
      sendCommand: vi.fn(async () => {
        throw new Error("status unavailable")
      }),
      startDaemonProcess: vi.fn(async () => ({ pid: 777 })),
      writeStdout: vi.fn(),
      checkSocketAlive: vi.fn(async () => true),
      cleanupStaleSocket: vi.fn(),
      fallbackPendingMessage: vi.fn(() => "/tmp/pending.jsonl"),

    }

    const result = await ensureDaemonRunning(deps)

    expect(result.alreadyRunning).toBe(true)
    expect(result.message).toContain("unable to verify version")
    expect(deps.startDaemonProcess).not.toHaveBeenCalled()
    expect(deps.cleanupStaleSocket).not.toHaveBeenCalled()
  })

  it("keeps a running daemon when the daemon version is unknown", async () => {
    vi.resetModules()
    vi.doMock("../../../heart/daemon/runtime-metadata", () => ({
      getRuntimeMetadata: () => ({
        version: "0.1.0-alpha.20",
        lastUpdated: "2026-03-09T11:00:00.000Z",
      }),
    }))

    const { ensureDaemonRunning } = await import("../../../heart/daemon/daemon-cli")

    const deps: OuroCliDeps = {
      socketPath: "/tmp/ouro-test.sock",
      sendCommand: vi.fn(async () => ({
        ok: true,
        summary: "running",
        data: {
          overview: {
            daemon: "running",
            health: "ok",
            socketPath: "/tmp/ouro-test.sock",
            version: "unknown",
            lastUpdated: "2026-03-08T00:00:00.000Z",
            workerCount: 0,
            senseCount: 0,
          },
          senses: [],
          workers: [],
        },
      })),
      startDaemonProcess: vi.fn(async () => ({ pid: 777 })),
      writeStdout: vi.fn(),
      checkSocketAlive: vi.fn(async () => true),
      cleanupStaleSocket: vi.fn(),
      fallbackPendingMessage: vi.fn(() => "/tmp/pending.jsonl"),

    }

    const result = await ensureDaemonRunning(deps)

    expect(result.alreadyRunning).toBe(true)
    expect(result.message).toContain("unable to verify version")
    expect(deps.startDaemonProcess).not.toHaveBeenCalled()
  })

  it("keeps a running daemon when version verification throws a non-Error value", async () => {
    vi.resetModules()
    vi.doMock("../../../heart/daemon/runtime-metadata", () => ({
      getRuntimeMetadata: () => ({
        version: "0.1.0-alpha.20",
        lastUpdated: "2026-03-09T11:00:00.000Z",
      }),
    }))

    const { ensureDaemonRunning } = await import("../../../heart/daemon/daemon-cli")

    const deps: OuroCliDeps = {
      socketPath: "/tmp/ouro-test.sock",
      sendCommand: vi.fn(async () => {
        throw "non-error-status-failure"
      }),
      startDaemonProcess: vi.fn(async () => ({ pid: 777 })),
      writeStdout: vi.fn(),
      checkSocketAlive: vi.fn(async () => true),
      cleanupStaleSocket: vi.fn(),
      fallbackPendingMessage: vi.fn(() => "/tmp/pending.jsonl"),

    }

    const result = await ensureDaemonRunning(deps)

    expect(result.alreadyRunning).toBe(true)
    expect(result.message).toContain("non-error-status-failure")
    expect(deps.startDaemonProcess).not.toHaveBeenCalled()
  })

  it("keeps the running daemon when stale replacement cannot complete", async () => {
    vi.resetModules()
    vi.doMock("../../../heart/daemon/runtime-metadata", () => ({
      getRuntimeMetadata: () => ({
        version: "0.1.0-alpha.20",
        lastUpdated: "2026-03-09T11:00:00.000Z",
      }),
    }))

    const { ensureDaemonRunning } = await import("../../../heart/daemon/daemon-cli")

    const sendCommand = vi.fn(async (_socketPath, command) => {
      if (command.kind === "daemon.status") {
        return {
          ok: true,
          summary: "running",
          data: {
            overview: {
              daemon: "running",
              health: "ok",
              socketPath: "/tmp/ouro-test.sock",
              version: "0.1.0-alpha.6",
              lastUpdated: "2026-03-08T00:00:00.000Z",
              workerCount: 0,
              senseCount: 0,
            },
            senses: [],
            workers: [],
          },
        }
      }
      if (command.kind === "daemon.stop") {
        throw new Error("permission denied")
      }
      throw new Error(`unexpected command ${command.kind}`)
    })

    const deps: OuroCliDeps = {
      socketPath: "/tmp/ouro-test.sock",
      sendCommand,
      startDaemonProcess: vi.fn(async () => ({ pid: 777 })),
      writeStdout: vi.fn(),
      checkSocketAlive: vi.fn(async () => true),
      cleanupStaleSocket: vi.fn(),
      fallbackPendingMessage: vi.fn(() => "/tmp/pending.jsonl"),

    }

    const result = await ensureDaemonRunning(deps)

    expect(result.alreadyRunning).toBe(true)
    expect(result.message).toContain("could not replace stale daemon")
    expect(result.message).toContain("permission denied")
    expect(deps.startDaemonProcess).not.toHaveBeenCalled()
  })

  it("keeps the running daemon when stale replacement fails with a non-Error value", async () => {
    vi.resetModules()
    vi.doMock("../../../heart/daemon/runtime-metadata", () => ({
      getRuntimeMetadata: () => ({
        version: "0.1.0-alpha.20",
        lastUpdated: "2026-03-09T11:00:00.000Z",
      }),
    }))

    const { ensureDaemonRunning } = await import("../../../heart/daemon/daemon-cli")

    const sendCommand = vi.fn(async (_socketPath, command) => {
      if (command.kind === "daemon.status") {
        return {
          ok: true,
          summary: "running",
          data: {
            overview: {
              daemon: "running",
              health: "ok",
              socketPath: "/tmp/ouro-test.sock",
              version: "0.1.0-alpha.6",
              lastUpdated: "2026-03-08T00:00:00.000Z",
              workerCount: 0,
              senseCount: 0,
            },
            senses: [],
            workers: [],
          },
        }
      }
      if (command.kind === "daemon.stop") {
        throw "string-stop-failure"
      }
      throw new Error(`unexpected command ${command.kind}`)
    })

    const deps: OuroCliDeps = {
      socketPath: "/tmp/ouro-test.sock",
      sendCommand,
      startDaemonProcess: vi.fn(async () => ({ pid: 777 })),
      writeStdout: vi.fn(),
      checkSocketAlive: vi.fn(async () => true),
      cleanupStaleSocket: vi.fn(),
      fallbackPendingMessage: vi.fn(() => "/tmp/pending.jsonl"),

    }

    const result = await ensureDaemonRunning(deps)

    expect(result.alreadyRunning).toBe(true)
    expect(result.message).toContain("string-stop-failure")
    expect(deps.startDaemonProcess).not.toHaveBeenCalled()
  })

  it("cleans up stale socket and starts daemon when not running", async () => {
    const { ensureDaemonRunning } = await import("../../../heart/daemon/daemon-cli")

    const deps: OuroCliDeps = {
      socketPath: "/tmp/ouro-test.sock",
      sendCommand: vi.fn(),
      startDaemonProcess: vi.fn(async () => ({ pid: 42 })),
      writeStdout: vi.fn(),
      checkSocketAlive: vi.fn(async () => false),
      cleanupStaleSocket: vi.fn(),
      fallbackPendingMessage: vi.fn(() => "/tmp/pending.jsonl"),

    }

    const result = await ensureDaemonRunning(deps)

    expect(result.alreadyRunning).toBe(false)
    expect(result.message).toContain("daemon started")
    expect(result.message).toContain("42")
    expect(deps.cleanupStaleSocket).toHaveBeenCalledWith("/tmp/ouro-test.sock")
    expect(deps.startDaemonProcess).toHaveBeenCalledWith("/tmp/ouro-test.sock")
  })

  it("formats unknown pid when startDaemonProcess returns null pid", async () => {
    const { ensureDaemonRunning } = await import("../../../heart/daemon/daemon-cli")

    const deps: OuroCliDeps = {
      socketPath: "/tmp/ouro-test.sock",
      sendCommand: vi.fn(),
      startDaemonProcess: vi.fn(async () => ({ pid: null })),
      writeStdout: vi.fn(),
      checkSocketAlive: vi.fn(async () => false),
      cleanupStaleSocket: vi.fn(),
      fallbackPendingMessage: vi.fn(() => "/tmp/pending.jsonl"),

    }

    const result = await ensureDaemonRunning(deps)

    expect(result.alreadyRunning).toBe(false)
    expect(result.message).toContain("pid unknown")
  })

  it("calls tailLogs directly for ouro logs when tailLogs dep is provided", async () => {
    const tailLogs = vi.fn(() => () => {})
    const deps: OuroCliDeps = {
      socketPath: "/tmp/ouro-test.sock",
      sendCommand: vi.fn(),
      startDaemonProcess: vi.fn(async () => ({ pid: 1 })),
      writeStdout: vi.fn(),
      checkSocketAlive: vi.fn(async () => true),
      cleanupStaleSocket: vi.fn(),
      fallbackPendingMessage: vi.fn(() => "/tmp/pending.jsonl"),

      tailLogs,
    }

    const result = await runOuroCli(["logs"], deps)

    expect(tailLogs).toHaveBeenCalledTimes(1)
    expect(deps.sendCommand).not.toHaveBeenCalled()
    expect(result).toBe("")
  })

  it("falls back to daemon socket for ouro logs when tailLogs dep is not set", async () => {
    const deps: OuroCliDeps = {
      socketPath: "/tmp/ouro-test.sock",
      sendCommand: vi.fn(async () => ({ ok: true, summary: "logs available" })),
      startDaemonProcess: vi.fn(async () => ({ pid: 1 })),
      writeStdout: vi.fn(),
      checkSocketAlive: vi.fn(async () => true),
      cleanupStaleSocket: vi.fn(),
      fallbackPendingMessage: vi.fn(() => "/tmp/pending.jsonl"),

    }

    await runOuroCli(["logs"], deps)

    expect(deps.sendCommand).toHaveBeenCalledWith(
      "/tmp/ouro-test.sock",
      { kind: "daemon.logs" },
    )
  })
})

describe("specialist integration (zero agents -> adoption specialist)", () => {
  it("routes bare ouro to adoption specialist when zero agents discovered and dep is provided", async () => {
    const runAdoptionSpecialist = vi.fn(async () => "HatchedBot")
    const startChat = vi.fn(async () => {})
    const deps: OuroCliDeps = {
      socketPath: "/tmp/ouro-test.sock",
      sendCommand: vi.fn(async () => ({ ok: true })),
      startDaemonProcess: vi.fn(async () => ({ pid: 42 })),
      writeStdout: vi.fn(),
      checkSocketAlive: vi.fn(async () => false),
      cleanupStaleSocket: vi.fn(),
      fallbackPendingMessage: vi.fn(() => "/tmp/pending.jsonl"),

      listDiscoveredAgents: vi.fn(async () => []),
      runAdoptionSpecialist,
      startChat,
    }

    await runOuroCli([], deps)

    expect(runAdoptionSpecialist).toHaveBeenCalledTimes(1)
    // Should NOT have fallen through to the old hatch flow
    expect(deps.sendCommand).not.toHaveBeenCalled()
  })

  it("starts daemon and chat with hatchling name after specialist returns a name", async () => {
    const runAdoptionSpecialist = vi.fn(async () => "MyNewBot")
    const startChat = vi.fn(async () => {})
    const deps: OuroCliDeps = {
      socketPath: "/tmp/ouro-test.sock",
      sendCommand: vi.fn(async () => ({ ok: true })),
      startDaemonProcess: vi.fn(async () => ({ pid: 77 })),
      writeStdout: vi.fn(),
      checkSocketAlive: vi.fn(async () => false),
      cleanupStaleSocket: vi.fn(),
      fallbackPendingMessage: vi.fn(() => "/tmp/pending.jsonl"),

      registerOuroBundleType: vi.fn(async () => ({ attempted: true, registered: true })),
      listDiscoveredAgents: vi.fn(async () => []),
      runAdoptionSpecialist,
      startChat,
    }

    await runOuroCli([], deps)

    expect(runAdoptionSpecialist).toHaveBeenCalledTimes(1)
    expect(deps.registerOuroBundleType).toHaveBeenCalledTimes(1)
    expect(deps.startDaemonProcess).toHaveBeenCalled()
    expect(startChat).toHaveBeenCalledWith("MyNewBot")
  })

  it("exits cleanly without starting chat when specialist returns null (aborted)", async () => {
    const runAdoptionSpecialist = vi.fn(async () => null)
    const startChat = vi.fn(async () => {})
    const deps: OuroCliDeps = {
      socketPath: "/tmp/ouro-test.sock",
      sendCommand: vi.fn(async () => ({ ok: true })),
      startDaemonProcess: vi.fn(async () => ({ pid: 1 })),
      writeStdout: vi.fn(),
      checkSocketAlive: vi.fn(async () => false),
      cleanupStaleSocket: vi.fn(),
      fallbackPendingMessage: vi.fn(() => "/tmp/pending.jsonl"),

      listDiscoveredAgents: vi.fn(async () => []),
      runAdoptionSpecialist,
      startChat,
    }

    const result = await runOuroCli([], deps)

    expect(runAdoptionSpecialist).toHaveBeenCalledTimes(1)
    expect(startChat).not.toHaveBeenCalled()
    expect(deps.startDaemonProcess).not.toHaveBeenCalled()
    expect(result).toBe("")
  })

  it("calls installOuroCommand during system setup before specialist runs", async () => {
    const callOrder: string[] = []
    const installOuroCommand = vi.fn(() => {
      callOrder.push("installOuroCommand")
      return { installed: true, scriptPath: "/home/test/.local/bin/ouro", pathReady: true, shellProfileUpdated: null }
    })
    const syncGlobalOuroBotWrapper = vi.fn(async () => {
      callOrder.push("syncGlobalOuroBotWrapper")
      return { installed: true }
    })
    const runAdoptionSpecialist = vi.fn(async () => {
      callOrder.push("runAdoptionSpecialist")
      return "OrderBot"
    })
    const startChat = vi.fn(async () => {})
    const deps: OuroCliDeps = {
      socketPath: "/tmp/ouro-test.sock",
      sendCommand: vi.fn(async () => ({ ok: true })),
      startDaemonProcess: vi.fn(async () => ({ pid: 1 })),
      writeStdout: vi.fn(),
      checkSocketAlive: vi.fn(async () => false),
      cleanupStaleSocket: vi.fn(),
      fallbackPendingMessage: vi.fn(() => "/tmp/pending.jsonl"),
      listDiscoveredAgents: vi.fn(async () => []),
      runAdoptionSpecialist,
      installOuroCommand,
      syncGlobalOuroBotWrapper,
      startChat,
    }

    await runOuroCli([], deps)

    expect(installOuroCommand).toHaveBeenCalledTimes(1)
    expect(syncGlobalOuroBotWrapper).toHaveBeenCalledTimes(1)
    // System setup should happen before the specialist
    expect(callOrder.indexOf("installOuroCommand")).toBeLessThan(callOrder.indexOf("runAdoptionSpecialist"))
    expect(callOrder.indexOf("syncGlobalOuroBotWrapper")).toBeLessThan(callOrder.indexOf("runAdoptionSpecialist"))
  })

  it("handles installOuroCommand failure gracefully during system setup", async () => {
    const installOuroCommand = vi.fn(() => { throw new Error("permission denied") })
    const runAdoptionSpecialist = vi.fn(async () => "GracefulBot")
    const startChat = vi.fn(async () => {})
    const deps: OuroCliDeps = {
      socketPath: "/tmp/ouro-test.sock",
      sendCommand: vi.fn(async () => ({ ok: true })),
      startDaemonProcess: vi.fn(async () => ({ pid: 1 })),
      writeStdout: vi.fn(),
      checkSocketAlive: vi.fn(async () => false),
      cleanupStaleSocket: vi.fn(),
      fallbackPendingMessage: vi.fn(() => "/tmp/pending.jsonl"),

      listDiscoveredAgents: vi.fn(async () => []),
      runAdoptionSpecialist,
      installOuroCommand,
      startChat,
    }

    // Should not throw — failure is non-blocking
    await runOuroCli([], deps)

    expect(installOuroCommand).toHaveBeenCalledTimes(1)
    expect(runAdoptionSpecialist).toHaveBeenCalledTimes(1)
    expect(startChat).toHaveBeenCalledWith("GracefulBot")
  })

  it("handles syncGlobalOuroBotWrapper failure gracefully during system setup", async () => {
    const syncGlobalOuroBotWrapper = vi.fn(async () => { throw new Error("npm install failed") })
    const runAdoptionSpecialist = vi.fn(async () => "WrapperBot")
    const startChat = vi.fn(async () => {})
    const deps: OuroCliDeps = {
      socketPath: "/tmp/ouro-test.sock",
      sendCommand: vi.fn(async () => ({ ok: true })),
      startDaemonProcess: vi.fn(async () => ({ pid: 1 })),
      writeStdout: vi.fn(),
      checkSocketAlive: vi.fn(async () => false),
      cleanupStaleSocket: vi.fn(),
      fallbackPendingMessage: vi.fn(() => "/tmp/pending.jsonl"),

      listDiscoveredAgents: vi.fn(async () => []),
      runAdoptionSpecialist,
      syncGlobalOuroBotWrapper,
      startChat,
    }

    await runOuroCli([], deps)

    expect(syncGlobalOuroBotWrapper).toHaveBeenCalledTimes(1)
    expect(runAdoptionSpecialist).toHaveBeenCalledTimes(1)
    expect(startChat).toHaveBeenCalledWith("WrapperBot")
  })

  it("falls back to old hatch flow for explicit ouro hatch command even when specialist dep exists", async () => {
    const runAdoptionSpecialist = vi.fn(async () => "ShouldNotBeUsed")
    const runHatchFlow = vi.fn(async () => ({
      bundleRoot: "/tmp/AgentBundles/ExplicitBot.ouro",
      selectedIdentity: "python.md",
      specialistSecretsPath: "/tmp/.agentsecrets/AdoptionSpecialist/secrets.json",
      hatchlingSecretsPath: "/tmp/.agentsecrets/ExplicitBot/secrets.json",
    }))

    const deps: OuroCliDeps = {
      socketPath: "/tmp/ouro-test.sock",
      sendCommand: vi.fn(async () => ({ ok: true })),
      startDaemonProcess: vi.fn(async () => ({ pid: 33 })),
      writeStdout: vi.fn(),
      checkSocketAlive: vi.fn(async () => false),
      cleanupStaleSocket: vi.fn(),
      fallbackPendingMessage: vi.fn(() => "/tmp/pending.jsonl"),

      registerOuroBundleType: vi.fn(async () => ({ attempted: true, registered: true })),
      runAdoptionSpecialist,
      runHatchFlow,
    }

    const result = await runOuroCli([
      "hatch",
      "--agent",
      "ExplicitBot",
      "--human",
      "Ari",
      "--provider",
      "anthropic",
      "--setup-token",
      "sk-ant-oat01-test-token",
    ], deps)

    expect(runAdoptionSpecialist).not.toHaveBeenCalled()
    expect(runHatchFlow).toHaveBeenCalled()
    expect(result).toContain("hatched ExplicitBot")
  })

  it("routes bare ouro hatch through specialist when no explicit args given", async () => {
    const runAdoptionSpecialist = vi.fn(async () => "HatchedViaSpecialist")
    const startChat = vi.fn(async () => {})
    const deps: OuroCliDeps = {
      socketPath: "/tmp/ouro-test.sock",
      sendCommand: vi.fn(async () => ({ ok: true })),
      startDaemonProcess: vi.fn(async () => ({ pid: 42 })),
      writeStdout: vi.fn(),
      checkSocketAlive: vi.fn(async () => false),
      cleanupStaleSocket: vi.fn(),
      fallbackPendingMessage: vi.fn(() => "/tmp/pending.jsonl"),

      registerOuroBundleType: vi.fn(async () => ({ attempted: true, registered: true })),
      runAdoptionSpecialist,
      startChat,
    }

    const result = await runOuroCli(["hatch"], deps)

    expect(runAdoptionSpecialist).toHaveBeenCalledTimes(1)
    expect(startChat).toHaveBeenCalledWith("HatchedViaSpecialist")
    expect(result).toBe("")
  })

  it("returns empty string without starting chat on bare ouro hatch when startChat is not provided", async () => {
    const runAdoptionSpecialist = vi.fn(async () => "NoChatHatch")
    const deps: OuroCliDeps = {
      socketPath: "/tmp/ouro-test.sock",
      sendCommand: vi.fn(async () => ({ ok: true })),
      startDaemonProcess: vi.fn(async () => ({ pid: 11 })),
      writeStdout: vi.fn(),
      checkSocketAlive: vi.fn(async () => false),
      cleanupStaleSocket: vi.fn(),
      fallbackPendingMessage: vi.fn(() => "/tmp/pending.jsonl"),

      registerOuroBundleType: vi.fn(async () => ({ attempted: true, registered: true })),
      runAdoptionSpecialist,
      // No startChat provided
    }

    const result = await runOuroCli(["hatch"], deps)

    expect(runAdoptionSpecialist).toHaveBeenCalledTimes(1)
    expect(result).toBe("")
  })

  it("returns empty string when specialist returns null on bare ouro hatch", async () => {
    const runAdoptionSpecialist = vi.fn(async () => null)
    const deps: OuroCliDeps = {
      socketPath: "/tmp/ouro-test.sock",
      sendCommand: vi.fn(async () => ({ ok: true })),
      startDaemonProcess: vi.fn(async () => ({ pid: 1 })),
      writeStdout: vi.fn(),
      checkSocketAlive: vi.fn(async () => false),
      cleanupStaleSocket: vi.fn(),
      fallbackPendingMessage: vi.fn(() => "/tmp/pending.jsonl"),

      runAdoptionSpecialist,
    }

    const result = await runOuroCli(["hatch"], deps)

    expect(runAdoptionSpecialist).toHaveBeenCalledTimes(1)
    expect(result).toBe("")
  })

  it("returns empty string without starting chat when startChat is not provided", async () => {
    const runAdoptionSpecialist = vi.fn(async () => "NoChatBot")
    const deps: OuroCliDeps = {
      socketPath: "/tmp/ouro-test.sock",
      sendCommand: vi.fn(async () => ({ ok: true })),
      startDaemonProcess: vi.fn(async () => ({ pid: 88 })),
      writeStdout: vi.fn(),
      checkSocketAlive: vi.fn(async () => false),
      cleanupStaleSocket: vi.fn(),
      fallbackPendingMessage: vi.fn(() => "/tmp/pending.jsonl"),

      registerOuroBundleType: vi.fn(async () => ({ attempted: true, registered: true })),
      listDiscoveredAgents: vi.fn(async () => []),
      runAdoptionSpecialist,
      // No startChat provided
    }

    const result = await runOuroCli([], deps)

    expect(runAdoptionSpecialist).toHaveBeenCalledTimes(1)
    expect(deps.startDaemonProcess).toHaveBeenCalled()
    expect(result).toBe("")
  })
})

describe("daemon command protocol", () => {
  it("handles raw JSON command payloads and returns structured JSON", async () => {
    const daemon = new OuroDaemon({
      socketPath: "/tmp/ouro-test.sock",
      processManager: {
        listAgentSnapshots: () => [
          {
            name: "slugger",
            channel: "cli",
            status: "running",
            pid: 123,
            restartCount: 0,
            startedAt: null,
            lastCrashAt: null,
            backoffMs: 1000,
          },
        ],
        startAutoStartAgents: async () => undefined,
        stopAll: async () => undefined,
        startAgent: async () => undefined,
      },
      scheduler: {
        listJobs: () => [],
        triggerJob: async () => ({ ok: true, message: "triggered" }),
      },
      healthMonitor: {
        runChecks: async () => [{ name: "agent-processes", status: "ok", message: "all good" }],
      },
      router: {
        send: async () => ({ id: "msg-1", queuedAt: "2026-03-05T22:00:00.000Z" }),
        pollInbox: () => [],
      },
    })

    const raw = await daemon.handleRawPayload("{\"kind\":\"daemon.status\"}")
    const parsed = JSON.parse(raw) as { ok: boolean; summary?: string }

    expect(parsed.ok).toBe(true)
    expect(parsed.summary).toContain("slugger")
  })

  it("returns protocol errors for malformed payloads", async () => {
    const daemon = new OuroDaemon({
      socketPath: "/tmp/ouro-test.sock",
      processManager: {
        listAgentSnapshots: () => [],
        startAutoStartAgents: async () => undefined,
        stopAll: async () => undefined,
        startAgent: async () => undefined,
      },
      scheduler: {
        listJobs: () => [],
        triggerJob: async () => ({ ok: true, message: "triggered" }),
      },
      healthMonitor: {
        runChecks: async () => [],
      },
      router: {
        send: async () => ({ id: "msg-1", queuedAt: "2026-03-05T22:00:00.000Z" }),
        pollInbox: () => [],
      },
    })

    const raw = await daemon.handleRawPayload("not-json")
    const parsed = JSON.parse(raw) as { ok: boolean; error?: string }

    expect(parsed.ok).toBe(false)
    expect(parsed.error).toContain("Invalid daemon command payload")
  })
})

describe("discoverExistingCredentials", () => {
  const fs = require("fs") as typeof import("fs")
  const os = require("os") as typeof import("os")
  const path = require("path") as typeof import("path")

  function makeTempSecrets(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), "discover-creds-"))
  }

  it("returns empty array when secretsRoot does not exist", () => {
    const result = discoverExistingCredentials("/nonexistent/path")
    expect(result).toEqual([])
  })

  it("returns empty array when secretsRoot is empty", () => {
    const tmpDir = makeTempSecrets()
    try {
      const result = discoverExistingCredentials(tmpDir)
      expect(result).toEqual([])
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it("discovers anthropic credentials with setupToken", () => {
    const tmpDir = makeTempSecrets()
    const agentDir = path.join(tmpDir, "myagent")
    fs.mkdirSync(agentDir)
    fs.writeFileSync(
      path.join(agentDir, "secrets.json"),
      JSON.stringify({ providers: { anthropic: { setupToken: "sk-ant-test" } } }),
    )
    try {
      const result = discoverExistingCredentials(tmpDir)
      expect(result).toEqual([
        { agentName: "myagent", provider: "anthropic", credentials: { setupToken: "sk-ant-test" }, providerConfig: { setupToken: "sk-ant-test" } },
      ])
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it("discovers minimax credentials with apiKey", () => {
    const tmpDir = makeTempSecrets()
    const agentDir = path.join(tmpDir, "minimaxagent")
    fs.mkdirSync(agentDir)
    fs.writeFileSync(
      path.join(agentDir, "secrets.json"),
      JSON.stringify({ providers: { minimax: { apiKey: "mm-key-123" } } }),
    )
    try {
      const result = discoverExistingCredentials(tmpDir)
      expect(result).toEqual([
        { agentName: "minimaxagent", provider: "minimax", credentials: { apiKey: "mm-key-123" }, providerConfig: { apiKey: "mm-key-123" } },
      ])
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it("discovers openai-codex credentials with oauthAccessToken", () => {
    const tmpDir = makeTempSecrets()
    const agentDir = path.join(tmpDir, "codexagent")
    fs.mkdirSync(agentDir)
    fs.writeFileSync(
      path.join(agentDir, "secrets.json"),
      JSON.stringify({ providers: { "openai-codex": { oauthAccessToken: "oauth-tok" } } }),
    )
    try {
      const result = discoverExistingCredentials(tmpDir)
      expect(result).toEqual([
        { agentName: "codexagent", provider: "openai-codex", credentials: { oauthAccessToken: "oauth-tok" }, providerConfig: { oauthAccessToken: "oauth-tok" } },
      ])
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it("discovers azure credentials when all three fields present", () => {
    const tmpDir = makeTempSecrets()
    const agentDir = path.join(tmpDir, "azureagent")
    fs.mkdirSync(agentDir)
    fs.writeFileSync(
      path.join(agentDir, "secrets.json"),
      JSON.stringify({
        providers: { azure: { apiKey: "az-key", endpoint: "https://az.endpoint", deployment: "gpt-deploy" } },
      }),
    )
    try {
      const result = discoverExistingCredentials(tmpDir)
      expect(result).toEqual([
        {
          agentName: "azureagent",
          provider: "azure",
          credentials: { apiKey: "az-key", endpoint: "https://az.endpoint", deployment: "gpt-deploy" },
          providerConfig: { apiKey: "az-key", endpoint: "https://az.endpoint", deployment: "gpt-deploy" },
        },
      ])
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it("skips azure with missing fields", () => {
    const tmpDir = makeTempSecrets()
    const agentDir = path.join(tmpDir, "azuepartial")
    fs.mkdirSync(agentDir)
    fs.writeFileSync(
      path.join(agentDir, "secrets.json"),
      JSON.stringify({ providers: { azure: { apiKey: "az-key", endpoint: "", deployment: "" } } }),
    )
    try {
      const result = discoverExistingCredentials(tmpDir)
      expect(result).toEqual([])
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it("skips providers with empty credential strings", () => {
    const tmpDir = makeTempSecrets()
    const agentDir = path.join(tmpDir, "emptyagent")
    fs.mkdirSync(agentDir)
    fs.writeFileSync(
      path.join(agentDir, "secrets.json"),
      JSON.stringify({
        providers: {
          anthropic: { setupToken: "" },
          minimax: { apiKey: "" },
          "openai-codex": { oauthAccessToken: "" },
        },
      }),
    )
    try {
      const result = discoverExistingCredentials(tmpDir)
      expect(result).toEqual([])
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it("discovers multiple providers from multiple agents and deduplicates", () => {
    const tmpDir = makeTempSecrets()
    const agentA = path.join(tmpDir, "agentA")
    const agentB = path.join(tmpDir, "agentB")
    fs.mkdirSync(agentA)
    fs.mkdirSync(agentB)
    // Both agents have same anthropic key
    fs.writeFileSync(
      path.join(agentA, "secrets.json"),
      JSON.stringify({ providers: { anthropic: { setupToken: "same-key" } } }),
    )
    fs.writeFileSync(
      path.join(agentB, "secrets.json"),
      JSON.stringify({ providers: { anthropic: { setupToken: "same-key" }, minimax: { apiKey: "mm-key" } } }),
    )
    try {
      const result = discoverExistingCredentials(tmpDir)
      // Should have anthropic (deduplicated) + minimax
      expect(result).toHaveLength(2)
      expect(result.find((r) => r.provider === "anthropic")).toBeDefined()
      expect(result.find((r) => r.provider === "minimax")).toBeDefined()
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it("skips non-directory entries and invalid JSON", () => {
    const tmpDir = makeTempSecrets()
    // File instead of directory
    fs.writeFileSync(path.join(tmpDir, "not-a-dir"), "hello")
    // Directory with invalid JSON
    const badDir = path.join(tmpDir, "badjson")
    fs.mkdirSync(badDir)
    fs.writeFileSync(path.join(badDir, "secrets.json"), "not-json{{{")
    // Directory with no secrets.json
    const emptyDir = path.join(tmpDir, "nosecrets")
    fs.mkdirSync(emptyDir)
    try {
      const result = discoverExistingCredentials(tmpDir)
      expect(result).toEqual([])
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it("skips entries without providers key", () => {
    const tmpDir = makeTempSecrets()
    const agentDir = path.join(tmpDir, "noproviders")
    fs.mkdirSync(agentDir)
    fs.writeFileSync(path.join(agentDir, "secrets.json"), JSON.stringify({ integrations: {} }))
    try {
      const result = discoverExistingCredentials(tmpDir)
      expect(result).toEqual([])
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })
})

describe("ouro task CLI execution", () => {
  const mockTaskModule = {
    getBoard: vi.fn(),
    createTask: vi.fn(),
    updateStatus: vi.fn(),
    getTask: vi.fn(),
    boardStatus: vi.fn(),
    boardAction: vi.fn(),
    boardDeps: vi.fn(),
    boardSessions: vi.fn(),
    fix: vi.fn(),
  }

  function makeDeps(overrides?: Partial<OuroCliDeps>): OuroCliDeps {
    return {
      socketPath: "/tmp/ouro-test.sock",
      sendCommand: vi.fn(),
      startDaemonProcess: vi.fn(async () => ({ pid: 1 })),
      writeStdout: vi.fn(),
      checkSocketAlive: vi.fn(async () => true),
      cleanupStaleSocket: vi.fn(),
      fallbackPendingMessage: vi.fn(() => "/tmp/pending.jsonl"),

      taskModule: mockTaskModule as any,
      ...overrides,
    }
  }

  it("ouro task board returns full board output", async () => {
    mockTaskModule.getBoard.mockReturnValueOnce({
      compact: "[Tasks] processing:1",
      full: "## processing\n- sample-task",
      byStatus: { drafting: [], processing: ["sample-task"], validating: [], collaborating: [], paused: [], blocked: [], done: [], cancelled: [] },
      actionRequired: [],
      unresolvedDependencies: [],
      activeSessions: [],
    })

    const deps = makeDeps()
    const result = await runOuroCli(["task", "board"], deps)
    expect(result).toContain("## processing")
    expect(result).toContain("sample-task")
    // Should NOT send to daemon
    expect(deps.sendCommand).not.toHaveBeenCalled()
  })

  it("ouro task board returns no-tasks fallback when board is empty", async () => {
    mockTaskModule.getBoard.mockReturnValueOnce({
      compact: "",
      full: "",
      byStatus: { drafting: [], processing: [], validating: [], collaborating: [], paused: [], blocked: [], done: [], cancelled: [] },
      actionRequired: [],
      unresolvedDependencies: [],
      activeSessions: [],
    })

    const deps = makeDeps()
    const result = await runOuroCli(["task", "board"], deps)
    expect(result).toBe("no tasks found")
  })

  it("ouro task board <status> returns status-filtered board", async () => {
    mockTaskModule.boardStatus.mockReturnValueOnce(["task-a", "task-b"])
    const deps = makeDeps()
    const result = await runOuroCli(["task", "board", "processing"], deps)
    expect(result).toBe("task-a\ntask-b")
    expect(mockTaskModule.boardStatus).toHaveBeenCalledWith("processing")
  })

  it("ouro task board <status> returns fallback when no tasks in status", async () => {
    mockTaskModule.boardStatus.mockReturnValueOnce([])
    const deps = makeDeps()
    const result = await runOuroCli(["task", "board", "blocked"], deps)
    expect(result).toBe("no tasks in that status")
  })

  it("ouro task create returns file path and initial content", async () => {
    mockTaskModule.createTask.mockReturnValueOnce("/mock/tasks/one-shots/2026-03-09-my-task.md")
    const deps = makeDeps()
    const result = await runOuroCli(["task", "create", "My Task", "--type", "one-shot"], deps)
    expect(result).toContain("created:")
    expect(result).toContain("/mock/tasks/one-shots/2026-03-09-my-task.md")
    expect(mockTaskModule.createTask).toHaveBeenCalledWith(
      expect.objectContaining({ title: "My Task", type: "one-shot" }),
    )
  })

  it("ouro task create defaults type when --type not specified", async () => {
    mockTaskModule.createTask.mockReturnValueOnce("/mock/tasks/one-shots/2026-03-09-quick-task.md")
    const deps = makeDeps()
    const result = await runOuroCli(["task", "create", "Quick Task"], deps)
    expect(result).toContain("created:")
    expect(mockTaskModule.createTask).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Quick Task", type: "one-shot" }),
    )
  })

  it("ouro task create surfaces module exceptions", async () => {
    mockTaskModule.createTask.mockImplementationOnce(() => {
      throw new Error("create failed")
    })
    const deps = makeDeps()
    const result = await runOuroCli(["task", "create", "Bad Task", "--type", "one-shot"], deps)
    expect(result).toContain("error: create failed")
  })

  it("ouro task update delegates to updateStatus", async () => {
    mockTaskModule.updateStatus.mockReturnValueOnce({ ok: true, from: "drafting", to: "processing" })
    const deps = makeDeps()
    const result = await runOuroCli(["task", "update", "my-task", "processing"], deps)
    expect(result).toContain("updated: my-task -> processing")
    expect(mockTaskModule.updateStatus).toHaveBeenCalledWith("my-task", "processing")
  })

  it("ouro task update surfaces module errors", async () => {
    mockTaskModule.updateStatus.mockReturnValueOnce({
      ok: false,
      from: "drafting",
      to: "done",
      reason: "invalid transition",
    })
    const deps = makeDeps()
    const result = await runOuroCli(["task", "update", "my-task", "done"], deps)
    expect(result).toContain("error: invalid transition")
  })

  it("ouro task update uses default failure reason when module omits one", async () => {
    mockTaskModule.updateStatus.mockReturnValueOnce({
      ok: false,
      from: "drafting",
      to: "done",
    })
    const deps = makeDeps()
    const result = await runOuroCli(["task", "update", "my-task", "done"], deps)
    expect(result).toContain("error: status update failed")
  })

  it("ouro task update includes archive details", async () => {
    mockTaskModule.updateStatus.mockReturnValueOnce({
      ok: true,
      from: "validating",
      to: "done",
      archived: ["/mock/archive/task.md"],
    })
    const deps = makeDeps()
    const result = await runOuroCli(["task", "update", "my-task", "done"], deps)
    expect(result).toContain("updated: my-task -> done")
    expect(result).toContain("archived:")
  })

  it("ouro task show reads and formats a task file", async () => {
    mockTaskModule.getTask.mockReturnValueOnce({
      path: "/mock/tasks/one-shots/2026-03-09-my-task.md",
      name: "2026-03-09-my-task.md",
      stem: "2026-03-09-my-task",
      type: "one-shot",
      collection: "one-shots",
      category: "infrastructure",
      title: "My Task",
      status: "processing",
      created: "2026-03-09",
      updated: "2026-03-09",
      frontmatter: { type: "one-shot", title: "My Task", status: "processing" },
      body: "## scope\ndo the thing",
      hasWorkDir: false,
      workDirFiles: [],
      derivedChildren: [],
    })
    const deps = makeDeps()
    const result = await runOuroCli(["task", "show", "my-task"], deps)
    expect(result).toContain("My Task")
    expect(result).toContain("processing")
    expect(result).toContain("one-shot")
    expect(mockTaskModule.getTask).toHaveBeenCalledWith("my-task")
  })

  it("ouro task show formats task with empty body (no trailing body section)", async () => {
    mockTaskModule.getTask.mockReturnValueOnce({
      path: "/mock/tasks/one-shots/2026-03-09-my-task.md",
      name: "2026-03-09-my-task.md",
      stem: "2026-03-09-my-task",
      type: "one-shot",
      collection: "one-shots",
      category: "infrastructure",
      title: "My Task",
      status: "drafting",
      created: "2026-03-09",
      updated: "2026-03-09",
      frontmatter: {},
      body: "",
      hasWorkDir: false,
      workDirFiles: [],
      derivedChildren: [],
    })
    const deps = makeDeps()
    const result = await runOuroCli(["task", "show", "my-task"], deps)
    expect(result).toContain("My Task")
    expect(result).toContain("drafting")
    // Empty body should not produce a trailing newline section
    expect(result).not.toContain("\n\n")
  })

  it("ouro task show returns not-found when task does not exist", async () => {
    mockTaskModule.getTask.mockReturnValueOnce(null)
    const deps = makeDeps()
    const result = await runOuroCli(["task", "show", "nonexistent"], deps)
    expect(result).toContain("not found")
  })

  it("ouro task actionable returns actionable items", async () => {
    mockTaskModule.boardAction.mockReturnValueOnce(["blocked tasks: task-a"])
    const deps = makeDeps()
    const result = await runOuroCli(["task", "actionable"], deps)
    expect(result).toBe("blocked tasks: task-a")
  })

  it("ouro task actionable returns fallback when no action required", async () => {
    mockTaskModule.boardAction.mockReturnValueOnce([])
    const deps = makeDeps()
    const result = await runOuroCli(["task", "actionable"], deps)
    expect(result).toBe("no action required")
  })

  it("ouro task deps returns dependency info", async () => {
    mockTaskModule.boardDeps.mockReturnValueOnce(["task-a -> missing task-z"])
    const deps = makeDeps()
    const result = await runOuroCli(["task", "deps"], deps)
    expect(result).toBe("task-a -> missing task-z")
  })

  it("ouro task deps returns fallback when no dependencies", async () => {
    mockTaskModule.boardDeps.mockReturnValueOnce([])
    const deps = makeDeps()
    const result = await runOuroCli(["task", "deps"], deps)
    expect(result).toBe("no unresolved dependencies")
  })

  it("ouro task sessions returns active sessions", async () => {
    mockTaskModule.boardSessions.mockReturnValueOnce(["task-a"])
    const deps = makeDeps()
    const result = await runOuroCli(["task", "sessions"], deps)
    expect(result).toBe("task-a")
  })

  it("ouro task sessions returns fallback when no sessions", async () => {
    mockTaskModule.boardSessions.mockReturnValueOnce([])
    const deps = makeDeps()
    const result = await runOuroCli(["task", "sessions"], deps)
    expect(result).toBe("no active sessions")
  })

  it("ouro task fix dry-run shows issue summary", async () => {
    mockTaskModule.fix.mockReturnValueOnce({
      applied: [],
      remaining: [
        { target: "one-shots/foo.md", code: "schema-missing-kind", description: "missing kind: task", fix: "add kind: task to frontmatter", confidence: "safe", category: "migration" },
        { target: "orphan.md", code: "org-root-level-doc", description: "root-level orphan doc", fix: "move to collection or remove", confidence: "needs_review", category: "migration" },
      ],
      skipped: [],
      health: "2 migration",
    })

    const deps = makeDeps()
    const result = await runOuroCli(["task", "fix"], deps)
    expect(mockTaskModule.fix).toHaveBeenCalledWith({ mode: "dry-run" })
    expect(result).toContain("schema-missing-kind")
    expect(result).toContain("org-root-level-doc")
    expect(result).toContain("safe fixes")
    expect(result).toContain("needs review")
    expect(result).toContain("2 migration")
  })

  it("ouro task fix dry-run with only safe issues omits review section", async () => {
    mockTaskModule.fix.mockReturnValueOnce({
      applied: [],
      remaining: [
        { target: "one-shots/foo.md", code: "schema-missing-kind", description: "missing kind: task", fix: "add kind: task", confidence: "safe", category: "migration" },
      ],
      skipped: [],
      health: "1 migration",
    })

    const deps = makeDeps()
    const result = await runOuroCli(["task", "fix"], deps)
    expect(result).toContain("safe fixes (1)")
    expect(result).not.toContain("needs review")
    expect(result).toContain("1 migration")
  })

  it("ouro task fix dry-run with only review issues omits safe section", async () => {
    mockTaskModule.fix.mockReturnValueOnce({
      applied: [],
      remaining: [
        { target: "orphan.md", code: "org-root-level-doc", description: "root-level orphan doc", fix: "move to collection", confidence: "needs_review", category: "migration" },
      ],
      skipped: [],
      health: "1 migration",
    })

    const deps = makeDeps()
    const result = await runOuroCli(["task", "fix"], deps)
    expect(result).not.toContain("safe fixes")
    expect(result).toContain("needs review (1)")
    expect(result).toContain("1 migration")
  })

  it("ouro task fix dry-run shows clean when no issues", async () => {
    mockTaskModule.fix.mockReturnValueOnce({
      applied: [],
      remaining: [],
      skipped: [],
      health: "clean",
    })

    const deps = makeDeps()
    const result = await runOuroCli(["task", "fix"], deps)
    expect(result).toContain("clean")
  })

  it("ouro task fix --safe applies safe fixes and shows results", async () => {
    mockTaskModule.fix.mockReturnValueOnce({
      applied: [
        { target: "one-shots/foo.md", code: "schema-missing-kind", description: "missing kind: task", fix: "add kind: task to frontmatter", confidence: "safe", category: "migration" },
      ],
      remaining: [
        { target: "orphan.md", code: "org-root-level-doc", description: "root-level orphan doc", fix: "move to collection or remove", confidence: "needs_review", category: "migration" },
      ],
      skipped: [
        { target: "orphan.md", code: "org-root-level-doc", description: "root-level orphan doc", fix: "move to collection or remove", confidence: "needs_review", category: "migration" },
      ],
      health: "1 migration",
    })

    const deps = makeDeps()
    const result = await runOuroCli(["task", "fix", "--safe"], deps)
    expect(mockTaskModule.fix).toHaveBeenCalledWith({ mode: "safe" })
    expect(result).toContain("1 applied")
    expect(result).toContain("1 remaining")
    expect(result).toContain("1 migration")
  })

  it("ouro task fix --all is alias for --safe", async () => {
    mockTaskModule.fix.mockReturnValueOnce({
      applied: [],
      remaining: [],
      skipped: [],
      health: "clean",
    })

    const deps = makeDeps()
    await runOuroCli(["task", "fix", "--all"], deps)
    expect(mockTaskModule.fix).toHaveBeenCalledWith({ mode: "safe" })
  })

  it("ouro task fix <id> shows issue details", async () => {
    mockTaskModule.fix.mockReturnValueOnce({
      applied: [],
      remaining: [
        { target: "one-shots/foo.md", code: "schema-missing-kind", description: "missing kind: task", fix: "add kind: task to frontmatter", confidence: "safe", category: "migration" },
      ],
      skipped: [],
      health: "1 migration",
    })

    const deps = makeDeps()
    const result = await runOuroCli(["task", "fix", "schema-missing-kind:one-shots/foo.md"], deps)
    expect(mockTaskModule.fix).toHaveBeenCalledWith({ mode: "single", issueId: "schema-missing-kind:one-shots/foo.md" })
    expect(result).toContain("schema-missing-kind")
    expect(result).toContain("one-shots/foo.md")
  })

  it("ouro task fix <id> --option N applies specific option", async () => {
    mockTaskModule.fix.mockReturnValueOnce({
      applied: [
        { target: "one-shots/foo.md", code: "schema-missing-kind", description: "missing kind: task", fix: "add kind: task to frontmatter", confidence: "safe", category: "migration" },
      ],
      remaining: [],
      skipped: [],
      health: "clean",
    })

    const deps = makeDeps()
    const result = await runOuroCli(["task", "fix", "schema-missing-kind:one-shots/foo.md", "--option", "1"], deps)
    expect(mockTaskModule.fix).toHaveBeenCalledWith({ mode: "single", issueId: "schema-missing-kind:one-shots/foo.md", option: 1 })
    expect(result).toContain("1 applied")
    expect(result).toContain("clean")
  })

  it("ouro task fix surfaces fix module exceptions", async () => {
    mockTaskModule.fix.mockImplementationOnce(() => {
      throw new Error("fix failed")
    })

    const deps = makeDeps()
    const result = await runOuroCli(["task", "fix"], deps)
    expect(result).toContain("error: fix failed")
  })
})

describe("ouro reminder CLI execution", () => {
  const mockTaskModule = {
    getBoard: vi.fn(),
    createTask: vi.fn(),
    updateStatus: vi.fn(),
    getTask: vi.fn(),
    boardStatus: vi.fn(),
    boardAction: vi.fn(),
    boardDeps: vi.fn(),
    boardSessions: vi.fn(),
  }

  function makeDeps(overrides?: Partial<OuroCliDeps>): OuroCliDeps {
    return {
      socketPath: "/tmp/ouro-test.sock",
      sendCommand: vi.fn(),
      startDaemonProcess: vi.fn(async () => ({ pid: 1 })),
      writeStdout: vi.fn(),
      checkSocketAlive: vi.fn(async () => true),
      cleanupStaleSocket: vi.fn(),
      fallbackPendingMessage: vi.fn(() => "/tmp/pending.jsonl"),

      taskModule: mockTaskModule as any,
      ...overrides,
    }
  }

  it("ouro reminder create creates a one-shot reminder", async () => {
    mockTaskModule.createTask.mockReturnValueOnce("/mock/tasks/one-shots/2026-03-10-ping-ari.md")
    const deps = makeDeps()
    const result = await runOuroCli(["reminder", "create", "Ping Ari", "--body", "Check daemon status", "--at", "2026-03-10T17:00:00.000Z"], deps)
    expect(result).toContain("created:")
    expect(result).toContain("/mock/tasks/one-shots/2026-03-10-ping-ari.md")
    expect(mockTaskModule.createTask).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Ping Ari",
        type: "one-shot",
        category: "reminder",
        body: "Check daemon status",
        scheduledAt: "2026-03-10T17:00:00.000Z",
      }),
    )
    // Should NOT send to daemon
    expect(deps.sendCommand).not.toHaveBeenCalled()
  })

  it("ouro reminder create creates a recurring habit", async () => {
    mockTaskModule.createTask.mockReturnValueOnce("/mock/tasks/habits/heartbeat.md")
    const deps = makeDeps()
    const result = await runOuroCli(["reminder", "create", "Heartbeat", "--body", "Run heartbeat", "--cadence", "30m"], deps)
    expect(result).toContain("created:")
    expect(mockTaskModule.createTask).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Heartbeat",
        type: "ongoing",
        category: "reminder",
        body: "Run heartbeat",
        cadence: "30m",
      }),
    )
  })

  it("ouro reminder create uses custom category", async () => {
    mockTaskModule.createTask.mockReturnValueOnce("/mock/tasks/habits/ops.md")
    const deps = makeDeps()
    const result = await runOuroCli(["reminder", "create", "Ops check", "--body", "Check ops", "--cadence", "1h", "--category", "operations"], deps)
    expect(result).toContain("created:")
    expect(mockTaskModule.createTask).toHaveBeenCalledWith(
      expect.objectContaining({
        category: "operations",
      }),
    )
  })

  it("ouro reminder create surfaces task module exceptions", async () => {
    mockTaskModule.createTask.mockImplementationOnce(() => {
      throw new Error("scheduler exploded")
    })
    const deps = makeDeps()
    const result = await runOuroCli(["reminder", "create", "Broken", "--body", "This will fail", "--at", "2026-03-10T17:00:00.000Z"], deps)
    expect(result).toContain("error: scheduler exploded")
  })

  it("ouro reminder create passes requester to task module", async () => {
    mockTaskModule.createTask.mockReturnValueOnce("/mock/tasks/one-shots/remind.md")
    const deps = makeDeps()
    await runOuroCli(["reminder", "create", "PR Review", "--body", "Check PR #47", "--at", "2026-03-12T09:00:00.000Z", "--requester", "arimendelow/cli"], deps)
    expect(mockTaskModule.createTask).toHaveBeenCalledWith(
      expect.objectContaining({
        requester: "arimendelow/cli",
      }),
    )
  })

  it("ouro reminder create surfaces non-Error exceptions", async () => {
    mockTaskModule.createTask.mockImplementationOnce(() => {
      throw "scheduler exploded string"
    })
    const deps = makeDeps()
    const result = await runOuroCli(["reminder", "create", "Broken", "--body", "This will fail", "--at", "2026-03-10T17:00:00.000Z"], deps)
    expect(result).toContain("error: scheduler exploded string")
  })
})

describe("ouro friend CLI execution", () => {
  function makeDeps(overrides?: Partial<OuroCliDeps>): OuroCliDeps {
    return {
      socketPath: "/tmp/ouro-test.sock",
      sendCommand: vi.fn(),
      startDaemonProcess: vi.fn(async () => ({ pid: 1 })),
      writeStdout: vi.fn(),
      checkSocketAlive: vi.fn(async () => true),
      cleanupStaleSocket: vi.fn(),
      fallbackPendingMessage: vi.fn(() => "/tmp/pending.jsonl"),

      ...overrides,
    }
  }

  it("ouro friend list returns all friends with summary info", async () => {
    const mockFriendStore = {
      get: vi.fn(),
      put: vi.fn(),
      delete: vi.fn(),
      findByExternalId: vi.fn(),
      listAll: vi.fn(async () => [
        {
          id: "friend-1",
          name: "Ari",
          trustLevel: "family",
          externalIds: [{ provider: "local", externalId: "ari", linkedAt: "2026-03-01T00:00:00.000Z" }],
          tenantMemberships: [],
          toolPreferences: {},
          notes: {},
          totalTokens: 1000,
          createdAt: "2026-03-01T00:00:00.000Z",
          updatedAt: "2026-03-09T12:00:00.000Z",
          schemaVersion: 1,
        },
        {
          id: "friend-2",
          name: "Bob",
          trustLevel: "friend",
          externalIds: [],
          tenantMemberships: [],
          toolPreferences: {},
          notes: {},
          totalTokens: 500,
          createdAt: "2026-03-02T00:00:00.000Z",
          updatedAt: "2026-03-08T12:00:00.000Z",
          schemaVersion: 1,
        },
      ]),
    }
    const deps = makeDeps({ friendStore: mockFriendStore as any })
    const result = await runOuroCli(["friend", "list"], deps)

    expect(result).toContain("Ari")
    expect(result).toContain("friend-1")
    expect(result).toContain("family")
    expect(result).toContain("Bob")
    expect(result).toContain("friend-2")
    expect(result).toContain("friend")
    expect(mockFriendStore.listAll).toHaveBeenCalled()
    expect(deps.sendCommand).not.toHaveBeenCalled()
  })

  it("ouro friend list returns empty message when no friends", async () => {
    const mockFriendStore = {
      get: vi.fn(),
      put: vi.fn(),
      delete: vi.fn(),
      findByExternalId: vi.fn(),
      listAll: vi.fn(async () => []),
    }
    const deps = makeDeps({ friendStore: mockFriendStore as any })
    const result = await runOuroCli(["friend", "list"], deps)

    expect(result).toContain("no friends")
    expect(mockFriendStore.listAll).toHaveBeenCalled()
  })

  it("ouro friend show returns full friend record", async () => {
    const friendRecord = {
      id: "friend-1",
      name: "Ari",
      trustLevel: "family",
      externalIds: [{ provider: "local", externalId: "ari", linkedAt: "2026-03-01T00:00:00.000Z" }],
      tenantMemberships: [],
      toolPreferences: {},
      notes: { role: { value: "engineer", savedAt: "2026-03-01T00:00:00.000Z" } },
      totalTokens: 1000,
      createdAt: "2026-03-01T00:00:00.000Z",
      updatedAt: "2026-03-09T12:00:00.000Z",
      schemaVersion: 1,
    }
    const mockFriendStore = {
      get: vi.fn(async () => friendRecord),
      put: vi.fn(),
      delete: vi.fn(),
      findByExternalId: vi.fn(),
      listAll: vi.fn(),
    }
    const deps = makeDeps({ friendStore: mockFriendStore as any })
    const result = await runOuroCli(["friend", "show", "friend-1"], deps)

    expect(result).toContain("Ari")
    expect(result).toContain("family")
    expect(result).toContain("friend-1")
    expect(mockFriendStore.get).toHaveBeenCalledWith("friend-1")
  })

  it("ouro friend list handles store without listAll method", async () => {
    const mockFriendStore = {
      get: vi.fn(),
      put: vi.fn(),
      delete: vi.fn(),
      findByExternalId: vi.fn(),
      // No listAll method
    }
    const deps = makeDeps({ friendStore: mockFriendStore as any })
    const result = await runOuroCli(["friend", "list"], deps)
    expect(result).toContain("does not support listing")
  })

  it("ouro friend list handles friend records without trustLevel", async () => {
    const mockFriendStore = {
      get: vi.fn(),
      put: vi.fn(),
      delete: vi.fn(),
      findByExternalId: vi.fn(),
      listAll: vi.fn(async () => [
        {
          id: "friend-1",
          name: "NoTrust",
          // trustLevel intentionally missing
          externalIds: [],
          tenantMemberships: [],
          toolPreferences: {},
          notes: {},
          totalTokens: 0,
          createdAt: "2026-03-01T00:00:00.000Z",
          updatedAt: "2026-03-01T00:00:00.000Z",
          schemaVersion: 1,
        },
      ]),
    }
    const deps = makeDeps({ friendStore: mockFriendStore as any })
    const result = await runOuroCli(["friend", "list"], deps)
    expect(result).toContain("unknown")
    expect(result).toContain("NoTrust")
  })

  it("ouro friend show returns not-found when friend does not exist", async () => {
    const mockFriendStore = {
      get: vi.fn(async () => null),
      put: vi.fn(),
      delete: vi.fn(),
      findByExternalId: vi.fn(),
      listAll: vi.fn(),
    }
    const deps = makeDeps({ friendStore: mockFriendStore as any })
    const result = await runOuroCli(["friend", "show", "nonexistent"], deps)

    expect(result).toContain("not found")
    expect(mockFriendStore.get).toHaveBeenCalledWith("nonexistent")
  })

  it("ouro friend link adds externalId and checks for orphans", async () => {
    const targetFriend = {
      id: "friend-1",
      name: "Ari",
      trustLevel: "family",
      externalIds: [{ provider: "local", externalId: "ari", linkedAt: "2026-01-01T00:00:00.000Z" }],
      tenantMemberships: [],
      toolPreferences: {},
      notes: {},
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      schemaVersion: 1,
    }
    const mockFriendStore = {
      get: vi.fn(async (id: string) => id === "friend-1" ? targetFriend : null),
      put: vi.fn(),
      delete: vi.fn(),
      findByExternalId: vi.fn(async () => null),
      listAll: vi.fn(),
    }
    const deps = makeDeps({ friendStore: mockFriendStore as any })
    const result = await runOuroCli([
      "friend", "link", "slugger",
      "--friend", "friend-1",
      "--provider", "imessage-handle",
      "--external-id", "+1234567890",
    ], deps)

    expect(result).toContain("linked")
    expect(mockFriendStore.put).toHaveBeenCalledWith("friend-1", expect.objectContaining({
      externalIds: expect.arrayContaining([
        expect.objectContaining({ provider: "imessage-handle", externalId: "+1234567890" }),
      ]),
    }))
    expect(mockFriendStore.findByExternalId).toHaveBeenCalledWith("imessage-handle", "+1234567890")
  })

  it("ouro friend link merges orphan friend when externalId found on another record", async () => {
    const targetFriend = {
      id: "friend-1",
      name: "Ari",
      trustLevel: "family",
      externalIds: [{ provider: "local", externalId: "ari", linkedAt: "2026-01-01T00:00:00.000Z" }],
      tenantMemberships: [],
      toolPreferences: {},
      notes: { role: { value: "engineer", savedAt: "2026-01-01T00:00:00.000Z" } },
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      schemaVersion: 1,
    }
    const orphanFriend = {
      id: "orphan-1",
      name: "Unknown +1234567890",
      trustLevel: "stranger",
      externalIds: [
        { provider: "imessage-handle", externalId: "+1234567890", linkedAt: "2026-02-01T00:00:00.000Z" },
        { provider: "imessage-handle", externalId: "+0987654321", linkedAt: "2026-02-01T00:00:00.000Z" },
      ],
      tenantMemberships: [],
      toolPreferences: {},
      notes: { phone: { value: "+1234567890", savedAt: "2026-02-01T00:00:00.000Z" } },
      createdAt: "2026-02-01T00:00:00.000Z",
      updatedAt: "2026-02-01T00:00:00.000Z",
      schemaVersion: 1,
    }
    const mockFriendStore = {
      get: vi.fn(async (id: string) => id === "friend-1" ? targetFriend : null),
      put: vi.fn(),
      delete: vi.fn(),
      findByExternalId: vi.fn(async () => orphanFriend),
      listAll: vi.fn(),
    }
    const deps = makeDeps({ friendStore: mockFriendStore as any })
    const result = await runOuroCli([
      "friend", "link", "slugger",
      "--friend", "friend-1",
      "--provider", "imessage-handle",
      "--external-id", "+1234567890",
    ], deps)

    expect(result).toContain("linked")
    expect(result).toContain("merged")
    // Orphan should be deleted
    expect(mockFriendStore.delete).toHaveBeenCalledWith("orphan-1")
    // Target should get orphan's extra externalIds and notes merged
    const putCall = mockFriendStore.put.mock.calls[0]
    const savedRecord = putCall[1]
    // Should have original + new + orphan's other externalId
    expect(savedRecord.externalIds).toEqual(expect.arrayContaining([
      expect.objectContaining({ provider: "imessage-handle", externalId: "+0987654321" }),
      expect.objectContaining({ provider: "imessage-handle", externalId: "+1234567890" }),
    ]))
    // Notes should be merged
    expect(savedRecord.notes.phone).toBeDefined()
    expect(savedRecord.notes.role).toBeDefined()
    // Trust level should keep the higher one (family > stranger)
    expect(savedRecord.trustLevel).toBe("family")
  })

  it("ouro friend link handles undefined trust levels when merging", async () => {
    const targetFriend = {
      id: "friend-1",
      name: "Ari",
      // trustLevel intentionally omitted
      externalIds: [{ provider: "local" as const, externalId: "ari", linkedAt: "2026-01-01T00:00:00.000Z" }],
      tenantMemberships: [],
      toolPreferences: {},
      notes: {},
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      schemaVersion: 1,
    }
    const orphanFriend = {
      id: "orphan-1",
      name: "Unknown",
      // trustLevel intentionally omitted
      externalIds: [{ provider: "imessage-handle" as const, externalId: "+111", linkedAt: "2026-02-01T00:00:00.000Z" }],
      tenantMemberships: [],
      toolPreferences: {},
      notes: {},
      createdAt: "2026-02-01T00:00:00.000Z",
      updatedAt: "2026-02-01T00:00:00.000Z",
      schemaVersion: 1,
    }
    const mockFriendStore = {
      get: vi.fn(async (id: string) => id === "friend-1" ? targetFriend : null),
      put: vi.fn(),
      delete: vi.fn(),
      findByExternalId: vi.fn(async () => orphanFriend),
      listAll: vi.fn(),
    }
    const deps = makeDeps({ friendStore: mockFriendStore as any })
    await runOuroCli([
      "friend", "link", "slugger",
      "--friend", "friend-1",
      "--provider", "imessage-handle",
      "--external-id", "+111",
    ], deps)

    const putCall = mockFriendStore.put.mock.calls[0]
    expect(putCall[1].trustLevel).toBe("stranger")
  })

  it("ouro friend link keeps orphan's higher trust when merging", async () => {
    const targetFriend = {
      id: "friend-1",
      name: "Ari",
      trustLevel: "acquaintance" as const,
      externalIds: [{ provider: "local" as const, externalId: "ari", linkedAt: "2026-01-01T00:00:00.000Z" }],
      tenantMemberships: [],
      toolPreferences: {},
      notes: {},
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      schemaVersion: 1,
    }
    const orphanFriend = {
      id: "orphan-1",
      name: "Unknown",
      trustLevel: "family" as const,
      externalIds: [{ provider: "imessage-handle" as const, externalId: "+1234567890", linkedAt: "2026-02-01T00:00:00.000Z" }],
      tenantMemberships: [],
      toolPreferences: {},
      notes: {},
      createdAt: "2026-02-01T00:00:00.000Z",
      updatedAt: "2026-02-01T00:00:00.000Z",
      schemaVersion: 1,
    }
    const mockFriendStore = {
      get: vi.fn(async (id: string) => id === "friend-1" ? targetFriend : null),
      put: vi.fn(),
      delete: vi.fn(),
      findByExternalId: vi.fn(async () => orphanFriend),
      listAll: vi.fn(),
    }
    const deps = makeDeps({ friendStore: mockFriendStore as any })
    await runOuroCli([
      "friend", "link", "slugger",
      "--friend", "friend-1",
      "--provider", "imessage-handle",
      "--external-id", "+1234567890",
    ], deps)

    const putCall = mockFriendStore.put.mock.calls[0]
    const savedRecord = putCall[1]
    // Orphan had family (higher than acquaintance), so merged record should be family
    expect(savedRecord.trustLevel).toBe("family")
  })

  it("ouro friend unlink removes matching externalId", async () => {
    const targetFriend = {
      id: "friend-1",
      name: "Ari",
      trustLevel: "family",
      externalIds: [
        { provider: "local", externalId: "ari", linkedAt: "2026-01-01T00:00:00.000Z" },
        { provider: "imessage-handle", externalId: "+1234567890", linkedAt: "2026-02-01T00:00:00.000Z" },
      ],
      tenantMemberships: [],
      toolPreferences: {},
      notes: {},
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      schemaVersion: 1,
    }
    const mockFriendStore = {
      get: vi.fn(async () => targetFriend),
      put: vi.fn(),
      delete: vi.fn(),
      findByExternalId: vi.fn(),
      listAll: vi.fn(),
    }
    const deps = makeDeps({ friendStore: mockFriendStore as any })
    const result = await runOuroCli([
      "friend", "unlink", "slugger",
      "--friend", "friend-1",
      "--provider", "imessage-handle",
      "--external-id", "+1234567890",
    ], deps)

    expect(result).toContain("unlinked")
    expect(mockFriendStore.put).toHaveBeenCalledWith("friend-1", expect.objectContaining({
      externalIds: [
        expect.objectContaining({ provider: "local", externalId: "ari" }),
      ],
    }))
  })

  it("ouro friend unlink returns not-found when friend does not exist", async () => {
    const mockFriendStore = {
      get: vi.fn(async () => null),
      put: vi.fn(),
      delete: vi.fn(),
      findByExternalId: vi.fn(),
      listAll: vi.fn(),
    }
    const deps = makeDeps({ friendStore: mockFriendStore as any })
    const result = await runOuroCli([
      "friend", "unlink", "slugger",
      "--friend", "friend-1",
      "--provider", "imessage-handle",
      "--external-id", "+1234567890",
    ], deps)

    expect(result).toContain("not found")
  })

  it("ouro friend unlink returns message when externalId not found on friend", async () => {
    const targetFriend = {
      id: "friend-1",
      name: "Ari",
      trustLevel: "family",
      externalIds: [{ provider: "local", externalId: "ari", linkedAt: "2026-01-01T00:00:00.000Z" }],
      tenantMemberships: [],
      toolPreferences: {},
      notes: {},
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      schemaVersion: 1,
    }
    const mockFriendStore = {
      get: vi.fn(async () => targetFriend),
      put: vi.fn(),
      delete: vi.fn(),
      findByExternalId: vi.fn(),
      listAll: vi.fn(),
    }
    const deps = makeDeps({ friendStore: mockFriendStore as any })
    const result = await runOuroCli([
      "friend", "unlink", "slugger",
      "--friend", "friend-1",
      "--provider", "imessage-handle",
      "--external-id", "+1234567890",
    ], deps)

    expect(result).toContain("not linked")
    expect(mockFriendStore.put).not.toHaveBeenCalled()
  })
})

describe("ouro whoami and session list CLI execution", () => {
  function makeDeps(overrides?: Partial<OuroCliDeps>): OuroCliDeps {
    return {
      socketPath: "/tmp/ouro-test.sock",
      sendCommand: vi.fn(),
      startDaemonProcess: vi.fn(async () => ({ pid: 1 })),
      writeStdout: vi.fn(),
      checkSocketAlive: vi.fn(async () => true),
      cleanupStaleSocket: vi.fn(),
      fallbackPendingMessage: vi.fn(() => "/tmp/pending.jsonl"),

      ...overrides,
    }
  }

  it("ouro whoami returns agent identity info", async () => {
    const deps = makeDeps({
      whoamiInfo: vi.fn(() => ({
        agentName: "slugger",
        homePath: "/Users/ari/AgentBundles/slugger.ouro",
        bonesVersion: "0.1.0-alpha.31",
      })),
    })
    const result = await runOuroCli(["whoami"], deps)

    expect(result).toContain("slugger")
    expect(result).toContain("/Users/ari/AgentBundles/slugger.ouro")
    expect(result).toContain("0.1.0-alpha.31")
    expect(deps.sendCommand).not.toHaveBeenCalled()
  })

  it("ouro session list returns sessions from scanner", async () => {
    const deps = makeDeps({
      scanSessions: vi.fn(async () => [
        { friendId: "friend-1", friendName: "Ari", channel: "cli", lastActivity: "2026-03-09T12:00:00.000Z" },
        { friendId: "self", friendName: "self", channel: "inner", lastActivity: "2026-03-09T11:00:00.000Z" },
      ]),
    })
    const result = await runOuroCli(["session", "list"], deps)

    expect(result).toContain("friend-1")
    expect(result).toContain("Ari")
    expect(result).toContain("cli")
    expect(result).toContain("self")
    expect(result).toContain("inner")
    expect(deps.sendCommand).not.toHaveBeenCalled()
  })

  it("ouro session list returns empty message when no sessions", async () => {
    const deps = makeDeps({
      scanSessions: vi.fn(async () => []),
    })
    const result = await runOuroCli(["session", "list"], deps)

    expect(result).toContain("no active sessions")
  })

  it("default deps provide a real session scanner", () => {
    const deps = createDefaultOuroCliDeps("/tmp/ouro-test.sock")
    expect(deps.scanSessions).toEqual(expect.any(Function))
  })

  it("default deps session scanner uses the shared session-activity helper", async () => {
    const getAgentNameSpy = vi.spyOn(identity, "getAgentName").mockReturnValue("slugger")
    const getAgentRootSpy = vi.spyOn(identity, "getAgentRoot").mockReturnValue("/tmp/AgentBundles/slugger.ouro")
    const listSpy = vi.spyOn(sessionActivity, "listSessionActivity").mockReturnValue([
      {
        friendId: "friend-1",
        friendName: "Ari",
        channel: "bluebubbles",
        key: "chat_any;-;ari@mendelow.me",
        sessionPath: "/tmp/AgentBundles/slugger.ouro/state/sessions/friend-1/bluebubbles/chat_any;-;ari@mendelow.me.json",
        lastActivityAt: "2026-03-14T16:00:00.000Z",
        lastActivityMs: 123,
        activitySource: "friend-facing",
      },
    ])

    const deps = createDefaultOuroCliDeps("/tmp/ouro-test.sock")
    const result = await deps.scanSessions?.()

    expect(listSpy).toHaveBeenCalledWith({
      sessionsDir: "/tmp/AgentBundles/slugger.ouro/state/sessions",
      friendsDir: "/tmp/AgentBundles/slugger.ouro/friends",
      agentName: "slugger",
    })
    expect(result).toEqual([
      {
        friendId: "friend-1",
        friendName: "Ari",
        channel: "bluebubbles",
        lastActivity: "2026-03-14T16:00:00.000Z",
      },
    ])

    listSpy.mockRestore()
    getAgentRootSpy.mockRestore()
    getAgentNameSpy.mockRestore()
  })
})

describe("--agent flag parsing for identity-dependent commands", () => {
  it("parses whoami with --agent flag", () => {
    expect(parseOuroCommand(["whoami", "--agent", "slugger"])).toEqual({
      kind: "whoami",
      agent: "slugger",
    })
  })

  it("parses whoami without --agent flag (no agent field)", () => {
    const result = parseOuroCommand(["whoami"])
    expect(result).toEqual({ kind: "whoami" })
    expect((result as any).agent).toBeUndefined()
  })

  it("parses friend list with --agent flag", () => {
    expect(parseOuroCommand(["friend", "list", "--agent", "slugger"])).toEqual({
      kind: "friend.list",
      agent: "slugger",
    })
  })

  it("parses friend show with --agent flag", () => {
    expect(parseOuroCommand(["friend", "show", "abc-123", "--agent", "slugger"])).toEqual({
      kind: "friend.show",
      friendId: "abc-123",
      agent: "slugger",
    })
  })

  it("parses task board with --agent flag", () => {
    expect(parseOuroCommand(["task", "board", "--agent", "slugger"])).toEqual({
      kind: "task.board",
      agent: "slugger",
    })
  })

  it("parses task board with status and --agent flag", () => {
    expect(parseOuroCommand(["task", "board", "processing", "--agent", "slugger"])).toEqual({
      kind: "task.board",
      status: "processing",
      agent: "slugger",
    })
  })

  it("parses task create with --agent flag", () => {
    expect(parseOuroCommand(["task", "create", "My Task", "--agent", "slugger"])).toEqual({
      kind: "task.create",
      title: "My Task",
      agent: "slugger",
    })
  })

  it("parses task update with --agent flag", () => {
    expect(parseOuroCommand(["task", "update", "task-123", "in-progress", "--agent", "slugger"])).toEqual({
      kind: "task.update",
      id: "task-123",
      status: "in-progress",
      agent: "slugger",
    })
  })

  it("parses task show with --agent flag", () => {
    expect(parseOuroCommand(["task", "show", "task-123", "--agent", "slugger"])).toEqual({
      kind: "task.show",
      id: "task-123",
      agent: "slugger",
    })
  })

  it("parses task actionable with --agent flag", () => {
    expect(parseOuroCommand(["task", "actionable", "--agent", "slugger"])).toEqual({
      kind: "task.actionable",
      agent: "slugger",
    })
  })

  it("parses task deps with --agent flag", () => {
    expect(parseOuroCommand(["task", "deps", "--agent", "slugger"])).toEqual({
      kind: "task.deps",
      agent: "slugger",
    })
  })

  it("parses task sessions with --agent flag", () => {
    expect(parseOuroCommand(["task", "sessions", "--agent", "slugger"])).toEqual({
      kind: "task.sessions",
      agent: "slugger",
    })
  })

  it("parses session list with --agent flag", () => {
    expect(parseOuroCommand(["session", "list", "--agent", "slugger"])).toEqual({
      kind: "session.list",
      agent: "slugger",
    })
  })

  it("parses friend create with --agent flag", () => {
    expect(parseOuroCommand(["friend", "create", "--name", "Bob", "--trust", "friend", "--agent", "slugger"])).toEqual({
      kind: "friend.create",
      name: "Bob",
      trustLevel: "friend",
      agent: "slugger",
    })
  })

  it("parses friend create without --trust (defaults to acquaintance)", () => {
    expect(parseOuroCommand(["friend", "create", "--name", "Charlie", "--agent", "slugger"])).toEqual({
      kind: "friend.create",
      name: "Charlie",
      agent: "slugger",
    })
  })

  it("parses task create with both --type and --agent flags", () => {
    expect(parseOuroCommand(["task", "create", "My Task", "--type", "feature", "--agent", "slugger"])).toEqual({
      kind: "task.create",
      title: "My Task",
      type: "feature",
      agent: "slugger",
    })
  })

  it("parses friend create without --agent flag", () => {
    expect(parseOuroCommand(["friend", "create", "--name", "Dave"])).toEqual({
      kind: "friend.create",
      name: "Dave",
    })
  })

  it("parses friend create with --trust but no value (ignores incomplete flag)", () => {
    expect(parseOuroCommand(["friend", "create", "--name", "Eve", "--trust"])).toEqual({
      kind: "friend.create",
      name: "Eve",
    })
  })

  it("rejects friend create without --name", () => {
    expect(() => parseOuroCommand(["friend", "create", "--agent", "slugger"])).toThrow("Usage")
  })
})

describe("--agent flag CLI execution", () => {
  function makeDeps(overrides?: Partial<OuroCliDeps>): OuroCliDeps {
    return {
      socketPath: "/tmp/ouro-test.sock",
      sendCommand: vi.fn(),
      startDaemonProcess: vi.fn(async () => ({ pid: 1 })),
      writeStdout: vi.fn(),
      checkSocketAlive: vi.fn(async () => true),
      cleanupStaleSocket: vi.fn(),
      fallbackPendingMessage: vi.fn(() => "/tmp/pending.jsonl"),

      ...overrides,
    }
  }

  it("whoami with --agent uses agent root instead of runtime identity", async () => {
    const deps = makeDeps()
    const result = await runOuroCli(["whoami", "--agent", "slugger"], deps)

    expect(result).toContain("agent: slugger")
    expect(result).toContain("slugger.ouro")
    expect(deps.sendCommand).not.toHaveBeenCalled()
  })

  it("whoami without --agent and without runtime context returns error", async () => {
    // No whoamiInfo dep and no --agent flag; getAgentName() would throw in production
    // but we test that the command gracefully handles no agent context
    const deps = makeDeps({
      whoamiInfo: vi.fn(() => { throw new Error("no agent context") }),
    })
    const result = await runOuroCli(["whoami"], deps)

    expect(result).toContain("error")
    expect(result.toLowerCase()).toMatch(/no agent|--agent/)
  })

  it("friend list with --agent creates store for correct agent dir", async () => {
    const mockFriendStore = {
      get: vi.fn(),
      put: vi.fn(),
      delete: vi.fn(),
      findByExternalId: vi.fn(),
      listAll: vi.fn(async () => [
        {
          id: "friend-1",
          name: "Ari",
          trustLevel: "family",
          externalIds: [],
          tenantMemberships: [],
          toolPreferences: {},
          notes: {},
          totalTokens: 1000,
          createdAt: "2026-03-01T00:00:00.000Z",
          updatedAt: "2026-03-09T12:00:00.000Z",
          schemaVersion: 1,
        },
      ]),
    }
    const deps = makeDeps({ friendStore: mockFriendStore as any })
    const result = await runOuroCli(["friend", "list", "--agent", "slugger"], deps)

    expect(result).toContain("Ari")
    expect(result).toContain("friend-1")
  })

  it("task board with --agent uses agent-scoped task module", async () => {
    const taskMod = {
      getBoard: vi.fn(() => ({ full: "task board output", compact: "compact" })),
      boardStatus: vi.fn(),
      boardAction: vi.fn(),
      boardDeps: vi.fn(),
      boardSessions: vi.fn(),
      createTask: vi.fn(),
      updateStatus: vi.fn(),
      getTask: vi.fn(),
    }
    const deps = makeDeps({ taskModule: taskMod as any })
    const result = await runOuroCli(["task", "board", "--agent", "slugger"], deps)

    expect(result).toContain("task board output")
  })

  it("session list with --agent uses agent-scoped session scanner", async () => {
    const deps = makeDeps({
      scanSessions: vi.fn(async () => [
        { friendId: "friend-1", friendName: "Ari", channel: "cli", lastActivity: "2026-03-09T12:00:00.000Z" },
      ]),
    })
    const result = await runOuroCli(["session", "list", "--agent", "slugger"], deps)

    expect(result).toContain("friend-1")
    expect(result).toContain("Ari")
  })

  it("friend create creates a new friend record", async () => {
    const mockFriendStore = {
      get: vi.fn(),
      put: vi.fn(),
      delete: vi.fn(),
      findByExternalId: vi.fn(),
      listAll: vi.fn(),
    }
    const deps = makeDeps({ friendStore: mockFriendStore as any })
    const result = await runOuroCli(["friend", "create", "--name", "Bob", "--trust", "friend", "--agent", "slugger"], deps)

    expect(result).toContain("created")
    expect(result).toContain("Bob")
    expect(mockFriendStore.put).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        name: "Bob",
        trustLevel: "friend",
      }),
    )
  })

  it("friend create defaults trust to acquaintance when --trust omitted", async () => {
    const mockFriendStore = {
      get: vi.fn(),
      put: vi.fn(),
      delete: vi.fn(),
      findByExternalId: vi.fn(),
      listAll: vi.fn(),
    }
    const deps = makeDeps({ friendStore: mockFriendStore as any })
    const result = await runOuroCli(["friend", "create", "--name", "Charlie", "--agent", "slugger"], deps)

    expect(result).toContain("created")
    expect(mockFriendStore.put).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        name: "Charlie",
        trustLevel: "acquaintance",
      }),
    )
  })

  it("friend show with --agent uses correct agent-scoped store", async () => {
    const friendRecord = {
      id: "friend-1",
      name: "Ari",
      trustLevel: "family",
      externalIds: [],
      tenantMemberships: [],
      toolPreferences: {},
      notes: {},
      totalTokens: 1000,
      createdAt: "2026-03-01T00:00:00.000Z",
      updatedAt: "2026-03-09T12:00:00.000Z",
      schemaVersion: 1,
    }
    const mockFriendStore = {
      get: vi.fn(async () => friendRecord),
      put: vi.fn(),
      delete: vi.fn(),
      findByExternalId: vi.fn(),
      listAll: vi.fn(),
    }
    const deps = makeDeps({ friendStore: mockFriendStore as any })
    const result = await runOuroCli(["friend", "show", "friend-1", "--agent", "slugger"], deps)

    expect(result).toContain("Ari")
    expect(mockFriendStore.get).toHaveBeenCalledWith("friend-1")
  })
})

describe("ouro thoughts CLI execution", () => {
  function makeDeps(overrides?: Partial<OuroCliDeps>): OuroCliDeps {
    return {
      socketPath: "/tmp/ouro-test.sock",
      sendCommand: vi.fn(),
      startDaemonProcess: vi.fn(async () => ({ pid: 1 })),
      writeStdout: vi.fn(),
      checkSocketAlive: vi.fn(async () => true),
      cleanupStaleSocket: vi.fn(),
      fallbackPendingMessage: vi.fn(() => "/tmp/pending.jsonl"),

      ...overrides,
    }
  }

  const testAgentName = `thoughts-test-${Date.now()}`
  const agentBundlesRoot = path.join(os.homedir(), "AgentBundles")
  const testAgentRoot = path.join(agentBundlesRoot, `${testAgentName}.ouro`)
  const sessionDir = path.join(testAgentRoot, "state", "sessions", "self", "inner")
  const sessionFile = path.join(sessionDir, "dialog.json")

  function writeSessionFile(messages: unknown[]): void {
    fs.mkdirSync(sessionDir, { recursive: true })
    fs.writeFileSync(sessionFile, JSON.stringify({ version: 1, messages }))
  }

  afterAll(() => {
    fs.rmSync(testAgentRoot, { recursive: true, force: true })
  })

  it("returns formatted thoughts with --agent", async () => {
    writeSessionFile([
      { role: "system", content: "system prompt" },
      { role: "user", content: "waking up.\n\nwhat needs my attention?" },
      { role: "assistant", content: "checking in. all looks good." },
    ])
    const deps = makeDeps()
    const result = await runOuroCli(["thoughts", "--agent", testAgentName], deps)

    expect(result).toContain("boot")
    expect(result).toContain("checking in. all looks good.")
    expect(deps.writeStdout).toHaveBeenCalled()
  })

  it("returns raw JSON with --json flag", async () => {
    writeSessionFile([
      { role: "system", content: "system prompt" },
      { role: "user", content: "waking up.\n\nwhat needs my attention?" },
      { role: "assistant", content: "hello from inner dialog." },
    ])
    const deps = makeDeps()
    const result = await runOuroCli(["thoughts", "--agent", testAgentName, "--json"], deps)

    expect(result).toContain("\"version\":1")
    expect(result).toContain("hello from inner dialog.")
  })

  it("limits turns with --last flag", async () => {
    writeSessionFile([
      { role: "system", content: "system prompt" },
      { role: "user", content: "waking up.\n\nwhat needs my attention?" },
      { role: "assistant", content: "first response." },
      { role: "user", content: "...time passing. anything stirring?" },
      { role: "assistant", content: "second response." },
      { role: "user", content: "...time passing. anything stirring?" },
      { role: "assistant", content: "third response." },
    ])
    const deps = makeDeps()
    const result = await runOuroCli(["thoughts", "--agent", testAgentName, "--last", "1"], deps)

    expect(result).toContain("third response.")
    expect(result).not.toContain("first response.")
    expect(result).not.toContain("second response.")
  })

  it("returns no-activity message for nonexistent agent", async () => {
    const deps = makeDeps()
    const result = await runOuroCli(["thoughts", "--agent", "nonexistent-agent-xyzzy"], deps)

    expect(result).toContain("no inner dialog activity")
  })

  it("returns no-session message for --json with nonexistent agent", async () => {
    const deps = makeDeps()
    const result = await runOuroCli(["thoughts", "--agent", "nonexistent-agent-xyzzy", "--json"], deps)

    expect(result).toContain("no inner dialog session found")
  })

  it("returns error message when no --agent and no agent context", async () => {
    const deps = makeDeps()
    const result = await runOuroCli(["thoughts"], deps)

    expect(result).toContain("error")
    expect(result).toContain("--agent")
  })

  it("enters follow mode and resolves on SIGINT", async () => {
    writeSessionFile([
      { role: "system", content: "system prompt" },
      { role: "user", content: "waking up.\n\nwhat needs my attention?" },
      { role: "assistant", content: "checking in." },
    ])
    const deps = makeDeps()

    // Schedule SIGINT to fire shortly after follow mode starts
    const timer = setTimeout(() => process.emit("SIGINT", "SIGINT"), 50)

    const result = await runOuroCli(["thoughts", "--agent", testAgentName, "--follow"], deps)
    clearTimeout(timer)

    // Should have printed follow banner
    const calls = (deps.writeStdout as ReturnType<typeof vi.fn>).mock.calls.map((c: unknown[]) => c[0])
    expect(calls.some((c: string) => c.includes("following"))).toBe(true)
    expect(result).toContain("boot")
  })
})

describe("ouro changelog command", () => {
  it("parseOuroCommand parses changelog", () => {
    const cmd = parseOuroCommand(["changelog"])
    expect(cmd).toEqual({ kind: "changelog" })
  })

  it("parseOuroCommand parses changelog --from version", () => {
    const cmd = parseOuroCommand(["changelog", "--from", "0.1.0"])
    expect(cmd).toEqual({ kind: "changelog", from: "0.1.0" })
  })

  it("parseOuroCommand parses changelog with --agent flag", () => {
    const cmd = parseOuroCommand(["changelog", "--agent", "slugger"])
    expect(cmd).toEqual({ kind: "changelog", agent: "slugger" })
  })

  it("parseOuroCommand parses changelog --from with --agent flag", () => {
    const cmd = parseOuroCommand(["changelog", "--from", "0.2.0", "--agent", "slugger"])
    expect(cmd).toEqual({ kind: "changelog", from: "0.2.0", agent: "slugger" })
  })

  it("runOuroCli changelog reads changelog.json and returns formatted output", async () => {
    const changelogData = [
      { version: "0.3.0", date: "2026-03-18", changes: ["added guardrails", "added changelog command"] },
      { version: "0.2.0", date: "2026-03-10", changes: ["trust levels"] },
      { version: "0.1.0", date: "2026-03-01", changes: ["initial release"] },
    ]
    const tmpFile = path.join(os.tmpdir(), `changelog-test-${Date.now()}.json`)
    fs.writeFileSync(tmpFile, JSON.stringify(changelogData))

    const deps: OuroCliDeps = {
      socketPath: "/tmp/test.sock",
      sendCommand: vi.fn(),
      startDaemonProcess: vi.fn(),
      writeStdout: vi.fn(),
      checkSocketAlive: vi.fn(),
      cleanupStaleSocket: vi.fn(),
      fallbackPendingMessage: vi.fn(),
      installSubagents: vi.fn(),
      getChangelogPath: () => tmpFile,
    }

    try {
      const result = await runOuroCli(["changelog"], deps)
      expect(result).toContain("0.3.0")
      expect(result).toContain("0.2.0")
      expect(result).toContain("guardrails")
    } finally {
      fs.unlinkSync(tmpFile)
    }
  })

  it("runOuroCli changelog --from filters entries", async () => {
    const changelogData = [
      { version: "0.3.0", date: "2026-03-18", changes: ["added guardrails"] },
      { version: "0.2.0", date: "2026-03-10", changes: ["trust levels"] },
      { version: "0.1.0", date: "2026-03-01", changes: ["initial release"] },
    ]
    const tmpFile = path.join(os.tmpdir(), `changelog-from-${Date.now()}.json`)
    fs.writeFileSync(tmpFile, JSON.stringify(changelogData))

    const deps: OuroCliDeps = {
      socketPath: "/tmp/test.sock",
      sendCommand: vi.fn(),
      startDaemonProcess: vi.fn(),
      writeStdout: vi.fn(),
      checkSocketAlive: vi.fn(),
      cleanupStaleSocket: vi.fn(),
      fallbackPendingMessage: vi.fn(),
      installSubagents: vi.fn(),
      getChangelogPath: () => tmpFile,
    }

    try {
      const result = await runOuroCli(["changelog", "--from", "0.2.0"], deps)
      expect(result).toContain("0.3.0")
      expect(result).not.toContain("0.1.0")
    } finally {
      fs.unlinkSync(tmpFile)
    }
  })

  it("runOuroCli changelog --from filters object-shaped changelog entries", async () => {
    const changelogData = {
      versions: [
        { version: "0.1.0-alpha.90", changes: ["latest fix"] },
        { version: "0.1.0-alpha.89", changes: ["previous fix"] },
        { version: "0.1.0-alpha.88", changes: ["baseline fix"] },
      ],
    }
    const tmpFile = path.join(os.tmpdir(), `changelog-object-${Date.now()}.json`)
    fs.writeFileSync(tmpFile, JSON.stringify(changelogData))

    const deps: OuroCliDeps = {
      socketPath: "/tmp/test.sock",
      sendCommand: vi.fn(),
      startDaemonProcess: vi.fn(),
      writeStdout: vi.fn(),
      checkSocketAlive: vi.fn(),
      cleanupStaleSocket: vi.fn(),
      fallbackPendingMessage: vi.fn(),
      installSubagents: vi.fn(),
      getChangelogPath: () => tmpFile,
    }

    try {
      const result = await runOuroCli(["changelog", "--from", "0.1.0-alpha.88"], deps)
      expect(result).toContain("0.1.0-alpha.90")
      expect(result).toContain("0.1.0-alpha.89")
      expect(result).not.toContain("0.1.0-alpha.88")
    } finally {
      fs.unlinkSync(tmpFile)
    }
  })

  it("runOuroCli changelog returns empty message for object-shaped changelog without versions", async () => {
    const changelogData = { note: "missing versions array" }
    const tmpFile = path.join(os.tmpdir(), `changelog-object-empty-${Date.now()}.json`)
    fs.writeFileSync(tmpFile, JSON.stringify(changelogData))

    const deps: OuroCliDeps = {
      socketPath: "/tmp/test.sock",
      sendCommand: vi.fn(),
      startDaemonProcess: vi.fn(),
      writeStdout: vi.fn(),
      checkSocketAlive: vi.fn(),
      cleanupStaleSocket: vi.fn(),
      fallbackPendingMessage: vi.fn(),
      installSubagents: vi.fn(),
      getChangelogPath: () => tmpFile,
    }

    try {
      const result = await runOuroCli(["changelog"], deps)
      expect(result).toContain("no changelog entries found")
    } finally {
      fs.unlinkSync(tmpFile)
    }
  })

  it("runOuroCli changelog --from with no matching entries returns empty message", async () => {
    const changelogData = [
      { version: "0.1.0", date: "2026-03-01", changes: ["initial release"] },
    ]
    const tmpFile = path.join(os.tmpdir(), `changelog-empty-${Date.now()}.json`)
    fs.writeFileSync(tmpFile, JSON.stringify(changelogData))

    const deps: OuroCliDeps = {
      socketPath: "/tmp/test.sock",
      sendCommand: vi.fn(),
      startDaemonProcess: vi.fn(),
      writeStdout: vi.fn(),
      checkSocketAlive: vi.fn(),
      cleanupStaleSocket: vi.fn(),
      fallbackPendingMessage: vi.fn(),
      installSubagents: vi.fn(),
      getChangelogPath: () => tmpFile,
    }

    try {
      const result = await runOuroCli(["changelog", "--from", "9.9.9"], deps)
      expect(result).toContain("no changelog entries found")
    } finally {
      fs.unlinkSync(tmpFile)
    }
  })

  it("runOuroCli changelog with entries that have no date or changes", async () => {
    const changelogData = [
      { version: "0.1.0" },
    ]
    const tmpFile = path.join(os.tmpdir(), `changelog-minimal-${Date.now()}.json`)
    fs.writeFileSync(tmpFile, JSON.stringify(changelogData))

    const deps: OuroCliDeps = {
      socketPath: "/tmp/test.sock",
      sendCommand: vi.fn(),
      startDaemonProcess: vi.fn(),
      writeStdout: vi.fn(),
      checkSocketAlive: vi.fn(),
      cleanupStaleSocket: vi.fn(),
      fallbackPendingMessage: vi.fn(),
      installSubagents: vi.fn(),
      getChangelogPath: () => tmpFile,
    }

    try {
      const result = await runOuroCli(["changelog"], deps)
      expect(result).toContain("0.1.0")
      // No date or changes, so output should be minimal
      expect(result).not.toContain("(")
    } finally {
      fs.unlinkSync(tmpFile)
    }
  })

  it("runOuroCli changelog returns message when changelog file missing", async () => {
    const deps: OuroCliDeps = {
      socketPath: "/tmp/test.sock",
      sendCommand: vi.fn(),
      startDaemonProcess: vi.fn(),
      writeStdout: vi.fn(),
      checkSocketAlive: vi.fn(),
      cleanupStaleSocket: vi.fn(),
      fallbackPendingMessage: vi.fn(),
      installSubagents: vi.fn(),
      getChangelogPath: () => "/nonexistent/changelog.json",
    }

    const result = await runOuroCli(["changelog"], deps)
    expect(result).toContain("no changelog entries found")
  })

  it("runOuroCli changelog falls back to module getChangelogPath when deps.getChangelogPath is undefined", async () => {
    const deps: OuroCliDeps = {
      socketPath: "/tmp/test.sock",
      sendCommand: vi.fn(),
      startDaemonProcess: vi.fn(),
      writeStdout: vi.fn(),
      checkSocketAlive: vi.fn(),
      cleanupStaleSocket: vi.fn(),
      fallbackPendingMessage: vi.fn(),
      installSubagents: vi.fn(),
    }

    // Without getChangelogPath in deps, it falls back to the module-level getChangelogPath
    // which resolves to the real changelog.json in the repo
    const result = await runOuroCli(["changelog"], deps)
    // Should either show entries or "no changelog entries found" — either way it shouldn't throw
    expect(typeof result).toBe("string")
  })
})

describe("ouro friend update", () => {
  it("parses friend update command", () => {
    expect(parseOuroCommand(["friend", "update", "friend-123", "--trust", "family", "--agent", "slugger"])).toEqual({
      kind: "friend.update",
      friendId: "friend-123",
      trustLevel: "family",
      agent: "slugger",
    })
  })

  it("parses friend update without --agent", () => {
    expect(parseOuroCommand(["friend", "update", "friend-123", "--trust", "acquaintance"])).toEqual({
      kind: "friend.update",
      friendId: "friend-123",
      trustLevel: "acquaintance",
    })
  })

  it("rejects friend update without id", () => {
    expect(() => parseOuroCommand(["friend", "update"])).toThrow("Usage")
  })

  it("rejects friend update without --trust", () => {
    expect(() => parseOuroCommand(["friend", "update", "friend-123"])).toThrow("Usage")
  })

  it("rejects friend update with invalid trust level", () => {
    expect(() => parseOuroCommand(["friend", "update", "friend-123", "--trust", "bestie"])).toThrow("Usage")
  })

  it("executes friend update and writes trust level", async () => {
    const now = "2026-03-19T00:00:00.000Z"
    const existing = {
      id: "friend-123",
      name: "Bob",
      trustLevel: "acquaintance" as const,
      externalIds: [],
      tenantMemberships: [],
      toolPreferences: {},
      notes: {},
      totalTokens: 0,
      createdAt: "2026-03-01T00:00:00.000Z",
      updatedAt: "2026-03-01T00:00:00.000Z",
      schemaVersion: 1,
    }
    const mockFriendStore = {
      get: vi.fn(async () => existing),
      put: vi.fn(),
      delete: vi.fn(),
      findByExternalId: vi.fn(),
      listAll: vi.fn(),
    }
    const deps: OuroCliDeps = {
      socketPath: "/tmp/test.sock",
      sendCommand: vi.fn(),
      startDaemonProcess: vi.fn(),
      writeStdout: vi.fn(),
      checkSocketAlive: vi.fn(),
      cleanupStaleSocket: vi.fn(),
      fallbackPendingMessage: vi.fn(),
      friendStore: mockFriendStore as any,
    }
    const result = await runOuroCli(["friend", "update", "friend-123", "--trust", "family", "--agent", "slugger"], deps)
    expect(result).toContain("updated")
    expect(result).toContain("friend-123")
    expect(result).toContain("family")
    expect(mockFriendStore.put).toHaveBeenCalledWith(
      "friend-123",
      expect.objectContaining({
        trustLevel: "family",
        role: "family",
      }),
    )
  })

  it("returns not found for nonexistent friend", async () => {
    const mockFriendStore = {
      get: vi.fn(async () => null),
      put: vi.fn(),
      delete: vi.fn(),
      findByExternalId: vi.fn(),
      listAll: vi.fn(),
    }
    const deps: OuroCliDeps = {
      socketPath: "/tmp/test.sock",
      sendCommand: vi.fn(),
      startDaemonProcess: vi.fn(),
      writeStdout: vi.fn(),
      checkSocketAlive: vi.fn(),
      cleanupStaleSocket: vi.fn(),
      fallbackPendingMessage: vi.fn(),
      friendStore: mockFriendStore as any,
    }
    const result = await runOuroCli(["friend", "update", "no-such-id", "--trust", "friend", "--agent", "slugger"], deps)
    expect(result).toContain("friend not found")
  })
})

describe("ouro config model", () => {
  it("parses config model command", () => {
    expect(parseOuroCommand(["config", "model", "--agent", "slugger", "gpt-5"])).toEqual({
      kind: "config.model",
      agent: "slugger",
      modelName: "gpt-5",
    })
  })

  it("rejects config model without --agent", () => {
    expect(() => parseOuroCommand(["config", "model", "gpt-5"])).toThrow("--agent")
  })

  it("rejects config model without model name", () => {
    expect(() => parseOuroCommand(["config", "model", "--agent", "slugger"])).toThrow("Usage")
  })

  it("rejects config without subcommand", () => {
    expect(() => parseOuroCommand(["config"])).toThrow("Usage")
  })

  it("rejects config with unknown subcommand", () => {
    expect(() => parseOuroCommand(["config", "unknown"])).toThrow("Usage")
  })

  it("parses config model with model name after --agent flag", () => {
    expect(parseOuroCommand(["config", "model", "--agent", "ouro", "claude-sonnet-4.6"])).toEqual({
      kind: "config.model",
      agent: "ouro",
      modelName: "claude-sonnet-4.6",
    })
  })

  it("parses config models command", () => {
    expect(parseOuroCommand(["config", "models", "--agent", "slugger"])).toEqual({
      kind: "config.models",
      agent: "slugger",
    })
  })

  it("rejects config models without --agent", () => {
    expect(() => parseOuroCommand(["config", "models"])).toThrow("--agent")
  })

  it("parses config model with --facing human", () => {
    expect(parseOuroCommand(["config", "model", "--agent", "slugger", "--facing", "human", "gpt-5"])).toEqual({
      kind: "config.model",
      agent: "slugger",
      modelName: "gpt-5",
      facing: "human",
    })
  })

  it("parses config model with --facing agent", () => {
    expect(parseOuroCommand(["config", "model", "--agent", "slugger", "--facing", "agent", "claude-opus-4-6"])).toEqual({
      kind: "config.model",
      agent: "slugger",
      modelName: "claude-opus-4-6",
      facing: "agent",
    })
  })

  it("defaults config model facing to 'human' when --facing not specified", () => {
    const result = parseOuroCommand(["config", "model", "--agent", "slugger", "gpt-5"])
    expect(result).toEqual({
      kind: "config.model",
      agent: "slugger",
      modelName: "gpt-5",
    })
  })

  it("rejects config model with invalid --facing value", () => {
    expect(() => parseOuroCommand(["config", "model", "--agent", "slugger", "--facing", "both", "gpt-5"])).toThrow("--facing must be 'human' or 'agent'")
  })

  it("config.model writes model to specified facing in agent.json", async () => {
    const agentName = `config-model-facing-${Date.now()}`
    const agentRoot = path.join(os.homedir(), "AgentBundles", `${agentName}.ouro`)
    const agentConfigPath = path.join(agentRoot, "agent.json")
    fs.mkdirSync(agentRoot, { recursive: true })
    fs.writeFileSync(
      agentConfigPath,
      JSON.stringify({
        version: 2, enabled: true, provider: "anthropic",
        humanFacing: { provider: "anthropic", model: "claude-opus-4-6" },
        agentFacing: { provider: "anthropic", model: "claude-opus-4-6" },
        phrases: { thinking: ["working"], tool: ["running tool"], followup: ["processing"] },
      }, null, 2) + "\n",
      "utf-8",
    )
    const deps: OuroCliDeps = {
      socketPath: "/tmp/ouro-test.sock",
      sendCommand: vi.fn(async () => ({ ok: true, message: "ok" })),
      startDaemonProcess: vi.fn(async () => ({ pid: 1 })),
      writeStdout: vi.fn(),
      checkSocketAlive: vi.fn(async () => true),
      cleanupStaleSocket: vi.fn(),
      fallbackPendingMessage: vi.fn(() => "/tmp/pending.jsonl"),
    }
    try {
      const result = await runOuroCli(["config", "model", "--agent", agentName, "--facing", "human", "claude-sonnet-4.6"], deps)
      expect(result).toContain("claude-sonnet-4.6")
      const updated = JSON.parse(fs.readFileSync(agentConfigPath, "utf-8")) as any
      expect(updated.humanFacing.model).toBe("claude-sonnet-4.6")
      // agentFacing should be unchanged
      expect(updated.agentFacing.model).toBe("claude-opus-4-6")
    } finally {
      fs.rmSync(agentRoot, { recursive: true, force: true })
    }
  })
})

describe("auth.switch with facing", () => {
  it("auth switch updates specified facing only", async () => {
    const agentName = `auth-switch-facing-${Date.now()}`
    const agentRoot = path.join(os.homedir(), "AgentBundles", `${agentName}.ouro`)
    const agentConfigPath = path.join(agentRoot, "agent.json")
    fs.mkdirSync(agentRoot, { recursive: true })
    const secretsDir = path.join(os.homedir(), ".agentsecrets", agentName)
    fs.mkdirSync(secretsDir, { recursive: true })
    fs.writeFileSync(
      path.join(secretsDir, "secrets.json"),
      JSON.stringify({
        providers: { "github-copilot": { githubToken: "ghp_test", baseUrl: "https://api.test.com" } },
      }, null, 2) + "\n",
      "utf-8",
    )
    fs.writeFileSync(
      agentConfigPath,
      JSON.stringify({
        version: 2, enabled: true, provider: "anthropic",
        humanFacing: { provider: "anthropic", model: "claude-opus-4-6" },
        agentFacing: { provider: "anthropic", model: "claude-opus-4-6" },
        phrases: { thinking: ["working"], tool: ["running tool"], followup: ["processing"] },
      }, null, 2) + "\n",
      "utf-8",
    )
    const deps: OuroCliDeps = {
      socketPath: "/tmp/ouro-test.sock",
      sendCommand: vi.fn(async () => ({ ok: true, message: "ok" })),
      startDaemonProcess: vi.fn(async () => ({ pid: 1 })),
      writeStdout: vi.fn(),
      checkSocketAlive: vi.fn(async () => true),
      cleanupStaleSocket: vi.fn(),
      fallbackPendingMessage: vi.fn(() => "/tmp/pending.jsonl"),
    }
    try {
      const result = await runOuroCli(["auth", "switch", "--agent", agentName, "--provider", "github-copilot", "--facing", "human"], deps)
      expect(result).toContain("switched")
      expect(result).toContain("github-copilot")
      const updated = JSON.parse(fs.readFileSync(agentConfigPath, "utf-8")) as any
      expect(updated.humanFacing.provider).toBe("github-copilot")
      // agentFacing should be unchanged
      expect(updated.agentFacing.provider).toBe("anthropic")
    } finally {
      fs.rmSync(agentRoot, { recursive: true, force: true })
      fs.rmSync(secretsDir, { recursive: true, force: true })
    }
  })

  it("auth switch updates both facings when --facing not specified", async () => {
    const agentName = `auth-switch-both-${Date.now()}`
    const agentRoot = path.join(os.homedir(), "AgentBundles", `${agentName}.ouro`)
    const agentConfigPath = path.join(agentRoot, "agent.json")
    fs.mkdirSync(agentRoot, { recursive: true })
    const secretsDir = path.join(os.homedir(), ".agentsecrets", agentName)
    fs.mkdirSync(secretsDir, { recursive: true })
    fs.writeFileSync(
      path.join(secretsDir, "secrets.json"),
      JSON.stringify({
        providers: { "minimax": { apiKey: "mm-key" } },
      }, null, 2) + "\n",
      "utf-8",
    )
    fs.writeFileSync(
      agentConfigPath,
      JSON.stringify({
        version: 2, enabled: true, provider: "anthropic",
        humanFacing: { provider: "anthropic", model: "claude-opus-4-6" },
        agentFacing: { provider: "anthropic", model: "claude-opus-4-6" },
        phrases: { thinking: ["working"], tool: ["running tool"], followup: ["processing"] },
      }, null, 2) + "\n",
      "utf-8",
    )
    const deps: OuroCliDeps = {
      socketPath: "/tmp/ouro-test.sock",
      sendCommand: vi.fn(async () => ({ ok: true, message: "ok" })),
      startDaemonProcess: vi.fn(async () => ({ pid: 1 })),
      writeStdout: vi.fn(),
      checkSocketAlive: vi.fn(async () => true),
      cleanupStaleSocket: vi.fn(),
      fallbackPendingMessage: vi.fn(() => "/tmp/pending.jsonl"),
    }
    try {
      const result = await runOuroCli(["auth", "switch", "--agent", agentName, "--provider", "minimax"], deps)
      expect(result).toContain("switched")
      const updated = JSON.parse(fs.readFileSync(agentConfigPath, "utf-8")) as any
      expect(updated.humanFacing.provider).toBe("minimax")
      expect(updated.agentFacing.provider).toBe("minimax")
    } finally {
      fs.rmSync(agentRoot, { recursive: true, force: true })
      fs.rmSync(secretsDir, { recursive: true, force: true })
    }
  })

  it("parses auth switch with --facing flag", () => {
    expect(parseOuroCommand(["auth", "switch", "--agent", "foo", "--provider", "github-copilot", "--facing", "human"])).toEqual({
      kind: "auth.switch",
      agent: "foo",
      provider: "github-copilot",
      facing: "human",
    })
    expect(parseOuroCommand(["auth", "switch", "--agent", "foo", "--provider", "azure", "--facing", "agent"])).toEqual({
      kind: "auth.switch",
      agent: "foo",
      provider: "azure",
      facing: "agent",
    })
  })
})

describe("ouro habit CLI parsing", () => {
  it("parses ouro habit list --agent <agent>", () => {
    expect(parseOuroCommand(["habit", "list", "--agent", "slugger"])).toEqual({
      kind: "habit.list",
      agent: "slugger",
    })
  })

  it("parses ouro habit list without --agent", () => {
    expect(parseOuroCommand(["habit", "list"])).toEqual({
      kind: "habit.list",
    })
  })

  it("parses ouro habit create --agent <agent> <name> --cadence <interval>", () => {
    expect(parseOuroCommand(["habit", "create", "--agent", "slugger", "daily-reflection", "--cadence", "24h"])).toEqual({
      kind: "habit.create",
      agent: "slugger",
      name: "daily-reflection",
      cadence: "24h",
    })
  })

  it("parses ouro habit create without --cadence (defaults to no cadence)", () => {
    expect(parseOuroCommand(["habit", "create", "--agent", "slugger", "meditation"])).toEqual({
      kind: "habit.create",
      agent: "slugger",
      name: "meditation",
    })
  })

  it("parses ouro habit create without --agent", () => {
    expect(parseOuroCommand(["habit", "create", "morning-check", "--cadence", "1h"])).toEqual({
      kind: "habit.create",
      name: "morning-check",
      cadence: "1h",
    })
  })

  it("throws on ouro habit create without name", () => {
    expect(() => parseOuroCommand(["habit", "create", "--agent", "slugger"])).toThrow("Usage")
  })

  it("throws on unknown habit subcommand", () => {
    expect(() => parseOuroCommand(["habit", "delete"])).toThrow("Usage")
  })

  it("parses poke --habit <name> as habit poke", () => {
    expect(parseOuroCommand(["poke", "slugger", "--habit", "heartbeat"])).toEqual({
      kind: "habit.poke",
      agent: "slugger",
      habitName: "heartbeat",
    })
  })

  it("poke --habit takes priority over --task", () => {
    expect(parseOuroCommand(["poke", "slugger", "--habit", "heartbeat", "--task", "something"])).toEqual({
      kind: "habit.poke",
      agent: "slugger",
      habitName: "heartbeat",
    })
  })
})

describe("ouro habit CLI execution", () => {
  function makeDeps(overrides?: Partial<OuroCliDeps>): OuroCliDeps {
    return {
      socketPath: "/tmp/ouro-test.sock",
      sendCommand: vi.fn(),
      startDaemonProcess: vi.fn(async () => ({ pid: 1 })),
      writeStdout: vi.fn(),
      checkSocketAlive: vi.fn(async () => true),
      cleanupStaleSocket: vi.fn(),
      fallbackPendingMessage: vi.fn(() => "/tmp/pending.jsonl"),
      ...overrides,
    }
  }

  const cleanup: string[] = []

  afterAll(() => {
    while (cleanup.length > 0) {
      const entry = cleanup.pop()
      if (entry) fs.rmSync(entry, { recursive: true, force: true })
    }
  })

  it("ouro habit list scans habits/ and displays name/cadence/status/lastRun", async () => {
    const tempBundle = fs.mkdtempSync(path.join(os.tmpdir(), "habit-list-"))
    cleanup.push(tempBundle)

    const habitsDir = path.join(tempBundle, "habits")
    fs.mkdirSync(habitsDir, { recursive: true })

    fs.writeFileSync(path.join(habitsDir, "heartbeat.md"), [
      "---",
      "title: Heartbeat check-in",
      "cadence: 30m",
      "status: active",
      "lastRun: 2026-03-27T10:00:00.000Z",
      "created: 2026-03-01T00:00:00.000Z",
      "---",
      "",
      "Run heartbeat.",
      "",
    ].join("\n"), "utf-8")

    fs.writeFileSync(path.join(habitsDir, "daily-reflection.md"), [
      "---",
      "title: Daily Reflection",
      "cadence: 24h",
      "status: paused",
      "lastRun: null",
      "created: 2026-03-01T00:00:00.000Z",
      "---",
      "",
      "Reflect.",
      "",
    ].join("\n"), "utf-8")

    const deps = makeDeps({ agentBundleRoot: tempBundle })
    const result = await runOuroCli(["habit", "list", "--agent", "test"], deps)

    expect(result).toContain("heartbeat")
    expect(result).toContain("30m")
    expect(result).toContain("active")
    expect(result).toContain("daily-reflection")
    expect(result).toContain("24h")
    expect(result).toContain("paused")
    expect(deps.sendCommand).not.toHaveBeenCalled()
  })

  it("ouro habit list returns message when no habits exist", async () => {
    const tempBundle = fs.mkdtempSync(path.join(os.tmpdir(), "habit-list-empty-"))
    cleanup.push(tempBundle)

    const deps = makeDeps({ agentBundleRoot: tempBundle })
    const result = await runOuroCli(["habit", "list", "--agent", "test"], deps)
    expect(result).toContain("no habits")
  })

  it("ouro habit list shows 'none' for habits without cadence and 'never' for null lastRun", async () => {
    const tempBundle = fs.mkdtempSync(path.join(os.tmpdir(), "habit-list-nocadence-"))
    cleanup.push(tempBundle)
    const habitsDir = path.join(tempBundle, "habits")
    fs.mkdirSync(habitsDir, { recursive: true })

    fs.writeFileSync(path.join(habitsDir, "manual.md"), [
      "---",
      "title: Manual Check",
      "status: active",
      "lastRun: null",
      "created: 2026-03-01T00:00:00.000Z",
      "---",
      "",
      "Manual only.",
    ].join("\n"), "utf-8")

    const deps = makeDeps({ agentBundleRoot: tempBundle })
    const result = await runOuroCli(["habit", "list", "--agent", "test"], deps)
    expect(result).toContain("none")
    expect(result).toContain("never")
  })

  it("ouro habit create without --cadence uses null cadence", async () => {
    const tempBundle = fs.mkdtempSync(path.join(os.tmpdir(), "habit-create-nocadence-"))
    cleanup.push(tempBundle)

    const deps = makeDeps({ agentBundleRoot: tempBundle })
    const result = await runOuroCli(["habit", "create", "--agent", "test", "meditation"], deps)
    expect(result).toContain("meditation")

    // Verify file was created with null cadence
    const content = fs.readFileSync(path.join(tempBundle, "habits", "meditation.md"), "utf-8")
    expect(content).toContain("cadence: null")
  })

  it("ouro habit list returns message when habits dir exists but has no .md files", async () => {
    const tempBundle = fs.mkdtempSync(path.join(os.tmpdir(), "habit-list-emptydir-"))
    cleanup.push(tempBundle)
    fs.mkdirSync(path.join(tempBundle, "habits"), { recursive: true })
    // Only a README, no .md habit files
    fs.writeFileSync(path.join(tempBundle, "habits", "README.md"), "# Habits", "utf8")

    const deps = makeDeps({ agentBundleRoot: tempBundle })
    const result = await runOuroCli(["habit", "list", "--agent", "test"], deps)
    expect(result).toContain("no habits")
  })

  it("ouro habit create creates a new habit file", async () => {
    const tempBundle = fs.mkdtempSync(path.join(os.tmpdir(), "habit-create-"))
    cleanup.push(tempBundle)

    const deps = makeDeps({ agentBundleRoot: tempBundle })
    const result = await runOuroCli(["habit", "create", "--agent", "test", "morning-check", "--cadence", "1h"], deps)

    expect(result).toContain("created")
    expect(result).toContain("morning-check")

    const filePath = path.join(tempBundle, "habits", "morning-check.md")
    expect(fs.existsSync(filePath)).toBe(true)

    const content = fs.readFileSync(filePath, "utf-8")
    expect(content).toContain("title: morning-check")
    expect(content).toContain("cadence: 1h")
    expect(content).toContain("status: active")
    expect(content).toContain("lastRun:")
    expect(content).toContain("created:")
  })

  it("ouro habit create errors helpfully on duplicate name", async () => {
    const tempBundle = fs.mkdtempSync(path.join(os.tmpdir(), "habit-create-dup-"))
    cleanup.push(tempBundle)

    const habitsDir = path.join(tempBundle, "habits")
    fs.mkdirSync(habitsDir, { recursive: true })
    fs.writeFileSync(path.join(habitsDir, "heartbeat.md"), "---\ntitle: Heartbeat\n---\n\nBody.\n", "utf-8")

    const deps = makeDeps({ agentBundleRoot: tempBundle })
    const result = await runOuroCli(["habit", "create", "--agent", "test", "heartbeat", "--cadence", "30m"], deps)

    expect(result).toContain("error")
    expect(result).toContain("heartbeat")
    expect(result).toContain("already exists")
  })

  it("ouro poke --habit sends habit poke via daemon", async () => {
    const deps = makeDeps({
      sendCommand: vi.fn(async () => ({ ok: true, message: "poked" })),
    })
    const result = await runOuroCli(["poke", "slugger", "--habit", "heartbeat"], deps)
    expect(result).toContain("poked")
    expect(deps.sendCommand).toHaveBeenCalledWith(
      deps.socketPath,
      expect.objectContaining({
        kind: "habit.poke",
        agent: "slugger",
        habitName: "heartbeat",
      }),
    )
  })
})

describe("OURO_CLI_TRUST_MANIFEST", () => {
  it("exports trust manifest with expected entries", async () => {
    const { OURO_CLI_TRUST_MANIFEST } = await import("../../../repertoire/guardrails")
    expect(OURO_CLI_TRUST_MANIFEST.whoami).toBe("acquaintance")
    expect(OURO_CLI_TRUST_MANIFEST.changelog).toBe("acquaintance")
    expect(OURO_CLI_TRUST_MANIFEST["task board"]).toBe("friend")
    expect(OURO_CLI_TRUST_MANIFEST["task fix"]).toBe("friend")
    expect(OURO_CLI_TRUST_MANIFEST["friend list"]).toBe("friend")
    expect(OURO_CLI_TRUST_MANIFEST["session list"]).toBe("acquaintance")
    expect(OURO_CLI_TRUST_MANIFEST["config model"]).toBe("friend")
    expect(OURO_CLI_TRUST_MANIFEST["config models"]).toBe("friend")
    expect(OURO_CLI_TRUST_MANIFEST["friend update"]).toBe("family")
  })
})
