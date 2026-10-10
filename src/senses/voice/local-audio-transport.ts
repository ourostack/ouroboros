import * as crypto from "node:crypto"
import * as fs from "fs"
import * as path from "path"
import { PassThrough, type Readable } from "stream"
import { emitNervesEvent } from "../../nerves/runtime"
import type { inspectVoiceAudioRouting } from "./audio-routing"
import type { LocalAudioCallInfo, LocalAudioMode, VoiceCallIdentity } from "./call-auth"
import { PacedFrameFeeder, PacedPlaybackQueue, mulawFrameRms } from "./local-audio"
import {
  CAPTURE_DEVICE_NAME,
  LocalAudioDevices,
  PLAYBACK_DEVICE_NAME,
  checkLocalAudioRouting,
  fileCaptureArgs,
  filePlaybackArgs,
  probeCaptureLoopback,
  soxCaptureArgs,
  defaultListAudioToolboxDevices,
  ffmpegPlaybackArgs,
  findAudioToolboxDeviceIndex,
  type LocalAudioProcessSpawner,
  type ProcessInfo,
  type ProcessSignalHost,
} from "./local-audio-devices"
import type { MuteQuery } from "./local-audio-mute"
import { sanitizeRoomText } from "./local-audio-prompts"
import { LocalMediaStreamSocket } from "./local-media-stream"
import { TwilioOpenAIRealtimeMediaStreamSession, type TwilioPhoneBridgeOptions, type VoiceSessionSocket } from "./twilio-phone"

/** Per-mode caps. Group and listen modes (a later change) add their own entries. */
export const LOCAL_AUDIO_MODE_LIMITS: Record<LocalAudioMode, { idleSilenceMs: number; maxDurationMs: number }> = {
  conversation: { idleSilenceMs: 5 * 60_000, maxDurationMs: 2 * 60 * 60_000 },
}

/** Speech or room noise above this level counts as activity for idle-silence detection. */
const ACTIVITY_RMS = 300
const IDLE_CHECK_MS = 1_000
/**
 * Added before a mark is echoed: sox buffer plus BlackHole's own buffering. This is an estimate, not a
 * measurement; `outputLatencyMs` in the transport deps overrides it, and the value used is recorded in
 * the call metadata.
 */
export const DEFAULT_DEVICE_OUTPUT_LATENCY_MS = 40
/** A file-driven reply is drained before the writer closes, but never for longer than this. */
const FILE_DRAIN_CAP_MS = 30_000
const MAX_CONSENT_CHARS = 500

export type LocalAudioEndReason =
  | "left"
  | "session_ended"
  | "capture_ended"
  | "playback_failed"
  | "idle_silence"
  | "max_duration"
  | "disclosure_failed"

export interface LocalAudioJoinRequest {
  agentName: string
  /** An exact friend id from the join request (never a display name). */
  friendId?: string
  participants?: string
  occasion?: string
  mode?: LocalAudioMode
  /** The join says the room is the owner alone. Only then may trust rise above acquaintance. */
  ownerAlone?: boolean
  ownerName?: string
  /** The owner's explicit statement that participants consented to a silent join. */
  silentConsent?: string
  /** Where to tell the owner when the join starts and stops. */
  notify?: { friendId: string; channel: string; key: string }
  /** File-driven mode: capture from a recording, play to a WAV file, paced at real time. */
  files?: { inputPath: string; outputPath: string }
  idleSilenceMs?: number
  maxDurationMs?: number
}

export type LocalAudioState = "idle" | "starting" | "joined" | "ended" | "failed"

export interface LocalAudioStatus {
  state: LocalAudioState
  callSid: string
  startedAt?: string
  endedAt?: string
  endReason?: LocalAudioEndReason
}

export interface LocalAudioEndSummary {
  reason: LocalAudioEndReason
  callSid: string
  durationMs: number
}

interface LifecycleSession {
  attach(): void
  end(): void
}

