import { describe, it, expect, vi } from "vitest"

vi.mock("../../../heart/identity", () => ({
  getAgentName: vi.fn(() => "testagent"),
  getAgentSecretsPath: vi.fn(() => "/tmp/.agentsecrets/testagent/secrets.json"),
  resetAgentConfigCache: vi.fn(),
  loadAgentConfig: vi.fn(() => ({
    name: "testagent",
    configPath: "~/.agentsecrets/testagent/secrets.json",
    provider: "minimax",
    phrases: { thinking: ["thinking"], tool: ["tool"], followup: ["followup"] },
  })),
}))

import { InputQueue } from "../../../senses/cli"

describe("InputQueue", () => {
  it("yields pushed items in order", async () => {
    const queue = new InputQueue()
    queue.push("hello")
    queue.push("world")
    queue.close()

    const results: string[] = []
    for await (const item of queue) {
      results.push(item)
    }
    expect(results).toEqual(["hello", "world"])
  })

  it("awaits push when queue is empty", async () => {
    const queue = new InputQueue()

    // Push after a delay
    setTimeout(() => {
      queue.push("delayed")
      queue.close()
    }, 10)

    const results: string[] = []
    for await (const item of queue) {
      results.push(item)
    }
    expect(results).toEqual(["delayed"])
  })

  it("resolves pending next() when push is called", async () => {
    const queue = new InputQueue()

    const iter = queue[Symbol.asyncIterator]()
    const nextPromise = iter.next()

    queue.push("resolved")

    const result = await nextPromise
    expect(result).toEqual({ value: "resolved", done: false })

    queue.close()
  })

  it("close resolves pending next() with done", async () => {
    const queue = new InputQueue()

    const iter = queue[Symbol.asyncIterator]()
    const nextPromise = iter.next()

    queue.close()

    const result = await nextPromise
    expect(result.done).toBe(true)
  })

  it("ignores push after close", async () => {
    const queue = new InputQueue()
    queue.push("before")
    queue.close()
    queue.push("after") // should be ignored

    const results: string[] = []
    for await (const item of queue) {
      results.push(item)
    }
    expect(results).toEqual(["before"])
  })

  it("returns done immediately when already closed and queue empty", async () => {
    const queue = new InputQueue()
    queue.close()

    const iter = queue[Symbol.asyncIterator]()
    const result = await iter.next()
    expect(result.done).toBe(true)
  })

  it("drains buffered items before returning done", async () => {
    const queue = new InputQueue()
    queue.push("a")
    queue.push("b")
    queue.close()

    const iter = queue[Symbol.asyncIterator]()
    expect(await iter.next()).toEqual({ value: "a", done: false })
    expect(await iter.next()).toEqual({ value: "b", done: false })
    expect((await iter.next()).done).toBe(true)
  })

  describe("drainAll", () => {
    it("returns all buffered items and clears the queue", () => {
      const queue = new InputQueue()
      queue.push("a")
      queue.push("b")
      queue.push("c")
      const drained = queue.drainAll()
      expect(drained).toEqual(["a", "b", "c"])
      // Queue should be empty now
      queue.close()
      // Drain again should be empty
      expect(queue.drainAll()).toEqual([])
    })

    it("returns empty array when queue is empty", () => {
      const queue = new InputQueue()
      expect(queue.drainAll()).toEqual([])
    })

    it("leaves pending promise untouched", async () => {
      const queue = new InputQueue()
      const iter = queue[Symbol.asyncIterator]()

      // Start awaiting — creates a pending promise
      const nextPromise = iter.next()

      // Push some items to buffer, then drain
      queue.push("buffered")
      // The push above resolved the pending promise, so push more to buffer
      queue.push("x")
      queue.push("y")
      const drained = queue.drainAll()
      expect(drained).toEqual(["x", "y"])

      // The pending promise should have resolved with "buffered"
      const result = await nextPromise
      expect(result).toEqual({ value: "buffered", done: false })

      queue.close()
    })

    it("does not affect subsequent pushes", async () => {
      const queue = new InputQueue()
      queue.push("first")
      queue.drainAll()

      // New push after drain should work normally
      queue.push("second")
      queue.close()

      const results: string[] = []
      for await (const item of queue) {
        results.push(item)
      }
      expect(results).toEqual(["second"])
    })
  })

  it("supports multiple sequential pushes and awaits", async () => {
    const queue = new InputQueue()
    const results: string[] = []

    const consumer = (async () => {
      for await (const item of queue) {
        results.push(item)
      }
    })()

    queue.push("first")
    await new Promise(r => setTimeout(r, 5))
    queue.push("second")
    await new Promise(r => setTimeout(r, 5))
    queue.push("third")
    queue.close()

    await consumer
    expect(results).toEqual(["first", "second", "third"])
  })
})
