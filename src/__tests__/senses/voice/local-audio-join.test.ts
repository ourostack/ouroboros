import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("../../../senses/voice/twilio-phone-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../senses/voice/twilio-phone-runtime")>()),
  resolveLocalAudioRealtimeOptions: vi.fn(async () => ({ apiKey: "mocked-key" })),
}))
const notifyLive = vi.hoisted(() => vi.fn(async () => "delivered_now"))
vi.mock("../../../senses/voice/local-audio-notify", () => ({ notifyOwnerLive: notifyLive }))
import {
  LocalAudioControlServer,
  acquireJoinLock,
  localAudioPaths,
  readJoinStatus,
  sendLocalAudioControl,
  writeJoinStatus,
} from "../../../senses/voice/local-audio-control"
import {
  defaultLaunchSpawn,
  defaultLocalAudioJoinDeps,
  launchLocalAudioJoin,
  localAudioJoinArgs,
  parseNotifySession,
  runLocalAudioJoin,
  runLocalAudioLeave,
  runLocalAudioStatus,
  type LocalAudioJoinDeps,
} from "../../../senses/voice/local-audio-join"
import type { LocalAudioDeviceTransport, LocalAudioJoinRequest } from "../../../senses/voice/local-audio-transport"

let root: string
let agentRoot: string
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "laj-"))
  agentRoot = path.join(root, "slugger.ouro")
})
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }) })

function fakeTransport(options: { startError?: string; slowStart?: boolean } = {}) {
  let resolveEnded!: (s: { reason: string; callSid: string; durationMs: number }) => void
  const ended = new Promise<{ reason: string; callSid: string; durationMs: number }>((r) => { resolveEnded = r })
  let state = "idle"
  let releaseStart: () => void = () => undefined
  const transport = {
    ended,
    start: vi.fn(async () => {
      if (options.slowStart) await new Promise<void>((resolve) => { releaseStart = resolve })
      if (state === "ended") return
      if (options.startError) { state = "failed"; throw new Error(options.startError) }
      state = "joined"
    }),
    leave: vi.fn(async (reason = "left") => { state = "ended"; resolveEnded({ reason, callSid: "local-audio-abc", durationMs: 4200 }); releaseStart() }),
    status: vi.fn(() => ({ state, callSid: "local-audio-abc" })),
  }
  return { transport: transport as unknown as LocalAudioDeviceTransport, raw: transport, finish: (reason = "idle_silence") => { state = "ended"; resolveEnded({ reason, callSid: "local-audio-abc", durationMs: 9000 }) } }
}

function makeDeps(extra: Partial<LocalAudioJoinDeps> & { transport?: ReturnType<typeof fakeTransport> } = {}) {
  const out: string[] = []
  const notices: Array<{ target: unknown; text: string }> = []
  const signals: Array<() => void> = []
  const transport = extra.transport ?? fakeTransport()
  let seenBridge: unknown
  const deps: LocalAudioJoinDeps = {
    agentRoot: () => agentRoot,
    resolveRealtime: async () => ({ apiKey: "fixture-key", apiKeySource: "voice.openaiRealtimeApiKey" }),
    createTransport: (_request, bridge) => { seenBridge = bridge; return transport.transport },
    notifyOwner: async (_agent, target, text) => { notices.push({ target, text }) },
    write: (text) => { out.push(text) },
    onStopSignal: (cb) => { signals.push(cb); return () => undefined },
    ...extra,
  }
  return { deps, out, notices, signals, transport, bridge: () => seenBridge }
}

const request: LocalAudioJoinRequest = { agentName: "slugger", friendId: "ari", participants: "Ari, Sam", occasion: "podcast prep", notify: { friendId: "ari", channel: "cli", key: "session" } }

describe("parseNotifySession", () => {
  it("parses friend:channel:key, keeping colons inside the key", () => {
    expect(parseNotifySession("ari:cli:session")).toEqual({ friendId: "ari", channel: "cli", key: "session" })
    expect(parseNotifySession("ari:teams:19:abc@thread")).toEqual({ friendId: "ari", channel: "teams", key: "19:abc@thread" })
  })
  it("refuses anything that could escape the pending directory", () => {
    for (const bad of ["", "ari:cli", "../x:cli:k", "ari:../cli:k", "ari:cli:..", "ari:cli:a/b", "ari:cli:a\\b", "ari::k", ":cli:k", "ari:cli:"]) {
      expect(parseNotifySession(bad)).toBeNull()
    }
  })
})

