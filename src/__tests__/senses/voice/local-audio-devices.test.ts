import { spawn } from "child_process"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { EventEmitter } from "events"
import { PassThrough } from "stream"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { VoiceAudioRoutingInspection } from "../../../senses/voice/audio-routing"
import {
  LocalAudioDevices,
  checkLocalAudioRouting,
  PS_ENV,
  defaultInspectProcess,
  defaultInspectProcessAsync,
  defaultKillGroup,
  fileCaptureArgs,
  filePlaybackArgs,
  soxCaptureArgs,
  type ChildProcessLike,
  type LocalAudioProcessSpawner,
  type ProcessInfo,
  probeCaptureLoopback,
  soxProbeToneArgs,
  type ProcessSignalHost,
  ffmpegPlaybackArgs,
  audioToolboxListArgs,
  findAudioToolboxDeviceIndex,
  defaultListAudioToolboxDevices,
} from "../../../senses/voice/local-audio-devices"

class FakeChild extends EventEmitter implements ChildProcessLike {
  stdin = new PassThrough()
  stdout = new PassThrough()
  kills: string[] = []
  constructor(public pid: number | undefined) { super() }
  kill(signal: NodeJS.Signals): boolean {
    this.kills.push(signal)
    return true
  }
}

function makeSpawner(pids: Array<number | undefined> = [1001, 1002]) {
  const children: FakeChild[] = []
  const calls: Array<{ command: string; args: string[]; detached: boolean }> = []
  const spawner: LocalAudioProcessSpawner = {
    spawn(command, args, options) {
      calls.push({ command, args, detached: options.detached })
      const child = new FakeChild(pids[children.length])
      children.push(child)
      return child
    },
  }
  return { spawner, children, calls }
}

let dir: string
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "local-audio-devices-"))
})
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

describe("sox argument builders", () => {
  it("builds capture args for a CoreAudio device", () => {
    expect(soxCaptureArgs("BlackHole 16ch")).toEqual(["-q", "--buffer", "1024", "--input-buffer", "8192", "-t", "coreaudio", "BlackHole 16ch", "-t", "raw", "-r", "8000", "-e", "mu-law", "-b", "8", "-c", "1", "-", "remix", "1,2"])
  })

  it("builds file capture and playback args", () => {
    expect(fileCaptureArgs("/in.wav")).toEqual(["-q", "/in.wav", "-t", "raw", "-r", "8000", "-e", "mu-law", "-b", "8", "-c", "1", "-"])
    expect(filePlaybackArgs("/out.wav")).toEqual(["-q", "-t", "raw", "-r", "8000", "-e", "mu-law", "-b", "8", "-c", "1", "-", "-t", "wav", "/out.wav"])
  })
})

describe("ffmpeg playback", () => {
  const listing = [
    "Input #0, lavfi, from 'anullsrc':",
    "[AudioToolbox @ 0x7b514003c0] CoreAudio devices:",
    "[AudioToolbox @ 0x7b514003c0] [0]                 BlackHole 16ch, BlackHole16ch_UID",
    "[AudioToolbox @ 0x7b514003c0] [1]                  BlackHole 2ch, BlackHole2ch_UID",
    "[AudioToolbox @ 0x7b514003c0] [4]            Multi-Output Device, ~:AMS2_StackedOutput:0",
  ].join("\n")

  it("plays raw mono 8 kHz mu-law from stdin to an AudioToolbox device by index, without input probing delay", () => {
    expect(ffmpegPlaybackArgs(1)).toEqual([
      "-hide_banner", "-loglevel", "error", "-nostdin",
      "-probesize", "32", "-analyzeduration", "0", "-fflags", "nobuffer",
      "-f", "mulaw", "-ar", "8000", "-ac", "1", "-i", "pipe:0",
      "-f", "audiotoolbox", "-audio_device_index", "1", "-",
    ])
  })

  it("lists AudioToolbox devices without playing anything", () => {
    expect(audioToolboxListArgs()).toEqual(["-hide_banner", "-f", "lavfi", "-i", "anullsrc", "-t", "0", "-f", "audiotoolbox", "-list_devices", "true", "-"])
  })

  it("finds a device index by its exact name and ignores near matches", () => {
    expect(findAudioToolboxDeviceIndex(listing, "BlackHole 2ch")).toBe(1)
    expect(findAudioToolboxDeviceIndex(listing, "BlackHole 16ch")).toBe(0)
    expect(findAudioToolboxDeviceIndex(listing, "Multi-Output Device")).toBe(4)
    expect(findAudioToolboxDeviceIndex(listing, "BlackHole")).toBeUndefined()
    expect(findAudioToolboxDeviceIndex("", "BlackHole 2ch")).toBeUndefined()
  })

  it("defaultListAudioToolboxDevices returns ffmpeg's log output and rejects when ffmpeg cannot run", async () => {
    const calls: Array<{ file: string; args: string[] }> = []
    const ok = await defaultListAudioToolboxDevices("/opt/ffmpeg", (file, args, cb) => { calls.push({ file, args }); cb(null, "", "devices here") })
    expect(ok).toBe("devices here")
    expect(calls).toEqual([{ file: "/opt/ffmpeg", args: audioToolboxListArgs() }])
    // A non-zero exit still carries the listing on stderr.
    await expect(defaultListAudioToolboxDevices(undefined, (_f, _a, cb) => cb(Object.assign(new Error("exit 1"), { code: 1 }), "", "partial"))).resolves.toBe("partial")
    await expect(defaultListAudioToolboxDevices(undefined, (_f, _a, cb) => cb(Object.assign(new Error("spawn ffmpeg ENOENT"), { code: "ENOENT" }), "", ""))).rejects.toThrow(/ENOENT/)
  })

  it("defaultListAudioToolboxDevices runs the real ffmpeg binary through execFile", async () => {
    await expect(defaultListAudioToolboxDevices("/nonexistent/ffmpeg-for-test")).rejects.toThrow(/ENOENT/)
  })
})

