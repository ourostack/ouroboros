/**
 * `ouro desk` CLI tests.
 *
 * Verifies that each subverb parses argv into the canonical
 * `{ kind: "desk", tool, toolArgs }` shape, with tool names and arguments Desk
 * 3's MCP tools accept, and that the executor routes it through the daemon
 * socket as `mcp.call` with `server: "desk"` (or `desk-<name>` for --desk).
 *
 * Also covers the `ouro task ...` alias surface — must route identically to
 * `ouro desk task ...`.
 */

import { describe, it, expect, vi, beforeEach } from "vitest"

import {
  parseOuroCommand,
  runOuroCli,
  type OuroCliDeps,
} from "../../../heart/daemon/daemon-cli"

function createMockDeps(overrides: Partial<OuroCliDeps> = {}): OuroCliDeps {
  return {
    socketPath: "/tmp/ouro-test.sock",
    sendCommand: vi.fn().mockResolvedValue({
      ok: true,
      data: { content: [{ type: "text", text: "ok" }] },
    }),
    startDaemonProcess: vi.fn().mockResolvedValue({ pid: 12345 }),
    writeStdout: vi.fn(),
    checkSocketAlive: vi.fn().mockResolvedValue(true),
    cleanupStaleSocket: vi.fn(),
    fallbackPendingMessage: vi.fn().mockReturnValue("pending"),
    ...overrides,
  }
}

// ── Parser tests ──

const desk = (tool: string, toolArgs: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  kind: "desk",
  tool,
  toolArgs,
  ...extra,
})

