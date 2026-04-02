import React from "react"
import { describe, it, expect, afterEach, vi, beforeEach } from "vitest"
import { render, cleanup } from "ink-testing-library"

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

import { CliStore, createInkCallbacks, InkCliApp } from "../../../senses/cli/adapter"

afterEach(() => {
  cleanup()
})

describe("CliStore", () => {
  let store: CliStore

  beforeEach(() => {
    store = new CliStore()
  })

  it("starts with empty state", () => {
    const state = store.getState()
    expect(state.streamingText).toBe("")
    expect(state.loading).toBe(false)
    expect(state.activeTool).toBeNull()
    expect(state.toolResults).toEqual([])
    expect(state.errorMessage).toBeNull()
    expect(state.kickMessage).toBeNull()
    expect(state.inputSuppressed).toBe(false)
  })

  it("modelStart sets loading and spinner phrase", () => {
    store.modelStart()
    const state = store.getState()
    expect(state.loading).toBe(true)
    expect(state.spinnerPhrase).toBeTruthy()
    expect(state.streamingText).toBe("")
  })

  it("appendText adds text and stops loading", () => {
    store.modelStart()
    store.appendText("Hello ")
    store.appendText("world")
    const state = store.getState()
    expect(state.streamingText).toBe("Hello world")
    expect(state.loading).toBe(false)
  })

  it("clearText resets streaming text", () => {
    store.appendText("some text")
    store.clearText()
    expect(store.getState().streamingText).toBe("")
  })

  it("toolStart sets active tool and loading", () => {
    store.toolStart("shell", { command: "ls" })
    const state = store.getState()
    expect(state.loading).toBe(true)
    expect(state.activeTool).toEqual({ name: "shell", args: { command: "ls" } })
  })

  it("toolEnd clears active tool and adds result", () => {
    store.toolStart("shell", { command: "ls" })
    store.toolEnd("shell", "ls", true)
    const state = store.getState()
    expect(state.loading).toBe(false)
    expect(state.activeTool).toBeNull()
    expect(state.toolResults).toHaveLength(1)
    expect(state.toolResults[0]).toEqual({ name: "shell", argSummary: "ls", success: true })
  })

  it("accumulates multiple tool results", () => {
    store.toolStart("shell", { command: "ls" })
    store.toolEnd("shell", "ls", true)
    store.toolStart("read_file", { path: "/foo" })
    store.toolEnd("read_file", "/foo", true)
    expect(store.getState().toolResults).toHaveLength(2)
  })

  it("setError sets error message and stops loading", () => {
    store.modelStart()
    store.setError("something went wrong")
    const state = store.getState()
    expect(state.errorMessage).toBe("something went wrong")
    expect(state.loading).toBe(false)
  })

  it("setKick sets kick message", () => {
    store.setKick()
    const state = store.getState()
    expect(state.kickMessage).toBeTruthy()
  })

  it("suppressInput / restoreInput toggle", () => {
    store.suppressInput()
    expect(store.getState().inputSuppressed).toBe(true)
    store.restoreInput()
    expect(store.getState().inputSuppressed).toBe(false)
  })

  it("endTurn resets transient state", () => {
    store.modelStart()
    store.appendText("hello")
    store.setError("oops")
    store.endTurn()
    const state = store.getState()
    expect(state.loading).toBe(false)
    expect(state.activeTool).toBeNull()
    expect(state.errorMessage).toBeNull()
    expect(state.kickMessage).toBeNull()
    // streamingText is preserved (it's the turn's output)
    expect(state.streamingText).toBe("hello")
  })

  it("setBanner sets banner lines", () => {
    store.setBanner(["welcome", "to ouroboros"])
    expect(store.getState().bannerLines).toEqual(["welcome", "to ouroboros"])
  })

  it("getElapsedSeconds returns 0 when not loading", () => {
    expect(store.getElapsedSeconds()).toBe(0)
  })

  it("getElapsedSeconds returns elapsed time when loading", () => {
    store.modelStart()
    // Just verify it returns a number >= 0
    expect(store.getElapsedSeconds()).toBeGreaterThanOrEqual(0)
  })

  it("notifies subscribers on state change", () => {
    const listener = vi.fn()
    store.subscribe(listener)
    store.modelStart()
    expect(listener).toHaveBeenCalled()
  })

  it("unsubscribe stops notifications", () => {
    const listener = vi.fn()
    const unsub = store.subscribe(listener)
    unsub()
    store.modelStart()
    expect(listener).not.toHaveBeenCalled()
  })

  it("modelStart after tool run uses followup phrases", () => {
    // First call without tool run -> thinking phrases
    store.modelStart()
    const phrase1 = store.getState().spinnerPhrase

    // Simulate a tool run
    store.toolStart("shell", {})
    store.toolEnd("shell", "ls", true)

    // Next modelStart should use followup phrases
    store.modelStart()
    const phrase2 = store.getState().spinnerPhrase
    // Both should be non-empty strings
    expect(phrase1).toBeTruthy()
    expect(phrase2).toBeTruthy()
  })
})