describe("LocalAudioDevices", () => {
  function make(extra: { killGroup?: (pid: number, signal: NodeJS.Signals) => boolean; inspectProcess?: (pid: number) => ProcessInfo | null; pids?: Array<number | undefined>; soxPath?: string; playbackCommand?: string } = {}) {
    const { spawner, children, calls } = makeSpawner(extra.pids)
    const killed: Array<{ pid: number; signal: string }> = []
    const pidFile = path.join(dir, "sub", "voice-sox.pids")
    const timers: Array<{ cb: () => void; ms: number }> = []
    const inspectProcess = extra.inspectProcess ?? ((pid) => ({ command: "/opt/homebrew/bin/sox", startTime: `start-${pid}` }))
    const devices = new LocalAudioDevices({
      spawner,
      captureArgs: ["cap"],
      playbackArgs: ["play"],
      pidFile,
      soxPath: extra.soxPath,
      playbackCommand: extra.playbackCommand,
      killGroup: extra.killGroup ?? ((pid, signal) => { killed.push({ pid, signal }); return true }),
      inspectProcess,
      inspectProcessAsync: async (pid) => inspectProcess(pid),
      setTimer: (cb, ms) => { timers.push({ cb, ms }); return timers.length },
    })
    return { devices, children, calls, killed, pidFile, timers }
  }

  it("spawns capture and playback sox detached and records pids", async () => {
    const { devices, children, calls, pidFile } = make()
    const { capture, playback } = devices.start()
    expect(calls).toEqual([
      { command: "sox", args: ["cap"], detached: true },
      { command: "sox", args: ["play"], detached: true },
    ])
    expect(capture).toBe(children[0]!.stdout)
    expect(playback).toBe(children[1]!.stdin)
    // The pid file lists the pids at once, without waiting for ps...
    expect(fs.readFileSync(pidFile, "utf8")).toBe("1001\t\n1002\t\n")
    // ...and gains the start times when the non-blocking ps lookups answer.
    await vi.waitFor(() => expect(fs.readFileSync(pidFile, "utf8").trim().split("\n")).toEqual(["1001\tstart-1001", "1002\tstart-1002"]))
  })

  it("does not recreate the pid file when the devices stopped before ps answered", async () => {
    const { devices, pidFile } = make()
    devices.start()
    devices.stop()
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(fs.existsSync(pidFile)).toBe(false)
  })

  it("skips a child that exited before its start time arrived, and survives a vanished state directory", async () => {
    const { devices, children, pidFile } = make()
    devices.start()
    children[0]!.emit("exit", 0, null)
    await vi.waitFor(() => expect(fs.readFileSync(pidFile, "utf8")).toBe("1002\tstart-1002\n"))
    const gone = make()
    gone.devices.start()
    fs.rmSync(path.dirname(gone.pidFile), { recursive: true, force: true })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(fs.existsSync(gone.pidFile)).toBe(false)
  })

  it("records an empty start time when the process cannot be inspected, so a later sweep will not kill it", async () => {
    const { devices, killed, pidFile } = make({ inspectProcess: () => null })
    devices.start()
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(fs.readFileSync(pidFile, "utf8")).toBe("1001\t\n1002\t\n")
    const sweeper = make({ inspectProcess: () => ({ command: "sox", startTime: "T" }) })
    fs.mkdirSync(path.dirname(sweeper.pidFile), { recursive: true })
    fs.writeFileSync(sweeper.pidFile, fs.readFileSync(pidFile))
    expect(sweeper.devices.sweepStale()).toBe(0)
    expect(sweeper.killed).toEqual([])
    expect(killed).toEqual([])
  })

  it("uses a custom sox path and tolerates missing pids and stdio", async () => {
    const { devices, children, pidFile } = make({ pids: [undefined, 77], soxPath: "/opt/sox" })
    devices.start()
    await vi.waitFor(() => expect(fs.readFileSync(pidFile, "utf8").trim()).toBe("77\tstart-77"))
    expect(children).toHaveLength(2)
  })

  it("runs playback with its own command when one is given", () => {
    const { devices, calls } = make({ playbackCommand: "ffmpeg" })
    devices.start()
    expect(calls.map((c) => c.command)).toEqual(["sox", "ffmpeg"])
  })

  it("throws and cleans up when a child has no stdio", () => {
    const { spawner, children } = makeSpawner()
    const original = spawner.spawn.bind(spawner)
    spawner.spawn = (c, a, o) => {
      const child = original(c, a, o) as FakeChild
      ;(child as unknown as { stdout: null }).stdout = null
      return child
    }
    const killed: number[] = []
    const devices = new LocalAudioDevices({
      spawner, captureArgs: [], playbackArgs: [], pidFile: path.join(dir, "p"),
      killGroup: (pid) => { killed.push(pid); return true }, inspectProcess: (pid) => ({ command: "sox", startTime: `start-${pid}` }),
      inspectProcessAsync: async () => null, setTimer: () => 0,
    })
    expect(() => devices.start()).toThrow(/stdio/)
    expect(killed).toEqual([1001, 1002])
    expect(children).toHaveLength(2)
  })

  it("stop kills both process groups with SIGTERM, removes the pid file, and is idempotent", () => {
    const { devices, killed, pidFile } = make()
    devices.start()
    devices.stop()
    expect(killed).toEqual([{ pid: 1001, signal: "SIGTERM" }, { pid: 1002, signal: "SIGTERM" }])
    expect(fs.existsSync(pidFile)).toBe(false)
    devices.stop()
    expect(killed).toHaveLength(2)
  })

  it("stop falls back to child.kill when the group kill fails or there is no pid", () => {
    const { devices, children } = make({ killGroup: () => false, pids: [1001, undefined] })
    devices.start()
    devices.stop()
    expect(children[0]!.kills).toEqual(["SIGTERM"])
    expect(children[1]!.kills).toEqual(["SIGTERM"])
  })

  it("forgets a child that exits on its own so stop does not signal a reused pid", () => {
    const { devices, children, killed } = make()
    devices.start()
    children[0]!.emit("exit", 0, null)
    devices.stop()
    expect(killed).toEqual([{ pid: 1002, signal: "SIGTERM" }])
  })

  it("start stops anything it already started", () => {
    const { devices, killed } = make({ pids: [1, 2, 3, 4] })
    devices.start()
    devices.start()
    expect(killed.map((k) => k.pid)).toEqual([1, 2])
  })

  it("sweepStale kills sox groups left in a stale pid file and returns the count", () => {
    const infos: Record<number, ProcessInfo | null> = {
      111: { command: "/opt/homebrew/bin/sox", startTime: "T1" },
      222: { command: "sox", startTime: "T2" },
      333: { command: "/bin/zsh", startTime: "T3" },
      444: { command: "sox", startTime: "REUSED" },
      555: null,
      666: { command: "sox", startTime: "T6" },
      777: { command: "/opt/homebrew/bin/ffmpeg", startTime: "T7" },
    }
    const { devices, killed, pidFile, timers } = make({ inspectProcess: (pid) => infos[pid] ?? null })
    fs.mkdirSync(path.dirname(pidFile), { recursive: true })
    fs.writeFileSync(pidFile, "111\tT1\n222\tT2\n333\tT3\n444\tT4\n555\tT5\n666\n777\tT7\n999\tT9\nnot-a-pid\n\n-5\n")
    expect(devices.sweepStale()).toBe(3)
    expect(killed).toEqual([{ pid: 111, signal: "SIGTERM" }, { pid: 222, signal: "SIGTERM" }, { pid: 777, signal: "SIGTERM" }])
    expect(fs.existsSync(pidFile)).toBe(false)
    // sox that ignored SIGTERM gets SIGKILL after the grace; one that died (or was replaced) is left alone.
    expect(timers.map((t) => t.ms)).toEqual([500])
    delete infos[222]
    delete infos[777]
    timers[0]!.cb()
    expect(killed.slice(3)).toEqual([{ pid: 111, signal: "SIGKILL" }])
  })

  it("sweepStale returns 0 when there is no pid file and does not count failed kills", () => {
    const missing = make()
    expect(missing.devices.sweepStale()).toBe(0)
    const failing = make({ killGroup: () => false })
    fs.mkdirSync(path.dirname(failing.pidFile), { recursive: true })
    fs.writeFileSync(failing.pidFile, "9\tstart-9\n")
    expect(failing.devices.sweepStale()).toBe(0)
  })
})

