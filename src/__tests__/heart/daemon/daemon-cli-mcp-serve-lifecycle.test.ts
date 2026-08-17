import { EventEmitter, PassThrough } from "node:stream"
import { describe, expect, it, vi } from "vitest"
import type { McpServer } from "../../../heart/mcp/mcp-server"
import type { OuroCliDeps } from "../../../heart/daemon/cli-types"
import { runMcpServeCliLifecycle, runOuroCli } from "../../../heart/daemon/cli-exec"

function fakeServer() {
  return {
    agent: "slugger",
    friendId: "local-test",
    start: vi.fn(),
    stop: vi.fn(),
  } satisfies McpServer
}

describe("mcp-serve CLI lifecycle", () => {
  it.each(["end", "close"] as const)("stops and resolves exactly once on stdin %s", async (event) => {
    const input = new EventEmitter()
    const server = fakeServer()
    const promise = runMcpServeCliLifecycle(server, input)

    input.emit(event)
    input.emit(event)

    await expect(promise).resolves.toBeUndefined()
    expect(server.start).toHaveBeenCalledOnce()
    expect(server.stop).toHaveBeenCalledOnce()
    expect(input.listenerCount("end")).toBe(0)
    expect(input.listenerCount("close")).toBe(0)
  })

  it("deduplicates end followed by close", async () => {
    const input = new EventEmitter()
    const server = fakeServer()
    const promise = runMcpServeCliLifecycle(server, input)

    input.emit("end")
    input.emit("close")

    await promise
    expect(server.stop).toHaveBeenCalledOnce()
  })

  it("deduplicates terminal callbacks when an input cannot remove queued listeners", async () => {
    const listeners = new Map<string, () => void>()
    const input = {
      once: vi.fn((event: string, listener: () => void) => {
        listeners.set(event, listener)
        return input
      }),
      removeListener: vi.fn(() => input),
    }
    const server = fakeServer()
    const promise = runMcpServeCliLifecycle(server, input)

    listeners.get("end")?.()
    listeners.get("close")?.()

    await promise
    expect(server.stop).toHaveBeenCalledOnce()
  })

  it.each([
    ["end", ["end"]],
    ["close", ["close"]],
    ["end+close", ["end", "close"]],
  ] as const)("uses injected ownership at the actual CLI boundary for %s", async (_label, events) => {
    const input = new EventEmitter()
    const output = new PassThrough()
    const server = fakeServer()
    const createMcpServer = vi.fn(() => server)
    const deps = {
      socketPath: "/tmp/ouro-test.sock",
      sendCommand: vi.fn(),
      startDaemonProcess: vi.fn(),
      writeStdout: vi.fn(),
      checkSocketAlive: vi.fn(),
      cleanupStaleSocket: vi.fn(),
      fallbackPendingMessage: vi.fn(),
      mcpServeInput: input,
      mcpServeOutput: output,
      createMcpServer,
    } as unknown as OuroCliDeps

    const resultPromise = runOuroCli(["mcp-serve", "--agent", "slugger", "--friend", "friend-1"], deps)
    await Promise.resolve()
    for (const event of events) input.emit(event)

    await expect(resultPromise).resolves.toBe("")
    expect(createMcpServer).toHaveBeenCalledWith(expect.objectContaining({
      agent: "slugger",
      friendId: "friend-1",
      socketPath: "/tmp/ouro-test.sock",
      stdin: input,
      stdout: output,
    }))
    expect(server.start).toHaveBeenCalledOnce()
    expect(server.stop).toHaveBeenCalledOnce()
  })
})
