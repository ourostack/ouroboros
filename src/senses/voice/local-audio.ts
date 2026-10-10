import type { Readable, Writable } from "stream"
import { emitNervesEvent } from "../../nerves/runtime"

/** 20 ms of 8 kHz mu-law audio. */
export const MULAW_FRAME_BYTES = 160
/** mu-law encoding of zero amplitude. */
export const MULAW_SILENCE_BYTE = 0xff

const FRAME_MS = 20
const DEFAULT_MAX_LEAD_MS = 60

export interface PacedPlaybackQueueOptions {
  write: (frame: Buffer) => void
  now: () => number
  setTimer: (cb: () => void, ms: number) => unknown
  clearTimer: (handle: unknown) => void
  /** How far ahead of the clock frames may be written. Default 60. */
  maxLeadMs?: number
  /** Measured device output latency added before a mark fires. Default 0. */
  outputLatencyMs?: number
}

type QueueItem =
  | { kind: "frame"; frame: Buffer }
  | { kind: "mark"; name: string; onPlayed: (name: string) => void }

interface PendingMark {
  name: string
  onPlayed: (name: string) => void
  timer: unknown
}

function silenceFrame(): Buffer {
  return Buffer.alloc(MULAW_FRAME_BYTES, MULAW_SILENCE_BYTE)
}

/**
 * Writes one 160-byte mu-law frame per 20 ms to a sink in real time, never more than
 * `maxLeadMs` ahead of the clock. Idle periods write silence so the timeline (and mark
 * delivery) keeps advancing.
 */
export class PacedPlaybackQueue {
  private readonly items: QueueItem[] = []
  private readonly pendingMarks = new Set<PendingMark>()
  private readonly maxLeadMs: number
  private readonly outputLatencyMs: number
  private running = false
  private drainWaiters: Array<() => void> = []
  private timer: unknown = undefined
  private nextDue = 0

  constructor(private readonly options: PacedPlaybackQueueOptions) {
    this.maxLeadMs = options.maxLeadMs ?? DEFAULT_MAX_LEAD_MS
    this.outputLatencyMs = options.outputLatencyMs ?? 0
  }

  start(): void {
    if (this.running) return
    this.running = true
    this.nextDue = this.options.now()
    emitNervesEvent({
      component: "senses",
      event: "senses.voice_local_playback_started",
      message: "local paced playback queue started",
      meta: { maxLeadMs: this.maxLeadMs, outputLatencyMs: this.outputLatencyMs },
    })
    this.tick()
  }

  stop(): void {
    if (!this.running) return
    this.running = false
    this.options.clearTimer(this.timer)
    this.timer = undefined
    for (const pending of this.pendingMarks) this.options.clearTimer(pending.timer)
    this.pendingMarks.clear()
    this.items.length = 0
    this.releaseDrainWaiters()
  }

  /** Resolves once every queued frame has been written (or the queue stopped), so a file output gets the whole reply. */
  drain(): Promise<void> {
    if (!this.running || !this.hasQueuedFrames()) return Promise.resolve()
    return new Promise((resolve) => { this.drainWaiters.push(resolve) })
  }

  enqueue(payload: Buffer): void {
    for (let offset = 0; offset < payload.length; offset += MULAW_FRAME_BYTES) {
      const slice = payload.subarray(offset, offset + MULAW_FRAME_BYTES)
      const frame = slice.length === MULAW_FRAME_BYTES
        ? Buffer.from(slice)
        : Buffer.concat([slice, Buffer.alloc(MULAW_FRAME_BYTES - slice.length, MULAW_SILENCE_BYTE)])
      this.items.push({ kind: "frame", frame })
    }
  }

  mark(name: string, onPlayed: (name: string) => void): void {
    this.items.push({ kind: "mark", name, onPlayed })
  }

  /** Drops queued audio and fires every pending mark now (Twilio returns marks on clear). */
  clear(): void {
    const dropped = this.items.splice(0)
    const firing: Array<{ name: string; onPlayed: (name: string) => void }> = []
    for (const pending of this.pendingMarks) {
      this.options.clearTimer(pending.timer)
      firing.push(pending)
    }
    this.pendingMarks.clear()
    for (const item of dropped) {
      if (item.kind === "mark") firing.push(item)
    }
    emitNervesEvent({
      component: "senses",
      event: "senses.voice_local_playback_cleared",
      message: "local paced playback queue cleared",
      meta: { droppedFrames: dropped.filter((item) => item.kind === "frame").length, firedMarks: firing.length },
    })
    for (const mark of firing) mark.onPlayed(mark.name)
  }

  queuedMs(): number {
    return this.items.filter((item) => item.kind === "frame").length * FRAME_MS
  }

  private tick(): void {
    const now = this.options.now()
    // Underrun (event loop stall): restart the timeline instead of bursting to catch up.
    if (this.nextDue < now) this.nextDue = now
    for (;;) {
      this.drainMarks()
      if (this.nextDue + FRAME_MS - now > this.maxLeadMs) break
      const head = this.items[0]
      if (head && head.kind === "frame") {
        this.items.shift()
        this.options.write(head.frame)
      } else {
        this.options.write(silenceFrame())
      }
      this.nextDue += FRAME_MS
    }
    if (!this.hasQueuedFrames()) this.releaseDrainWaiters()
    this.timer = this.options.setTimer(() => this.tick(), this.nextDue + FRAME_MS - this.maxLeadMs - now)
  }