describe("localAudioJoinArgs", () => {
  it("builds one flag per stated fact and nothing else", () => {
    expect(localAudioJoinArgs({ ...request, ownerAlone: true, ownerName: "Ari", silentConsent: "everyone agreed", mode: "conversation" })).toEqual([
      "voice", "join", "--agent", "slugger", "--friend", "ari", "--participants", "Ari, Sam", "--occasion", "podcast prep", "--mode", "conversation",
      "--owner-alone", "--owner-name", "Ari", "--silent-consent", "everyone agreed", "--notify-session", "ari:cli:session",
    ])
    expect(localAudioJoinArgs({ agentName: "slugger" })).toEqual(["voice", "join", "--agent", "slugger"])
    expect(localAudioJoinArgs({ agentName: "slugger", files: { inputPath: "/a.wav", outputPath: "/b.wav" }, idleSilenceMs: 5000, maxDurationMs: 60000 })).toEqual([
      "voice", "join", "--agent", "slugger", "--input-file", "/a.wav", "--output-file", "/b.wav", "--idle-silence-ms", "5000", "--max-duration-ms", "60000",
    ])
  })
})

describe("runLocalAudioJoin", () => {
  it("joins, serves leave on the control socket, and reports the end to the owner", async () => {
    const h = makeDeps()
    const joined = runLocalAudioJoin(request, h.deps)
    const paths = localAudioPaths(agentRoot)
    await vi.waitFor(() => expect(readJoinStatus(paths)?.state).toBe("joined"))
    expect((h.bridge() as { openaiRealtime: { apiKey: string }; agentName: string }).openaiRealtime.apiKey).toBe("fixture-key")
    expect(h.out.join("\n")).toContain("local-audio-abc")
    expect(h.notices[0]!.target).toEqual({ friendId: "ari", channel: "cli", key: "session" })
    expect(h.notices[0]!.text).toMatch(/joined/i)
    expect(h.notices[0]!.text).toContain("Ari, Sam")
    expect((await sendLocalAudioControl(paths, "status")).ok).toBe(true)
    expect((await sendLocalAudioControl(paths, "leave")).ok).toBe(true)
    const summary = await joined
    expect(summary.reason).toBe("left")
    expect(readJoinStatus(paths)).toMatchObject({ state: "ended", reason: "left" })
    expect(h.notices[1]!.text).toMatch(/left/i)
    expect(h.notices[1]!.text).toContain("left")
    expect(fs.existsSync(paths.socketPath)).toBe(false)
  })

  it("says the join is silent and quotes the consent when the owner consented", async () => {
    const h = makeDeps()
    const joined = runLocalAudioJoin({ ...request, silentConsent: "Ari said all guests agreed" }, h.deps)
    await vi.waitFor(() => expect(h.notices).toHaveLength(1))
    expect(h.notices[0]!.text).toMatch(/silent/i)
    expect(h.notices[0]!.text).toContain("Ari said all guests agreed")
    h.transport.finish()
    expect((await joined).reason).toBe("idle_silence")
    expect(h.notices[1]!.text).toMatch(/idle/i)
  })

  it("leaves when the process is told to stop", async () => {
    const h = makeDeps()
    const joined = runLocalAudioJoin({ agentName: "slugger" }, h.deps)
    await vi.waitFor(() => expect(h.signals).toHaveLength(1))
    h.signals[0]!()
    expect((await joined).reason).toBe("left")
    expect(h.notices).toHaveLength(0)
  })

  it("refuses a second join while one is running", async () => {
    const paths = localAudioPaths(agentRoot)
    const server = new LocalAudioControlServer(paths, { status: () => ({ state: "joined", callSid: "local-audio-live" }) as never, leave: async () => undefined })
    await server.start()
    const h = makeDeps()
    await expect(runLocalAudioJoin(request, h.deps)).rejects.toThrow(/already running.*local-audio-live.*ouro voice leave/s)
    await server.close()
  })

  it("fails loudly, records why, and tears down when the join cannot start", async () => {
    const h = makeDeps({ transport: fakeTransport({ startError: "Local audio routing is not ready:\n- BlackHole 2ch is muted" }) })
    await expect(runLocalAudioJoin(request, h.deps)).rejects.toThrow(/BlackHole 2ch is muted/)
    const paths = localAudioPaths(agentRoot)
    expect(readJoinStatus(paths)).toMatchObject({ state: "failed", reason: expect.stringContaining("BlackHole 2ch is muted") })
    expect(fs.existsSync(paths.socketPath)).toBe(false)
    expect(h.notices).toHaveLength(1)
    expect(h.notices[0]!.text).toMatch(/could not join/i)
  })

  it("fails before any audio starts when the realtime key is missing", async () => {
    const h = makeDeps({ resolveRealtime: async () => { throw new Error("missing voice.openaiRealtimeApiKey") } })
    await expect(runLocalAudioJoin(request, h.deps)).rejects.toThrow(/openaiRealtimeApiKey/)
    expect(readJoinStatus(localAudioPaths(agentRoot))).toMatchObject({ state: "failed" })
    expect(h.transport.raw.start).not.toHaveBeenCalled()
  })

  it("works without an owner notification target", async () => {
    const h = makeDeps()
    const joined = runLocalAudioJoin({ agentName: "slugger" }, h.deps)
    await vi.waitFor(() => expect(readJoinStatus(localAudioPaths(agentRoot))?.state).toBe("joined"))
    h.transport.finish("capture_ended")
    await joined
    expect(h.notices).toHaveLength(0)
  })
})

