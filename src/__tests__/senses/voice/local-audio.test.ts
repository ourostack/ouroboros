import { PassThrough } from "stream"
import { describe, expect, it } from "vitest"
import {
  CaptureChunker,
  PacedFrameFeeder,
  mulawFrameRms,
  MULAW_FRAME_BYTES,
  MULAW_SILENCE_BYTE,
  PacedPlaybackQueue,
  isDigitalSilence,
  mulawToLinear,
} from "../../../senses/voice/local-audio"

function mulawEncode(sample: number): number {
  const BIAS = 0x84
  const CLIP = 32635
  let s = sample
  const sign = s < 0 ? 0x80 : 0
  if (s < 0) s = -s
  if (s > CLIP) s = CLIP
  s += BIAS
  let exponent = 7
  for (let mask = 0x4000; (s & mask) === 0 && exponent > 0; mask >>= 1) exponent--
  const mantissa = (s >> (exponent + 3)) & 0x0f
  return ~(sign | (exponent << 4) | mantissa) & 0xff
}

function tone(frames: number): Buffer {
  const out = Buffer.alloc(frames * MULAW_FRAME_BYTES)
  for (let i = 0; i < out.length; i++) {
    out[i] = mulawEncode(Math.round(12000 * Math.sin((2 * Math.PI * 440 * i) / 8000)))
  }
  return out
}

function loud(frames: number): Buffer {
  return Buffer.alloc(frames * MULAW_FRAME_BYTES, 0x10)
}

function makeHarness(options: { maxLeadMs?: number; outputLatencyMs?: number } = {}) {
  let clock = 0
  let nextHandle = 1
  const timers = new Map<number, { at: number; cb: () => void }>()
  const written: Array<{ at: number; frame: Buffer }> = []
  const queue = new PacedPlaybackQueue({
    write: (frame) => written.push({ at: clock, frame }),
    now: () => clock,
    setTimer: (cb, ms) => {
      const handle = nextHandle++
      timers.set(handle, { at: clock + ms, cb })
      return handle
    },
    clearTimer: (handle) => {
      timers.delete(handle as number)
    },
    ...options,
  })
  function advance(ms: number): void {
    const target = clock + ms
    for (;;) {
      let nextKey: number | undefined
      let nextAt = Infinity
      for (const [key, t] of timers) {
        if (t.at < nextAt) {
          nextAt = t.at
          nextKey = key
        }
      }
      if (nextKey === undefined || nextAt > target) break
      const t = timers.get(nextKey)!
      timers.delete(nextKey)
      clock = Math.max(clock, nextAt)
      t.cb()
    }
    clock = target
  }
  return {
    queue,
    written,
    timers,
    advance,
    setClock: (ms: number) => { clock = ms },
    now: () => clock,
  }
}

const isSilenceFrame = (frame: Buffer) => frame.length === MULAW_FRAME_BYTES && frame.every((b) => b === MULAW_SILENCE_BYTE)

