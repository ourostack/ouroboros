import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"

// Mock provider-ping for auth verify/switch tests
vi.mock("../../../heart/provider-ping", () => ({
  pingProvider: vi.fn().mockResolvedValue({ ok: true }),
}))

const mockProviderCredentials = vi.hoisted(() => ({
  pools: new Map<string, any>(),
  refreshProviderCredentialPool: vi.fn(async (agentName: string, options?: { onProgress?: (message: string) => void }) => {
    options?.onProgress?.(`reading vault items for ${agentName}...`)
    options?.onProgress?.("parsing provider credentials...")
    return mockProviderCredentials.pools.get(agentName) ?? {
      ok: true,
      poolPath: `vault:${agentName}:providers/*`,
      pool: {
        schemaVersion: 1,
        updatedAt: "2026-04-13T00:00:00.000Z",
        providers: {},
      },
    }
  }),
  readProviderCredentialPool: vi.fn((agentName: string) => {
    return mockProviderCredentials.pools.get(agentName) ?? {
      ok: false,
      reason: "missing",
      poolPath: `vault:${agentName}:providers/*`,
      error: "provider credentials have not been loaded from vault",
    }
  }),
}))

vi.mock("../../../heart/provider-credentials", async () => {
  const actual = await vi.importActual<typeof import("../../../heart/provider-credentials")>("../../../heart/provider-credentials")
  return {
    ...actual,
    refreshProviderCredentialPool: mockProviderCredentials.refreshProviderCredentialPool,
    readProviderCredentialPool: mockProviderCredentials.readProviderCredentialPool,
  }
})

// Mock startup-tui so ensureDaemonRunning doesn't poll a real socket
vi.mock("../../../heart/daemon/startup-tui", () => ({
  pollDaemonStartup: vi.fn(async () => ({ stable: [], degraded: [] })),
}))

// Mock agent-config-check so chat health checks don't hit real filesystem
vi.mock("../../../heart/daemon/agent-config-check", () => ({
  checkAgentConfigWithProviderHealth: vi.fn().mockResolvedValue({ ok: true }),
}))

// Mock agentic-repair so ouro up repair flow doesn't need real providers
const mockAgenticRepair = vi.hoisted(() => ({
  runAgenticRepair: vi.fn(async () => ({ repairsAttempted: false, usedAgentic: false })),
  createAgenticDiagnosisProviderRuntime: vi.fn(),
  // Layer 3: gate function. Default to today's pre-Layer-3 behavior so the
  // existing daemon-cli tests don't change semantics — they fired the
  // agentic-repair path on `untypedDegraded.length > 0`, which is exactly
  // what `shouldFireRepairGuide` returns when typedDegraded is empty.
  shouldFireRepairGuide: vi.fn(
    (input: { untypedDegraded: unknown[]; typedDegraded: unknown[]; noRepair: boolean }) => {
      if (input.noRepair) return false
      if (input.untypedDegraded.length > 0) return true
      if (input.typedDegraded.length >= 3) return true
      return false
    },
  ),
}))
vi.mock("../../../heart/daemon/agentic-repair", () => mockAgenticRepair)

import {
  createDefaultOuroCliDeps,
  parseOuroCommand,
  runOuroCli,
  summarizeDaemonStartupFailure,
  type OuroCliDeps,
} from "../../../heart/daemon/daemon-cli"
import { OuroDaemon } from "../../../heart/daemon/daemon"
import * as daemonThoughts from "../../../heart/daemon/thoughts"
import * as identity from "../../../heart/identity"
import * as sessionActivity from "../../../heart/session-activity"
import { readProviderState } from "../../../heart/provider-state"
import { createTaskModule } from "../../../repertoire/tasks"
import { createTmpBundle } from "../../test-helpers/tmpdir-bundle"
import { checkAgentConfigWithProviderHealth } from "../../../heart/daemon/agent-config-check"

const PACKAGE_VERSION = JSON.parse(
  fs.readFileSync(path.join(process.cwd(), "package.json"), "utf-8"),
) as { version: string }

describe("summarizeDaemonStartupFailure", () => {
  it("prefers the explicit startup failure reason when present", () => {
    expect(summarizeDaemonStartupFailure({
      ok: false,
      alreadyRunning: false,
      message: "background service started (pid 777) but did not finish booting",
      startupFailureReason: "replacement background service did not answer within 1s",
    })).toBe("replacement background service did not answer within 1s")
  })

  it("falls back to the first message line when no explicit reason is available", () => {
    expect(summarizeDaemonStartupFailure({
      ok: false,
      alreadyRunning: false,
      message: "background service started (pid 777) but did not finish booting\nRun `ouro logs` to watch live startup logs.",
      startupFailureReason: "",
    })).toBe("background service started (pid 777) but did not finish booting")
  })

  it("uses the stock startup failure sentence when neither reason nor message first line are usable", () => {
    expect(summarizeDaemonStartupFailure({
      ok: false,
      alreadyRunning: false,
      message: "\nRun `ouro logs` to watch live startup logs.",
      startupFailureReason: "",
    })).toBe("background service failed to finish booting")
  })
})

function runningDaemonStatusResponse(overrides?: {
  socketPath?: string
  version?: string
  lastUpdated?: string
  workerCount?: number
  senseCount?: number
}): { ok: true; summary: string; data: { overview: Record<string, unknown>; senses: []; workers: [] } } {
  return {
    ok: true,
    summary: "running",
    data: {
      overview: {
        daemon: "running",
        health: "ok",
        socketPath: overrides?.socketPath ?? "/tmp/ouro-test.sock",
        version: overrides?.version ?? PACKAGE_VERSION.version,
        ...(overrides?.lastUpdated ? { lastUpdated: overrides.lastUpdated } : {}),
        workerCount: overrides?.workerCount ?? 0,
        senseCount: overrides?.senseCount ?? 0,
      },
      senses: [],
      workers: [],
    },
  }
}

function sendCommandWithRunningStatus(
  response = runningDaemonStatusResponse(),
): ReturnType<typeof vi.fn> {
  return vi.fn(async (_socketPath, command) => {
    if (command.kind === "daemon.status") {
      return response
    }
    return { ok: true, summary: "ok" }
  })
}

function runningDaemonStatusWithProviders(
  providers: Array<{
    agent: string
    lane: string
    provider: string
    model: string
    source: string
    readiness: string
    credential: string
    detail?: string
  }>,
  agents = ["slugger"],
): ReturnType<typeof runningDaemonStatusResponse> {
  const response = runningDaemonStatusResponse()
  return {
    ...response,
    data: {
      ...(response.data as Record<string, unknown>),
      agents: agents.map((name) => ({ name, enabled: true })),
      providers,
      sync: [],
    },
  }
}

function setProviderCredentialPool(
  agentName: string,
  providers: Record<string, { credentials?: Record<string, string | number>; config?: Record<string, string | number>; revision?: string }>,
): void {
  const now = "2026-04-13T00:00:00.000Z"
  mockProviderCredentials.pools.set(agentName, {
    ok: true,
    poolPath: `vault:${agentName}:providers/*`,
    pool: {
      schemaVersion: 1,
      updatedAt: now,
      providers: Object.fromEntries(Object.entries(providers).map(([provider, record]) => [
        provider,
        {
          provider,
          revision: record.revision ?? `cred_${provider}`,
          updatedAt: now,
          credentials: record.credentials ?? {},
          config: record.config ?? {},
          provenance: { source: "auth-flow", updatedAt: now },
        },
      ])),
    },
  })
}