export interface LocalAudioTransportDeps {
  spawner: LocalAudioProcessSpawner
  bridgeOptions: TwilioPhoneBridgeOptions
  pidFile: string
  metadataDir?: string
  soxPath?: string
  /** ffmpeg plays live audio (sox's CoreAudio output can deadlock at low priority). Default "ffmpeg" on PATH. */
  ffmpegPath?: string
  /** ffmpeg's AudioToolbox device listing. The default runs ffmpeg. */
  listAudioToolboxDevices?: () => Promise<string>
  inspectRouting: typeof inspectVoiceAudioRouting
  queryMute?: MuteQuery
  now?: () => number
  setTimer?: (cb: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
  killGroup?: (pid: number, signal: NodeJS.Signals) => boolean
  inspectProcess?: (pid: number) => ProcessInfo | null
  processHost?: ProcessSignalHost
  probeTimeoutMs?: number
  /** Estimated delay between writing audio to the playback device and it being heard. Default 40. */
  outputLatencyMs?: number
  /** Builds the Realtime session around the in-process socket. The default is the real one. */
  createSession?: (
    socket: VoiceSessionSocket,
    identity: VoiceCallIdentity,
    options: TwilioPhoneBridgeOptions,
    lifecycle: { onClose: () => void; onDisclosureSpoken: (atMs: number) => void; onDisclosureFailed: () => void },
  ) => LifecycleSession
}

/**
 * Drives the existing OpenAI Realtime media-stream session in-process from the Mac's audio devices
 * (or a recording): capture from BlackHole 16ch, play into BlackHole 2ch. Identity is injected
 * through the constructor from the join request. There is no network path to this class.
 */
export class LocalAudioDeviceTransport {
  readonly ended: Promise<LocalAudioEndSummary>
  private resolveEnded!: (summary: LocalAudioEndSummary) => void
  private state: LocalAudioState = "idle"
  private readonly callSid = `local-audio-${crypto.randomBytes(6).toString("hex")}`
  private startedAtMs = 0
  private endedAtMs = 0
  private endReason: LocalAudioEndReason | undefined
  private finished = false
  private finishing: Promise<void> | undefined
  private readonly startAbort = new AbortController()
  private disclosureSpokenAt: number | undefined
  private captureClosed = false
  private devices: LocalAudioDevices | undefined
  private socket: LocalMediaStreamSocket | undefined
  private queue: PacedPlaybackQueue | undefined
  private feeder: PacedFrameFeeder | undefined
  private session: LifecycleSession | undefined
  private idleTimer: unknown
  private lastActivityAt = 0
  private lastSpeechAt = 0
  private awaitingReply = false
  private callInfo!: LocalAudioCallInfo

  private readonly now: () => number
  private readonly setTimer: (cb: () => void, ms: number) => unknown
  private readonly clearTimer: (handle: unknown) => void

  constructor(
    private readonly request: LocalAudioJoinRequest,
    private readonly deps: LocalAudioTransportDeps,
  ) {
    this.now = deps.now ?? Date.now
    this.setTimer = deps.setTimer ?? ((cb, ms) => setTimeout(cb, ms))
    this.clearTimer = deps.clearTimer ?? ((handle) => clearTimeout(handle as NodeJS.Timeout))
    this.ended = new Promise((resolve) => { this.resolveEnded = resolve })
  }

  status(): LocalAudioStatus {
    return {
      state: this.state,
      callSid: this.callSid,
      ...(this.startedAtMs ? { startedAt: new Date(this.startedAtMs).toISOString() } : {}),
      ...(this.endedAtMs ? { endedAt: new Date(this.endedAtMs).toISOString() } : {}),
      ...(this.endReason ? { endReason: this.endReason } : {}),
    }
  }

  async start(): Promise<void> {
    if (this.state !== "idle") throw new Error(`local audio join already ${this.state}`)
    this.state = "starting"
    try {
      await this.startUnchecked()
    } catch (error) {
      // Left while starting: the join already ended cleanly, so a late failure changes nothing.
      if (this.finished) return
      this.state = "failed"
      this.teardown()
      emitNervesEvent({
        level: "error",
        component: "senses",
        event: "senses.voice_local_join_failed",
        message: "local audio join failed",
        meta: { callSid: this.callSid, error: errorText(error) },
      })
      throw error
    }
  }