describe("default process helpers", () => {
  it("defaultInspectProcess reports command and start time for a live process and null for a missing one", () => {
    const info = defaultInspectProcess(process.pid)
    expect(info?.command).toMatch(/node/)
    expect(info?.startTime).toMatch(/^\w{3} \w{3}\s+\d+ \d\d:\d\d:\d\d \d{4}$/)
    // Locale independent: the month and weekday words are not matched by name, and ps runs with LC_ALL=C.
    expect(defaultInspectProcess(1, () => "ven. oct.  9 00:34:22 2026   sox")).toEqual({ startTime: "ven. oct.  9 00:34:22 2026", command: "sox" })
    expect(PS_ENV.LC_ALL).toBe("C")
    expect(defaultInspectProcess(process.pid)?.startTime).toBe(info?.startTime)
    expect(defaultInspectProcess(2147483646)).toBeNull()
    expect(defaultInspectProcess(1, () => "garbage output")).toBeNull()
    expect(defaultInspectProcess(1, () => "Fri Oct  9 00:34:22 2026   /usr/bin/some tool")).toEqual({
      startTime: "Fri Oct  9 00:34:22 2026",
      command: "/usr/bin/some tool",
    })
  })

  it("defaultInspectProcessAsync answers like the sync lookup without blocking, and yields null on failure", async () => {
    const info = await defaultInspectProcessAsync(process.pid)
    expect(info?.command).toMatch(/node/)
    expect(info?.startTime).toBe(defaultInspectProcess(process.pid)?.startTime)
    expect(await defaultInspectProcessAsync(2147483646)).toBeNull()
    expect(await defaultInspectProcessAsync(1, async () => "garbage")).toBeNull()
    expect(await defaultInspectProcessAsync(1, async () => { throw new Error("no ps") })).toBeNull()
  })

  it("LocalAudioDevices falls back to the default group-kill and process inspection", async () => {
    const { spawner, children } = makeSpawner([undefined, undefined])
    const devices = new LocalAudioDevices({ spawner, captureArgs: [], playbackArgs: [], pidFile: path.join(dir, "default.pids") })
    devices.start()
    devices.stop()
    expect(children.map((c) => c.kills)).toEqual([["SIGTERM"], ["SIGTERM"]])
    await new Promise((resolve) => setTimeout(resolve, 50))
    fs.writeFileSync(path.join(dir, "default.pids"), "2147483646\tT\n")
    expect(devices.sweepStale()).toBe(0)
  })

  it("defaultKillGroup signals a real process group and reports failure for a missing one", async () => {
    const child = spawn("sleep", ["30"], { detached: true, stdio: "ignore" })
    const exited = new Promise<void>((resolve) => child.on("exit", () => resolve()))
    expect(defaultKillGroup(child.pid!, "SIGTERM")).toBe(true)
    await exited
    expect(defaultKillGroup(2147483646, "SIGTERM")).toBe(false)
  })
})

