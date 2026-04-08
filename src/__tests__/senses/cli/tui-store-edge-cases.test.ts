import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("../../../heart/identity", () => ({
  getAgentName: vi.fn(() => "testagent"),
  getAgentSecretsPath: vi.fn(() => "/tmp/.agentsecrets/testagent/secrets.json"),
  resetAgentConfigCache: vi.fn(),
  loadAgentConfig: vi.fn(() => ({
    name: "testagent",
    configPath: "~/.agentsecrets/testagent/secrets.json",
    provider: "minimax",
    phrases: {
      thinking: ["pondering"],
      tool: ["working"],
      followup: ["continuing"],
    },
  })),
}))

// Hard-mock the daemon socket client. The runtime guard in socket-client.ts
// already prevents real socket calls under vitest (by detecting process.argv),
// but the explicit mock lets tests that care assert on call counts and avoids
// the per-file allowlist in test-isolation.contract.test.ts.
vi.mock("../../../heart/daemon/socket-client", () => ({
  DEFAULT_DAEMON_SOCKET_PATH: "/tmp/ouroboros-test-mock.sock",
  sendDaemonCommand: vi.fn().mockResolvedValue({ ok: true }),
  checkDaemonSocketAlive: vi.fn().mockResolvedValue(false),
  requestInnerWake: vi.fn().mockResolvedValue(null),
}))

import { TuiStore } from "../../../senses/cli/tui-store"