describe("ouro desk CLI parsing — task subverbs", () => {
  it("'desk task list' lists tasks through desk_search with no query", () => {
    expect(parseOuroCommand(["desk", "task", "list"])).toEqual(desk("desk_search", { filters: { kind: "task" } }))
  })

  it("'desk task list --track foo --status open' adds filters", () => {
    expect(parseOuroCommand(["desk", "task", "list", "--track", "foo", "--status", "open"])).toEqual(
      desk("desk_search", { filters: { kind: "task", track: "foo", status: "open" } }),
    )
  })

  it("'desk task list' refuses extra words", () => {
    expect(() => parseOuroCommand(["desk", "task", "list", "foo"])).toThrow(/takes no words/)
  })

  it("'desk task new <track>/<slug>' parses to task_create with the slug as title", () => {
    expect(parseOuroCommand(["desk", "task", "new", "harness/fix-bug"])).toEqual(
      desk("task_create", { track: "harness", slug: "fix-bug", title: "fix-bug" }),
    )
  })

  it("'desk task new <slug> --track <t> --title <title>' parses to task_create", () => {
    expect(parseOuroCommand(["desk", "task", "new", "fix-bug", "--track", "harness", "--title", "Fix the bug"])).toEqual(
      desk("task_create", { track: "harness", slug: "fix-bug", title: "Fix the bug" }),
    )
  })

  it("'desk task new <track>/<slug> --track <t>' refuses the track twice", () => {
    expect(() => parseOuroCommand(["desk", "task", "new", "harness/fix-bug", "--track", "harness"])).toThrow(/track once/)
  })

  it("'desk task new <slug>' without a track throws", () => {
    expect(() => parseOuroCommand(["desk", "task", "new", "fix-bug"])).toThrow(/usage/i)
  })

  it("'desk task new' without slug throws", () => {
    expect(() => parseOuroCommand(["desk", "task", "new"])).toThrow(/<track>\/<slug>/)
  })

  it("'desk task new a/b/c' throws: the slug can't hold a slash", () => {
    expect(() => parseOuroCommand(["desk", "task", "new", "a/b/c", "--track", "a"])).toThrow(/usage/i)
  })

  it("'desk task done <track>/<slug> --pr <url>' moves the task to done with PR evidence", () => {
    expect(parseOuroCommand(["desk", "task", "done", "harness/fix-bug", "--pr", "https://github.com/o/r/pull/1"])).toEqual(
      desk("task_update", {
        track: "harness",
        slug: "fix-bug",
        status: "done",
        evidence: { kind: "pr", ref: "https://github.com/o/r/pull/1" },
      }),
    )
  })

  it("'desk task done <track>/<slug> --commit <sha>' uses commit evidence", () => {
    expect(parseOuroCommand(["desk", "task", "done", "harness/fix-bug", "--commit", "abc1234"])).toEqual(
      desk("task_update", { track: "harness", slug: "fix-bug", status: "done", evidence: { kind: "commit", ref: "abc1234" } }),
    )
  })

  it("'desk task done' without evidence says to pass --pr or --commit", () => {
    expect(() => parseOuroCommand(["desk", "task", "done", "harness/fix-bug"])).toThrow(/--pr <url>.*--commit <sha>/)
  })

  it("'desk task done' with both --pr and --commit throws", () => {
    expect(() =>
      parseOuroCommand(["desk", "task", "done", "harness/fix-bug", "--pr", "https://x/pull/1", "--commit", "abc1234"]),
    ).toThrow(/one of them/)
  })

  it("'desk task done' without a task throws", () => {
    expect(() => parseOuroCommand(["desk", "task", "done", "--pr", "https://x/pull/1"])).toThrow(/<track>\/<slug>/)
  })

  it("'desk task done <slug>' without its track throws", () => {
    expect(() => parseOuroCommand(["desk", "task", "done", "fix-bug", "--commit", "abc1234"])).toThrow(/<track>\/<slug>/)
  })

  it("'desk task done' refuses a flag value that is another flag", () => {
    expect(() => parseOuroCommand(["desk", "task", "done", "harness/fix-bug", "--pr", "--commit"])).toThrow(/--pr needs a value/)
  })

  it("'desk task done' refuses a flag it doesn't take", () => {
    expect(() => parseOuroCommand(["desk", "task", "done", "harness/fix-bug", "--steps"])).toThrow(/doesn't take --steps/)
  })

  it("'desk task archive <track>/<slug>' parses to task_archive", () => {
    expect(parseOuroCommand(["desk", "task", "archive", "harness/fix-bug"])).toEqual(
      desk("task_archive", { track: "harness", slug: "fix-bug" }),
    )
  })

  it("'desk task archive <track>/<slug> --cancelled' archives it as cancelled", () => {
    expect(parseOuroCommand(["desk", "task", "archive", "harness/fix-bug", "--cancelled"])).toEqual(
      desk("task_archive", { track: "harness", slug: "fix-bug", outcome: "cancelled" }),
    )
  })

  it("'desk task archive' without a task throws", () => {
    expect(() => parseOuroCommand(["desk", "task", "archive"])).toThrow(/usage/i)
  })

  it("'desk task show <track>/<slug>' searches for the slug in its track", () => {
    expect(parseOuroCommand(["desk", "task", "show", "harness/fix-bug"])).toEqual(
      desk("desk_search", { query: "fix-bug", filters: { kind: "task", track: "harness" } }),
    )
  })

  it("'desk task show' without a task throws", () => {
    expect(() => parseOuroCommand(["desk", "task", "show"])).toThrow(/usage/i)
  })

  it("'desk task' with unknown subverb throws", () => {
    expect(() => parseOuroCommand(["desk", "task", "frobnicate"])).toThrow(/usage/i)
  })

  it("'desk task' with no subverb throws", () => {
    expect(() => parseOuroCommand(["desk", "task"])).toThrow(/usage/i)
  })
})

describe("ouro desk CLI parsing — track subverbs", () => {
  it("'desk track list' is gone, since Desk 3 does not index tracks", () => {
    expect(() => parseOuroCommand(["desk", "track", "list"])).toThrow(/usage/i)
  })

  it("'desk track new <slug> --title <t> --scope <s>' parses to track_create", () => {
    expect(
      parseOuroCommand(["desk", "track", "new", "harness", "--title", "Harness", "--scope", "the runtime; not the site"]),
    ).toEqual(desk("track_create", { slug: "harness", title: "Harness", scope: "the runtime; not the site" }))
  })

  it("'desk track new <slug>' without --title and --scope throws", () => {
    expect(() => parseOuroCommand(["desk", "track", "new", "harness"])).toThrow(/--scope/)
    expect(() => parseOuroCommand(["desk", "track", "new", "harness", "--title", "Harness"])).toThrow(/usage/i)
  })

  it("'desk track new' without slug throws", () => {
    expect(() => parseOuroCommand(["desk", "track", "new", "--title", "H", "--scope", "s"])).toThrow(/usage/i)
  })

  it("'desk track show <slug>' lists the track's tasks through desk_search", () => {
    expect(parseOuroCommand(["desk", "track", "show", "harness"])).toEqual(
      desk("desk_search", { filters: { kind: "task", track: "harness" } }),
    )
  })

  it("'desk track show' without slug throws", () => {
    expect(() => parseOuroCommand(["desk", "track", "show"])).toThrow(/usage/i)
  })

  it("'desk track' with unknown subverb throws", () => {
    expect(() => parseOuroCommand(["desk", "track", "frobnicate"])).toThrow(/usage/i)
  })

  it("'desk track' with no subverb throws", () => {
    expect(() => parseOuroCommand(["desk", "track"])).toThrow(/usage/i)
  })
})

describe("ouro desk CLI parsing — friction / lesson", () => {
  it("'desk friction add <text>' parses to friction_add with the text as body", () => {
    expect(parseOuroCommand(["desk", "friction", "add", "build is slow"])).toEqual(
      desk("friction_add", { body: "build is slow" }),
    )
  })

  it("'desk friction add' joins remaining args with spaces", () => {
    expect(parseOuroCommand(["desk", "friction", "add", "build", "is", "slow"])).toEqual(
      desk("friction_add", { body: "build is slow" }),
    )
  })

  it("'desk friction add' without text throws", () => {
    expect(() => parseOuroCommand(["desk", "friction", "add"])).toThrow(/note's text/)
  })

  it("'desk friction' with unknown subverb throws", () => {
    expect(() => parseOuroCommand(["desk", "friction", "list"])).toThrow(/usage/i)
  })

  it("'desk friction' with no subverb throws", () => {
    expect(() => parseOuroCommand(["desk", "friction"])).toThrow(/usage/i)
  })

  it("'desk lesson add <text> --scope <s> --topic <t>' parses to lesson_add", () => {
    expect(
      parseOuroCommand(["desk", "lesson", "add", "always", "quote", "paths", "--scope", "personal", "--topic", "quoting"]),
    ).toEqual(desk("lesson_add", { scope: "personal", topic: "quoting", body: "always quote paths" }))
  })

  it("'desk lesson add <text>' without --scope and --topic throws", () => {
    expect(() => parseOuroCommand(["desk", "lesson", "add", "always quote paths"])).toThrow(/--scope.*--topic/)
    expect(() => parseOuroCommand(["desk", "lesson", "add", "x", "--scope", "personal"])).toThrow(/usage/i)
  })

  it("'desk lesson add' without text throws", () => {
    expect(() => parseOuroCommand(["desk", "lesson", "add", "--scope", "personal", "--topic", "t"])).toThrow(/lesson's text/)
  })

  it("'desk lesson' with unknown subverb throws", () => {
    expect(() => parseOuroCommand(["desk", "lesson", "rm"])).toThrow(/usage/i)
  })

  it("'desk lesson' with no subverb throws", () => {
    expect(() => parseOuroCommand(["desk", "lesson"])).toThrow(/usage/i)
  })
})

describe("ouro desk CLI parsing — search / recall / status / doctor / reindex", () => {
  it("'desk search <query>' parses to desk_search with query", () => {
    expect(parseOuroCommand(["desk", "search", "build errors"])).toEqual(desk("desk_search", { query: "build errors" }))
  })

  it("'desk search' joins multiple words", () => {
    expect(parseOuroCommand(["desk", "search", "build", "errors"])).toEqual(desk("desk_search", { query: "build errors" }))
  })

  it("'desk search' without query throws", () => {
    expect(() => parseOuroCommand(["desk", "search"])).toThrow(/usage/i)
  })

  it("'desk recall <topic>' parses to desk_recall with topic", () => {
    expect(parseOuroCommand(["desk", "recall", "europe trip"])).toEqual(desk("desk_recall", { topic: "europe trip" }))
  })

  it("'desk recall' without topic throws", () => {
    expect(() => parseOuroCommand(["desk", "recall"])).toThrow(/needs a topic/)
  })

  it("'desk status' parses to desk_status", () => {
    expect(parseOuroCommand(["desk", "status"])).toEqual(desk("desk_status", {}))
  })

  it("'desk doctor' parses to desk_doctor", () => {
    expect(parseOuroCommand(["desk", "doctor"])).toEqual(desk("desk_doctor", {}))
  })

  it("'desk reindex' parses to desk_doctor with reindex", () => {
    expect(parseOuroCommand(["desk", "reindex"])).toEqual(desk("desk_doctor", { reindex: true }))
  })

  it("'desk status|doctor|reindex' refuse extra words", () => {
    for (const verb of ["status", "doctor", "reindex"]) {
      expect(() => parseOuroCommand(["desk", verb, "now"])).toThrow(/takes no words/)
    }
  })

  it("'desk thread' is gone: Desk has no such tool", () => {
    expect(() => parseOuroCommand(["desk", "thread", "harness/fix-bug/task.md"])).toThrow(/usage/i)
  })

  it("'desk' with unknown subverb throws", () => {
    expect(() => parseOuroCommand(["desk", "frobnicate"])).toThrow(/usage/i)
  })

  it("'desk' bare throws", () => {
    expect(() => parseOuroCommand(["desk"])).toThrow(/usage/i)
  })
})

describe("ouro desk CLI parsing — --desk and --agent", () => {
  it("--desk <name> picks the desk, wherever it sits", () => {
    expect(parseOuroCommand(["desk", "--desk", "work", "status"])).toEqual(desk("desk_status", {}, { desk: "work" }))
    expect(parseOuroCommand(["desk", "task", "list", "--desk", "work"])).toEqual(
      desk("desk_search", { filters: { kind: "task" } }, { desk: "work" }),
    )
  })

  it("--agent <name> names the agent", () => {
    expect(parseOuroCommand(["desk", "search", "x", "--agent", "slugger"])).toEqual(
      desk("desk_search", { query: "x" }, { agent: "slugger" }),
    )
  })

  it("--desk refuses a name that isn't a desk name", () => {
    expect(() => parseOuroCommand(["desk", "status", "--desk", "Work!"])).toThrow(/is not a desk name/)
    expect(() => parseOuroCommand(["desk", "status", "--desk", "-work"])).toThrow(/is not a desk name/)
  })

  it("--desk without a value throws", () => {
    expect(() => parseOuroCommand(["desk", "status", "--desk"])).toThrow(/--desk needs a value/)
  })

  it("the Hosted Desk admin verbs don't take --desk", () => {
    expect(() => parseOuroCommand(["desk", "access", "acct", "on", "--desk", "work"])).toThrow()
    expect(() => parseOuroCommand(["desk", "--desk", "work", "access", "acct", "on"])).toThrow(/usage/i)
  })

  it("'task' alias takes --desk too", () => {
    expect(parseOuroCommand(["task", "show", "harness/fix-bug", "--desk", "work"])).toEqual(
      desk("desk_search", { query: "fix-bug", filters: { kind: "task", track: "harness" } }, { desk: "work" }),
    )
  })
})

// ── Task alias router ──

describe("ouro task alias — must route through desk_*", () => {
  it("'task list' routes through desk_search with kind=task", () => {
    expect(parseOuroCommand(["task", "list"])).toEqual(desk("desk_search", { filters: { kind: "task" } }))
  })

  it("'task new <slug> --track <t>' routes through task_create", () => {
    expect(parseOuroCommand(["task", "new", "fix-bug", "--track", "harness"])).toEqual(
      desk("task_create", { track: "harness", slug: "fix-bug", title: "fix-bug" }),
    )
  })

  it("'task done <track>/<slug> --pr <url>' routes through task_update", () => {
    expect(parseOuroCommand(["task", "done", "harness/fix-bug", "--pr", "https://x/pull/1"])).toEqual(
      desk("task_update", { track: "harness", slug: "fix-bug", status: "done", evidence: { kind: "pr", ref: "https://x/pull/1" } }),
    )
  })

  it("'task archive <track>/<slug>' routes through task_archive", () => {
    expect(parseOuroCommand(["task", "archive", "harness/fix-bug"])).toEqual(
      desk("task_archive", { track: "harness", slug: "fix-bug" }),
    )
  })

  it("'task show <track>/<slug>' routes through desk_search", () => {
    expect(parseOuroCommand(["task", "show", "harness/fix-bug"])).toEqual(
      desk("desk_search", { query: "fix-bug", filters: { kind: "task", track: "harness" } }),
    )
  })

  it("'task' with no subverb throws", () => {
    expect(() => parseOuroCommand(["task"])).toThrow(/usage/i)
  })

  it("'task frobnicate' throws", () => {
    expect(() => parseOuroCommand(["task", "frobnicate"])).toThrow(/usage/i)
  })
})

// ── Execution tests (daemon-routed) ──

describe("ouro desk CLI execution (daemon-routed)", () => {
  let sendCommand: ReturnType<typeof vi.fn>

  beforeEach(() => {
    sendCommand = vi.fn()
  })

  it("'desk task list' calls daemon as mcp.call(desk, desk_search, ...)", async () => {
    sendCommand.mockResolvedValue({
      ok: true,
      data: { content: [{ type: "text", text: "task list result" }] },
    })
    const deps = createMockDeps({ sendCommand })

    const result = await runOuroCli(["desk", "task", "list"], deps)

    expect(sendCommand).toHaveBeenCalledWith("/tmp/ouro-test.sock", {
      kind: "mcp.call",
      server: "desk",
      tool: "desk_search",
      args: JSON.stringify({ filters: { kind: "task" } }),
    })
    expect(result).toContain("task list result")
  })

  it("'desk friction add' sends friction_add through daemon", async () => {
    sendCommand.mockResolvedValue({
      ok: true,
      data: { content: [{ type: "text", text: "friction logged" }] },
    })
    const deps = createMockDeps({ sendCommand })

    await runOuroCli(["desk", "friction", "add", "build is slow"], deps)

    expect(sendCommand).toHaveBeenCalledWith("/tmp/ouro-test.sock", {
      kind: "mcp.call",
      server: "desk",
      tool: "friction_add",
      args: JSON.stringify({ body: "build is slow" }),
    })
  })

  it("'desk search' sends desk_search through daemon", async () => {
    sendCommand.mockResolvedValue({
      ok: true,
      data: { content: [{ type: "text", text: "hits" }] },
    })
    const deps = createMockDeps({ sendCommand })

    await runOuroCli(["desk", "search", "build errors"], deps)

    expect(sendCommand).toHaveBeenCalledWith("/tmp/ouro-test.sock", {
      kind: "mcp.call",
      server: "desk",
      tool: "desk_search",
      args: JSON.stringify({ query: "build errors" }),
    })
  })

  it("'task list' alias routes through the same desk_search call", async () => {
    sendCommand.mockResolvedValue({
      ok: true,
      data: { content: [{ type: "text", text: "list result" }] },
    })
    const deps = createMockDeps({ sendCommand })

    await runOuroCli(["task", "list"], deps)

    expect(sendCommand).toHaveBeenCalledWith("/tmp/ouro-test.sock", {
      kind: "mcp.call",
      server: "desk",
      tool: "desk_search",
      args: JSON.stringify({ filters: { kind: "task" } }),
    })
  })

  it("'desk' surfaces daemon-unavailable cleanly when socket throws", async () => {
    sendCommand.mockRejectedValue(new Error("ECONNREFUSED"))
    const deps = createMockDeps({ sendCommand })

    // A failure, exit 1, with the code the desk cards name.
    await expect(runOuroCli(["desk", "task", "list"], deps)).rejects.toMatchObject({
      code: "daemon-down",
      message: expect.stringContaining("daemon unavailable"),
    })
  })

  it("'desk' surfaces daemon-returned error", async () => {
    sendCommand.mockResolvedValue({
      ok: false,
      error: "no MCP servers configured",
    })
    const deps = createMockDeps({ sendCommand })

    const result = await runOuroCli(["desk", "task", "list"], deps)

    expect(result).toContain("no MCP servers configured")
  })

  it("'desk' surfaces fallback message when daemon returns no error string", async () => {
    sendCommand.mockResolvedValue({ ok: false })
    const deps = createMockDeps({ sendCommand })

    const result = await runOuroCli(["desk", "task", "list"], deps)

    expect(result).toContain("unknown error")
  })

  it("'desk' renders empty result content as a fallback message", async () => {
    sendCommand.mockResolvedValue({ ok: true, data: undefined })
    const deps = createMockDeps({ sendCommand })

    const result = await runOuroCli(["desk", "search", "foo"], deps)

    expect(result).toContain("no result")
  })

  it("'desk' joins multi-block content arrays", async () => {
    sendCommand.mockResolvedValue({
      ok: true,
      data: {
        content: [
          { type: "text", text: "line one" },
          { type: "text", text: "line two" },
        ],
      },
    })
    const deps = createMockDeps({ sendCommand })

    const result = await runOuroCli(["desk", "search", "x"], deps)

    expect(result).toContain("line one")
    expect(result).toContain("line two")
  })

  it("'desk' tolerates content blocks missing a text field", async () => {
    sendCommand.mockResolvedValue({
      ok: true,
      data: {
        content: [
          { type: "text", text: "first" },
          // missing text — fallback empty string keeps the join stable
          { type: "text" } as unknown as { type: string; text: string },
        ],
      },
    })
    const deps = createMockDeps({ sendCommand })

    const result = await runOuroCli(["desk", "search", "x"], deps)
    expect(result).toContain("first")
  })

  it("threads --agent through the desk command into the daemon socket", async () => {
    sendCommand.mockResolvedValue({
      ok: true,
      data: { content: [{ type: "text", text: "ok" }] },
    })
    const deps = createMockDeps({ sendCommand })

    // The desk handler accepts an `agent` field on the CliCommand object —
    // wired directly here because the top-level CLI parser does not yet
    // surface --agent for the desk umbrella; agent-propagation lives in the
    // command shape so callers (programmatic + future flag) can opt in.
    const { executeDeskCommand } = await import("../../../heart/daemon/cli-desk")
    await executeDeskCommand(
      { kind: "desk", tool: "desk_search", toolArgs: { query: "x" }, agent: "slugger" },
      deps,
    )

    expect(sendCommand).toHaveBeenCalledWith("/tmp/ouro-test.sock", {
      kind: "mcp.call",
      server: "desk",
      tool: "desk_search",
      args: JSON.stringify({ query: "x" }),
      agent: "slugger",
    })
  })

  it("--desk <name> sends the call to that desk's server, desk-<name>", async () => {
    sendCommand.mockResolvedValue({ ok: true, data: { content: [{ type: "text", text: "ready" }] } })
    const deps = createMockDeps({ sendCommand })

    const result = await runOuroCli(["desk", "status", "--desk", "work"], deps)

    expect(sendCommand).toHaveBeenCalledWith("/tmp/ouro-test.sock", {
      kind: "mcp.call",
      server: "desk-work",
      tool: "desk_status",
      args: JSON.stringify({}),
    })
    expect(result).toContain("ready")
  })

  it("a usage error fails with the usage code", async () => {
    const deps = createMockDeps({ sendCommand })
    await expect(runOuroCli(["desk", "task", "done", "harness/fix-bug"], deps)).rejects.toMatchObject({ code: "usage" })
    expect(sendCommand).not.toHaveBeenCalled()
  })
})

describe("deskUsage()", () => {
  it("exports a human-readable usage string", async () => {
    const { deskUsage } = await import("../../../heart/daemon/cli-desk")
    const usage = deskUsage()
    expect(usage).toContain("ouro desk task list")
    expect(usage).toContain("ouro desk friction add")
    expect(usage).toContain("ouro task list|new|done|archive|show [<ouro desk task arguments>]")
    expect(usage).toContain("--desk <name>")
    expect(usage).not.toContain("thread")
  })
})
