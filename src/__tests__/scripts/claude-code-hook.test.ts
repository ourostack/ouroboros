import { describe, it, expect, vi, beforeEach } from "vitest"
import { emitNervesEvent } from "../../nerves/runtime"

// ── Mocks ──────────────────────────────────────────────────────

const mockSendDaemonCommand = vi.fn()
const mockCheckDaemonSocketAlive = vi.fn()

vi.mock("../../heart/daemon/socket-client", () => ({
  sendDaemonCommand: (...args: any[]) => mockSendDaemonCommand(...args),
  checkDaemonSocketAlive: (...args: any[]) => mockCheckDaemonSocketAlive(...args),
  DEFAULT_DAEMON_SOCKET_PATH: "/tmp/ouroboros-daemon.sock",
}))

const mockDrainPending = vi.fn().mockReturnValue([])
const mockGetPendingDir = vi.fn().mockReturnValue("/tmp/pending")
const mockHasPendingMessages = vi.fn().mockReturnValue(false)

vi.mock("../../mind/pending", () => ({
  drainPending: (...args: any[]) => mockDrainPending(...args),
  getPendingDir: (...args: any[]) => mockGetPendingDir(...args),
  hasPendingMessages: (...args: any[]) => mockHasPendingMessages(...args),
}))

// ── Tests ──────────────────────────────────────────────────────

describe("claude-code-hook (lifecycle events)", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.resetModules()
    mockSendDaemonCommand.mockResolvedValue({ ok: true })
    mockCheckDaemonSocketAlive.mockResolvedValue(true)
    emitNervesEvent({
      component: "daemon",
      event: "daemon.hook_test_start",
      message: "claude code hook test",
      meta: {},
    })
  })

  it("exports handleHookEvent function", async () => {
    const mod = await import("../../scripts/claude-code-hook")
    expect(typeof mod.handleHookEvent).toBe("function")
  })

  it("sends SessionStart event to daemon", async () => {
    const { handleHookEvent } = await import("../../scripts/claude-code-hook")
    const result = await handleHookEvent({
      event: "SessionStart",
      sessionId: "sess-123",
    })
    expect(mockSendDaemonCommand).toHaveBeenCalled()
    expect(result.exitCode).toBe(0)
  })

  it("sends Stop event to daemon", async () => {
    const { handleHookEvent } = await import("../../scripts/claude-code-hook")
    const result = await handleHookEvent({
      event: "Stop",
      sessionId: "sess-123",
    })
    expect(mockSendDaemonCommand).toHaveBeenCalled()
    expect(result.exitCode).toBe(0)
  })

  it("sends PostToolUse event to daemon", async () => {
    const { handleHookEvent } = await import("../../scripts/claude-code-hook")
    const result = await handleHookEvent({
      event: "PostToolUse",
      sessionId: "sess-123",
      toolName: "Read",
    })
    expect(mockSendDaemonCommand).toHaveBeenCalled()
    expect(result.exitCode).toBe(0)
  })

  it("exits 0 when daemon is unavailable", async () => {
    mockSendDaemonCommand.mockRejectedValue(new Error("connection refused"))
    const { handleHookEvent } = await import("../../scripts/claude-code-hook")
    const result = await handleHookEvent({
      event: "SessionStart",
      sessionId: "sess-123",
    })
    // Should not throw, should exit 0
    expect(result.exitCode).toBe(0)
  })

  it("handles unknown event gracefully", async () => {
    const { handleHookEvent } = await import("../../scripts/claude-code-hook")
    const result = await handleHookEvent({
      event: "UnknownEvent",
      sessionId: "sess-123",
    })
    expect(result.exitCode).toBe(0)
  })
})

describe("claude-code-stop-hook (pending message check)", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.resetModules()
    emitNervesEvent({
      component: "daemon",
      event: "daemon.stop_hook_test_start",
      message: "claude code stop hook test",
      meta: {},
    })
  })

  it("exports handleStopHook function", async () => {
    const mod = await import("../../scripts/claude-code-stop-hook")
    expect(typeof mod.handleStopHook).toBe("function")
  })

  it("returns empty additionalContext when no pending messages", async () => {
    mockHasPendingMessages.mockReturnValue(false)
    mockDrainPending.mockReturnValue([])
    const { handleStopHook } = await import("../../scripts/claude-code-stop-hook")
    const result = await handleStopHook({ agentName: "test-agent", friendId: "friend-1", sessionId: "sess-123" })
    expect(result.additionalContext).toBe("")
  })

  it("returns pending messages as additionalContext when present", async () => {
    mockHasPendingMessages.mockReturnValue(true)
    mockDrainPending.mockReturnValue([
      { from: "agent", content: "I have an update for you", timestamp: Date.now() },
    ])
    const { handleStopHook } = await import("../../scripts/claude-code-stop-hook")
    const result = await handleStopHook({ agentName: "test-agent", friendId: "friend-1", sessionId: "sess-123" })
    expect(result.additionalContext).toContain("I have an update for you")
  })

  it("returns multiple pending messages concatenated", async () => {
    mockHasPendingMessages.mockReturnValue(true)
    mockDrainPending.mockReturnValue([
      { from: "agent", content: "Message one", timestamp: Date.now() },
      { from: "agent", content: "Message two", timestamp: Date.now() },
    ])
    const { handleStopHook } = await import("../../scripts/claude-code-stop-hook")
    const result = await handleStopHook({ agentName: "test-agent", friendId: "friend-1", sessionId: "sess-123" })
    expect(result.additionalContext).toContain("Message one")
    expect(result.additionalContext).toContain("Message two")
  })

  it("handles errors gracefully (returns empty)", async () => {
    mockDrainPending.mockImplementation(() => { throw new Error("boom") })
    const { handleStopHook } = await import("../../scripts/claude-code-stop-hook")
    const result = await handleStopHook({ agentName: "test-agent", friendId: "friend-1", sessionId: "sess-123" })
    expect(result.additionalContext).toBe("")
  })
})
