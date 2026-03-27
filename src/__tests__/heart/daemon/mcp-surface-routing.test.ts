import { describe, it, expect, vi } from "vitest"
import { emitNervesEvent } from "../../../nerves/runtime"

// ── Mocks ──────────────────────────────────────────────────────

vi.mock("fs", () => ({
  existsSync: vi.fn(() => true),
  readFileSync: vi.fn(),
  readdirSync: vi.fn(() => []),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
  statSync: vi.fn(() => ({ isDirectory: () => true })),
}))

vi.mock("../../../heart/identity", () => ({
  getAgentRoot: vi.fn((agent: string) => `/mock/bundles/${agent}`),
  getAgentName: vi.fn(() => "test-agent"),
}))

import * as fs from "fs"

// ── Tests ──────────────────────────────────────────────────────

describe("mcp surface routing + session awareness", () => {
  it("enumerateSessions picks up mcp sessions alongside cli/teams/bb", async () => {
    emitNervesEvent({
      component: "daemon",
      event: "daemon.mcp_surface_test_start",
      message: "mcp surface routing test",
      meta: {},
    })

    // Mock filesystem: state/sessions/{friendId}/{channel}/{key}/session.json
    vi.mocked(fs.existsSync).mockImplementation((p: any) => {
      const s = String(p)
      return s.includes("state/sessions")
    })

    vi.mocked(fs.readdirSync).mockImplementation((p: any): any => {
      const s = String(p)
      if (s.endsWith("sessions")) return ["friend-1"]
      if (s.endsWith("friend-1")) return ["cli", "mcp", "teams"]
      if (s.endsWith("cli")) return ["session"]
      if (s.endsWith("mcp")) return ["session-abc-123"]
      if (s.endsWith("teams")) return ["general"]
      return []
    })

    vi.mocked(fs.statSync).mockImplementation((): any => ({
      isDirectory: () => true,
    }))

    vi.mocked(fs.readFileSync).mockImplementation((p: any): any => {
      return JSON.stringify({ lastUsage: "2026-03-26T12:00:00.000Z" })
    })

    // Dynamic import after mocks
    const { handleAgentCatchup } = await import("../../../heart/daemon/agent-service")
    const result = await handleAgentCatchup({ agent: "test-agent", friendId: "friend-1" })

    expect(result.ok).toBe(true)
    // Should include the mcp session in the output
    expect(result.message).toContain("mcp")
    expect(result.message).toContain("session-abc-123")
  })

  it("surface tool can queue to mcp pending path via routeToFriend", async () => {
    emitNervesEvent({
      component: "senses",
      event: "senses.mcp_surface_routing_test",
      message: "verifying surface routes to mcp pending",
      meta: {},
    })

    // Import the surface tool handler
    const { handleSurface } = await import("../../../senses/surface-tool")

    // Mock routeToFriend to simulate pending queue write
    const mockRouteToFriend = vi.fn().mockResolvedValue({ status: "queued" as const })

    const result = await handleSurface({
      content: "here is your answer",
      friendId: "friend-1",
      queue: [],
      routeToFriend: mockRouteToFriend,
      advanceObligation: vi.fn(),
    })

    expect(mockRouteToFriend).toHaveBeenCalledWith("friend-1", "here is your answer", undefined)
    expect(result).toContain("queued")
  })
})