describe("ouro CLI parsing", () => {
  it("parses primary daemon commands", () => {
    expect(parseOuroCommand([])).toEqual({ kind: "daemon.up" })
    expect(parseOuroCommand(["up"])).toEqual({ kind: "daemon.up" })
    expect(parseOuroCommand(["stop"])).toEqual({ kind: "daemon.stop" })
    expect(parseOuroCommand(["down"])).toEqual({ kind: "daemon.stop" })
    expect(parseOuroCommand(["status"])).toEqual({ kind: "daemon.status" })
    expect(parseOuroCommand(["status", "--json"])).toEqual({ kind: "daemon.status", json: true })
    expect(parseOuroCommand(["logs"])).toEqual({ kind: "daemon.logs" })
    expect(parseOuroCommand(["logs", "prune"])).toEqual({ kind: "daemon.logs.prune" })
    expect(parseOuroCommand(["mailbox"])).toEqual({ kind: "mailbox" })
    expect(parseOuroCommand(["mailbox", "--json"])).toEqual({ kind: "mailbox", json: true })
    expect(parseOuroCommand(["outlook"])).toEqual({ kind: "mailbox" })
    expect(parseOuroCommand(["outlook", "--json"])).toEqual({ kind: "mailbox", json: true })
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

  it("rejects unsupported status flag combinations", () => {
    expect(() => parseOuroCommand(["status", "--bogus"])).toThrow("Usage: ouro status [--json] OR ouro status --agent <name>")
    expect(() => parseOuroCommand(["status", "--agent", "slugger", "--json"])).toThrow(
      "Usage: ouro status [--json] OR ouro status --agent <name>",
    )
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

    expect(parseOuroCommand(["auth"])).toEqual({
      kind: "auth.run",
    })
    expect(() => parseOuroCommand(["auth", "--agent", "slugger", "--provider", "not-real"])).toThrow("Usage")
  })

  it("parses auth verify and auth switch subcommands", () => {
    expect(parseOuroCommand(["auth", "verify"])).toEqual({
      kind: "auth.verify",
    })
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
    expect(parseOuroCommand(["auth", "switch", "--provider", "github-copilot"])).toEqual({
      kind: "auth.switch",
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
    expect(parseOuroCommand(["chat"])).toEqual({ kind: "chat.connect", agent: "" })
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
      sendCommand: sendCommandWithRunningStatus(),
      startDaemonProcess: vi.fn(async () => ({ pid: 12345 })),
      writeStdout: vi.fn(),
      checkSocketAlive: vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(false).mockResolvedValue(true),
      cleanupStaleSocket: vi.fn(),
      fallbackPendingMessage: vi.fn(() => "/tmp/pending.jsonl"),
    }

    const result = await runOuroCli(["up"], deps)

    expect(result).toContain("daemon started")
    expect(deps.startDaemonProcess).toHaveBeenCalledWith("/tmp/ouro-test.sock")
    expect(deps.sendCommand).toHaveBeenCalledWith("/tmp/ouro-test.sock", { kind: "daemon.status" })
  })

  it("fails `up` when the daemon socket dies before final handoff", async () => {
    const writeStdout = vi.fn()
    const deps: OuroCliDeps = {
      socketPath: "/tmp/ouro-test.sock",
      sendCommand: sendCommandWithRunningStatus(),
      startDaemonProcess: vi.fn(async () => ({ pid: 12345 })),
      writeStdout,
      checkSocketAlive: vi.fn()
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(false),
      cleanupStaleSocket: vi.fn(),
      fallbackPendingMessage: vi.fn(() => "/tmp/pending.jsonl"),
      readRecentDaemonLogLines: vi.fn(() => ["daemon crashed hard"]),
    }

    const result = await runOuroCli(["up"], deps)

    expect(result).toContain("background service stopped before boot finished")
    expect(result).toContain("the daemon socket is no longer answering")
    expect(result).toContain("recent daemon logs:")
    expect(result).toContain("daemon crashed hard")
    expect(deps.sendCommand).not.toHaveBeenCalledWith("/tmp/ouro-test.sock", { kind: "daemon.status" })
    expect(writeStdout).toHaveBeenCalledWith(expect.stringContaining("background service stopped before boot finished"))
  })

  it("fails `up` when final daemon status does not answer cleanly", async () => {
    const writeStdout = vi.fn()
    const deps: OuroCliDeps = {
      socketPath: "/tmp/ouro-test.sock",
      sendCommand: vi.fn(async (_socketPath, command) => {
        if (command.kind === "daemon.status") {
          return { ok: false }
        }
        return { ok: true, summary: "ok" }
      }),
      startDaemonProcess: vi.fn(async () => ({ pid: 12345 })),
      writeStdout,
      checkSocketAlive: vi.fn()
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(true),
      cleanupStaleSocket: vi.fn(),
      fallbackPendingMessage: vi.fn(() => "/tmp/pending.jsonl"),
    }

    const result = await runOuroCli(["up"], deps)

    expect(result).toContain("background service stopped before boot finished")
    expect(result).toContain("daemon status did not answer cleanly")
    expect(writeStdout).toHaveBeenCalledWith(expect.stringContaining("daemon status did not answer cleanly"))
  })

  it("fails `up` when final daemon status reports a non-running state", async () => {
    const writeStdout = vi.fn()
    const deps: OuroCliDeps = {
      socketPath: "/tmp/ouro-test.sock",
      sendCommand: vi.fn(async (_socketPath, command) => {
        if (command.kind === "daemon.status") {
          return {
            ok: true,
            data: {
              overview: {
                daemon: "stopped",
                health: "warn",
                socketPath: "/tmp/ouro-test.sock",
                version: PACKAGE_VERSION.version,
                workerCount: 0,
                senseCount: 0,
              },
              senses: [],
              workers: [],
            },
          }
        }
        return { ok: true, summary: "ok" }
      }),
      startDaemonProcess: vi.fn(async () => ({ pid: 12345 })),
      writeStdout,
      checkSocketAlive: vi.fn()
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(true),
      cleanupStaleSocket: vi.fn(),
      fallbackPendingMessage: vi.fn(() => "/tmp/pending.jsonl"),
    }

    const result = await runOuroCli(["up"], deps)

    expect(result).toContain("background service stopped before boot finished")
    expect(result).toContain("the daemon reported state stopped")
    expect(writeStdout).toHaveBeenCalledWith(expect.stringContaining("the daemon reported state stopped"))
  })

  it("reports a single worker still answering during final daemon handoff", async () => {
    const writeStdout = vi.fn()
    const deps: OuroCliDeps = {
      socketPath: "/tmp/ouro-test.sock",
      sendCommand: vi.fn(async (_socketPath, command) => {
        if (command.kind === "daemon.status") {
          return {
            ok: true,
            data: {
              overview: {
                daemon: "running",
                health: "ok",
                socketPath: "/tmp/ouro-test.sock",
                version: PACKAGE_VERSION.version,
                workerCount: 1,
                senseCount: 0,
              },
              senses: [],
              workers: [{
                agent: "slugger",
                worker: "inner-dialog",
                status: "running",
                pid: 7777,
                restartCount: 0,
                lastExitCode: null,
                lastSignal: null,
                startedAt: null,
                errorReason: null,
                fixHint: null,
              }],
            },
          }
        }
        return { ok: true, summary: "ok" }
      }),
      startDaemonProcess: vi.fn(async () => ({ pid: 12345 })),
      writeStdout,
      checkSocketAlive: vi.fn()
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(true),
      cleanupStaleSocket: vi.fn(),
      fallbackPendingMessage: vi.fn(() => "/tmp/pending.jsonl"),
    }

    const result = await runOuroCli(["up"], deps)
    const output = writeStdout.mock.calls.map((call) => String(call[0])).join("")

    expect(result).toContain("daemon started")
    expect(output).toContain("1 worker still answering")
  })

  it("reports multiple workers still answering during final daemon handoff", async () => {
    const writeStdout = vi.fn()
    const deps: OuroCliDeps = {
      socketPath: "/tmp/ouro-test.sock",
      sendCommand: vi.fn(async (_socketPath, command) => {
        if (command.kind === "daemon.status") {
          return {
            ok: true,
            data: {
              overview: {
                daemon: "running",
                health: "ok",
                socketPath: "/tmp/ouro-test.sock",
                version: PACKAGE_VERSION.version,
                workerCount: 2,
                senseCount: 0,
              },
              senses: [],
              workers: [
                {
                  agent: "slugger",
                  worker: "inner-dialog",
                  status: "running",
                  pid: 7777,
                  restartCount: 0,
                  lastExitCode: null,
                  lastSignal: null,
                  startedAt: null,
                  errorReason: null,
                  fixHint: null,
                },
                {
                  agent: "ouroboros",
                  worker: "inner-dialog",
                  status: "running",
                  pid: 8888,
                  restartCount: 0,
                  lastExitCode: null,
                  lastSignal: null,
                  startedAt: null,
                  errorReason: null,
                  fixHint: null,
                },
              ],
            },
          }
        }
        return { ok: true, summary: "ok" }
      }),
      startDaemonProcess: vi.fn(async () => ({ pid: 12345 })),
      writeStdout,
      checkSocketAlive: vi.fn()
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(true),
      cleanupStaleSocket: vi.fn(),
      fallbackPendingMessage: vi.fn(() => "/tmp/pending.jsonl"),
    }

    const result = await runOuroCli(["up"], deps)
    const output = writeStdout.mock.calls.map((call) => String(call[0])).join("")

    expect(result).toContain("daemon started")
    expect(output).toContain("2 workers still answering")
  })

  it("fails `up` when the final daemon status probe throws an Error", async () => {
    const writeStdout = vi.fn()
    const deps: OuroCliDeps = {
      socketPath: "/tmp/ouro-test.sock",
      sendCommand: vi.fn(async (_socketPath, command) => {
        if (command.kind === "daemon.status") {
          throw new Error("status probe exploded")
        }
        return { ok: true, summary: "ok" }
      }),
      startDaemonProcess: vi.fn(async () => ({ pid: 12345 })),
      writeStdout,
      checkSocketAlive: vi.fn()
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(true),
      cleanupStaleSocket: vi.fn(),
      fallbackPendingMessage: vi.fn(() => "/tmp/pending.jsonl"),
    }

    const result = await runOuroCli(["up"], deps)

    expect(result).toContain("background service stopped before boot finished")
    expect(result).toContain("status probe exploded")
    expect(writeStdout).toHaveBeenCalledWith(expect.stringContaining("status probe exploded"))
  })

  it("fails `up` when the final daemon status probe throws a non-Error value", async () => {
    const writeStdout = vi.fn()
    const deps: OuroCliDeps = {
      socketPath: "/tmp/ouro-test.sock",
      sendCommand: vi.fn(async (_socketPath, command) => {
        if (command.kind === "daemon.status") {
          throw "string-status-probe-failure"
        }
        return { ok: true, summary: "ok" }
      }),
      startDaemonProcess: vi.fn(async () => ({ pid: 12345 })),
      writeStdout,
      checkSocketAlive: vi.fn()
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(true),
      cleanupStaleSocket: vi.fn(),
      fallbackPendingMessage: vi.fn(() => "/tmp/pending.jsonl"),
    }

    const result = await runOuroCli(["up"], deps)

    expect(result).toContain("background service stopped before boot finished")
    expect(result).toContain("string-status-probe-failure")
    expect(writeStdout).toHaveBeenCalledWith(expect.stringContaining("string-status-probe-failure"))
  })

  it("marks `ouro up` as failed at the shell level when daemon startup never answers", async () => {
    let nowMs = Date.parse("2026-04-10T05:02:36.000Z")
    const sleep = vi.fn(async (ms: number) => {
      nowMs += ms
    })
    const setExitCode = vi.fn()
    const deps = {
      socketPath: "/tmp/ouro-test.sock",
      sendCommand: vi.fn(async () => ({ ok: true, summary: "ok" })),
      startDaemonProcess: vi.fn(async () => ({ pid: 5184 })),
      writeStdout: vi.fn(),
      setExitCode,
      checkSocketAlive: vi.fn(async () => false),
      cleanupStaleSocket: vi.fn(),
      fallbackPendingMessage: vi.fn(() => "/tmp/pending.jsonl"),
      sleep,
      now: () => nowMs,
      startupPollIntervalMs: 5,
      startupTimeoutMs: 20,
      startupRetryLimit: 0,
    } as OuroCliDeps & {
      sleep: typeof sleep
      now: () => number
      startupPollIntervalMs: number
      startupTimeoutMs: number
      startupRetryLimit: number
    }

    const result = await runOuroCli(["up"], deps)

    expect(result).toContain("did not finish booting")
    expect(setExitCode).toHaveBeenCalledWith(1)
  })

  it("runs `auth` locally with provider autodetected from agent.json", async () => {
    const tmp = createTmpBundle({
      agentName: "auth-local",
      agentJson: {
        version: 2,
        enabled: true,
        provider: "anthropic",
        humanFacing: { provider: "anthropic", model: "claude-opus-4-6" },
        agentFacing: { provider: "anthropic", model: "claude-opus-4-6" },
        phrases: { thinking: ["working"], tool: ["running tool"], followup: ["processing"] },
      },
    })

    const runAuthFlow = vi.fn(async () => ({ message: `authenticated ${tmp.agentName} with anthropic` }))
    const deps = {
      socketPath: "/tmp/ouro-test.sock",
      sendCommand: vi.fn(async () => ({ ok: true, message: "unexpected daemon call" })),
      startDaemonProcess: vi.fn(async () => ({ pid: 1 })),
      writeStdout: vi.fn(),
      checkSocketAlive: vi.fn(async () => true),
      cleanupStaleSocket: vi.fn(),
      fallbackPendingMessage: vi.fn(() => "/tmp/pending.jsonl"),
      bundlesRoot: tmp.bundlesRoot,
      runAuthFlow,
    } as OuroCliDeps & {
      runAuthFlow: typeof runAuthFlow
    }

    try {
      const result = await runOuroCli(["auth", "--agent", tmp.agentName], deps)

      expect(result).toBe(`authenticated ${tmp.agentName} with anthropic`)
      expect(runAuthFlow).toHaveBeenCalledWith(expect.objectContaining({
        agentName: tmp.agentName,
        provider: "anthropic",
        onProgress: expect.any(Function),
      }))
      const output = deps.writeStdout.mock.calls.map((call) => String(call[0])).join("")
      expect(output).toContain("... authenticating anthropic")
      expect(output).toContain("✓ authenticating anthropic")
      expect(output).toContain("... verifying anthropic")
      expect(deps.sendCommand).not.toHaveBeenCalled()
    } finally {
      tmp.cleanup()
    }
  })

  it("runs `auth` locally for the only discovered agent when --agent is omitted", async () => {
    const tmp = createTmpBundle({
      agentName: "auth-single",
      agentJson: {
        version: 2,
        enabled: true,
        provider: "anthropic",
        humanFacing: { provider: "anthropic", model: "claude-opus-4-6" },
        agentFacing: { provider: "anthropic", model: "claude-opus-4-6" },
        phrases: { thinking: ["working"], tool: ["running tool"], followup: ["processing"] },
      },
    })

    const runAuthFlow = vi.fn(async () => ({ message: `authenticated ${tmp.agentName} with minimax` }))
    const deps = {
      socketPath: "/tmp/ouro-test.sock",
      sendCommand: vi.fn(async () => ({ ok: true, message: "unexpected daemon call" })),
      startDaemonProcess: vi.fn(async () => ({ pid: 1 })),
      writeStdout: vi.fn(),
      checkSocketAlive: vi.fn(async () => true),
      cleanupStaleSocket: vi.fn(),
      fallbackPendingMessage: vi.fn(() => "/tmp/pending.jsonl"),
      bundlesRoot: tmp.bundlesRoot,
      listDiscoveredAgents: vi.fn(async () => [tmp.agentName]),
      runAuthFlow,
    } as OuroCliDeps & {
      listDiscoveredAgents: () => Promise<string[]>
      runAuthFlow: typeof runAuthFlow
    }

    try {
      const result = await runOuroCli(["auth", "--provider", "minimax"], deps)

      expect(result).toBe(`authenticated ${tmp.agentName} with minimax`)
      expect(runAuthFlow).toHaveBeenCalledWith(expect.objectContaining({
        agentName: tmp.agentName,
        provider: "minimax",
      }))
    } finally {
      tmp.cleanup()
    }
  })

  it("asks for an agent when auth omits --agent and multiple agents are available", async () => {
    const runAuthFlow = vi.fn(async () => ({ message: "authenticated ouroboros with minimax" }))
    const deps = {
      socketPath: "/tmp/ouro-test.sock",
      sendCommand: vi.fn(async () => ({ ok: true, message: "unexpected daemon call" })),
      startDaemonProcess: vi.fn(async () => ({ pid: 1 })),
      writeStdout: vi.fn(),
      checkSocketAlive: vi.fn(async () => true),
      cleanupStaleSocket: vi.fn(),
      fallbackPendingMessage: vi.fn(() => "/tmp/pending.jsonl"),
      listDiscoveredAgents: vi.fn(async () => ["slugger", "ouroboros"]),
      promptInput: vi.fn(async () => "2"),
      runAuthFlow,
    } as OuroCliDeps & {
      listDiscoveredAgents: () => Promise<string[]>
      promptInput: (question: string) => Promise<string>
      runAuthFlow: typeof runAuthFlow
    }

    const result = await runOuroCli(["auth", "--provider", "minimax"], deps)

    expect(result).toBe("authenticated ouroboros with minimax")
    expect(deps.promptInput).toHaveBeenCalledWith(expect.stringContaining("Which agent should this use?"))
    expect(runAuthFlow).toHaveBeenCalledWith(expect.objectContaining({
      agentName: "ouroboros",
      provider: "minimax",
    }))
  })

  it("keeps auth progress visible when the provider auth flow fails", async () => {
    const tmp = createTmpBundle({
      agentName: "auth-error",
      agentJson: {
        version: 2,
        enabled: true,
        provider: "anthropic",
        humanFacing: { provider: "anthropic", model: "claude-opus-4-6" },
        agentFacing: { provider: "anthropic", model: "claude-opus-4-6" },
        phrases: { thinking: ["working"], tool: ["running tool"], followup: ["processing"] },
      },
    })

    const runAuthFlow = vi.fn(async (input: { onProgress?: (message: string) => void }) => {
      input.onProgress?.("opening browser login")
      throw new Error("auth service down")
    })
    const deps = {
      socketPath: "/tmp/ouro-test.sock",
      sendCommand: vi.fn(async () => ({ ok: true, message: "unexpected daemon call" })),
      startDaemonProcess: vi.fn(async () => ({ pid: 1 })),
      writeStdout: vi.fn(),
      checkSocketAlive: vi.fn(async () => true),
      cleanupStaleSocket: vi.fn(),
      fallbackPendingMessage: vi.fn(() => "/tmp/pending.jsonl"),
      bundlesRoot: tmp.bundlesRoot,
      runAuthFlow,
    } as OuroCliDeps & {
      runAuthFlow: typeof runAuthFlow
    }

    try {
      await expect(runOuroCli(["auth", "--agent", tmp.agentName], deps)).rejects.toThrow("auth service down")

      const output = deps.writeStdout.mock.calls.map((call) => String(call[0])).join("")
      expect(output).toContain("... authenticating anthropic")
      expect(output).toContain("opening browser login")
      expect(output).not.toContain("✓ authenticating anthropic")
      expect(deps.sendCommand).not.toHaveBeenCalled()
    } finally {
      tmp.cleanup()
    }
  })

  it("ouro auth --provider stores credentials without switching provider", async () => {
    const tmp = createTmpBundle({
      agentName: "auth-store",
      agentJson: {
        version: 2,
        enabled: true,
        provider: "anthropic",
        humanFacing: { provider: "anthropic", model: "claude-opus-4-6" },
        agentFacing: { provider: "anthropic", model: "claude-opus-4-6" },
        phrases: { thinking: ["working"], tool: ["running tool"], followup: ["processing"] },
      },
    })

    const runAuthFlow = vi.fn(async () => ({ message: `authenticated ${tmp.agentName} with openai-codex` }))
    const deps = {
      socketPath: "/tmp/ouro-test.sock",
      sendCommand: vi.fn(async () => ({ ok: true, message: "unexpected daemon call" })),
      startDaemonProcess: vi.fn(async () => ({ pid: 1 })),
      writeStdout: vi.fn(),
      checkSocketAlive: vi.fn(async () => true),
      cleanupStaleSocket: vi.fn(),
      fallbackPendingMessage: vi.fn(() => "/tmp/pending.jsonl"),
      bundlesRoot: tmp.bundlesRoot,
      runAuthFlow,
    } as OuroCliDeps & {
      runAuthFlow: typeof runAuthFlow
    }

    try {
      const result = await runOuroCli(["auth", "--agent", tmp.agentName, "--provider", "openai-codex"], deps)

      expect(result).toBe(`authenticated ${tmp.agentName} with openai-codex`)
      expect(runAuthFlow).toHaveBeenCalledWith(expect.objectContaining({
        agentName: tmp.agentName,
        provider: "openai-codex",
        onProgress: expect.any(Function),
      }))
      const output = deps.writeStdout.mock.calls.map((call) => String(call[0])).join("")
      expect(output).toContain("... authenticating openai-codex")
      expect(output).toContain("✓ authenticating openai-codex")
      expect(output).toContain("... verifying openai-codex")
      // Behavior change: auth stores credentials but does NOT switch
      const updated = JSON.parse(fs.readFileSync(tmp.agentConfigPath, "utf-8")) as { provider: string }
      expect(updated.provider).toBe("anthropic")
      expect(deps.sendCommand).not.toHaveBeenCalled()
    } finally {
      tmp.cleanup()
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

    vi.doMock("../../../heart/auth/auth-flow", async () => {
      const actual = await vi.importActual<typeof import("../../../heart/auth/auth-flow")>("../../../heart/auth/auth-flow")
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
      expect(readAgentConfigForAgent).toHaveBeenCalledWith("slugger", undefined)
      expect(defaultRunRuntimeAuthFlow).toHaveBeenCalledWith({
        agentName: "slugger",
        provider: "minimax",
        promptInput: deps.promptInput,
        onProgress: expect.any(Function),
      })
      const output = (deps.writeStdout as ReturnType<typeof vi.fn>).mock.calls.map((call) => String(call[0])).join("")
      expect(output).toContain("... authenticating minimax")
      expect(output).toContain("✓ authenticating minimax")
      expect(output).toContain("... verifying minimax")
      expect(writeAgentProviderSelection).not.toHaveBeenCalled()
    } finally {
      vi.doUnmock("../../../heart/auth/auth-flow")
      vi.resetModules()
    }
  })

  it("ouro auth --provider stores credentials but does NOT switch provider", async () => {
    const tmp = createTmpBundle({
      agentName: "auth-no-switch",
      agentJson: {
        version: 2, enabled: true, provider: "anthropic",
        humanFacing: { provider: "anthropic", model: "claude-opus-4-6" },
        agentFacing: { provider: "anthropic", model: "claude-opus-4-6" },
        phrases: { thinking: ["working"], tool: ["running tool"], followup: ["processing"] },
      },
    })
    const runAuthFlow = vi.fn(async () => ({ message: `authenticated ${tmp.agentName} with github-copilot` }))
    const deps = {
      socketPath: "/tmp/ouro-test.sock",
      sendCommand: vi.fn(async () => ({ ok: true, message: "ok" })),
      startDaemonProcess: vi.fn(async () => ({ pid: 1 })),
      writeStdout: vi.fn(),
      checkSocketAlive: vi.fn(async () => true),
      cleanupStaleSocket: vi.fn(),
      fallbackPendingMessage: vi.fn(() => "/tmp/pending.jsonl"),
      bundlesRoot: tmp.bundlesRoot,
      runAuthFlow,
    } as OuroCliDeps & { runAuthFlow: typeof runAuthFlow }
    try {
      await runOuroCli(["auth", "--agent", tmp.agentName, "--provider", "github-copilot"], deps)
      const updated = JSON.parse(fs.readFileSync(tmp.agentConfigPath, "utf-8")) as { provider: string }
      expect(updated.provider).toBe("anthropic")
    } finally {
      tmp.cleanup()
    }
  })

  it("ouro auth verify reports provider status", async () => {
    const tmp = createTmpBundle({
      agentName: "auth-verify",
      agentJson: {
        version: 2, enabled: true, provider: "anthropic",
        humanFacing: { provider: "anthropic", model: "claude-opus-4-6" },
        agentFacing: { provider: "anthropic", model: "claude-opus-4-6" },
        phrases: { thinking: ["working"], tool: ["running tool"], followup: ["processing"] },
      },
    })
    const deps: OuroCliDeps = {
      socketPath: "/tmp/ouro-test.sock",
      sendCommand: vi.fn(async () => ({ ok: true, message: "ok" })),
      startDaemonProcess: vi.fn(async () => ({ pid: 1 })),
      writeStdout: vi.fn(),
      checkSocketAlive: vi.fn(async () => true),
      cleanupStaleSocket: vi.fn(),
      fallbackPendingMessage: vi.fn(() => "/tmp/pending.jsonl"),
      bundlesRoot: tmp.bundlesRoot,
    }
    try {
      setProviderCredentialPool(tmp.agentName, {
        anthropic: { credentials: { setupToken: "sk-ant-test" } },
      })
      const result = await runOuroCli(["auth", "verify", "--agent", tmp.agentName], deps)
      expect(typeof result).toBe("string")
      expect(result).toContain("anthropic")
      const output = vi.mocked(deps.writeStdout).mock.calls.map(([text]) => text).join("\n")
      expect(output).toContain("... reading provider credentials")
      expect(output).toContain(`reading vault items for ${tmp.agentName}...`)
      expect(output).toContain("✓ reading provider credentials")
      expect(output).toContain("... verifying providers")
      expect(output).toContain("✓ verifying providers")
    } finally {
      tmp.cleanup()
    }
  })

  it("ouro auth verify renders a shared provider health board in TTY mode", async () => {
    const { pingProvider } = await import("../../../heart/provider-ping")
    vi.mocked(pingProvider).mockResolvedValueOnce({
      ok: false,
      classification: "auth-failure",
      message: "token expired",
    })
    const tmp = createTmpBundle({
      agentName: "auth-verify-board",
      agentJson: {
        version: 2, enabled: true, provider: "openai-codex",
        humanFacing: { provider: "openai-codex", model: "gpt-5.4" },
        agentFacing: { provider: "openai-codex", model: "gpt-5.4" },
        phrases: { thinking: ["working"], tool: ["running tool"], followup: ["processing"] },
      },
    })
    const deps: OuroCliDeps = {
      socketPath: "/tmp/ouro-test.sock",
      sendCommand: vi.fn(async () => ({ ok: true, message: "ok" })),
      startDaemonProcess: vi.fn(async () => ({ pid: 1 })),
      writeStdout: vi.fn(),
      checkSocketAlive: vi.fn(async () => true),
      cleanupStaleSocket: vi.fn(),
      fallbackPendingMessage: vi.fn(() => "/tmp/pending.jsonl"),
      bundlesRoot: tmp.bundlesRoot,
      isTTY: true,
      stdoutColumns: 74,
    }
    try {
      setProviderCredentialPool(tmp.agentName, {
        "openai-codex": { credentials: { oauthAccessToken: "expired-token" } },
      })
      const result = await runOuroCli(["auth", "verify", "--agent", tmp.agentName], deps)
      expect(result).toContain("___    _   _")
      expect(result).toContain("Provider health")
      expect(result).toContain("openai-codex")
      expect(result).toContain("failed (token expired)")
      expect(result).toContain("ouro auth --agent auth-verify-board --provider openai-codex")
      expect(result).toContain("[human required]")
    } finally {
      tmp.cleanup()
    }
  })

  it("ouro auth switch updates local provider state instead of agent.json", async () => {
    const tmp = createTmpBundle({
      agentName: "auth-switch-new",
      agentJson: {
        version: 2, enabled: true, provider: "anthropic",
        humanFacing: { provider: "anthropic", model: "claude-opus-4-6" },
        agentFacing: { provider: "anthropic", model: "claude-opus-4-6" },
        phrases: { thinking: ["working"], tool: ["running tool"], followup: ["processing"] },
      },
    })
    const deps: OuroCliDeps = {
      socketPath: "/tmp/ouro-test.sock",
      sendCommand: vi.fn(async () => ({ ok: true, message: "ok" })),
      startDaemonProcess: vi.fn(async () => ({ pid: 1 })),
      writeStdout: vi.fn(),
      checkSocketAlive: vi.fn(async () => true),
      cleanupStaleSocket: vi.fn(),
      fallbackPendingMessage: vi.fn(() => "/tmp/pending.jsonl"),
      bundlesRoot: tmp.bundlesRoot,
    }
    try {
      const result = await runOuroCli(["auth", "switch", "--agent", tmp.agentName, "--provider", "github-copilot"], deps)
      expect(result).toContain("switched")
      expect(result).toContain("github-copilot")
      const updated = JSON.parse(fs.readFileSync(tmp.agentConfigPath, "utf-8")) as any
      expect(updated.humanFacing.provider).toBe("anthropic")
      expect(updated.agentFacing.provider).toBe("anthropic")
      const stateResult = readProviderState(tmp.agentRoot)
      expect(stateResult.ok).toBe(true)
      if (!stateResult.ok) throw new Error(stateResult.error)
      expect(stateResult.state.lanes.outward.provider).toBe("github-copilot")
      expect(stateResult.state.lanes.inner.provider).toBe("github-copilot")
    } finally {
      tmp.cleanup()
    }
  })

  it("ouro auth --switch flag form updates local provider state instead of agent.json", async () => {
    const tmp = createTmpBundle({
      agentName: "auth-flag-switch",
      agentJson: {
        version: 2, enabled: true, provider: "openai-codex",
        humanFacing: { provider: "openai-codex", model: "gpt-5.4" },
        agentFacing: { provider: "openai-codex", model: "gpt-5.4" },
        phrases: { thinking: ["working"], tool: ["running tool"], followup: ["processing"] },
      },
    })
    const deps: OuroCliDeps = {
      socketPath: "/tmp/ouro-test.sock",
      sendCommand: vi.fn(async () => ({ ok: true, message: "ok" })),
      startDaemonProcess: vi.fn(async () => ({ pid: 1 })),
      writeStdout: vi.fn(),
      checkSocketAlive: vi.fn(async () => true),
      cleanupStaleSocket: vi.fn(),
      fallbackPendingMessage: vi.fn(() => "/tmp/pending.jsonl"),
      bundlesRoot: tmp.bundlesRoot,
    }
    try {
      const result = await runOuroCli(["auth", "--switch", "--agent", tmp.agentName, "--provider", "github-copilot"], deps)
      expect(result).toContain("switched")
      expect(result).toContain("github-copilot")
      const updated = JSON.parse(fs.readFileSync(tmp.agentConfigPath, "utf-8")) as any
      expect(updated.humanFacing.provider).toBe("openai-codex")
      expect(updated.agentFacing.provider).toBe("openai-codex")
      const stateResult = readProviderState(tmp.agentRoot)
      expect(stateResult.ok).toBe(true)
      if (!stateResult.ok) throw new Error(stateResult.error)
      expect(stateResult.state.lanes.outward.provider).toBe("github-copilot")
      expect(stateResult.state.lanes.inner.provider).toBe("github-copilot")
    } finally {
      tmp.cleanup()
    }
  })

  it("ouro auth verify uses pingProvider for github-copilot", async () => {
    const tmp = createTmpBundle({
      agentName: "auth-verify-ghcp",
      agentJson: {
        version: 2, enabled: true, provider: "github-copilot",
        humanFacing: { provider: "github-copilot", model: "claude-sonnet-4.6" },
        agentFacing: { provider: "github-copilot", model: "claude-sonnet-4.6" },
        phrases: { thinking: ["working"], tool: ["running tool"], followup: ["processing"] },
      },
    })
    const deps: OuroCliDeps = {
      socketPath: "/tmp/ouro-test.sock",
      sendCommand: vi.fn(async () => ({ ok: true, message: "ok" })),
      startDaemonProcess: vi.fn(async () => ({ pid: 1 })),
      writeStdout: vi.fn(),
      checkSocketAlive: vi.fn(async () => true),
      cleanupStaleSocket: vi.fn(),
      fallbackPendingMessage: vi.fn(() => "/tmp/pending.jsonl"),
      bundlesRoot: tmp.bundlesRoot,
    }
    try {
      setProviderCredentialPool(tmp.agentName, {
        "github-copilot": {
          credentials: { githubToken: "ghp_valid_token" },
          config: { baseUrl: "https://api.test.com" },
        },
      })
      // pingProvider is mocked to return { ok: true } at the top of this file
      const result = await runOuroCli(["auth", "verify", "--agent", tmp.agentName, "--provider", "github-copilot"], deps)
      expect(result).toBe("github-copilot: ok")
      const output = vi.mocked(deps.writeStdout).mock.calls.map(([text]) => text).join("\n")
      expect(output).toContain("... reading provider credentials")
      expect(output).toContain("✓ reading provider credentials")
      expect(output).toContain("... verifying github-copilot")
      expect(output).toContain("✓ verifying github-copilot")
    } finally {
      tmp.cleanup()
    }
  })

  it("ouro auth verify reports failure from pingProvider", async () => {
    const { pingProvider } = await import("../../../heart/provider-ping")
    vi.mocked(pingProvider).mockResolvedValueOnce({ ok: false, classification: "auth-failure", message: "token expired" })
    const tmp = createTmpBundle({
      agentName: "auth-verify-ghcp-fail",
      agentJson: {
        version: 2, enabled: true, provider: "github-copilot",
        humanFacing: { provider: "github-copilot", model: "claude-sonnet-4.6" },
        agentFacing: { provider: "github-copilot", model: "claude-sonnet-4.6" },
        phrases: { thinking: ["working"], tool: ["running tool"], followup: ["processing"] },
      },
    })
    const deps: OuroCliDeps = {
      socketPath: "/tmp/ouro-test.sock",
      sendCommand: vi.fn(async () => ({ ok: true, message: "ok" })),
      startDaemonProcess: vi.fn(async () => ({ pid: 1 })),
      writeStdout: vi.fn(),
      checkSocketAlive: vi.fn(async () => true),
      cleanupStaleSocket: vi.fn(),
      fallbackPendingMessage: vi.fn(() => "/tmp/pending.jsonl"),
      bundlesRoot: tmp.bundlesRoot,
    }
    try {
      setProviderCredentialPool(tmp.agentName, {
        "github-copilot": {
          credentials: { githubToken: "ghp_expired" },
          config: { baseUrl: "https://api.test.com" },
        },
      })
      const result = await runOuroCli(["auth", "verify", "--agent", tmp.agentName, "--provider", "github-copilot"], deps)
      expect(result).toBe("github-copilot: failed (token expired)")
    } finally {
      tmp.cleanup()
    }
  })

  it("ouro auth verify checks all providers when no --provider given", async () => {
    const tmp = createTmpBundle({
      agentName: "auth-verify-all",
      agentJson: {
        version: 2, enabled: true, provider: "anthropic",
        humanFacing: { provider: "anthropic", model: "claude-opus-4-6" },
        agentFacing: { provider: "anthropic", model: "claude-opus-4-6" },
        phrases: { thinking: ["working"], tool: ["running tool"], followup: ["processing"] },
      },
    })
    const deps: OuroCliDeps = {
      socketPath: "/tmp/ouro-test.sock",
      sendCommand: vi.fn(async () => ({ ok: true, message: "ok" })),
      startDaemonProcess: vi.fn(async () => ({ pid: 1 })),
      writeStdout: vi.fn(),
      checkSocketAlive: vi.fn(async () => true),
      cleanupStaleSocket: vi.fn(),
      fallbackPendingMessage: vi.fn(() => "/tmp/pending.jsonl"),
      bundlesRoot: tmp.bundlesRoot,
    }
    try {
      setProviderCredentialPool(tmp.agentName, {
        azure: { credentials: { apiKey: "az-key" }, config: { endpoint: "https://az.test.com" } },
        minimax: { credentials: {} },
        anthropic: { credentials: { setupToken: "sk-ant-abc" } },
        "openai-codex": { credentials: { oauthAccessToken: "tok" } },
        "github-copilot": {
          credentials: { githubToken: "ghp_test" },
          config: { baseUrl: "https://api.test.com" },
        },
      })
      // pingProvider is mocked to return { ok: true } — all providers with creds pass
      const result = await runOuroCli(["auth", "verify", "--agent", tmp.agentName], deps)
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
      tmp.cleanup()
    }
  })

  it("is idempotent for `up` when daemon already running", async () => {
    const deps: OuroCliDeps = {
      socketPath: "/tmp/ouro-test.sock",
      sendCommand: sendCommandWithRunningStatus(),
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
      sendCommand: sendCommandWithRunningStatus(),
      startDaemonProcess: vi.fn(async () => ({ pid: 4321 })),
      writeStdout: vi.fn(),
      checkSocketAlive: vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(false).mockResolvedValue(true),
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
      sendCommand: sendCommandWithRunningStatus(),
      startDaemonProcess: vi.fn(async () => ({ pid: 5678 })),
      writeStdout: vi.fn(),
      checkSocketAlive: vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(false).mockResolvedValue(true),
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
      sendCommand: sendCommandWithRunningStatus(),
      startDaemonProcess: vi.fn(async () => ({ pid: 6789 })),
      writeStdout: vi.fn(),
      checkSocketAlive: vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(false).mockResolvedValue(true),
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
      sendCommand: sendCommandWithRunningStatus(),
      startDaemonProcess: vi.fn(async () => ({ pid: 6790 })),
      writeStdout: vi.fn(),
      checkSocketAlive: vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(false).mockResolvedValue(true),
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

  it("renders tty status as a dense runtime cockpit instead of the generic board", async () => {
    const deps: OuroCliDeps = {
      socketPath: "/tmp/ouro-test.sock",
      sendCommand: vi.fn(async () => ({
        ok: true,
        summary: "daemon=running\tworkers=1\tsenses=0\thealth=ok",
        data: {
          overview: {
            daemon: "running",
            socketPath: "/tmp/ouro-test.sock",
            version: PACKAGE_VERSION.version,
            lastUpdated: "2026-04-19T20:10:00.000Z",
            workerCount: 1,
            senseCount: 0,
            health: "ok",
            mailboxUrl: "http://127.0.0.1:4310/mailbox",
            entryPath: "/usr/local/lib/node_modules/@ouro.bot/cli/dist/heart/daemon/daemon-entry.js",
            mode: "production",
          },
          senses: [],
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
      isTTY: true,
      stdoutColumns: 82,
    }

    const result = await runOuroCli(["status"], deps)

    expect(result).toContain("ouroboros daemon")
    expect(result).toContain("Socket")
    expect(result).toContain("Workers")
    expect(result).toContain("inner-dialog")
    expect(result).not.toContain("Ouro status")
    expect(result).not.toContain("What is running, what is stopped, and what needs attention.")
    expect(deps.writeStdout).toHaveBeenCalledWith(expect.stringContaining("ouroboros daemon"))
  })

  it("surfaces the Mailbox URL from daemon status and can fetch JSON from the same seam", async () => {
    const fetchImpl = vi.fn(async (target: string | URL | Request) => ({
      ok: true,
      status: 200,
      json: async () => ({ productName: "Ouro Mailbox", agentCount: 1 }),
      text: async () => JSON.stringify({ productName: "Ouro Mailbox", agentCount: 1 }, null, 2),
    }))
    const deps: OuroCliDeps = {
      socketPath: "/tmp/ouro-test.sock",
      sendCommand: vi.fn(async () => ({
        ok: true,
        data: {
          overview: {
            daemon: "running",
            socketPath: "/tmp/ouro-test.sock",
            version: PACKAGE_VERSION.version,
            lastUpdated: "2026-03-08T23:50:00.000Z",
            workerCount: 0,
            senseCount: 0,
            health: "ok",
            entryPath: "/usr/local/lib/node_modules/@ouro.bot/cli/dist/heart/daemon/daemon-entry.js",
            mode: "production",
            mailboxUrl: "http://127.0.0.1:4310/mailbox",
          },
          senses: [],
          workers: [],
        },
      })),
      startDaemonProcess: vi.fn(async () => ({ pid: 1 })),
      writeStdout: vi.fn(),
      checkSocketAlive: vi.fn(async () => true),
      cleanupStaleSocket: vi.fn(),
      fallbackPendingMessage: vi.fn(() => "/tmp/pending.jsonl"),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    }

    const urlResult = await runOuroCli(["mailbox"], deps)
    expect(urlResult).toContain("http://127.0.0.1:4310/mailbox")

    const jsonResult = await runOuroCli(["mailbox", "--json"], deps)
    expect(fetchImpl).toHaveBeenCalledWith("http://127.0.0.1:4310/mailbox/api/machine")
    expect(jsonResult).toContain("\"productName\": \"Ouro Mailbox\"")
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
          sync: [],
        },
      })),
      startDaemonProcess: vi.fn(async () => ({ pid: 1 })),
      writeStdout: vi.fn(),
      checkSocketAlive: vi.fn(async () => true),
      cleanupStaleSocket: vi.fn(),
      fallbackPendingMessage: vi.fn(() => "/tmp/pending.jsonl"),

    }

    const result = await runOuroCli(["status"], deps)

    expect(result).toContain("unknown")
    expect(result).toContain("unavailable")
    expect(result).toContain("Socket")
    expect(result).toContain("Health")
    expect(result).toContain("Mailbox")
    // With no sync rows, the Git Sync section is omitted entirely (matches Senses/Workers)
    expect(result).not.toContain("Git Sync")
  })

  it("renders daemon status as JSON when requested", async () => {
    const payload = {
      overview: {
        daemon: "running",
        socketPath: "/tmp/ouro-test.sock",
        version: PACKAGE_VERSION.version,
        lastUpdated: "2026-03-08T23:50:00.000Z",
        workerCount: 1,
        senseCount: 1,
        health: "ok",
        mailboxUrl: "http://127.0.0.1:4310/mailbox",
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
      ],
      workers: [
        {
          agent: "slugger",
          worker: "inner-dialog",
          status: "running",
          pid: 1234,
          restarts: 0,
        },
      ],
      sync: [],
      agents: [{ name: "slugger", enabled: true }],
    }
    const deps: OuroCliDeps = {
      socketPath: "/tmp/ouro-test.sock",
      sendCommand: vi.fn(async () => ({
        ok: true,
        summary: "daemon=running\tworkers=1\tsenses=1\thealth=ok",
        data: payload,
      })),
      startDaemonProcess: vi.fn(async () => ({ pid: 1 })),
      writeStdout: vi.fn(),
      checkSocketAlive: vi.fn(async () => true),
      cleanupStaleSocket: vi.fn(),
      fallbackPendingMessage: vi.fn(() => "/tmp/pending.jsonl"),
    }

    const result = await runOuroCli(["status", "--json"], deps)

    expect(JSON.parse(result)).toEqual(payload)
    expect(result).not.toContain("ouroboros daemon")
    expect(deps.writeStdout).toHaveBeenCalledWith(JSON.stringify(payload, null, 2))
  })

  it("renders daemon status metadata as JSON when the daemon omits status data", async () => {
    const deps: OuroCliDeps = {
      socketPath: "/tmp/ouro-test.sock",
      sendCommand: vi.fn(async () => ({
        ok: false,
        summary: "daemon=degraded",
        message: "provider lane degraded",
        error: "provider check failed",
      })),
      startDaemonProcess: vi.fn(async () => ({ pid: 1 })),
      writeStdout: vi.fn(),
      checkSocketAlive: vi.fn(async () => true),
      cleanupStaleSocket: vi.fn(),
      fallbackPendingMessage: vi.fn(() => "/tmp/pending.jsonl"),
    }

    const result = await runOuroCli(["status", "--json"], deps)

    expect(JSON.parse(result)).toEqual({
      ok: false,
      summary: "daemon=degraded",
      message: "provider lane degraded",
      error: "provider check failed",
    })
  })

  it("renders minimal daemon status JSON when the daemon omits optional metadata", async () => {
    const deps: OuroCliDeps = {
      socketPath: "/tmp/ouro-test.sock",
      sendCommand: vi.fn(async () => ({ ok: true })),
      startDaemonProcess: vi.fn(async () => ({ pid: 1 })),
      writeStdout: vi.fn(),
      checkSocketAlive: vi.fn(async () => true),
      cleanupStaleSocket: vi.fn(),
      fallbackPendingMessage: vi.fn(() => "/tmp/pending.jsonl"),
    }

    const result = await runOuroCli(["status", "--json"], deps)

    expect(JSON.parse(result)).toEqual({ ok: true })
  })

  it("renders Git Sync as a per-agent section with remote URL, local-only, not-a-repo, and disabled states", async () => {
    const deps: OuroCliDeps = {
      socketPath: "/tmp/ouro-test.sock",
      sendCommand: vi.fn(async () => ({
        ok: true,
        summary: "daemon=running\tworkers=0\tsenses=0\thealth=ok",
        data: {
          overview: {},
          senses: [],
          workers: [],
          sync: [
            // Enabled, bundle is a git repo with resolved remote URL
            { agent: "slugger", enabled: true, remote: "origin", gitInitialized: true, remoteUrl: "git@github.com:me/slugger-state.git" },
            // Enabled, bundle is a git repo but no remote configured (local-only mode)
            { agent: "local-bot", enabled: true, remote: "origin", gitInitialized: true },
            // Enabled but bundle is NOT a git repo — surface as error
            { agent: "needs-init", enabled: true, remote: "origin", gitInitialized: false },
            // Disabled
            { agent: "ouroboros", enabled: false, remote: "origin" },
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

    expect(result).toContain("Git Sync")
    // Header line
    expect(result).toContain("slugger")
    expect(result).toContain("local-bot")
    expect(result).toContain("needs-init")
    expect(result).toContain("ouroboros")
    // Enabled with URL: shows "<remote> → <url>"
    expect(result).toContain("origin → git@github.com:me/slugger-state.git")
    // Enabled without URL, but a git repo: shows "local only"
    expect(result).toContain("local only")
    // Enabled but not a git repo: shows actionable error with "git init" hint
    expect(result).toContain("not a git repo")
    expect(result).toContain("git init")
    expect(result).toContain("error")
    // Disabled state
    expect(result).toContain("disabled")
  })

  it("renders Agents section with both enabled and disabled bundles", async () => {
    const deps: OuroCliDeps = {
      socketPath: "/tmp/ouro-test.sock",
      sendCommand: vi.fn(async () => ({
        ok: true,
        summary: "daemon=running\tworkers=0\tsenses=0\thealth=ok",
        data: {
          overview: {},
          senses: [],
          workers: [],
          sync: [],
          agents: [
            { name: "alpha", enabled: true },
            { name: "ouroboros", enabled: false },
            { name: "slugger", enabled: true },
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

    expect(result).toContain("Agents")
    expect(result).toContain("alpha")
    expect(result).toContain("ouroboros")
    expect(result).toContain("slugger")
    expect(result).toContain("enabled")
    expect(result).toContain("disabled")
  })

  it("falls back to the raw daemon summary when agents is provided as a non-array", async () => {
    const deps: OuroCliDeps = {
      socketPath: "/tmp/ouro-test.sock",
      sendCommand: vi.fn(async () => ({
        ok: true,
        summary: "malformed-agents",
        data: {
          overview: {},
          senses: [],
          workers: [],
          sync: [],
          agents: "not-an-array",
        },
      })),
      startDaemonProcess: vi.fn(async () => ({ pid: 1 })),
      writeStdout: vi.fn(),
      checkSocketAlive: vi.fn(async () => true),
      cleanupStaleSocket: vi.fn(),
      fallbackPendingMessage: vi.fn(() => "/tmp/pending.jsonl"),
    }

    const result = await runOuroCli(["status"], deps)
    expect(result).toBe("malformed-agents")
  })

  it("falls back to the raw daemon summary when an agent row is missing required fields", async () => {
    const deps: OuroCliDeps = {
      socketPath: "/tmp/ouro-test.sock",
      sendCommand: vi.fn(async () => ({
        ok: true,
        summary: "malformed-agent-row",
        data: {
          overview: {},
          senses: [],
          workers: [],
          sync: [],
          agents: [{ name: "ok", enabled: true }, { name: "no-enabled-flag" }],
        },
      })),
      startDaemonProcess: vi.fn(async () => ({ pid: 1 })),
      writeStdout: vi.fn(),
      checkSocketAlive: vi.fn(async () => true),
      cleanupStaleSocket: vi.fn(),
      fallbackPendingMessage: vi.fn(() => "/tmp/pending.jsonl"),
    }

    const result = await runOuroCli(["status"], deps)
    expect(result).toBe("malformed-agent-row")
  })

  it("falls back to the raw daemon summary when an agent row is null or wrong-typed", async () => {
    const deps: OuroCliDeps = {
      socketPath: "/tmp/ouro-test.sock",
      sendCommand: vi.fn(async () => ({
        ok: true,
        summary: "null-agent-row",
        data: {
          overview: {},
          senses: [],
          workers: [],
          sync: [],
          // null entries, array-as-row, and wrong-type entries all exercise the
          // top-of-parser guard in parsedAgents.
          agents: [null, { name: "ok", enabled: true }],
        },
      })),
      startDaemonProcess: vi.fn(async () => ({ pid: 1 })),
      writeStdout: vi.fn(),
      checkSocketAlive: vi.fn(async () => true),
      cleanupStaleSocket: vi.fn(),
      fallbackPendingMessage: vi.fn(() => "/tmp/pending.jsonl"),
    }

    const result = await runOuroCli(["status"], deps)
    expect(result).toBe("null-agent-row")
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
            mailboxUrl: "http://127.0.0.1:4310/mailbox",
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

    expect(result).toContain("ouroboros daemon")
    expect(result).toContain("Senses")
    expect(result).toContain("Workers")
    expect(result).toContain(PACKAGE_VERSION.version)
    expect(result).toContain("2026-03-08T23:50:00.000Z")
    expect(result).toContain("BlueBubbles")
    expect(result).toContain("interactive")
    expect(result).toContain("/bluebubbles-webhook")
    expect(result).toContain("inner-dialog")
    expect(result).toContain("restarts: 0")
    expect(result).toContain("Mailbox")
    expect(result).toContain("http://127.0.0.1:4310/mailbox")
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

  it("falls back to the raw daemon summary when sync is provided as a non-array", async () => {
    const deps: OuroCliDeps = {
      socketPath: "/tmp/ouro-test.sock",
      sendCommand: vi.fn(async () => ({
        ok: true,
        summary: "malformed-sync-not-array",
        data: {
          overview: {
            daemon: "running",
            socketPath: "/tmp/ouro-test.sock",
            workerCount: 0,
            senseCount: 0,
            health: "ok",
          },
          senses: [],
          workers: [],
          sync: {},
        },
      })),
      startDaemonProcess: vi.fn(async () => ({ pid: 1 })),
      writeStdout: vi.fn(),
      checkSocketAlive: vi.fn(async () => true),
      cleanupStaleSocket: vi.fn(),
      fallbackPendingMessage: vi.fn(() => "/tmp/pending.jsonl"),
    }

    const result = await runOuroCli(["status"], deps)

    expect(result).toBe("malformed-sync-not-array")
  })

  it("falls back to the raw daemon summary when a sync row is malformed", async () => {
    const deps: OuroCliDeps = {
      socketPath: "/tmp/ouro-test.sock",
      sendCommand: vi.fn(async () => ({
        ok: true,
        summary: "malformed-sync-row",
        data: {
          overview: {
            daemon: "running",
            socketPath: "/tmp/ouro-test.sock",
            workerCount: 0,
            senseCount: 0,
            health: "ok",
          },
          senses: [],
          workers: [],
          sync: ["bad-row"],
        },
      })),
      startDaemonProcess: vi.fn(async () => ({ pid: 1 })),
      writeStdout: vi.fn(),
      checkSocketAlive: vi.fn(async () => true),
      cleanupStaleSocket: vi.fn(),
      fallbackPendingMessage: vi.fn(() => "/tmp/pending.jsonl"),
    }

    const result = await runOuroCli(["status"], deps)

    expect(result).toBe("malformed-sync-row")
  })

  it("falls back to the raw daemon summary when a sync row is missing required fields", async () => {
    const deps: OuroCliDeps = {
      socketPath: "/tmp/ouro-test.sock",
      sendCommand: vi.fn(async () => ({
        ok: true,
        summary: "sync-row-missing-fields",
        data: {
          overview: {
            daemon: "running",
            socketPath: "/tmp/ouro-test.sock",
            workerCount: 0,
            senseCount: 0,
            health: "ok",
          },
          senses: [],
          workers: [],
          sync: [
            {
              agent: "slugger",
              // missing enabled and remote
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

    expect(result).toBe("sync-row-missing-fields")
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
      checkSocketAlive: vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true),
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
      checkSocketAlive: vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true),
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
      checkSocketAlive: vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true),
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
    }))
    const runAuthFlow = vi.fn(async (input: { onProgress?: (message: string) => void }) => {
      input.onProgress?.("opening anthropic browser login")
      return {
        agentName: "ClaudeSprout",
        provider: "anthropic",
        message: "authenticated ClaudeSprout with anthropic",
        credentialPath: "vault:test:providers:test",
        credentials: {
          setupToken: `sk-ant-oat01-${"a".repeat(90)}`,
        },
      } as any
    })
    const promptInput = vi.fn(async () => "unexpected")

    const deps = {
      socketPath: "/tmp/ouro-test.sock",
      sendCommand: vi.fn(async () => ({ ok: true, message: "unexpected sendCommand call" })),
      startDaemonProcess: vi.fn(async () => ({ pid: 111 })),
      writeStdout: vi.fn(),
      checkSocketAlive: vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true),
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
      onProgress: expect.any(Function),
    })
    expect(deps.writeStdout).toHaveBeenCalledWith(expect.stringContaining("resolving anthropic credentials"))
    expect(deps.writeStdout).toHaveBeenCalledWith(expect.stringContaining("opening anthropic browser login"))
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
    }))
    const runAuthFlow = vi.fn(async () => ({
      agentName: "CodexSprout",
      provider: "openai-codex",
      message: "authenticated CodexSprout with openai-codex",
      credentialPath: "vault:test:providers:test",
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
      checkSocketAlive: vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true),
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
      onProgress: expect.any(Function),
    })
    expect(deps.writeStdout).toHaveBeenCalledWith(expect.stringContaining("resolving openai-codex credentials"))
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

  it("ends hatch auth progress cleanly when the shared runtime auth flow fails", async () => {
    const runHatchFlow = vi.fn()
    const runAuthFlow = vi.fn(async () => {
      throw new Error("browser auth failed")
    })
    const deps = {
      socketPath: "/tmp/ouro-test.sock",
      sendCommand: vi.fn(async () => ({ ok: true, message: "unexpected sendCommand call" })),
      startDaemonProcess: vi.fn(async () => ({ pid: 222 })),
      writeStdout: vi.fn(),
      checkSocketAlive: vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true),
      cleanupStaleSocket: vi.fn(),
      fallbackPendingMessage: vi.fn(() => "/tmp/pending.jsonl"),
      registerOuroBundleType: vi.fn(async () => ({ attempted: true, registered: true })),
      runHatchFlow,
      runAuthFlow,
      promptInput: vi.fn(async () => "unexpected"),
    } as OuroCliDeps

    await expect(runOuroCli([
      "hatch",
      "--agent",
      "SadSprout",
      "--human",
      "Ari",
      "--provider",
      "openai-codex",
    ], deps)).rejects.toThrow("browser auth failed")

    expect(runAuthFlow).toHaveBeenCalledWith({
      agentName: "SadSprout",
      provider: "openai-codex",
      promptInput: deps.promptInput,
      onProgress: expect.any(Function),
    })
    expect(deps.writeStdout).toHaveBeenCalledWith(expect.stringContaining("resolving openai-codex credentials"))
    expect(runHatchFlow).not.toHaveBeenCalled()
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
      })),
    }

    await expect(runOuroCli(["hatch"], deps)).rejects.toThrow("Usage")
  })

  it("does not re-prompt azure credentials when they are provided on CLI", async () => {
    const runHatchFlow = vi.fn(async () => ({
      bundleRoot: "/tmp/AgentBundles/AzureProvided.ouro",
      selectedIdentity: "medusa.md",
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
      sendCommand: sendCommandWithRunningStatus(),
      startDaemonProcess: vi.fn(async () => ({ pid: 404 })),
      writeStdout: vi.fn(),
      checkSocketAlive: vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(false).mockResolvedValue(true),
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
    }))

    const deps = {
      socketPath: "/tmp/ouro-test.sock",
      sendCommand: vi.fn(async () => ({ ok: true })),
      startDaemonProcess: vi.fn(async () => ({ pid: 505 })),
      writeStdout: vi.fn(),
      checkSocketAlive: vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true),
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
    }))
    const deps = {
      socketPath: "/tmp/ouro-test.sock",
      sendCommand: vi.fn(async () => ({ ok: true })),
      startDaemonProcess: vi.fn(async () => ({ pid: null })),
      writeStdout: vi.fn(),
      checkSocketAlive: vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true),
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
      checkSocketAlive: vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true),
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
    }))

    const deps = {
      socketPath: "/tmp/ouro-test.sock",
      sendCommand: vi.fn(async () => ({ ok: true, message: "unexpected sendCommand call" })),
      startDaemonProcess: vi.fn(async () => ({ pid: 999 })),
      writeStdout: vi.fn(),
      checkSocketAlive: vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true),
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

  it("renders an Ouro home prompt before asking which discovered agent to talk to", async () => {
    const startChat = vi.fn(async () => {})
    const promptInput = vi.fn(async (prompt: string) => {
      expect(prompt).toContain("___    _   _")
      expect(prompt).toContain("Talk to ouroboros")
      expect(prompt).toContain("Talk to slugger")
      expect(prompt).toContain("Start or check Ouro")
      return "2"
    })
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
      isTTY: true,
      stdoutColumns: 78,
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

  it("falls back to a plain agent picker prompt if TTY mode drops before the second question", async () => {
    const promptInput = vi.fn(async (prompt: string) => {
      if (prompt.includes("Ouro home")) {
        deps.isTTY = false
        return "repair"
      }
      expect(prompt).toContain("Repair an agent")
      expect(prompt).not.toContain("OUROBOROS")
      return "slugger"
    })
    const sendCommand = vi.fn(async (socketPath: string, command: any) => {
      if (command.kind === "daemon.status") {
        return {
          ok: true,
          data: {
            overview: {
              version: "0.1.0-alpha.429",
              lastUpdated: "2026-04-18T10:00:00.000Z",
              repoRoot: "/tmp/ouro",
              configFingerprint: "abc",
            },
            agents: [],
            workers: [],
            senses: [],
          },
        }
      }
      if (command.kind === "provider.check") return { ok: true, message: "ok" }
      return { ok: true, message: "repair done" }
    })
    const deps = {
      socketPath: "/tmp/ouro-test.sock",
      sendCommand,
      startDaemonProcess: vi.fn(async () => ({ pid: 1 })),
      writeStdout: vi.fn(),
      checkSocketAlive: vi.fn(async () => true),
      cleanupStaleSocket: vi.fn(),
      fallbackPendingMessage: vi.fn(() => "/tmp/pending.jsonl"),
      listDiscoveredAgents: vi.fn(async () => ["ouroboros", "slugger"]),
      promptInput,
      isTTY: true,
      stdoutColumns: 78,
    } as OuroCliDeps & {
      promptInput: typeof promptInput
      isTTY: boolean
    }

    const result = await runOuroCli([], deps)

    expect(result).toContain("slugger: ready")
  })

  it("throws a clear error if the home-screen agent picker loses interactive input mid-flow", async () => {
    const promptInput = vi.fn(async () => {
      deps.promptInput = undefined
      return "connect"
    })
    const deps = {
      socketPath: "/tmp/ouro-test.sock",
      sendCommand: vi.fn(async () => ({ ok: true })),
      startDaemonProcess: vi.fn(async () => ({ pid: 1 })),
      writeStdout: vi.fn(),
      checkSocketAlive: vi.fn(async () => true),
      cleanupStaleSocket: vi.fn(),
      fallbackPendingMessage: vi.fn(() => "/tmp/pending.jsonl"),
      listDiscoveredAgents: vi.fn(async () => ["ouroboros", "slugger"]),
      promptInput,
      isTTY: true,
      stdoutColumns: 78,
    } as OuroCliDeps & {
      promptInput?: typeof promptInput
    }

    await expect(runOuroCli([], deps)).rejects.toThrow("agent selection requires interactive input")
  })

  it("lets home-screen help print the grouped help text", async () => {
    const promptInput = vi.fn(async () => "help")
    const deps = {
      socketPath: "/tmp/ouro-test.sock",
      sendCommand: vi.fn(async () => ({ ok: true })),
      startDaemonProcess: vi.fn(async () => ({ pid: 1 })),
      writeStdout: vi.fn(),
      checkSocketAlive: vi.fn(async () => true),
      cleanupStaleSocket: vi.fn(),
      fallbackPendingMessage: vi.fn(() => "/tmp/pending.jsonl"),
      listDiscoveredAgents: vi.fn(async () => []),
      promptInput,
      isTTY: true,
      stdoutColumns: 78,
    } as OuroCliDeps & { promptInput: typeof promptInput }

    const result = await runOuroCli([], deps)

    expect(result).toContain("Usage:")
    expect(deps.writeStdout).toHaveBeenCalledWith(expect.stringContaining("Usage:"))
  })

  it("lets the home screen hand off directly into ouro up", async () => {
    const promptInput = vi.fn(async () => "up")
    const sendCommand = vi.fn(async (socketPath: string, command: any) => {
      if (command.kind === "provider.check") return { ok: true, message: "ok" }
      return { ok: true }
    })
    const deps = {
      socketPath: "/tmp/ouro-test.sock",
      sendCommand,
      startDaemonProcess: vi.fn(async () => ({ pid: 1 })),
      writeStdout: vi.fn(),
      checkSocketAlive: vi.fn(async () => true),
      cleanupStaleSocket: vi.fn(),
      fallbackPendingMessage: vi.fn(() => "/tmp/pending.jsonl"),
      listDiscoveredAgents: vi.fn(async () => ["slugger"]),
      promptInput,
      isTTY: true,
      stdoutColumns: 78,
      updateCheck: vi.fn(async () => ({
        outcome: "up-to-date",
        currentVersion: "0.1.0-alpha.429",
        latestVersion: "0.1.0-alpha.429",
      })),
      bundleMetaHook: vi.fn(async () => ({ updatedAgents: [], prunedBundles: [] })),
    } as OuroCliDeps & { promptInput: typeof promptInput }

    await expect(runOuroCli([], deps)).resolves.toContain("daemon already running")
    expect(promptInput).toHaveBeenCalledWith(expect.stringContaining("Ouro home"))
    expect(sendCommand).toHaveBeenCalledWith("/tmp/ouro-test.sock", expect.objectContaining({ kind: "daemon.status" }))
  })

  it("cancels a home-screen clone when the remote URL is blank", async () => {
    const promptInput = vi.fn(async (prompt: string) => {
      if (prompt.includes("Ouro home")) return "clone"
      return "   "
    })
    const deps = {
      socketPath: "/tmp/ouro-test.sock",
      sendCommand: vi.fn(async () => ({ ok: true })),
      startDaemonProcess: vi.fn(async () => ({ pid: 1 })),
      writeStdout: vi.fn(),
      checkSocketAlive: vi.fn(async () => true),
      cleanupStaleSocket: vi.fn(),
      fallbackPendingMessage: vi.fn(() => "/tmp/pending.jsonl"),
      listDiscoveredAgents: vi.fn(async () => []),
      promptInput,
      isTTY: true,
      stdoutColumns: 78,
    } as OuroCliDeps & { promptInput: typeof promptInput }

    const result = await runOuroCli([], deps)

    expect(result).toBe("no remote URL provided — clone cancelled.")
  })

  it("lets bare home-screen chat fall through to daemon chat when startChat is unavailable", async () => {
    const sendCommand = vi.fn(async (socketPath: string, command: any) => {
      if (command.kind === "daemon.status") {
        return {
          ok: true,
          data: {
            overview: {
              version: "0.1.0-alpha.429",
              lastUpdated: "2026-04-18T10:00:00.000Z",
              repoRoot: "/tmp/ouro",
              configFingerprint: "abc",
            },
            agents: [],
            workers: [],
            senses: [],
          },
        }
      }
      if (command.kind === "provider.check") return { ok: true, message: "ok" }
      return { ok: true, message: "daemon chat connected" }
    })
    const deps = {
      socketPath: "/tmp/ouro-test.sock",
      sendCommand,
      startDaemonProcess: vi.fn(async () => ({ pid: 1 })),
      writeStdout: vi.fn(),
      checkSocketAlive: vi.fn(async () => true),
      cleanupStaleSocket: vi.fn(),
      fallbackPendingMessage: vi.fn(() => "/tmp/pending.jsonl"),
      listDiscoveredAgents: vi.fn(async () => ["slugger"]),
      promptInput: vi.fn(async () => "slugger"),
      isTTY: true,
      stdoutColumns: 78,
    } as OuroCliDeps

    const result = await runOuroCli([], deps)

    expect(result).toBe("daemon chat connected")
  })

  it("lets the no-agent home screen fall back to the old hatch flow when serpent guide is unavailable", async () => {
    const runHatchFlow = vi.fn(async () => ({
      bundleRoot: "/tmp/AgentBundles/Sprout.ouro",
      selectedIdentity: "medusa.md",
    }))
    const promptInput = vi.fn(async (question: string) => {
      if (question.includes("Ouro home")) return "hatch"
      if (question === "Hatchling name: ") return "Sprout"
      if (question === "Your name: ") return "Ari"
      if (question === "Provider (azure|anthropic|minimax|openai-codex|github-copilot): ") return "anthropic"
      if (question === "Anthropic setup-token: ") return "sk-ant-oat01-test-token"
      return ""
    })
    const deps = {
      socketPath: "/tmp/ouro-test.sock",
      sendCommand: vi.fn(async () => ({ ok: true })),
      startDaemonProcess: vi.fn(async () => ({ pid: 1 })),
      writeStdout: vi.fn(),
      checkSocketAlive: vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true),
      cleanupStaleSocket: vi.fn(),
      fallbackPendingMessage: vi.fn(() => "/tmp/pending.jsonl"),
      listDiscoveredAgents: vi.fn(async () => []),
      promptInput,
      isTTY: true,
      stdoutColumns: 78,
      registerOuroBundleType: vi.fn(async () => ({ attempted: true, registered: true })),
      runHatchFlow,
    } as OuroCliDeps & {
      promptInput: typeof promptInput
      runHatchFlow: typeof runHatchFlow
    }

    const result = await runOuroCli([], deps)

    expect(result).toContain("Hatch complete")
    expect(result).toContain("Sprout is ready for first contact.")
    expect(runHatchFlow).toHaveBeenCalled()
  })

  it("uses the no-agent home hatch path to launch serpent guide when it is available", async () => {
    const runSerpentGuide = vi.fn(async () => "Sprout")
    const startChat = vi.fn(async () => {})
    const promptInput = vi.fn(async (question: string) => {
      if (question.includes("Ouro home")) return "hatch"
      return ""
    })
    const deps = {
      socketPath: "/tmp/ouro-test.sock",
      sendCommand: vi.fn(async () => ({ ok: true })),
      startDaemonProcess: vi.fn(async () => ({ pid: 41 })),
      writeStdout: vi.fn(),
      checkSocketAlive: vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true),
      cleanupStaleSocket: vi.fn(),
      fallbackPendingMessage: vi.fn(() => "/tmp/pending.jsonl"),
      listDiscoveredAgents: vi.fn(async () => []),
      promptInput,
      isTTY: true,
      stdoutColumns: 78,
      registerOuroBundleType: vi.fn(async () => ({ attempted: true, registered: true })),
      runSerpentGuide,
      startChat,
    } as OuroCliDeps & {
      promptInput: typeof promptInput
      runSerpentGuide: typeof runSerpentGuide
      startChat: typeof startChat
    }

    const result = await runOuroCli([], deps)

    expect(result).toBe("")
    expect(deps.registerOuroBundleType).toHaveBeenCalledTimes(1)
    expect(runSerpentGuide).toHaveBeenCalledTimes(1)
    expect(startChat).toHaveBeenCalledWith("Sprout")
  })

  it("lets the no-agent home hatch path exit quietly when serpent guide returns null", async () => {
    const runSerpentGuide = vi.fn(async () => null)
    const promptInput = vi.fn(async (question: string) => {
      if (question.includes("Ouro home")) return "hatch"
      return ""
    })
    const deps = {
      socketPath: "/tmp/ouro-test.sock",
      sendCommand: vi.fn(async () => ({ ok: true })),
      startDaemonProcess: vi.fn(async () => ({ pid: 41 })),
      writeStdout: vi.fn(),
      checkSocketAlive: vi.fn(async () => false),
      cleanupStaleSocket: vi.fn(),
      fallbackPendingMessage: vi.fn(() => "/tmp/pending.jsonl"),
      listDiscoveredAgents: vi.fn(async () => []),
      promptInput,
      isTTY: true,
      stdoutColumns: 78,
      registerOuroBundleType: vi.fn(async () => ({ attempted: true, registered: true })),
      runSerpentGuide,
    } as OuroCliDeps & {
      promptInput: typeof promptInput
      runSerpentGuide: typeof runSerpentGuide
    }

    await expect(runOuroCli([], deps)).resolves.toBe("")
    expect(runSerpentGuide).toHaveBeenCalledTimes(1)
    expect(deps.startDaemonProcess).not.toHaveBeenCalled()
  })

  it("keeps the no-agent home hatch path calm when startChat is unavailable", async () => {
    const runSerpentGuide = vi.fn(async () => "Sprout")
    const promptInput = vi.fn(async (question: string) => {
      if (question.includes("Ouro home")) return "hatch"
      return ""
    })
    const deps = {
      socketPath: "/tmp/ouro-test.sock",
      sendCommand: vi.fn(async () => ({ ok: true })),
      startDaemonProcess: vi.fn(async () => ({ pid: 41 })),
      writeStdout: vi.fn(),
      checkSocketAlive: vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true),
      cleanupStaleSocket: vi.fn(),
      fallbackPendingMessage: vi.fn(() => "/tmp/pending.jsonl"),
      listDiscoveredAgents: vi.fn(async () => []),
      promptInput,
      isTTY: true,
      stdoutColumns: 78,
      registerOuroBundleType: vi.fn(async () => ({ attempted: true, registered: true })),
      runSerpentGuide,
    } as OuroCliDeps & {
      promptInput: typeof promptInput
      runSerpentGuide: typeof runSerpentGuide
    }

    await expect(runOuroCli([], deps)).resolves.toBe("")
    expect(runSerpentGuide).toHaveBeenCalledTimes(1)
    expect(deps.startDaemonProcess).toHaveBeenCalled()
  })

  it("lets the no-agent home screen exit quietly", async () => {
    const deps = {
      socketPath: "/tmp/ouro-test.sock",
      sendCommand: vi.fn(async () => ({ ok: true })),
      startDaemonProcess: vi.fn(async () => ({ pid: 1 })),
      writeStdout: vi.fn(),
      checkSocketAlive: vi.fn(async () => true),
      cleanupStaleSocket: vi.fn(),
      fallbackPendingMessage: vi.fn(() => "/tmp/pending.jsonl"),
      listDiscoveredAgents: vi.fn(async () => []),
      promptInput: vi.fn(async () => "exit"),
      isTTY: true,
      stdoutColumns: 78,
    } as OuroCliDeps

    await expect(runOuroCli([], deps)).resolves.toBe("")
  })

  it("lets the populated home screen exit quietly", async () => {
    const deps = {
      socketPath: "/tmp/ouro-test.sock",
      sendCommand: vi.fn(async () => ({ ok: true })),
      startDaemonProcess: vi.fn(async () => ({ pid: 1 })),
      writeStdout: vi.fn(),
      checkSocketAlive: vi.fn(async () => true),
      cleanupStaleSocket: vi.fn(),
      fallbackPendingMessage: vi.fn(() => "/tmp/pending.jsonl"),
      listDiscoveredAgents: vi.fn(async () => ["slugger"]),
      promptInput: vi.fn(async () => "exit"),
      isTTY: true,
      stdoutColumns: 78,
    } as OuroCliDeps

    await expect(runOuroCli([], deps)).resolves.toBe("")
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

  it("renders --help as a shared board in TTY mode", async () => {
    const deps: OuroCliDeps = {
      socketPath: "/tmp/ouro-test.sock",
      sendCommand: vi.fn(async () => ({ ok: true })),
      startDaemonProcess: vi.fn(async () => ({ pid: 1 })),
      writeStdout: vi.fn(),
      checkSocketAlive: vi.fn(async () => true),
      cleanupStaleSocket: vi.fn(),
      fallbackPendingMessage: vi.fn(() => "/tmp/pending.jsonl"),
      isTTY: true,
      stdoutColumns: 74,
    }

    const result = await runOuroCli(["--help"], deps)

    expect(result).toContain("___    _   _")
    expect(result).toContain("Help")
    expect(result).toContain("daemon")
    expect(result).toContain("connect")
  })

  it("renders TTY help boards even when stdoutColumns falls back to the terminal width", async () => {
    const deps: OuroCliDeps = {
      socketPath: "/tmp/ouro-test.sock",
      sendCommand: vi.fn(async () => ({ ok: true })),
      startDaemonProcess: vi.fn(async () => ({ pid: 1 })),
      writeStdout: vi.fn(),
      checkSocketAlive: vi.fn(async () => true),
      cleanupStaleSocket: vi.fn(),
      fallbackPendingMessage: vi.fn(() => "/tmp/pending.jsonl"),
      isTTY: true,
    }

    const result = await runOuroCli(["--help"], deps)

    expect(result).toContain("___    _   _")
    expect(result).toContain("Help")
  })

  it("renders parsed `ouro help` as the shared board in TTY mode", async () => {
    const deps: OuroCliDeps = {
      socketPath: "/tmp/ouro-test.sock",
      sendCommand: vi.fn(async () => ({ ok: true })),
      startDaemonProcess: vi.fn(async () => ({ pid: 1 })),
      writeStdout: vi.fn(),
      checkSocketAlive: vi.fn(async () => true),
      cleanupStaleSocket: vi.fn(),
      fallbackPendingMessage: vi.fn(() => "/tmp/pending.jsonl"),
      isTTY: true,
      stdoutColumns: 74,
    }

    const result = await runOuroCli(["help"], deps)

    expect(result).toContain("___    _   _")
    expect(result).toContain("Command groups")
    expect(result).toContain("Everything Ouro can do from the terminal.")
  })

  it("renders command-specific parsed help boards in TTY mode", async () => {
    const deps: OuroCliDeps = {
      socketPath: "/tmp/ouro-test.sock",
      sendCommand: vi.fn(async () => ({ ok: true })),
      startDaemonProcess: vi.fn(async () => ({ pid: 1 })),
      writeStdout: vi.fn(),
      checkSocketAlive: vi.fn(async () => true),
      cleanupStaleSocket: vi.fn(),
      fallbackPendingMessage: vi.fn(() => "/tmp/pending.jsonl"),
      isTTY: true,
      stdoutColumns: 74,
    }

    const result = await runOuroCli(["help", "up"], deps)

    expect(result).toContain("Reference for up.")
    expect(result).toContain("A closer look at up.")
    expect(result).toContain("Command")
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

  it("includes task command in help output", async () => {
    const deps = makeHelpDeps()
    const result = await runOuroCli(["--help"], deps)

    expect(result).toContain("task")
    expect(result).toContain("Tasks")
    expect(result).toContain("reminder")
  })

  it("includes reminder command in help output", async () => {
    const deps = makeHelpDeps()
    const result = await runOuroCli(["--help"], deps)

    expect(result).toContain("reminder")
  })

  it("includes friend command in help output", async () => {
    const deps = makeHelpDeps()
    const result = await runOuroCli(["--help"], deps)

    expect(result).toContain("friend")
    expect(result).toContain("Friends")
  })

  it("includes whoami in help output", async () => {
    const deps = makeHelpDeps()
    const result = await runOuroCli(["--help"], deps)

    expect(result).toContain("whoami")
  })

  it("includes session command in help output", async () => {
    const deps = makeHelpDeps()
    const result = await runOuroCli(["--help"], deps)

    expect(result).toContain("session")
  })

  it("includes all core daemon commands in help output", async () => {
    const deps = makeHelpDeps()
    const result = await runOuroCli(["--help"], deps)

    expect(result).toContain("up")
    expect(result).toContain("stop")
    expect(result).toContain("down")
    expect(result).toContain("status")
    expect(result).toContain("logs")
    expect(result).toContain("hatch")
    expect(result).toContain("chat")
    expect(result).toContain("msg")
    expect(result).toContain("poke")
    expect(result).toContain("link")
    expect(result).toContain("Lifecycle")
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
      checkSocketAlive: vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true),
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
      checkSocketAlive: vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true),
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
    }))

    const deps = {
      socketPath: "/tmp/ouro-test.sock",
      sendCommand: vi.fn(async () => ({ ok: true })),
      startDaemonProcess: vi.fn(async () => ({ pid: 99 })),
      writeStdout: vi.fn(),
      checkSocketAlive: vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true),
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
    }))

    const deps = {
      socketPath: "/tmp/ouro-test.sock",
      sendCommand: vi.fn(async () => ({ ok: true })),
      startDaemonProcess: vi.fn(async () => ({ pid: 99 })),
      writeStdout: vi.fn(),
      checkSocketAlive: vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true),
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
    }))

    const deps = {
      socketPath: "/tmp/ouro-test.sock",
      sendCommand: vi.fn(async () => ({ ok: true })),
      startDaemonProcess: vi.fn(async () => ({ pid: 99 })),
      writeStdout: vi.fn(),
      checkSocketAlive: vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true),
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
    expect(result.message).toContain("replaced an older background service")
    expect(result.message).toContain("0.1.0-alpha.6")
    expect(result.message).toContain("0.1.0-alpha.20")
    expect(sendCommand).toHaveBeenNthCalledWith(1, "/tmp/ouro-test.sock", { kind: "daemon.status" })
    expect(sendCommand).toHaveBeenNthCalledWith(2, "/tmp/ouro-test.sock", { kind: "daemon.stop" })
    expect(deps.cleanupStaleSocket).toHaveBeenCalledWith("/tmp/ouro-test.sock")
    expect(deps.startDaemonProcess).toHaveBeenCalledWith("/tmp/ouro-test.sock")
  })

  it("passes runtime path and config drift signals into the daemon runtime sync check", async () => {
    vi.resetModules()
    const tmp = createTmpBundle({ agentName: "slugger" })
    const ensureCurrentDaemonRuntime = vi.fn(async () => ({
      ok: true,
      alreadyRunning: false,
      message: "restarted drifted daemon",
      verifyStartupStatus: true,
      startedPid: null,
      startupFailureReason: null,
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

    try {
      const deps: OuroCliDeps = {
        socketPath: "/tmp/ouro-test.sock",
        bundlesRoot: tmp.bundlesRoot,
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
            workers: [{ agent: "slugger", worker: "inner-dialog", status: "running", pid: 123, restartCount: 0, lastExitCode: null, lastSignal: null, startedAt: null, errorReason: null, fixHint: null }],
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
        ok: true,
        alreadyRunning: false,
        message: "restarted drifted daemon",
        verifyStartupStatus: true,
        startedPid: null,
        startupFailureReason: null,
        stability: { stable: [], degraded: [] },
      })
      expect(ensureCurrentDaemonRuntime).toHaveBeenCalledWith(expect.objectContaining({
        socketPath: "/tmp/ouro-test.sock",
        localVersion: "0.1.0-alpha.20",
        localLastUpdated: "2026-03-09T11:00:00.000Z",
        localRepoRoot: "/Users/arimendelow/Projects/ouroboros-agent-harness-bb-health-status",
        localConfigFingerprint: "cfg-local",
        localManagedAgents: "slugger",
      }))
      await expect(syncDeps.fetchRunningRuntimeMetadata?.()).resolves.toEqual({
        version: "0.1.0-alpha.20",
        lastUpdated: "2026-03-09T11:00:00.000Z",
        repoRoot: "/Users/arimendelow/Projects/ouroboros-agent-harness-cross-chat-bridge-orchestration",
        configFingerprint: "cfg-running",
        managedAgents: "slugger",
      })
    } finally {
      tmp.cleanup()
    }
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
    expect(result.message).toContain("could not replace the older background service")
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
      checkSocketAlive: vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true),
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

  it("waits for startup stability plus fresh current-boot health and retries once when the first boot loses its socket", async () => {
    const { ensureDaemonRunning } = await import("../../../heart/daemon/daemon-cli")

    let nowMs = Date.parse("2026-04-10T05:02:36.000Z")
    let currentAttempt = 0
    let pollCount = 0

    const startDaemonProcess = vi.fn(async () => {
      currentAttempt += 1
      pollCount = 0
      return { pid: currentAttempt === 1 ? 5184 : 5683 }
    })
    const checkSocketAlive = vi.fn(async () => {
      if (currentAttempt === 0) return false
      pollCount += 1
      if (currentAttempt === 1) return pollCount === 1
      return true
    })
    const readHealthState = vi.fn(() => {
      if (currentAttempt === 1) {
        return {
          status: "ok",
          mode: "normal",
          pid: 32096,
          startedAt: "2026-04-09T10:40:31.091Z",
          uptimeSeconds: 64839,
          safeMode: null,
          degraded: [],
          agents: {},
          habits: {},
        }
      }
      return {
        status: "ok",
        mode: "normal",
        pid: 5683,
        startedAt: new Date(nowMs).toISOString(),
        uptimeSeconds: 0,
        safeMode: null,
        degraded: [],
        agents: {},
        habits: {},
      }
    })
    const readHealthUpdatedAt = vi.fn(() => (currentAttempt === 1 ? nowMs - 60_000 : nowMs))
    const sleep = vi.fn(async (ms: number) => {
      nowMs += ms
    })

    const deps = {
      socketPath: "/tmp/ouro-test.sock",
      sendCommand: vi.fn(),
      startDaemonProcess,
      writeStdout: vi.fn(),
      checkSocketAlive,
      cleanupStaleSocket: vi.fn(),
      fallbackPendingMessage: vi.fn(() => "/tmp/pending.jsonl"),
      healthFilePath: "/tmp/ouro-health.json",
      readHealthState,
      readHealthUpdatedAt,
      readRecentDaemonLogLines: vi.fn(() => [
        "2026-04-10T05:02:39.000Z warn daemon: startup lost socket before stabilizing",
      ]),
      sleep,
      now: () => nowMs,
      startupPollIntervalMs: 5,
      startupStabilityWindowMs: 15,
      startupTimeoutMs: 60,
    } as OuroCliDeps & {
      readHealthState: typeof readHealthState
      readHealthUpdatedAt: typeof readHealthUpdatedAt
      readRecentDaemonLogLines: () => string[]
      sleep: typeof sleep
      now: () => number
      startupPollIntervalMs: number
      startupStabilityWindowMs: number
      startupTimeoutMs: number
    }

    const result = await ensureDaemonRunning(deps)

    expect(result.alreadyRunning).toBe(false)
    expect(result.message).toContain("daemon started")
    expect(result.message).toContain("5683")
    expect(startDaemonProcess).toHaveBeenCalledTimes(2)
    expect(deps.cleanupStaleSocket).toHaveBeenCalledTimes(2)
    expect(readHealthState).toHaveBeenCalled()
  })

  it("returns startup failure with recent daemon log context when the retry also fails to stabilize", async () => {
    const { ensureDaemonRunning } = await import("../../../heart/daemon/daemon-cli")

    let nowMs = Date.parse("2026-04-10T05:02:36.000Z")
    let currentAttempt = 0
    let pollCount = 0

    const startDaemonProcess = vi.fn(async () => {
      currentAttempt += 1
      pollCount = 0
      return { pid: currentAttempt === 1 ? 5184 : 5683 }
    })
    const checkSocketAlive = vi.fn(async () => {
      if (currentAttempt === 0) return false
      pollCount += 1
      return pollCount === 1
    })
    const sleep = vi.fn(async (ms: number) => {
      nowMs += ms
    })

    const deps = {
      socketPath: "/tmp/ouro-test.sock",
      sendCommand: vi.fn(),
      startDaemonProcess,
      writeStdout: vi.fn(),
      checkSocketAlive,
      cleanupStaleSocket: vi.fn(),
      fallbackPendingMessage: vi.fn(() => "/tmp/pending.jsonl"),
      healthFilePath: "/tmp/ouro-health.json",
      readHealthState: vi.fn(() => ({
        status: "ok",
        mode: "normal",
        pid: 32096,
        startedAt: "2026-04-09T10:40:31.091Z",
        uptimeSeconds: 64839,
        safeMode: null,
        degraded: [],
        agents: {},
        habits: {},
      })),
      readHealthUpdatedAt: vi.fn(() => nowMs - 60_000),
      readRecentDaemonLogLines: vi.fn(() => [
        "2026-04-10T05:02:39.000Z warn daemon: startup lost socket before stabilizing",
        "2026-04-10T05:02:39.100Z error daemon: stale shutdown unlinked active socket",
      ]),
      sleep,
      now: () => nowMs,
      startupPollIntervalMs: 5,
      startupStabilityWindowMs: 15,
      startupTimeoutMs: 60,
    } as OuroCliDeps & {
      readHealthState: () => {
        status: string
        mode: string
        pid: number
        startedAt: string
        uptimeSeconds: number
        safeMode: null
        degraded: []
        agents: Record<string, never>
        habits: Record<string, never>
      }
      readHealthUpdatedAt: () => number
      readRecentDaemonLogLines: () => string[]
      sleep: typeof sleep
      now: () => number
      startupPollIntervalMs: number
      startupStabilityWindowMs: number
      startupTimeoutMs: number
    }

    const result = await ensureDaemonRunning(deps)

    expect(result.alreadyRunning).toBe(false)
    expect(result.message).toContain("did not finish booting")
    expect(result.message).toContain("answered once and then disappeared during startup")
    expect(result.message).toContain("stale shutdown unlinked active socket")
    expect(result.message).not.toContain("daemon started")
    expect(startDaemonProcess).toHaveBeenCalledTimes(2)
  })

  it("fails startup when the socket stays up but health evidence never matches the current boot attempt", async () => {
    const { ensureDaemonRunning } = await import("../../../heart/daemon/daemon-cli")

    let nowMs = Date.parse("2026-04-10T05:02:36.000Z")
    const sleep = vi.fn(async (ms: number) => {
      nowMs += ms
    })
    const deps = {
      socketPath: "/tmp/ouro-test.sock",
      sendCommand: vi.fn(),
      startDaemonProcess: vi.fn(async () => ({ pid: 5683 })),
      writeStdout: vi.fn(),
      checkSocketAlive: vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true),
      cleanupStaleSocket: vi.fn(),
      fallbackPendingMessage: vi.fn(() => "/tmp/pending.jsonl"),
      healthFilePath: "/tmp/ouro-health.json",
      readHealthState: vi.fn(() => ({
        status: "ok",
        mode: "normal",
        pid: 32096,
        startedAt: "2026-04-09T10:40:31.091Z",
        uptimeSeconds: 64839,
        safeMode: null,
        degraded: [],
        agents: {},
        habits: {},
      })),
      readHealthUpdatedAt: vi.fn(() => nowMs - 60_000),
      readRecentDaemonLogLines: vi.fn(() => []),
      sleep,
      now: () => nowMs,
      startupPollIntervalMs: 5,
      startupStabilityWindowMs: 15,
      startupTimeoutMs: 20,
      startupRetryLimit: 0,
    } as OuroCliDeps & {
      readHealthState: () => {
        status: string
        mode: string
        pid: number
        startedAt: string
        uptimeSeconds: number
        safeMode: null
        degraded: []
        agents: Record<string, never>
        habits: Record<string, never>
      }
      readHealthUpdatedAt: () => number
      readRecentDaemonLogLines: () => string[]
      sleep: typeof sleep
      now: () => number
      startupPollIntervalMs: number
      startupStabilityWindowMs: number
      startupTimeoutMs: number
      startupRetryLimit: number
    }

    const result = await ensureDaemonRunning(deps)

    expect(result.alreadyRunning).toBe(false)
    expect(result.message).toContain("did not finish booting")
    expect(result.message).toContain("never published a ready signal")
    expect(result.message).not.toContain("recent daemon logs:")
    expect(deps.startDaemonProcess).toHaveBeenCalledTimes(1)
  })

  it("keeps polling while startup health is missing or mismatched before accepting the current boot attempt", async () => {
    const { ensureDaemonRunning } = await import("../../../heart/daemon/daemon-cli")

    let nowMs = Date.parse("2026-04-10T05:02:36.000Z")
    let healthReads = 0
    const sleep = vi.fn(async (ms: number) => {
      nowMs += ms
    })
    const deps = {
      socketPath: "/tmp/ouro-test.sock",
      sendCommand: vi.fn(),
      startDaemonProcess: vi.fn(async () => ({ pid: 5683 })),
      writeStdout: vi.fn(),
      checkSocketAlive: vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true),
      cleanupStaleSocket: vi.fn(),
      fallbackPendingMessage: vi.fn(() => "/tmp/pending.jsonl"),
      healthFilePath: "/tmp/ouro-health.json",
      readHealthState: vi.fn(() => {
        healthReads += 1
        if (healthReads === 1) return null
        if (healthReads === 2) {
          return {
            status: "ok",
            mode: "normal",
            pid: 5683,
            startedAt: "2026-04-09T10:40:31.091Z",
            uptimeSeconds: 64839,
            safeMode: null,
            degraded: [],
            agents: {},
            habits: {},
          }
        }
        if (healthReads === 3) {
          return {
            status: "ok",
            mode: "normal",
            pid: 32096,
            startedAt: new Date(nowMs).toISOString(),
            uptimeSeconds: 0,
            safeMode: null,
            degraded: [],
            agents: {},
            habits: {},
          }
        }
        return {
          status: "ok",
          mode: "normal",
          pid: 5683,
          startedAt: new Date(nowMs).toISOString(),
          uptimeSeconds: 0,
          safeMode: null,
          degraded: [],
          agents: {},
          habits: {},
        }
      }),
      readHealthUpdatedAt: vi.fn(() => nowMs),
      readRecentDaemonLogLines: vi.fn(() => []),
      sleep,
      now: () => nowMs,
      startupPollIntervalMs: 5,
      startupStabilityWindowMs: 15,
      startupTimeoutMs: 40,
      startupRetryLimit: 0,
    } as OuroCliDeps & {
      readHealthState: () => {
        status: string
        mode: string
        pid: number
        startedAt: string
        uptimeSeconds: number
        safeMode: null
        degraded: []
        agents: Record<string, never>
        habits: Record<string, never>
      } | null
      readHealthUpdatedAt: () => number
      readRecentDaemonLogLines: () => string[]
      sleep: typeof sleep
      now: () => number
      startupPollIntervalMs: number
      startupStabilityWindowMs: number
      startupTimeoutMs: number
      startupRetryLimit: number
    }

    const result = await ensureDaemonRunning(deps)

    expect(result.alreadyRunning).toBe(false)
    expect(result.message).toContain("daemon started")
    expect(healthReads).toBeGreaterThanOrEqual(4)
  })

  it("accepts fresh current-boot health even when startDaemonProcess cannot report a pid", async () => {
    const { ensureDaemonRunning } = await import("../../../heart/daemon/daemon-cli")

    let nowMs = Date.parse("2026-04-10T05:02:36.000Z")
    const sleep = vi.fn(async (ms: number) => {
      nowMs += ms
    })
    const deps = {
      socketPath: "/tmp/ouro-test.sock",
      sendCommand: vi.fn(),
      startDaemonProcess: vi.fn(async () => ({ pid: null })),
      writeStdout: vi.fn(),
      checkSocketAlive: vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true),
      cleanupStaleSocket: vi.fn(),
      fallbackPendingMessage: vi.fn(() => "/tmp/pending.jsonl"),
      healthFilePath: "/tmp/ouro-health.json",
      readHealthState: vi.fn(() => ({
        status: "ok",
        mode: "normal",
        pid: 5683,
        startedAt: new Date(nowMs).toISOString(),
        uptimeSeconds: 0,
        safeMode: null,
        degraded: [],
        agents: {},
        habits: {},
      })),
      readHealthUpdatedAt: vi.fn(() => nowMs),
      readRecentDaemonLogLines: vi.fn(() => []),
      sleep,
      now: () => nowMs,
      startupPollIntervalMs: 5,
      startupStabilityWindowMs: 15,
      startupTimeoutMs: 60,
      startupRetryLimit: 0,
    } as OuroCliDeps & {
      readHealthState: () => {
        status: string
        mode: string
        pid: number
        startedAt: string
        uptimeSeconds: number
        safeMode: null
        degraded: []
        agents: Record<string, never>
        habits: Record<string, never>
      }
      readHealthUpdatedAt: () => number
      readRecentDaemonLogLines: () => string[]
      sleep: typeof sleep
      now: () => number
      startupPollIntervalMs: number
      startupStabilityWindowMs: number
      startupTimeoutMs: number
      startupRetryLimit: number
    }

    const result = await ensureDaemonRunning(deps)

    expect(result.alreadyRunning).toBe(false)
    expect(result.message).toContain("pid unknown")
  })

  it("returns a health-monitor timeout failure when the daemon never exposes a socket", async () => {
    const { ensureDaemonRunning } = await import("../../../heart/daemon/daemon-cli")

    let nowMs = Date.parse("2026-04-10T05:02:36.000Z")
    const sleep = vi.fn(async (ms: number) => {
      nowMs += ms
    })
    const deps = {
      socketPath: "/tmp/ouro-test.sock",
      sendCommand: vi.fn(),
      startDaemonProcess: vi.fn(async () => ({ pid: 5184 })),
      writeStdout: vi.fn(),
      checkSocketAlive: vi.fn(async () => false),
      cleanupStaleSocket: vi.fn(),
      fallbackPendingMessage: vi.fn(() => "/tmp/pending.jsonl"),
      healthFilePath: "/tmp/ouro-health.json",
      readHealthState: vi.fn(() => null),
      readHealthUpdatedAt: vi.fn(() => nowMs),
      readRecentDaemonLogLines: vi.fn(() => []),
      sleep,
      now: () => nowMs,
      startupPollIntervalMs: 5,
      startupTimeoutMs: 20,
      startupRetryLimit: 0,
    } as OuroCliDeps & {
      readHealthState: () => null
      readHealthUpdatedAt: () => number
      readRecentDaemonLogLines: () => string[]
      sleep: typeof sleep
      now: () => number
      startupPollIntervalMs: number
      startupTimeoutMs: number
      startupRetryLimit: number
    }

    const result = await ensureDaemonRunning(deps)

    expect(result.alreadyRunning).toBe(false)
    expect(result.message).toContain("did not finish booting")
    expect(result.message).toContain("did not answer within 1s")
  })

  it("returns a socket-timeout failure when no health monitor is wired and the daemon never responds", async () => {
    const { ensureDaemonRunning } = await import("../../../heart/daemon/daemon-cli")

    let nowMs = Date.parse("2026-04-10T05:02:36.000Z")
    const sleep = vi.fn(async (ms: number) => {
      nowMs += ms
    })
    const deps = {
      socketPath: "/tmp/ouro-test.sock",
      sendCommand: vi.fn(),
      startDaemonProcess: vi.fn(async () => ({ pid: null })),
      writeStdout: vi.fn(),
      checkSocketAlive: vi.fn(async () => false),
      cleanupStaleSocket: vi.fn(),
      fallbackPendingMessage: vi.fn(() => "/tmp/pending.jsonl"),
      sleep,
      now: () => nowMs,
      startupPollIntervalMs: 5,
      startupTimeoutMs: 20,
      startupRetryLimit: 0,
    } as OuroCliDeps & {
      sleep: typeof sleep
      now: () => number
      startupPollIntervalMs: number
      startupTimeoutMs: number
      startupRetryLimit: number
    }

    const result = await ensureDaemonRunning(deps)

    expect(result.alreadyRunning).toBe(false)
    expect(result.message).toContain("did not finish booting")
    expect(result.message).toContain("did not answer within 1s")
    expect(result.message).toContain("Run `ouro logs` to watch live startup logs")
    expect(result.message).toContain("pid unknown")
  })

  it("returns a replacement-daemon timeout when swapping out an older running daemon", async () => {
    const { ensureDaemonRunning } = await import("../../../heart/daemon/daemon-cli")

    let nowMs = Date.parse("2026-04-10T05:02:36.000Z")
    const sleep = vi.fn(async (ms: number) => {
      nowMs += ms
    })
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
    const deps = {
      socketPath: "/tmp/ouro-test.sock",
      sendCommand,
      startDaemonProcess: vi.fn(async () => ({ pid: 777 })),
      writeStdout: vi.fn(),
      checkSocketAlive: vi.fn().mockResolvedValueOnce(true).mockResolvedValue(false),
      cleanupStaleSocket: vi.fn(),
      fallbackPendingMessage: vi.fn(() => "/tmp/pending.jsonl"),
      healthFilePath: "/tmp/ouro-health.json",
      readHealthState: vi.fn(() => null),
      readHealthUpdatedAt: vi.fn(() => nowMs),
      sleep,
      now: () => nowMs,
      startupPollIntervalMs: 5,
      startupTimeoutMs: 20,
      startupRetryLimit: 0,
    } as OuroCliDeps & {
      readHealthState: () => null
      readHealthUpdatedAt: () => number
      sleep: typeof sleep
      now: () => number
      startupPollIntervalMs: number
      startupTimeoutMs: number
      startupRetryLimit: number
    }

    const result = await ensureDaemonRunning(deps)

    expect(result.ok).toBe(false)
    expect(result.message).toContain("replaced an older background service")
    expect(result.message).toContain("replacement background service did not answer within 1s")
    expect(result.startupFailureReason).toBe("replacement background service did not answer within 1s")
  })

  it("normalizes missing runtime-sync startup reasons to null", async () => {
    vi.resetModules()
    vi.doMock("../../../heart/daemon/runtime-metadata", () => ({
      getRuntimeMetadata: () => ({
        version: "0.1.0-alpha.20",
      }),
    }))
    vi.doMock("../../../heart/daemon/daemon-runtime-sync", async () => {
      const actual = await vi.importActual<typeof import("../../../heart/daemon/daemon-runtime-sync")>("../../../heart/daemon/daemon-runtime-sync")
      return {
        ...actual,
        ensureCurrentDaemonRuntime: vi.fn(async () => ({
          ok: false,
          alreadyRunning: false,
          message: "replacement background service failed",
          verifyStartupStatus: false,
          startedPid: 777,
          startupFailureReason: undefined,
        })),
      }
    })
    try {
      const { ensureDaemonRunning } = await import("../../../heart/daemon/daemon-cli")

      const result = await ensureDaemonRunning({
        socketPath: "/tmp/ouro-test.sock",
        sendCommand: vi.fn(async () => ({
          ok: true,
          summary: "running",
          data: {
            overview: {
              daemon: "running",
              health: "ok",
              socketPath: "/tmp/ouro-test.sock",
              version: "0.1.0-alpha.6",
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
      })

      expect(result.ok).toBe(false)
      expect(result.startupFailureReason).toBeNull()
    } finally {
      vi.doUnmock("../../../heart/daemon/runtime-metadata")
      vi.doUnmock("../../../heart/daemon/daemon-runtime-sync")
      vi.resetModules()
    }
  })

  it("formats unknown pid when startDaemonProcess returns null pid", async () => {
    const { ensureDaemonRunning } = await import("../../../heart/daemon/daemon-cli")

    const deps: OuroCliDeps = {
      socketPath: "/tmp/ouro-test.sock",
      sendCommand: vi.fn(),
      startDaemonProcess: vi.fn(async () => ({ pid: null })),
      writeStdout: vi.fn(),
      checkSocketAlive: vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true),
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

  it("calls pruneDaemonLogs directly for ouro logs prune and prints the bytes-freed summary", async () => {
    const pruneDaemonLogs = vi.fn(() => ({ filesCompacted: 3, bytesFreed: 123456 }))
    const writeStdout = vi.fn()
    const deps: OuroCliDeps = {
      socketPath: "/tmp/ouro-test.sock",
      sendCommand: vi.fn(),
      startDaemonProcess: vi.fn(async () => ({ pid: 1 })),
      writeStdout,
      checkSocketAlive: vi.fn(async () => true),
      cleanupStaleSocket: vi.fn(),
      fallbackPendingMessage: vi.fn(() => "/tmp/pending.jsonl"),
      pruneDaemonLogs,
    }

    const result = await runOuroCli(["logs", "prune"], deps)

    expect(pruneDaemonLogs).toHaveBeenCalledTimes(1)
    expect(deps.sendCommand).not.toHaveBeenCalled()
    expect(result).toBe("compacted 3 files, freed 123456 bytes")
    expect(writeStdout).toHaveBeenCalledWith("compacted 3 files, freed 123456 bytes")
  })

  it("uses singular 'file' in the prune summary when exactly one file is compacted", async () => {
    const pruneDaemonLogs = vi.fn(() => ({ filesCompacted: 1, bytesFreed: 42 }))
    const deps: OuroCliDeps = {
      socketPath: "/tmp/ouro-test.sock",
      sendCommand: vi.fn(),
      startDaemonProcess: vi.fn(async () => ({ pid: 1 })),
      writeStdout: vi.fn(),
      checkSocketAlive: vi.fn(async () => true),
      cleanupStaleSocket: vi.fn(),
      fallbackPendingMessage: vi.fn(() => "/tmp/pending.jsonl"),
      pruneDaemonLogs,
    }

    const result = await runOuroCli(["logs", "prune"], deps)
    expect(result).toBe("compacted 1 file, freed 42 bytes")
  })

  it("prints an unavailable message for ouro logs prune when pruneDaemonLogs dep is missing", async () => {
    const writeStdout = vi.fn()
    const deps: OuroCliDeps = {
      socketPath: "/tmp/ouro-test.sock",
      sendCommand: vi.fn(),
      startDaemonProcess: vi.fn(async () => ({ pid: 1 })),
      writeStdout,
      checkSocketAlive: vi.fn(async () => true),
      cleanupStaleSocket: vi.fn(),
      fallbackPendingMessage: vi.fn(() => "/tmp/pending.jsonl"),
    }

    const result = await runOuroCli(["logs", "prune"], deps)
    expect(result).toBe("logs prune unavailable (dep not wired)")
    expect(writeStdout).toHaveBeenCalledWith("logs prune unavailable (dep not wired)")
  })
})

describe("specialist integration (zero agents -> serpent guide)", () => {
  it("routes bare ouro to serpent guide when zero agents discovered and dep is provided", async () => {
    const runSerpentGuide = vi.fn(async () => "HatchedBot")
    const startChat = vi.fn(async () => {})
    const deps: OuroCliDeps = {
      socketPath: "/tmp/ouro-test.sock",
      sendCommand: vi.fn(async () => ({ ok: true })),
      startDaemonProcess: vi.fn(async () => ({ pid: 42 })),
      writeStdout: vi.fn(),
      checkSocketAlive: vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true),
      cleanupStaleSocket: vi.fn(),
      fallbackPendingMessage: vi.fn(() => "/tmp/pending.jsonl"),

      listDiscoveredAgents: vi.fn(async () => []),
      runSerpentGuide,
      startChat,
    }

    await runOuroCli([], deps)

    expect(runSerpentGuide).toHaveBeenCalledTimes(1)
    // Should NOT have fallen through to the old hatch flow
    expect(deps.sendCommand).not.toHaveBeenCalled()
  })

  it("starts daemon and chat with hatchling name after specialist returns a name", async () => {
    const runSerpentGuide = vi.fn(async () => "MyNewBot")
    const startChat = vi.fn(async () => {})
    const deps: OuroCliDeps = {
      socketPath: "/tmp/ouro-test.sock",
      sendCommand: vi.fn(async () => ({ ok: true })),
      startDaemonProcess: vi.fn(async () => ({ pid: 77 })),
      writeStdout: vi.fn(),
      checkSocketAlive: vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true),
      cleanupStaleSocket: vi.fn(),
      fallbackPendingMessage: vi.fn(() => "/tmp/pending.jsonl"),

      registerOuroBundleType: vi.fn(async () => ({ attempted: true, registered: true })),
      listDiscoveredAgents: vi.fn(async () => []),
      runSerpentGuide,
      startChat,
    }

    await runOuroCli([], deps)

    expect(runSerpentGuide).toHaveBeenCalledTimes(1)
    expect(deps.registerOuroBundleType).toHaveBeenCalledTimes(1)
    expect(deps.startDaemonProcess).toHaveBeenCalled()
    expect(startChat).toHaveBeenCalledWith("MyNewBot")
  })

  it("exits cleanly without starting chat when specialist returns null (aborted)", async () => {
    const runSerpentGuide = vi.fn(async () => null)
    const startChat = vi.fn(async () => {})
    const deps: OuroCliDeps = {
      socketPath: "/tmp/ouro-test.sock",
      sendCommand: vi.fn(async () => ({ ok: true })),
      startDaemonProcess: vi.fn(async () => ({ pid: 1 })),
      writeStdout: vi.fn(),
      checkSocketAlive: vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true),
      cleanupStaleSocket: vi.fn(),
      fallbackPendingMessage: vi.fn(() => "/tmp/pending.jsonl"),

      listDiscoveredAgents: vi.fn(async () => []),
      runSerpentGuide,
      startChat,
    }

    const result = await runOuroCli([], deps)

    expect(runSerpentGuide).toHaveBeenCalledTimes(1)
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
    const runSerpentGuide = vi.fn(async () => {
      callOrder.push("runSerpentGuide")
      return "OrderBot"
    })
    const startChat = vi.fn(async () => {})
    const deps: OuroCliDeps = {
      socketPath: "/tmp/ouro-test.sock",
      sendCommand: vi.fn(async () => ({ ok: true })),
      startDaemonProcess: vi.fn(async () => ({ pid: 1 })),
      writeStdout: vi.fn(),
      checkSocketAlive: vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true),
      cleanupStaleSocket: vi.fn(),
      fallbackPendingMessage: vi.fn(() => "/tmp/pending.jsonl"),
      listDiscoveredAgents: vi.fn(async () => []),
      runSerpentGuide,
      installOuroCommand,
      syncGlobalOuroBotWrapper,
      startChat,
    }

    await runOuroCli([], deps)

    expect(installOuroCommand).toHaveBeenCalledTimes(1)
    expect(syncGlobalOuroBotWrapper).toHaveBeenCalledTimes(1)
    // System setup should happen before the specialist
    expect(callOrder.indexOf("installOuroCommand")).toBeLessThan(callOrder.indexOf("runSerpentGuide"))
    expect(callOrder.indexOf("syncGlobalOuroBotWrapper")).toBeLessThan(callOrder.indexOf("runSerpentGuide"))
  })

  it("surfaces exact remediation when PATH resolves ouro to a stale external launcher", async () => {
    const writeStdout = vi.fn()
    const installOuroCommand = vi.fn(() => ({
      installed: false,
      scriptPath: "/home/test/.ouro-cli/bin/ouro",
      pathReady: true,
      shellProfileUpdated: null,
      repairedOldLauncher: false,
      pathResolution: {
        status: "shadowed" as const,
        expectedPath: "/home/test/.ouro-cli/bin/ouro",
        resolvedPath: "/opt/homebrew/bin/ouro",
        detail: "PATH resolves ouro to /opt/homebrew/bin/ouro before /home/test/.ouro-cli/bin/ouro",
        remediation: "move /home/test/.ouro-cli/bin before /opt/homebrew/bin in PATH, or remove/replace /opt/homebrew/bin/ouro after confirming it is the stale ouro launcher",
      },
    }))
    const deps: OuroCliDeps = {
      socketPath: "/tmp/ouro-test.sock",
      sendCommand: vi.fn(async () => ({ ok: true })),
      startDaemonProcess: vi.fn(async () => ({ pid: 1 })),
      writeStdout,
      checkSocketAlive: vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true),
      cleanupStaleSocket: vi.fn(),
      fallbackPendingMessage: vi.fn(() => "/tmp/pending.jsonl"),
      listDiscoveredAgents: vi.fn(async () => []),
      runSerpentGuide: vi.fn(async () => null),
      installOuroCommand,
    }

    await runOuroCli([], deps)

    expect(writeStdout).toHaveBeenCalledWith(expect.stringContaining("fix ouro PATH: PATH resolves ouro to /opt/homebrew/bin/ouro"))
    expect(writeStdout).toHaveBeenCalledWith(expect.stringContaining("move /home/test/.ouro-cli/bin before /opt/homebrew/bin in PATH"))
  })

  it("announces when system setup repairs a stale shadowing ouro launcher", async () => {
    const writeStdout = vi.fn()
    const installOuroCommand = vi.fn(() => ({
      installed: false,
      scriptPath: "/home/test/.ouro-cli/bin/ouro",
      pathReady: true,
      shellProfileUpdated: null,
      repairedOldLauncher: false,
      repairedShadowedLauncherPath: "/opt/homebrew/bin/ouro",
      pathResolution: {
        status: "ok" as const,
        expectedPath: "/home/test/.ouro-cli/bin/ouro",
        resolvedPath: "/opt/homebrew/bin/ouro",
        detail: "PATH resolves ouro through a compatible wrapper at /opt/homebrew/bin/ouro",
        remediation: null,
      },
    }))
    const deps: OuroCliDeps = {
      socketPath: "/tmp/ouro-test.sock",
      sendCommand: vi.fn(async () => ({ ok: true })),
      startDaemonProcess: vi.fn(async () => ({ pid: 1 })),
      writeStdout,
      checkSocketAlive: vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true),
      cleanupStaleSocket: vi.fn(),
      fallbackPendingMessage: vi.fn(() => "/tmp/pending.jsonl"),
      listDiscoveredAgents: vi.fn(async () => []),
      runSerpentGuide: vi.fn(async () => null),
      installOuroCommand,
    }

    await runOuroCli([], deps)

    expect(writeStdout).toHaveBeenCalledWith("updated stale ouro launcher at /opt/homebrew/bin/ouro")
    expect(writeStdout).not.toHaveBeenCalledWith(expect.stringContaining("fix ouro PATH:"))
  })

  it("handles installOuroCommand failure gracefully during system setup", async () => {
    const installOuroCommand = vi.fn(() => { throw new Error("permission denied") })
    const runSerpentGuide = vi.fn(async () => "GracefulBot")
    const startChat = vi.fn(async () => {})
    const deps: OuroCliDeps = {
      socketPath: "/tmp/ouro-test.sock",
      sendCommand: vi.fn(async () => ({ ok: true })),
      startDaemonProcess: vi.fn(async () => ({ pid: 1 })),
      writeStdout: vi.fn(),
      checkSocketAlive: vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true),
      cleanupStaleSocket: vi.fn(),
      fallbackPendingMessage: vi.fn(() => "/tmp/pending.jsonl"),

      listDiscoveredAgents: vi.fn(async () => []),
      runSerpentGuide,
      installOuroCommand,
      startChat,
    }

    // Should not throw — failure is non-blocking
    await runOuroCli([], deps)

    expect(installOuroCommand).toHaveBeenCalledTimes(1)
    expect(runSerpentGuide).toHaveBeenCalledTimes(1)
    expect(startChat).toHaveBeenCalledWith("GracefulBot")
  })

  it("handles syncGlobalOuroBotWrapper failure gracefully during system setup", async () => {
    const syncGlobalOuroBotWrapper = vi.fn(async () => { throw new Error("npm install failed") })
    const runSerpentGuide = vi.fn(async () => "WrapperBot")
    const startChat = vi.fn(async () => {})
    const deps: OuroCliDeps = {
      socketPath: "/tmp/ouro-test.sock",
      sendCommand: vi.fn(async () => ({ ok: true })),
      startDaemonProcess: vi.fn(async () => ({ pid: 1 })),
      writeStdout: vi.fn(),
      checkSocketAlive: vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true),
      cleanupStaleSocket: vi.fn(),
      fallbackPendingMessage: vi.fn(() => "/tmp/pending.jsonl"),

      listDiscoveredAgents: vi.fn(async () => []),
      runSerpentGuide,
      syncGlobalOuroBotWrapper,
      startChat,
    }

    await runOuroCli([], deps)

    expect(syncGlobalOuroBotWrapper).toHaveBeenCalledTimes(1)
    expect(runSerpentGuide).toHaveBeenCalledTimes(1)
    expect(startChat).toHaveBeenCalledWith("WrapperBot")
  })

  it("falls back to old hatch flow for explicit ouro hatch command even when specialist dep exists", async () => {
    const runSerpentGuide = vi.fn(async () => "ShouldNotBeUsed")
    const runHatchFlow = vi.fn(async () => ({
      bundleRoot: "/tmp/AgentBundles/ExplicitBot.ouro",
      selectedIdentity: "python.md",
    }))

    const deps: OuroCliDeps = {
      socketPath: "/tmp/ouro-test.sock",
      sendCommand: vi.fn(async () => ({ ok: true })),
      startDaemonProcess: vi.fn(async () => ({ pid: 33 })),
      writeStdout: vi.fn(),
      checkSocketAlive: vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true),
      cleanupStaleSocket: vi.fn(),
      fallbackPendingMessage: vi.fn(() => "/tmp/pending.jsonl"),

      registerOuroBundleType: vi.fn(async () => ({ attempted: true, registered: true })),
      runSerpentGuide,
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

    expect(runSerpentGuide).not.toHaveBeenCalled()
    expect(runHatchFlow).toHaveBeenCalled()
    expect(result).toContain("hatched ExplicitBot")
    expect(result).not.toContain("vault unlock secret")
  })

  it("renders a shared hatch completion board in TTY mode for explicit hatch flows", async () => {
    const runHatchFlow = vi.fn(async () => ({
      bundleRoot: "/tmp/AgentBundles/ExplicitBot.ouro",
      selectedIdentity: "python.md",
    }))
    const deps: OuroCliDeps = {
      socketPath: "/tmp/ouro-test.sock",
      sendCommand: vi.fn(async () => ({ ok: true })),
      startDaemonProcess: vi.fn(async () => ({ pid: 33 })),
      writeStdout: vi.fn(),
      checkSocketAlive: vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true),
      cleanupStaleSocket: vi.fn(),
      fallbackPendingMessage: vi.fn(() => "/tmp/pending.jsonl"),
      registerOuroBundleType: vi.fn(async () => ({ attempted: true, registered: true })),
      runHatchFlow,
      isTTY: true,
      stdoutColumns: 78,
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

    expect(result).toContain("Hatch complete")
    expect(result).toContain("ExplicitBot is ready for first contact.")
    expect(result).toContain("What changed")
    expect(result).toContain("Next moves")
  })

  it("routes bare ouro hatch through specialist when no explicit args given", async () => {
    const runSerpentGuide = vi.fn(async () => "HatchedViaSpecialist")
    const startChat = vi.fn(async () => {})
    const deps: OuroCliDeps = {
      socketPath: "/tmp/ouro-test.sock",
      sendCommand: vi.fn(async () => ({ ok: true })),
      startDaemonProcess: vi.fn(async () => ({ pid: 42 })),
      writeStdout: vi.fn(),
      checkSocketAlive: vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true),
      cleanupStaleSocket: vi.fn(),
      fallbackPendingMessage: vi.fn(() => "/tmp/pending.jsonl"),

      registerOuroBundleType: vi.fn(async () => ({ attempted: true, registered: true })),
      runSerpentGuide,
      startChat,
    }

    const result = await runOuroCli(["hatch"], deps)

    expect(runSerpentGuide).toHaveBeenCalledTimes(1)
    expect(startChat).toHaveBeenCalledWith("HatchedViaSpecialist")
    expect(result).toBe("")
  })

  it("renders a shared hatch welcome shell in TTY mode before launching the specialist", async () => {
    const runSerpentGuide = vi.fn(async () => null)
    const writeStdout = vi.fn()
    const deps: OuroCliDeps = {
      socketPath: "/tmp/ouro-test.sock",
      sendCommand: vi.fn(async () => ({ ok: true })),
      startDaemonProcess: vi.fn(async () => ({ pid: 1 })),
      writeStdout,
      checkSocketAlive: vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true),
      cleanupStaleSocket: vi.fn(),
      fallbackPendingMessage: vi.fn(() => "/tmp/pending.jsonl"),
      runSerpentGuide,
      isTTY: true,
      stdoutColumns: 74,
    }

    await runOuroCli(["hatch"], deps)

    const output = writeStdout.mock.calls.map(([text]) => text).join("\n")
    expect(output).toContain("___    _   _")
    expect(output).toContain("Hatch an agent")
  })

  it("returns empty string without starting chat on bare ouro hatch when startChat is not provided", async () => {
    const runSerpentGuide = vi.fn(async () => "NoChatHatch")
    const deps: OuroCliDeps = {
      socketPath: "/tmp/ouro-test.sock",
      sendCommand: vi.fn(async () => ({ ok: true })),
      startDaemonProcess: vi.fn(async () => ({ pid: 11 })),
      writeStdout: vi.fn(),
      checkSocketAlive: vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true),
      cleanupStaleSocket: vi.fn(),
      fallbackPendingMessage: vi.fn(() => "/tmp/pending.jsonl"),

      registerOuroBundleType: vi.fn(async () => ({ attempted: true, registered: true })),
      runSerpentGuide,
      // No startChat provided
    }

    const result = await runOuroCli(["hatch"], deps)

    expect(runSerpentGuide).toHaveBeenCalledTimes(1)
    expect(result).toBe("")
  })

  it("returns empty string when specialist returns null on bare ouro hatch", async () => {
    const runSerpentGuide = vi.fn(async () => null)
    const deps: OuroCliDeps = {
      socketPath: "/tmp/ouro-test.sock",
      sendCommand: vi.fn(async () => ({ ok: true })),
      startDaemonProcess: vi.fn(async () => ({ pid: 1 })),
      writeStdout: vi.fn(),
      checkSocketAlive: vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true),
      cleanupStaleSocket: vi.fn(),
      fallbackPendingMessage: vi.fn(() => "/tmp/pending.jsonl"),

      runSerpentGuide,
    }

    const result = await runOuroCli(["hatch"], deps)

    expect(runSerpentGuide).toHaveBeenCalledTimes(1)
    expect(result).toBe("")
  })

  it("returns empty string without starting chat when startChat is not provided", async () => {
    const runSerpentGuide = vi.fn(async () => "NoChatBot")
    const deps: OuroCliDeps = {
      socketPath: "/tmp/ouro-test.sock",
      sendCommand: vi.fn(async () => ({ ok: true })),
      startDaemonProcess: vi.fn(async () => ({ pid: 88 })),
      writeStdout: vi.fn(),
      checkSocketAlive: vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true),
      cleanupStaleSocket: vi.fn(),
      fallbackPendingMessage: vi.fn(() => "/tmp/pending.jsonl"),

      registerOuroBundleType: vi.fn(async () => ({ attempted: true, registered: true })),
      listDiscoveredAgents: vi.fn(async () => []),
      runSerpentGuide,
      // No startChat provided
    }

    const result = await runOuroCli([], deps)

    expect(runSerpentGuide).toHaveBeenCalledTimes(1)
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
      listDiscoveredAgents: vi.fn(async () => ["slugger"]),
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
      listDiscoveredAgents: vi.fn(async () => ["slugger"]),
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

      listDiscoveredAgents: vi.fn(async () => ["slugger"]),
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

      listDiscoveredAgents: vi.fn(async () => ["slugger"]),
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

  it("ouro whoami renders a shared identity board in TTY mode", async () => {
    const deps = makeDeps({
      whoamiInfo: vi.fn(() => ({
        agentName: "slugger",
        homePath: "/Users/ari/AgentBundles/slugger.ouro",
        bonesVersion: "0.1.0-alpha.31",
      })),
      isTTY: true,
      stdoutColumns: 74,
    })
    const result = await runOuroCli(["whoami"], deps)

    expect(result).toContain("___    _   _")
    expect(result).toContain("Identity")
    expect(result).toContain("slugger")
    expect(result).toContain("/Users/ari/AgentBundles/slugger.ouro")
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
    const result = await deps.scanSessions?.("slugger")

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
  function addBundleToRoot(bundlesRoot: string, agentName: string, agentJsonRaw: string): string {
    const agentRoot = path.join(bundlesRoot, `${agentName}.ouro`)
    fs.mkdirSync(agentRoot, { recursive: true })
    fs.writeFileSync(path.join(agentRoot, "agent.json"), agentJsonRaw, "utf-8")
    return agentRoot
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

      listDiscoveredAgents: vi.fn(async () => ["slugger"]),
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
    // No whoamiInfo dep, runtime context, or discovered agents.
    const deps = makeDeps({
      listDiscoveredAgents: vi.fn(async () => []),
      whoamiInfo: vi.fn(() => { throw new Error("no agent context") }),
    })
    const result = await runOuroCli(["whoami"], deps)

    expect(result).toContain("no agents found")
    expect(result).toContain("ouro")
  })

  it("whoami without --agent prompts for an agent when multiple are available", async () => {
    const deps = makeDeps({
      listDiscoveredAgents: vi.fn(async () => ["slugger", "ouroboros"]),
      promptInput: vi.fn(async () => "ouroboros"),
      whoamiInfo: vi.fn(() => { throw new Error("no agent context") }),
    })
    const result = await runOuroCli(["whoami"], deps)

    expect(deps.promptInput).toHaveBeenCalledWith(expect.stringContaining("Which agent should this use?"))
    expect(result).toContain("agent: ouroboros")
    expect(result).toContain("ouroboros.ouro")
  })

  it("whoami falls back to the no-agents message when agent resolution throws unexpectedly", async () => {
    const deps = makeDeps({
      listDiscoveredAgents: vi.fn(() => {
        throw new Error("exploded discovery")
      }),
    })
    const result = await runOuroCli(["whoami"], deps)

    expect(result).toContain("no agents found")
    expect(result).toContain("ouro clone")
  })

  it("task board without --agent prompts and reads the selected agent bundle", async () => {
    const tmp = createTmpBundle({ agentName: "slugger" })
    try {
      const agentJsonRaw = fs.readFileSync(tmp.agentConfigPath, "utf-8")
      const otherAgentRoot = addBundleToRoot(tmp.bundlesRoot, "ouroboros", agentJsonRaw)
      createTaskModule(path.join(tmp.agentRoot, "tasks")).createTask({
        title: "Slugger task",
        type: "one-shot",
        category: "general",
        body: "",
      })
      createTaskModule(path.join(otherAgentRoot, "tasks")).createTask({
        title: "Ouroboros task",
        type: "one-shot",
        category: "general",
        body: "",
      })

      const deps = makeDeps({
        bundlesRoot: tmp.bundlesRoot,
        listDiscoveredAgents: vi.fn(async () => ["slugger", "ouroboros"]),
        promptInput: vi.fn(async () => "ouroboros"),
      })
      const result = await runOuroCli(["task", "board"], deps)

      expect(deps.promptInput).toHaveBeenCalledWith(expect.stringContaining("Which agent should this use?"))
      expect(result).toContain("ouroboros-task")
      expect(result).not.toContain("Slugger task")
    } finally {
      tmp.cleanup()
    }
  })

  it("reminder create without --agent prompts and writes into the selected agent bundle", async () => {
    const tmp = createTmpBundle({ agentName: "slugger" })
    try {
      const agentJsonRaw = fs.readFileSync(tmp.agentConfigPath, "utf-8")
      const otherAgentRoot = addBundleToRoot(tmp.bundlesRoot, "ouroboros", agentJsonRaw)
      const deps = makeDeps({
        bundlesRoot: tmp.bundlesRoot,
        listDiscoveredAgents: vi.fn(async () => ["slugger", "ouroboros"]),
        promptInput: vi.fn(async () => "ouroboros"),
      })

      const result = await runOuroCli(
        ["reminder", "create", "Ping Ari", "--body", "Check daemon status", "--at", "2026-03-10T17:00:00.000Z"],
        deps,
      )

      const sluggerOneShots = path.join(tmp.agentRoot, "tasks", "one-shots")
      const ouroborosOneShots = path.join(otherAgentRoot, "tasks", "one-shots")
      const sluggerFiles = fs.existsSync(sluggerOneShots) ? fs.readdirSync(sluggerOneShots) : []
      const ouroborosFiles = fs.existsSync(ouroborosOneShots) ? fs.readdirSync(ouroborosOneShots) : []

      expect(deps.promptInput).toHaveBeenCalledWith(expect.stringContaining("Which agent should this use?"))
      expect(result).toContain("ouroboros.ouro/tasks")
      expect(sluggerFiles).toHaveLength(0)
      expect(ouroborosFiles.length).toBeGreaterThan(0)
    } finally {
      tmp.cleanup()
    }
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

  it("friend list without --agent prompts and reads the selected agent store", async () => {
    const tmp = createTmpBundle({ agentName: "slugger" })
    try {
      const agentJsonRaw = fs.readFileSync(tmp.agentConfigPath, "utf-8")
      const otherAgentRoot = addBundleToRoot(tmp.bundlesRoot, "ouroboros", agentJsonRaw)
      const sluggerFriendsDir = path.join(tmp.agentRoot, "friends")
      const ouroborosFriendsDir = path.join(otherAgentRoot, "friends")
      fs.mkdirSync(sluggerFriendsDir, { recursive: true })
      fs.mkdirSync(ouroborosFriendsDir, { recursive: true })
      fs.writeFileSync(path.join(sluggerFriendsDir, "slugger-friend.json"), JSON.stringify({
        id: "slugger-friend",
        name: "Slugger Friend",
        trustLevel: "friend",
        externalIds: [],
        tenantMemberships: [],
        toolPreferences: {},
        notes: {},
        totalTokens: 0,
        createdAt: "2026-03-01T00:00:00.000Z",
        updatedAt: "2026-03-01T00:00:00.000Z",
        schemaVersion: 1,
      }, null, 2))
      fs.writeFileSync(path.join(ouroborosFriendsDir, "ouroboros-friend.json"), JSON.stringify({
        id: "ouroboros-friend",
        name: "Ouroboros Friend",
        trustLevel: "family",
        externalIds: [],
        tenantMemberships: [],
        toolPreferences: {},
        notes: {},
        totalTokens: 0,
        createdAt: "2026-03-01T00:00:00.000Z",
        updatedAt: "2026-03-01T00:00:00.000Z",
        schemaVersion: 1,
      }, null, 2))

      const deps = makeDeps({
        bundlesRoot: tmp.bundlesRoot,
        listDiscoveredAgents: vi.fn(async () => ["slugger", "ouroboros"]),
        promptInput: vi.fn(async () => "ouroboros"),
      })
      const result = await runOuroCli(["friend", "list"], deps)

      expect(deps.promptInput).toHaveBeenCalledWith(expect.stringContaining("Which agent should this use?"))
      expect(result).toContain("Ouroboros Friend")
      expect(result).not.toContain("Slugger Friend")
    } finally {
      tmp.cleanup()
    }
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

  it("session list without --agent prompts and passes the selected agent to the scanner", async () => {
    const scanSessions = vi.fn(async (agentName: string) => [
      { friendId: `${agentName}-friend`, friendName: `${agentName} friend`, channel: "cli", lastActivity: "2026-03-09T12:00:00.000Z" },
    ])
    const deps = makeDeps({
      scanSessions,
      listDiscoveredAgents: vi.fn(async () => ["slugger", "ouroboros"]),
      promptInput: vi.fn(async () => "ouroboros"),
    })
    const result = await runOuroCli(["session", "list"], deps)

    expect(deps.promptInput).toHaveBeenCalledWith(expect.stringContaining("Which agent should this use?"))
    expect(scanSessions).toHaveBeenCalledWith("ouroboros")
    expect(result).toContain("ouroboros-friend")
    expect(result).toContain("ouroboros friend")
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

  it("habit list without --agent prompts and reads the selected agent habits", async () => {
    const tmp = createTmpBundle({ agentName: "slugger" })
    try {
      const agentJsonRaw = fs.readFileSync(tmp.agentConfigPath, "utf-8")
      const otherAgentRoot = addBundleToRoot(tmp.bundlesRoot, "ouroboros", agentJsonRaw)
      const sluggerHabitsDir = path.join(tmp.agentRoot, "habits")
      const ouroborosHabitsDir = path.join(otherAgentRoot, "habits")
      fs.mkdirSync(sluggerHabitsDir, { recursive: true })
      fs.mkdirSync(ouroborosHabitsDir, { recursive: true })
      fs.writeFileSync(path.join(sluggerHabitsDir, "slugger-check-in.md"), [
        "---",
        "title: Slugger Check-In",
        "cadence: 24h",
        "status: active",
        "lastRun: null",
        "created: 2026-03-01T00:00:00.000Z",
        "---",
        "",
        "Check in.",
      ].join("\n"), "utf-8")
      fs.writeFileSync(path.join(ouroborosHabitsDir, "ouroboros-heartbeat.md"), [
        "---",
        "title: Ouroboros Heartbeat",
        "cadence: 30m",
        "status: active",
        "lastRun: 2026-03-27T10:00:00.000Z",
        "created: 2026-03-01T00:00:00.000Z",
        "---",
        "",
        "Pulse.",
      ].join("\n"), "utf-8")

      const deps = makeDeps({
        bundlesRoot: tmp.bundlesRoot,
        listDiscoveredAgents: vi.fn(async () => ["slugger", "ouroboros"]),
        promptInput: vi.fn(async () => "ouroboros"),
      })
      const result = await runOuroCli(["habit", "list"], deps)

      expect(deps.promptInput).toHaveBeenCalledWith(expect.stringContaining("Which agent should this use?"))
      expect(result).toContain("ouroboros-heartbeat")
      expect(result).not.toContain("slugger-check-in")
    } finally {
      tmp.cleanup()
    }
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
  // Self-contained tmpdir bundle so this suite never writes into ~/AgentBundles.
  // The thoughts CLI handler honors `deps.bundlesRoot` so we route reads here.
  //
  // IMPORTANT: createTmpBundle() is called inside beforeAll, NOT at describe
  // scope. Previously it ran at collection time (module load) and registered
  // a live handle in _liveHandles BEFORE any test ran. The tmpbundle leak
  // guard's afterEach then fired on the FIRST test in the entire file
  // ("ouro CLI parsing > parses primary daemon commands" at line 28),
  // noticed the pre-existing handle, and forcibly cleaned it + logged a
  // misleading leak warning blaming that test. Moving the handle creation
  // into beforeAll means the handle only exists while the thoughts suite
  // is actually running, and afterAll's cleanup aligns with it.
  let tmp: ReturnType<typeof createTmpBundle>
  let testAgentName: string
  let agentBundlesRoot: string
  let testAgentRoot: string
  let sessionDir: string
  let sessionFile: string

  beforeAll(() => {
    // `shared: true` tells the tmpbundle leak guard this handle lives across
    // the whole describe block (beforeAll → afterAll) and should not be
    // flagged as leaked by afterEach on the individual tests that use it.
    tmp = createTmpBundle({ agentName: "thoughts-test", shared: true })
    testAgentName = tmp.agentName
    agentBundlesRoot = tmp.bundlesRoot
    testAgentRoot = tmp.agentRoot
    sessionDir = path.join(testAgentRoot, "state", "sessions", "self", "inner")
    sessionFile = path.join(sessionDir, "dialog.json")
  })

  function makeDeps(overrides?: Partial<OuroCliDeps>): OuroCliDeps {
    return {
      socketPath: "/tmp/ouro-test.sock",
      sendCommand: vi.fn(),
      startDaemonProcess: vi.fn(async () => ({ pid: 1 })),
      writeStdout: vi.fn(),
      checkSocketAlive: vi.fn(async () => true),
      cleanupStaleSocket: vi.fn(),
      fallbackPendingMessage: vi.fn(() => "/tmp/pending.jsonl"),
      bundlesRoot: agentBundlesRoot,
      ...overrides,
    }
  }

  function writeSessionFile(messages: unknown[]): void {
    fs.mkdirSync(sessionDir, { recursive: true })
    fs.writeFileSync(sessionFile, JSON.stringify({ version: 1, messages }))
  }

  afterAll(() => {
    tmp.cleanup()
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

  it("returns a clear no-agents message when thoughts has no target to use", async () => {
    const deps = makeDeps({
      listDiscoveredAgents: vi.fn(async () => []),
    })
    const result = await runOuroCli(["thoughts"], deps)

    expect(result).toContain("no agents found")
    expect(result).toContain("ouro")
  })

  it("uses runtime agent context when thoughts omits --agent", async () => {
    writeSessionFile([
      { role: "system", content: "system prompt" },
      { role: "user", content: "waking up.\n\nwhat needs my attention?" },
      { role: "assistant", content: "runtime context found me." },
    ])
    const listDiscoveredAgents = vi.fn(async () => ["other-agent"])
    const deps = makeDeps({
      listDiscoveredAgents,
      whoamiInfo: vi.fn(() => ({
        agentName: testAgentName,
      })),
    })
    const result = await runOuroCli(["thoughts"], deps)

    expect(result).toContain("runtime context found me.")
    expect(listDiscoveredAgents).not.toHaveBeenCalled()
  })

  it("returns multi-agent guidance when thoughts omits --agent without prompt support", async () => {
    const deps = makeDeps({
      listDiscoveredAgents: vi.fn(async () => ["slugger", "ouroboros"]),
    })
    const result = await runOuroCli(["thoughts"], deps)

    expect(result).toContain("multiple agents found: slugger, ouroboros")
    expect(result).toContain("Re-run with --agent <name>.")
  })

  it("returns invalid-selection guidance when thoughts prompt answer is blank", async () => {
    const deps = makeDeps({
      listDiscoveredAgents: vi.fn(async () => ["slugger", "ouroboros"]),
      promptInput: vi.fn(async () => "   "),
    })
    const result = await runOuroCli(["thoughts"], deps)

    expect(result).toContain("invalid agent selection. Available agents: slugger, ouroboros")
    expect(result).toContain("Re-run with --agent <name>.")
  })

  it("returns invalid-selection guidance when thoughts prompt answer is not a name or number", async () => {
    const deps = makeDeps({
      listDiscoveredAgents: vi.fn(async () => ["slugger", "ouroboros"]),
      promptInput: vi.fn(async () => "definitely-not-an-agent"),
    })
    const result = await runOuroCli(["thoughts"], deps)

    expect(result).toContain("invalid agent selection. Available agents: slugger, ouroboros")
    expect(result).toContain("Re-run with --agent <name>.")
  })

  it("returns the defensive no-agent-context message when thought parsing throws unexpectedly", async () => {
    const parseSpy = vi.spyOn(daemonThoughts, "parseInnerDialogSession").mockImplementation(() => {
      throw new Error("unexpected parse failure")
    })
    try {
      const deps = makeDeps()
      const result = await runOuroCli(["thoughts", "--agent", testAgentName], deps)

      expect(result).toContain("error: no agent context")
    } finally {
      parseSpy.mockRestore()
    }
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

describe("ouro inner CLI execution", () => {
  function makeDeps(overrides?: Partial<OuroCliDeps>): OuroCliDeps {
    return {
      socketPath: "/tmp/ouro-test.sock",
      sendCommand: vi.fn(),
      startDaemonProcess: vi.fn(async () => ({ pid: 1 })),
      writeStdout: vi.fn(),
      checkSocketAlive: vi.fn(async () => true),
      cleanupStaleSocket: vi.fn(),
      fallbackPendingMessage: vi.fn(() => "/tmp/pending.jsonl"),
      listDiscoveredAgents: vi.fn(async () => ["slugger"]),
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

  it("reads runtime state from the canonical self/inner/dialog session path", async () => {
    const tempBundle = fs.mkdtempSync(path.join(os.tmpdir(), "inner-status-bundle-"))
    cleanup.push(tempBundle)

    fs.mkdirSync(path.join(tempBundle, "state", "sessions", "self", "inner"), { recursive: true })
    fs.mkdirSync(path.join(tempBundle, "habits"), { recursive: true })
    fs.mkdirSync(path.join(tempBundle, "journal"), { recursive: true })
    fs.writeFileSync(
      path.join(tempBundle, "state", "sessions", "self", "inner", "runtime.json"),
      JSON.stringify({
        status: "idle",
        reason: "heartbeat",
        lastCompletedAt: "2026-03-26T10:25:00.000Z",
      }, null, 2),
      "utf-8",
    )
    fs.writeFileSync(
      path.join(tempBundle, "habits", "heartbeat.md"),
      ["---", "title: heartbeat", "cadence: 30m", "status: active", "---", "", "check in"].join("\n"),
      "utf-8",
    )

    const deps = makeDeps({ agentBundleRoot: tempBundle })
    const result = await runOuroCli(["inner", "--agent", "test"], deps)

    expect(result).toContain("status: idle")
    expect(result).toContain("last turn:")
    expect(result).not.toContain("status: unknown")
  })
})

describe("ouro up startup progress", () => {
  it("prints ordered startup phase output before reporting daemon success", async () => {
    let nowMs = Date.parse("2026-04-10T05:02:36.000Z")
    const writeStdout = vi.fn()
    const sleep = vi.fn(async (ms: number) => {
      nowMs += ms
    })
    const deps = {
      socketPath: "/tmp/ouro-test.sock",
      sendCommand: sendCommandWithRunningStatus(),
      startDaemonProcess: vi.fn(async () => ({ pid: 5683 })),
      writeStdout,
      checkSocketAlive: vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(false).mockResolvedValue(true),
      cleanupStaleSocket: vi.fn(),
      fallbackPendingMessage: vi.fn(() => "/tmp/pending.jsonl"),
      healthFilePath: "/tmp/ouro-health.json",
      readHealthState: vi.fn(() => ({
        status: "ok",
        mode: "normal",
        pid: 5683,
        startedAt: new Date(nowMs).toISOString(),
        uptimeSeconds: 0,
        safeMode: null,
        degraded: [],
        agents: {},
        habits: {},
      })),
      readHealthUpdatedAt: vi.fn(() => nowMs),
      readRecentDaemonLogLines: vi.fn(() => []),
      sleep,
      now: () => nowMs,
      startupPollIntervalMs: 5,
      startupStabilityWindowMs: 15,
      startupTimeoutMs: 60,
    } as OuroCliDeps & {
      readHealthState: () => {
        status: string
        mode: string
        pid: number
        startedAt: string
        uptimeSeconds: number
        safeMode: null
        degraded: []
        agents: Record<string, never>
        habits: Record<string, never>
      }
      readHealthUpdatedAt: () => number
      readRecentDaemonLogLines: () => string[]
      sleep: typeof sleep
      now: () => number
      startupPollIntervalMs: number
      startupStabilityWindowMs: number
      startupTimeoutMs: number
    }

    const result = await runOuroCli(["up"], deps)
    const lines = writeStdout.mock.calls.map((call: unknown[]) => String(call[0]))
    const startIndex = lines.findIndex((line) => line.includes("starting a fresh background service"))
    const socketIndex = lines.findIndex((line) => line.includes("waiting for the new background service to answer"))
    const healthIndex = lines.findIndex((line) => line.includes("waiting for this boot to publish its ready signal"))
    const stableIndex = lines.findIndex((line) => line.includes("\u2713 starting daemon"))

    expect(result).toContain("daemon started")
    expect(startIndex).toBeGreaterThanOrEqual(0)
    expect(socketIndex).toBeGreaterThan(startIndex)
    expect(healthIndex).toBeGreaterThan(socketIndex)
    expect(stableIndex).toBeGreaterThan(healthIndex)
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

  it("parses config model without --agent so execution can resolve it", () => {
    expect(parseOuroCommand(["config", "model", "gpt-5"])).toEqual({
      kind: "config.model",
      modelName: "gpt-5",
    })
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

  it("parses config models without --agent so execution can resolve it", () => {
    expect(parseOuroCommand(["config", "models"])).toEqual({
      kind: "config.models",
    })
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

  it("config.model updates the local provider-state lane instead of agent.json", async () => {
    const tmp = createTmpBundle({
      agentName: "config-model-facing",
      agentJson: {
        version: 2, enabled: true, provider: "anthropic",
        humanFacing: { provider: "anthropic", model: "claude-opus-4-6" },
        agentFacing: { provider: "anthropic", model: "claude-opus-4-6" },
        phrases: { thinking: ["working"], tool: ["running tool"], followup: ["processing"] },
      },
    })
    const deps: OuroCliDeps = {
      socketPath: "/tmp/ouro-test.sock",
      sendCommand: vi.fn(async () => ({ ok: true, message: "ok" })),
      startDaemonProcess: vi.fn(async () => ({ pid: 1 })),
      writeStdout: vi.fn(),
      checkSocketAlive: vi.fn(async () => true),
      cleanupStaleSocket: vi.fn(),
      fallbackPendingMessage: vi.fn(() => "/tmp/pending.jsonl"),
      bundlesRoot: tmp.bundlesRoot,
    }
    try {
      const result = await runOuroCli(["config", "model", "--agent", tmp.agentName, "--facing", "human", "claude-sonnet-4.6"], deps)
      expect(result).toContain("claude-sonnet-4.6")
      expect(result).toContain("deprecated")
      const updated = JSON.parse(fs.readFileSync(tmp.agentConfigPath, "utf-8")) as any
      expect(updated.humanFacing.model).toBe("claude-opus-4-6")
      expect(updated.agentFacing.model).toBe("claude-opus-4-6")
      const stateResult = readProviderState(tmp.agentRoot)
      expect(stateResult.ok).toBe(true)
      if (!stateResult.ok) throw new Error(stateResult.error)
      expect(stateResult.state.lanes.outward.model).toBe("claude-sonnet-4.6")
      expect(stateResult.state.lanes.inner.model).toBe("claude-opus-4-6")
    } finally {
      tmp.cleanup()
    }
  })

  it("resolves config model to the only discovered agent when --agent is omitted", async () => {
    const tmp = createTmpBundle({
      agentName: "config-single",
      agentJson: {
        version: 2,
        enabled: true,
        provider: "anthropic",
        humanFacing: { provider: "anthropic", model: "claude-opus-4-6" },
        agentFacing: { provider: "anthropic", model: "claude-opus-4-6" },
        phrases: { thinking: ["working"], tool: ["running tool"], followup: ["processing"] },
      },
    })
    const deps: OuroCliDeps = {
      socketPath: "/tmp/ouro-test.sock",
      sendCommand: vi.fn(async () => ({ ok: true, message: "ok" })),
      startDaemonProcess: vi.fn(async () => ({ pid: 1 })),
      writeStdout: vi.fn(),
      checkSocketAlive: vi.fn(async () => true),
      cleanupStaleSocket: vi.fn(),
      fallbackPendingMessage: vi.fn(() => "/tmp/pending.jsonl"),
      bundlesRoot: tmp.bundlesRoot,
      listDiscoveredAgents: vi.fn(async () => [tmp.agentName]),
    }
    try {
      const result = await runOuroCli(["config", "model", "gpt-5.4"], deps)
      expect(result).toContain("gpt-5.4")
      const stateResult = readProviderState(tmp.agentRoot)
      expect(stateResult.ok).toBe(true)
      if (!stateResult.ok) throw new Error(stateResult.error)
      expect(stateResult.state.lanes.outward.model).toBe("gpt-5.4")
    } finally {
      tmp.cleanup()
    }
  })
})

describe("auth.switch with facing", () => {
  it("auth switch updates specified local provider-state lane only", async () => {
    const tmp = createTmpBundle({
      agentName: "auth-switch-facing",
      agentJson: {
        version: 2, enabled: true, provider: "anthropic",
        humanFacing: { provider: "anthropic", model: "claude-opus-4-6" },
        agentFacing: { provider: "anthropic", model: "claude-opus-4-6" },
        phrases: { thinking: ["working"], tool: ["running tool"], followup: ["processing"] },
      },
    })
    const deps: OuroCliDeps = {
      socketPath: "/tmp/ouro-test.sock",
      sendCommand: vi.fn(async () => ({ ok: true, message: "ok" })),
      startDaemonProcess: vi.fn(async () => ({ pid: 1 })),
      writeStdout: vi.fn(),
      checkSocketAlive: vi.fn(async () => true),
      cleanupStaleSocket: vi.fn(),
      fallbackPendingMessage: vi.fn(() => "/tmp/pending.jsonl"),
      bundlesRoot: tmp.bundlesRoot,
    }
    try {
      const result = await runOuroCli(["auth", "switch", "--agent", tmp.agentName, "--provider", "github-copilot", "--facing", "human"], deps)
      expect(result).toContain("switched")
      expect(result).toContain("github-copilot")
      const updated = JSON.parse(fs.readFileSync(tmp.agentConfigPath, "utf-8")) as any
      expect(updated.humanFacing.provider).toBe("anthropic")
      expect(updated.agentFacing.provider).toBe("anthropic")
      const stateResult = readProviderState(tmp.agentRoot)
      expect(stateResult.ok).toBe(true)
      if (!stateResult.ok) throw new Error(stateResult.error)
      expect(stateResult.state.lanes.outward.provider).toBe("github-copilot")
      expect(stateResult.state.lanes.inner.provider).toBe("anthropic")
    } finally {
      tmp.cleanup()
    }
  })

  it("auth switch updates both local provider-state lanes when --facing is not specified", async () => {
    const tmp = createTmpBundle({
      agentName: "auth-switch-both",
      agentJson: {
        version: 2, enabled: true, provider: "anthropic",
        humanFacing: { provider: "anthropic", model: "claude-opus-4-6" },
        agentFacing: { provider: "anthropic", model: "claude-opus-4-6" },
        phrases: { thinking: ["working"], tool: ["running tool"], followup: ["processing"] },
      },
    })
    const deps: OuroCliDeps = {
      socketPath: "/tmp/ouro-test.sock",
      sendCommand: vi.fn(async () => ({ ok: true, message: "ok" })),
      startDaemonProcess: vi.fn(async () => ({ pid: 1 })),
      writeStdout: vi.fn(),
      checkSocketAlive: vi.fn(async () => true),
      cleanupStaleSocket: vi.fn(),
      fallbackPendingMessage: vi.fn(() => "/tmp/pending.jsonl"),
      bundlesRoot: tmp.bundlesRoot,
    }
    try {
      const result = await runOuroCli(["auth", "switch", "--agent", tmp.agentName, "--provider", "minimax"], deps)
      expect(result).toContain("switched")
      const updated = JSON.parse(fs.readFileSync(tmp.agentConfigPath, "utf-8")) as any
      expect(updated.humanFacing.provider).toBe("anthropic")
      expect(updated.agentFacing.provider).toBe("anthropic")
      const stateResult = readProviderState(tmp.agentRoot)
      expect(stateResult.ok).toBe(true)
      if (!stateResult.ok) throw new Error(stateResult.error)
      expect(stateResult.state.lanes.outward.provider).toBe("minimax")
      expect(stateResult.state.lanes.inner.provider).toBe("minimax")
    } finally {
      tmp.cleanup()
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
      listDiscoveredAgents: vi.fn(async () => ["slugger"]),
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

  it("ouro habit list scans habits/ and displays resolved name/cadence/status/lastRun", async () => {
    const tempBundle = fs.mkdtempSync(path.join(os.tmpdir(), "habit-list-"))
    cleanup.push(tempBundle)

    const habitsDir = path.join(tempBundle, "habits")
    const runtimeStateDir = path.join(tempBundle, "state", "habits")
    fs.mkdirSync(habitsDir, { recursive: true })
    fs.mkdirSync(runtimeStateDir, { recursive: true })

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

    fs.writeFileSync(path.join(runtimeStateDir, "heartbeat.json"), JSON.stringify({
      schemaVersion: 1,
      name: "heartbeat",
      lastRun: "2026-03-27T12:00:00.000Z",
      updatedAt: "2026-03-27T12:00:00.000Z",
    }, null, 2), "utf-8")

    const deps = makeDeps({ agentBundleRoot: tempBundle })
    const result = await runOuroCli(["habit", "list", "--agent", "test"], deps)

    expect(result).toContain("heartbeat")
    expect(result).toContain("30m")
    expect(result).toContain("active")
    expect(result).toContain("daily-reflection")
    expect(result).toContain("24h")
    expect(result).toContain("paused")
    expect(result).toContain("2026-03-27T12:00:00.000Z")
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
    expect(content).not.toContain("lastRun:")
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

describe("chat provider health check", () => {
  const mockHealthCheck = checkAgentConfigWithProviderHealth as ReturnType<typeof vi.fn>

  it("ouro chat bails with error when provider health check fails", async () => {
    mockHealthCheck.mockResolvedValueOnce({
      ok: false,
      error: "azure token expired",
      fix: "run ouro auth refresh",
    })
    const startChat = vi.fn(async () => {})
    const deps = {
      socketPath: "/tmp/ouro-test.sock",
      sendCommand: vi.fn(async () => ({ ok: true, message: "unexpected" })),
      startDaemonProcess: vi.fn(async () => ({ pid: 42 })),
      writeStdout: vi.fn(),
      checkSocketAlive: vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true),
      cleanupStaleSocket: vi.fn(),
      fallbackPendingMessage: vi.fn(() => "/tmp/pending.jsonl"),
      listDiscoveredAgents: vi.fn(async () => ["slugger"]),
      startChat,
    } as OuroCliDeps & {
      listDiscoveredAgents: () => Promise<string[]>
      startChat: typeof startChat
    }

    const result = await runOuroCli(["chat", "slugger"], deps)

    expect(startChat).not.toHaveBeenCalled()
    expect(deps.writeStdout).toHaveBeenCalledWith(
      expect.stringContaining("azure token expired"),
    )
    expect(deps.writeStdout).toHaveBeenCalledWith(
      expect.stringContaining("run ouro auth refresh"),
    )
    expect(result).toContain("azure token expired")
  })

  it("ouro chat proceeds when provider health check passes", async () => {
    mockHealthCheck.mockResolvedValueOnce({ ok: true })
    const startChat = vi.fn(async () => {})
    const deps = {
      socketPath: "/tmp/ouro-test.sock",
      sendCommand: vi.fn(async () => ({ ok: true, message: "unexpected" })),
      startDaemonProcess: vi.fn(async () => ({ pid: 42 })),
      writeStdout: vi.fn(),
      checkSocketAlive: vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true),
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
  })

  it("bare ouro with single agent bails when provider health check fails", async () => {
    mockHealthCheck.mockResolvedValueOnce({
      ok: false,
      error: "provider unreachable",
      fix: "check your network",
    })
    const startChat = vi.fn(async () => {})
    const deps = {
      socketPath: "/tmp/ouro-test.sock",
      sendCommand: vi.fn(async () => ({ ok: true, message: "unexpected" })),
      startDaemonProcess: vi.fn(async () => ({ pid: 42 })),
      writeStdout: vi.fn(),
      checkSocketAlive: vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true),
      cleanupStaleSocket: vi.fn(),
      fallbackPendingMessage: vi.fn(() => "/tmp/pending.jsonl"),
      listDiscoveredAgents: vi.fn(async () => ["slugger"]),
      startChat,
    } as OuroCliDeps & {
      listDiscoveredAgents: () => Promise<string[]>
      startChat: typeof startChat
    }

    const result = await runOuroCli([], deps)

    expect(startChat).not.toHaveBeenCalled()
    expect(result).toContain("provider unreachable")
  })

  it("bare ouro with multi-agent selection bails when provider health check fails", async () => {
    mockHealthCheck.mockResolvedValueOnce({
      ok: false,
      error: "copilot token expired",
      fix: "run ouro auth --provider github-copilot",
    })
    const startChat = vi.fn(async () => {})
    const deps = {
      socketPath: "/tmp/ouro-test.sock",
      sendCommand: vi.fn(async () => ({ ok: true, message: "unexpected" })),
      startDaemonProcess: vi.fn(async () => ({ pid: 42 })),
      writeStdout: vi.fn(),
      checkSocketAlive: vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true),
      cleanupStaleSocket: vi.fn(),
      fallbackPendingMessage: vi.fn(() => "/tmp/pending.jsonl"),
      listDiscoveredAgents: vi.fn(async () => ["slugger", "ouroboros"]),
      promptInput: vi.fn(async () => "slugger"),
      startChat,
    } as OuroCliDeps & {
      listDiscoveredAgents: () => Promise<string[]>
      promptInput: (prompt: string) => Promise<string>
      startChat: typeof startChat
    }

    const result = await runOuroCli([], deps)

    expect(startChat).not.toHaveBeenCalled()
    expect(result).toContain("copilot token expired")
    expect(deps.writeStdout).toHaveBeenCalledWith(
      expect.stringContaining("run ouro auth --provider github-copilot"),
    )
  })

  it("health check failure includes fix hint when provided", async () => {
    mockHealthCheck.mockResolvedValueOnce({
      ok: false,
      error: "bad credentials",
    })
    const startChat = vi.fn(async () => {})
    const deps = {
      socketPath: "/tmp/ouro-test.sock",
      sendCommand: vi.fn(async () => ({ ok: true, message: "unexpected" })),
      startDaemonProcess: vi.fn(async () => ({ pid: 42 })),
      writeStdout: vi.fn(),
      checkSocketAlive: vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true),
      cleanupStaleSocket: vi.fn(),
      fallbackPendingMessage: vi.fn(() => "/tmp/pending.jsonl"),
      listDiscoveredAgents: vi.fn(async () => ["slugger"]),
      startChat,
    } as OuroCliDeps & {
      listDiscoveredAgents: () => Promise<string[]>
      startChat: typeof startChat
    }

    const result = await runOuroCli(["chat", "slugger"], deps)

    expect(startChat).not.toHaveBeenCalled()
    expect(result).toContain("bad credentials")
    // No fix hint in the output since none was provided
    expect(deps.writeStdout).toHaveBeenCalledWith(
      expect.stringContaining("bad credentials"),
    )
  })
})

describe("ouro up per-agent progress threading", () => {
  const mockHealthCheck = checkAgentConfigWithProviderHealth as ReturnType<typeof vi.fn>

  it("uses daemon provider readiness during ouro up provider checks without rereading the vault", async () => {
    mockHealthCheck.mockClear()
    let nowMs = Date.parse("2026-04-10T05:02:36.000Z")
    const deps = {
      socketPath: "/tmp/ouro-test.sock",
      sendCommand: sendCommandWithRunningStatus(runningDaemonStatusWithProviders([
        {
          agent: "slugger",
          lane: "outward",
          provider: "openai-codex",
          model: "gpt-5.5",
          source: "local",
          readiness: "ready",
          credential: "checked previously",
        },
        {
          agent: "slugger",
          lane: "inner",
          provider: "openai-codex",
          model: "gpt-5.5",
          source: "local",
          readiness: "ready",
          credential: "checked previously",
        },
      ])),
      startDaemonProcess: vi.fn(async () => ({ pid: 5683 })),
      writeStdout: vi.fn(),
      checkSocketAlive: vi.fn().mockResolvedValue(true),
      cleanupStaleSocket: vi.fn(),
      fallbackPendingMessage: vi.fn(() => "/tmp/pending.jsonl"),
      listDiscoveredAgents: () => ["slugger"],
      healthFilePath: "/tmp/ouro-health.json",
      readHealthState: vi.fn(() => ({
        status: "ok",
        mode: "normal",
        pid: 5683,
        startedAt: new Date(nowMs).toISOString(),
        uptimeSeconds: 0,
        safeMode: null,
        degraded: [],
        agents: {},
        habits: {},
      })),
      readHealthUpdatedAt: vi.fn(() => nowMs),
      readRecentDaemonLogLines: vi.fn(() => []),
      sleep: vi.fn(async (ms: number) => { nowMs += ms }),
      now: () => nowMs,
    } satisfies OuroCliDeps

    await runOuroCli(["up"], deps)

    expect(mockHealthCheck).not.toHaveBeenCalled()
  })

  it("uses daemon provider readiness to report degraded providers without starting a foreground vault read", async () => {
    mockHealthCheck.mockClear()
    let nowMs = Date.parse("2026-04-10T05:02:36.000Z")
    const writeStdout = vi.fn()
    const deps = {
      socketPath: "/tmp/ouro-test.sock",
      sendCommand: sendCommandWithRunningStatus(runningDaemonStatusWithProviders([
        {
          agent: "slugger",
          lane: "outward",
          provider: "openai-codex",
          model: "gpt-5.5",
          source: "local",
          readiness: "failed",
          credential: "checked previously",
          detail: "bad token",
        },
        {
          agent: "slugger",
          lane: "inner",
          provider: "openai-codex",
          model: "gpt-5.5",
          source: "local",
          readiness: "failed",
          credential: "checked previously",
        },
      ])),
      startDaemonProcess: vi.fn(async () => ({ pid: 5683 })),
      writeStdout,
      checkSocketAlive: vi.fn().mockResolvedValue(true),
      cleanupStaleSocket: vi.fn(),
      fallbackPendingMessage: vi.fn(() => "/tmp/pending.jsonl"),
      listDiscoveredAgents: () => ["slugger"],
      healthFilePath: "/tmp/ouro-health.json",
      readHealthState: vi.fn(() => ({
        status: "ok",
        mode: "normal",
        pid: 5683,
        startedAt: new Date(nowMs).toISOString(),
        uptimeSeconds: 0,
        safeMode: null,
        degraded: [],
        agents: {},
        habits: {},
      })),
      readHealthUpdatedAt: vi.fn(() => nowMs),
      readRecentDaemonLogLines: vi.fn(() => []),
      sleep: vi.fn(async (ms: number) => { nowMs += ms }),
      now: () => nowMs,
    } satisfies OuroCliDeps

    await runOuroCli(["up"], deps)

    expect(mockHealthCheck).not.toHaveBeenCalled()
    expect(writeStdout).toHaveBeenCalledWith(expect.stringContaining("outward provider openai-codex / gpt-5.5 readiness is failed: bad token"))
  })

  it("renders daemon status provider failures that do not include details", async () => {
    mockHealthCheck.mockClear()
    let nowMs = Date.parse("2026-04-10T05:02:36.000Z")
    const writeStdout = vi.fn()
    const deps = {
      socketPath: "/tmp/ouro-test.sock",
      sendCommand: sendCommandWithRunningStatus(runningDaemonStatusWithProviders([
        {
          agent: "slugger",
          lane: "outward",
          provider: "openai-codex",
          model: "gpt-5.5",
          source: "local",
          readiness: "failed",
          credential: "checked previously",
        },
        {
          agent: "slugger",
          lane: "inner",
          provider: "openai-codex",
          model: "gpt-5.5",
          source: "local",
          readiness: "ready",
          credential: "checked previously",
        },
      ])),
      startDaemonProcess: vi.fn(async () => ({ pid: 5683 })),
      writeStdout,
      checkSocketAlive: vi.fn().mockResolvedValue(true),
      cleanupStaleSocket: vi.fn(),
      fallbackPendingMessage: vi.fn(() => "/tmp/pending.jsonl"),
      listDiscoveredAgents: () => ["slugger"],
      healthFilePath: "/tmp/ouro-health.json",
      readHealthState: vi.fn(() => ({
        status: "ok",
        mode: "normal",
        pid: 5683,
        startedAt: new Date(nowMs).toISOString(),
        uptimeSeconds: 0,
        safeMode: null,
        degraded: [],
        agents: {},
        habits: {},
      })),
      readHealthUpdatedAt: vi.fn(() => nowMs),
      readRecentDaemonLogLines: vi.fn(() => []),
      sleep: vi.fn(async (ms: number) => { nowMs += ms }),
      now: () => nowMs,
    } satisfies OuroCliDeps

    await runOuroCli(["up"], deps)

    expect(mockHealthCheck).not.toHaveBeenCalled()
    expect(writeStdout).toHaveBeenCalledWith(expect.stringContaining("outward provider openai-codex / gpt-5.5 readiness is failed"))
    expect(writeStdout).toHaveBeenCalledWith(expect.stringContaining("Run `ouro status` or `ouro doctor` for provider details."))
  })

  it("renders daemon status repair commands for unconfigured provider rows", async () => {
    mockHealthCheck.mockClear()
    let nowMs = Date.parse("2026-04-10T05:02:36.000Z")
    const writeStdout = vi.fn()
    const deps = {
      socketPath: "/tmp/ouro-test.sock",
      sendCommand: sendCommandWithRunningStatus(runningDaemonStatusWithProviders([
        {
          agent: "slugger",
          lane: "outward",
          provider: "unconfigured",
          model: "-",
          source: "missing",
          readiness: "unknown",
          credential: "missing",
          detail: "ouro use --agent slugger --lane outward --provider openai-codex --model gpt-5.5",
        },
        {
          agent: "slugger",
          lane: "inner",
          provider: "openai-codex",
          model: "gpt-5.5",
          source: "local",
          readiness: "ready",
          credential: "checked previously",
        },
      ])),
      startDaemonProcess: vi.fn(async () => ({ pid: 5683 })),
      writeStdout,
      checkSocketAlive: vi.fn().mockResolvedValue(true),
      cleanupStaleSocket: vi.fn(),
      fallbackPendingMessage: vi.fn(() => "/tmp/pending.jsonl"),
      listDiscoveredAgents: () => ["slugger"],
      healthFilePath: "/tmp/ouro-health.json",
      readHealthState: vi.fn(() => ({
        status: "ok",
        mode: "normal",
        pid: 5683,
        startedAt: new Date(nowMs).toISOString(),
        uptimeSeconds: 0,
        safeMode: null,
        degraded: [],
        agents: {},
        habits: {},
      })),
      readHealthUpdatedAt: vi.fn(() => nowMs),
      readRecentDaemonLogLines: vi.fn(() => []),
      sleep: vi.fn(async (ms: number) => { nowMs += ms }),
      now: () => nowMs,
    } satisfies OuroCliDeps

    await runOuroCli(["up"], deps)

    expect(mockHealthCheck).not.toHaveBeenCalled()
    expect(writeStdout).toHaveBeenCalledWith(expect.stringContaining("Run `ouro use --agent slugger --lane outward --provider openai-codex --model gpt-5.5`."))
  })

  it("falls back to foreground provider checks when daemon status cannot be read", async () => {
    mockHealthCheck.mockClear()
    mockHealthCheck.mockResolvedValueOnce({ ok: true })
    let nowMs = Date.parse("2026-04-10T05:02:36.000Z")
    let statusCalls = 0
    const sendCommand = vi.fn(async (_socketPath, command) => {
      if (command.kind === "daemon.status") {
        statusCalls += 1
        if (statusCalls === 1) {
          throw new Error("status socket interrupted")
        }
        return runningDaemonStatusResponse()
      }
      return { ok: true, summary: "ok" }
    })
    const deps = {
      socketPath: "/tmp/ouro-test.sock",
      sendCommand,
      startDaemonProcess: vi.fn(async () => ({ pid: 5683 })),
      writeStdout: vi.fn(),
      checkSocketAlive: vi.fn().mockResolvedValue(true),
      cleanupStaleSocket: vi.fn(),
      fallbackPendingMessage: vi.fn(() => "/tmp/pending.jsonl"),
      listDiscoveredAgents: () => ["slugger"],
      healthFilePath: "/tmp/ouro-health.json",
      readHealthState: vi.fn(() => ({
        status: "ok",
        mode: "normal",
        pid: 5683,
        startedAt: new Date(nowMs).toISOString(),
        uptimeSeconds: 0,
        safeMode: null,
        degraded: [],
        agents: {},
        habits: {},
      })),
      readHealthUpdatedAt: vi.fn(() => nowMs),
      readRecentDaemonLogLines: vi.fn(() => []),
      sleep: vi.fn(async (ms: number) => { nowMs += ms }),
      now: () => nowMs,
    } satisfies OuroCliDeps

    await runOuroCli(["up"], deps)

    expect(mockHealthCheck).toHaveBeenCalled()
  })

  it("passes onProgress callback to checkAgentConfigWithProviderHealth during ouro up provider checks", async () => {
    mockHealthCheck.mockResolvedValue({ ok: true })
    let nowMs = Date.parse("2026-04-10T05:02:36.000Z")
    const deps = {
      socketPath: "/tmp/ouro-test.sock",
      sendCommand: vi.fn(),
      startDaemonProcess: vi.fn(async () => ({ pid: 5683 })),
      writeStdout: vi.fn(),
      checkSocketAlive: vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true),
      cleanupStaleSocket: vi.fn(),
      fallbackPendingMessage: vi.fn(() => "/tmp/pending.jsonl"),
      listDiscoveredAgents: () => ["slugger"],
      healthFilePath: "/tmp/ouro-health.json",
      readHealthState: vi.fn(() => ({
        status: "ok",
        mode: "normal",
        pid: 5683,
        startedAt: new Date(nowMs).toISOString(),
        uptimeSeconds: 0,
        safeMode: null,
        degraded: [],
        agents: {},
        habits: {},
      })),
      readHealthUpdatedAt: vi.fn(() => nowMs),
      readRecentDaemonLogLines: vi.fn(() => []),
      sleep: vi.fn(async (ms: number) => { nowMs += ms }),
      now: () => nowMs,
      startupPollIntervalMs: 5,
      startupStabilityWindowMs: 15,
      startupTimeoutMs: 60,
    } satisfies OuroCliDeps

    await runOuroCli(["up"], deps)

    // checkAgentConfigWithProviderHealth should have been called for slugger
    // with deps that include onProgress callback
    expect(mockHealthCheck).toHaveBeenCalled()
    const healthCheckCalls = mockHealthCheck.mock.calls
    const callWithOnProgress = healthCheckCalls.find(
      (call: unknown[]) => call[2] && typeof (call[2] as Record<string, unknown>).onProgress === "function",
    )
    expect(callWithOnProgress).toBeDefined()
  })
})

describe("ouro up post-repair progress phase", () => {
  const mockHealthCheck = checkAgentConfigWithProviderHealth as ReturnType<typeof vi.fn>

  it("threads onProgress to checkAgentProviders during post-repair re-check", async () => {
    // First call (post-daemon provider checks): return degraded with vault-locked
    // error so interactive repair is triggered. Second call (post-repair re-check):
    // return ok.
    mockHealthCheck
      .mockResolvedValueOnce({
        ok: false,
        error: "credential vault is locked",
        fix: "Run 'ouro vault unlock --agent slugger'",
      })
      .mockResolvedValue({ ok: true })

    // Mock agentic repair to simulate successful repair
    mockAgenticRepair.runAgenticRepair.mockResolvedValueOnce({
      repairsAttempted: true,
      usedAgentic: false,
    })

    const nowMs = Date.parse("2026-04-10T05:02:36.000Z")
    const deps = {
      socketPath: "/tmp/ouro-test.sock",
      sendCommand: vi.fn(),
      startDaemonProcess: vi.fn(async () => ({ pid: 5683 })),
      writeStdout: vi.fn(),
      // Daemon already alive: skip preflight, go straight to post-daemon checks
      checkSocketAlive: vi.fn().mockResolvedValue(true),
      cleanupStaleSocket: vi.fn(),
      fallbackPendingMessage: vi.fn(() => "/tmp/pending.jsonl"),
      listDiscoveredAgents: () => ["slugger"],
      healthFilePath: "/tmp/ouro-health.json",
      readHealthState: vi.fn(() => ({
        status: "ok",
        mode: "normal",
        pid: 5683,
        startedAt: new Date(nowMs).toISOString(),
        uptimeSeconds: 0,
        safeMode: null,
        degraded: [],
        agents: {},
        habits: {},
      })),
      readHealthUpdatedAt: vi.fn(() => nowMs),
      readRecentDaemonLogLines: vi.fn(() => []),
      sleep: vi.fn(async () => {}),
      now: () => nowMs,
    } satisfies OuroCliDeps

    await runOuroCli(["up"], deps)

    // checkAgentConfigWithProviderHealth should be called at least twice:
    // once during post-daemon provider checks, once during post-repair re-check
    expect(mockHealthCheck.mock.calls.length).toBeGreaterThanOrEqual(2)

    // The post-repair re-check call should have onProgress in deps
    const postRepairCalls = mockHealthCheck.mock.calls.slice(1)
    const postRepairCallWithOnProgress = postRepairCalls.find(
      (call: unknown[]) => call[2] && typeof (call[2] as Record<string, unknown>).onProgress === "function",
    )
    expect(postRepairCallWithOnProgress).toBeDefined()
  })

  it("wraps post-repair re-check in a progress phase (non-TTY output)", async () => {
    // First call: return degraded. Post-repair: return ok.
    mockHealthCheck
      .mockResolvedValueOnce({
        ok: false,
        error: "credential vault is locked",
        fix: "Run 'ouro vault unlock --agent slugger'",
      })
      .mockResolvedValue({ ok: true })

    mockAgenticRepair.runAgenticRepair.mockResolvedValueOnce({
      repairsAttempted: true,
      usedAgentic: false,
    })

    const nowMs = Date.parse("2026-04-10T05:02:36.000Z")
    const writeStdout = vi.fn()
    const deps = {
      socketPath: "/tmp/ouro-test.sock",
      sendCommand: sendCommandWithRunningStatus(),
      startDaemonProcess: vi.fn(async () => ({ pid: 5683 })),
      writeStdout,
      checkSocketAlive: vi.fn().mockResolvedValue(true),
      cleanupStaleSocket: vi.fn(),
      fallbackPendingMessage: vi.fn(() => "/tmp/pending.jsonl"),
      listDiscoveredAgents: () => ["slugger"],
      healthFilePath: "/tmp/ouro-health.json",
      readHealthState: vi.fn(() => ({
        status: "ok",
        mode: "normal",
        pid: 5683,
        startedAt: new Date(nowMs).toISOString(),
        uptimeSeconds: 0,
        safeMode: null,
        degraded: [],
        agents: {},
        habits: {},
      })),
      readHealthUpdatedAt: vi.fn(() => nowMs),
      readRecentDaemonLogLines: vi.fn(() => []),
      sleep: vi.fn(async () => {}),
      now: () => nowMs,
    } satisfies OuroCliDeps

    await runOuroCli(["up"], deps)

    // In non-TTY mode, UpProgress.completePhase writes static lines.
    // The post-repair check should produce a phase completion line.
    const lines = writeStdout.mock.calls.map((call: unknown[]) => String(call[0]))
    const postRepairPhaseLine = lines.find((line) => line.includes("post-repair check"))
    expect(postRepairPhaseLine).toBeDefined()
  })
})
