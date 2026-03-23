import { afterEach, describe, expect, it, vi } from "vitest"

import { emitNervesEvent, setRuntimeLogger } from "../../nerves/runtime"

describe("observability/runtime", () => {
  afterEach(() => {
    setRuntimeLogger(null)
    vi.restoreAllMocks()
  })

  it("routes events to the level-specific runtime logger methods", () => {
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }
    setRuntimeLogger(logger)

    emitNervesEvent({
      level: "debug",
      event: "runtime.debug",
      trace_id: "trace-debug",
      component: "observability",
      message: "debug event",
    })
    emitNervesEvent({
      level: "warn",
      event: "runtime.warn",
      trace_id: "trace-warn",
      component: "observability",
      message: "warn event",
    })
    emitNervesEvent({
      level: "error",
      event: "runtime.error",
      trace_id: "trace-error",
      component: "observability",
      message: "error event",
    })
    emitNervesEvent({
      event: "runtime.info",
      trace_id: "trace-info",
      component: "observability",
      message: "info event",
    })

    expect(logger.debug).toHaveBeenCalledWith(expect.objectContaining({
      event: "runtime.debug",
      trace_id: "trace-debug",
    }))
    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({
      event: "runtime.warn",
      trace_id: "trace-warn",
    }))
    expect(logger.error).toHaveBeenCalledWith(expect.objectContaining({
      event: "runtime.error",
      trace_id: "trace-error",
    }))
    expect(logger.info).toHaveBeenCalledWith(expect.objectContaining({
      event: "runtime.info",
      trace_id: "trace-info",
    }))
  })

  it("default logger is silent (no stderr) to prevent spinner interleave", () => {
    const chunks: string[] = []
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation((chunk: any) => {
      chunks.push(chunk.toString())
      return true
    })

    setRuntimeLogger(null)
    emitNervesEvent({
      event: "runtime.default",
      component: "observability",
      message: "default logger path",
      meta: { test: true },
    })

    // Default logger has no sinks — events before configuration are silently dropped
    // to prevent INFO lines from interleaving with CLI spinner output.
    expect(chunks).toHaveLength(0)

    stderrSpy.mockRestore()
  })
})
