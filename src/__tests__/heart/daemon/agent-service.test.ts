import { describe, it, expect, vi, beforeEach } from "vitest"
import { emitNervesEvent } from "../../../nerves/runtime"

// Mock fs
vi.mock("fs", () => ({
  existsSync: vi.fn(() => false),
  readFileSync: vi.fn(() => ""),
  readdirSync: vi.fn(() => []),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
}))

// Mock identity
vi.mock("../../../heart/identity", () => ({
  getAgentRoot: vi.fn(() => "/mock/agent-root"),
  getAgentStateRoot: vi.fn(() => "/mock/agent-root/state"),
  getAgentName: vi.fn(() => "test-agent"),
  getRepoRoot: vi.fn(() => "/mock/repo"),
}))

import * as fs from "fs"

describe("agent-service", () => {
  beforeEach(() => {
    vi.mocked(fs.existsSync).mockReset()
    vi.mocked(fs.readFileSync).mockReset()
    vi.mocked(fs.readdirSync).mockReset()

    emitNervesEvent({
      component: "daemon",
      event: "daemon.agent_service_test_start",
      message: "agent service test starting",
      meta: {},
    })
  })

  describe("handleAgentStatus", () => {
    it("returns status with agent name", async () => {
      const { handleAgentStatus } = await import("../../../heart/daemon/agent-service")
      const result = await handleAgentStatus({ agent: "test-agent", friendId: "friend-1" })

      expect(result.ok).toBe(true)
      expect(result.data).toBeDefined()
      const data = result.data as Record<string, unknown>
      expect(data.agent).toBe("test-agent")
      expect(data.status).toBeDefined()

      emitNervesEvent({
        component: "daemon",
        event: "daemon.agent_service_test_end",
        message: "handleAgentStatus test complete",
        meta: {},
      })
    })

    it("reads memory and session files when they exist on disk", async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true)
      vi.mocked(fs.readFileSync).mockReturnValue("# Agent Memory\nSome content here\n")
      vi.mocked(fs.readdirSync).mockReturnValue(["session-1.json", "session-2.json", "notes.txt"] as unknown as ReturnType<typeof fs.readdirSync>)

      const { handleAgentStatus } = await import("../../../heart/daemon/agent-service")
      const result = await handleAgentStatus({ agent: "test-agent", friendId: "friend-1" })

      expect(result.ok).toBe(true)
      const data = result.data as Record<string, unknown>
      expect(data.hasMemory).toBe(true)
      // readdirSync filters to .json/.jsonl/.md — "notes.txt" is excluded
      expect(data.sessionCount).toBe(2)

      emitNervesEvent({
        component: "daemon",
        event: "daemon.agent_service_test_end",
        message: "handleAgentStatus with files test complete",
        meta: {},
      })
    })

    it("falls back to psyche/memory/facts.jsonl when MEMORY.md does not exist", async () => {
      // First call (MEMORY.md) -> not found, second call (facts.jsonl) -> found
      vi.mocked(fs.existsSync).mockImplementation((p) => {
        const pathStr = String(p)
        if (pathStr.includes("MEMORY.md")) return false
        if (pathStr.includes("facts.jsonl")) return true
        // sessions dir exists
        return true
      })
      vi.mocked(fs.readFileSync).mockReturnValue("psyche memory facts content\n")
      vi.mocked(fs.readdirSync).mockReturnValue([] as unknown as ReturnType<typeof fs.readdirSync>)

      const { handleAgentStatus } = await import("../../../heart/daemon/agent-service")
      const result = await handleAgentStatus({ agent: "test-agent", friendId: "friend-1" })

      expect(result.ok).toBe(true)
      const data = result.data as Record<string, unknown>
      expect(data.hasMemory).toBe(true)

      emitNervesEvent({
        component: "daemon",
        event: "daemon.agent_service_test_end",
        message: "handleAgentStatus fallback memory test complete",
        meta: {},
      })
    })
  })

  describe("handleAgentAsk", () => {
    it("returns a response for a question", async () => {
      const { handleAgentAsk } = await import("../../../heart/daemon/agent-service")
      const result = await handleAgentAsk({
        agent: "test-agent",
        friendId: "friend-1",
        question: "What are you working on?",
      })

      expect(result.ok).toBe(true)
      expect(result.message).toBeDefined()

      emitNervesEvent({
        component: "daemon",
        event: "daemon.agent_service_test_end",
        message: "handleAgentAsk test complete",
        meta: {},
      })
    })

    it("returns memory-based answer when memory file exists", async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true)
      vi.mocked(fs.readFileSync).mockReturnValue("# Memory\nI work on deployment automation.\n")

      const { handleAgentAsk } = await import("../../../heart/daemon/agent-service")
      const result = await handleAgentAsk({
        agent: "test-agent",
        friendId: "friend-1",
        question: "What do you work on?",
      })

      expect(result.ok).toBe(true)
      expect(result.message).toContain("Based on agent memory")
      expect(result.message).toContain("deployment automation")

      emitNervesEvent({
        component: "daemon",
        event: "daemon.agent_service_test_end",
        message: "handleAgentAsk with memory test complete",
        meta: {},
      })
    })

    it("returns error when question is missing", async () => {
      const { handleAgentAsk } = await import("../../../heart/daemon/agent-service")
      const result = await handleAgentAsk({
        agent: "test-agent",
        friendId: "friend-1",
      })

      expect(result.ok).toBe(false)
      expect(result.error).toContain("question")

      emitNervesEvent({
        component: "daemon",
        event: "daemon.agent_service_test_end",
        message: "handleAgentAsk missing question test complete",
        meta: {},
      })
    })
  })

  describe("handleAgentCatchup", () => {
    it("returns catchup summary", async () => {
      const { handleAgentCatchup } = await import("../../../heart/daemon/agent-service")
      const result = await handleAgentCatchup({ agent: "test-agent", friendId: "friend-1" })

      expect(result.ok).toBe(true)
      expect(result.message).toBeDefined()

      emitNervesEvent({
        component: "daemon",
        event: "daemon.agent_service_test_end",
        message: "handleAgentCatchup test complete",
        meta: {},
      })
    })

    it("reports recent sessions when session files exist", async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true)
      vi.mocked(fs.readdirSync).mockReturnValue(["session-a.json", "session-b.json"] as unknown as ReturnType<typeof fs.readdirSync>)

      const { handleAgentCatchup } = await import("../../../heart/daemon/agent-service")
      const result = await handleAgentCatchup({ agent: "test-agent", friendId: "friend-1" })

      expect(result.ok).toBe(true)
      expect(result.message).toContain("Recent activity")
      expect(result.message).toContain("2 recent sessions")

      emitNervesEvent({
        component: "daemon",
        event: "daemon.agent_service_test_end",
        message: "handleAgentCatchup with sessions test complete",
        meta: {},
      })
    })
  })

  describe("handleAgentDelegate", () => {
    it("accepts a task delegation", async () => {
      const { handleAgentDelegate } = await import("../../../heart/daemon/agent-service")
      const result = await handleAgentDelegate({
        agent: "test-agent",
        friendId: "friend-1",
        task: "Fix the build",
        context: "CI is failing",
      })

      expect(result.ok).toBe(true)
      expect(result.message).toContain("delegate")

      emitNervesEvent({
        component: "daemon",
        event: "daemon.agent_service_test_end",
        message: "handleAgentDelegate test complete",
        meta: {},
      })
    })

    it("returns error when task is missing", async () => {
      const { handleAgentDelegate } = await import("../../../heart/daemon/agent-service")
      const result = await handleAgentDelegate({
        agent: "test-agent",
        friendId: "friend-1",
      })

      expect(result.ok).toBe(false)
      expect(result.error).toContain("task")

      emitNervesEvent({
        component: "daemon",
        event: "daemon.agent_service_test_end",
        message: "handleAgentDelegate missing task test complete",
        meta: {},
      })
    })
  })

  describe("handleAgentGetContext", () => {
    it("returns current context", async () => {
      const { handleAgentGetContext } = await import("../../../heart/daemon/agent-service")
      const result = await handleAgentGetContext({ agent: "test-agent", friendId: "friend-1" })

      expect(result.ok).toBe(true)
      expect(result.data).toBeDefined()

      emitNervesEvent({
        component: "daemon",
        event: "daemon.agent_service_test_end",
        message: "handleAgentGetContext test complete",
        meta: {},
      })
    })

    it("includes memory summary when memory file exists", async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true)
      vi.mocked(fs.readFileSync).mockReturnValue("# Memory\nAgent context details here\n")
      vi.mocked(fs.readdirSync).mockReturnValue(["task-1.json"] as unknown as ReturnType<typeof fs.readdirSync>)

      const { handleAgentGetContext } = await import("../../../heart/daemon/agent-service")
      const result = await handleAgentGetContext({ agent: "test-agent", friendId: "friend-1" })

      expect(result.ok).toBe(true)
      const data = result.data as Record<string, unknown>
      expect(data.hasMemory).toBe(true)
      expect(data.memorySummary).toContain("Agent context details")
      expect(data.taskCount).toBe(1)

      emitNervesEvent({
        component: "daemon",
        event: "daemon.agent_service_test_end",
        message: "handleAgentGetContext with memory test complete",
        meta: {},
      })
    })
  })

  describe("handleAgentSearchMemory", () => {
    it("searches memory with a query", async () => {
      const { handleAgentSearchMemory } = await import("../../../heart/daemon/agent-service")
      const result = await handleAgentSearchMemory({
        agent: "test-agent",
        friendId: "friend-1",
        query: "deployment process",
      })

      expect(result.ok).toBe(true)
      expect(result.data).toBeDefined()

      emitNervesEvent({
        component: "daemon",
        event: "daemon.agent_service_test_end",
        message: "handleAgentSearchMemory test complete",
        meta: {},
      })
    })

    it("returns matching lines when memory file exists", async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true)
      vi.mocked(fs.readFileSync).mockReturnValue(
        "# Memory\nDeployment process uses Docker\nTesting requires node 20\nDeployment schedule is weekly\n",
      )

      const { handleAgentSearchMemory } = await import("../../../heart/daemon/agent-service")
      const result = await handleAgentSearchMemory({
        agent: "test-agent",
        friendId: "friend-1",
        query: "deployment",
      })

      expect(result.ok).toBe(true)
      const data = result.data as { matches: string[] }
      expect(data.matches.length).toBe(2)
      expect(data.matches[0]).toContain("Deployment process")
      expect(data.matches[1]).toContain("Deployment schedule")

      emitNervesEvent({
        component: "daemon",
        event: "daemon.agent_service_test_end",
        message: "handleAgentSearchMemory with matches test complete",
        meta: {},
      })
    })

    it("returns error when query is missing", async () => {
      const { handleAgentSearchMemory } = await import("../../../heart/daemon/agent-service")
      const result = await handleAgentSearchMemory({
        agent: "test-agent",
        friendId: "friend-1",
      })

      expect(result.ok).toBe(false)
      expect(result.error).toContain("query")

      emitNervesEvent({
        component: "daemon",
        event: "daemon.agent_service_test_end",
        message: "handleAgentSearchMemory missing query test complete",
        meta: {},
      })
    })
  })

  describe("handleAgentGetTask", () => {
    it("returns current task info", async () => {
      const { handleAgentGetTask } = await import("../../../heart/daemon/agent-service")
      const result = await handleAgentGetTask({ agent: "test-agent", friendId: "friend-1" })

      expect(result.ok).toBe(true)

      emitNervesEvent({
        component: "daemon",
        event: "daemon.agent_service_test_end",
        message: "handleAgentGetTask test complete",
        meta: {},
      })
    })

    it("lists task files when they exist on disk", async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true)
      vi.mocked(fs.readdirSync).mockReturnValue(["fix-build.json", "deploy.md", "notes.txt"] as unknown as ReturnType<typeof fs.readdirSync>)

      const { handleAgentGetTask } = await import("../../../heart/daemon/agent-service")
      const result = await handleAgentGetTask({ agent: "test-agent", friendId: "friend-1" })

      expect(result.ok).toBe(true)
      expect(result.message).toContain("Current tasks")
      expect(result.message).toContain("fix-build.json")
      expect(result.message).toContain("deploy.md")

      emitNervesEvent({
        component: "daemon",
        event: "daemon.agent_service_test_end",
        message: "handleAgentGetTask with files test complete",
        meta: {},
      })
    })
  })

  describe("handleAgentCheckScope", () => {
    it("checks if item is in scope", async () => {
      const { handleAgentCheckScope } = await import("../../../heart/daemon/agent-service")
      const result = await handleAgentCheckScope({
        agent: "test-agent",
        friendId: "friend-1",
        item: "add error handling to the API",
      })

      expect(result.ok).toBe(true)
      expect(result.data).toBeDefined()

      emitNervesEvent({
        component: "daemon",
        event: "daemon.agent_service_test_end",
        message: "handleAgentCheckScope test complete",
        meta: {},
      })
    })

    it("returns error when item is missing", async () => {
      const { handleAgentCheckScope } = await import("../../../heart/daemon/agent-service")
      const result = await handleAgentCheckScope({
        agent: "test-agent",
        friendId: "friend-1",
      })

      expect(result.ok).toBe(false)
      expect(result.error).toContain("item")

      emitNervesEvent({
        component: "daemon",
        event: "daemon.agent_service_test_end",
        message: "handleAgentCheckScope missing item test complete",
        meta: {},
      })
    })
  })

  describe("handleAgentRequestDecision", () => {
    it("accepts a decision request", async () => {
      const { handleAgentRequestDecision } = await import("../../../heart/daemon/agent-service")
      const result = await handleAgentRequestDecision({
        agent: "test-agent",
        friendId: "friend-1",
        topic: "Should we use REST or GraphQL?",
        options: ["REST", "GraphQL"],
      })

      expect(result.ok).toBe(true)

      emitNervesEvent({
        component: "daemon",
        event: "daemon.agent_service_test_end",
        message: "handleAgentRequestDecision test complete",
        meta: {},
      })
    })

    it("returns error when topic is missing", async () => {
      const { handleAgentRequestDecision } = await import("../../../heart/daemon/agent-service")
      const result = await handleAgentRequestDecision({
        agent: "test-agent",
        friendId: "friend-1",
      })

      expect(result.ok).toBe(false)
      expect(result.error).toContain("topic")

      emitNervesEvent({
        component: "daemon",
        event: "daemon.agent_service_test_end",
        message: "handleAgentRequestDecision missing topic test complete",
        meta: {},
      })
    })
  })

  describe("handleAgentCheckGuidance", () => {
    it("returns guidance for a topic", async () => {
      const { handleAgentCheckGuidance } = await import("../../../heart/daemon/agent-service")
      const result = await handleAgentCheckGuidance({
        agent: "test-agent",
        friendId: "friend-1",
        topic: "error handling patterns",
      })

      expect(result.ok).toBe(true)

      emitNervesEvent({
        component: "daemon",
        event: "daemon.agent_service_test_end",
        message: "handleAgentCheckGuidance test complete",
        meta: {},
      })
    })

    it("returns relevant guidance when memory contains matching lines", async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true)
      vi.mocked(fs.readFileSync).mockReturnValue(
        "# Guidance\nError handling: always use try-catch\nLogging: use structured logs\nError handling: wrap async calls\n",
      )

      const { handleAgentCheckGuidance } = await import("../../../heart/daemon/agent-service")
      const result = await handleAgentCheckGuidance({
        agent: "test-agent",
        friendId: "friend-1",
        topic: "error handling",
      })

      expect(result.ok).toBe(true)
      expect(result.message).toContain("Relevant guidance:")
      expect(result.message).toContain("always use try-catch")

      emitNervesEvent({
        component: "daemon",
        event: "daemon.agent_service_test_end",
        message: "handleAgentCheckGuidance with memory test complete",
        meta: {},
      })
    })

    it("returns no guidance when memory exists but has no matching lines", async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true)
      vi.mocked(fs.readFileSync).mockReturnValue(
        "# Memory\nDeployment process uses Docker\nTesting requires node 20\n",
      )

      const { handleAgentCheckGuidance } = await import("../../../heart/daemon/agent-service")
      const result = await handleAgentCheckGuidance({
        agent: "test-agent",
        friendId: "friend-1",
        topic: "kubernetes",
      })

      expect(result.ok).toBe(true)
      expect(result.message).toContain("No specific guidance found for: kubernetes")

      emitNervesEvent({
        component: "daemon",
        event: "daemon.agent_service_test_end",
        message: "handleAgentCheckGuidance no match test complete",
        meta: {},
      })
    })

    it("returns error when topic is missing", async () => {
      const { handleAgentCheckGuidance } = await import("../../../heart/daemon/agent-service")
      const result = await handleAgentCheckGuidance({
        agent: "test-agent",
        friendId: "friend-1",
      })

      expect(result.ok).toBe(false)
      expect(result.error).toContain("topic")

      emitNervesEvent({
        component: "daemon",
        event: "daemon.agent_service_test_end",
        message: "handleAgentCheckGuidance missing topic test complete",
        meta: {},
      })
    })
  })

  describe("handleAgentReportProgress", () => {
    it("accepts progress report", async () => {
      const { handleAgentReportProgress } = await import("../../../heart/daemon/agent-service")
      const result = await handleAgentReportProgress({
        agent: "test-agent",
        friendId: "friend-1",
        summary: "Tests passing, 80% done",
      })

      expect(result.ok).toBe(true)

      emitNervesEvent({
        component: "daemon",
        event: "daemon.agent_service_test_end",
        message: "handleAgentReportProgress test complete",
        meta: {},
      })
    })

    it("returns error when summary is missing", async () => {
      const { handleAgentReportProgress } = await import("../../../heart/daemon/agent-service")
      const result = await handleAgentReportProgress({
        agent: "test-agent",
        friendId: "friend-1",
      })

      expect(result.ok).toBe(false)
      expect(result.error).toContain("summary")

      emitNervesEvent({
        component: "daemon",
        event: "daemon.agent_service_test_end",
        message: "handleAgentReportProgress missing summary test complete",
        meta: {},
      })
    })
  })

  describe("handleAgentReportBlocker", () => {
    it("accepts blocker report", async () => {
      const { handleAgentReportBlocker } = await import("../../../heart/daemon/agent-service")
      const result = await handleAgentReportBlocker({
        agent: "test-agent",
        friendId: "friend-1",
        blocker: "CI pipeline is down",
      })

      expect(result.ok).toBe(true)

      emitNervesEvent({
        component: "daemon",
        event: "daemon.agent_service_test_end",
        message: "handleAgentReportBlocker test complete",
        meta: {},
      })
    })

    it("returns error when blocker is missing", async () => {
      const { handleAgentReportBlocker } = await import("../../../heart/daemon/agent-service")
      const result = await handleAgentReportBlocker({
        agent: "test-agent",
        friendId: "friend-1",
      })

      expect(result.ok).toBe(false)
      expect(result.error).toContain("blocker")

      emitNervesEvent({
        component: "daemon",
        event: "daemon.agent_service_test_end",
        message: "handleAgentReportBlocker missing blocker test complete",
        meta: {},
      })
    })
  })

  describe("handleAgentReportComplete", () => {
    it("accepts completion report", async () => {
      const { handleAgentReportComplete } = await import("../../../heart/daemon/agent-service")
      const result = await handleAgentReportComplete({
        agent: "test-agent",
        friendId: "friend-1",
        summary: "All tests passing, PR created",
      })

      expect(result.ok).toBe(true)

      emitNervesEvent({
        component: "daemon",
        event: "daemon.agent_service_test_end",
        message: "handleAgentReportComplete test complete",
        meta: {},
      })
    })

    it("returns error when summary is missing", async () => {
      const { handleAgentReportComplete } = await import("../../../heart/daemon/agent-service")
      const result = await handleAgentReportComplete({
        agent: "test-agent",
        friendId: "friend-1",
      })

      expect(result.ok).toBe(false)
      expect(result.error).toContain("summary")

      emitNervesEvent({
        component: "daemon",
        event: "daemon.agent_service_test_end",
        message: "handleAgentReportComplete missing summary test complete",
        meta: {},
      })
    })
  })
})
