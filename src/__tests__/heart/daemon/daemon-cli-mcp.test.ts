import { describe, it, expect, vi, beforeEach } from "vitest"

import {
  parseOuroCommand,
  runOuroCli,
  type OuroCliDeps,
} from "../../../heart/daemon/daemon-cli"

function createMockDeps(overrides: Partial<OuroCliDeps> = {}): OuroCliDeps {
  return {
    socketPath: "/tmp/ouro-test.sock",
    sendCommand: vi.fn().mockResolvedValue({ ok: true, summary: "ok" }),
    startDaemonProcess: vi.fn().mockResolvedValue({ pid: 12345 }),
    writeStdout: vi.fn(),
    checkSocketAlive: vi.fn().mockResolvedValue(true),
    cleanupStaleSocket: vi.fn(),
    fallbackPendingMessage: vi.fn().mockReturnValue("pending"),
    ...overrides,
  }
}

describe("ouro mcp CLI parsing", () => {
  it("parses 'mcp list' command", () => {
    expect(parseOuroCommand(["mcp", "list"])).toEqual({ kind: "mcp.list" })
  })

  it("parses 'mcp list' with agent context", () => {
    expect(parseOuroCommand(["mcp", "list", "--agent", "slugger"])).toEqual({
      kind: "mcp.list",
      agent: "slugger",
    })
  })

  it("parses 'mcp call' with server, tool, and args", () => {
    expect(
      parseOuroCommand(["mcp", "call", "ado", "get_work_items", "--args", '{"query":"..."}'])
    ).toEqual({
      kind: "mcp.call",
      server: "ado",
      tool: "get_work_items",
      args: '{"query":"..."}',
    })
  })

  it("parses 'mcp call' without args flag", () => {
    expect(parseOuroCommand(["mcp", "call", "ado", "get_work_items"])).toEqual({
      kind: "mcp.call",
      server: "ado",
      tool: "get_work_items",
    })
  })

  it("parses 'mcp call' with agent context", () => {
    expect(parseOuroCommand(["mcp", "call", "spoonjoy", "health", "--agent", "slugger"])).toEqual({
      kind: "mcp.call",
      server: "spoonjoy",
      tool: "health",
      agent: "slugger",
    })
  })

  it("throws for 'mcp call' with missing server/tool", () => {
    expect(() => parseOuroCommand(["mcp", "call"])).toThrow(/usage/i)
    expect(() => parseOuroCommand(["mcp", "call", "ado"])).toThrow(/usage/i)
  })

  it("throws for 'mcp' with unknown subcommand", () => {
    expect(() => parseOuroCommand(["mcp", "unknown"])).toThrow(/usage/i)
  })

  it("throws for bare 'mcp' without subcommand", () => {
    expect(() => parseOuroCommand(["mcp"])).toThrow(/usage/i)
  })
})