describe("single join lock", () => {
  it("refuses a second join cleanly without touching the first one's socket, pid file or devices", async () => {
    const paths = localAudioPaths(agentRoot)
    const lock = acquireJoinLock(paths)
    expect(lock.ok).toBe(true)
    fs.writeFileSync(paths.socketPath, "first join, not listening yet")
    fs.writeFileSync(paths.pidFile, "{}")
    fs.writeFileSync(paths.soxPidFile, "1234 5678")
    const h = makeDeps()
    await expect(runLocalAudioJoin(request, h.deps)).rejects.toThrow(/already running.*ouro voice leave/s)
    expect(fs.existsSync(paths.socketPath)).toBe(true)
    expect(fs.existsSync(paths.pidFile)).toBe(true)
    expect(fs.readFileSync(paths.soxPidFile, "utf8")).toBe("1234 5678")
    expect(h.transport.raw.start).not.toHaveBeenCalled()
    expect(fs.existsSync(paths.lockFile)).toBe(true)
    if (lock.ok) lock.release()
  })

  it("names the running session when it answers, the holder process when it is still starting, and an unknown holder when the lock is unreadable", async () => {
    const paths = localAudioPaths(agentRoot)
    const lock = acquireJoinLock(paths)
    await expect(runLocalAudioJoin(request, makeDeps().deps)).rejects.toThrow(new RegExp(`starting, process ${process.pid}`))
    if (lock.ok) lock.release()
    fs.writeFileSync(paths.lockFile, "")
    await expect(runLocalAudioJoin(request, makeDeps().deps)).rejects.toThrow(/starting, process unknown/)
    fs.rmSync(paths.lockFile)
    const lock2 = acquireJoinLock(paths)
    const server = new LocalAudioControlServer(paths, { status: () => ({ state: "joined", callSid: "local-audio-live" }) as never, leave: async () => undefined })
    await server.start()
    await expect(runLocalAudioJoin(request, makeDeps().deps)).rejects.toThrow(/already running \(local-audio-live\)/)
    await server.close()
    if (lock2.ok) lock2.release()
  })

  it("holds the lock for the whole join and releases it afterwards, even after a failure", async () => {
    const paths = localAudioPaths(agentRoot)
    const h = makeDeps()
    const joined = runLocalAudioJoin({ agentName: "slugger" }, h.deps)
    await vi.waitFor(() => expect(readJoinStatus(paths)?.state).toBe("joined"))
    expect(fs.existsSync(paths.lockFile)).toBe(true)
    h.transport.finish()
    await joined
    expect(fs.existsSync(paths.lockFile)).toBe(false)
    const failing = makeDeps({ transport: fakeTransport({ startError: "no device" }) })
    await expect(runLocalAudioJoin({ agentName: "slugger" }, failing.deps)).rejects.toThrow(/no device/)
    expect(fs.existsSync(paths.lockFile)).toBe(false)
  })

  it("launch refuses over a starting join and leaves its status file alone", async () => {
    const paths = localAudioPaths(agentRoot)
    const lock = acquireJoinLock(paths)
    writeJoinStatus(paths, { state: "starting" })
    const spawned: string[] = []
    const result = await launchLocalAudioJoin(request, {
      agentRoot: () => agentRoot, execPath: "node", cliEntry: "entry.js",
      spawn: (command) => { spawned.push(command); return { pid: 1, unref: () => undefined, on: () => undefined } },
      sleep: async () => undefined, now: () => 0, timeoutMs: 10,
    })
    expect(result.ok).toBe(false)
    expect(result.message).toMatch(/already running/)
    expect(spawned).toEqual([])
    expect(readJoinStatus(paths)?.state).toBe("starting")
    if (lock.ok) lock.release()
  })
})

