import * as fs from "fs"
import { EventEmitter } from "events"
import * as os from "os"
import * as path from "path"
import { PassThrough } from "stream"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import * as nerves from "../../../nerves/runtime"
import type { VoiceCallIdentity } from "../../../senses/voice/call-auth"
import type { ChildProcessLike, LocalAudioProcessSpawner } from "../../../senses/voice/local-audio-devices"
import {
  LOCAL_AUDIO_MODE_LIMITS,
  defaultCreateSession,
  LocalAudioDeviceTransport,
  type LocalAudioJoinRequest,
  type LocalAudioTransportDeps,
} from "../../../senses/voice/local-audio-transport"
import type { LocalMediaStreamSocket } from "../../../senses/voice/local-media-stream"

class FakeChild extends EventEmitter implements ChildProcessLike {
  stdin = new PassThrough()
  stdout = new PassThrough()
  kills: string[] = []
  written: Buffer[] = []
  constructor(public pid: number | undefined, public args: string[]) {
    super()
    this.stdin.on("data", (chunk: Buffer) => this.written.push(chunk))
  }
  kill(signal: NodeJS.Signals): boolean {
    this.kills.push(signal)
    return true
  }
}

let dir: string
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "local-audio-transport-")) })
afterEach(() => { vi.restoreAllMocks(); fs.rmSync(dir, { recursive: true, force: true }) })

const LOUD = Buffer.alloc(160, 0x10)

function harness(options: { request?: Partial<LocalAudioJoinRequest>; inspectRouting?: LocalAudioTransportDeps["inspectRouting"]; routingOk?: boolean; probeHears?: boolean; apiKey?: string | null; killed?: number[]; swept?: () => void; muteSteps?: boolean } = {}) {
  let clock = 1_000_000
  const timers: Array<{ at: number; cb: () => void; cleared: boolean }> = []
  const children: FakeChild[] = []
  let nextPid = 5000
  const spawner: LocalAudioProcessSpawner = {
    spawn(_command, args) {
      const child = new FakeChild(nextPid++, args)
      children.push(child)
      // The probe's capture process hears the tone straight away unless told otherwise.
      if (args.includes("coreaudio") && args.includes("raw") && children.length === 1 && options.probeHears !== false) {
        queueMicrotask(() => child.stdout.write(Buffer.alloc(160, 0x20)))
      }
      return child
    },
  }
  const sessions: Array<{ socket: LocalMediaStreamSocket; identity: VoiceCallIdentity; ended: boolean; lifecycle: { onClose?: () => void; onDisclosureSpoken?: (atMs: number) => void; onDisclosureFailed?: () => void } | undefined; messages: any[] }> = []
  const killed: number[] = options.killed ?? []
  const deps: LocalAudioTransportDeps = {
    spawner,
    bridgeOptions: {
      agentName: "slugger", agentRoot: path.join(dir, "slugger.ouro"), publicBaseUrl: "https://x.test", outputDir: dir,
      transcriber: {} as never, tts: {} as never,
      ...(options.apiKey === null ? {} : { openaiRealtime: { apiKey: options.apiKey ?? "fixture-key" } }),
    },
    pidFile: path.join(dir, "sox.pids"),
    metadataDir: path.join(dir, "calls"),
    soxPath: "/opt/sox",
    inspectRouting: options.inspectRouting ?? (async () => ({ status: options.routingOk === false ? "needs_setup" : "ready", hasCaptureDevice: true, hasOutputDevice: true, currentOutput: null, missing: options.routingOk === false ? [] : [], guidance: [] })),
    queryMute: options.muteSteps ? async () => [{ device: "BlackHole 2ch", inputMuted: true, outputMuted: true }] : undefined,
    now: () => clock,
    setTimer: (cb, ms) => { const t = { at: clock + ms, cb, cleared: false }; timers.push(t); return t },
    clearTimer: (h) => { (h as { cleared: boolean }).cleared = true },
    killGroup: (pid) => { killed.push(pid); return true },
    inspectProcess: () => null,
    processHost: { pid: 1, once: () => undefined, off: () => undefined, kill: () => undefined },
    probeTimeoutMs: 1500,
    createSession: (socket, identity, _bridge, lifecycle) => {
      const entry = { socket: socket as unknown as LocalMediaStreamSocket, identity, ended: false, lifecycle, messages: [] as any[] }
      sessions.push(entry)
      return {
        attach: () => { socket.on("message", (raw: Buffer) => entry.messages.push(JSON.parse(raw.toString()))) },
        end: () => { entry.ended = true; socket.close() },
      }
    },
  }
  const request: LocalAudioJoinRequest = { agentName: "slugger", ...options.request }
  const transport = new LocalAudioDeviceTransport(request, deps)
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
  const tick = () => new Promise((resolve) => setImmediate(resolve))
  return { transport, deps, children, sessions, advance, tick, killed, timers, now: () => clock }
}