describe("PacedPlaybackQueue", () => {
  it("writes 1 s of audio as 50 frames over 1 s, never more than 3 frames (60 ms) ahead", () => {
    const h = makeHarness()
    h.queue.start()
    h.queue.enqueue(loud(50))
    expect(h.queue.queuedMs()).toBe(1000)
    for (let t = 0; t <= 1100; t += 5) {
      h.advance(t === 0 ? 0 : 5)
      const lead = h.written.length * 20 - h.now()
      expect(lead).toBeLessThanOrEqual(60)
    }
    const audio = h.written.filter((w) => !isSilenceFrame(w.frame))
    expect(audio).toHaveLength(50)
    expect(h.written[0]!.frame.length).toBe(160)
    // 3 priming silence frames at start, then one audio frame per 20 ms tick
    expect(audio[0]!.at).toBe(20)
    expect(audio[49]!.at).toBe(1000)
    expect(h.queue.queuedMs()).toBe(0)
  })

  it("writes silence while idle so the timeline keeps advancing", () => {
    const h = makeHarness()
    h.queue.start()
    h.advance(1000)
    expect(h.written.length).toBe(53)
    expect(h.written.every((w) => isSilenceFrame(w.frame))).toBe(true)
    h.queue.enqueue(loud(1))
    h.advance(200)
    expect(h.written.filter((w) => !isSilenceFrame(w.frame))).toHaveLength(1)
  })

  it("start is idempotent and stop halts writes", () => {
    const h = makeHarness()
    h.queue.start()
    h.queue.start()
    h.advance(100)
    const count = h.written.length
    h.queue.stop()
    h.queue.stop()
    h.advance(1000)
    expect(h.written.length).toBe(count)
    expect(h.timers.size).toBe(0)
    h.queue.start()
    h.advance(100)
    expect(h.written.length).toBeGreaterThan(count)
  })

  it("clear after 500 ms of a 3 s clip stops the clip immediately, with at most 3 frames (60 ms) already written ahead", () => {
    const h = makeHarness()
    h.queue.start()
    h.queue.enqueue(loud(150))
    h.advance(500)
    const before = h.written.filter((w) => !isSilenceFrame(w.frame)).length
    const residualMs = h.written.length * 20 - 500
    h.queue.clear()
    expect(h.queue.queuedMs()).toBe(0)
    h.advance(3000)
    const after = h.written.filter((w) => !isSilenceFrame(w.frame)).length
    expect(after).toBe(before)
    expect(residualMs).toBeLessThanOrEqual(60)
  })

  it("pads a partial trailing frame with silence", () => {
    const h = makeHarness()
    h.queue.start()
    h.queue.enqueue(Buffer.alloc(100, 0x10))
    h.queue.enqueue(Buffer.alloc(0))
    h.advance(20)
    const padded = h.written.find((w) => !isSilenceFrame(w.frame))!.frame
    expect(padded.subarray(0, 100).every((b) => b === 0x10)).toBe(true)
    expect(padded.subarray(100).every((b) => b === MULAW_SILENCE_BYTE)).toBe(true)
  })

  it("fires marks in order when the playhead reaches the frame enqueued before them", () => {
    const h = makeHarness()
    const fired: Array<{ name: string; at: number }> = []
    const cb = (name: string) => fired.push({ name, at: h.now() })
    h.queue.start()
    h.queue.enqueue(loud(10))
    h.queue.mark("a", cb)
    h.queue.enqueue(loud(5))
    h.queue.mark("b", cb)
    h.advance(600)
    // 3 priming silence slots (60 ms), then 10 clip frames end at 260 ms and 5 more at 360 ms
    expect(fired).toEqual([{ name: "a", at: 260 }, { name: "b", at: 360 }])
  })

  it("fires a mark on an empty queue at the next tick", () => {
    const h = makeHarness()
    const fired: string[] = []
    h.queue.start()
    h.advance(0)
    h.queue.mark("m", (n) => fired.push(n))
    h.advance(20)
    expect(fired).toEqual([])
    h.advance(40)
    // the mark waits for the already-written silence to play out (playhead at 60 ms)
    expect(fired).toEqual(["m"])
  })

  it("delays marks by the output latency", () => {
    const h = makeHarness({ outputLatencyMs: 80 })
    const fired: Array<{ name: string; at: number }> = []
    h.queue.start()
    h.queue.enqueue(loud(2))
    h.queue.mark("a", (name) => fired.push({ name, at: h.now() }))
    h.advance(170)
    expect(fired).toEqual([])
    h.advance(20)
    // the second clip frame ends at 100 ms, plus 80 ms output latency
    expect(fired).toEqual([{ name: "a", at: 180 }])
  })

  it("clear fires pending marks immediately, including those waiting on output latency", () => {
    const h = makeHarness({ outputLatencyMs: 500 })
    const fired: string[] = []
    h.queue.start()
    h.queue.enqueue(loud(2))
    h.queue.mark("written", (n) => fired.push(n))
    h.advance(60)
    h.queue.enqueue(loud(100))
    h.queue.mark("queued", (n) => fired.push(n))
    h.queue.clear()
    expect(fired).toEqual(["written", "queued"])
    h.advance(1000)
    expect(fired).toEqual(["written", "queued"])
  })

  it("stop discards latency timers without firing marks", () => {
    const h = makeHarness({ outputLatencyMs: 500 })
    const fired: string[] = []
    h.queue.start()
    h.queue.enqueue(loud(1))
    h.queue.mark("x", (n) => fired.push(n))
    h.advance(60)
    h.queue.stop()
    h.advance(1000)
    expect(fired).toEqual([])
  })

  it("does not burst to catch up after the clock stalls", () => {
    const h = makeHarness()
    h.queue.start()
    h.queue.enqueue(loud(100))
    h.advance(100)
    const before = h.written.length
    h.setClock(h.now() + 2000)
    h.advance(20)
    expect(h.written.length - before).toBeLessThanOrEqual(4)
  })

  it("fires a mark at once when the playhead has already passed it", () => {
    const h = makeHarness()
    const fired: string[] = []
    h.queue.start()
    h.advance(100)
    h.setClock(h.now() + 2000)
    h.queue.mark("late", (n) => fired.push(n))
    h.advance(20)
    expect(fired).toEqual(["late"])
  })

  it("uses default lead and latency options", () => {
    let clock = 0
    const frames: Buffer[] = []
    const queue = new PacedPlaybackQueue({
      write: (f) => frames.push(f),
      now: () => clock,
      setTimer: () => 1,
      clearTimer: () => undefined,
    })
    queue.start()
    clock = 0
    expect(frames).toHaveLength(3)
  })
})

