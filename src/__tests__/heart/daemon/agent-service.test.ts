import { describe, it, expect, vi, beforeEach } from "vitest"
import { emitNervesEvent } from "../../../nerves/runtime"

// Mock diary module — shared functions the service layer reuses
vi.mock("../../../mind/diary", () => ({
  readDiaryEntries: vi.fn(() => []),
  searchDiaryEntries: vi.fn(async () => []),
  resolveDiaryRoot: vi.fn((p?: string) => p ?? "/mock/diary"),
}))

vi.mock("../../../heart/identity", () => ({
  getAgentRoot: vi.fn((agent: string) => `/mock/agents/${agent}.ouro`),
}))

vi.mock("fs", () => ({
  existsSync: vi.fn(() => false),
  readFileSync: vi.fn(() => ""),
  readdirSync: vi.fn(() => []),
  statSync: vi.fn(() => ({ isDirectory: () => false })),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
}))

import * as fs from "fs"
import { readDiaryEntries, searchDiaryEntries, resolveDiaryRoot } from "../../../mind/diary"

describe("agent-service handlers", () => {
  beforeEach(() => {
    vi.mocked(readDiaryEntries).mockReturnValue([])
    vi.mocked(searchDiaryEntries).mockResolvedValue([])
    vi.mocked(fs.existsSync).mockReturnValue(false)
    vi.mocked(fs.readFileSync).mockReturnValue("")
    vi.mocked(fs.readdirSync).mockReturnValue([])
    emitNervesEvent({ component: "daemon", event: "daemon.agent_service_test_start", message: "test starting", meta: {} })
  })

  describe("handleAgentStatus", () => {
    it("returns status with no memory or sessions", async () => {
      const { handleAgentStatus } = await import("../../../heart/daemon/agent-service")
      const r = await handleAgentStatus({ agent: "test", friendId: "f1" })
      expect(r.ok).toBe(true)
      expect(r.data).toMatchObject({ agent: "test", hasMemory: false, sessionCount: 0 })
    })

    it("resolves diary root via diary/ path, not psyche/memory/", async () => {
      const { handleAgentStatus } = await import("../../../heart/daemon/agent-service")
      await handleAgentStatus({ agent: "test", friendId: "f1" })
      // agentDiaryRoot should pass diary/ path, not psyche/memory/
      expect(vi.mocked(resolveDiaryRoot)).toHaveBeenCalledWith(
        expect.stringContaining("/diary"),
      )
      expect(vi.mocked(resolveDiaryRoot)).not.toHaveBeenCalledWith(
        expect.stringContaining("psyche/memory"),
      )
    })

    it("reports memory when diary entries exist", async () => {
      vi.mocked(readDiaryEntries).mockReturnValue([
        { id: "1", text: "fact one", source: "test", createdAt: "2026-01-01", embedding: [] },
      ])
      const { handleAgentStatus } = await import("../../../heart/daemon/agent-service")
      const r = await handleAgentStatus({ agent: "test", friendId: "f1" })
      expect(r.data).toMatchObject({ hasMemory: true, factCount: 1 })
    })

    it("reads inner dialog status", async () => {
      vi.mocked(fs.existsSync).mockImplementation((p) => String(p).includes("runtime.json"))
      vi.mocked(fs.readFileSync).mockImplementation((p) => {
        if (String(p).includes("runtime.json")) return JSON.stringify({ status: "thinking", lastCompletedAt: "2026-03-26T01:00:00Z" })
        return ""
      })
      const { handleAgentStatus } = await import("../../../heart/daemon/agent-service")
      const r = await handleAgentStatus({ agent: "test", friendId: "f1" })
      expect(r.data).toMatchObject({ innerStatus: "thinking" })
    })

    it("handles malformed runtime.json gracefully (JSON parse error)", async () => {
      vi.mocked(fs.existsSync).mockImplementation((p) => String(p).includes("runtime.json"))
      vi.mocked(fs.readFileSync).mockImplementation((p) => {
        if (String(p).includes("runtime.json")) return "not valid json{{"
        return ""
      })
      const { handleAgentStatus } = await import("../../../heart/daemon/agent-service")
      const r = await handleAgentStatus({ agent: "test", friendId: "f1" })
      // Falls back to unknown when JSON parse fails
      expect(r.data).toMatchObject({ innerStatus: "unknown" })
    })
  })

  describe("handleAgentAsk", () => {
    it("returns error when question is missing", async () => {
      const { handleAgentAsk } = await import("../../../heart/daemon/agent-service")
      const r = await handleAgentAsk({ agent: "test", friendId: "f1" })
      expect(r.ok).toBe(false)
    })

    it("delegates to searchDiaryEntries (same as recall tool)", async () => {
      vi.mocked(searchDiaryEntries).mockResolvedValue([
        { id: "1", text: "ouroboros is an agent runtime", source: "test", createdAt: "2026-01-01", embedding: [] },
      ])
      const { handleAgentAsk } = await import("../../../heart/daemon/agent-service")
      const r = await handleAgentAsk({ agent: "test", friendId: "f1", question: "what is ouroboros?" })
      expect(r.ok).toBe(true)
      expect(r.message).toContain("ouroboros is an agent runtime")
      expect(searchDiaryEntries).toHaveBeenCalledWith("what is ouroboros?", expect.any(Array))
    })

    it("returns no-matches message when search finds nothing", async () => {
      const { handleAgentAsk } = await import("../../../heart/daemon/agent-service")
      const r = await handleAgentAsk({ agent: "test", friendId: "f1", question: "unknown" })
      expect(r.message).toContain("No relevant memories found")
    })
  })

  describe("handleAgentSearchMemory", () => {
    it("returns error when query is missing", async () => {
      const { handleAgentSearchMemory } = await import("../../../heart/daemon/agent-service")
      const r = await handleAgentSearchMemory({ agent: "test", friendId: "f1" })
      expect(r.ok).toBe(false)
    })

    it("formats results like the recall tool ([diary] prefix)", async () => {
      vi.mocked(searchDiaryEntries).mockResolvedValue([
        { id: "1", text: "MCP server bridge", source: "tool:diary_write", createdAt: "2026-03-26", embedding: [] },
      ])
      const { handleAgentSearchMemory } = await import("../../../heart/daemon/agent-service")
      const r = await handleAgentSearchMemory({ agent: "test", friendId: "f1", query: "MCP" })
      expect(r.ok).toBe(true)
      const matches = (r.data as { matches: string[] }).matches
      expect(matches[0]).toContain("[diary]")
      expect(matches[0]).toContain("MCP server bridge")
      expect(matches[0]).toContain("source=tool:diary_write")
    })
  })

  describe("handleAgentCatchup", () => {
    it("returns no recent activity when empty", async () => {
      const { handleAgentCatchup } = await import("../../../heart/daemon/agent-service")
      const r = await handleAgentCatchup({ agent: "test", friendId: "f1" })
      expect(r.ok).toBe(true)
      expect(r.message).toContain("No recent sessions")
    })

    it("enumerates sessions from filesystem and sorts by lastUsage", async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true)
      vi.mocked(fs.statSync).mockImplementation((p) => {
        const s = String(p)
        // Make files (not directories) at certain paths
        if (s.endsWith("not-a-dir")) return { isDirectory: () => false } as any
        if (s.endsWith("not-a-channel")) return { isDirectory: () => false } as any
        return { isDirectory: () => true } as any
      })
      vi.mocked(fs.readdirSync).mockImplementation((p) => {
        const s = String(p)
        if (s.endsWith("sessions")) return ["friend-1", "not-a-dir"] as any
        if (s.endsWith("friend-1")) return ["mcp", "not-a-channel"] as any
        if (s.endsWith("mcp")) return ["session-1", "session-missing"] as any
        return []
      })
      vi.mocked(fs.existsSync).mockImplementation((p) => {
        const s = String(p)
        if (s.includes("sessions") && !s.includes("session.json")) return true
        // session.json exists for session-1 but not session-missing
        if (s.includes("session-1") && s.endsWith("session.json")) return true
        if (s.includes("session-missing") && s.endsWith("session.json")) return false
        return false
      })
      vi.mocked(fs.readFileSync).mockImplementation((p) => {
        if (String(p).includes("session-1") && String(p).includes("session.json")) return JSON.stringify({ lastUsage: "2026-03-26T10:00:00Z" })
        return ""
      })
      const { handleAgentCatchup } = await import("../../../heart/daemon/agent-service")
      const r = await handleAgentCatchup({ agent: "test", friendId: "f1" })
      expect(r.ok).toBe(true)
      const data = r.data as { recentSessions: any[] }
      expect(data.recentSessions.length).toBe(1)
      expect(data.recentSessions[0].friendId).toBe("friend-1")
      expect(data.recentSessions[0].channel).toBe("mcp")
    })

    it("skips malformed session.json files gracefully", async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true)
      vi.mocked(fs.statSync).mockReturnValue({ isDirectory: () => true } as any)
      vi.mocked(fs.readdirSync).mockImplementation((p) => {
        const s = String(p)
        if (s.endsWith("sessions")) return ["friend-1"] as any
        if (s.endsWith("friend-1")) return ["cli"] as any
        if (s.endsWith("cli")) return ["sess-bad"] as any
        return []
      })
      vi.mocked(fs.readFileSync).mockImplementation(() => "not valid json{{")
      const { handleAgentCatchup } = await import("../../../heart/daemon/agent-service")
      const r = await handleAgentCatchup({ agent: "test", friendId: "f1" })
      expect(r.ok).toBe(true)
      expect(r.message).toContain("No recent sessions")
    })

    it("sorts sessions by lastUsage, handling missing values", async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true)
      vi.mocked(fs.statSync).mockReturnValue({ isDirectory: () => true } as any)
      vi.mocked(fs.readdirSync).mockImplementation((p) => {
        const s = String(p)
        if (s.endsWith("sessions")) return ["f1", "f2", "f3"] as any
        if (s.endsWith("f1")) return ["mcp"] as any
        if (s.endsWith("f2")) return ["cli"] as any
        if (s.endsWith("f3")) return ["teams"] as any
        if (s.endsWith("mcp")) return ["s1"] as any
        if (s.endsWith("cli")) return ["s2"] as any
        if (s.endsWith("teams")) return ["s3"] as any
        return []
      })
      vi.mocked(fs.readFileSync).mockImplementation((p) => {
        const s = String(p)
        if (s.includes("f1") && s.includes("session.json")) return JSON.stringify({})
        if (s.includes("f2") && s.includes("session.json")) return JSON.stringify({ lastUsage: "2026-03-26T10:00:00Z" })
        if (s.includes("f3") && s.includes("session.json")) return JSON.stringify({})
        return ""
      })
      const { handleAgentCatchup } = await import("../../../heart/daemon/agent-service")
      const r = await handleAgentCatchup({ agent: "test", friendId: "f1" })
      const data = r.data as { recentSessions: any[] }
      expect(data.recentSessions.length).toBe(3)
      // f2 has lastUsage, so it should sort first
      expect(data.recentSessions[0].friendId).toBe("f2")
    })

    it("handles session without lastUsage property", async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true)
      vi.mocked(fs.statSync).mockReturnValue({ isDirectory: () => true } as any)
      vi.mocked(fs.readdirSync).mockImplementation((p) => {
        const s = String(p)
        if (s.endsWith("sessions")) return ["friend-1"] as any
        if (s.endsWith("friend-1")) return ["mcp"] as any
        if (s.endsWith("mcp")) return ["sess-1"] as any
        return []
      })
      vi.mocked(fs.readFileSync).mockImplementation((p) => {
        if (String(p).includes("session.json")) return JSON.stringify({ version: 1 })
        return ""
      })
      const { handleAgentCatchup } = await import("../../../heart/daemon/agent-service")
      const r = await handleAgentCatchup({ agent: "test", friendId: "f1" })
      expect(r.ok).toBe(true)
      const data = r.data as { recentSessions: any[] }
      expect(data.recentSessions.length).toBe(1)
      // lastUsage defaults to "" when not present
      expect(data.recentSessions[0].lastUsage).toBe("")
    })

    it("includes inner dialog status", async () => {
      vi.mocked(fs.existsSync).mockImplementation((p) => String(p).includes("runtime.json"))
      vi.mocked(fs.readFileSync).mockImplementation((p) => {
        if (String(p).includes("runtime.json")) return JSON.stringify({ status: "idle", lastCompletedAt: "2026-03-26T10:00:00Z" })
        return ""
      })
      const { handleAgentCatchup } = await import("../../../heart/daemon/agent-service")
      const r = await handleAgentCatchup({ agent: "test", friendId: "f1" })
      expect(r.message).toContain("Inner dialog: idle")
    })
  })

  describe("handleAgentGetContext", () => {
    it("returns recent facts when no query is provided", async () => {
      vi.mocked(readDiaryEntries).mockReturnValue([
        { id: "1", text: "fact one", source: "test", createdAt: "2026-01-01", embedding: [] },
        { id: "2", text: "fact two", source: "test", createdAt: "2026-01-02", embedding: [] },
      ])
      const { handleAgentGetContext } = await import("../../../heart/daemon/agent-service")
      const r = await handleAgentGetContext({ agent: "test", friendId: "f1" })
      expect((r.data as Record<string, unknown>).memorySummary).toContain("fact one")
      expect((r.data as Record<string, unknown>).memorySummary).toContain("fact two")
    })

    it("returns no-match message when query finds nothing", async () => {
      vi.mocked(searchDiaryEntries).mockResolvedValue([])
      const { handleAgentGetContext } = await import("../../../heart/daemon/agent-service")
      const r = await handleAgentGetContext({ agent: "test", friendId: "f1", question: "nonexistent" })
      expect((r.data as Record<string, unknown>).memorySummary).toContain("No relevant memories")
    })

    it("uses searchDiaryEntries when query is provided", async () => {
      vi.mocked(searchDiaryEntries).mockResolvedValue([
        { id: "1", text: "relevant", source: "test", createdAt: "2026-01-01", embedding: [] },
      ])
      const { handleAgentGetContext } = await import("../../../heart/daemon/agent-service")
      const r = await handleAgentGetContext({ agent: "test", friendId: "f1", query: "context" })
      expect((r.data as Record<string, unknown>).memorySummary).toContain("relevant")
      expect(searchDiaryEntries).toHaveBeenCalled()
    })
  })

  describe("handleAgentCheckGuidance", () => {
    it("returns error when topic is missing", async () => {
      const { handleAgentCheckGuidance } = await import("../../../heart/daemon/agent-service")
      const r = await handleAgentCheckGuidance({ agent: "test", friendId: "f1" })
      expect(r.ok).toBe(false)
    })

    it("uses searchDiaryEntries for guidance", async () => {
      vi.mocked(searchDiaryEntries).mockResolvedValue([
        { id: "1", text: "always use explicit types", source: "test", createdAt: "2026-01-01", embedding: [] },
      ])
      const { handleAgentCheckGuidance } = await import("../../../heart/daemon/agent-service")
      const r = await handleAgentCheckGuidance({ agent: "test", friendId: "f1", topic: "types" })
      expect(r.message).toContain("always use explicit types")
    })
  })

  describe("handleAgentDelegate", () => {
    it("returns error when task is missing", async () => {
      const { handleAgentDelegate } = await import("../../../heart/daemon/agent-service")
      const r = await handleAgentDelegate({ agent: "test", friendId: "f1" })
      expect(r.ok).toBe(false)
    })

    it("queues task", async () => {
      const { handleAgentDelegate } = await import("../../../heart/daemon/agent-service")
      const r = await handleAgentDelegate({ agent: "test", friendId: "f1", task: "fix bug" })
      expect(r.ok).toBe(true)
      expect(r.message).toContain("fix bug")
    })
  })

  describe("handleAgentGetTask", () => {
    it("returns no tasks when empty", async () => {
      const { handleAgentGetTask } = await import("../../../heart/daemon/agent-service")
      const r = await handleAgentGetTask({ agent: "test", friendId: "f1" })
      expect(r.message).toContain("No active tasks")
    })

    it("handles missing task file content gracefully", async () => {
      vi.mocked(fs.existsSync).mockImplementation((p) => {
        const s = String(p)
        return s.includes("tasks") && !s.endsWith(".md")
      })
      vi.mocked(fs.readdirSync).mockImplementation((p) => {
        if (String(p).includes("tasks")) return ["plan.md"] as any
        return []
      })
      vi.mocked(fs.readFileSync).mockImplementation(() => { throw new Error("ENOENT") })
      const { handleAgentGetTask } = await import("../../../heart/daemon/agent-service")
      const r = await handleAgentGetTask({ agent: "test", friendId: "f1" })
      expect(r.ok).toBe(true)
      // Task shows up but with empty statusLine since file doesn't exist
      const data = r.data as { tasks: { name: string; statusLine: string }[] }
      expect(data.tasks[0].name).toBe("plan.md")
      expect(data.tasks[0].statusLine).toBe("")
    })

    it("returns task files with first-line summary", async () => {
      vi.mocked(fs.existsSync).mockImplementation((p) => {
        const s = String(p)
        return s.includes("tasks")
      })
      vi.mocked(fs.readdirSync).mockImplementation((p) => {
        const s = String(p)
        if (s.includes("tasks")) return ["doing-feature.md", "plan.md"] as any
        return []
      })
      vi.mocked(fs.readFileSync).mockImplementation((p) => {
        const s = String(p)
        if (s.includes("doing-feature.md")) return "# Feature doing doc\nSome details"
        if (s.includes("plan.md")) return "# Plan\nPlanning details"
        return ""
      })
      const { handleAgentGetTask } = await import("../../../heart/daemon/agent-service")
      const r = await handleAgentGetTask({ agent: "test", friendId: "f1" })
      expect(r.ok).toBe(true)
      const data = r.data as { tasks: { name: string; statusLine: string }[]; activeCount: number; totalCount: number }
      // "doing" file should be prioritized
      expect(data.activeCount).toBe(1)
      expect(data.totalCount).toBe(2)
      expect(data.tasks[0].name).toBe("doing-feature.md")
      expect(data.tasks[0].statusLine).toBe("# Feature doing doc")
    })
  })

  describe("handleAgentGetTask — edge cases", () => {
    it("returns empty when tasks dir exists but readdirSync throws", async () => {
      vi.mocked(fs.existsSync).mockImplementation((p) => {
        return String(p).includes("tasks")
      })
      vi.mocked(fs.readdirSync).mockImplementation(() => { throw new Error("EACCES") })
      const { handleAgentGetTask } = await import("../../../heart/daemon/agent-service")
      const r = await handleAgentGetTask({ agent: "test", friendId: "f1" })
      expect(r.ok).toBe(true)
      expect(r.message).toContain("No active tasks")
    })
  })

  describe("handleAgentCheckScope", () => {
    it("returns error when item is missing", async () => {
      const { handleAgentCheckScope } = await import("../../../heart/daemon/agent-service")
      const r = await handleAgentCheckScope({ agent: "test", friendId: "f1" })
      expect(r.ok).toBe(false)
    })
  })

  describe("handleAgentRequestDecision", () => {
    it("returns error when topic is missing", async () => {
      const { handleAgentRequestDecision } = await import("../../../heart/daemon/agent-service")
      const r = await handleAgentRequestDecision({ agent: "test", friendId: "f1" })
      expect(r.ok).toBe(false)
    })
  })

  describe("report handlers", () => {
    it("reportProgress errors without summary", async () => {
      const { handleAgentReportProgress } = await import("../../../heart/daemon/agent-service")
      expect((await handleAgentReportProgress({ agent: "t", friendId: "f" })).ok).toBe(false)
    })

    it("reportProgress succeeds", async () => {
      const { handleAgentReportProgress } = await import("../../../heart/daemon/agent-service")
      expect((await handleAgentReportProgress({ agent: "t", friendId: "f", summary: "done" })).ok).toBe(true)
    })

    it("reportBlocker errors without blocker", async () => {
      const { handleAgentReportBlocker } = await import("../../../heart/daemon/agent-service")
      expect((await handleAgentReportBlocker({ agent: "t", friendId: "f" })).ok).toBe(false)
    })

    it("reportComplete errors without summary", async () => {
      const { handleAgentReportComplete } = await import("../../../heart/daemon/agent-service")
      expect((await handleAgentReportComplete({ agent: "t", friendId: "f" })).ok).toBe(false)
    })

    it("reportComplete succeeds", async () => {
      const { handleAgentReportComplete } = await import("../../../heart/daemon/agent-service")
      const r = await handleAgentReportComplete({ agent: "t", friendId: "f", summary: "all done" })
      expect(r.ok).toBe(true)
      expect(r.message).toContain("all done")
    })
  })
})
