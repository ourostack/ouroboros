import { PassThrough } from "stream"
import { describe, expect, it } from "vitest"
import { PacedPlaybackQueue } from "../../../senses/voice/local-audio"
import { LocalMediaStreamSocket } from "../../../senses/voice/local-media-stream"
import type { VoiceSessionSocket } from "../../../senses/voice/twilio-phone"

function setup() {
  const capture = new PassThrough()
  const calls: string[] = []
  const playback = {
    start: () => calls.push("start"),
    stop: () => calls.push("stop"),
    enqueue: (b: Buffer) => calls.push(`enqueue:${b.length}`),
    clear: () => calls.push("clear"),
    mark: (name: string, cb: (n: string) => void) => { calls.push(`mark:${name}`); marks.push(cb) },
  } as unknown as PacedPlaybackQueue
  const marks: Array<(n: string) => void> = []
  let ended = 0
  const socket = new LocalMediaStreamSocket({ capture, playback, streamSid: "MZlocal", callSid: "CAlocal", onEnded: () => { ended++ } })
  const messages: any[] = []
  socket.on("message", (raw: Buffer) => messages.push(JSON.parse(raw.toString())))
  let closeEvents = 0
  socket.on("close", () => { closeEvents++ })
  return { socket, capture, calls, marks, messages, ended: () => ended, closeEvents: () => closeEvents }
}

const flush = () => new Promise((resolve) => setImmediate(resolve))

describe("LocalMediaStreamSocket", () => {
  it("satisfies the narrow session socket interface", () => {
    const { socket } = setup()
    const narrow: VoiceSessionSocket = socket
    expect(narrow.isOpen()).toBe(false)
  })

  it("emits a start message with no token or identity parameters, and starts playback", () => {
    const { socket, messages, calls } = setup()
    socket.open()
    socket.open()
    expect(socket.isOpen()).toBe(true)
    expect(calls).toEqual(["start"])
    expect(messages).toHaveLength(1)
    expect(messages[0]).toMatchObject({
      event: "start",
      streamSid: "MZlocal",
      start: { streamSid: "MZlocal", callSid: "CAlocal", tracks: ["inbound"], mediaFormat: { encoding: "audio/x-mulaw", sampleRate: 8000, channels: 1 } },
    })
    expect(messages[0].start.customParameters).toBeUndefined()
    expect(JSON.stringify(messages[0])).not.toMatch(/token|friend/i)
  })

  it("emits one media message per 160-byte frame with increasing timestamps", async () => {
    const { socket, capture, messages } = setup()
    socket.open()
    capture.write(Buffer.alloc(100, 1))
    capture.write(Buffer.alloc(300, 2))
    await flush()
    const media = messages.filter((m) => m.event === "media")
    expect(media).toHaveLength(2)
    expect(Buffer.from(media[0].media.payload, "base64")).toHaveLength(160)
    expect(media[0].media.track).toBe("inbound")
    expect(Number(media[1].media.timestamp)).toBeGreaterThan(Number(media[0].media.timestamp))
    expect(Number(media[1].sequenceNumber)).toBeGreaterThan(Number(media[0].sequenceNumber))
  })

  it("flushes the remainder, emits stop, closes and reports ended once when capture ends", async () => {
    const { socket, capture, messages, ended, closeEvents, calls } = setup()
    socket.open()
    capture.write(Buffer.alloc(200, 3))
    capture.end()
    await flush()
    expect(messages.map((m) => m.event)).toEqual(["start", "media", "media", "stop"])
    expect(messages[3].stop.callSid).toBe("CAlocal")
    expect(socket.isOpen()).toBe(false)
    expect(ended()).toBe(1)
    expect(closeEvents()).toBe(1)
    expect(calls.at(-1)).toBe("stop")
    socket.close()
    expect(ended()).toBe(1)
  })

  it("treats a capture error as the end of the stream", async () => {
    const { socket, capture, messages, ended } = setup()
    socket.open()
    capture.destroy(new Error("sox died"))
    await flush()
    expect(messages.at(-1).event).toBe("stop")
    expect(ended()).toBe(1)
    expect(socket.isOpen()).toBe(false)
  })

  it("ignores a stop-triggered close from the session during the capture-end handler", async () => {
    const { socket, capture, ended } = setup()
    socket.on("message", (raw: Buffer) => { if (JSON.parse(raw.toString()).event === "stop") socket.close() })
    socket.open()
    capture.end()
    await flush()
    expect(ended()).toBe(1)
  })

  it("routes media, clear and mark messages to the playback queue and echoes marks", () => {
    const { socket, calls, marks, messages } = setup()
    socket.open()
    socket.send(JSON.stringify({ event: "media", streamSid: "MZlocal", media: { payload: Buffer.alloc(320, 9).toString("base64") } }))
    socket.send(Buffer.from(JSON.stringify({ event: "mark", streamSid: "MZlocal", mark: { name: "rt-1" } })))
    socket.send(JSON.stringify({ event: "clear", streamSid: "MZlocal" }))
    expect(calls).toEqual(["start", "enqueue:320", "mark:rt-1", "clear"])
    marks[0]!("rt-1")
    expect(messages.at(-1)).toMatchObject({ event: "mark", mark: { name: "rt-1" }, streamSid: "MZlocal" })
  })

  it("ignores malformed, unknown and incomplete messages", () => {
    const { socket, calls, messages } = setup()
    socket.open()
    for (const bad of ["not json", "null", "5", JSON.stringify({ event: "media", media: {} }), JSON.stringify({ event: "mark", mark: {} }), JSON.stringify({ event: "nope" }), JSON.stringify({})]) {
      socket.send(bad)
    }
    expect(calls).toEqual(["start"])
    expect(messages).toHaveLength(1)
  })

  it("ignores sends before open and after close, and does not echo marks after close", () => {
    const { socket, calls, marks, messages } = setup()
    socket.send(JSON.stringify({ event: "clear" }))
    socket.open()
    socket.send(JSON.stringify({ event: "mark", mark: { name: "m" } }))
    socket.close()
    marks[0]!("m")
    socket.send(JSON.stringify({ event: "clear" }))
    socket.open()
    expect(calls).toEqual(["start", "mark:m", "stop"])
    expect(messages.map((m) => m.event)).toEqual(["start"])
  })

  it("close stops listening to capture", async () => {
    const { socket, capture, messages } = setup()
    socket.open()
    socket.close()
    capture.write(Buffer.alloc(160))
    capture.emit("end")
    await flush()
    expect(messages.map((m) => m.event)).toEqual(["start"])
  })
})

describe("LocalMediaStreamSocket activity hooks", () => {
  it("reports every captured frame and every audio payload played, and tolerates missing hooks", async () => {
    const capture = new PassThrough()
    const frames: number[] = []
    const played: number[] = []
    const playback = { start: () => undefined, stop: () => undefined, enqueue: () => undefined, clear: () => undefined, mark: () => undefined } as unknown as PacedPlaybackQueue
    const socket = new LocalMediaStreamSocket({
      capture, playback, streamSid: "MZ", callSid: "CA", onEnded: () => undefined,
      onCaptureFrame: (frame) => frames.push(frame.length),
      onPlaybackAudio: (bytes) => played.push(bytes),
    })
    socket.open()
    capture.write(Buffer.alloc(320, 1))
    await flush()
    socket.send(JSON.stringify({ event: "media", media: { payload: Buffer.alloc(480).toString("base64") } }))
    expect(frames).toEqual([160, 160])
    expect(played).toEqual([480])
  })
})
