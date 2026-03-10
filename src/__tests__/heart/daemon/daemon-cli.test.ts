import * as fs from "fs"
import * as path from "path"
import { describe, expect, it, vi } from "vitest"

import {
  discoverExistingCredentials,
  parseOuroCommand,
  runOuroCli,
  type OuroCliDeps,
} from "../../../heart/daemon/daemon-cli"
import { OuroDaemon } from "../../../heart/daemon/daemon"

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

  it("rejects malformed friend subcommands", () => {
    // bare "friend" with no subcommand
    expect(() => parseOuroCommand(["friend"])).toThrow("Usage")

    // friend show with no id
    expect(() => parseOuroCommand(["friend", "show"])).toThrow("Usage")

    // unknown friend subcommand
    expect(() => parseOuroCommand(["friend", "unknown"])).toThrow("Usage")
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
      installSubagents: vi.fn(async () => ({ claudeInstalled: 0, codexInstalled: 0, notes: [] })),
    }

    const shortResult = await runOuroCli(["-v"], deps)
    const longResult = await runOuroCli(["--version"], deps)

    expect(shortResult).toBe(PACKAGE_VERSION.version)
    expect(longResult).toBe(PACKAGE_VERSION.version)
    expect(deps.writeStdout).toHaveBeenNthCalledWith(1, PACKAGE_VERSION.version)
    expect(deps.writeStdout).toHaveBeenNthCalledWith(2, PACKAGE_VERSION.version)
    expect(deps.sendCommand).not.toHaveBeenCalled()
  })

  it("starts daemon on `up` when socket is not live", async () => {
    const installSubagents = vi.fn(async () => ({
      claudeInstalled: 0,
      codexInstalled: 0,
      notes: [],
    }))
    const deps: OuroCliDeps = {
      socketPath: "/tmp/ouro-test.sock",
      sendCommand: vi.fn(),
      startDaemonProcess: vi.fn(async () => ({ pid: 12345 })),
      writeStdout: vi.fn(),
      checkSocketAlive: vi.fn(async () => false),
      cleanupStaleSocket: vi.fn(),
      fallbackPendingMessage: vi.fn(() => "/tmp/pending.jsonl"),
      installSubagents,
    }

    const result = await runOuroCli(["up"], deps)

    expect(result).toContain("daemon started")
    expect(installSubagents).toHaveBeenCalledTimes(1)
    expect(deps.startDaemonProcess).toHaveBeenCalledWith("/tmp/ouro-test.sock")
    expect(deps.sendCommand).not.toHaveBeenCalled()
  })

  it("is idempotent for `up` when daemon already running", async () => {
    const installSubagents = vi.fn(async () => ({
      claudeInstalled: 0,
      codexInstalled: 0,
      notes: [],
    }))
    const deps: OuroCliDeps = {
      socketPath: "/tmp/ouro-test.sock",
      sendCommand: vi.fn(),
      startDaemonProcess: vi.fn(async () => ({ pid: 1 })),
      writeStdout: vi.fn(),
      checkSocketAlive: vi.fn(async () => true),
      cleanupStaleSocket: vi.fn(),
      fallbackPendingMessage: vi.fn(() => "/tmp/pending.jsonl"),
      installSubagents,
    }

    const result = await runOuroCli(["up"], deps)

    expect(result).toContain("already running")
    expect(installSubagents).toHaveBeenCalledTimes(1)
    expect(deps.startDaemonProcess).not.toHaveBeenCalled()
    expect(deps.sendCommand).toHaveBeenCalledWith("/tmp/ouro-test.sock", { kind: "daemon.status" })
  })

  it("attempts .ouro UTI registration during `up` setup", async () => {
    const registerOuroBundleType = vi.fn(async () => ({ attempted: true, registered: true }))
    const deps: OuroCliDeps = {
      socketPath: "/tmp/ouro-test.sock",
      sendCommand: vi.fn(),
      startDaemonProcess: vi.fn(async () => ({ pid: 4321 })),
      writeStdout: vi.fn(),
      checkSocketAlive: vi.fn(async () => false),
      cleanupStaleSocket: vi.fn(),
      fallbackPendingMessage: vi.fn(() => "/tmp/pending.jsonl"),
      installSubagents: vi.fn(async () => ({ claudeInstalled: 0, codexInstalled: 0, notes: [] })),
      registerOuroBundleType,
    }

    await runOuroCli(["up"], deps)

    expect(registerOuroBundleType).toHaveBeenCalledTimes(1)
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
      installSubagents: vi.fn(async () => ({ claudeInstalled: 0, codexInstalled: 0, notes: [] })),
      registerOuroBundleType,
    }

    const result = await runOuroCli(["up"], deps)

    expect(registerOuroBundleType).toHaveBeenCalledTimes(1)
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
      installSubagents: vi.fn(async () => ({ claudeInstalled: 0, codexInstalled: 0, notes: [] })),
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
      installSubagents: vi.fn(async () => ({ claudeInstalled: 0, codexInstalled: 0, notes: [] })),
    }

    const result = await runOuroCli(["status"], deps)

    expect(result).toContain("| Daemon       | unknown |")
    expect(result).toContain("| Socket       | unknown |")
    expect(result).toContain("| Version      | unknown |")
    expect(result).toContain("| Last Updated | unknown |")
    expect(result).toContain("| Workers      | 0")
    expect(result).toContain("| Senses       | 0")
    expect(result).toContain("| Health       | unknown |")
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
      installSubagents: vi.fn(async () => ({ claudeInstalled: 0, codexInstalled: 0, notes: [] })),
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
      installSubagents: vi.fn(async () => ({ claudeInstalled: 0, codexInstalled: 0, notes: [] })),
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
      installSubagents: vi.fn(async () => ({ claudeInstalled: 0, codexInstalled: 0, notes: [] })),
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
      installSubagents: vi.fn(async () => ({ claudeInstalled: 0, codexInstalled: 0, notes: [] })),
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
      installSubagents: vi.fn(async () => ({ claudeInstalled: 0, codexInstalled: 0, notes: [] })),
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
      installSubagents: vi.fn(async () => ({ claudeInstalled: 0, codexInstalled: 0, notes: [] })),
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
      installSubagents: vi.fn(async () => ({ claudeInstalled: 0, codexInstalled: 0, notes: [] })),
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
      installSubagents: vi.fn(async () => ({ claudeInstalled: 0, codexInstalled: 0, notes: [] })),
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
      installSubagents: vi.fn(async () => ({ claudeInstalled: 0, codexInstalled: 0, notes: [] })),
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
      installSubagents: vi.fn(async () => ({ claudeInstalled: 0, codexInstalled: 0, notes: [] })),
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
      installSubagents: vi.fn(async () => ({ claudeInstalled: 0, codexInstalled: 0, notes: [] })),
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
      installSubagents: vi.fn(async () => ({ claudeInstalled: 0, codexInstalled: 0, notes: [] })),
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

  it("continues `up` flow when subagent install throws", async () => {
    const deps: OuroCliDeps = {
      socketPath: "/tmp/ouro-test.sock",
      sendCommand: vi.fn(),
      startDaemonProcess: vi.fn(async () => ({ pid: 777 })),
      writeStdout: vi.fn(),
      checkSocketAlive: vi.fn(async () => false),
      cleanupStaleSocket: vi.fn(),
      fallbackPendingMessage: vi.fn(() => "/tmp/pending.jsonl"),
      installSubagents: vi.fn(async () => {
        throw new Error("install exploded")
      }),
    }

    const result = await runOuroCli(["up"], deps)

    expect(result).toContain("daemon started")
    expect(deps.startDaemonProcess).toHaveBeenCalledTimes(1)
  })

  it("continues `up` flow when subagent install throws a non-Error value", async () => {
    const deps: OuroCliDeps = {
      socketPath: "/tmp/ouro-test.sock",
      sendCommand: vi.fn(),
      startDaemonProcess: vi.fn(async () => ({ pid: 778 })),
      writeStdout: vi.fn(),
      checkSocketAlive: vi.fn(async () => false),
      cleanupStaleSocket: vi.fn(),
      fallbackPendingMessage: vi.fn(() => "/tmp/pending.jsonl"),
      installSubagents: vi.fn(async () => {
        throw "install exploded string"
      }),
    }

    const result = await runOuroCli(["up"], deps)

    expect(result).toContain("daemon started")
    expect(deps.startDaemonProcess).toHaveBeenCalledTimes(1)
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
      installSubagents: vi.fn(async () => ({ claudeInstalled: 0, codexInstalled: 0, notes: [] })),
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

  it("routes link command through local friend linker instead of daemon socket", async () => {
    const deps: OuroCliDeps = {
      socketPath: "/tmp/ouro-test.sock",
      sendCommand: vi.fn(async () => ({ ok: true, message: "unexpected daemon call" })),
      startDaemonProcess: vi.fn(async () => ({ pid: 1 })),
      writeStdout: vi.fn(),
      checkSocketAlive: vi.fn(async () => true),
      cleanupStaleSocket: vi.fn(),
      fallbackPendingMessage: vi.fn(() => "/tmp/pending.jsonl"),
      installSubagents: vi.fn(async () => ({ claudeInstalled: 0, codexInstalled: 0, notes: [] })),
      linkFriendIdentity: vi.fn(async () => "linked aad:aad-user-123 to friend-1"),
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
    expect(deps.linkFriendIdentity).toHaveBeenCalledWith({
      kind: "friend.link",
      agent: "slugger",
      friendId: "friend-1",
      provider: "aad",
      externalId: "aad-user-123",
    })
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
      installSubagents: vi.fn(async () => ({ claudeInstalled: 0, codexInstalled: 0, notes: [] })),
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
      installSubagents: vi.fn(async () => ({ claudeInstalled: 0, codexInstalled: 0, notes: [] })),
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
      installSubagents: vi.fn(async () => ({ claudeInstalled: 0, codexInstalled: 0, notes: [] })),
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
      installSubagents: vi.fn(async () => ({ claudeInstalled: 0, codexInstalled: 0, notes: [] })),
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

  it("throws usage when hatch input cannot resolve required values", async () => {
    const deps: OuroCliDeps = {
      socketPath: "/tmp/ouro-test.sock",
      sendCommand: vi.fn(async () => ({ ok: true })),
      startDaemonProcess: vi.fn(async () => ({ pid: 1 })),
      writeStdout: vi.fn(),
      checkSocketAlive: vi.fn(async () => true),
      cleanupStaleSocket: vi.fn(),
      fallbackPendingMessage: vi.fn(() => "/tmp/pending.jsonl"),
      installSubagents: vi.fn(async () => ({ claudeInstalled: 0, codexInstalled: 0, notes: [] })),
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
      installSubagents: vi.fn(async () => ({ claudeInstalled: 0, codexInstalled: 0, notes: [] })),
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
      installSubagents: vi.fn(async () => ({ claudeInstalled: 0, codexInstalled: 0, notes: [] })),
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
      installSubagents: vi.fn(async () => ({ claudeInstalled: 0, codexInstalled: 0, notes: [] })),
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
      installSubagents: vi.fn(async () => {
        throw "install failed string"
      }),
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
      installSubagents: vi.fn(async () => ({ claudeInstalled: 0, codexInstalled: 0, notes: [] })),
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
      installSubagents: vi.fn(async () => ({ claudeInstalled: 0, codexInstalled: 0, notes: [] })),
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
      installSubagents: vi.fn(async () => ({ claudeInstalled: 0, codexInstalled: 0, notes: [] })),
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
      installSubagents: vi.fn(async () => {
        throw new Error("install failed")
      }),
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
      installSubagents: vi.fn(async () => ({ claudeInstalled: 0, codexInstalled: 0, notes: [] })),
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
      installSubagents: vi.fn(async () => ({ claudeInstalled: 0, codexInstalled: 0, notes: [] })),
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
      installSubagents: vi.fn(async () => ({ claudeInstalled: 0, codexInstalled: 0, notes: [] })),
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
      installSubagents: vi.fn(async () => ({ claudeInstalled: 0, codexInstalled: 0, notes: [] })),
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
      installSubagents: vi.fn(async () => ({ claudeInstalled: 0, codexInstalled: 0, notes: [] })),
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
      installSubagents: vi.fn(async () => ({ claudeInstalled: 0, codexInstalled: 0, notes: [] })),
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
      installSubagents: vi.fn(async () => ({ claudeInstalled: 0, codexInstalled: 0, notes: [] })),
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
      installSubagents: vi.fn(async () => ({ claudeInstalled: 0, codexInstalled: 0, notes: [] })),
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
      installSubagents: vi.fn(async () => ({ claudeInstalled: 0, codexInstalled: 0, notes: [] })),
    }
  }

  it("includes task subcommands in help output", async () => {
    const deps = makeHelpDeps()
    const result = await runOuroCli(["--help"], deps)

    expect(result).toContain("ouro task board")
    expect(result).toContain("ouro task create")
    expect(result).toContain("ouro task update")
    expect(result).toContain("ouro task show")
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
      installSubagents: vi.fn(async () => ({ claudeInstalled: 0, codexInstalled: 0, notes: [] })),
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
      installSubagents: vi.fn(async () => ({ claudeInstalled: 0, codexInstalled: 0, notes: [] })),
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
      installSubagents: vi.fn(async () => ({ claudeInstalled: 0, codexInstalled: 0, notes: [] })),
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
      installSubagents: vi.fn(async () => ({ claudeInstalled: 0, codexInstalled: 0, notes: [] })),
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
      installSubagents: vi.fn(async () => ({ claudeInstalled: 0, codexInstalled: 0, notes: [] })),
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
      installSubagents: vi.fn(async () => ({ claudeInstalled: 0, codexInstalled: 0, notes: [] })),
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
      installSubagents: vi.fn(async () => ({ claudeInstalled: 0, codexInstalled: 0, notes: [] })),
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
      installSubagents: vi.fn(async () => ({ claudeInstalled: 0, codexInstalled: 0, notes: [] })),
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
      installSubagents: vi.fn(async () => ({ claudeInstalled: 0, codexInstalled: 0, notes: [] })),
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
      installSubagents: vi.fn(async () => ({ claudeInstalled: 0, codexInstalled: 0, notes: [] })),
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
      installSubagents: vi.fn(async () => ({ claudeInstalled: 0, codexInstalled: 0, notes: [] })),
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
      installSubagents: vi.fn(async () => ({ claudeInstalled: 0, codexInstalled: 0, notes: [] })),
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
      installSubagents: vi.fn(async () => ({ claudeInstalled: 0, codexInstalled: 0, notes: [] })),
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
      installSubagents: vi.fn(async () => ({ claudeInstalled: 0, codexInstalled: 0, notes: [] })),
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
      installSubagents: vi.fn(async () => ({ claudeInstalled: 0, codexInstalled: 0, notes: [] })),
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
      installSubagents: vi.fn(async () => ({ claudeInstalled: 0, codexInstalled: 0, notes: [] })),
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
      installSubagents: vi.fn(async () => ({ claudeInstalled: 0, codexInstalled: 0, notes: [] })),
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
      installSubagents: vi.fn(async () => ({ claudeInstalled: 0, codexInstalled: 0, notes: [] })),
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
      installSubagents: vi.fn(async () => ({ claudeInstalled: 0, codexInstalled: 0, notes: [] })),
      registerOuroBundleType: vi.fn(async () => ({ attempted: true, registered: true })),
      listDiscoveredAgents: vi.fn(async () => []),
      runAdoptionSpecialist,
      startChat,
    }

    await runOuroCli([], deps)

    expect(runAdoptionSpecialist).toHaveBeenCalledTimes(1)
    expect(deps.installSubagents).toHaveBeenCalledTimes(1)
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
      installSubagents: vi.fn(async () => ({ claudeInstalled: 0, codexInstalled: 0, notes: [] })),
      listDiscoveredAgents: vi.fn(async () => []),
      runAdoptionSpecialist,
      startChat,
    }

    const result = await runOuroCli([], deps)

    expect(runAdoptionSpecialist).toHaveBeenCalledTimes(1)
    expect(startChat).not.toHaveBeenCalled()
    // System setup runs BEFORE the specialist, so installSubagents is called even if specialist aborts
    expect(deps.installSubagents).toHaveBeenCalledTimes(1)
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
      installSubagents: vi.fn(async () => {
        callOrder.push("installSubagents")
        return { claudeInstalled: 0, codexInstalled: 0, notes: [] }
      }),
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
    expect(callOrder.indexOf("installSubagents")).toBeLessThan(callOrder.indexOf("runAdoptionSpecialist"))
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
      installSubagents: vi.fn(async () => ({ claudeInstalled: 0, codexInstalled: 0, notes: [] })),
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
      installSubagents: vi.fn(async () => ({ claudeInstalled: 0, codexInstalled: 0, notes: [] })),
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
      installSubagents: vi.fn(async () => ({ claudeInstalled: 0, codexInstalled: 0, notes: [] })),
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
      installSubagents: vi.fn(async () => ({ claudeInstalled: 0, codexInstalled: 0, notes: [] })),
      registerOuroBundleType: vi.fn(async () => ({ attempted: true, registered: true })),
      runAdoptionSpecialist,
      startChat,
    }

    const result = await runOuroCli(["hatch"], deps)

    expect(runAdoptionSpecialist).toHaveBeenCalledTimes(1)
    expect(startChat).toHaveBeenCalledWith("HatchedViaSpecialist")
    expect(deps.installSubagents).toHaveBeenCalledTimes(1)
    expect(result).toBe("")
  })

  it("continues gracefully when subagent install fails during bare ouro hatch specialist flow", async () => {
    const runAdoptionSpecialist = vi.fn(async () => "HatchSubagentFail")
    const startChat = vi.fn(async () => {})
    const deps: OuroCliDeps = {
      socketPath: "/tmp/ouro-test.sock",
      sendCommand: vi.fn(async () => ({ ok: true })),
      startDaemonProcess: vi.fn(async () => ({ pid: 77 })),
      writeStdout: vi.fn(),
      checkSocketAlive: vi.fn(async () => false),
      cleanupStaleSocket: vi.fn(),
      fallbackPendingMessage: vi.fn(() => "/tmp/pending.jsonl"),
      installSubagents: vi.fn(async () => {
        throw new Error("subagent install failed in hatch path")
      }),
      registerOuroBundleType: vi.fn(async () => ({ attempted: true, registered: true })),
      runAdoptionSpecialist,
      startChat,
    }

    const result = await runOuroCli(["hatch"], deps)

    expect(runAdoptionSpecialist).toHaveBeenCalledTimes(1)
    expect(startChat).toHaveBeenCalledWith("HatchSubagentFail")
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
      installSubagents: vi.fn(async () => ({ claudeInstalled: 0, codexInstalled: 0, notes: [] })),
      registerOuroBundleType: vi.fn(async () => ({ attempted: true, registered: true })),
      runAdoptionSpecialist,
      // No startChat provided
    }

    const result = await runOuroCli(["hatch"], deps)

    expect(runAdoptionSpecialist).toHaveBeenCalledTimes(1)
    expect(deps.installSubagents).toHaveBeenCalledTimes(1)
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
      installSubagents: vi.fn(async () => ({ claudeInstalled: 0, codexInstalled: 0, notes: [] })),
      runAdoptionSpecialist,
    }

    const result = await runOuroCli(["hatch"], deps)

    expect(runAdoptionSpecialist).toHaveBeenCalledTimes(1)
    // System setup runs BEFORE the specialist, so installSubagents is called even if specialist aborts
    expect(deps.installSubagents).toHaveBeenCalledTimes(1)
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
      installSubagents: vi.fn(async () => ({ claudeInstalled: 0, codexInstalled: 0, notes: [] })),
      registerOuroBundleType: vi.fn(async () => ({ attempted: true, registered: true })),
      listDiscoveredAgents: vi.fn(async () => []),
      runAdoptionSpecialist,
      // No startChat provided
    }

    const result = await runOuroCli([], deps)

    expect(runAdoptionSpecialist).toHaveBeenCalledTimes(1)
    expect(deps.installSubagents).toHaveBeenCalledTimes(1)
    expect(deps.startDaemonProcess).toHaveBeenCalled()
    expect(result).toBe("")
  })

  it("continues subagent install failure gracefully after specialist hatch", async () => {
    const runAdoptionSpecialist = vi.fn(async () => "FailInstallBot")
    const startChat = vi.fn(async () => {})
    const deps: OuroCliDeps = {
      socketPath: "/tmp/ouro-test.sock",
      sendCommand: vi.fn(async () => ({ ok: true })),
      startDaemonProcess: vi.fn(async () => ({ pid: 55 })),
      writeStdout: vi.fn(),
      checkSocketAlive: vi.fn(async () => false),
      cleanupStaleSocket: vi.fn(),
      fallbackPendingMessage: vi.fn(() => "/tmp/pending.jsonl"),
      installSubagents: vi.fn(async () => {
        throw new Error("subagent install failed")
      }),
      registerOuroBundleType: vi.fn(async () => ({ attempted: true, registered: true })),
      listDiscoveredAgents: vi.fn(async () => []),
      runAdoptionSpecialist,
      startChat,
    }

    await runOuroCli([], deps)

    expect(runAdoptionSpecialist).toHaveBeenCalledTimes(1)
    expect(startChat).toHaveBeenCalledWith("FailInstallBot")
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
      installSubagents: vi.fn(async () => ({ claudeInstalled: 0, codexInstalled: 0, notes: [] })),
      taskModule: mockTaskModule as any,
      ...overrides,
    }
  }

  it("ouro task board returns full board output", async () => {
    mockTaskModule.getBoard.mockReturnValueOnce({
      compact: "[Tasks] processing:1",
      full: "## processing\n- sample-task",
      byStatus: { drafting: [], processing: ["sample-task"], validating: [], collaborating: [], paused: [], blocked: [], done: [] },
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
      byStatus: { drafting: [], processing: [], validating: [], collaborating: [], paused: [], blocked: [], done: [] },
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
      installSubagents: vi.fn(async () => ({ claudeInstalled: 0, codexInstalled: 0, notes: [] })),
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
        type: "habit",
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
      installSubagents: vi.fn(async () => ({ claudeInstalled: 0, codexInstalled: 0, notes: [] })),
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
      installSubagents: vi.fn(async () => ({ claudeInstalled: 0, codexInstalled: 0, notes: [] })),
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
})
