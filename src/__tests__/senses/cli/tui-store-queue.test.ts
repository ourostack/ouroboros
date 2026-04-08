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

describe("TuiStore queue methods", () => {
  let store: TuiStore

  beforeEach(() => {
    store = new TuiStore()
  })

  describe("queuedInputs getter", () => {
    it("starts empty", () => {
      expect(store.queuedInputs).toEqual([])
    })

    it("returns readonly array", () => {
      const q = store.queuedInputs
      expect(Array.isArray(q)).toBe(true)
    })
  })

  describe("enqueueInput", () => {
    it("adds item to queuedInputs", () => {
      store.enqueueInput("hello")
      expect(store.queuedInputs).toEqual(["hello"])
    })

    it("adds multiple items in order", () => {
      store.enqueueInput("first")
      store.enqueueInput("second")
      store.enqueueInput("third")
      expect(store.queuedInputs).toEqual(["first", "second", "third"])
    })

    it("notifies subscribers", () => {
      const listener = vi.fn()
      store.subscribe(listener)
      store.enqueueInput("hello")
      expect(listener).toHaveBeenCalledTimes(1)
    })
  })

  describe("dequeueInput", () => {
    it("removes first occurrence of text", () => {
      store.enqueueInput("a")
      store.enqueueInput("b")
      store.enqueueInput("a")
      store.dequeueInput("a")
      expect(store.queuedInputs).toEqual(["b", "a"])
    })

    it("is a no-op if text not found", () => {
      store.enqueueInput("a")
      store.dequeueInput("b")
      expect(store.queuedInputs).toEqual(["a"])
    })

    it("notifies subscribers even when no-op", () => {
      const listener = vi.fn()
      store.subscribe(listener)
      store.dequeueInput("missing")
      expect(listener).toHaveBeenCalledTimes(1)
    })

    it("notifies subscribers on removal", () => {
      store.enqueueInput("a")
      const listener = vi.fn()
      store.subscribe(listener)
      store.dequeueInput("a")
      expect(listener).toHaveBeenCalledTimes(1)
    })
  })

  describe("popAllQueuedForEditing", () => {
    it("returns all items and empties queue", () => {
      store.enqueueInput("x")
      store.enqueueInput("y")
      const result = store.popAllQueuedForEditing()
      expect(result).toEqual(["x", "y"])
      expect(store.queuedInputs).toEqual([])
    })

    it("returns empty array when queue is empty", () => {
      const result = store.popAllQueuedForEditing()
      expect(result).toEqual([])
    })

    it("notifies subscribers", () => {
      store.enqueueInput("z")
      const listener = vi.fn()
      store.subscribe(listener)
      store.popAllQueuedForEditing()
      expect(listener).toHaveBeenCalledTimes(1)
    })

    it("returns a copy, not the internal array", () => {
      store.enqueueInput("a")
      const result = store.popAllQueuedForEditing()
      result.push("mutated")
      expect(store.queuedInputs).toEqual([])
    })
  })

  describe("queue interaction with other store methods", () => {
    it("queue survives modelStart (not cleared by new turn)", () => {
      store.enqueueInput("pending message")
      store.modelStart()
      expect(store.queuedInputs).toEqual(["pending message"])
    })

    it("queue survives commitAssistantMessage", () => {
      store.enqueueInput("pending")
      store.modelStart()
      store.appendText("response")
      store.commitAssistantMessage()
      expect(store.queuedInputs).toEqual(["pending"])
    })

    it("enqueue and dequeue interleave correctly", () => {
      store.enqueueInput("a")
      store.enqueueInput("b")
      store.dequeueInput("a")
      store.enqueueInput("c")
      expect(store.queuedInputs).toEqual(["b", "c"])
    })

    it("dequeueInput with duplicates removes only first", () => {
      store.enqueueInput("dup")
      store.enqueueInput("dup")
      store.enqueueInput("dup")
      store.dequeueInput("dup")
      expect(store.queuedInputs).toEqual(["dup", "dup"])
    })

    it("popAllQueuedForEditing after partial dequeue returns remaining", () => {
      store.enqueueInput("a")
      store.enqueueInput("b")
      store.enqueueInput("c")
      store.dequeueInput("b")
      const popped = store.popAllQueuedForEditing()
      expect(popped).toEqual(["a", "c"])
      expect(store.queuedInputs).toEqual([])
    })
  })

  describe("clearQueue", () => {
    it("empties the queue", () => {
      store.enqueueInput("a")
      store.enqueueInput("b")
      store.clearQueue()
      expect(store.queuedInputs).toEqual([])
    })

    it("notifies subscribers", () => {
      const listener = vi.fn()
      store.subscribe(listener)
      store.clearQueue()
      expect(listener).toHaveBeenCalledTimes(1)
    })

    it("is safe to call on empty queue", () => {
      store.clearQueue()
      expect(store.queuedInputs).toEqual([])
    })
  })

  describe("addToHistoryOnly", () => {
    it("adds text to input history without creating a completed message", () => {
      store.addToHistoryOnly("saved text")
      expect(store.inputHistory).toContain("saved text")
      expect(store.completedMessages).toEqual([])
    })

    it("does not trigger notify (no listener called)", () => {
      const listener = vi.fn()
      store.subscribe(listener)
      listener.mockClear()

      store.addToHistoryOnly("quiet save")
      expect(listener).not.toHaveBeenCalled()
    })

    it("text is retrievable via inputHistory", () => {
      store.addToHistoryOnly("first")
      store.addToHistoryOnly("second")
      expect(store.inputHistory).toEqual(["first", "second"])
    })

    it("works alongside addUserMessage history", () => {
      store.addToHistoryOnly("escaped text")
      store.addUserMessage("submitted text")
      expect(store.inputHistory).toEqual(["escaped text", "submitted text"])
    })
  })
})