const events = () => (nerves.emitNervesEvent as unknown as { mock?: unknown }).mock

describe("LocalAudioDeviceTransport device mode", () => {
  it("checks routing, proves the capture loopback, then starts sox and the session with the stated identity", async () => {
    const h = harness({ request: { participants: "Ari, Sam", occasion: "podcast prep", ownerAlone: false, ownerName: "Ari", friendId: "ari" } })
    await h.transport.start()
    // probe listener, probe tone, live capture, live playback
    expect(h.children.map((c) => c.args.includes("synth") ? "tone" : c.args.includes("-") && c.args[0] === "-q" && c.args.includes("remix") ? "capture" : "other")).toEqual(["capture", "tone", "capture", "other"])
    expect(h.children[2]!.args).toContain("BlackHole 16ch")
    expect(h.children[3]!.args).toContain("BlackHole 2ch")
    expect(h.sessions).toHaveLength(1)
    const { identity } = h.sessions[0]!
    expect(identity).toMatchObject({
      agentName: "slugger", direction: "inbound", friendId: "ari",
      local: { mode: "conversation", ownerAlone: false, ownerName: "Ari", participants: "Ari, Sam", occasion: "podcast prep", disclosure: "spoken" },
    })
    expect(identity.callSid).toMatch(/^local-audio-[0-9a-f]{12}$/)
    expect(h.sessions[0]!.messages[0].event).toBe("start")
    expect(h.transport.status().state).toBe("joined")
  })

  it("forwards live capture to the session without consuming the first seconds", async () => {
    const h = harness()
    await h.transport.start()
    const live = h.children[2]!
    live.stdout.write(Buffer.concat([LOUD, LOUD]))
    await h.tick()
    expect(h.sessions[0]!.messages.filter((m) => m.event === "media")).toHaveLength(2)
  })

  it("plays the session's audio to the playback process through the paced queue", async () => {
    const h = harness()
    await h.transport.start()
    h.sessions[0]!.socket.send(JSON.stringify({ event: "media", media: { payload: Buffer.alloc(480, 0x20).toString("base64") } }))
    h.advance(200)
    const playback = h.children[3]!
    expect(Buffer.concat(playback.written).length).toBeGreaterThanOrEqual(480)
  })

  it("fails loudly with the exact steps when routing is not ready, and starts no sox", async () => {
    const h = harness({ routingOk: false })
    await expect(h.transport.start()).rejects.toThrow(/BlackHole 16ch/)
    expect(h.children).toHaveLength(0)
    expect(h.transport.status().state).toBe("failed")
  })

  it("fails loudly when a BlackHole device is muted", async () => {
    const h = harness({ muteSteps: true })
    await expect(h.transport.start()).rejects.toThrow(/BlackHole 2ch is muted \(input and output\)/)
    expect(h.children).toHaveLength(0)
  })

  it("fails the join when the capture probe hears nothing, naming both fixes, and cleans up", async () => {
    const h = harness({ probeHears: false })
    const started = h.transport.start()
    await h.tick()
    // The probe capture opens (a silent chunk arrives), the tone starts, and nothing is heard in time.
    h.children[0]!.stdout.write(Buffer.alloc(160, 0xff))
    await h.tick()
    h.advance(2000)
    await expect(started).rejects.toThrow(/muted[\s\S]*microphone permission/)
    expect(h.sessions).toHaveLength(0)
    expect(h.children).toHaveLength(2)
  })

  it("refuses to start without an OpenAI Realtime key", async () => {
    const h = harness({ apiKey: null })
    await expect(h.transport.start()).rejects.toThrow(/OpenAI Realtime/)
    expect(h.children).toHaveLength(0)
  })

  it("sweeps sox left behind by an earlier crashed run", async () => {
    fs.writeFileSync(path.join(dir, "sox.pids"), "99999\tT\n")
    const h = harness()
    const inspected: number[] = []
    h.deps.inspectProcess = (pid) => { inspected.push(pid); return null }
    await new LocalAudioDeviceTransport({ agentName: "slugger" }, h.deps).start()
    expect(inspected).toContain(99999)
  })

  it("refuses a second start", async () => {
    const h = harness()
    await h.transport.start()
    await expect(h.transport.start()).rejects.toThrow(/already/)
  })
})

