import { execFile, execFileSync } from "child_process"
import * as fs from "fs"
import * as path from "path"
import type { Readable, Writable } from "stream"
import { emitNervesEvent } from "../../nerves/runtime"
import type { inspectVoiceAudioRouting } from "./audio-routing"
import { isDigitalSilence } from "./local-audio"
import { muteFixSteps, type MuteQuery } from "./local-audio-mute"

export interface ChildProcessLike {
  stdin: Writable | null
  stdout: Readable | null
  pid?: number
  kill(signal: NodeJS.Signals): boolean
  on(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown
}

export interface LocalAudioProcessSpawner {
  spawn(command: string, args: string[], options: { detached: boolean }): ChildProcessLike
}

const RAW_MULAW = ["-t", "raw", "-r", "8000", "-e", "mu-law", "-b", "8", "-c", "1"]

const AUDIO_PROCESS_NAMES = new Set(["sox", "ffmpeg"])

export const CAPTURE_DEVICE_NAME = "BlackHole 16ch"
export const PLAYBACK_DEVICE_NAME = "BlackHole 2ch"

/** Capture a CoreAudio device as mono 8 kHz mu-law on stdout (channels 1 and 2 mixed). */
export function soxCaptureArgs(device: string): string[] {
  // BlackHole 16ch spreads a stereo call over many channels; `remix 1,2` mixes the first two to mono.
  // `--buffer` sizes sox's writes to stdout (1024 bytes is 128 ms of 8 kHz mu-law), while the larger
  // `--input-buffer` keeps the CoreAudio reads big enough to avoid dropped audio. A single
  // `--buffer 8192` delayed everything the agent heard by about a second.
  return ["-q", "--buffer", "1024", "--input-buffer", "8192", "-t", "coreaudio", device, ...RAW_MULAW, "-", "remix", "1,2"]
}

/**
 * Play raw mono 8 kHz mu-law from stdin to an AudioToolbox output device, chosen by index.
 *
 * sox's CoreAudio output can deadlock when the process runs at lowered priority (a zsh background
 * job is niced by default, and so is a launchd Background job): its main thread holds a lock inside
 * `AudioDeviceStart` while the device IO thread waits for that lock, so nothing is ever played.
 * Observed live: 5 of 5 niced joins were silent with sox and 2 of 2 spoke with ffmpeg. The probe
 * flags keep ffmpeg from buffering input before it starts playing.
 */
export function ffmpegPlaybackArgs(deviceIndex: number): string[] {
  return [
    "-hide_banner", "-loglevel", "error", "-nostdin",
    "-probesize", "32", "-analyzeduration", "0", "-fflags", "nobuffer",
    "-f", "mulaw", "-ar", "8000", "-ac", "1", "-i", "pipe:0",
    "-f", "audiotoolbox", "-audio_device_index", String(deviceIndex), "-",
  ]
}

/** ffmpeg prints the AudioToolbox devices to its log; `-t 0` means nothing is played. */
export function audioToolboxListArgs(): string[] {
  return ["-hide_banner", "-f", "lavfi", "-i", "anullsrc", "-t", "0", "-f", "audiotoolbox", "-list_devices", "true", "-"]
}

// "[AudioToolbox @ 0x7b514003c0] [1]                  BlackHole 2ch, BlackHole2ch_UID"
const AUDIOTOOLBOX_DEVICE_LINE = /\[(\d+)\]\s+(.+),\s*[^,]*$/

/** The index ffmpeg uses for a device with exactly this name, or undefined when it is not listed. */
export function findAudioToolboxDeviceIndex(listing: string, deviceName: string): number | undefined {
  for (const line of listing.split("\n")) {
    const match = AUDIOTOOLBOX_DEVICE_LINE.exec(line.trim())
    if (match && match[2]!.trim() === deviceName) return Number(match[1])
  }
  return undefined
}

type ExecFileCallback = (file: string, args: string[], callback: (error: (Error & { code?: unknown }) | null, stdout: string, stderr: string) => void) => void

/** Runs ffmpeg's device listing and returns its log. Rejects only when ffmpeg itself cannot run. */
export function defaultListAudioToolboxDevices(
  ffmpegPath = "ffmpeg",
  run: ExecFileCallback = (file, args, callback) => {
    execFile(file, args, { encoding: "utf8", timeout: 5000 }, (error, stdout, stderr) => callback(error, stdout, stderr))
  },
): Promise<string> {
  return new Promise((resolve, reject) => {
    run(ffmpegPath, audioToolboxListArgs(), (error, _stdout, stderr) => {
      if (error && typeof error.code !== "number") reject(error)
      else resolve(stderr)
    })
  })
}

/** Decode any audio file to the capture stream format (stdout). The caller paces it. */
export function fileCaptureArgs(inputPath: string): string[] {
  return ["-q", inputPath, ...RAW_MULAW, "-"]
}

/** Write raw mono 8 kHz mu-law from stdin to a WAV file. */
export function filePlaybackArgs(outputPath: string): string[] {
  return ["-q", ...RAW_MULAW, "-", "-t", "wav", outputPath]
}

/** Signals a whole process group. Returns false when the group is already gone. */
export function defaultKillGroup(pid: number, signal: NodeJS.Signals): boolean {
  try {
    process.kill(-pid, signal)
    return true
  } catch {
    return false
  }
}

export interface ProcessInfo {
  command: string
  startTime: string
}

// `ps -o lstart=` prints "Fri Oct  9 11:59:46 2026": weekday, month, day, time, year. The words are not
// matched by name, so a locale that spells them differently still parses (and LC_ALL=C pins the format).
const PS_LINE = /^(\S+\s+\S+\s+\d+\s+[\d:]{8}\s+\d{4})\s+(.+)$/
export const PS_ENV = { ...process.env, LC_ALL: "C" }
const PS_ARGS = (pid: number): string[] => ["-p", String(pid), "-o", "lstart=", "-o", "comm="]

function parsePsLine(out: string): ProcessInfo | null {
  const match = PS_LINE.exec(out.trim())
  return match ? { startTime: match[1]!, command: match[2]! } : null
}

/** Command and start time of a live process, or null when it is gone. Used to avoid killing a reused pid. */
export function defaultInspectProcess(
  pid: number,
  runPs: (args: string[]) => string = (args) => execFileSync("ps", args, { encoding: "utf8", timeout: 2000, env: PS_ENV }),
): ProcessInfo | null {
  try {
    return parsePsLine(runPs(PS_ARGS(pid)))
  } catch {
    return null
  }
}

/** The same lookup without blocking the event loop (audio is flowing while this runs). */
export function defaultInspectProcessAsync(
  pid: number,
  runPs: (args: string[]) => Promise<string> = (args) =>
    new Promise((resolve, reject) => {
      execFile("ps", args, { encoding: "utf8", timeout: 2000, env: PS_ENV }, (error, stdout) => (error ? reject(error) : resolve(stdout)))
    }),
): Promise<ProcessInfo | null> {
  return runPs(PS_ARGS(pid)).then(parsePsLine, () => null)
}

/** The slice of `process` the devices need to clean up sox when the parent is told to stop. */
export interface ProcessSignalHost {
  pid: number
  once(event: string, listener: () => void): unknown
  off(event: string, listener: () => void): unknown
  kill(pid: number, signal: NodeJS.Signals): unknown
  /** How many listeners the host has for an event. Another listener owns shutting down, so we do not re-raise. */
  listenerCount(event: string): number
}

export const defaultProcessHost: ProcessSignalHost = {
  get pid() { return process.pid },
  once: (event, listener) => process.once(event as NodeJS.Signals, listener),
  off: (event, listener) => process.off(event as NodeJS.Signals, listener),
  kill: (pid, signal) => process.kill(pid, signal),
  listenerCount: (event) => process.listenerCount(event as NodeJS.Signals),
}

export interface LocalAudioDevicesOptions {
  spawner: LocalAudioProcessSpawner
  captureArgs: string[]
  playbackArgs: string[]
  pidFile: string
  soxPath?: string
  /** The playback process's command when it is not sox (live playback uses ffmpeg). */
  playbackCommand?: string
  killGroup?: (pid: number, signal: NodeJS.Signals) => boolean
  inspectProcess?: (pid: number) => ProcessInfo | null
  inspectProcessAsync?: (pid: number) => Promise<ProcessInfo | null>
  processHost?: ProcessSignalHost
  /** The playback process writes a file: on a stop signal let it finalize (EOF, then SIGTERM) before SIGKILL. */
  gracefulPlayback?: boolean
  setTimer?: (cb: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
}

/**
 * sox does not act on SIGTERM while it is blocked in a CoreAudio call or in a stdin read (observed
 * live: a tone process stayed alive for minutes). After this grace, anything left gets SIGKILL.
 */
export const KILL_GRACE_MS = 500

interface RunningChild {
  child: ChildProcessLike
  pid: number | undefined
}

/**
 * Owns the capture and playback sox processes: each runs detached in its own process group,
 * pids are recorded in a pid file so a later start can sweep leftovers from a crashed run.
 */
export class LocalAudioDevices {
  private running: RunningChild[] = []
  private readonly killGroup: (pid: number, signal: NodeJS.Signals) => boolean
  private readonly inspectProcess: (pid: number) => ProcessInfo | null
  private readonly inspectProcessAsync: (pid: number) => Promise<ProcessInfo | null>
  private readonly host: ProcessSignalHost
  private readonly setTimer: (cb: () => void, ms: number) => unknown
  private signalCleanup: (() => void) | null = null