  private hasQueuedFrames(): boolean {
    return this.items.some((item) => item.kind === "frame")
  }

  private releaseDrainWaiters(): void {
    const waiters = this.drainWaiters
    this.drainWaiters = []
    for (const resolve of waiters) resolve()
  }

  private drainMarks(): void {
    for (;;) {
      const head = this.items[0]
      if (!head || head.kind !== "mark") return
      this.items.shift()
      // `nextDue` is the playhead: the scheduled end of the last frame written before this mark.
      const delay = this.nextDue + this.outputLatencyMs - this.options.now()
      if (delay <= 0) {
        head.onPlayed(head.name)
        continue
      }
      const pending: PendingMark = { name: head.name, onPlayed: head.onPlayed, timer: undefined }
      pending.timer = this.options.setTimer(() => {
        this.pendingMarks.delete(pending)
        pending.onPlayed(pending.name)
      }, delay)
      this.pendingMarks.add(pending)
    }
  }
}

/** Re-chunks arbitrary byte chunks into 160-byte frames. */
export class CaptureChunker {
  private pending: Buffer = Buffer.alloc(0)

  constructor(private readonly onFrame: (frame: Buffer) => void) {}

  push(chunk: Buffer): void {
    this.pending = this.pending.length === 0 ? chunk : Buffer.concat([this.pending, chunk])
    while (this.pending.length >= MULAW_FRAME_BYTES) {
      this.onFrame(Buffer.from(this.pending.subarray(0, MULAW_FRAME_BYTES)))
      this.pending = this.pending.subarray(MULAW_FRAME_BYTES)
    }
  }

  /** Emits any remainder padded with silence. */
  flush(): void {
    if (this.pending.length === 0) return
    const padded = Buffer.concat([this.pending, Buffer.alloc(MULAW_FRAME_BYTES - this.pending.length, MULAW_SILENCE_BYTE)])
    this.pending = Buffer.alloc(0)
    this.onFrame(padded)
  }
}

/** Decodes one mu-law byte to 16-bit linear PCM (G.711). Both zero codes (0xff, 0x7f) decode to 0. */
export function mulawToLinear(byte: number): number {
  const inverted = ~byte & 0xff
  const exponent = (inverted >> 4) & 0x07
  const mantissa = inverted & 0x0f
  const magnitude = (((mantissa << 3) + 0x84) << exponent) - 0x84
  return inverted & 0x80 ? -magnitude : magnitude
}

/** True when every byte decodes to linear PCM within `threshold` of zero. */
export function isDigitalSilence(frames: Buffer[], threshold = 2): boolean {
  for (const frame of frames) {
    for (const byte of frame) {
      if (Math.abs(mulawToLinear(byte)) > threshold) return false
    }
  }
  return true
}

/** Root-mean-square level of a mu-law frame in 16-bit linear units. */
export function mulawFrameRms(frame: Buffer): number {
  if (frame.length === 0) return 0
  let sum = 0
  for (const byte of frame) {
    const sample = mulawToLinear(byte)
    sum += sample * sample
  }
  return Math.sqrt(sum / frame.length)
}

export interface PacedFrameFeederOptions {
  source: Readable
  sink: Writable
  now: () => number
  setTimer: (cb: () => void, ms: number) => unknown
  clearTimer: (handle: unknown) => void
}

/**
 * Turns a fast source (sox decoding a recorded file) into a real-time capture stream: one 160-byte
 * frame per 20 ms, then silence for as long as it runs, like a quiet room. This is the file-driven
 * "microphone" for tests without a human.
 */
export class PacedFrameFeeder {
  private buffered: Buffer = Buffer.alloc(0)
  private drained = false
  private running = false
  private timer: unknown = undefined
  private nextDue = 0
  private readonly onData = (chunk: Buffer): void => {
    this.buffered = Buffer.concat([this.buffered, chunk])
  }
  private readonly onEnd = (): void => {
    this.drained = true
  }

  constructor(private readonly options: PacedFrameFeederOptions) {}

  sourceDrained(): boolean {
    return this.drained && this.buffered.length === 0
  }

  start(): void {
    if (this.running) return
    this.running = true
    this.nextDue = this.options.now()
    this.options.source.on("data", this.onData)
    this.options.source.on("end", this.onEnd)
    this.options.source.on("error", this.onEnd)
    emitNervesEvent({
      component: "senses",
      event: "senses.voice_local_file_capture_started",
      message: "paced file capture started",
      meta: {},
    })
    this.tick()
  }

  stop(): void {
    if (!this.running) return
    this.running = false
    this.options.clearTimer(this.timer)
    this.options.source.off("data", this.onData)
    this.options.source.off("end", this.onEnd)
    this.options.source.off("error", this.onEnd)
    this.options.sink.end()
  }

  private tick(): void {
    const now = this.options.now()
    // Stall: restart the timeline instead of bursting.
    if (this.nextDue < now - FRAME_MS * 5) this.nextDue = now
    while (this.nextDue <= now) {
      this.options.sink.write(this.nextFrame())
      this.nextDue += FRAME_MS
    }
    this.timer = this.options.setTimer(() => this.tick(), this.nextDue - now)
  }

  private nextFrame(): Buffer {
    const take = Math.min(this.buffered.length, MULAW_FRAME_BYTES)
    const frame = Buffer.alloc(MULAW_FRAME_BYTES, MULAW_SILENCE_BYTE)
    this.buffered.copy(frame, 0, 0, take)
    this.buffered = this.buffered.subarray(take)
    return frame
  }
}