describe("LocalAudioDeviceTransport ending", () => {
  it("leave stops sox, closes the session once, and resolves with the reason", async () => {
    const killed: number[] = []
    const h = harness({ killed })
    await h.transport.start()
    await h.transport.leave()
    await h.transport.leave()
    const summary = await h.transport.ended
    expect(summary.reason).toBe("left")
    expect(h.transport.status().state).toBe("ended")
    expect(killed.slice(-2)).toEqual([5002, 5003])
    expect(h.sessions[0]!.socket.isOpen()).toBe(false)
  })

  it("ends with agent_ended when the session hangs up", async () => {
    const h = harness()
    await h.transport.start()
    h.sessions[0]!.socket.close()
    expect((await h.transport.ended).reason).toBe("session_ended")
  })

  it("ends with capture_ended when sox capture exits", async () => {
    const h = harness()
    await h.transport.start()
    h.children[2]!.stdout.end()
    expect((await h.transport.ended).reason).toBe("capture_ended")
  })

  it("ends when the playback pipe breaks", async () => {
    const h = harness()
    await h.transport.start()
    h.children[3]!.stdin.emit("error", new Error("EPIPE"))
    expect((await h.transport.ended).reason).toBe("playback_failed")
  })

  it("ends after the mode's idle-silence cap and resets on speech and on the agent's own audio", async () => {
    const h = harness({ request: { idleSilenceMs: 10_000 } })
    await h.transport.start()
    const live = h.children[2]!
    h.advance(9_000)
    live.stdout.write(LOUD)
    await h.tick()
    h.advance(9_000)
    expect(h.transport.status().state).toBe("joined")
    h.sessions[0]!.socket.send(JSON.stringify({ event: "media", media: { payload: LOUD.toString("base64") } }))
    h.advance(9_000)
    expect(h.transport.status().state).toBe("joined")
    h.advance(2_000)
    expect((await h.transport.ended).reason).toBe("idle_silence")
  })

  it("does not count digital silence or background hiss as activity", async () => {
    const h = harness({ request: { idleSilenceMs: 5_000 } })
    await h.transport.start()
    const live = h.children[2]!
    for (let i = 0; i < 4; i++) {
      live.stdout.write(Buffer.alloc(160, 0xff))
      await h.tick()
      h.advance(1_000)
    }
    h.advance(1_500)
    expect((await h.transport.ended).reason).toBe("idle_silence")
  })

  it("ends at the mode's maximum duration even while people keep talking", async () => {
    const h = harness({ request: { idleSilenceMs: 60_000, maxDurationMs: 30_000 } })
    await h.transport.start()
    for (let i = 0; i < 4; i++) {
      h.children[2]!.stdout.write(LOUD)
      await h.tick()
      h.advance(10_000)
    }
    expect((await h.transport.ended).reason).toBe("max_duration")
  })

  it("has per-mode caps", () => {
    expect(LOCAL_AUDIO_MODE_LIMITS.conversation.idleSilenceMs).toBeGreaterThan(0)
    expect(LOCAL_AUDIO_MODE_LIMITS.conversation.maxDurationMs).toBeGreaterThan(LOCAL_AUDIO_MODE_LIMITS.conversation.idleSilenceMs)
  })

  it("reports how long after the last speech the first reply audio started", async () => {
    const spy = vi.spyOn(nerves, "emitNervesEvent")
    const h = harness()
    await h.transport.start()
    h.children[2]!.stdout.write(LOUD)
    await h.tick()
    h.advance(1_200)
    h.sessions[0]!.socket.send(JSON.stringify({ event: "media", media: { payload: LOUD.toString("base64") } }))
    h.sessions[0]!.socket.send(JSON.stringify({ event: "media", media: { payload: LOUD.toString("base64") } }))
    const latency = spy.mock.calls.map(([e]) => e as { event: string; meta?: { latencyMs?: number } }).filter((e) => e.event === "senses.voice_local_reply_latency")
    expect(latency).toHaveLength(1)
    expect(latency[0]!.meta!.latencyMs).toBe(1200)
  })
})