describe("leaving a join that is still starting", () => {
  it("stops the starting process through its stop signal when the control socket is not up yet", async () => {
    const paths = localAudioPaths(agentRoot)
    fs.mkdirSync(paths.dir, { recursive: true })
    fs.writeFileSync(paths.lockFile, JSON.stringify({ pid: process.ppid, startedAt: "x" }))
    const spy = vi.spyOn(process, "kill").mockImplementation(() => true)
    const reply = await runLocalAudioLeave("slugger", makeDeps().deps)
    expect(spy).toHaveBeenCalledWith(process.ppid, "SIGTERM")
    spy.mockRestore()
    expect(reply).toMatch(/still starting.*stop/)
  })

  it("reports the failure when the starting process cannot be signalled", async () => {
    const paths = localAudioPaths(agentRoot)
    fs.mkdirSync(paths.dir, { recursive: true })
    fs.writeFileSync(paths.lockFile, JSON.stringify({ pid: process.ppid, startedAt: "x" }))
    const spy = vi.spyOn(process, "kill").mockImplementation((_pid, signal) => { if (signal === "SIGTERM") throw new Error("EPERM"); return true })
    const reply = await runLocalAudioLeave("slugger", makeDeps().deps)
    spy.mockRestore()
    expect(reply).toMatch(/Could not leave/)
  })
})

