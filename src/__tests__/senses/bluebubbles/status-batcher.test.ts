import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

vi.mock("../../../nerves/runtime", () => ({
  emitNervesEvent: vi.fn(),
}))

import { createStatusBatcher } from "../../../senses/bluebubbles"

describe("createStatusBatcher", () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it("sends a single description immediately after debounce window", () => {
    const send = vi.fn()
    const batcher = createStatusBatcher(send, 500)

    batcher.add("reading file...")
    expect(send).not.toHaveBeenCalled()

    vi.advanceTimersByTime(500)
    expect(send).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledWith("reading file...")
  })

  it("batches multiple descriptions within debounce window into one message", () => {
    const send = vi.fn()
    const batcher = createStatusBatcher(send, 500)

    batcher.add("searching memory...")
    batcher.add("reading file...")
    batcher.add("checking session...")
    expect(send).not.toHaveBeenCalled()

    vi.advanceTimersByTime(500)
    expect(send).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledWith("searching memory... \u00b7 reading file... \u00b7 checking session...")
  })

  it("flush sends accumulated descriptions immediately", () => {
    const send = vi.fn()
    const batcher = createStatusBatcher(send, 500)

    batcher.add("searching memory...")
    batcher.add("reading file...")

    batcher.flush()
    expect(send).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledWith("searching memory... \u00b7 reading file...")

    // Timer should not fire again (already flushed)
    vi.advanceTimersByTime(500)
    expect(send).toHaveBeenCalledTimes(1)
  })

  it("flush with no pending descriptions does nothing", () => {
    const send = vi.fn()
    const batcher = createStatusBatcher(send, 500)

    batcher.flush()
    expect(send).not.toHaveBeenCalled()
  })

  it("separate batches for descriptions outside debounce window", () => {
    const send = vi.fn()
    const batcher = createStatusBatcher(send, 500)

    batcher.add("first...")
    vi.advanceTimersByTime(500)
    expect(send).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledWith("first...")

    batcher.add("second...")
    vi.advanceTimersByTime(500)
    expect(send).toHaveBeenCalledTimes(2)
    expect(send).toHaveBeenCalledWith("second...")
  })

  it("resets debounce timer on each add within window", () => {
    const send = vi.fn()
    const batcher = createStatusBatcher(send, 500)

    batcher.add("first...")
    vi.advanceTimersByTime(300) // 300ms in, not yet fired
    expect(send).not.toHaveBeenCalled()

    batcher.add("second...")
    vi.advanceTimersByTime(300) // 600ms total, but only 300ms since last add
    expect(send).not.toHaveBeenCalled()

    vi.advanceTimersByTime(200) // 800ms total, 500ms since last add
    expect(send).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledWith("first... \u00b7 second...")
  })
})
