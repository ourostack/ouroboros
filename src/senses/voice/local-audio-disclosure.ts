import { emitNervesEvent } from "../../nerves/runtime"

/** Tunable so tests can run the real state machine quickly. */
export const disclosureTimings = {
  /** The join leaves if the disclosure has not been spoken this long after it was first requested. */
  deadlineMs: 20_000,
  /** Pause before asking again after a cancelled or cut attempt. */
  retryDelayMs: 500,
  /** How long to wait for the response to start before checking whether the request was lost. */
  createWaitMs: 4_000,
}

export interface DisclosureHost {
  /** Asks the Realtime session to speak the disclosure (it goes through the floor gate, which can delay or drop it). */
  request(body: Record<string, unknown>): void
  /** True while a request for the body is still held inside the session (gate delay, response hold, create in flight). */
  isQueued(body: Record<string, unknown>): boolean
  /** Sends a playback mark behind the disclosure audio; its echo means the audio was played (or cleared). */
  sendMark(name: string): void
  onSpoken(atMs: number): void
  onFailed(): void
}

export interface DisclosureTrackerOptions {
  body: Record<string, unknown>
  host: DisclosureHost
  now?: () => number
  setTimer?: (cb: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
}

/** The spoken notice must actually say it is an AI; an answer to the room instead of the notice does not count. */
const SAYS_AI = /\b(A\.?I\b\.?|artificial intelligence)/iu

type State = "idle" | "requested" | "speaking" | "playing" | "retrying" | "spoken" | "failed" | "stopped"

/**
 * Makes the spoken disclosure a guarantee instead of a hope. A local audio join asks the model to say
 * the notice, but the floor gate can delay or overwrite that request and a barge-in can cut its audio.
 * The tracker follows the one response that carries the notice and counts it as spoken only when the
 * response completed, its audio transcript is done, no barge-in cut it, and its audio played out.
 * Anything else asks again, until the deadline, when the join gives up and leaves.
 */
export class DisclosureTracker {
  private state: State = "idle"
  private responseId: string | undefined
  private transcriptSeen = false
  private cut = false
  private sent = false
  private attempts = 0
  private markName = ""
  private deadlineTimer: unknown
  private createTimer: unknown
  private retryTimer: unknown
  private readonly now: () => number
  private readonly setTimer: (cb: () => void, ms: number) => unknown
  private readonly clearTimer: (handle: unknown) => void

  constructor(private readonly options: DisclosureTrackerOptions) {
    this.now = options.now ?? Date.now
    this.setTimer = options.setTimer ?? ((cb, ms) => {
      const handle = setTimeout(cb, ms)
      handle.unref()
      return handle
    })
    this.clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as NodeJS.Timeout))
  }

  start(): void {
    this.deadlineTimer = this.setTimer(() => this.fail(), disclosureTimings.deadlineMs)
    this.attempt()
  }

  isSpoken(): boolean {
    return this.state === "spoken"
  }

  stop(): void {
    this.finish("stopped")
  }

  /** The session put a response.create on the wire. */
  noteSent(body: unknown): void {
    if (body === this.options.body && this.state === "requested") this.sent = true
  }

  handleRealtimeEvent(event: Record<string, unknown>): void {
    if (this.isTerminal()) return
    const type = event.type
    const response = event.response as { id?: unknown; status?: unknown } | undefined
    if (type === "response.created") {
      if (!this.sent || this.responseId || typeof response?.id !== "string") return
      this.responseId = response.id
      this.sent = false
      this.state = "speaking"
      this.clear(this.createTimer)
      return
    }
    if (type === "response.output_audio_transcript.done") {
      if (this.responseId && event.response_id === this.responseId && typeof event.transcript === "string" && SAYS_AI.test(event.transcript)) {
        this.transcriptSeen = true
      }
      return
    }
    if (type === "response.done" && this.responseId && response?.id === this.responseId) {
      if (response.status === "completed" && this.transcriptSeen && !this.cut) {
        this.state = "playing"
        this.markName = `disclosure-${this.attempts}`
        this.options.host.sendMark(this.markName)
      } else {
        this.retry(`response ${String(response.status)}${this.cut ? " after a barge-in" : ""}`)
      }
    }
  }

  /** The caller's speech cleared the playback queue. */
  noteCleared(): void {
    if (this.state === "speaking" || this.state === "playing") this.cut = true
  }

  /** A playback mark came back. Returns true when it was the disclosure's own. */
  noteMark(name: string): boolean {
    if (this.state !== "playing" || name !== this.markName) return false
    if (this.cut) {
      this.retry("audio was cut before it played out")
      return true
    }
    this.finish("spoken")
    const atMs = this.now()
    emitNervesEvent({
      component: "senses",
      event: "senses.voice_local_disclosure_spoken",
      message: "local audio disclosure notice was spoken and played out",
      meta: { attempts: this.attempts },
    })
    this.options.host.onSpoken(atMs)
    return true
  }

  private attempt(): void {
    this.attempts++
    this.state = "requested"
    this.responseId = undefined
    this.transcriptSeen = false
    this.cut = false
    this.sent = false
    this.options.host.request(this.options.body)
    this.createTimer = this.setTimer(() => this.checkRequest(), disclosureTimings.createWaitMs)
  }

  /** The response never started: if the session no longer holds the request (the gate overwrote it), ask again. */
  private checkRequest(): void {
    if (this.options.host.isQueued(this.options.body)) {
      this.createTimer = this.setTimer(() => this.checkRequest(), disclosureTimings.createWaitMs)
      return
    }
    this.attempt()
  }

  private retry(why: string): void {
    this.state = "retrying"
    emitNervesEvent({
      level: "warn",
      component: "senses",
      event: "senses.voice_local_disclosure_retry",
      message: "local audio disclosure notice was not spoken; asking again",
      meta: { why, attempts: this.attempts },
    })
    this.retryTimer = this.setTimer(() => this.attempt(), disclosureTimings.retryDelayMs)
  }

  private fail(): void {
    this.finish("failed")
    emitNervesEvent({
      level: "error",
      component: "senses",
      event: "senses.voice_local_disclosure_failed",
      message: "local audio disclosure notice could not be spoken in time; leaving",
      meta: { attempts: this.attempts, deadlineMs: disclosureTimings.deadlineMs },
    })
    this.options.host.onFailed()
  }

  private isTerminal(): boolean {
    return this.state === "spoken" || this.state === "failed" || this.state === "stopped"
  }

  private finish(state: "spoken" | "failed" | "stopped"): void {
    if (this.isTerminal()) return
    this.state = state
    this.clear(this.deadlineTimer)
    this.clear(this.createTimer)
    this.clear(this.retryTimer)
  }

  private clear(handle: unknown): void {
    if (handle !== undefined) this.clearTimer(handle)
  }
}
