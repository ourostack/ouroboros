import { EventEmitter } from "node:events"

import { describe, expect, it, vi } from "vitest"

vi.mock("node:net", async (importActual) => {
  const actual = await importActual<typeof import("node:net")>()
  return {
    ...actual,
    createConnection: vi.fn(() => {
      const socket = new EventEmitter() as EventEmitter & { destroy(): void; setTimeout(ms: number, callback: () => void): void }
      socket.destroy = vi.fn()
      socket.setTimeout = (_ms, callback) => { queueMicrotask(callback) }
      return socket
    }),
  }
})

import { sanctuaryInteractiveControlReady } from "../../senses/sanctuary-interactive-control"

describe("Sanctuary interactive readiness timeout coverage", () => {
  it("returns false when neither connect nor error wins before the deadline", async () => {
    await expect(sanctuaryInteractiveControlReady("/never-connects.sock", 1)).resolves.toBe(false)
  })
})