  constructor(private readonly options: LocalAudioDevicesOptions) {
    this.killGroup = options.killGroup ?? defaultKillGroup
    this.setTimer = options.setTimer ?? ((cb, ms) => setTimeout(cb, ms))
    this.inspectProcess = options.inspectProcess ?? defaultInspectProcess
    this.inspectProcessAsync = options.inspectProcessAsync ?? defaultInspectProcessAsync
    this.host = options.processHost ?? defaultProcessHost
  }

  start(): { capture: Readable; playback: Writable } {
    this.stop()
    const command = this.options.soxPath ?? "sox"
    const capture = this.spawnTracked(command, this.options.captureArgs)
    const playback = this.spawnTracked(this.options.playbackCommand ?? command, this.options.playbackArgs)
    this.writePidFile()
    this.recordStartTimes([...this.running])
    this.watchParentSignals()
    if (!capture.stdout || !playback.stdin) {
      this.stop()
      throw new Error("sox did not provide capture stdout / playback stdin stdio")
    }
    emitNervesEvent({
      component: "senses",
      event: "senses.voice_local_audio_devices_started",
      message: "local audio sox processes started",
      meta: { capturePid: capture.pid ?? null, playbackPid: playback.pid ?? null },
    })
    return { capture: capture.stdout, playback: playback.stdin }
  }

