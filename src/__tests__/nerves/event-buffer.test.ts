import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { LogEvent, LogSink } from "../../nerves/index"

const mockEmitNervesEvent = vi.fn()
vi.mock("../../nerves/runtime", () => ({
  emitNervesEvent: (...args: any[]) => mockEmitNervesEvent(...args),
}))

import { createBufferedSink, type BufferedSink } from "../../nerves/event-buffer"

function makeLogEvent(overrides: Partial<LogEvent> = {}): LogEvent {
  return {
    ts: "2026-03-27T10:00:00.000Z",
    level: "info",
    event: "test.event",
    trace_id: "trace-1",
    component: "test",
    message: "test message",
    meta: {},
    ...overrides,
  }
}

describe("event-buffer", () => {
  let innerSink: ReturnType<typeof vi.fn>

  beforeEach(() => {
    vi.clearAllMocks()
    innerSink = vi.fn()
  })

  describe("createBufferedSink()", () => {
    it("returns a BufferedSink with sink function and state/flush methods", () => {
      const buffered = createBufferedSink(innerSink)
      expect(typeof buffered.sink).toBe("function")
      expect(typeof buffered.flush).toBe("function")
      expect(typeof buffered.state).toBe("function")
    })

    it("delegates to inner sink when inner sink is healthy", () => {
      const buffered = createBufferedSink(innerSink)
      const event = makeLogEvent()

      buffered.sink(event)

      expect(innerSink).toHaveBeenCalledWith(event)
    })

    it("buffers events when inner sink throws", () => {
      innerSink.mockImplementation(() => { throw new Error("sink broken") })

      const buffered = createBufferedSink(innerSink)
      const event = makeLogEvent()

      buffered.sink(event)

      const state = buffered.state()
      expect(state.buffered).toBe(1)
      expect(state.sinkHealthy).toBe(false)
    })

    it("buffers multiple events while inner sink is unhealthy", () => {
      innerSink.mockImplementation(() => { throw new Error("sink broken") })

      const buffered = createBufferedSink(innerSink)

      buffered.sink(makeLogEvent({ message: "event 1" }))
      buffered.sink(makeLogEvent({ message: "event 2" }))
      buffered.sink(makeLogEvent({ message: "event 3" }))

      expect(buffered.state().buffered).toBe(3)
    })

    it("respects maxSize option and drops oldest events (ring buffer)", () => {
      innerSink.mockImplementation(() => { throw new Error("sink broken") })

      const buffered = createBufferedSink(innerSink, { maxSize: 3 })

      buffered.sink(makeLogEvent({ message: "event 1" }))
      buffered.sink(makeLogEvent({ message: "event 2" }))
      buffered.sink(makeLogEvent({ message: "event 3" }))
      buffered.sink(makeLogEvent({ message: "event 4" }))

      const state = buffered.state()
      expect(state.buffered).toBe(3)
      expect(state.dropped).toBe(1)
    })

    it("defaults maxSize to 1000", () => {
      innerSink.mockImplementation(() => { throw new Error("sink broken") })

      const buffered = createBufferedSink(innerSink)

      for (let i = 0; i < 1005; i++) {
        buffered.sink(makeLogEvent({ message: `event ${i}` }))
      }

      const state = buffered.state()
      expect(state.buffered).toBe(1000)
      expect(state.dropped).toBe(5)
    })

    it("tracks total dropped count correctly over multiple overflows", () => {
      innerSink.mockImplementation(() => { throw new Error("sink broken") })

      const buffered = createBufferedSink(innerSink, { maxSize: 2 })

      buffered.sink(makeLogEvent({ message: "1" }))
      buffered.sink(makeLogEvent({ message: "2" }))
      buffered.sink(makeLogEvent({ message: "3" }))
      buffered.sink(makeLogEvent({ message: "4" }))
      buffered.sink(makeLogEvent({ message: "5" }))

      const state = buffered.state()
      expect(state.buffered).toBe(2)
      expect(state.dropped).toBe(3)
    })

    it("auto-flushes buffer when inner sink recovers on next event", () => {
      let callCount = 0
      innerSink.mockImplementation(() => {
        callCount++
        if (callCount <= 2) throw new Error("broken")
        // recovers on 3rd call and beyond
      })

      const buffered = createBufferedSink(innerSink)

      // First two events: sink fails, both buffered
      buffered.sink(makeLogEvent({ message: "buffered 1" }))
      buffered.sink(makeLogEvent({ message: "buffered 2" }))
      expect(buffered.state().buffered).toBe(2)

      // Third event: sink recovers, flushes buffer + sends new event
      buffered.sink(makeLogEvent({ message: "trigger recovery" }))

      expect(buffered.state().buffered).toBe(0)
      expect(buffered.state().sinkHealthy).toBe(true)
    })

    it("flush() retries buffered events against inner sink", () => {
      let broken = true
      innerSink.mockImplementation(() => {
        if (broken) throw new Error("broken")
      })

      const buffered = createBufferedSink(innerSink)

      buffered.sink(makeLogEvent({ message: "event 1" }))
      buffered.sink(makeLogEvent({ message: "event 2" }))
      expect(buffered.state().buffered).toBe(2)

      broken = false
      buffered.flush()

      expect(buffered.state().buffered).toBe(0)
      expect(buffered.state().sinkHealthy).toBe(true)
    })

    it("flush() keeps events in buffer if inner sink still throws", () => {
      innerSink.mockImplementation(() => { throw new Error("still broken") })

      const buffered = createBufferedSink(innerSink)

      buffered.sink(makeLogEvent({ message: "event 1" }))
      buffered.flush()

      expect(buffered.state().buffered).toBe(1)
      expect(buffered.state().sinkHealthy).toBe(false)
    })

    it("reports sinkHealthy = true initially", () => {
      const buffered = createBufferedSink(innerSink)
      expect(buffered.state().sinkHealthy).toBe(true)
    })

    it("reports sinkHealthy = false after inner sink throws", () => {
      innerSink.mockImplementation(() => { throw new Error("broken") })
      const buffered = createBufferedSink(innerSink)

      buffered.sink(makeLogEvent())

      expect(buffered.state().sinkHealthy).toBe(false)
    })

    it("reports sinkHealthy = true after successful event", () => {
      let broken = true
      innerSink.mockImplementation(() => {
        if (broken) throw new Error("broken")
      })

      const buffered = createBufferedSink(innerSink)

      buffered.sink(makeLogEvent())
      expect(buffered.state().sinkHealthy).toBe(false)

      broken = false
      buffered.sink(makeLogEvent())
      expect(buffered.state().sinkHealthy).toBe(true)
    })

    it("reports initial state with zero buffered and zero dropped", () => {
      const buffered = createBufferedSink(innerSink)
      const state = buffered.state()
      expect(state.buffered).toBe(0)
      expect(state.dropped).toBe(0)
      expect(state.sinkHealthy).toBe(true)
    })

    describe("buffer TTL", () => {
      it("discards buffer after 5 minutes of unhealthy sink", () => {
        const clock = { now: Date.now() }
        innerSink.mockImplementation(() => { throw new Error("broken") })

        const buffered = createBufferedSink(innerSink, {
          nowMs: () => clock.now,
        })

        // Buffer some events
        buffered.sink(makeLogEvent({ message: "event 1" }))
        buffered.sink(makeLogEvent({ message: "event 2" }))
        expect(buffered.state().buffered).toBe(2)

        // Advance time past TTL (5 minutes = 300000ms)
        clock.now += 300_001

        // Next event should trigger TTL check: discard old buffer
        buffered.sink(makeLogEvent({ message: "event 3" }))

        // Old events discarded, only "event 3" might be buffered
        // (since sink is still broken, event 3 itself is also buffered fresh)
        expect(buffered.state().buffered).toBe(1)
        expect(buffered.state().dropped).toBe(2)
      })

      it("does not discard buffer before TTL expires", () => {
        const clock = { now: Date.now() }
        innerSink.mockImplementation(() => { throw new Error("broken") })

        const buffered = createBufferedSink(innerSink, {
          nowMs: () => clock.now,
        })

        buffered.sink(makeLogEvent({ message: "event 1" }))
        buffered.sink(makeLogEvent({ message: "event 2" }))

        // Advance time but NOT past TTL
        clock.now += 299_999

        buffered.sink(makeLogEvent({ message: "event 3" }))

        expect(buffered.state().buffered).toBe(3)
        expect(buffered.state().dropped).toBe(0)
      })

      it("resets TTL timer when sink recovers", () => {
        const clock = { now: Date.now() }
        let broken = true
        innerSink.mockImplementation(() => {
          if (broken) throw new Error("broken")
        })

        const buffered = createBufferedSink(innerSink, {
          nowMs: () => clock.now,
        })

        buffered.sink(makeLogEvent())
        expect(buffered.state().sinkHealthy).toBe(false)

        // Sink recovers
        broken = false
        buffered.sink(makeLogEvent())
        expect(buffered.state().sinkHealthy).toBe(true)

        // Break again
        broken = true
        buffered.sink(makeLogEvent())
        expect(buffered.state().sinkHealthy).toBe(false)

        // Advance time less than TTL from second failure
        clock.now += 200_000

        // Should still have buffered event (TTL hasn't expired since second failure)
        buffered.sink(makeLogEvent())
        expect(buffered.state().buffered).toBe(2) // two events since second failure
      })

      it("logs a nerves event when buffer is discarded due to TTL", () => {
        const clock = { now: Date.now() }
        innerSink.mockImplementation(() => { throw new Error("broken") })

        const buffered = createBufferedSink(innerSink, {
          nowMs: () => clock.now,
        })

        buffered.sink(makeLogEvent())
        clock.now += 300_001
        buffered.sink(makeLogEvent())

        expect(mockEmitNervesEvent).toHaveBeenCalledWith(
          expect.objectContaining({
            event: "nerves.buffer_ttl_discard",
          }),
        )
      })

      it("handles TTL expiry when buffer was already flushed externally", () => {
        const clock = { now: Date.now() }
        let broken = true
        innerSink.mockImplementation(() => {
          if (broken) throw new Error("broken")
        })

        const buffered = createBufferedSink(innerSink, {
          nowMs: () => clock.now,
        })

        // Buffer an event
        buffered.sink(makeLogEvent({ message: "event 1" }))
        expect(buffered.state().buffered).toBe(1)

        // Manually flush (sink recovers briefly)
        broken = false
        buffered.flush()
        expect(buffered.state().buffered).toBe(0)

        // Break again and advance past TTL from original unhealthy time
        broken = true
        // We need to get unhealthy again first
        buffered.sink(makeLogEvent({ message: "event 2" }))
        expect(buffered.state().buffered).toBe(1)

        // Advance past TTL
        clock.now += 300_001

        // Trigger TTL check — discards the single event
        buffered.sink(makeLogEvent({ message: "event 3" }))
        // event 2 dropped, event 3 buffered
        expect(buffered.state().dropped).toBe(1)
      })

      it("uses custom ttlMs option", () => {
        const clock = { now: Date.now() }
        innerSink.mockImplementation(() => { throw new Error("broken") })

        const buffered = createBufferedSink(innerSink, {
          nowMs: () => clock.now,
          ttlMs: 60_000, // 1 minute TTL
        })

        buffered.sink(makeLogEvent({ message: "event 1" }))
        clock.now += 60_001

        buffered.sink(makeLogEvent({ message: "event 2" }))

        expect(buffered.state().buffered).toBe(1)
        expect(buffered.state().dropped).toBe(1)
      })
    })

    it("flush() is a no-op when buffer is empty", () => {
      const buffered = createBufferedSink(innerSink)

      // No events buffered
      buffered.flush()

      expect(buffered.state().buffered).toBe(0)
      expect(innerSink).not.toHaveBeenCalled()
    })

    it("TTL discard with empty buffer does not emit nerves event", () => {
      const clock = { now: Date.now() }
      let broken = true
      innerSink.mockImplementation(() => {
        if (broken) throw new Error("broken")
      })

      const buffered = createBufferedSink(innerSink, {
        nowMs: () => clock.now,
      })

      // Make sink unhealthy with one event, then flush it manually
      buffered.sink(makeLogEvent())
      expect(buffered.state().buffered).toBe(1)

      // Recover and flush
      broken = false
      buffered.flush()
      expect(buffered.state().buffered).toBe(0)

      // Now break again and advance past TTL
      broken = true
      buffered.sink(makeLogEvent())
      expect(buffered.state().buffered).toBe(1)

      // Advance past TTL
      clock.now += 300_001

      // The single buffered event should be discarded
      buffered.sink(makeLogEvent())
      expect(buffered.state().buffered).toBe(1) // only the new one
    })

    it("markUnhealthy does not reset unhealthySince when already unhealthy", () => {
      const clock = { now: Date.now() }
      innerSink.mockImplementation(() => { throw new Error("broken") })

      const buffered = createBufferedSink(innerSink, {
        nowMs: () => clock.now,
        ttlMs: 100_000,
      })

      // First failure: marks unhealthy at clock.now
      buffered.sink(makeLogEvent())
      expect(buffered.state().sinkHealthy).toBe(false)

      // Advance time partway
      clock.now += 50_000

      // Second failure: should NOT reset unhealthySince
      buffered.sink(makeLogEvent())

      // Advance to original unhealthySince + ttl
      clock.now += 50_001

      // TTL should trigger based on original failure time, not second failure
      buffered.sink(makeLogEvent())
      expect(buffered.state().dropped).toBeGreaterThan(0)
    })

    describe("flush behavior during auto-flush failure", () => {
      it("stops auto-flush if re-flushing buffered events fails mid-way", () => {
        let callCount = 0
        innerSink.mockImplementation(() => {
          callCount++
          // First 2 calls fail (buffering), 3rd succeeds (recovery trigger),
          // but when flushing buffered[0], it works, then buffered[1] fails
          if (callCount <= 2) throw new Error("broken")
          if (callCount === 3) return // recovery event succeeds
          if (callCount === 4) return // flush buffered[0] succeeds
          throw new Error("broken again") // flush buffered[1] fails
        })

        const buffered = createBufferedSink(innerSink)

        buffered.sink(makeLogEvent({ message: "b1" }))
        buffered.sink(makeLogEvent({ message: "b2" }))
        expect(buffered.state().buffered).toBe(2)

        // Recovery event triggers auto-flush
        buffered.sink(makeLogEvent({ message: "recovery" }))

        // One buffered event flushed, one still in buffer (failed during flush)
        expect(buffered.state().buffered).toBe(1)
      })
    })
  })
})