  async leave(reason: LocalAudioEndReason = "left"): Promise<void> {
    await this.finish(reason)
  }

  /** Live playback goes through ffmpeg, which names devices by index: find BlackHole 2ch's index now. */
  private async resolveLivePlayback(): Promise<{ command: string; args: string[] }> {
    const command = this.deps.ffmpegPath ?? "ffmpeg"
    const list = this.deps.listAudioToolboxDevices ?? (() => defaultListAudioToolboxDevices(command))
    let listing: string
    try {
      listing = await list()
    } catch (error) {
      throw new Error(`Local audio routing is not ready:\n- Live playback needs ffmpeg (${errorText(error)}): brew install ffmpeg`)
    }
    const index = findAudioToolboxDeviceIndex(listing, PLAYBACK_DEVICE_NAME)
    if (index === undefined) {
      throw new Error(`Local audio routing is not ready:\n- ffmpeg does not list the playback device "${PLAYBACK_DEVICE_NAME}". Install it with brew install --cask blackhole-2ch, then restart macOS audio or reboot.`)
    }
    return { command, args: ffmpegPlaybackArgs(index) }
  }

  private async startUnchecked(): Promise<void> {
    const { request, deps } = this
    if (!deps.bridgeOptions.openaiRealtime?.apiKey?.trim()) {
      throw new Error("OpenAI Realtime API key is not configured (voice.openaiRealtimeApiKey, integrations.openaiApiKey, or integrations.openaiEmbeddingsApiKey)")
    }
    const files = request.files
    const soxPath = deps.soxPath
    const livePlayback = files ? undefined : await this.resolveLivePlayback()
    if (this.finished) return
    this.devices = new LocalAudioDevices({
      spawner: deps.spawner,
      captureArgs: files ? fileCaptureArgs(files.inputPath) : soxCaptureArgs(CAPTURE_DEVICE_NAME),
      playbackArgs: livePlayback ? livePlayback.args : filePlaybackArgs(files!.outputPath),
      ...(livePlayback ? { playbackCommand: livePlayback.command } : {}),
      pidFile: deps.pidFile,
      soxPath,
      killGroup: deps.killGroup,
      inspectProcess: deps.inspectProcess,
      processHost: deps.processHost,
      gracefulPlayback: Boolean(files),
    })
    this.devices.sweepStale()

    if (!files) {
      const routing = await checkLocalAudioRouting(deps.inspectRouting, deps.queryMute)
      if (this.finished) return
      if (!routing.ok) throw new Error(`Local audio routing is not ready:\n- ${routing.steps.join("\n- ")}`)
      const probe = await probeCaptureLoopback({
        spawner: deps.spawner,
        soxPath,
        timeoutMs: deps.probeTimeoutMs,
        setTimer: this.setTimer,
        clearTimer: this.clearTimer,
        killGroup: deps.killGroup,
        signal: this.startAbort.signal,
      })
      if (this.finished) return
      if (!probe.ok) throw new Error(`Local audio health check failed: ${probe.reason}`)
    }

    const consent = sanitizeConsent(request.silentConsent)
    this.callInfo = {
      mode: request.mode ?? "conversation",
      ownerAlone: request.ownerAlone === true,
      ...(request.ownerName ? { ownerName: request.ownerName } : {}),
      ...(request.participants ? { participants: request.participants } : {}),
      ...(request.occasion ? { occasion: request.occasion } : {}),
      disclosure: consent ? "silent" : "spoken",
      ...(consent ? { consentStatement: consent } : {}),
    }
    const identity: VoiceCallIdentity = {
      callSid: this.callSid,
      agentName: request.agentName,
      direction: "inbound",
      from: "local-audio-room",
      to: `local-audio:${request.agentName}`,
      engine: "openai-realtime",
      ...(request.friendId ? { friendId: request.friendId } : {}),
      local: this.callInfo,
    }

    // Record the join (and, for a silent one, the owner's consent) before any audio flows.
    this.startedAtMs = this.now()
    this.lastActivityAt = this.startedAtMs
    if (!this.writeMetadata({}) && this.callInfo.disclosure === "silent") {
      throw new Error("could not record the owner's consent in the call metadata, so a silent join is not allowed")
    }

    const { capture, playback } = this.devices.start()
    playback.on("error", () => { void this.finish("playback_failed") })
    // Registered before the socket's own listeners so the reason is known when it reports the end.
    capture.once("end", () => { this.captureClosed = true })
    capture.once("close", () => { this.captureClosed = true })
    let socketCapture: Readable = capture
    if (files) {
      const sink = new PassThrough()
      this.feeder = new PacedFrameFeeder({ source: capture, sink, now: this.now, setTimer: this.setTimer, clearTimer: this.clearTimer })
      socketCapture = sink
    }
    this.queue = new PacedPlaybackQueue({
      write: (frame) => { playback.write(frame) },
      now: this.now,
      setTimer: this.setTimer,
      clearTimer: this.clearTimer,
      outputLatencyMs: this.outputLatencyMs(),
    })
    this.socket = new LocalMediaStreamSocket({
      capture: socketCapture,
      playback: this.queue,
      streamSid: `MZ${this.callSid}`,
      callSid: this.callSid,
      onEnded: () => { void this.finish(this.captureClosed ? "capture_ended" : "session_ended") },
      onCaptureFrame: (frame) => this.noteCapture(frame),
      onPlaybackAudio: () => this.notePlayback(),
    })
    const createSession = deps.createSession ?? defaultCreateSession
    this.session = createSession(this.socket, identity, deps.bridgeOptions, {
      onClose: () => { void this.finish("session_ended") },
      onDisclosureSpoken: (atMs) => {
        this.disclosureSpokenAt = atMs
        this.writeMetadata({})
      },
      onDisclosureFailed: () => { void this.finish("disclosure_failed") },
    })

    this.session.attach()
    this.socket.open()
    this.feeder?.start()
    this.state = "joined"
    this.scheduleIdleCheck()
    emitNervesEvent({
      component: "senses",
      event: "senses.voice_local_joined",
      message: "local audio session joined",
      meta: {
        callSid: this.callSid,
        agentName: request.agentName,
        mode: this.callInfo.mode,
        fileDriven: String(Boolean(files)),
        disclosure: this.callInfo.disclosure,
        ownerAlone: String(this.callInfo.ownerAlone),
      },
    })
  }

