import { afterEach, describe, expect, it, vi } from "vitest"

import { emitNervesEvent, emitNervesEventDurable, setRuntimeLogger } from "../../nerves/runtime"
import { createLogger, type DurableLogSink, type LogEvent } from "../../nerves"

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

  it("awaits the configured durable logger barrier", async () => {
    const barrier = vi.fn(async () => undefined)
    setRuntimeLogger({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), durabilityBarrier: barrier, emitDurable: vi.fn() })

    await emitNervesEventDurable({ event: "runtime.durable", component: "observability", message: "durable event" })

    expect(barrier).toHaveBeenCalledOnce()
  })

  it("bypasses ordinary level filtering for durable evidence", async () => {
    const events: LogEvent[] = []
    const sink = ((event: LogEvent) => { events.push(event) }) as DurableLogSink
    sink.barrier = vi.fn(async () => undefined)
    setRuntimeLogger(createLogger({ level: "error", sinks: [sink] }))

    await emitNervesEventDurable({ event: "runtime.durable_info", component: "observability", message: "durable info" })

    expect(events).toHaveLength(1)
    expect(events[0]?.event).toBe("runtime.durable_info")
    expect(sink.barrier).toHaveBeenCalledOnce()
  })

  it("rejects a durability barrier when no durable sink is configured", async () => {
    const logger = createLogger({ sinks: [] })

    await expect(logger.durabilityBarrier()).rejects.toThrow("No durable Nerves sink is configured")
  })
})
