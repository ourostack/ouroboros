import type { LogEvent, LogSink } from "./index"
import { emitNervesEvent } from "./runtime"

export interface BufferedSinkOptions {
  maxSize?: number
  ttlMs?: number
  nowMs?: () => number
}

export interface BufferedSinkState {
  buffered: number
  dropped: number
  sinkHealthy: boolean
}

export interface BufferedSink {
  sink: LogSink
  flush: () => void
  state: () => BufferedSinkState
}

const DEFAULT_MAX_SIZE = 1000
const DEFAULT_TTL_MS = 5 * 60 * 1000 // 5 minutes

export function createBufferedSink(inner: LogSink, options: BufferedSinkOptions = {}): BufferedSink {
  const maxSize = options.maxSize ?? DEFAULT_MAX_SIZE
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS
  const nowMs = options.nowMs ?? (() => Date.now())

  const buffer: LogEvent[] = []
  let dropped = 0
  let sinkHealthy = true
  let unhealthySince: number | null = null

  function tryInner(event: LogEvent): boolean {
    try {
      inner(event)
      return true
    } catch {
      return false
    }
  }

  function markUnhealthy(): void {
    sinkHealthy = false
    unhealthySince = unhealthySince ?? nowMs()
  }

  function markHealthy(): void {
    sinkHealthy = true
    unhealthySince = null
  }

  function discardBuffer(): void {
    const count = buffer.length
    dropped += count
    buffer.length = 0
    emitNervesEvent({
      component: "nerves",
      event: "nerves.buffer_ttl_discard",
      message: `discarded ${count} buffered events after TTL`,
      meta: { discarded: count, ttlMs },
    })
  }

  function checkTtl(): boolean {
    if (unhealthySince !== null && nowMs() - unhealthySince > ttlMs) {
      discardBuffer()
      // Reset unhealthySince to now so TTL starts fresh for newly buffered events
      unhealthySince = nowMs()
      return true
    }
    return false
  }

  function addToBuffer(event: LogEvent): void {
    if (buffer.length >= maxSize) {
      buffer.shift()
      dropped++
    }
    buffer.push(event)
  }

  function flushBuffer(): void {
    while (buffer.length > 0) {
      const event = buffer[0]
      if (tryInner(event)) {
        buffer.shift()
      } else {
        markUnhealthy()
        return
      }
    }
  }

  function sink(event: LogEvent): void {
    if (!sinkHealthy) {
      checkTtl()
      // Try sending the new event to see if inner has recovered
      if (tryInner(event)) {
        markHealthy()
        flushBuffer()
      } else {
        addToBuffer(event)
      }
      return
    }

    if (tryInner(event)) {
      return
    }

    // Inner failed
    markUnhealthy()
    addToBuffer(event)
  }

  function flush(): void {
    if (buffer.length === 0) return

    // Test if inner is recovered by trying the first buffered event
    const first = buffer[0]
    if (tryInner(first)) {
      buffer.shift()
      markHealthy()
      flushBuffer()
    }
    // If still broken, leave buffer intact
  }

  function state(): BufferedSinkState {
    return {
      buffered: buffer.length,
      dropped,
      sinkHealthy,
    }
  }

  return { sink, flush, state }
}