  private noteCapture(frame: Buffer): void {
    if (mulawFrameRms(frame) < ACTIVITY_RMS) return
    this.lastSpeechAt = this.now()
    this.lastActivityAt = this.lastSpeechAt
    this.awaitingReply = true
  }

  private notePlayback(): void {
    const now = this.now()
    this.lastActivityAt = now
    if (!this.awaitingReply) return
    this.awaitingReply = false
    emitNervesEvent({
      component: "senses",
      event: "senses.voice_local_reply_latency",
      message: "first reply audio after the last heard speech",
      meta: { callSid: this.callSid, latencyMs: now - this.lastSpeechAt },
    })
  }

  private scheduleIdleCheck(): void {
    this.idleTimer = this.setTimer(() => {
      const limits = LOCAL_AUDIO_MODE_LIMITS[this.callInfo.mode]
      const now = this.now()
      if (now - this.startedAtMs >= (this.request.maxDurationMs ?? limits.maxDurationMs)) {
        void this.finish("max_duration")
      } else if (now - this.lastActivityAt >= (this.request.idleSilenceMs ?? limits.idleSilenceMs)) {
        void this.finish("idle_silence")
      } else {
        this.scheduleIdleCheck()
      }
    }, IDLE_CHECK_MS)
  }

  /** Ends the join once. A second caller waits for the same finish. */
  private finish(reason: LocalAudioEndReason): Promise<void> {
    if (this.state === "failed") return Promise.resolve()
    // A re-entrant call (closing the socket reports the end again) has nothing to wait for.
    if (this.finished) return this.finishing ?? Promise.resolve()
    this.finishing = this.runFinish(reason)
    return this.finishing
  }

