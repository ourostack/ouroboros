import { EventEmitter } from "node:events"
import * as fs from "node:fs"

import { describe, expect, it, vi } from "vitest"

const state = vi.hoisted(() => ({ accept: undefined as ((connection: EventEmitter) => void) | undefined }))

vi.mock("node:net", async (importActual) => {
  const actual = await importActual<typeof import("node:net")>()
  return {
    ...actual,
    createServer: vi.fn((...args: unknown[]) => {
      state.accept = args.at(-1) as (connection: EventEmitter) => void
      return Reflect.apply(actual.createServer, actual, args)
    }),
  }
})

import { createSanctuaryInteractiveControl } from "../../senses/sanctuary-interactive-control"

describe("Sanctuary interactive disconnected socket coverage", () => {
  it("does not write an ownership failure to an already-destroyed connection", async () => {
    const agentRoot = fs.mkdtempSync("/tmp/d007-disconnected-")
    const control = createSanctuaryInteractiveControl({
      agentRoot, authorizedUserId: "42", authorizedChatId: "42",
      transport: { handleUpdate: vi.fn(), listPendingDeliveries: vi.fn(() => []) } as never,
      runRequest: async () => { throw new Error("owner unavailable") },
    })
    try {
      await control.start()
      const connection = new EventEmitter() as EventEmitter & { destroyed: boolean; setEncoding(value: string): void; end(value: string): void; destroy(): void }
      connection.destroyed = true
      connection.setEncoding = vi.fn()
      connection.end = vi.fn()
      connection.destroy = vi.fn()
      state.accept!(connection)
      connection.emit("data", JSON.stringify({ operation: "interactive_runtime_ready", label: "unit-16m-restart-continuation", scenarioHandleDigest: "a".repeat(64) }))
      connection.emit("end")
      await new Promise<void>((resolve) => setImmediate(resolve))
      expect(connection.end).not.toHaveBeenCalled()
    } finally {
      await control.stop()
      fs.rmSync(agentRoot, { recursive: true, force: true })
    }
  })
})
