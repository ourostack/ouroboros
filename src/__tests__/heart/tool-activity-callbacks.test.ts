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
        isDebug: () => false,
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
        isDebug: () => false,
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
        isDebug: () => false,
      })

      onToolEnd("shell", "exit code 1", false)
      expect(onFailure).toHaveBeenCalledWith("✗ shell — exit code 1")
    })

    it("does NOT call onDescription for settle (hidden)", async () => {
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

    it("does NOT call onDescription for rest (hidden)", async () => {
      const createToolActivityCallbacks = await loadModule()
      const onDescription = vi.fn()

      const { onToolStart } = createToolActivityCallbacks({
        onDescription,
        onResult: vi.fn(),
        onFailure: vi.fn(),
        isDebug: () => false,
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
        isDebug: () => true,
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
        isDebug: () => true,
      })

      onToolEnd("read_file", "200 lines read", true)
      expect(onResult).toHaveBeenCalledWith("✓ read_file")
    })

    it("calls onFailure (not onResult) on tool END when success=false", async () => {
      const createToolActivityCallbacks = await loadModule()
      const onResult = vi.fn()
      const onFailure = vi.fn()

      const { onToolEnd } = createToolActivityCallbacks({
        onDescription: vi.fn(),
        onResult,
        onFailure,
        isDebug: () => true,
      })

      onToolEnd("shell", "exit code 1", false)
      expect(onResult).not.toHaveBeenCalled()
      expect(onFailure).toHaveBeenCalledWith("✗ shell — exit code 1")
    })

    it("does NOT call onDescription for settle even in debug mode", async () => {
      const createToolActivityCallbacks = await loadModule()
      const onDescription = vi.fn()

      const { onToolStart } = createToolActivityCallbacks({
        onDescription,
        onResult: vi.fn(),
        onFailure: vi.fn(),
        isDebug: () => true,
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
        isDebug: () => false,
      })

      onToolStart("some_custom_tool", {})
      expect(onDescription).toHaveBeenCalledWith("using some_custom_tool...")
    })
  })

  describe("hidden-tool END suppression (regression: rejected settle args leak)", () => {
    // Bug: when a hidden tool (settle/rest/observe) is rejected, onToolEnd was
    // emitting "✗ <previous tool's description> — <hidden tool's args summary>"
    // because lastDescription persisted from the prior visible tool and the
    // hidden tool's onToolEnd was not being suppressed symmetrically with onToolStart.
    // The summary for settle includes its `answer` arg, so this leaked the
    // agent's intended-but-rejected answer text into the visible chat.

    it("after a visible tool primes lastDescription, a hidden tool that ENDS with success=false does NOT call onFailure", async () => {
      const createToolActivityCallbacks = await loadModule()
      const onDescription = vi.fn()
      const onResult = vi.fn()
      const onFailure = vi.fn()

      const { onToolStart, onToolEnd } = createToolActivityCallbacks({
        onDescription,
        onResult,
        onFailure,
        isDebug: () => false,
      })

      // 1. Visible tool primes lastDescription.
      onToolStart("read_file", { file_path: "/foo/audit.ts" })
      expect(onDescription).toHaveBeenCalledWith("reading audit.ts...")

      // 2. Hidden tool (settle) starts — no description side effect.
      onToolStart("settle", { answer: "found it secret answer", intent: "complete" })

      // 3. Hidden tool ends in failure (e.g. rejected by mustResolveBeforeHandoff
      //    gate or attention-queue gate). The summary leaks the answer args.
      onToolEnd("settle", "answer=found it secret answer intent=complete", false)

      // The hidden tool MUST NOT produce a visible failure line.
      expect(onFailure).not.toHaveBeenCalled()
      expect(onResult).not.toHaveBeenCalled()
    })

    it("hidden tool that ENDS with success=true does NOT call onResult, even in debug mode", async () => {
      const createToolActivityCallbacks = await loadModule()
      const onResult = vi.fn()
      const onFailure = vi.fn()

      const { onToolStart, onToolEnd } = createToolActivityCallbacks({
        onDescription: vi.fn(),
        onResult,
        onFailure,
        isDebug: () => true,
      })

      onToolStart("settle", { answer: "delivered text" })
      onToolEnd("settle", "answer=delivered text", true)

      expect(onResult).not.toHaveBeenCalled()
      expect(onFailure).not.toHaveBeenCalled()
    })

    it("two interleaved hidden tools (settle then rest) do not interfere with each other or with later visible tools", async () => {
      const createToolActivityCallbacks = await loadModule()
      const onDescription = vi.fn()
      const onResult = vi.fn()
      const onFailure = vi.fn()

      const { onToolStart, onToolEnd } = createToolActivityCallbacks({
        onDescription,
        onResult,
        onFailure,
        isDebug: () => false,
      })

      onToolStart("settle", {})
      onToolStart("rest", {})
      onToolEnd("settle", "answer=foo", false)
      onToolEnd("rest", "note=bar", false)

      expect(onFailure).not.toHaveBeenCalled()
      expect(onResult).not.toHaveBeenCalled()

      // A later visible tool should still produce a normal description and END.
      onToolStart("shell", { command: "npm test" })
      expect(onDescription).toHaveBeenLastCalledWith("running npm test...")
      onToolEnd("shell", "exit code 1", false)
      expect(onFailure).toHaveBeenCalledWith("✗ running npm test — exit code 1")
    })

    it("two concurrent same-named hidden tool starts (e.g. settle x2) decrement the counter on each end without emitting", async () => {
      // Defensive: covers the counter-decrement branch (hiddenCount > 1) so a
      // concurrent same-name hidden tool path stays suppressed across both ends.
      const createToolActivityCallbacks = await loadModule()
      const onResult = vi.fn()
      const onFailure = vi.fn()

      const { onToolStart, onToolEnd } = createToolActivityCallbacks({
        onDescription: vi.fn(),
        onResult,
        onFailure,
        isDebug: () => true,
      })

      onToolStart("settle", { answer: "first" })
      onToolStart("settle", { answer: "second" }) // bumps counter to 2
      onToolEnd("settle", "answer=first", false)  // takes the > 1 branch (counter -> 1)
      onToolEnd("settle", "answer=second", true)  // takes the === 1 branch (deletes)

      expect(onResult).not.toHaveBeenCalled()
      expect(onFailure).not.toHaveBeenCalled()
    })

    it("hidden tool start without a matching end does not break the next visible tool's END emission", async () => {
      // Defensive: if an engine path ever calls onToolStart for a hidden tool but
      // never calls onToolEnd for it, a subsequent visible tool's END must still
      // attribute correctly to its own description (not to a stale hidden mark).
      const createToolActivityCallbacks = await loadModule()
      const onDescription = vi.fn()
      const onResult = vi.fn()
      const onFailure = vi.fn()

      const { onToolStart, onToolEnd } = createToolActivityCallbacks({
        onDescription,
        onResult,
        onFailure,
        isDebug: () => false,
      })

      onToolStart("settle", {}) // hidden, no end ever fires
      onToolStart("read_file", { file_path: "/x/y.ts" })
      expect(onDescription).toHaveBeenLastCalledWith("reading y.ts...")
      onToolEnd("read_file", "200 lines", false)
      expect(onFailure).toHaveBeenCalledWith("✗ reading y.ts — 200 lines")
    })
  })
})