  private async runFinish(reason: LocalAudioEndReason): Promise<void> {
    this.finished = true
    this.endReason = reason
    this.clearIdleTimer()
    // Leaving while the start is still waiting on the routing check or the probe: cancel it. Nothing
    // else is running yet except the probe's processes, which the abort kills.
    this.startAbort.abort()
    if (this.request.files && this.queue) await this.drainQueue()
    this.state = "ended"
    this.endedAtMs = this.now()
    this.socket?.close()
    this.feeder?.stop()
    this.queue?.stop()
    if (this.request.files) await this.devices?.finish()
    else this.devices?.stop()
    const durationMs = this.startedAtMs ? this.endedAtMs - this.startedAtMs : 0
    this.writeMetadata({ endedAt: new Date(this.endedAtMs).toISOString(), endReason: reason, durationMs })
    emitNervesEvent({
      component: "senses",
      event: "senses.voice_local_ended",
      message: "local audio session ended",
      meta: { callSid: this.callSid, reason, durationMs },
    })
    this.resolveEnded({ reason, callSid: this.callSid, durationMs })
  }

  /** The reply to a recorded question is only complete once every queued frame reached the writer. */
  private async drainQueue(): Promise<void> {
    let timer: unknown
    const capped = new Promise<void>((resolve) => { timer = this.setTimer(resolve, FILE_DRAIN_CAP_MS) })
    await Promise.race([this.queue!.drain(), capped])
    this.clearTimer(timer)
  }

  private outputLatencyMs(): number {
    return this.request.files ? 0 : (this.deps.outputLatencyMs ?? DEFAULT_DEVICE_OUTPUT_LATENCY_MS)
  }

  private clearIdleTimer(): void {
    if (this.idleTimer !== undefined) this.clearTimer(this.idleTimer)
  }

  /** Failed start: stop anything that was already running. */
  private teardown(): void {
    this.clearIdleTimer()
    this.socket?.close()
    this.feeder?.stop()
    this.queue?.stop()
    this.devices?.stop()
  }

  private metadata: Record<string, unknown> = {}

  /** Returns whether the record was written. A join that never got going (no call info) has no record. */
  private writeMetadata(update: Record<string, unknown>): boolean {
    const dir = this.deps.metadataDir
    if (!dir || !this.callInfo) return false
    this.metadata = {
      ...this.metadata,
      callSid: this.callSid,
      transport: "local-audio",
      agentName: this.request.agentName,
      mode: this.callInfo.mode,
      startedAt: new Date(this.startedAtMs).toISOString(),
      participants: this.callInfo.participants ?? null,
      occasion: this.callInfo.occasion ?? null,
      friendId: this.request.friendId ?? null,
      ownerAlone: this.callInfo.ownerAlone,
      disclosure: this.callInfo.disclosure,
      ...(this.callInfo.consentStatement ? { consentStatement: this.callInfo.consentStatement } : {}),
      fileDriven: Boolean(this.request.files),
      disclosureSpokenAt: this.disclosureSpokenAt === undefined ? null : new Date(this.disclosureSpokenAt).toISOString(),
      outputLatencyMs: this.outputLatencyMs(),
      outputLatencyMeasured: false,
      ...update,
    }
    try {
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(path.join(dir, `${this.callSid}.json`), JSON.stringify(this.metadata, null, 2))
      return true
    } catch (error) {
      emitNervesEvent({
        level: "warn",
        component: "senses",
        event: "senses.voice_local_metadata_write_failed",
        message: "local audio call metadata could not be written",
        meta: { callSid: this.callSid, error: errorText(error) },
      })
      return false
    }
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function sanitizeConsent(statement: string | undefined): string {
  return sanitizeRoomText(statement).slice(0, MAX_CONSENT_CHARS)
}

export function defaultCreateSession(
  socket: VoiceSessionSocket,
  identity: VoiceCallIdentity,
  options: TwilioPhoneBridgeOptions,
  lifecycle: { onClose: () => void; onDisclosureSpoken: (atMs: number) => void; onDisclosureFailed: () => void },
): LifecycleSession {
  return new TwilioOpenAIRealtimeMediaStreamSession(socket, identity, options, lifecycle)
}
