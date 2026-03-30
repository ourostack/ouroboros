import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("../../nerves/runtime", () => ({
  emitNervesEvent: vi.fn(),
}))

vi.mock("../../heart/identity", () => ({
  getAgentName: vi.fn(() => "testagent"),
  getAgentRoot: vi.fn(() => "/tmp/AgentBundles/testagent.ouro"),
}))

describe("BlueBubbles tool callbacks via createToolActivityCallbacks", () => {
  beforeEach(() => {
    vi.resetModules()
  })

  async function loadModule() {
    const { createToolActivityCallbacks } = await import("../../heart/tool-activity-callbacks")
    return createToolActivityCallbacks
  }

  describe("default mode (non-debug)", () => {
    it("onToolStart sends ONE human-readable iMessage via onDescription", async () => {
      const createToolActivityCallbacks = await loadModule()
      const sendText = vi.fn()

      const { onToolStart } = createToolActivityCallbacks({
        onDescription: sendText,
        onResult: vi.fn(),
        onFailure: vi.fn(),
        isDebug: () => false,
      })

      onToolStart("read_file", { file_path: "/foo/bar/mcp-server.ts" })
      expect(sendText).toHaveBeenCalledTimes(1)
      expect(sendText).toHaveBeenCalledWith("reading mcp-server.ts...")
    })

    it("onToolEnd does NOT send in default mode (success=true)", async () => {
      const createToolActivityCallbacks = await loadModule()
      const onResult = vi.fn()

      const { onToolEnd } = createToolActivityCallbacks({
        onDescription: vi.fn(),
        onResult,
        onFailure: vi.fn(),
        isDebug: () => false,
      })

      onToolEnd("shell", "exit code 0", true)
      expect(onResult).not.toHaveBeenCalled()
    })

    it("onToolEnd sends failure message when success=false", async () => {
      const createToolActivityCallbacks = await loadModule()
      const onFailure = vi.fn()

      const { onToolEnd } = createToolActivityCallbacks({
        onDescription: vi.fn(),
        onResult: vi.fn(),
        onFailure,
        isDebug: () => false,
      })

      onToolEnd("shell", "exit code 1", false)
      expect(onFailure).toHaveBeenCalledWith("✗ shell — exit code 1")
    })

    it("settle: NO message sent (hidden)", async () => {
      const createToolActivityCallbacks = await loadModule()
      const onDescription = vi.fn()

      const { onToolStart } = createToolActivityCallbacks({
        onDescription,
        onResult: vi.fn(),
        onFailure: vi.fn(),
        isDebug: () => false,
      })

      onToolStart("settle", {})
      expect(onDescription).not.toHaveBeenCalled()
    })
  })

  describe("debug mode", () => {
    it("onToolStart sends description", async () => {
      const createToolActivityCallbacks = await loadModule()
      const onDescription = vi.fn()

      const { onToolStart } = createToolActivityCallbacks({
        onDescription,
        onResult: vi.fn(),
        onFailure: vi.fn(),
        isDebug: () => true,
      })

      onToolStart("shell", { command: "npm test" })
      expect(onDescription).toHaveBeenCalledWith("running npm test...")
    })

    it("onToolEnd sends result summary", async () => {
      const createToolActivityCallbacks = await loadModule()
      const onResult = vi.fn()

      const { onToolEnd } = createToolActivityCallbacks({
        onDescription: vi.fn(),
        onResult,
        onFailure: vi.fn(),
        isDebug: () => true,
      })

      onToolEnd("read_file", "200 lines", true)
      expect(onResult).toHaveBeenCalledWith("✓ read_file")
    })
  })

  describe("integration: BB-style queue serialization", () => {
    it("multiple tool starts are serialized correctly", async () => {
      const createToolActivityCallbacks = await loadModule()
      const calls: string[] = []
      const onDescription = vi.fn((text: string) => calls.push(text))

      const { onToolStart } = createToolActivityCallbacks({
        onDescription,
        onResult: vi.fn(),
        onFailure: vi.fn(),
        isDebug: () => false,
      })

      onToolStart("read_file", { file_path: "/a/b.ts" })
      onToolStart("shell", { command: "npm test" })
      onToolStart("settle", {})

      expect(calls).toEqual([
        "reading b.ts...",
        "running npm test...",
        // settle is hidden, not in the list
      ])
    })
  })
})