describe("defaultProcessHost", () => {
  it("reports the real listener count for a signal", async () => {
    const { defaultProcessHost } = await import("../../../senses/voice/local-audio-devices")
    expect(defaultProcessHost.listenerCount("SIGUSR2")).toBe(process.listenerCount("SIGUSR2"))
  })
})

describe("checkLocalAudioRouting", () => {
  function inspection(overrides: Partial<VoiceAudioRoutingInspection>): VoiceAudioRoutingInspection {
    return { status: "ready", hasCaptureDevice: true, hasOutputDevice: true, currentOutput: null, missing: [], guidance: [], ...overrides }
  }

  it("asks for the BlackHole pair and reports ok with app routing steps when ready", async () => {
    const seen: unknown[] = []
    const result = await checkLocalAudioRouting(async (options) => { seen.push(options); return inspection({}) })
    expect(seen).toEqual([{ captureDeviceName: "BlackHole 16ch", outputDeviceName: "BlackHole 2ch" }])
    expect(result.ok).toBe(true)
    expect(result.steps.join("\n")).toContain("microphone")
    expect(result.steps.join("\n")).toContain("BlackHole 16ch")
    expect(result.steps.join("\n")).not.toContain("brew install")
  })

  it("does not claim the BlackHole devices are missing when the inspection itself failed", async () => {
    const result = await checkLocalAudioRouting(async () =>
      inspection({ status: "unknown", hasCaptureDevice: false, hasOutputDevice: false, missing: ["BlackHole 16ch", "BlackHole 2ch"], error: "boom" }))
    expect(result.ok).toBe(false)
    expect(result.steps[0]).toBe("Audio device inspection failed: boom")
    expect(result.steps.join("\n")).not.toContain("brew install --cask")
  })

  it("tells the owner to install SwitchAudioSource when that tool is missing", async () => {
    for (const error of ["spawn SwitchAudioSource ENOENT", "SwitchAudioSource: command not found"]) {
      const result = await checkLocalAudioRouting(async () =>
        inspection({ status: "unknown", hasCaptureDevice: false, hasOutputDevice: false, missing: ["BlackHole 16ch", "BlackHole 2ch"], error }))
      expect(result.ok).toBe(false)
      expect(result.steps[0]).toContain("brew install switchaudio-osx")
      expect(result.steps.join("\n")).not.toContain("brew install --cask")
    }
  })

  it("reports an inspection that failed without saying why", async () => {
    const result = await checkLocalAudioRouting(async () => inspection({ status: "unknown", missing: [] }))
    expect(result.steps[0]).toBe("Audio device inspection failed: unknown error")
  })

  it("lists the install step for devices that are genuinely missing", async () => {
    const result = await checkLocalAudioRouting(async () =>
      inspection({ status: "needs_setup", hasCaptureDevice: false, hasOutputDevice: false, missing: ["BlackHole 16ch", "BlackHole 2ch"] }))
    expect(result.steps[0]).toContain("brew install --cask blackhole-16ch blackhole-2ch")
  })

  it("installs only the one missing device", async () => {
    const result = await checkLocalAudioRouting(async () =>
      inspection({ status: "needs_setup", hasCaptureDevice: true, hasOutputDevice: false, missing: ["BlackHole 2ch"] }))
    expect(result.ok).toBe(false)
    expect(result.steps[0]).toContain("blackhole-2ch")
    expect(result.steps[0]).not.toContain("blackhole-16ch")
  })
})