describe("LocalAudioDeviceTransport disclosure and call metadata", () => {
  it("records the owner's consent statement for a silent join in the call metadata", async () => {
    const h = harness({ request: { silentConsent: "Ari said both guests agreed to a silent assistant", friendId: "ari", ownerAlone: false } })
    await h.transport.start()
    expect(h.sessions[0]!.identity.local).toMatchObject({ disclosure: "silent", consentStatement: "Ari said both guests agreed to a silent assistant" })
    const file = path.join(dir, "calls", `${h.sessions[0]!.identity.callSid}.json`)
    const started = JSON.parse(fs.readFileSync(file, "utf8"))
    expect(started).toMatchObject({ transport: "local-audio", agentName: "slugger", disclosure: "silent", consentStatement: "Ari said both guests agreed to a silent assistant", friendId: "ari", mode: "conversation" })
    expect(started.endedAt).toBeUndefined()
    await h.transport.leave()
    await h.transport.ended
    const ended = JSON.parse(fs.readFileSync(file, "utf8"))
    expect(ended).toMatchObject({ endReason: "left" })
    expect(typeof ended.endedAt).toBe("string")
    expect(ended.durationMs).toBeGreaterThanOrEqual(0)
  })

  it("treats a blank consent statement as no consent: the join is spoken", async () => {
    const h = harness({ request: { silentConsent: "   " } })
    await h.transport.start()
    expect(h.sessions[0]!.identity.local!.disclosure).toBe("spoken")
    expect(h.sessions[0]!.identity.local!.consentStatement).toBeUndefined()
  })

  it("keeps working when the metadata directory cannot be written", async () => {
    const h = harness()
    h.deps.metadataDir = "/dev/null/nope"
    await h.transport.start()
    await h.transport.leave()
    expect((await h.transport.ended).reason).toBe("left")
  })
})

describe("LocalAudioDeviceTransport file-driven mode", () => {
  function fileHarness(extra: Partial<LocalAudioJoinRequest> = {}) {
    const h = harness({ request: { files: { inputPath: "/in/question.wav", outputPath: "/out/reply.wav" }, idleSilenceMs: 6_000, ...extra } })
    return h
  }

  it("skips routing and the probe, decodes the question file and records the reply to a file", async () => {
    const h = fileHarness()
    await h.transport.start()
    expect(h.children.map((c) => c.args)).toEqual([
      ["-q", "/in/question.wav", "-t", "raw", "-r", "8000", "-e", "mu-law", "-b", "8", "-c", "1", "-"],
      ["-q", "-t", "raw", "-r", "8000", "-e", "mu-law", "-b", "8", "-c", "1", "-", "-t", "wav", "/out/reply.wav"],
    ])
  })

  it("paces the file at real time, then keeps the room quiet until the idle cap ends the session", async () => {
    const h = fileHarness()
    await h.transport.start()
    h.children[0]!.stdout.write(Buffer.alloc(1600, 0x10))
    h.children[0]!.stdout.end()
    h.advance(100)
    const early = h.sessions[0]!.messages.filter((m) => m.event === "media").length
    expect(early).toBeGreaterThanOrEqual(5)
    expect(early).toBeLessThanOrEqual(7)
    h.advance(1_000)
    expect(h.sessions[0]!.messages.filter((m) => m.event === "media").length).toBeGreaterThanOrEqual(50)
    expect(h.transport.status().state).toBe("joined")
    h.advance(7_000)
    const summary = await h.transport.ended
    expect(summary.reason).toBe("idle_silence")
  })

  it("finishes the reply file gracefully before reporting the end", async () => {
    const h = fileHarness()
    await h.transport.start()
    const done = h.transport.leave()
    await h.tick()
    h.children[1]!.emit("exit", 0, null)
    await done
    expect((await h.transport.ended).reason).toBe("left")
  })
})