describe("ouro mcp CLI execution (daemon-routed)", () => {
  let sendCommand: ReturnType<typeof vi.fn>

  beforeEach(() => {
    sendCommand = vi.fn()
  })

  it("'mcp list' sends command through daemon socket and formats output", async () => {
    sendCommand.mockResolvedValue({
      ok: true,
      data: [
        {
          server: "ado",
          tools: [
            { name: "get_items", description: "Get work items", inputSchema: { type: "object" } },
          ],
        },
        {
          server: "mail",
          tools: [
            { name: "send_mail", description: "Send mail", inputSchema: { type: "object" } },
          ],
        },
      ],
    })
    const deps = createMockDeps({ sendCommand })

    const result = await runOuroCli(["mcp", "list"], deps)

    expect(sendCommand).toHaveBeenCalledWith("/tmp/ouro-test.sock", { kind: "mcp.list" })
    expect(result).toContain("[ado]")
    expect(result).toContain("get_items")
    expect(result).toContain("[mail]")
    expect(result).toContain("send_mail")
  })

  it("'mcp list --agent' carries the agent through the daemon socket", async () => {
    sendCommand.mockResolvedValue({ ok: true, data: [] })
    const deps = createMockDeps({ sendCommand })

    await runOuroCli(["mcp", "list", "--agent", "slugger"], deps)

    expect(sendCommand).toHaveBeenCalledWith("/tmp/ouro-test.sock", {
      kind: "mcp.list",
      agent: "slugger",
    })
  })

  it("'mcp call' sends command through daemon socket and prints result", async () => {
    sendCommand.mockResolvedValue({
      ok: true,
      data: {
        content: [{ type: "text", text: "tool result here" }],
      },
    })
    const deps = createMockDeps({ sendCommand })

    const result = await runOuroCli(["mcp", "call", "ado", "get_items", "--args", '{"query":"test"}'], deps)

    expect(sendCommand).toHaveBeenCalledWith("/tmp/ouro-test.sock", {
      kind: "mcp.call",
      server: "ado",
      tool: "get_items",
      args: '{"query":"test"}',
    })
    expect(result).toContain("tool result here")
  })

  it("'mcp call --agent' carries the agent through the daemon socket", async () => {
    sendCommand.mockResolvedValue({
      ok: true,
      data: { content: [{ type: "text", text: "healthy" }] },
    })
    const deps = createMockDeps({ sendCommand })

    await runOuroCli(["mcp", "call", "spoonjoy", "health", "--agent", "slugger"], deps)

    expect(sendCommand).toHaveBeenCalledWith("/tmp/ouro-test.sock", {
      kind: "mcp.call",
      server: "spoonjoy",
      tool: "health",
      agent: "slugger",
    })
  })

  it("'mcp call' without args sends command without args field", async () => {
    sendCommand.mockResolvedValue({
      ok: true,
      data: {
        content: [{ type: "text", text: "no args result" }],
      },
    })
    const deps = createMockDeps({ sendCommand })

    await runOuroCli(["mcp", "call", "ado", "get_items"], deps)

    expect(sendCommand).toHaveBeenCalledWith("/tmp/ouro-test.sock", {
      kind: "mcp.call",
      server: "ado",
      tool: "get_items",
    })
  })

  it("'mcp list' with daemon error shows helpful message", async () => {
    sendCommand.mockResolvedValue({
      ok: true,
      data: [],
      message: "no MCP servers configured",
    })
    const deps = createMockDeps({ sendCommand })

    const result = await runOuroCli(["mcp", "list"], deps)

    expect(result).toContain("no MCP servers configured")
  })

  it("'mcp call' with daemon error shows error message", async () => {
    sendCommand.mockResolvedValue({
      ok: false,
      error: "no MCP servers configured",
    })
    const deps = createMockDeps({ sendCommand })

    const result = await runOuroCli(["mcp", "call", "ado", "get_items"], deps)

    expect(result).toContain("no MCP servers configured")
  })

  it("'mcp list' with empty tools shows appropriate message", async () => {
    sendCommand.mockResolvedValue({
      ok: true,
      data: [],
    })
    const deps = createMockDeps({ sendCommand })

    const result = await runOuroCli(["mcp", "list"], deps)

    expect(result).toContain("no tools")
  })

  it("'mcp call' with ok response but no data shows fallback message", async () => {
    sendCommand.mockResolvedValue({
      ok: true,
      message: "completed",
    })
    const deps = createMockDeps({ sendCommand })

    const result = await runOuroCli(["mcp", "call", "ado", "get_items"], deps)

    expect(result).toBe("completed")
  })

  it("'mcp call' with ok response, no data, and no message shows 'no result'", async () => {
    sendCommand.mockResolvedValue({
      ok: true,
    })
    const deps = createMockDeps({ sendCommand })

    const result = await runOuroCli(["mcp", "call", "ado", "get_items"], deps)

    expect(result).toBe("no result")
  })

  it("'mcp call' with error response and no error message shows 'unknown error'", async () => {
    sendCommand.mockResolvedValue({
      ok: false,
    })
    const deps = createMockDeps({ sendCommand })

    const result = await runOuroCli(["mcp", "call", "ado", "get_items"], deps)

    expect(result).toBe("unknown error")
  })

  it("'mcp list' when daemon unavailable shows startup hint", async () => {
    sendCommand.mockRejectedValue(new Error("connect ENOENT"))
    const deps = createMockDeps({ sendCommand })

    const result = await runOuroCli(["mcp", "list"], deps)

    expect(result).toContain("daemon unavailable")
    expect(result).toContain("ouro up")
  })

  it("'mcp call' when daemon unavailable shows startup hint", async () => {
    sendCommand.mockRejectedValue(new Error("connect ENOENT"))
    const deps = createMockDeps({ sendCommand })

    const result = await runOuroCli(["mcp", "call", "ado", "get_items"], deps)

    expect(result).toContain("daemon unavailable")
  })
})