describe("TuiStore edge cases", () => {
  let store: TuiStore

  beforeEach(() => {
    store = new TuiStore()
  })

  // ─── Long streaming text followed by tool start ─────────────────
  describe("streaming-to-tool transition", () => {
    it("commits buffered streaming text to completed before showing tool", () => {
      store.modelStart()
      store.appendText("Part one of the response.")
      store.appendText(" Part two.")
      // Now a tool starts — the buffered text should be committed
      store.toolStart("shell", { command: "ls" })

      const completed = store.completedMessages
      // The streaming text should have been committed to completed
      expect(completed.some(m =>
        m.role === "assistant" && m.content.includes("Part one of the response. Part two."),
      )).toBe(true)
      // Live streaming text should be cleared
      expect(store.live.streamingText).toBe("")
    })

    it("does not commit empty streaming text on tool start", () => {
      store.modelStart()
      // No text appended, just go straight to tool
      store.toolStart("shell", { command: "ls" })

      const completed = store.completedMessages
      // Should not have any assistant messages with empty content
      expect(completed.filter(m => m.role === "assistant")).toHaveLength(0)
    })

    it("does not commit whitespace-only streaming text on tool start", () => {
      store.modelStart()
      store.appendText("   \n  ")
      store.toolStart("shell", { command: "ls" })

      const completed = store.completedMessages
      expect(completed.filter(m => m.role === "assistant")).toHaveLength(0)
    })

    it("handles rapid tool start/end cycles without losing text", () => {
      store.modelStart()
      store.appendText("Before tools.")
      store.toolStart("shell", { command: "ls" })
      store.toolEnd("shell", "ls", true)
      store.appendText("Between tools.")
      store.toolStart("read_file", { path: "/foo" })
      store.toolEnd("read_file", "/foo", true)

      const completed = store.completedMessages
      const assistantMsgs = completed.filter(m => m.role === "assistant")
      const toolMsgs = completed.filter(m => m.role === "tool")

      // First text committed when first tool started
      expect(assistantMsgs.some(m => m.content.includes("Before tools."))).toBe(true)
      // Between-tools text committed when second tool started
      expect(assistantMsgs.some(m => m.content.includes("Between tools."))).toBe(true)
      // Both tool results present
      expect(toolMsgs).toHaveLength(2)
    })
  })

  // ─── Input history edge cases ──────────────────────────────────
  describe("input history", () => {
    it("seedHistory does not add to completed messages (display only)", () => {
      store.seedHistory(["prev1", "prev2"])
      expect(store.completedMessages).toHaveLength(0)
      expect(store.inputHistory).toEqual(["prev1", "prev2"])
    })

    it("seedHistory combined with addUserMessage preserves order", () => {
      store.seedHistory(["old1", "old2"])
      store.addUserMessage("new message")
      expect(store.inputHistory).toEqual(["old1", "old2", "new message"])
    })

    it("seedHistory with empty array is a no-op", () => {
      store.seedHistory([])
      expect(store.inputHistory).toHaveLength(0)
    })
  })

  // ─── commitAssistantMessage edge cases ─────────────────────────
  describe("commitAssistantMessage", () => {
    it("does not create empty completed message when no text buffered", () => {
      store.commitAssistantMessage()
      expect(store.completedMessages.filter(m => m.role === "assistant")).toHaveLength(0)
    })

    it("trims whitespace from committed text", () => {
      store.modelStart()
      store.appendText("  hello world  \n  ")
      store.commitAssistantMessage()

      const msgs = store.completedMessages.filter(m => m.role === "assistant")
      expect(msgs).toHaveLength(1)
      expect(msgs[0].content).toBe("hello world")
    })

    it("clears all live state after commit", () => {
      store.modelStart()
      store.appendText("response text")
      store.commitAssistantMessage()

      expect(store.live.streamingText).toBe("")
      expect(store.live.loading).toBe(false)
      expect(store.live.activeTool).toBeNull()
      expect(store.live.errorMessage).toBeNull()
      expect(store.live.kickMessage).toBeNull()
    })

    it("double commit does not duplicate messages", () => {
      store.modelStart()
      store.appendText("once only")
      store.commitAssistantMessage()
      store.commitAssistantMessage()

      const msgs = store.completedMessages.filter(m => m.role === "assistant")
      expect(msgs).toHaveLength(1)
    })
  })

  // ─── Input suppression ─────────────────────────────────────────
  describe("input suppression", () => {
    it("suppressInput sets inputSuppressed to true", () => {
      store.suppressInput()
      expect(store.live.inputSuppressed).toBe(true)
    })

    it("restoreInput sets inputSuppressed to false", () => {
      store.suppressInput()
      store.restoreInput()
      expect(store.live.inputSuppressed).toBe(false)
    })

    it("multiple suppress calls are idempotent", () => {
      store.suppressInput()
      store.suppressInput()
      expect(store.live.inputSuppressed).toBe(true)
      store.restoreInput()
      expect(store.live.inputSuppressed).toBe(false)
    })
  })

  // ─── Elapsed time edge cases ───────────────────────────────────
  describe("getElapsed", () => {
    it("returns 0 when not loading", () => {
      expect(store.getElapsed()).toBe(0)
    })

    it("returns 0 when loading just started (sub-second)", () => {
      store.modelStart()
      expect(store.getElapsed()).toBe(0)
    })
  })

  // ─── Subscriber notification edge cases ────────────────────────
  describe("subscriber notification", () => {
    it("notifies on every state-changing operation", () => {
      const listener = vi.fn()
      store.subscribe(listener)

      store.modelStart()
      store.appendText("text")
      store.toolStart("shell", { command: "ls" })
      store.toolEnd("shell", "ls", true)
      store.setError("err")
      store.setKick()
      store.suppressInput()
      store.restoreInput()
      store.commitAssistantMessage()
      store.addUserMessage("hi")
      store.clearText()

      expect(listener).toHaveBeenCalledTimes(11)
    })

    it("unsubscribe prevents further notifications", () => {
      const listener = vi.fn()
      const unsub = store.subscribe(listener)
      store.modelStart()
      expect(listener).toHaveBeenCalledTimes(1)
      unsub()
      store.appendText("text")
      expect(listener).toHaveBeenCalledTimes(1)
    })
  })

  // ─── headerShown flag ──────────────────────────────────────────
  describe("headerShown", () => {
    it("starts as false", () => {
      expect(store.headerShown).toBe(false)
    })
  })
})