describe("stop signals during startup", () => {
  it("registers the stop handler before the devices start, so a SIGTERM while starting still ends the call and notifies", async () => {
    const h = makeDeps({ transport: fakeTransport({ slowStart: true }) })
    const joined = runLocalAudioJoin(request, h.deps)
    await vi.waitFor(() => expect(h.transport.raw.start).toHaveBeenCalled())
    expect(h.signals).toHaveLength(1)
    h.signals[0]!()
    const summary = await joined
    expect(summary.reason).toBe("left")
    expect(h.transport.raw.leave).toHaveBeenCalledWith("left")
    const paths = localAudioPaths(agentRoot)
    expect(readJoinStatus(paths)).toMatchObject({ state: "ended", reason: "left" })
    // A cancelled start never claims it joined.
    expect(h.out.join("")).not.toMatch(/Joined local audio session/)
    expect(h.notices.map((n) => n.text).join("\n")).not.toMatch(/I joined/)
    expect(h.notices).toHaveLength(1)
    expect(h.notices[0]!.text).toMatch(/ended/i)
    expect(fs.existsSync(paths.lockFile)).toBe(false)
    expect(fs.existsSync(paths.socketPath)).toBe(false)
  })

  it("a stop signal that arrives before the transport exists ends the join without starting devices", async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const h = makeDeps({ resolveRealtime: async () => { await gate; return { apiKey: "k" } as never } })
    const joined = runLocalAudioJoin(request, h.deps)
    await vi.waitFor(() => expect(h.signals).toHaveLength(1))
    h.signals[0]!()
    release()
    const summary = await joined
    expect(summary.reason).toBe("left")
    expect(h.transport.raw.start).not.toHaveBeenCalled()
    expect(readJoinStatus(localAudioPaths(agentRoot))).toMatchObject({ state: "ended", reason: "left" })
    expect(h.notices).toHaveLength(1)
    expect(h.notices[0]!.text).toMatch(/before joining/i)
  })

  it("a stop signal before the transport exists with no owner to notify stays quiet", async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const h = makeDeps({ resolveRealtime: async () => { await gate; return { apiKey: "k" } as never } })
    const joined = runLocalAudioJoin({ agentName: "slugger" }, h.deps)
    await vi.waitFor(() => expect(h.signals).toHaveLength(1))
    h.signals[0]!()
    release()
    await joined
    expect(h.notices).toHaveLength(0)
  })

  it("a stop signal that makes the start throw is a cancelled join, not a failure", async () => {
    const h = makeDeps({ transport: fakeTransport({ startError: "local audio join already ended" }) })
    h.transport.raw.start.mockImplementationOnce(async () => {
      h.signals[0]!()
      throw new Error("local audio join already ended")
    })
    const summary = await runLocalAudioJoin(request, h.deps)
    expect(summary).toMatchObject({ reason: "left", callSid: "not-joined" })
    expect(readJoinStatus(localAudioPaths(agentRoot))).toMatchObject({ state: "ended", reason: "left" })
    expect(h.notices.map((n) => n.text).join("\n")).not.toMatch(/could not join/)
    expect(h.notices.at(-1)!.text).toMatch(/before joining/i)
    expect(fs.existsSync(localAudioPaths(agentRoot).lockFile)).toBe(false)
  })

  it("listens for a stop signal before probing for an older running session", async () => {
    const h = makeDeps()
    const order: string[] = []
    h.deps.onStopSignal = (cb) => { order.push("stop-handler"); h.signals.push(cb); return () => undefined }
    const realResolve = h.deps.resolveRealtime
    h.deps.resolveRealtime = async (name) => { order.push("resolve"); return realResolve(name) }
    const joined = runLocalAudioJoin(request, h.deps)
    await vi.waitFor(() => expect(h.transport.raw.start).toHaveBeenCalled())
    expect(order).toEqual(["stop-handler", "resolve"])
    h.transport.finish()
    await joined
  })

  it("unsubscribes the stop handler when the join fails", async () => {
    const off = vi.fn()
    const h = makeDeps({ transport: fakeTransport({ startError: "nope" }), onStopSignal: () => off })
    await expect(runLocalAudioJoin({ agentName: "slugger" }, h.deps)).rejects.toThrow(/nope/)
    expect(off).toHaveBeenCalledTimes(1)
  })

  it("the launcher says so when a join ended before starting with no recorded reason", async () => {
    const result = await launchLocalAudioJoin(request, {
      agentRoot: () => agentRoot, execPath: "node", cliEntry: "entry.js",
      spawn: () => { writeJoinStatus(localAudioPaths(agentRoot), { state: "ended" }); return { pid: 1, unref: () => undefined, on: () => undefined } },
      sleep: async () => undefined, now: () => 0, timeoutMs: 10,
    })
    expect(result.message).toContain("no reason recorded")
  })

  it("the launcher reports a join that ended before it finished starting", async () => {
    const result = await launchLocalAudioJoin(request, {
      agentRoot: () => agentRoot, execPath: "node", cliEntry: "entry.js",
      spawn: () => { writeJoinStatus(localAudioPaths(agentRoot), { state: "ended", reason: "left" }); return { pid: 1, unref: () => undefined, on: () => undefined } },
      sleep: async () => undefined, now: () => 0, timeoutMs: 10,
    })
    expect(result).toEqual({ ok: false, message: "The local audio join ended before it finished starting (left)." })
  })
})

describe("owner notices", () => {
  it("do not claim the owner heard an announcement the join cannot vouch for, and explain a failed disclosure", async () => {
    const h = makeDeps()
    const joined = runLocalAudioJoin(request, h.deps)
    await vi.waitFor(() => expect(h.notices).toHaveLength(1))
    expect(h.notices[0]!.text).not.toMatch(/I announced myself/)
    expect(h.notices[0]!.text).toMatch(/announc/i)
    h.transport.finish("disclosure_failed")
    await joined
    expect(h.notices[1]!.text).toMatch(/could not confirm/i)
    expect(h.notices[1]!.text).not.toContain("disclosure_failed")
  })
})

describe("runLocalAudioLeave and runLocalAudioStatus", () => {
  it("tells the running join to leave, or says nothing is running", async () => {
    const h = makeDeps()
    expect(await runLocalAudioLeave("slugger", h.deps)).toBe("No local audio session is running.")
    expect(await runLocalAudioStatus("slugger", h.deps)).toBe("No local audio session is running.")
    const joined = runLocalAudioJoin({ agentName: "slugger" }, h.deps)
    await vi.waitFor(() => expect(readJoinStatus(localAudioPaths(agentRoot))?.state).toBe("joined"))
    expect(await runLocalAudioStatus("slugger", h.deps)).toContain("local-audio-abc")
    expect(await runLocalAudioLeave("slugger", h.deps)).toContain("Left local audio session local-audio-abc")
    await joined
  })
})