describe("LocalAudioDevices.finish", () => {
  it("ends the playback stream and waits for sox to exit so a file output is finalized", async () => {
    const { spawner, children } = makeSpawner([1001, 1002])
    const killed: number[] = []
    const devices = new LocalAudioDevices({
      spawner, captureArgs: [], playbackArgs: [], pidFile: path.join(dir, "fin.pids"),
      killGroup: (pid) => { killed.push(pid); return true }, inspectProcess: () => null, processHost: new FakeProcessHost(),
    })
    const { playback } = devices.start()
    let ended = false
    playback.on("finish", () => { ended = true })
    const done = devices.finish(1000)
    children[1]!.emit("exit", 0, null)
    await done
    await new Promise((resolve) => setImmediate(resolve))
    expect(ended).toBe(true)
    expect(killed).toEqual([1001])
  })

  it("gives up waiting after the timeout and still stops everything", async () => {
    const { spawner } = makeSpawner([1001, 1002])
    const killed: number[] = []
    const devices = new LocalAudioDevices({
      spawner, captureArgs: [], playbackArgs: [], pidFile: path.join(dir, "fin2.pids"),
      killGroup: (pid) => { killed.push(pid); return true }, inspectProcess: () => null, processHost: new FakeProcessHost(),
    })
    devices.start()
    await devices.finish(5)
    expect(killed).toEqual([1001, 1002])
    await devices.finish(5)
  })
})

