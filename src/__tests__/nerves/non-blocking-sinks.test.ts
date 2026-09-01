import { describe, it, expect, vi } from "vitest"
import { createFanoutSink } from "../../nerves"

const entry = {
  ts: "2026-03-03T00:00:00.000Z",
  level: "info" as const,
  event: "test.event",
  trace_id: "trace-1",
  component: "tests",
  message: "hello",
  meta: {},
}

describe("nerves non-blocking sink behavior", () => {
  it("continues fanout delivery when one sink fails", () => {
    const goodSink = vi.fn()
    const badSink = vi.fn(() => {
      throw new Error("sink failed")
    })

    const sink = createFanoutSink([badSink, goodSink])

    expect(() => sink(entry)).not.toThrow()
    expect(goodSink).toHaveBeenCalledWith(entry)
  })

  it("does not throw when ndjson file append fails", async () => {
    vi.resetModules()
    vi.doMock("fs", () => ({
      appendFile: vi.fn((_path: string, _data: string, _encoding: string, callback: (err: Error) => void) => {
        callback(new Error("disk full"))
      }),
      mkdirSync: vi.fn(),
    }))

    const { createNdjsonFileSink } = await import("../../nerves")
    const sink = createNdjsonFileSink("/tmp/non-blocking-test.ndjson", { rotationCheckIntervalBytes: 1 })

    expect(() => sink(entry)).not.toThrow()
    await expect(sink.barrier()).rejects.toThrow("disk full")
  })
})