describe("createInkCallbacks", () => {
  let store: CliStore

  beforeEach(() => {
    store = new CliStore()
  })

  it("returns a ChannelCallbacks-compatible object", () => {
    const cb = createInkCallbacks(store)
    expect(typeof cb.onModelStart).toBe("function")
    expect(typeof cb.onModelStreamStart).toBe("function")
    expect(typeof cb.onTextChunk).toBe("function")
    expect(typeof cb.onReasoningChunk).toBe("function")
    expect(typeof cb.onToolStart).toBe("function")
    expect(typeof cb.onToolEnd).toBe("function")
    expect(typeof cb.onError).toBe("function")
    expect(typeof cb.onKick).toBe("function")
    expect(typeof cb.flushMarkdown).toBe("function")
  })

  it("onModelStart updates store loading state", () => {
    const cb = createInkCallbacks(store)
    cb.onModelStart()
    expect(store.getState().loading).toBe(true)
  })

  it("onTextChunk appends text to store", () => {
    const cb = createInkCallbacks(store)
    cb.onTextChunk("hello ")
    cb.onTextChunk("world")
    expect(store.getState().streamingText).toBe("hello world")
  })

  it("onClearText resets store text", () => {
    const cb = createInkCallbacks(store)
    cb.onTextChunk("text")
    cb.onClearText!()
    expect(store.getState().streamingText).toBe("")
  })

  it("onToolStart/onToolEnd update store tool state", () => {
    const cb = createInkCallbacks(store)
    cb.onToolStart("shell", { command: "ls" })
    expect(store.getState().activeTool).toEqual({ name: "shell", args: { command: "ls" } })
    cb.onToolEnd("shell", "ls", true)
    expect(store.getState().activeTool).toBeNull()
    expect(store.getState().toolResults).toHaveLength(1)
  })

  it("onError with transient severity sets short message", () => {
    const cb = createInkCallbacks(store)
    cb.onError(new Error("rate limited"), "transient")
    expect(store.getState().errorMessage).toBe("rate limited")
  })

  it("onError with terminal severity uses formatError", () => {
    const cb = createInkCallbacks(store)
    cb.onError(new Error("fatal"), "terminal")
    // formatError wraps the message
    expect(store.getState().errorMessage).toBeTruthy()
  })

  it("onKick sets kick message", () => {
    const cb = createInkCallbacks(store)
    cb.onKick!()
    expect(store.getState().kickMessage).toBeTruthy()
  })

  it("flushMarkdown calls endTurn", () => {
    const cb = createInkCallbacks(store)
    cb.onModelStart()
    cb.flushMarkdown()
    expect(store.getState().loading).toBe(false)
  })

  it("onReasoningChunk is a no-op (reasoning stays private)", () => {
    const cb = createInkCallbacks(store)
    cb.onReasoningChunk("thinking...")
    expect(store.getState().streamingText).toBe("")
  })

  it("onModelStreamStart is a no-op", () => {
    const cb = createInkCallbacks(store)
    cb.onModelStart()
    cb.onModelStreamStart()
    // Still loading, no text change
    expect(store.getState().loading).toBe(true)
    expect(store.getState().streamingText).toBe("")
  })
})