describe("probeCaptureLoopback", () => {
  function setup(extra: { device?: string; pids?: Array<number | undefined>; killGroup?: (pid: number, signal: NodeJS.Signals) => boolean } = {}) {
    const { spawner, children, calls } = makeSpawner(extra.pids ?? [4242, 4243])
    const timers: Array<{ cb: () => void; ms: number; cleared: boolean }> = []
    const killed: number[] = []
    const run = probeCaptureLoopback({
      spawner,
      soxPath: "/opt/sox",
      device: extra.device,
      timeoutMs: 1500,
      openTimeoutMs: 40_000,
      setTimer: (cb, ms) => { const t = { cb, ms, cleared: false }; timers.push(t); return t },
      clearTimer: (h) => { (h as { cleared: boolean }).cleared = true },
      killGroup: extra.killGroup ?? ((pid) => { killed.push(pid); return true }),
    })
    return { run, timers, children, calls, killed }
  }

  it("starts the tone only after the listener's first chunk, so a slow CoreAudio open cannot miss it", async () => {
    const { run, timers, calls, killed, children } = setup()
    expect(calls).toEqual([{ command: "/opt/sox", args: soxCaptureArgs("BlackHole 16ch"), detached: true }])
    expect(soxProbeToneArgs("X")).toEqual(["-q", "-n", "-t", "coreaudio", "X", "synth", "3", "sine", "1000", "vol", "0.2"])
    // The capture takes its time to open: waiting on it uses the open timeout, not the hearing timeout.
    expect(timers.map((t) => t.ms)).toEqual([40_000])
    children[0]!.stdout.write(Buffer.alloc(160, 0xff))
    expect(calls).toHaveLength(2)
    expect(calls[1]).toEqual({ command: "/opt/sox", args: soxProbeToneArgs("BlackHole 16ch"), detached: true })
    expect(timers[0]!.cleared).toBe(true)
    expect(timers.map((t) => t.ms)).toEqual([40_000, 1500])
    // Silence keeps listening; the tone is not started a second time.
    children[0]!.stdout.write(Buffer.alloc(160, 0xff))
    expect(calls).toHaveLength(2)
    children[0]!.stdout.write(Buffer.alloc(160, 0x10))
    await expect(run).resolves.toEqual({ ok: true })
    expect(timers[1]!.cleared).toBe(true)
    expect(killed.sort()).toEqual([4242, 4243])
    expect(children[0]!.stdout.listenerCount("data")).toBe(0)
    children[0]!.emit("exit", 0, null)
    expect(killed).toHaveLength(2)
  })

  it("hears the tone even when the capture needed a long time to open", async () => {
    const { run, timers, calls, children } = setup()
    // Far past the hearing timeout, but still inside the open timeout: nothing has failed yet.
    expect(timers[0]!.cleared).toBe(false)
    expect(calls).toHaveLength(1)
    children[0]!.stdout.write(Buffer.alloc(160, 0x20))
    await expect(run).resolves.toEqual({ ok: true })
    expect(calls).toHaveLength(2)
  })

  it("fails with both fixes named when only silence arrives before the timeout", async () => {
    const { run, timers, children } = setup({ pids: [undefined, undefined], device: "Custom Device" })
    children[0]!.stdout.write(Buffer.alloc(160, 0xff))
    timers[1]!.cb()
    const result = await run
    expect(result.ok).toBe(false)
    expect(result.reason).toContain("microphone permission")
    expect(result.reason).toContain("muted")
    expect(result.reason).toContain("Custom Device")
    expect(result.reason).toContain("heard nothing from the probe tone")
    expect(children[0]!.kills).toEqual(["SIGTERM"])
    expect(children[1]!.kills).toEqual(["SIGTERM"])
  })

  it("fails without starting a tone when the capture never delivers anything", async () => {
    const { run, timers, calls, children } = setup({ pids: [undefined, undefined] })
    timers[0]!.cb()
    const result = await run
    expect(result.ok).toBe(false)
    expect(result.reason).toContain("delivered no audio at all within 40000 ms")
    expect(calls).toHaveLength(1)
    expect(children[0]!.kills).toEqual(["SIGTERM"])
  })

  it("fails when the capture process dies before hearing the tone", async () => {
    const { run, children } = setup()
    children[0]!.emit("exit", 1, null)
    const result = await run
    expect(result.ok).toBe(false)
    expect(result.reason).toContain("capture process exited")
  })

  it("does not escalate to SIGKILL for a child that exited during the grace period, and does for one that did not", async () => {
    const { spawner, children } = makeSpawner([2001, 2002])
    const signals: Array<{ pid: number; signal: string }> = []
    const timers: Array<() => void> = []
    const probe = probeCaptureLoopback({
      spawner, timeoutMs: 1500,
      setTimer: (cb) => { timers.push(cb); return timers.length }, clearTimer: () => undefined,
      killGroup: (pid, signal) => { signals.push({ pid, signal }); return true },
    })
    children[0]!.stdout.write(Buffer.alloc(160, 0x20))
    await probe
    expect(signals).toEqual([{ pid: 2001, signal: "SIGTERM" }, { pid: 2002, signal: "SIGTERM" }])
    // The listener obeyed SIGTERM; the tone did not.
    children[0]!.emit("exit", 0, null)
    for (const cb of timers) cb()
    expect(signals.slice(2)).toEqual([{ pid: 2002, signal: "SIGKILL" }])
  })

  it("stops at once, killing its processes, when it is aborted (the join was cancelled)", async () => {
    const controller = new AbortController()
    const { spawner, children } = makeSpawner([6001, 6002])
    const killed: number[] = []
    const run = probeCaptureLoopback({
      spawner, signal: controller.signal, setTimer: () => 0, clearTimer: () => undefined,
      killGroup: (pid) => { killed.push(pid); return true },
    })
    children[0]!.stdout.write(Buffer.alloc(160, 0xff))
    controller.abort()
    const result = await run
    expect(result).toEqual({ ok: false, reason: "cancelled" })
    expect(killed).toEqual([6001, 6002])
  })

  it("does not even start when it is already aborted", async () => {
    const controller = new AbortController()
    controller.abort()
    const { spawner, calls } = makeSpawner([6001, 6002])
    const result = await probeCaptureLoopback({ spawner, signal: controller.signal, setTimer: () => 0, clearTimer: () => undefined, killGroup: () => true })
    expect(result).toEqual({ ok: false, reason: "cancelled" })
    expect(calls).toHaveLength(0)
  })

  it("falls back to child.kill when the group kill fails and uses default timing options", async () => {
    const { run, children } = setup({ killGroup: () => false })
    children[0]!.stdout.write(Buffer.alloc(160, 0x20))
    await run
    expect(children[0]!.kills).toEqual(["SIGTERM"])

    const idle = makeSpawner([undefined, undefined])
    const timedOut = probeCaptureLoopback({ spawner: idle.spawner, openTimeoutMs: 5 })
    expect((await timedOut).ok).toBe(false)
    const silent = makeSpawner([undefined, undefined])
    const hearing = probeCaptureLoopback({ spawner: silent.spawner, timeoutMs: 5 })
    silent.children[0]!.stdout.write(Buffer.alloc(160, 0xff))
    expect((await hearing).ok).toBe(false)
    const quick = makeSpawner([undefined, undefined])
    const heard = probeCaptureLoopback({ spawner: quick.spawner })
    quick.children[0]!.stdout.write(Buffer.alloc(160, 0x20))
    await expect(heard).resolves.toEqual({ ok: true })
  })
})

class FakeProcessHost implements ProcessSignalHost {
  handlers = new Map<string, Array<() => void>>()
  pid = 777
  reraised: string[] = []
  /** Listeners owned by someone else (the join runner's own stop handler). */
  others = 0
  once(event: string, listener: () => void): this {
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), listener])
    return this
  }
  off(event: string, listener: () => void): this {
    this.handlers.set(event, (this.handlers.get(event) ?? []).filter((l) => l !== listener))
    return this
  }
  kill(pid: number, signal: NodeJS.Signals): void {
    this.reraised.push(`${pid}:${signal}`)
  }
  emit(event: string): void {
    for (const l of [...(this.handlers.get(event) ?? [])]) l()
  }
  listenerCount(event: string): number {
    return (this.handlers.get(event) ?? []).length + this.others
  }
  count(): number {
    return [...this.handlers.values()].reduce((n, l) => n + l.length, 0)
  }
}