describe("launchLocalAudioJoin (the tool's launcher)", () => {
  function launchDeps(behavior: (paths: ReturnType<typeof localAudioPaths>) => void | Promise<void>, exitCode?: number) {
    const spawned: Array<{ command: string; args: string[] }> = []
    const paths = localAudioPaths(agentRoot)
    let clock = 0
    return {
      spawned,
      deps: {
        agentRoot: () => agentRoot,
        execPath: "/usr/bin/node",
        cliEntry: "/pkg/dist/heart/daemon/ouro-entry.js",
        spawn: (command: string, args: string[]) => {
          spawned.push({ command, args })
          const handlers: Record<string, (code: number) => void> = {}
          void Promise.resolve(behavior(paths)).then(() => { if (exitCode !== undefined) handlers.exit?.(exitCode) })
          return { pid: 4321, unref: () => undefined, on: (event: string, cb: (code: number) => void) => { handlers[event] = cb } }
        },
        sleep: async (ms: number) => { clock += ms },
        now: () => clock,
        timeoutMs: 5_000,
        kill: vi.fn(),
      },
    }
  }

  it("launches the CLI detached with the stated facts and returns once the join reports joined", async () => {
    const l = launchDeps((paths) => writeJoinStatus(paths, { state: "joined", callSid: "local-audio-xyz" }))
    const result = await launchLocalAudioJoin(request, l.deps)
    expect(result).toEqual({ ok: true, callSid: "local-audio-xyz", message: expect.stringContaining("local-audio-xyz") })
    expect(l.spawned[0]!.command).toBe("/usr/bin/node")
    expect(l.spawned[0]!.args[0]).toBe("/pkg/dist/heart/daemon/ouro-entry.js")
    expect(l.spawned[0]!.args.slice(1)).toEqual(localAudioJoinArgs(request))
  })

  it("returns the failure reason (with the exact fix steps) when the join reports failed", async () => {
    const l = launchDeps((paths) => writeJoinStatus(paths, { state: "failed", reason: "BlackHole 2ch is muted (input and output). Unmute it..." }))
    const result = await launchLocalAudioJoin(request, l.deps)
    expect(result.ok).toBe(false)
    expect(result.message).toContain("BlackHole 2ch is muted")
  })

  it("does not trust a status file left by an earlier run", async () => {
    writeJoinStatus(localAudioPaths(agentRoot), { state: "joined", callSid: "local-audio-old" })
    const l = launchDeps(async (paths) => { writeJoinStatus(paths, { state: "failed", reason: "new failure" }) })
    const result = await launchLocalAudioJoin(request, l.deps)
    expect(result).toMatchObject({ ok: false })
    expect(result.message).toContain("new failure")
  })

  it("on timeout, stops the join's whole process group and says so", async () => {
    const l = launchDeps(() => undefined)
    const result = await launchLocalAudioJoin(request, l.deps)
    expect(result.ok).toBe(false)
    expect(result.message).toMatch(/did not report/i)
    expect(result.message).toMatch(/stopped it/i)
    expect(l.deps.kill).toHaveBeenCalledWith(-4321, "SIGTERM")
  })

  it("on timeout, asks a join that already opened its socket to leave instead of killing it", async () => {
    const paths = localAudioPaths(agentRoot)
    const calls: string[] = []
    const server = new LocalAudioControlServer(paths, { status: () => ({ state: "starting", callSid: "local-audio-slow" }) as never, leave: async () => { calls.push("leave") } })
    const l = launchDeps(async () => { await server.start() })
    // The launcher's own pre-check must not see the server yet, so start it from the spawn.
    const result = await launchLocalAudioJoin(request, l.deps)
    await server.close()
    expect(calls).toEqual(["leave"])
    expect(l.deps.kill).not.toHaveBeenCalled()
    expect(result.message).toMatch(/asked it to leave/i)
  })

  it("on timeout, reports honestly when the join could not be stopped", async () => {
    const l = launchDeps(() => undefined)
    l.deps.kill.mockImplementation(() => { throw new Error("ESRCH") })
    const result = await launchLocalAudioJoin(request, l.deps)
    expect(result.message).toMatch(/could not stop it/i)
    const noPid = launchDeps(() => undefined)
    noPid.deps.spawn = () => ({ pid: undefined, unref: () => undefined, on: () => undefined }) as never
    const second = await launchLocalAudioJoin(request, noPid.deps)
    expect(second.message).toMatch(/could not stop it/i)
    expect(noPid.deps.kill).not.toHaveBeenCalled()
  })

  it("uses the real process.kill when none is injected", async () => {
    const spy = vi.spyOn(process, "kill").mockImplementation(() => true)
    const { kill: _unused, ...rest } = launchDeps(() => undefined).deps
    await launchLocalAudioJoin(request, rest)
    expect(spy).toHaveBeenCalledWith(-4321, "SIGTERM")
    spy.mockRestore()
  })

  it("reports an early crash with the log location", async () => {
    const l = launchDeps(() => undefined, 1)
    const result = await launchLocalAudioJoin(request, l.deps)
    expect(result.ok).toBe(false)
    expect(result.message).toMatch(/exited/i)
    expect(result.message).toContain("join.log")
  })

  it("refuses to launch over a running join", async () => {
    const paths = localAudioPaths(agentRoot)
    const server = new LocalAudioControlServer(paths, { status: () => ({ state: "joined", callSid: "local-audio-live" }) as never, leave: async () => undefined })
    await server.start()
    const l = launchDeps(() => undefined)
    const result = await launchLocalAudioJoin(request, l.deps)
    await server.close()
    expect(result.ok).toBe(false)
    expect(result.message).toContain("local-audio-live")
    expect(l.spawned).toHaveLength(0)
  })

  it("uses a real detached spawn with a log file by default", () => {
    const paths = localAudioPaths(agentRoot)
    const child = defaultLaunchSpawn(paths)(process.execPath, ["-e", "process.exit(0)"])
    expect(typeof child.pid).toBe("number")
    child.unref()
    expect(fs.existsSync(paths.logFile)).toBe(true)
  })
})

