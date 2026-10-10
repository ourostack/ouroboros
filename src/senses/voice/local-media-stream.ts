import { EventEmitter } from "events"
import type { Readable } from "stream"
import { emitNervesEvent } from "../../nerves/runtime"
import { CaptureChunker, type PacedPlaybackQueue } from "./local-audio"
import type { VoiceSessionSocket } from "./twilio-phone"

export interface LocalMediaStreamSocketOptions {
  capture: Readable
  playback: PacedPlaybackQueue
  streamSid: string
  callSid: string
  onEnded: () => void
  /** Called for every captured 160-byte frame (activity and level tracking). */
  onCaptureFrame?: (frame: Buffer) => void
  /** Called with the byte length of every audio payload the session sends to play. */
  onPlaybackAudio?: (bytes: number) => void
}

const FRAME_MS = 20

/**
 * Speaks the Twilio Media Stream protocol in-process: captured audio becomes `start`, `media` and
 * `stop` messages for the session; the session's `media`, `clear` and `mark` messages drive the
 * paced playback queue. It sends no token and no identity parameters; identity is injected into
 * the session by whoever constructs it.
 */
export class LocalMediaStreamSocket extends EventEmitter implements VoiceSessionSocket {
  private opened = false
  private closed = false
  private sequence = 0
  private chunk = 0
  private readonly chunker: CaptureChunker
  private readonly onCaptureData = (data: Buffer): void => this.chunker.push(data)
  private readonly onCaptureEnd = (): void => this.endCapture()
  private readonly onCaptureError = (error: Error): void => {
    emitNervesEvent({
      level: "error",
      component: "senses",
      event: "senses.voice_local_capture_error",
      message: "local capture stream failed",
      meta: { callSid: this.options.callSid, error: error.message },
    })
    this.endCapture()
  }

  constructor(private readonly options: LocalMediaStreamSocketOptions) {
    super()
    this.chunker = new CaptureChunker((frame) => this.emitMedia(frame))
  }

  isOpen(): boolean {
    return this.opened && !this.closed
  }

  open(): void {
    if (this.opened || this.closed) return
    this.opened = true
    const { streamSid, callSid } = this.options
    this.options.playback.start()
    this.emitMessage({
      event: "start",
      start: {
        streamSid,
        callSid,
        tracks: ["inbound"],
        mediaFormat: { encoding: "audio/x-mulaw", sampleRate: 8000, channels: 1 },
      },
    })
    this.options.capture.on("data", this.onCaptureData)
    this.options.capture.on("end", this.onCaptureEnd)
    this.options.capture.on("close", this.onCaptureEnd)
    this.options.capture.on("error", this.onCaptureError)
    emitNervesEvent({
      component: "senses",
      event: "senses.voice_local_stream_opened",
      message: "local media stream opened",
      meta: { callSid, streamSid },
    })
  }

  send(data: string | Buffer): void {
    if (!this.isOpen()) return
    let message: unknown
    try {
      message = JSON.parse(data.toString())
    } catch {
      message = null
    }
    if (!message || typeof message !== "object") {
      emitNervesEvent({
        level: "warn",
        component: "senses",
        event: "senses.voice_local_stream_message_rejected",
        message: "local media stream ignored a message that was not a JSON object",
        meta: { callSid: this.options.callSid },
      })
      return
    }
    const { event, media, mark } = message as { event?: unknown; media?: { payload?: unknown }; mark?: { name?: unknown } }
    if (event === "media" && typeof media?.payload === "string") {
      const audio = Buffer.from(media.payload, "base64")
      this.options.onPlaybackAudio?.(audio.length)
      this.options.playback.enqueue(audio)
    } else if (event === "clear") {
      this.options.playback.clear()
    } else if (event === "mark" && typeof mark?.name === "string") {
      this.options.playback.mark(mark.name, (name) => {
        if (this.isOpen()) this.emitMessage({ event: "mark", mark: { name } })
      })
    }
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.options.capture.off("data", this.onCaptureData)
    this.options.capture.off("end", this.onCaptureEnd)
    this.options.capture.off("close", this.onCaptureEnd)
    this.options.capture.off("error", this.onCaptureError)
    this.options.playback.stop()
    emitNervesEvent({
      component: "senses",
      event: "senses.voice_local_stream_closed",
      message: "local media stream closed",
      meta: { callSid: this.options.callSid },
    })
    this.emit("close")
    this.options.onEnded()
  }

  private endCapture(): void {
    this.chunker.flush()
    this.emitMessage({ event: "stop", stop: { callSid: this.options.callSid } })
    this.close()
  }

  private emitMedia(frame: Buffer): void {
    this.chunk += 1
    this.options.onCaptureFrame?.(frame)
    this.emitMessage({
      event: "media",
      media: {
        track: "inbound",
        chunk: String(this.chunk),
        timestamp: String(this.chunk * FRAME_MS),
        payload: frame.toString("base64"),
      },
    })
  }

  private emitMessage(body: Record<string, unknown>): void {
    this.sequence += 1
    const message = { ...body, sequenceNumber: String(this.sequence), streamSid: this.options.streamSid }
    this.emit("message", Buffer.from(JSON.stringify(message)))
  }
}
