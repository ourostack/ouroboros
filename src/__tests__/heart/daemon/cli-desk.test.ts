/**
 * W6 Unit 10 — `ouro desk` umbrella CLI tests.
 *
 * Verifies that each subverb parses argv into the canonical
 * `{ kind: "desk", tool, toolArgs }` shape and that executor routes it through
 * the daemon socket as `mcp.call` with `server: "desk"`.
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

describe("ouro desk CLI parsing — task subverbs", () => {
  it("'desk task list' parses to desk_search with kind=task", () => {
    expect(parseOuroCommand(["desk", "task", "list"])).toEqual({
      kind: "desk",
      tool: "desk_search",
      toolArgs: { query: "", filters: { kind: "task" } },
    })
  })

  it("'desk task list --track foo --status open' adds filters", () => {
    expect(
      parseOuroCommand(["desk", "task", "list", "--track", "foo", "--status", "open"]),
    ).toEqual({
      kind: "desk",
      tool: "desk_search",
      toolArgs: { query: "", filters: { kind: "task", track: "foo", status: "open" } },
    })
  })

  it("'desk task new <slug> --track <t>' parses to task_create", () => {
    expect(parseOuroCommand(["desk", "task", "new", "fix-bug", "--track", "harness"])).toEqual({
      kind: "desk",
      tool: "task_create",
      toolArgs: { track: "harness", slug: "fix-bug" },
    })
  })

  it("'desk task new <slug>' without --track throws", () => {
    expect(() => parseOuroCommand(["desk", "task", "new", "fix-bug"])).toThrow(/usage/i)
  })

  it("'desk task new' without slug throws", () => {
    expect(() => parseOuroCommand(["desk", "task", "new"])).toThrow(/usage/i)
  })

  it("'desk task done <slug>' parses to task_update with status=done", () => {
    expect(parseOuroCommand(["desk", "task", "done", "harness/fix-bug"])).toEqual({
      kind: "desk",
      tool: "task_update",
      toolArgs: { path: "harness/fix-bug/task.md", frontmatter: { status: "done" } },
    })
  })

  it("'desk task done' without slug throws", () => {
    expect(() => parseOuroCommand(["desk", "task", "done"])).toThrow(/usage/i)
  })

  it("'desk task archive <slug>' parses to task_archive", () => {
    expect(parseOuroCommand(["desk", "task", "archive", "harness/fix-bug"])).toEqual({
      kind: "desk",
      tool: "task_archive",
      toolArgs: { path: "harness/fix-bug/task.md" },
    })
  })

  it("'desk task archive' without slug throws", () => {
    expect(() => parseOuroCommand(["desk", "task", "archive"])).toThrow(/usage/i)
  })

  it("'desk task show <slug>' parses to desk_search query=slug, kind=task", () => {
    expect(parseOuroCommand(["desk", "task", "show", "fix-bug"])).toEqual({
      kind: "desk",
      tool: "desk_search",
      toolArgs: { query: "fix-bug", filters: { kind: "task" } },
    })
  })

  it("'desk task show' without slug throws", () => {
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
  it("'desk track list' parses to desk_search with kind=track", () => {
    expect(parseOuroCommand(["desk", "track", "list"])).toEqual({
      kind: "desk",
      tool: "desk_search",
      toolArgs: { query: "", filters: { kind: "track" } },
    })
  })

  it("'desk track new <slug>' parses to track_create", () => {
    expect(parseOuroCommand(["desk", "track", "new", "harness"])).toEqual({
      kind: "desk",
      tool: "track_create",
      toolArgs: { slug: "harness" },
    })
  })

  it("'desk track new' without slug throws", () => {
    expect(() => parseOuroCommand(["desk", "track", "new"])).toThrow(/usage/i)
  })

  it("'desk track show <slug>' parses to desk_search with slug as query", () => {
    expect(parseOuroCommand(["desk", "track", "show", "harness"])).toEqual({
      kind: "desk",
      tool: "desk_search",
      toolArgs: { query: "harness", filters: { kind: "track" } },
    })
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
  it("'desk friction add <text>' parses to friction_add", () => {
    expect(parseOuroCommand(["desk", "friction", "add", "build is slow"])).toEqual({
      kind: "desk",
      tool: "friction_add",
      toolArgs: { text: "build is slow" },
    })
  })

  it("'desk friction add' joins remaining args with spaces", () => {
    expect(parseOuroCommand(["desk", "friction", "add", "build", "is", "slow"])).toEqual({
      kind: "desk",
      tool: "friction_add",
      toolArgs: { text: "build is slow" },
    })
  })

  it("'desk friction add' without text throws", () => {
    expect(() => parseOuroCommand(["desk", "friction", "add"])).toThrow(/usage/i)
  })

  it("'desk friction' with unknown subverb throws", () => {
    expect(() => parseOuroCommand(["desk", "friction", "list"])).toThrow(/usage/i)
  })

  it("'desk friction' with no subverb throws", () => {
    expect(() => parseOuroCommand(["desk", "friction"])).toThrow(/usage/i)
  })

  it("'desk lesson add <text>' parses to lesson_add", () => {
    expect(parseOuroCommand(["desk", "lesson", "add", "always quote paths"])).toEqual({
      kind: "desk",
      tool: "lesson_add",
      toolArgs: { text: "always quote paths" },
    })
  })

  it("'desk lesson add' without text throws", () => {
    expect(() => parseOuroCommand(["desk", "lesson", "add"])).toThrow(/usage/i)
  })

  it("'desk lesson' with unknown subverb throws", () => {
    expect(() => parseOuroCommand(["desk", "lesson", "rm"])).toThrow(/usage/i)
  })

  it("'desk lesson' with no subverb throws", () => {
    expect(() => parseOuroCommand(["desk", "lesson"])).toThrow(/usage/i)
  })
})

describe("ouro desk CLI parsing — search / recall / reindex / thread", () => {
  it("'desk search <query>' parses to desk_search with query", () => {
    expect(parseOuroCommand(["desk", "search", "build errors"])).toEqual({
      kind: "desk",
      tool: "desk_search",
      toolArgs: { query: "build errors" },
    })
  })

  it("'desk search' joins multiple words", () => {
    expect(parseOuroCommand(["desk", "search", "build", "errors"])).toEqual({
      kind: "desk",
      tool: "desk_search",
      toolArgs: { query: "build errors" },
    })
  })

  it("'desk search' without query throws", () => {
    expect(() => parseOuroCommand(["desk", "search"])).toThrow(/usage/i)
  })

  it("'desk recall <topic>' parses to desk_recall", () => {
    expect(parseOuroCommand(["desk", "recall", "europe trip"])).toEqual({
      kind: "desk",
      tool: "desk_recall",
      toolArgs: { query: "europe trip" },
    })
  })

  it("'desk recall' without query throws", () => {
    expect(() => parseOuroCommand(["desk", "recall"])).toThrow(/usage/i)
  })

  it("'desk reindex' parses to desk_reindex with no args", () => {
    expect(parseOuroCommand(["desk", "reindex"])).toEqual({
      kind: "desk",
      tool: "desk_reindex",
      toolArgs: {},
    })
  })

  it("'desk thread <path>' parses to desk_thread", () => {
    expect(parseOuroCommand(["desk", "thread", "harness/fix-bug/task.md"])).toEqual({
      kind: "desk",
      tool: "desk_thread",
      toolArgs: { start_path: "harness/fix-bug/task.md" },
    })
  })

  it("'desk thread' without path throws", () => {
    expect(() => parseOuroCommand(["desk", "thread"])).toThrow(/usage/i)
  })

  it("'desk' with unknown subverb throws", () => {
    expect(() => parseOuroCommand(["desk", "frobnicate"])).toThrow(/usage/i)
  })

  it("'desk' bare throws", () => {
    expect(() => parseOuroCommand(["desk"])).toThrow(/usage/i)
  })
})

// ── Task alias router ──

describe("ouro task alias — must route through desk_*", () => {
  it("'task list' routes through desk_search with kind=task", () => {
    expect(parseOuroCommand(["task", "list"])).toEqual({
      kind: "desk",
      tool: "desk_search",
      toolArgs: { query: "", filters: { kind: "task" } },
    })
  })

  it("'task new <slug> --track <t>' routes through task_create", () => {
    expect(parseOuroCommand(["task", "new", "fix-bug", "--track", "harness"])).toEqual({
      kind: "desk",
      tool: "task_create",
      toolArgs: { track: "harness", slug: "fix-bug" },
    })
  })

  it("'task done <slug>' routes through task_update", () => {
    expect(parseOuroCommand(["task", "done", "harness/fix-bug"])).toEqual({
      kind: "desk",
      tool: "task_update",
      toolArgs: { path: "harness/fix-bug/task.md", frontmatter: { status: "done" } },
    })
  })

  it("'task archive <slug>' routes through task_archive", () => {
    expect(parseOuroCommand(["task", "archive", "harness/fix-bug"])).toEqual({
      kind: "desk",
      tool: "task_archive",
      toolArgs: { path: "harness/fix-bug/task.md" },
    })
  })

  it("'task show <slug>' routes through desk_search", () => {
    expect(parseOuroCommand(["task", "show", "fix-bug"])).toEqual({
      kind: "desk",
      tool: "desk_search",
      toolArgs: { query: "fix-bug", filters: { kind: "task" } },
    })
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
      args: JSON.stringify({ query: "", filters: { kind: "task" } }),
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
      args: JSON.stringify({ text: "build is slow" }),
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
      args: JSON.stringify({ query: "", filters: { kind: "task" } }),
    })
  })

  it("'desk' surfaces daemon-unavailable cleanly when socket throws", async () => {
    sendCommand.mockRejectedValue(new Error("ECONNREFUSED"))
    const deps = createMockDeps({ sendCommand })

    const result = await runOuroCli(["desk", "task", "list"], deps)

    expect(result).toContain("daemon unavailable")
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
})

// ── Helper-branch coverage ──

describe("desk task helpers — slug normalisation", () => {
  it("'task done' accepts a slug already ending in /task.md (idempotent)", () => {
    expect(parseOuroCommand(["desk", "task", "done", "harness/fix/task.md"])).toEqual({
      kind: "desk",
      tool: "task_update",
      toolArgs: { path: "harness/fix/task.md", frontmatter: { status: "done" } },
    })
  })

  it("'task archive' accepts a slug already ending in /task.md", () => {
    expect(parseOuroCommand(["desk", "task", "archive", "harness/fix/task.md"])).toEqual({
      kind: "desk",
      tool: "task_archive",
      toolArgs: { path: "harness/fix/task.md" },
    })
  })

  it("'task done' strips a trailing slash before appending /task.md", () => {
    expect(parseOuroCommand(["desk", "task", "done", "harness/fix/"])).toEqual({
      kind: "desk",
      tool: "task_update",
      toolArgs: { path: "harness/fix/task.md", frontmatter: { status: "done" } },
    })
  })
})

describe("deskUsage()", () => {
  it("exports a human-readable usage string", async () => {
    const { deskUsage } = await import("../../../heart/daemon/cli-desk")
    const usage = deskUsage()
    expect(usage).toContain("ouro desk task list")
    expect(usage).toContain("ouro desk friction add")
    expect(usage).toContain("ouro task ...")
  })
})