  /**
   * `force` is for paths where no timer will get to run (the parent is exiting or being signalled):
   * SIGKILL straight away. Otherwise SIGTERM now and SIGKILL after a short grace to whatever is
   * still alive.
   */
  stop(force = false): void {
    this.signalCleanup?.()
    const stopping = this.running
    this.running = []
    const send = (entry: RunningChild, signal: NodeJS.Signals): void => {
      if (entry.pid === undefined || !this.killGroup(entry.pid, signal)) entry.child.kill(signal)
    }
    for (const entry of stopping) send(entry, force ? "SIGKILL" : "SIGTERM")
    if (!force && stopping.length > 0) {
      this.setTimer(() => {
        for (const entry of stopping) {
          // A child that exited cleared its pid (the pid may be reused by now): leave it alone.
          if (entry.pid !== undefined) send(entry, "SIGKILL")
        }
      }, KILL_GRACE_MS)
    }
    if (stopping.length > 0) {
      fs.rmSync(this.options.pidFile, { force: true })
      emitNervesEvent({
        component: "senses",
        event: "senses.voice_local_audio_devices_stopped",
        message: "local audio sox processes stopped",
        meta: { processes: stopping.length },
      })
    }
  }

  /**
   * Graceful end for file output: close the playback stream and let sox finalize the WAV header,
   * then stop everything. Gives up waiting after `timeoutMs`.
   */
  async finish(timeoutMs = 3000): Promise<void> {
    const playback = this.running[1]
    if (playback && playback.pid !== undefined) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, timeoutMs)
        playback.child.on("exit", () => {
          clearTimeout(timer)
          resolve()
        })
        playback.child.stdin?.end()
      })
    }
    this.stop()
  }

  /** Kills sox groups left behind in the pid file by a previous run. Returns how many were killed. */
  sweepStale(): number {
    let text: string
    try {
      text = fs.readFileSync(this.options.pidFile, "utf8")
    } catch {
      return 0
    }
    let killed = 0
    const terminated: Array<{ pid: number; recordedStart: string }> = []
    for (const line of text.split("\n")) {
      const [pidText = "", recordedStart = ""] = line.split("\t")
      const pid = Number.parseInt(pidText.trim(), 10)
      if (!Number.isInteger(pid) || pid <= 1) continue
      if (!this.isRecordedSox(pid, recordedStart)) continue
      if (this.killGroup(pid, "SIGTERM")) {
        killed++
        terminated.push({ pid, recordedStart })
      }
    }
    if (terminated.length > 0) {
      // sox can ignore SIGTERM while blocked in CoreAudio or a stdin read: whatever is still the same sox gets SIGKILL.
      this.setTimer(() => {
        for (const { pid, recordedStart } of terminated) {
          if (this.isRecordedSox(pid, recordedStart)) this.killGroup(pid, "SIGKILL")
        }
      }, KILL_GRACE_MS)
    }
    fs.rmSync(this.options.pidFile, { force: true })
    emitNervesEvent({
      component: "senses",
      event: "senses.voice_local_audio_stale_swept",
      message: "stale local audio sox processes swept",
      meta: { killed },
    })
    return killed
  }

  /** Only a process that is still one of our audio tools AND started when we recorded it is ours to kill (pids get reused). */
  private isRecordedSox(pid: number, recordedStart: string): boolean {
    const info = this.inspectProcess(pid)
    if (!info || !AUDIO_PROCESS_NAMES.has(path.basename(info.command))) return false
    return recordedStart !== "" && info.startTime === recordedStart
  }

  /**
   * sox lives in its own process group, so a Ctrl-C or kill aimed at this process would not reach
   * it. Kill the groups on SIGINT, SIGTERM and exit; for signals, re-raise afterwards so the
   * process still terminates the way the sender intended.
   */
  private watchParentSignals(): void {
    const handlers: Array<[string, () => void]> = [
      ["SIGINT", () => this.onSignal("SIGINT")],
      ["SIGTERM", () => this.onSignal("SIGTERM")],
      ["exit", () => this.stop(true)],
    ]
    for (const [event, listener] of handlers) this.host.once(event, listener)
    this.signalCleanup = () => {
      this.signalCleanup = null
      for (const [event, listener] of handlers) this.host.off(event, listener)
    }
  }

  private onSignal(signal: NodeJS.Signals): void {
    emitNervesEvent({
      level: "warn",
      component: "senses",
      event: "senses.voice_local_audio_parent_signal",
      message: "local audio parent received a stop signal; killing sox",
      meta: { signal },
    })
    if (this.options.gracefulPlayback) {
      this.winddownFileWriter()
      this.setTimer(() => {
        this.stop(true)
        this.reraise(signal)
      }, KILL_GRACE_MS)
      return
    }
    this.stop(true)
    this.reraise(signal)
  }

  /** The WAV writer finalizes its header on EOF or SIGTERM; everything else is not worth waiting for. */
  private winddownFileWriter(): void {
    this.running.forEach((entry, index) => {
      if (index === 0) {
        this.sendSignal(entry, "SIGKILL")
        return
      }
      entry.child.stdin?.end()
      this.sendSignal(entry, "SIGTERM")
    })
  }

  private sendSignal(entry: RunningChild, signal: NodeJS.Signals): void {
    if (entry.pid === undefined || !this.killGroup(entry.pid, signal)) entry.child.kill(signal)
  }

  /** Re-raise so the process still ends the way the sender intended, unless another listener owns that. */
  private reraise(signal: NodeJS.Signals): void {
    if (this.host.listenerCount(signal) === 0) this.host.kill(this.host.pid, signal)
  }

  private spawnTracked(command: string, args: string[]): ChildProcessLike & { pid: number | undefined } {
    const child = this.options.spawner.spawn(command, args, { detached: true })
    const entry: RunningChild = { child, pid: child.pid }
    this.running.push(entry)
    child.on("exit", () => {
      entry.pid = undefined
    })
    return Object.assign(child, { pid: child.pid })
  }

  private writePidFile(): void {
    const lines: string[] = []
    for (const entry of this.running) {
      if (entry.pid === undefined) continue
      lines.push(`${entry.pid}\t`)
    }
    fs.mkdirSync(path.dirname(this.options.pidFile), { recursive: true })
    fs.writeFileSync(this.options.pidFile, `${lines.join("\n")}\n`)
  }

  /**
   * The pid file first lists bare pids (a later sweep will not kill a pid without a start time), then
   * gains start times once `ps` answers, so the event loop never waits on `ps` while audio flows.
   */
  private recordStartTimes(entries: RunningChild[]): void {
    const pids = entries.map((entry) => entry.pid)
    void Promise.all(pids.map((pid) => (pid === undefined ? Promise.resolve(null) : this.inspectProcessAsync(pid)))).then((infos) => {
      if (entries.some((entry) => !this.running.includes(entry))) return
      const lines: string[] = []
      entries.forEach((entry, index) => {
        if (entry.pid === pids[index] && entry.pid !== undefined) lines.push(`${entry.pid}\t${infos[index]?.startTime ?? ""}`)
      })
      try {
        fs.writeFileSync(this.options.pidFile, `${lines.join("\n")}\n`)
      } catch {
        // The state directory is gone (the run ended): nothing to record.
      }
    })
  }
}

