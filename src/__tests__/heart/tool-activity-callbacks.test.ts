import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("../../nerves/runtime", () => ({
  emitNervesEvent: vi.fn(),
}))

describe("createToolActivityCallbacks", () => {
  beforeEach(() => { vi.resetModules() })

  async function loadModule() {
    const mod = await import("../../heart/tool-activity-callbacks")
    return mod.createToolActivityCallbacks
  }

  describe("default mode (isDebug = false)", () => {
    it("calls onDescription on tool START with human-readable text", async () => {
      const createToolActivityCallbacks = await loadModule()
      const onDescription = vi.fn()
      const onResult = vi.fn()
      const onFailure = vi.fn()

      const { onToolStart } = createToolActivityCallbacks({
        onDescription,
        onResult,
        onFailure,
        isDebug: false,
      })

      onToolStart("read_file", { file_path: "/foo/bar.ts" })
      expect(onDescription).toHaveBeenCalledWith("reading bar.ts...")
    })

    it("does NOT call onResult on tool END in default mode", async () => {
      const createToolActivityCallbacks = await loadModule()
      const onResult = vi.fn()

      const { onToolEnd } = createToolActivityCallbacks({
        onDescription: vi.fn(),
        onResult,
        onFailure: vi.fn(),
        isDebug: false,
      })

      onToolEnd("read_file", "200 lines read", true)
      expect(onResult).not.toHaveBeenCalled()
    })

    it("calls onFailure on tool END when success=false", async () => {
      const createToolActivityCallbacks = await loadModule()
      const onFailure = vi.fn()

      const { onToolEnd } = createToolActivityCallbacks({
        onDescription: vi.fn(),
        onResult: vi.fn(),
        onFailure,
        isDebug: false,
      })

      onToolEnd("shell", "exit code 1", false)
      expect(onFailure).toHaveBeenCalledWith("shell failed: exit code 1")
    })

    it("does NOT call onDescription for settle (hidden)", async () => {
      const createToolActivityCallbacks = await loadModule()
      const onDescription = vi.fn()

      const { onToolStart } = createToolActivityCallbacks({
        onDescription,
        onResult: vi.fn(),
        onFailure: vi.fn(),
        isDebug: false,
      })

      onToolStart("settle", {})
      expect(onDescription).not.toHaveBeenCalled()
    })

    it("does NOT call onDescription for rest (hidden)", async () => {
      const createToolActivityCallbacks = await loadModule()
      const onDescription = vi.fn()

      const { onToolStart } = createToolActivityCallbacks({
        onDescription,
        onResult: vi.fn(),
        onFailure: vi.fn(),
        isDebug: false,
      })

      onToolStart("rest", {})
      expect(onDescription).not.toHaveBeenCalled()
    })
  })

  describe("debug mode (isDebug = true)", () => {
    it("calls onDescription on tool START", async () => {
      const createToolActivityCallbacks = await loadModule()
      const onDescription = vi.fn()

      const { onToolStart } = createToolActivityCallbacks({
        onDescription,
        onResult: vi.fn(),
        onFailure: vi.fn(),
        isDebug: true,
      })

      onToolStart("shell", { command: "npm test" })
      expect(onDescription).toHaveBeenCalledWith("running npm test...")
    })

    it("calls onResult on tool END when success=true", async () => {
      const createToolActivityCallbacks = await loadModule()
      const onResult = vi.fn()

      const { onToolEnd } = createToolActivityCallbacks({
        onDescription: vi.fn(),
        onResult,
        onFailure: vi.fn(),
        isDebug: true,
      })

      onToolEnd("read_file", "200 lines read", true)
      expect(onResult).toHaveBeenCalledWith("read_file: 200 lines read")
    })

    it("calls onFailure (not onResult) on tool END when success=false", async () => {
      const createToolActivityCallbacks = await loadModule()
      const onResult = vi.fn()
      const onFailure = vi.fn()

      const { onToolEnd } = createToolActivityCallbacks({
        onDescription: vi.fn(),
        onResult,
        onFailure,
        isDebug: true,
      })

      onToolEnd("shell", "exit code 1", false)
      expect(onResult).not.toHaveBeenCalled()
      expect(onFailure).toHaveBeenCalledWith("shell failed: exit code 1")
    })

    it("does NOT call onDescription for settle even in debug mode", async () => {
      const createToolActivityCallbacks = await loadModule()
      const onDescription = vi.fn()

      const { onToolStart } = createToolActivityCallbacks({
        onDescription,
        onResult: vi.fn(),
        onFailure: vi.fn(),
        isDebug: true,
      })

      onToolStart("settle", {})
      expect(onDescription).not.toHaveBeenCalled()
    })
  })

  describe("fallback for unknown tools", () => {
    it("uses generic description for unknown tools", async () => {
      const createToolActivityCallbacks = await loadModule()
      const onDescription = vi.fn()

      const { onToolStart } = createToolActivityCallbacks({
        onDescription,
        onResult: vi.fn(),
        onFailure: vi.fn(),
        isDebug: false,
      })

      onToolStart("some_custom_tool", {})
      expect(onDescription).toHaveBeenCalledWith("using some_custom_tool...")
    })
  })
})