describe("LocalAudioDeviceTransport defaults and failure shapes", () => {
  it("reports a start failure that is not an Error", async () => {
    const h = harness()
    h.deps.createSession = () => { throw "plain failure" }
    await expect(h.transport.start()).rejects.toBe("plain failure")
    expect(h.transport.status().state).toBe("failed")
  })

  it("writes no call metadata when no directory is configured", async () => {
    const h = harness()
    h.deps.metadataDir = undefined
    await h.transport.start()
    expect(fs.existsSync(path.join(dir, "calls"))).toBe(false)
  })

  it("uses real timers and the real Realtime session by default, and ends when that session closes", async () => {
    const h = harness({ request: { idleSilenceMs: 60_000 } })
    const real = new LocalAudioDeviceTransport({ agentName: "slugger" }, {
      ...h.deps,
      setTimer: undefined,
      clearTimer: undefined,
      now: undefined,
      createSession: undefined,
      bridgeOptions: {
        ...h.deps.bridgeOptions,
        // Nothing listens here: the Realtime socket fails, which closes the session and ends the join.
        openaiRealtime: { apiKey: "fixture-key", websocketUrl: "ws://127.0.0.1:1" } as never,
      },
    })
    await real.start()
    const summary = await real.ended
    expect(summary.reason).toBe("session_ended")
  })

  it("builds the real session around the in-process socket", () => {
    const h = harness()
    const session = defaultCreateSession({ send: () => undefined, close: () => undefined, isOpen: () => false, on: () => undefined } as never, {} as never, h.deps.bridgeOptions, { onClose: () => undefined })
    expect(typeof session.attach).toBe("function")
    expect(typeof session.end).toBe("function")
  })
})


describe("LocalAudioDeviceTransport leave during startup", () => {
  it("leave while the probe is pending cancels the start, kills the probe and resolves ended (no live lane is left behind)", async () => {
    const killed: number[] = []
    const h = harness({ probeHears: false, killed })
    const starting = h.transport.start()
    await h.tick()
    await expect(h.transport.leave()).resolves.toBeUndefined()
    await expect(starting).resolves.toBeUndefined()
    expect(h.transport.status().state).toBe("ended")
    const summary = await h.transport.ended
    expect(summary).toMatchObject({ reason: "left", durationMs: 0 })
    expect(killed).toEqual([5000])
    // Even if the call audio shows up now, nothing starts: no tone, no live sox, no session.
    h.children[0]!.stdout.write(Buffer.alloc(160, 0x20))
    await h.tick()
    await h.tick()
    expect(h.children).toHaveLength(1)
    expect(h.sessions).toHaveLength(0)
    expect(h.transport.status().state).toBe("ended")
    // A second leave and a long wait change nothing (the reviewer's repro left a lane that never ended).
    await h.transport.leave()
    h.advance(10 * 60_000)
    expect(h.transport.status().state).toBe("ended")
    expect(fs.existsSync(path.join(dir, "calls"))).toBe(false)
  })

  it("leave while the routing check is pending stops the start before any sox is spawned", async () => {
    let release!: (value: Awaited<ReturnType<LocalAudioTransportDeps["inspectRouting"]>>) => void
    const h = harness({ inspectRouting: () => new Promise((resolve) => { release = resolve }) })
    const starting = h.transport.start()
    await h.tick()
    await h.transport.leave()
    release({ status: "ready", hasCaptureDevice: true, hasOutputDevice: true, currentOutput: null, missing: [], guidance: [] })
    await expect(starting).resolves.toBeUndefined()
    expect(h.children).toHaveLength(0)
    expect(h.sessions).toHaveLength(0)
    expect(h.transport.status().state).toBe("ended")
  })

  it("a start that fails after the leave does not turn the ended join into a failure", async () => {
    let fail!: (error: Error) => void
    const h = harness({ inspectRouting: () => new Promise((_resolve, reject) => { fail = reject }) })
    const starting = h.transport.start()
    await h.tick()
    await h.transport.leave()
    fail(new Error("inspection exploded"))
    await expect(starting).resolves.toBeUndefined()
    expect(h.transport.status().state).toBe("ended")
  })

  it("the maximum duration cap still ends a joined session", async () => {
    const h = harness({ request: { maxDurationMs: 30_000 } })
    await h.transport.start()
    h.advance(31_000)
    expect((await h.transport.ended).reason).toBe("max_duration")
  })
})