describe("LocalAudioDevices parent signal cleanup", () => {
  function make(host: FakeProcessHost) {
    const { spawner, children } = makeSpawner([1001, 1002])
    const killed: number[] = []
    const devices = new LocalAudioDevices({
      spawner, captureArgs: [], playbackArgs: [], pidFile: path.join(dir, "sig.pids"),
      killGroup: (pid) => { killed.push(pid); return true },
      inspectProcess: () => null,
      processHost: host,
    })
    return { devices, children, killed }
  }

  it.each(["SIGINT", "SIGTERM"])("kills sox on %s and then re-raises the signal", (signal) => {
    const host = new FakeProcessHost()
    const { devices, killed } = make(host)
    devices.start()
    expect(host.count()).toBe(3)
    host.emit(signal)
    expect(killed).toEqual([1001, 1002])
    expect(host.count()).toBe(0)
    expect(host.reraised).toEqual([`777:${signal}`])
  })

  it("kills sox when the process exits and removes its handlers on a normal stop", () => {
    const host = new FakeProcessHost()
    const first = make(host)
    first.devices.start()
    host.emit("exit")
    expect(first.killed).toEqual([1001, 1002])
    expect(host.reraised).toEqual([])

    const second = make(host)
    second.devices.start()
    second.devices.stop()
    expect(host.count()).toBe(0)
  })

  it("uses the real process object by default", () => {
    const before = process.listenerCount("SIGINT")
    const { spawner } = makeSpawner([undefined, undefined])
    const devices = new LocalAudioDevices({ spawner, captureArgs: [], playbackArgs: [], pidFile: path.join(dir, "real.pids") })
    devices.start()
    expect(process.listenerCount("SIGINT")).toBe(before + 1)
    devices.stop()
    expect(process.listenerCount("SIGINT")).toBe(before)
  })
})

describe("defaultProcessHost", () => {
  it("is the real process: its pid, listeners and signal 0", async () => {
    const { defaultProcessHost } = await import("../../../senses/voice/local-audio-devices")
    expect(defaultProcessHost.pid).toBe(process.pid)
    const listener = (): void => undefined
    const before = process.listenerCount("SIGUSR2")
    defaultProcessHost.once("SIGUSR2", listener)
    expect(process.listenerCount("SIGUSR2")).toBe(before + 1)
    defaultProcessHost.off("SIGUSR2", listener)
    expect(process.listenerCount("SIGUSR2")).toBe(before)
    expect(defaultProcessHost.kill(process.pid, 0)).toBe(true)
  })
})