describe("PacedPlaybackQueue.drain", () => {
  it("resolves once every queued frame has been written, and not before", async () => {
    const h = makeHarness()
    h.queue.start()
    h.queue.enqueue(loud(10))
    let drained = false
    void h.queue.drain().then(() => { drained = true })
    await Promise.resolve()
    expect(drained).toBe(false)
    h.advance(100)
    await Promise.resolve()
    expect(drained).toBe(false)
    h.advance(200)
    await Promise.resolve()
    expect(drained).toBe(true)
    expect(h.written.filter((w) => !isSilenceFrame(w.frame))).toHaveLength(10)
  })

  it("resolves at once when nothing is queued or the queue is not running, and when it is stopped while waiting", async () => {
    const h = makeHarness()
    await h.queue.drain()
    h.queue.enqueue(loud(5))
    await h.queue.drain()
    h.queue.start()
    let drained = false
    void h.queue.drain().then(() => { drained = true })
    await Promise.resolve()
    expect(drained).toBe(false)
    h.queue.stop()
    await Promise.resolve()
    expect(drained).toBe(true)
  })
})

describe("CaptureChunker", () => {
  it("re-chunks arbitrary chunks into 160-byte frames and flush pads the remainder", () => {
    const frames: Buffer[] = []
    const chunker = new CaptureChunker((f) => frames.push(f))
    chunker.push(Buffer.alloc(100, 1))
    expect(frames).toHaveLength(0)
    chunker.push(Buffer.alloc(300, 2))
    expect(frames).toHaveLength(2)
    chunker.push(Buffer.alloc(45, 3))
    expect(frames).toHaveLength(2)
    expect(frames.every((f) => f.length === 160)).toBe(true)
    chunker.flush()
    expect(frames).toHaveLength(3)
    expect(frames[2]!.subarray(0, 125).every((b) => b === 2 || b === 3)).toBe(true)
    expect(frames[2]!.subarray(125).every((b) => b === MULAW_SILENCE_BYTE)).toBe(true)
    chunker.flush()
    expect(frames).toHaveLength(3)
  })
})

describe("isDigitalSilence", () => {
  it("is true for all-0xFF and all-0x7F frames and honors the threshold in linear PCM units", () => {
    expect(isDigitalSilence([Buffer.alloc(160, 0xff), Buffer.alloc(160, 0x7f)])).toBe(true)
    expect(isDigitalSilence([Buffer.from([0xfe, 0x7e])])).toBe(false)
    expect(isDigitalSilence([Buffer.from([0xfe, 0x7e])], 8)).toBe(true)
  })

  it("treats 0x80 and 0x81 (full-scale) as sound, not silence", () => {
    expect(isDigitalSilence([Buffer.alloc(160, 0x80)])).toBe(false)
    expect(isDigitalSilence([Buffer.alloc(160, 0x81)])).toBe(false)
    expect(mulawToLinear(0x00)).toBe(-32124)
    expect(mulawToLinear(0x80)).toBe(32124)
  })

  it("is false for a 440 Hz tone", () => {
    expect(isDigitalSilence([tone(2)])).toBe(false)
  })
})

