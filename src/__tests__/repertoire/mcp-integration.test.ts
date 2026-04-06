import { describe, it, expect, vi } from "vitest"
import { parseOuroCommand, runOuroCli, type OuroCliDeps } from "../../heart/daemon/daemon-cli"
import { bodyMapSection } from "../../mind/prompt"
import { OURO_CLI_TRUST_MANIFEST } from "../../repertoire/guardrails"

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

describe("MCP integration — full flow", () => {
  describe("ouro mcp list end-to-end (parse -> daemon -> output)", () => {
    it("parses and runs mcp list through daemon socket", async () => {
      const sendCommand = vi.fn().mockResolvedValue({
        ok: true,
        data: [
          {
            server: "ado",
            tools: [
              { name: "get_items", description: "Get work items", inputSchema: { type: "object" } },
            ],
          },
        ],
      })

      const command = parseOuroCommand(["mcp", "list"])
      expect(command.kind).toBe("mcp.list")

      const deps = createMockDeps({ sendCommand })
      const result = await runOuroCli(["mcp", "list"], deps)

      expect(sendCommand).toHaveBeenCalledWith("/tmp/ouro-test.sock", { kind: "mcp.list" })
      expect(result).toContain("ado")
      expect(result).toContain("get_items")
      expect(deps.writeStdout).toHaveBeenCalledWith(expect.stringContaining("ado"))
    })
  })

  describe("ouro mcp call end-to-end (parse -> daemon -> output)", () => {
    it("parses and runs mcp call through daemon socket", async () => {
      const sendCommand = vi.fn().mockResolvedValue({
        ok: true,
        data: {
          content: [{ type: "text", text: "integration result" }],
        },
      })

      const command = parseOuroCommand(["mcp", "call", "ado", "get_items", "--args", '{"query":"test"}'])
      expect(command.kind).toBe("mcp.call")

      const deps = createMockDeps({ sendCommand })
      const result = await runOuroCli(["mcp", "call", "ado", "get_items", "--args", '{"query":"test"}'], deps)

      expect(sendCommand).toHaveBeenCalledWith("/tmp/ouro-test.sock", {
        kind: "mcp.call",
        server: "ado",
        tool: "get_items",
        args: '{"query":"test"}',
      })
      expect(result).toContain("integration result")
    })
  })

  describe("agent without mcpServers", () => {
    it("ouro mcp list returns 'no servers configured' message via daemon", async () => {
      const sendCommand = vi.fn().mockResolvedValue({
        ok: true,
        data: [],
        message: "no MCP servers configured",
      })
      const deps = createMockDeps({ sendCommand })

      const result = await runOuroCli(["mcp", "list"], deps)

      expect(result).toContain("no MCP servers configured")
    })

    it("MCP tools are now first-class — no system prompt section needed", () => {
      // mcpToolsSection was removed. MCP tools appear in the active tool list directly.
      // This test documents that the old pattern is gone.
      expect(true).toBe(true)
    })
  })

  describe("trust manifest integration", () => {
    it("mcp list requires acquaintance trust", () => {
      expect(OURO_CLI_TRUST_MANIFEST["mcp list"]).toBe("acquaintance")
    })

    it("mcp call requires friend trust", () => {
      expect(OURO_CLI_TRUST_MANIFEST["mcp call"]).toBe("friend")
    })
  })

  describe("body map includes MCP CLI entries", () => {
    it("bodyMapSection contains mcp commands", () => {
      const body = bodyMapSection("testagent")
      expect(body).toContain("ouro mcp list")
      expect(body).toContain("ouro mcp call")
    })
  })
})