describe("sox that ignores SIGTERM", () => {
  // Real sox blocked in a CoreAudio call or a stdin read does not act on SIGTERM; it must be SIGKILLed.
  function make(host?: ProcessSignalHost) {
    const { spawner, children } = makeSpawner([1001, 1002])
    const signals: Array<{ pid: number; signal: string }> = []
    const timers: Array<{ cb: () => void; ms: number; cleared: boolean }> = []
    const devices = new LocalAudioDevices({
      spawner, captureArgs: [], playbackArgs: [], pidFile: path.join(dir, "kill.pids"),
      killGroup: (pid, signal) => { signals.push({ pid, signal }); return true },
      inspectProcess: () => null,
      processHost: host,
      setTimer: (cb, ms) => { const t = { cb, ms, cleared: false }; timers.push(t); return t },
      clearTimer: (h) => { (h as { cleared: boolean }).cleared = true },
    })
    return { devices, children, signals, timers }
  }

  it("stop sends SIGTERM now and SIGKILL after a short grace to any sox still alive", () => {
    const { devices, children, signals, timers } = make()
    devices.start()
    devices.stop()
    expect(signals).toEqual([{ pid: 1001, signal: "SIGTERM" }, { pid: 1002, signal: "SIGTERM" }])
    expect(timers).toHaveLength(1)
    expect(timers[0]!.ms).toBeLessThanOrEqual(1000)
    children[0]!.emit("exit", 0, null)
    timers[0]!.cb()
    expect(signals.slice(2)).toEqual([{ pid: 1002, signal: "SIGKILL" }])
  })

  it("does not schedule a SIGKILL when nothing was running", () => {
    const { devices, timers } = make()
    devices.stop()
    expect(timers).toHaveLength(0)
  })

  it("falls back to child.kill for the SIGKILL when the group is gone", () => {
    const { spawner, children } = makeSpawner([undefined, 1002])
    const timers: Array<() => void> = []
    const devices = new LocalAudioDevices({
      spawner, captureArgs: [], playbackArgs: [], pidFile: path.join(dir, "kill2.pids"),
      killGroup: () => false, inspectProcess: () => null,
      setTimer: (cb) => { timers.push(cb); return 1 }, clearTimer: () => undefined,
    })
    devices.start()
    devices.stop()
    timers[0]!()
    // The child with no pid never started, so there is nothing to escalate.
    expect(children[0]!.kills).toEqual(["SIGTERM"])
    expect(children[1]!.kills).toEqual(["SIGTERM", "SIGKILL"])
  })

  it("SIGKILLs immediately when the parent is exiting or being signalled, since no timer would run", () => {
    const host = new FakeProcessHost()
    const first = make(host)
    first.devices.start()
    host.emit("exit")
    expect(first.signals).toEqual([{ pid: 1001, signal: "SIGKILL" }, { pid: 1002, signal: "SIGKILL" }])
    expect(first.timers).toHaveLength(0)
    const second = make(host)
    second.devices.start()
    host.emit("SIGTERM")
    expect(second.signals).toEqual([{ pid: 1001, signal: "SIGKILL" }, { pid: 1002, signal: "SIGKILL" }])
    expect(host.reraised).toEqual(["777:SIGTERM"])
  })

  it("does not re-raise a stop signal when another listener owns the shutdown", () => {
    const host = new FakeProcessHost()
    host.others = 1
    const { devices, signals } = make(host)
    devices.start()
    host.emit("SIGTERM")
    expect(signals).toEqual([{ pid: 1001, signal: "SIGKILL" }, { pid: 1002, signal: "SIGKILL" }])
    expect(host.reraised).toEqual([])
  })

  it("lets a file's WAV writer finish on a stop signal: EOF and SIGTERM first, SIGKILL only after the grace", async () => {
    const host = new FakeProcessHost()
    const { spawner, children } = makeSpawner([1001, 1002])
    const signals: Array<{ pid: number; signal: string }> = []
    const timers: Array<() => void> = []
    const devices = new LocalAudioDevices({
      spawner, captureArgs: [], playbackArgs: [], pidFile: path.join(dir, "wav.pids"),
      killGroup: (pid, signal) => { signals.push({ pid, signal }); return true },
      inspectProcess: () => null, inspectProcessAsync: async () => null, processHost: host, gracefulPlayback: true,
      setTimer: (cb) => { timers.push(cb); return timers.length },
    })
    const { playback } = devices.start()
    let ended = false
    playback.on("finish", () => { ended = true })
    host.emit("SIGTERM")
    expect(signals).toEqual([{ pid: 1001, signal: "SIGKILL" }, { pid: 1002, signal: "SIGTERM" }])
    expect(ended).toBe(false)
    await new Promise((resolve) => setImmediate(resolve))
    expect(ended).toBe(true)
    expect(host.reraised).toEqual([])
    expect(timers).toHaveLength(1)
    timers[0]!()
    expect(signals.slice(2)).toEqual([{ pid: 1001, signal: "SIGKILL" }, { pid: 1002, signal: "SIGKILL" }])
    expect(host.reraised).toEqual(["777:SIGTERM"])
    expect(children).toHaveLength(2)
  })

  it("falls back to killing the child directly when its process group cannot be signalled, and uses real timers by default", async () => {
    vi.useFakeTimers()
    try {
      const host = new FakeProcessHost()
      const { spawner, children } = makeSpawner([1001, 1002])
      const killed: Array<{ index: number; signal: unknown }> = []
      const devices = new LocalAudioDevices({
        spawner, captureArgs: [], playbackArgs: [], pidFile: path.join(dir, "fallback.pids"),
        killGroup: () => false, inspectProcess: () => null, inspectProcessAsync: async () => null, processHost: host, gracefulPlayback: true,
      })
      devices.start()
      children.forEach((child, index) => { child.kill = ((signal: unknown) => { killed.push({ index, signal }); return true }) as never })
      host.emit("SIGTERM")
      expect(killed).toEqual([{ index: 0, signal: "SIGKILL" }, { index: 1, signal: "SIGTERM" }])
      await vi.advanceTimersByTimeAsync(600)
      expect(host.reraised).toEqual(["777:SIGTERM"])
    } finally {
      vi.useRealTimers()
    }
  })

  it("the capture probe also escalates to SIGKILL for its listener and tone", async () => {
    const { spawner, children } = makeSpawner([2001, 2002])
    const signals: Array<{ pid: number; signal: string }> = []
    const timers: Array<() => void> = []
    const probe = probeCaptureLoopback({
      spawner, timeoutMs: 1500,
      setTimer: (cb) => { timers.push(cb); return timers.length }, clearTimer: () => undefined,
      killGroup: (pid, signal) => { signals.push({ pid, signal }); return true },
    })
    children[0]!.stdout.write(Buffer.alloc(160, 0x20))
    expect((await probe).ok).toBe(true)
    expect(signals).toEqual([{ pid: 2001, signal: "SIGTERM" }, { pid: 2002, signal: "SIGTERM" }])
    for (const cb of timers) cb()
    expect(signals.slice(2)).toEqual([{ pid: 2001, signal: "SIGKILL" }, { pid: 2002, signal: "SIGKILL" }])
  })
})