describe("mulawFrameRms", () => {
  it("is zero for silence, large for loud audio, and zero for an empty frame", () => {
    expect(mulawFrameRms(Buffer.alloc(160, 0xff))).toBe(0)
    expect(mulawFrameRms(tone(1))).toBeGreaterThan(5000)
    expect(mulawFrameRms(Buffer.alloc(0))).toBe(0)
  })
})

describe("PacedFrameFeeder", () => {
  function setup() {
    let clock = 1000
    const timers: Array<{ at: number; cb: () => void; cleared: boolean }> = []
    const source = new PassThrough()
    const sink = new PassThrough()
    const frames: Buffer[] = []
    sink.on("data", (chunk: Buffer) => frames.push(chunk))
    const feeder = new PacedFrameFeeder({
      source,
      sink,
      now: () => clock,
      setTimer: (cb, ms) => { const t = { at: clock + ms, cb, cleared: false }; timers.push(t); return t },
      clearTimer: (h) => { (h as { cleared: boolean }).cleared = true },
    })
    const advance = (ms: number): void => {
      const target = clock + ms
      for (;;) {
        const due = timers.filter((t) => !t.cleared && t.at <= target).sort((a, b) => a.at - b.at)[0]
        if (!due) break
        due.cleared = true
        clock = Math.max(clock, due.at)
        due.cb()
      }
      clock = target
    }
    return { feeder, source, sink, frames, advance }
  }

  it("writes one frame per 20 ms: source audio first, then silence forever once the source ends", async () => {
    const { feeder, source, frames, advance } = setup()
    feeder.start()
    source.write(Buffer.alloc(300, 0x10))
    frames.length = 0
    advance(20)
    expect(frames.map((f) => f.length)).toEqual([160])
    expect(frames[0]!.every((b) => b === 0x10)).toBe(true)
    advance(20)
    expect(frames[1]!.subarray(0, 140).every((b) => b === 0x10)).toBe(true)
    expect(frames[1]!.subarray(140).every((b) => b === 0xff)).toBe(true)
    advance(60)
    expect(frames).toHaveLength(5)
    expect(frames.slice(2).every((f) => f.every((b) => b === 0xff))).toBe(true)
    expect(feeder.sourceDrained()).toBe(false)
    source.end()
    await new Promise((resolve) => setImmediate(resolve))
    expect(feeder.sourceDrained()).toBe(true)
  })

  it("never bursts to catch up after a stall, and stop ends the sink and the timer", () => {
    const { feeder, sink, frames, advance } = setup()
    feeder.start()
    feeder.start()
    advance(1000)
    const before = frames.length
    expect(before).toBeGreaterThanOrEqual(50)
    expect(before).toBeLessThanOrEqual(52)
    feeder.stop()
    feeder.stop()
    advance(100)
    expect(frames).toHaveLength(before)
    expect(sink.writableEnded).toBe(true)
  })

  it("tolerates a source that errors", () => {
    const { feeder, source, advance, frames } = setup()
    feeder.start()
    source.emit("error", new Error("sox died"))
    advance(40)
    expect(frames.length).toBeGreaterThanOrEqual(2)
    expect(feeder.sourceDrained()).toBe(true)
  })
})

describe("PacedFrameFeeder stall handling", () => {
  it("restarts the timeline after a long stall instead of writing a burst of catch-up frames", () => {
    let clock = 1000
    let pending: (() => void) | undefined
    const sink = new PassThrough()
    const frames: Buffer[] = []
    sink.on("data", (chunk: Buffer) => frames.push(chunk))
    const feeder = new PacedFrameFeeder({
      source: new PassThrough(), sink, now: () => clock,
      setTimer: (cb) => { pending = cb; return 1 }, clearTimer: () => undefined,
    })
    feeder.start()
    expect(frames).toHaveLength(1)
    clock += 5_000
    pending!()
    expect(frames).toHaveLength(2)
    feeder.stop()
  })
})
