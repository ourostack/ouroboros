import { describe, it, expect, vi, beforeEach } from "vitest"
import { emitNervesEvent } from "../../../nerves/runtime"

const mockSendDaemonCommand = vi.fn()

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

vi.mock("../../../heart/daemon/socket-client", () => ({
  DEFAULT_DAEMON_SOCKET_PATH: "/tmp/ouroboros-daemon.sock",
  sendDaemonCommand: (...args: any[]) => mockSendDaemonCommand(...args),
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
    mockSendDaemonCommand.mockReset()
    mockSendDaemonCommand.mockResolvedValue({ ok: true, data: null })
    emitNervesEvent({ component: "daemon", event: "daemon.agent_service_test_start", message: "test starting", meta: {} })
  })

  describe("handleAgentStatus", () => {
    it("returns status with no diary entries or sessions", async () => {
      const { handleAgentStatus } = await import("../../../heart/daemon/agent-service")
      const r = await handleAgentStatus({ agent: "test", friendId: "f1" })
      expect(r.ok).toBe(true)
      expect(r.data).toMatchObject({ agent: "test", hasDiaryEntries: false, sessionCount: 0 })
      expect(r.message).toContain("innerStatus=unknown")
      expect(r.message).toContain("sessionCount=0")
      expect(r.message).not.toBe("Agent test status")
    })

    it("resolves diary root via diary/ path, not psyche/notes/", async () => {
      const { handleAgentStatus } = await import("../../../heart/daemon/agent-service")
      await handleAgentStatus({ agent: "test", friendId: "f1" })
      // agentDiaryRoot should pass diary/ path, not psyche/notes/
      expect(vi.mocked(resolveDiaryRoot)).toHaveBeenCalledWith(
        expect.stringContaining("/diary"),
      )
      expect(vi.mocked(resolveDiaryRoot)).not.toHaveBeenCalledWith(
        expect.stringContaining("psyche/notes"),
      )
    })

    it("reports diary entries when diary entries exist", async () => {
      vi.mocked(readDiaryEntries).mockReturnValue([
        { id: "1", text: "fact one", source: "test", createdAt: "2026-01-01", embedding: [] },
      ])
      const { handleAgentStatus } = await import("../../../heart/daemon/agent-service")
      const r = await handleAgentStatus({ agent: "test", friendId: "f1" })
      expect(r.data).toMatchObject({ hasDiaryEntries: true, factCount: 1 })
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

    it("includes daemon and sense proof details when runtime status is reachable", async () => {
      mockSendDaemonCommand.mockResolvedValueOnce({
        ok: true,
        data: {
          overview: { daemon: "running", health: "ok", version: "0.1.0-alpha.528", mode: "production" },
          workers: [
            { agent: "test", worker: "inner-dialog", status: "running" },
            { agent: "other", worker: "inner-dialog", status: "crashed" },
          ],
          senses: [
            {
              agent: "test",
              sense: "bluebubbles",
              enabled: true,
              status: "running",
              detail: ":18789 /bluebubbles-webhook",
              proofMethod: "bluebubbles.checkHealth",
              lastProofAt: "2026-04-29T21:05:52.423Z",
              proofAgeMs: 7382,
              pendingRecoveryCount: 0,
              failedRecoveryCount: 0,
            },
            { agent: "test", sense: "mail", enabled: true, status: "running", detail: "test@ouro.bot" },
            { agent: "other", sense: "bluebubbles", enabled: true, status: "error", detail: "not ours" },
          ],
        },
      })
      vi.mocked(fs.readFileSync).mockImplementation((p) => {
        if (String(p).endsWith("package.json")) return JSON.stringify({ version: "0.1.0-alpha.528" })
        return ""
      })

      const { handleAgentStatus } = await import("../../../heart/daemon/agent-service")
      const r = await handleAgentStatus({ agent: "test", friendId: "f1", socketPath: "/tmp/test-daemon.sock" })

      expect(mockSendDaemonCommand).toHaveBeenCalledWith("/tmp/test-daemon.sock", { kind: "daemon.status" })
      expect(r.message).toContain("daemon=running")
      expect(r.message).toContain("health=ok")
      expect(r.message).toContain("worker=inner-dialog:running")
      expect(r.message).toContain("sense=bluebubbles:running")
      expect(r.message).toContain("proof=bluebubbles.checkHealth")
      expect(r.message).toContain("proofAgeMs=7382")
      expect(r.message).toContain("sense=mail:running")
      expect(r.message).not.toContain("not ours")
      expect(r.data).toMatchObject({ mcpVersion: "0.1.0-alpha.528" })
    })

    it("makes daemon unreachability explicit without failing agent status", async () => {
      mockSendDaemonCommand.mockRejectedValueOnce(new Error("transport closed"))

      const { handleAgentStatus } = await import("../../../heart/daemon/agent-service")
      const r = await handleAgentStatus({ agent: "test", friendId: "f1", socketPath: "/tmp/test-daemon.sock" })

      expect(r.ok).toBe(true)
      expect(r.message).toContain("daemon=unreachable")
      expect(r.message).toContain("transport closed")
      expect(r.data).toMatchObject({
        runtime: {
          daemonReachable: false,
          error: "transport closed",
        },
      })
    })

    it("flags MCP and daemon version mismatch in status output", async () => {
      mockSendDaemonCommand.mockResolvedValueOnce({
        ok: true,
        data: {
          overview: { daemon: "running", health: "ok", version: "0.1.0-alpha.529", mode: "production" },
          workers: [],
          senses: [],
        },
      })
      vi.mocked(fs.readFileSync).mockImplementation((p) => {
        if (String(p).endsWith("package.json")) return JSON.stringify({ version: "0.1.0-alpha.528" })
        return ""
      })

      const { handleAgentStatus } = await import("../../../heart/daemon/agent-service")
      const r = await handleAgentStatus({ agent: "test", friendId: "f1", socketPath: "/tmp/test-daemon.sock" })

      expect(r.message).toContain("versionMismatch=mcp:0.1.0-alpha.528,daemon:0.1.0-alpha.529")
    })

    it("surfaces daemon status command failures with MCP version context", async () => {
      mockSendDaemonCommand
        .mockResolvedValueOnce({ ok: false, error: "socket rejected" })
        .mockResolvedValueOnce({ ok: false, message: "daemon busy" })
        .mockResolvedValueOnce({ ok: false })
        .mockResolvedValueOnce({ ok: false, error: "" })
      vi.mocked(fs.readFileSync).mockImplementation((p) => {
        if (String(p).endsWith("package.json")) return JSON.stringify({ version: "0.1.0-alpha.529" })
        return ""
      })

      const { handleAgentStatus } = await import("../../../heart/daemon/agent-service")
      const errorStatus = await handleAgentStatus({ agent: "test", friendId: "f1", socketPath: "/tmp/test-daemon.sock" })
      const messageStatus = await handleAgentStatus({ agent: "test", friendId: "f1", socketPath: "/tmp/test-daemon.sock" })
      const defaultStatus = await handleAgentStatus({ agent: "test", friendId: "f1", socketPath: "/tmp/test-daemon.sock" })
      const blankErrorStatus = await handleAgentStatus({ agent: "test", friendId: "f1", socketPath: "/tmp/test-daemon.sock" })

      expect(errorStatus.message).toContain("daemon=unreachable\terror=socket rejected")
      expect(errorStatus.message).toContain("mcpVersion=0.1.0-alpha.529")
      expect(messageStatus.message).toContain("daemon=unreachable\terror=daemon busy")
      expect(defaultStatus.message).toContain("daemon=unreachable\terror=daemon status did not answer cleanly")
      expect(blankErrorStatus.message).toContain("daemon=unreachable\nmcpVersion=0.1.0-alpha.529")
    })

    it("keeps malformed runtime rows out while rendering degraded and disabled sense proof details", async () => {
      mockSendDaemonCommand.mockResolvedValueOnce({
        ok: true,
        data: {
          overview: { daemon: "running", health: "degraded" },
          workers: [
            { agent: "test", worker: "inner-dialog", status: "running" },
            { agent: "test", worker: "ignored-missing-status" },
            "not a worker row",
          ],
          senses: [
            {
              agent: "test",
              sense: "bluebubbles",
              enabled: false,
              status: "error",
              detail: "disabled by config",
              proofMethod: "bluebubbles.checkHealth",
              lastProofAt: "2026-04-29T21:05:52.423Z",
              proofAgeMs: 456,
              pendingRecoveryCount: 2,
              failedRecoveryCount: 1,
              failureLayer: "probe",
              lastFailure: "health check failed",
              recoveryAction: "restart",
            },
            { agent: "test", sense: "ignored-missing-enabled", status: "running" },
            ["not a sense row"],
          ],
        },
      })

      const { handleAgentStatus } = await import("../../../heart/daemon/agent-service")
      const r = await handleAgentStatus({ agent: "test", friendId: "f1", socketPath: "/tmp/test-daemon.sock" })

      expect(r.message).toContain("daemon=running\thealth=degraded")
      expect(r.message).toContain("worker=inner-dialog:running")
      expect(r.message).not.toContain("ignored-missing-status")
      expect(r.message).toContain("sense=bluebubbles:disabled")
      expect(r.message).toContain("failureLayer=probe")
      expect(r.message).toContain("lastFailure=health check failed")
      expect(r.message).toContain("recovery=restart")
      expect(r.message).not.toContain("ignored-missing-enabled")
    })

    it("defaults incomplete daemon overview labels and omits absent optional sense detail", async () => {
      mockSendDaemonCommand.mockResolvedValueOnce({
        ok: true,
        data: {
          overview: {},
          workers: [],
          senses: [
            { agent: "test", sense: "mail", enabled: true, status: "running" },
          ],
        },
      })

      const { handleAgentStatus } = await import("../../../heart/daemon/agent-service")
      const r = await handleAgentStatus({ agent: "test", friendId: "f1", socketPath: "/tmp/test-daemon.sock" })

      expect(r.message).toContain("daemon=unknown\thealth=unknown")
      expect(r.message).toContain("sense=mail:running")
      expect(r.message).not.toContain("detail=")
    })

    it("treats non-array worker and sense payloads as empty", async () => {
      mockSendDaemonCommand.mockResolvedValueOnce({
        ok: true,
        data: {
          overview: { daemon: "running", health: "ok" },
          workers: "not workers",
          senses: { not: "senses" },
        },
      })

      const { handleAgentStatus } = await import("../../../heart/daemon/agent-service")
      const r = await handleAgentStatus({ agent: "test", friendId: "f1", socketPath: "/tmp/test-daemon.sock" })

      expect(r.message).toContain("daemon=running\thealth=ok")
      expect(r.message).not.toContain("worker=")
      expect(r.message).not.toContain("sense=")
    })

    it("renders MCP version alone when daemon returns an empty runtime shape", async () => {
      mockSendDaemonCommand.mockResolvedValueOnce({
        ok: true,
        data: { workers: [], senses: [] },
      })
      vi.mocked(fs.readFileSync).mockImplementation((p) => {
        if (String(p).endsWith("package.json")) return JSON.stringify({ version: "0.1.0-alpha.529" })
        return ""
      })

      const { handleAgentStatus } = await import("../../../heart/daemon/agent-service")
      const r = await handleAgentStatus({ agent: "test", friendId: "f1", socketPath: "/tmp/test-daemon.sock" })

      expect(r.message).toContain("mcpVersion=0.1.0-alpha.529")
    })

    it("records non-Error daemon transport failures as explicit unreachability", async () => {
      mockSendDaemonCommand.mockRejectedValueOnce("transport closed")

      const { handleAgentStatus } = await import("../../../heart/daemon/agent-service")
      const r = await handleAgentStatus({ agent: "test", friendId: "f1", socketPath: "/tmp/test-daemon.sock" })

      expect(r.message).toContain("daemon=unreachable\terror=transport closed")
    })

    it("can skip runtime probing when an explicit empty socket path is supplied", async () => {
      vi.mocked(fs.readFileSync).mockImplementation((p) => {
        if (String(p).endsWith("package.json")) return JSON.stringify({ version: "0.1.0-alpha.529" })
        return ""
      })

      const { handleAgentStatus } = await import("../../../heart/daemon/agent-service")
      const r = await handleAgentStatus({ agent: "test", friendId: "f1", socketPath: "" })

      expect(mockSendDaemonCommand).not.toHaveBeenCalled()
      expect(r.message).toContain("mcpVersion=0.1.0-alpha.529")
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

    it("delegates to searchDiaryEntries (same as search_notes tool)", async () => {
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
      expect(r.message).toContain("No relevant notes found")
    })
  })

  describe("handleAgentSearchNotes", () => {
    it("returns error when query is missing", async () => {
      const { handleAgentSearchNotes } = await import("../../../heart/daemon/agent-service")
      const r = await handleAgentSearchNotes({ agent: "test", friendId: "f1" })
      expect(r.ok).toBe(false)
    })

    it("formats results like the search_notes tool ([diary] prefix)", async () => {
      vi.mocked(searchDiaryEntries).mockResolvedValue([
        { id: "1", text: "MCP server bridge", source: "tool:diary_write", createdAt: "2026-03-26", embedding: [] },
      ])
      const { handleAgentSearchNotes } = await import("../../../heart/daemon/agent-service")
      const r = await handleAgentSearchNotes({ agent: "test", friendId: "f1", query: "MCP" })
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
      expect((r.data as Record<string, unknown>).noteSummary).toContain("fact one")
      expect((r.data as Record<string, unknown>).noteSummary).toContain("fact two")
    })

    it("returns no-match message when query finds nothing", async () => {
      vi.mocked(searchDiaryEntries).mockResolvedValue([])
      const { handleAgentGetContext } = await import("../../../heart/daemon/agent-service")
      const r = await handleAgentGetContext({ agent: "test", friendId: "f1", question: "nonexistent" })
      expect((r.data as Record<string, unknown>).noteSummary).toContain("No relevant notes")
    })

    it("uses searchDiaryEntries when query is provided", async () => {
      vi.mocked(searchDiaryEntries).mockResolvedValue([
        { id: "1", text: "relevant", source: "test", createdAt: "2026-01-01", embedding: [] },
      ])
      const { handleAgentGetContext } = await import("../../../heart/daemon/agent-service")
      const r = await handleAgentGetContext({ agent: "test", friendId: "f1", query: "context" })
      expect((r.data as Record<string, unknown>).noteSummary).toContain("relevant")
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
