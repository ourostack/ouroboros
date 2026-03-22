import { beforeEach, describe, expect, it, vi } from "vitest"

const emitNervesEvent = vi.fn()

vi.mock("../../nerves/runtime", () => ({
  emitNervesEvent: (...args: unknown[]) => emitNervesEvent(...args),
}))

describe("tool loop guard", () => {
  beforeEach(() => {
    emitNervesEvent.mockReset()
  })

  it("allows fresh tool calls", async () => {
    const { createToolLoopState, detectToolLoop } = await import("../../heart/tool-loop")

    const state = createToolLoopState()
    expect(detectToolLoop(state, "coding_status", { sessionId: "coding-001" })).toEqual({ stuck: false })
    expect(emitNervesEvent).not.toHaveBeenCalled()
  })

  it("detects repeated poll calls with no progress", async () => {
    const { createToolLoopState, detectToolLoop, recordToolOutcome } = await import("../../heart/tool-loop")

    const state = createToolLoopState()
    for (let count = 0; count < 3; count++) {
      recordToolOutcome(state, "coding_status", { sessionId: "coding-001" }, "status: running", true)
    }

    const result = detectToolLoop(state, "coding_status", { sessionId: "coding-001" })
    expect(result).toMatchObject({
      stuck: true,
      detector: "known_poll_no_progress",
      count: 3,
    })
    expect(result.message).toContain("stop polling")
    expect(emitNervesEvent).toHaveBeenCalledWith(expect.objectContaining({
      event: "engine.tool_loop_detected",
      component: "engine",
    }))
  })

  it("detects generic repeated calls with the same outcome", async () => {
    const { createToolLoopState, detectToolLoop, recordToolOutcome } = await import("../../heart/tool-loop")

    const state = createToolLoopState()
    for (let count = 0; count < 4; count++) {
      recordToolOutcome(state, "read_file", { path: "/tmp/a.txt" }, "same file", true)
    }

    const result = detectToolLoop(state, "read_file", { path: "/tmp/a.txt" })
    expect(result).toMatchObject({
      stuck: true,
      detector: "generic_repeat",
      count: 4,
    })
    expect(result.message).toContain("change approach")
  })

  it("detects ping-pong polling between status surfaces", async () => {
    const { createToolLoopState, detectToolLoop, recordToolOutcome } = await import("../../heart/tool-loop")

    const state = createToolLoopState()
    for (let count = 0; count < 3; count++) {
      recordToolOutcome(state, "coding_status", { sessionId: "coding-001" }, "status: running", true)
      recordToolOutcome(state, "coding_tail", { sessionId: "coding-001" }, "tail: no change", true)
    }

    const result = detectToolLoop(state, "coding_status", { sessionId: "coding-001" })
    expect(result).toMatchObject({
      stuck: true,
      detector: "ping_pong",
      pairedToolName: "coding_tail",
    })
    expect(result.message).toContain("status checks")
  })

  it("detects ping-pong regardless of which side of the pair is retried next", async () => {
    const { createToolLoopState, detectToolLoop, recordToolOutcome } = await import("../../heart/tool-loop")

    const state = createToolLoopState()
    for (let count = 0; count < 3; count++) {
      recordToolOutcome(state, "coding_status", { sessionId: "coding-001" }, "status: running", true)
      recordToolOutcome(state, "coding_tail", { sessionId: "coding-001" }, "tail: no change", true)
    }

    const result = detectToolLoop(state, "coding_tail", { sessionId: "coding-001" })
    expect(result).toMatchObject({
      stuck: true,
      detector: "ping_pong",
      pairedToolName: "coding_status",
    })
  })

  it("does not flag a broken ping-pong sequence", async () => {
    const { createToolLoopState, detectToolLoop, recordToolOutcome } = await import("../../heart/tool-loop")

    const state = createToolLoopState()
    recordToolOutcome(state, "coding_status", { sessionId: "coding-001" }, "status: running", true)
    recordToolOutcome(state, "coding_tail", { sessionId: "coding-001" }, "tail: waiting", true)
    recordToolOutcome(state, "coding_status", { sessionId: "coding-001" }, "status: running", true)
    recordToolOutcome(state, "coding_tail", { sessionId: "coding-001" }, "tail: changed", true)
    recordToolOutcome(state, "coding_status", { sessionId: "coding-001" }, "status: running", true)
    recordToolOutcome(state, "coding_tail", { sessionId: "coding-001" }, "tail: waiting", true)

    expect(detectToolLoop(state, "coding_status", { sessionId: "coding-001" })).toEqual({ stuck: false })
  })

  it("does not treat non-poll tools as ping-pong state checks", async () => {
    const { createToolLoopState, detectToolLoop, recordToolOutcome } = await import("../../heart/tool-loop")

    const state = createToolLoopState()
    for (let count = 0; count < 3; count++) {
      recordToolOutcome(state, "read_file", { path: "/tmp/a.txt" }, "A", true)
      recordToolOutcome(state, "grep_files", { pattern: "todo" }, "B", true)
    }

    expect(detectToolLoop(state, "read_file", { path: "/tmp/a.txt" })).toEqual({ stuck: false })
  })

  it("does not treat the same poll tool as a ping-pong pair", async () => {
    const { createToolLoopState, detectToolLoop, recordToolOutcome } = await import("../../heart/tool-loop")

    const state = createToolLoopState()
    const outcomes = ["queued", "running", "waiting", "queued", "running", "waiting"]
    for (const outcome of outcomes) {
      recordToolOutcome(state, "coding_status", { sessionId: "coding-001" }, outcome, true)
    }

    expect(detectToolLoop(state, "coding_status", { sessionId: "coding-001" })).toEqual({ stuck: false })
  })

  it("does not flag a ping-pong pattern when the next call leaves the pair", async () => {
    const { createToolLoopState, detectToolLoop, recordToolOutcome } = await import("../../heart/tool-loop")

    const state = createToolLoopState()
    for (let count = 0; count < 3; count++) {
      recordToolOutcome(state, "coding_status", { sessionId: "coding-001" }, "status: running", true)
      recordToolOutcome(state, "coding_tail", { sessionId: "coding-001" }, "tail: no change", true)
    }

    expect(detectToolLoop(state, "read_file", { path: "/tmp/status.txt" })).toEqual({ stuck: false })
  })

  it("detects a global circuit breaker once the turn is thrashing", async () => {
    const { GLOBAL_CIRCUIT_BREAKER_LIMIT, createToolLoopState, detectToolLoop, recordToolOutcome } = await import("../../heart/tool-loop")

    const state = createToolLoopState()
    for (let count = 0; count < GLOBAL_CIRCUIT_BREAKER_LIMIT; count++) {
      recordToolOutcome(state, `tool_${count}`, { step: String(count) }, `result ${count}`, true)
    }

    const result = detectToolLoop(state, "another_tool", { step: "overflow" })
    expect(result).toMatchObject({
      stuck: true,
      detector: "global_circuit_breaker",
      count: GLOBAL_CIRCUIT_BREAKER_LIMIT,
    })
    expect(result.message).toContain("already made")
  })

  it("does not flag known polls when the observed result changes", async () => {
    const { createToolLoopState, detectToolLoop, recordToolOutcome } = await import("../../heart/tool-loop")

    const state = createToolLoopState()
    recordToolOutcome(state, "coding_status", { sessionId: "coding-001" }, "status: queued", true)
    recordToolOutcome(state, "coding_status", { sessionId: "coding-001" }, "status: running", true)
    recordToolOutcome(state, "coding_status", { sessionId: "coding-001" }, "status: completed", true)

    expect(detectToolLoop(state, "coding_status", { sessionId: "coding-001" })).toEqual({ stuck: false })
  })

  it("tracks query_session status polling separately from search mode", async () => {
    const { createToolLoopState, detectToolLoop, recordToolOutcome } = await import("../../heart/tool-loop")

    const state = createToolLoopState()
    for (let count = 0; count < 3; count++) {
      recordToolOutcome(
        state,
        "query_session",
        { mode: "status", friendId: "self", channel: "inner", key: "dialog" },
        "processing",
        true,
      )
    }

    expect(detectToolLoop(state, "query_session", { mode: "search", friendId: "self", channel: "inner", key: "dialog", query: "latest" })).toEqual({ stuck: false })
    expect(detectToolLoop(state, "query_session", { mode: "status", friendId: "self", channel: "inner", key: "dialog" })).toMatchObject({
      stuck: true,
      detector: "known_poll_no_progress",
    })
  })

  it("treats query_active_work as a live poll surface with stable args", async () => {
    const { createToolLoopState, detectToolLoop, recordToolOutcome } = await import("../../heart/tool-loop")

    const state = createToolLoopState()
    for (let count = 0; count < 3; count++) {
      recordToolOutcome(state, "query_active_work", { scope: "ignored" }, "same live frame", true)
    }

    expect(detectToolLoop(state, "query_active_work", {})).toMatchObject({
      stuck: true,
      detector: "known_poll_no_progress",
      count: 3,
    })
  })

  it("normalizes missing poll identifiers to stable empty defaults", async () => {
    const { createToolLoopState, detectToolLoop, recordToolOutcome } = await import("../../heart/tool-loop")

    const state = createToolLoopState()
    for (let count = 0; count < 3; count++) {
      recordToolOutcome(state, "coding_tail", {}, "tail: unchanged", true)
    }

    expect(detectToolLoop(state, "coding_tail", {})).toMatchObject({
      stuck: true,
      detector: "known_poll_no_progress",
    })

    const queryState = createToolLoopState()
    for (let count = 0; count < 3; count++) {
      recordToolOutcome(queryState, "query_session", { mode: "status" }, "idle", true)
    }

    expect(detectToolLoop(queryState, "query_session", { mode: "status" })).toMatchObject({
      stuck: true,
      detector: "known_poll_no_progress",
    })

    const blankQueryState = createToolLoopState()
    for (let count = 0; count < 4; count++) {
      recordToolOutcome(blankQueryState, "query_session", {}, "no query provided", true)
    }

    expect(detectToolLoop(blankQueryState, "query_session", {})).toMatchObject({
      stuck: true,
      detector: "generic_repeat",
    })
  })

  it("trims loop history to the configured limit", async () => {
    const { TOOL_LOOP_HISTORY_LIMIT, createToolLoopState, recordToolOutcome } = await import("../../heart/tool-loop")

    const state = createToolLoopState()
    for (let count = 0; count < TOOL_LOOP_HISTORY_LIMIT + 5; count++) {
      recordToolOutcome(state, "read_file", { path: `/tmp/${count}.txt` }, `file ${count}`, true)
    }

    expect(state.history).toHaveLength(TOOL_LOOP_HISTORY_LIMIT)
    expect(state.history[0]?.toolName).toBe("read_file")
  })

  it("does not flag a repeated poll when the most recent call changed args", async () => {
    const { createToolLoopState, detectToolLoop, recordToolOutcome } = await import("../../heart/tool-loop")

    const state = createToolLoopState()
    recordToolOutcome(state, "coding_tail", { sessionId: "coding-001" }, "tail: same", true)
    recordToolOutcome(state, "coding_tail", { sessionId: "coding-001" }, "tail: same", true)
    recordToolOutcome(state, "coding_tail", { sessionId: "coding-002" }, "tail: same", true)

    expect(detectToolLoop(state, "coding_tail", { sessionId: "coding-001" })).toEqual({ stuck: false })
  })
})