describe("LocalAudioDeviceTransport disclosure, consent record and latency metadata", () => {
  it("records when the disclosure was spoken, and the output latency estimate it used", async () => {
    const h = harness({ request: { friendId: "ari" } })
    await h.transport.start()
    const file = path.join(dir, "calls", `${h.sessions[0]!.identity.callSid}.json`)
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toMatchObject({ disclosureSpokenAt: null, outputLatencyMs: 40, outputLatencyMeasured: false })
    h.sessions[0]!.lifecycle!.onDisclosureSpoken!(Date.parse("2026-10-09T12:00:00.000Z"))
    expect(JSON.parse(fs.readFileSync(file, "utf8")).disclosureSpokenAt).toBe("2026-10-09T12:00:00.000Z")
  })

  it("uses the configured output latency and records it", async () => {
    const h = harness()
    h.deps.outputLatencyMs = 90
    const transport = new LocalAudioDeviceTransport({ agentName: "slugger" }, h.deps)
    await transport.start()
    const file = path.join(dir, "calls", `${h.sessions[0]!.identity.callSid}.json`)
    expect(JSON.parse(fs.readFileSync(file, "utf8")).outputLatencyMs).toBe(90)
  })

  it("leaves with disclosure_failed when the notice could not be spoken in time", async () => {
    const h = harness()
    await h.transport.start()
    h.sessions[0]!.lifecycle!.onDisclosureFailed!()
    const summary = await h.transport.ended
    expect(summary.reason).toBe("disclosure_failed")
  })

  it("does not wait for a disclosure on a silent join", async () => {
    const h = harness({ request: { silentConsent: "Ari said everyone agreed" } })
    await h.transport.start()
    const file = path.join(dir, "calls", `${h.sessions[0]!.identity.callSid}.json`)
    expect(JSON.parse(fs.readFileSync(file, "utf8")).disclosureSpokenAt).toBeNull()
  })

  it("fails a silent join, and stops its sox, when the consent record cannot be written", async () => {
    const killed: number[] = []
    const h = harness({ request: { silentConsent: "Ari said everyone agreed" }, killed })
    h.deps.metadataDir = "/dev/null/nope"
    await expect(h.transport.start()).rejects.toThrow(/could not record the owner's consent/)
    expect(h.transport.status().state).toBe("failed")
    expect(h.sessions).toHaveLength(0)
    // Nothing live was started: only the probe's two processes ever existed, and they are stopped.
    expect(h.children).toHaveLength(2)
    expect(killed).toEqual([5000, 5001])
  })

  it("fails a silent join when no place to record the consent is configured", async () => {
    const h = harness({ request: { silentConsent: "Ari said everyone agreed" } })
    h.deps.metadataDir = undefined
    await expect(h.transport.start()).rejects.toThrow(/could not record the owner's consent/)
  })
})

describe("LocalAudioDeviceTransport file mode drains the reply before finishing", () => {
  function fileHarness() {
    return harness({ request: { files: { inputPath: "/in/question.wav", outputPath: "/out/reply.wav" }, idleSilenceMs: 60_000 } })
  }
  const reply = () => JSON.stringify({ event: "media", media: { payload: Buffer.alloc(1600, 0x20).toString("base64") } })

  it("plays the whole queued reply to the file before the writer is closed", async () => {
    const h = fileHarness()
    await h.transport.start()
    h.sessions[0]!.socket.send(reply())
    let done = false
    const leaving = h.transport.leave().then(() => { done = true })
    await h.tick()
    expect(done).toBe(false)
    expect(h.transport.status().state).toBe("joined")
    h.advance(400)
    await h.tick()
    expect(Buffer.concat(h.children[1]!.written).filter((b) => b === 0x20).length).toBe(1600)
    h.children[1]!.emit("exit", 0, null)
    await leaving
    expect(done).toBe(true)
    expect(h.transport.status().state).toBe("ended")
  })

  it("stops waiting for the reply after a cap, and a second leave waits for the same finish", async () => {
    const h = fileHarness()
    await h.transport.start()
    // 40 s of reply audio: still queued when the 30 s cap passes.
    h.sessions[0]!.socket.send(JSON.stringify({ event: "media", media: { payload: Buffer.alloc(320_000, 0x20).toString("base64") } }))
    const first = h.transport.leave()
    const second = h.transport.leave()
    h.advance(31_000)
    await h.tick()
    expect(h.transport.status().state).toBe("ended")
    h.children[1]!.emit("exit", 0, null)
    await Promise.all([first, second])
    expect(Buffer.concat(h.children[1]!.written).filter((b) => b === 0x20).length).toBeLessThan(320_000)
  })

  it("does not wait for the queue in device mode", async () => {
    const h = harness()
    await h.transport.start()
    h.sessions[0]!.socket.send(JSON.stringify({ event: "media", media: { payload: Buffer.alloc(1600, 0x20).toString("base64") } }))
    await h.transport.leave()
    expect(h.transport.status().state).toBe("ended")
  })
})