export async function checkLocalAudioRouting(
  inspect: typeof inspectVoiceAudioRouting,
  queryMute?: MuteQuery,
): Promise<{ ok: boolean; steps: string[] }> {
  const inspection = await inspect({ captureDeviceName: CAPTURE_DEVICE_NAME, outputDeviceName: PLAYBACK_DEVICE_NAME })
  const steps: string[] = []
  const muteSteps = inspection.missing.length === 0 && queryMute
    ? muteFixSteps((await queryMute([CAPTURE_DEVICE_NAME, PLAYBACK_DEVICE_NAME])) ?? [])
    : []
  steps.push(...muteSteps)
  if (inspection.status === "unknown") {
    // The inspection itself failed, so nothing is known about the devices: do not tell the owner to install them.
    const error = inspection.error ?? "unknown error"
    steps.push(/ENOENT|not found/i.test(error)
      ? "The device check needs SwitchAudioSource: brew install switchaudio-osx"
      : `Audio device inspection failed: ${error}`)
  } else {
    const missing = inspection.missing.map((name) => name.toLowerCase().replace(/\s+/g, "-"))
    if (missing.length > 0) {
      steps.push(`Install the missing audio devices: brew install --cask ${missing.join(" ")} (then restart macOS audio or reboot).`)
    }
  }
  steps.push(
    `In the call app, set the microphone to "${PLAYBACK_DEVICE_NAME}" (the agent speaks into it).`,
    `In the call app, set the speaker output to "${CAPTURE_DEVICE_NAME}" (the agent listens to it).`,
    `To hear the call yourself, create a Multi-Output Device in Audio MIDI Setup that includes "${CAPTURE_DEVICE_NAME}" and your speakers, and use it as the call app's speaker output.`,
  )
  return { ok: inspection.status === "ready" && muteSteps.length === 0, steps }
}