describe("defaultLocalAudioJoinDeps", () => {
  it("resolves the realtime options through the runtime", async () => {
    expect(await defaultLocalAudioJoinDeps().resolveRealtime("slugger")).toEqual({ apiKey: "mocked-key" })
  })

  it("builds a real transport rooted in the agent's private audio directory", () => {
    const deps = defaultLocalAudioJoinDeps({ agentRoot: () => agentRoot })
    const transport = deps.createTransport({ agentName: "slugger" }, { agentName: "slugger", agentRoot } as never)
    expect(transport.status().state).toBe("idle")
    const fromEnvRoot = defaultLocalAudioJoinDeps({ agentRoot: () => agentRoot }).createTransport({ agentName: "slugger" }, { agentName: "slugger" } as never)
    expect(fromEnvRoot.status().state).toBe("idle")
  })

  it("spawns sox children through node with piped stdio", async () => {
    const deps = defaultLocalAudioJoinDeps({ agentRoot: () => agentRoot })
    const transport = deps.createTransport({ agentName: "slugger" }, { agentName: "slugger", agentRoot } as never) as unknown as { deps: { spawner: { spawn: (c: string, a: string[], o: { detached: boolean }) => { stdin: unknown; kill: (s: string) => boolean; pid?: number } } } }
    const child = transport.deps.spawner.spawn(process.execPath, ["-e", "setTimeout(()=>{}, 5000)"], { detached: false })
    expect(child.stdin).toBeTruthy()
    child.kill("SIGKILL")
  })

  it("delivers owner notices live through the cross-chat path, with the agent's root as the queue fallback", async () => {
    const deps = defaultLocalAudioJoinDeps({ agentRoot: () => agentRoot })
    await deps.notifyOwner("slugger", { friendId: "ari", channel: "cli", key: "session" }, "hello")
    expect(notifyLive).toHaveBeenCalledWith("slugger", { friendId: "ari", channel: "cli", key: "session" }, "hello", { agentRoot })
  })

  it("passes a configured output latency estimate to the transport and ignores junk values", () => {
    const original = process.env.OURO_LOCAL_AUDIO_OUTPUT_LATENCY_MS
    try {
      const latencyOf = () => (defaultLocalAudioJoinDeps({ agentRoot: () => agentRoot }).createTransport({ agentName: "slugger" }, { agentName: "slugger", agentRoot } as never) as unknown as { deps: { outputLatencyMs?: number } }).deps.outputLatencyMs
      process.env.OURO_LOCAL_AUDIO_OUTPUT_LATENCY_MS = "85"
      expect(latencyOf()).toBe(85)
      process.env.OURO_LOCAL_AUDIO_OUTPUT_LATENCY_MS = "fast"
      expect(latencyOf()).toBeUndefined()
      process.env.OURO_LOCAL_AUDIO_OUTPUT_LATENCY_MS = "-5"
      expect(latencyOf()).toBeUndefined()
      delete process.env.OURO_LOCAL_AUDIO_OUTPUT_LATENCY_MS
      expect(latencyOf()).toBeUndefined()
    } finally {
      if (original === undefined) delete process.env.OURO_LOCAL_AUDIO_OUTPUT_LATENCY_MS
      else process.env.OURO_LOCAL_AUDIO_OUTPUT_LATENCY_MS = original
    }
  })

  it("writes to stdout and listens for stop signals until unsubscribed", () => {
    const deps = defaultLocalAudioJoinDeps()
    const spy = vi.spyOn(process.stdout, "write").mockReturnValue(true)
    deps.write("hi")
    expect(spy).toHaveBeenCalledWith("hi")
    spy.mockRestore()
    const before = process.listenerCount("SIGTERM")
    const cb = vi.fn()
    const off = deps.onStopSignal(cb)
    expect(process.listenerCount("SIGTERM")).toBe(before + 1)
    process.listeners("SIGINT").at(-1)!("SIGINT")
    expect(cb).toHaveBeenCalledTimes(1)
    off()
    expect(process.listenerCount("SIGTERM")).toBe(before)
  })

  it("lets callers override any piece", () => {
    const write = vi.fn()
    expect(defaultLocalAudioJoinDeps({ write }).write).toBe(write)
  })
})

