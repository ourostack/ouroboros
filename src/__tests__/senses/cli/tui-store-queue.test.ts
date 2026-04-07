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
})
