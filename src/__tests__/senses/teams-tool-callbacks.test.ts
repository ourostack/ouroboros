import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("../../nerves/runtime", () => ({
  emitNervesEvent: vi.fn(),
}))

vi.mock("../../heart/identity", () => ({
  getAgentName: vi.fn(() => "testagent"),
  getAgentRoot: vi.fn(() => "/tmp/AgentBundles/testagent.ouro"),
}))

describe("Teams tool callbacks via createToolActivityCallbacks", () => {
  beforeEach(() => {
    vi.resetModules()
  })

  async function loadModule() {
    const { createToolActivityCallbacks } = await import("../../heart/tool-activity-callbacks")
    return createToolActivityCallbacks
  }

  describe("default mode", () => {
    it("safeUpdate called with human-readable text on tool START", async () => {
      const createToolActivityCallbacks = await loadModule()
      const safeUpdate = vi.fn()

      const { onToolStart } = createToolActivityCallbacks({
        onDescription: safeUpdate,
        onResult: vi.fn(),
        onFailure: vi.fn(),
        isDebug: false,
      })

      onToolStart("shell", { command: "npm test" })
      expect(safeUpdate).toHaveBeenCalledWith("running npm test...")
    })

    it("no safeUpdate on tool END in default mode", async () => {
      const createToolActivityCallbacks = await loadModule()
      const safeUpdate = vi.fn()

      const { onToolEnd } = createToolActivityCallbacks({
        onDescription: vi.fn(),
        onResult: safeUpdate,
        onFailure: vi.fn(),
        isDebug: false,
      })

      onToolEnd("read_file", "200 lines", true)
      expect(safeUpdate).not.toHaveBeenCalled()
    })

    it("no 'shared work: processing' text anywhere", async () => {
      const createToolActivityCallbacks = await loadModule()
      const allCalls: string[] = []
      const capture = vi.fn((text: string) => allCalls.push(text))

      const { onToolStart, onToolEnd } = createToolActivityCallbacks({
        onDescription: capture,
        onResult: capture,
        onFailure: capture,
        isDebug: false,
      })

      onToolStart("read_file", { path: "/a/b.ts" })
      onToolEnd("read_file", "done", true)
      onToolStart("shell", { command: "npm test" })
      onToolEnd("shell", "exit 0", true)

      for (const text of allCalls) {
        expect(text).not.toContain("shared work")
      }
    })
  })

  describe("debug mode", () => {
    it("safeUpdate includes result on tool END", async () => {
      const createToolActivityCallbacks = await loadModule()
      const safeUpdate = vi.fn()

      const { onToolEnd } = createToolActivityCallbacks({
        onDescription: vi.fn(),
        onResult: safeUpdate,
        onFailure: vi.fn(),
        isDebug: true,
      })

      onToolEnd("read_file", "200 lines", true)
      expect(safeUpdate).toHaveBeenCalledWith("read_file: 200 lines")
    })

    it("onFailure called with x mark prefix on failure", async () => {
      const createToolActivityCallbacks = await loadModule()
      const onFailure = vi.fn()

      const { onToolEnd } = createToolActivityCallbacks({
        onDescription: vi.fn(),
        onResult: vi.fn(),
        onFailure,
        isDebug: true,
      })

      onToolEnd("shell", "exit code 1", false)
      expect(onFailure).toHaveBeenCalledWith("shell failed: exit code 1")
    })
  })
})