/** Plays a quiet tone into a CoreAudio device with a separate sox process (stopped as soon as it is heard). */
export function soxProbeToneArgs(device: string): string[] {
  return ["-q", "-n", "-t", "coreaudio", device, "synth", "3", "sine", "1000", "vol", "0.2"]
}

export interface ProbeCaptureLoopbackOptions {
  spawner: LocalAudioProcessSpawner
  device?: string
  /** How long the capture has to hear the tone once the tone has started. */
  timeoutMs?: number
  /** How long the probe capture may take to deliver its first chunk (opening CoreAudio can be slow on a busy Mac). */
  openTimeoutMs?: number
  soxPath?: string
  setTimer?: (cb: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
  killGroup?: (pid: number, signal: NodeJS.Signals) => boolean
  /** Aborting stops the probe at once and kills its processes (the join was cancelled). */
  signal?: AbortSignal
}

/**
 * A quiet room is not a permission failure: BlackHole returns zeros whenever the call app plays
 * nothing. So before the join we play a short probe tone into the capture device and require a
 * capture to hear it. The probe uses its own capture and tone processes, so it never touches the
 * live capture stream: the first seconds of real audio are never consumed or discarded, and the
 * tone never reaches the agent. The tone starts only after the probe capture has delivered its
 * first chunk (proof that it is open and listening), so a slow CoreAudio open cannot miss the tone.
 * Only a missing probe fails the join: either macOS microphone permission is missing for this
 * process, or the device is muted.
 */
export function probeCaptureLoopback(options: ProbeCaptureLoopbackOptions): Promise<{ ok: boolean; reason?: string }> {
  const timeoutMs = options.timeoutMs ?? 6000
  const openTimeoutMs = options.openTimeoutMs ?? 60_000
  const device = options.device ?? CAPTURE_DEVICE_NAME
  const command = options.soxPath ?? "sox"
  const setTimer = options.setTimer ?? ((cb, ms) => setTimeout(cb, ms))
  const clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as NodeJS.Timeout))
  const killGroup = options.killGroup ?? defaultKillGroup
  if (options.signal?.aborted) return Promise.resolve({ ok: false, reason: "cancelled" })
  const listener = options.spawner.spawn(command, soxCaptureArgs(device), { detached: true })
  let tone: ChildProcessLike | undefined

  return new Promise((resolve) => {
    let timer: unknown
    let done = false
    const kill = (child: ChildProcessLike): void => {
      const send = (signal: NodeJS.Signals): void => {
        if (child.pid === undefined || !killGroup(child.pid, signal)) child.kill(signal)
      }
      let exited = false
      child.on("exit", () => { exited = true })
      send("SIGTERM")
      setTimer(() => { if (!exited) send("SIGKILL") }, KILL_GRACE_MS)
    }
    const finish = (result: { ok: boolean; reason?: string }): void => {
      if (done) return
      done = true
      listener.stdout?.off("data", onData)
      clearTimer(timer)
      options.signal?.removeEventListener("abort", onAbort)
      kill(listener)
      if (tone) kill(tone)
      emitNervesEvent({
        level: result.ok ? "info" : "error",
        component: "senses",
        event: result.ok ? "senses.voice_local_capture_probe_heard" : "senses.voice_local_capture_probe_missing",
        message: result.ok ? "local capture heard the probe tone" : "local capture did not hear the probe tone",
        meta: { timeoutMs, reason: result.reason ?? null },
      })
      resolve(result)
    }
    const onAbort = (): void => finish({ ok: false, reason: "cancelled" })
    const onData = (chunk: Buffer): void => {
      if (!tone) {
        // The capture is open and delivering: now it is safe to play the tone.
        clearTimer(timer)
        tone = options.spawner.spawn(command, soxProbeToneArgs(device), { detached: true })
        timer = setTimer(() => {
          finish({ ok: false, reason: capturedNothingReason(device, `capture heard nothing from the probe tone within ${timeoutMs} ms`) })
        }, timeoutMs)
      }
      if (!isDigitalSilence([chunk])) finish({ ok: true })
    }
    timer = setTimer(() => {
      finish({ ok: false, reason: capturedNothingReason(device, `the probe capture delivered no audio at all within ${openTimeoutMs} ms`) })
    }, openTimeoutMs)
    options.signal?.addEventListener("abort", onAbort)
    listener.on("exit", () => finish({ ok: false, reason: capturedNothingReason(device, "the probe capture process exited before hearing the tone") }))
    listener.stdout?.on("data", onData)
  })
}

/** Digital silence has two usual causes on macOS; always name both fixes. */
export function capturedNothingReason(device: string, what: string): string {
  return `${what} on ${device}. Either the device is muted (open Audio MIDI Setup, select ${device}, and uncheck Mute for Input and Output) or macOS microphone permission is missing for the app running this command (System Settings > Privacy & Security > Microphone).`
}