describe("remaining branches", () => {
  it("covers notices without participants or occasion, unknown end reasons, and non-Error failures", async () => {
    const h = makeDeps()
    const joined = runLocalAudioJoin({ agentName: "slugger", notify: request.notify }, h.deps)
    await vi.waitFor(() => expect(h.notices).toHaveLength(1))
    expect(h.notices[0]!.text).not.toContain("Participants")
    expect(h.notices[0]!.text).not.toContain("Occasion")
    h.transport.finish("something_new")
    await joined
    expect(h.notices[1]!.text).toContain("something_new")

    const failing = makeDeps({ resolveRealtime: async () => { throw "plain string failure" } })
    await expect(runLocalAudioJoin({ agentName: "slugger" }, failing.deps)).rejects.toBe("plain string failure")
    expect(readJoinStatus(localAudioPaths(agentRoot))).toMatchObject({ state: "failed", reason: "plain string failure" })
    expect(failing.notices).toHaveLength(0)
  })

  it("reports a leave the session refused, and a status with a start time", async () => {
    const paths = localAudioPaths(agentRoot)
    const server = new LocalAudioControlServer(paths, {
      status: () => ({ state: "joined", callSid: "local-audio-s", startedAt: "2026-10-09T10:00:00.000Z" }) as never,
      leave: async () => { throw new Error("device busy") },
    })
    await server.start()
    const h = makeDeps()
    expect(await runLocalAudioStatus("slugger", h.deps)).toContain("since 2026-10-09T10:00:00.000Z")
    expect(await runLocalAudioLeave("slugger", h.deps)).toBe("Could not leave the local audio session: device busy")
    await server.close()
  })

  it("explains a failed launch that gave no reason", async () => {
    const spawned = { pid: 1, unref: () => undefined, on: () => undefined }
    const result = await launchLocalAudioJoin(request, {
      agentRoot: () => agentRoot, execPath: "node", cliEntry: "entry.js",
      spawn: () => { writeJoinStatus(localAudioPaths(agentRoot), { state: "failed" }); return spawned },
      sleep: async () => undefined, now: () => 0, timeoutMs: 10, kill: vi.fn(),
    })
    expect(result).toEqual({ ok: false, message: "The local audio join failed." })
  })

  it("gives the unused speech services a clear refusal and defaults to the real agent root", async () => {
    const h = makeDeps()
    const joined = runLocalAudioJoin(request, h.deps)
    await vi.waitFor(() => expect(h.bridge()).toBeDefined())
    const bridge = h.bridge() as { transcriber: { transcribe: () => Promise<never> }; tts: { synthesize: () => Promise<never> } }
    await expect(bridge.transcriber.transcribe()).rejects.toThrow(/not used by local audio/)
    await expect(bridge.tts.synthesize()).rejects.toThrow(/not used by local audio/)
    expect(typeof defaultLocalAudioJoinDeps().agentRoot("slugger")).toBe("string")
    h.transport.finish()
    await joined
  })
})