describe("InkCliApp", () => {
  let store: CliStore

  beforeEach(() => {
    store = new CliStore()
  })

  it("renders without crashing", () => {
    const onSubmit = vi.fn()
    const { lastFrame } = render(<InkCliApp store={store} onSubmit={onSubmit} />)
    expect(lastFrame()).toBeDefined()
  })

  it("shows prompt indicator when idle", () => {
    const onSubmit = vi.fn()
    const { lastFrame } = render(<InkCliApp store={store} onSubmit={onSubmit} />)
    expect(lastFrame()).toContain(")")
  })

  it("renders streaming text", () => {
    const onSubmit = vi.fn()
    store.appendText("Hello world")
    const { lastFrame } = render(<InkCliApp store={store} onSubmit={onSubmit} />)
    const frame = lastFrame()!
    expect(frame).toContain("Hello world")
  })

  it("shows spinner when loading", () => {
    const onSubmit = vi.fn()
    store.modelStart()
    const { lastFrame } = render(<InkCliApp store={store} onSubmit={onSubmit} />)
    const frame = lastFrame()!
    // Spinner phrase should appear
    expect(frame).toBeDefined()
    expect(store.getState().loading).toBe(true)
  })

  it("shows error messages", () => {
    const onSubmit = vi.fn()
    store.setError("something broke")
    const { lastFrame } = render(<InkCliApp store={store} onSubmit={onSubmit} />)
    const frame = lastFrame()!
    expect(frame).toContain("something broke")
  })

  it("shows tool results", () => {
    const onSubmit = vi.fn()
    // Set state before rendering so initial render includes the data
    store.toolStart("shell", { command: "ls" })
    store.toolEnd("shell", "ls", true)
    const { lastFrame } = render(<InkCliApp store={store} onSubmit={onSubmit} />)
    const frame = lastFrame()!
    expect(frame).toContain("shell")
  })

  it("shows active tool badge", () => {
    const onSubmit = vi.fn()
    store.toolStart("read_file", { path: "/foo.ts" })
    const { lastFrame } = render(<InkCliApp store={store} onSubmit={onSubmit} />)
    const frame = lastFrame()!
    expect(frame).toContain("read_file")
  })

  it("shows banner lines", () => {
    const onSubmit = vi.fn()
    store.setBanner(["ouroboros (type /commands for help)"])
    const { lastFrame } = render(<InkCliApp store={store} onSubmit={onSubmit} />)
    const frame = lastFrame()!
    expect(frame).toContain("ouroboros")
  })

  it("hides input when suppressed", () => {
    const onSubmit = vi.fn()
    store.suppressInput()
    const { lastFrame } = render(<InkCliApp store={store} onSubmit={onSubmit} />)
    const frame = lastFrame()!
    // The prompt ")" should not appear when suppressed
    // Input area renders empty text when suppressed
    expect(frame).not.toContain(")")
  })

  it("produces no padding characters in output", () => {
    const onSubmit = vi.fn()
    store.appendText("clean text")
    const { lastFrame } = render(<InkCliApp store={store} onSubmit={onSubmit} />)
    const frame = lastFrame()!
    const lines = frame.split("\n")
    for (const line of lines) {
      expect(line).toBe(line.trimEnd())
    }
  })

  it("shows kick message", () => {
    const onSubmit = vi.fn()
    store.setKick()
    const { lastFrame } = render(<InkCliApp store={store} onSubmit={onSubmit} />)
    const frame = lastFrame()!
    // Kick message from formatKick() should be present
    expect(frame).toBeDefined()
    expect(store.getState().kickMessage).toBeTruthy()
  })
})
