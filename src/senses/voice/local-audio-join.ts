import * as fs from "fs"
import * as path from "path"
import { spawn as nodeSpawn } from "child_process"
import { getAgentRoot } from "../../heart/identity"
import { emitNervesEvent } from "../../nerves/runtime"
import { inspectVoiceAudioRouting } from "./audio-routing"
import {
  LocalAudioControlServer,
  acquireJoinLock,
  inspectActiveJoin,
  localAudioPaths,
  parseNotifySession,
  readJoinStatus,
  sendLocalAudioControl,
  stopLockHolder,
  writeJoinStatus,
  type LocalAudioPaths,
} from "./local-audio-control"
import { createSwiftMuteQuery } from "./local-audio-mute"
import { notifyOwnerLive } from "./local-audio-notify"
import {
  LocalAudioDeviceTransport,
  type LocalAudioEndSummary,
  type LocalAudioJoinRequest,
} from "./local-audio-transport"
import { resolveLocalAudioRealtimeOptions } from "./twilio-phone-runtime"
import type { OpenAIRealtimeTwilioOptions, TwilioPhoneBridgeOptions } from "./twilio-phone"

export { parseNotifySession }
type NotifyTarget = NonNullable<LocalAudioJoinRequest["notify"]>

export interface LocalAudioJoinDeps {
  agentRoot: (agentName: string) => string
  resolveRealtime: (agentName: string) => Promise<OpenAIRealtimeTwilioOptions>
  createTransport: (request: LocalAudioJoinRequest, bridge: TwilioPhoneBridgeOptions) => LocalAudioDeviceTransport
  notifyOwner: (agentName: string, target: NotifyTarget, text: string) => Promise<void>
  write: (text: string) => void
  /** Calls back when the process is told to stop (SIGINT/SIGTERM). Returns an unsubscribe. */
  onStopSignal: (callback: () => void) => () => void
}

const NO_SESSION = "No local audio session is running."
/** The CLI arguments that make `ouro voice join` reproduce this request. */
export function localAudioJoinArgs(request: LocalAudioJoinRequest): string[] {
  const args = ["voice", "join", "--agent", request.agentName]
  const flag = (name: string, value: string | number | undefined): void => {
    if (value !== undefined) args.push(name, String(value))
  }
  flag("--friend", request.friendId)
  flag("--participants", request.participants)
  flag("--occasion", request.occasion)
  flag("--mode", request.mode)
  if (request.ownerAlone) args.push("--owner-alone")
  flag("--owner-name", request.ownerName)
  flag("--silent-consent", request.silentConsent)
  if (request.notify) flag("--notify-session", `${request.notify.friendId}:${request.notify.channel}:${request.notify.key}`)
  flag("--input-file", request.files?.inputPath)
  flag("--output-file", request.files?.outputPath)
  flag("--idle-silence-ms", request.idleSilenceMs)
  flag("--max-duration-ms", request.maxDurationMs)
  return args
}

const END_PHRASES: Record<string, string> = {
  left: "I left the call on request",
  session_ended: "the audio session ended",
  capture_ended: "the capture device stopped",
  playback_failed: "the playback device failed",
  disclosure_failed: "I could not confirm I announced myself aloud within 20 seconds, so I left",
  idle_silence: "the room went idle (long silence), so I left",
  max_duration: "it reached the maximum call length, so I left",
}

function joinedNotice(request: LocalAudioJoinRequest, callSid: string): string {
  const parts = [`I joined a local audio session (${callSid}) as ${request.agentName}.`]
  if (request.participants) parts.push(`Participants: ${request.participants}.`)
  if (request.occasion) parts.push(`Occasion: ${request.occasion}.`)
  const consent = request.silentConsent?.trim()
  parts.push(
    consent
      ? `This is a silent join on your recorded consent: "${consent}".`
      : "I am announcing myself aloud as an AI assistant that is transcribing; if I cannot confirm that announcement was spoken, I will leave and tell you.",
  )
  parts.push("Say leave, or run `ouro voice leave`, to end it.")
  return parts.join(" ")
}

function endedNotice(summary: LocalAudioEndSummary): string {
  const seconds = Math.round(summary.durationMs / 1000)
  return `Local audio session ${summary.callSid} ended after ${seconds}s: ${END_PHRASES[summary.reason] ?? summary.reason}.`
}

export async function runLocalAudioJoin(request: LocalAudioJoinRequest, deps: LocalAudioJoinDeps): Promise<LocalAudioEndSummary> {
  const agentRoot = deps.agentRoot(request.agentName)
  const paths = localAudioPaths(agentRoot)
  const refuse = (what: string): never => {
    throw new Error(`A local audio session is already running (${what}). Run \`ouro voice leave\` first.`)
  }
  // Only one join may run per agent. A refused join touches nothing of the running one.
  const lock = acquireJoinLock(paths)
  if (!lock.ok) {
    const running = await sendLocalAudioControl(paths, "status", 2_000)
    return refuse(running.ok ? (running.status as { callSid: string }).callSid : `starting, process ${lock.holderPid ?? "unknown"}`)
  }
  let server: LocalAudioControlServer | undefined
  let transport: LocalAudioDeviceTransport | undefined
  // Registered as soon as we hold the lock, so a stop signal at any point ends the call and releases the lock.
  let stopRequested = false
  const stopListening = deps.onStopSignal(() => {
    stopRequested = true
    if (transport) void transport.leave("left")
  })
  try {
    // A server from before the lock existed, or one that answers without owning the lock.
    const legacy = await sendLocalAudioControl(paths, "status", 2_000)
    if (legacy.ok) refuse((legacy.status as { callSid: string }).callSid)
    writeJoinStatus(paths, { state: "starting" })
    try {
      const openaiRealtime = await deps.resolveRealtime(request.agentName)
      if (stopRequested) return await endBeforeJoining(request, deps, paths)
      const bridge = localBridgeOptions(request.agentName, agentRoot, paths, openaiRealtime)
      transport = deps.createTransport(request, bridge)
      const live = transport
      server = new LocalAudioControlServer(paths, { status: () => live.status(), leave: () => live.leave("left") })
      await server.start()
      await live.start()
    } catch (error) {
      await server?.close()
      // A stop signal during startup makes the start fail; that is a cancelled join, not a failure.
      if (stopRequested) return await endBeforeJoining(request, deps, paths)
      const reason = error instanceof Error ? error.message : String(error)
      writeJoinStatus(paths, { state: "failed", reason })
      if (request.notify) await deps.notifyOwner(request.agentName, request.notify, `I could not join the local audio session: ${reason}`)
      throw error
    }
    const { callSid, state } = transport.status()
    // A leave or stop signal during startup cancels the start: it ended without ever joining.
    const joined = state !== "ended"
    if (joined) {
      writeJoinStatus(paths, { state: "joined", callSid })
      deps.write(`Joined local audio session ${callSid} as ${request.agentName}. Run \`ouro voice leave\` to end it.\n`)
      if (request.notify) await deps.notifyOwner(request.agentName, request.notify, joinedNotice(request, callSid))
    }
    const summary = await transport.ended
    writeJoinStatus(paths, { state: "ended", callSid, reason: summary.reason })
    await server!.close()
    if (request.notify) await deps.notifyOwner(request.agentName, request.notify, endedNotice(summary))
    return summary
  } finally {
    stopListening()
    lock.release()
  }
}

async function endBeforeJoining(request: LocalAudioJoinRequest, deps: LocalAudioJoinDeps, paths: LocalAudioPaths): Promise<LocalAudioEndSummary> {
  writeJoinStatus(paths, { state: "ended", reason: "left" })
  if (request.notify) await deps.notifyOwner(request.agentName, request.notify, "I was told to stop before joining the local audio session, so I did not join.")
  return { reason: "left", callSid: "not-joined", durationMs: 0 }
}

function localBridgeOptions(
  agentName: string,
  agentRoot: string,
  paths: LocalAudioPaths,
  openaiRealtime: OpenAIRealtimeTwilioOptions,
): TwilioPhoneBridgeOptions {
  const unused = (what: string) => async (): Promise<never> => { throw new Error(`${what} is not used by local audio`) }
  return {
    agentName,
    agentRoot,
    publicBaseUrl: "https://local-audio.invalid",
    outputDir: paths.dir,
    transcriber: { transcribe: unused("the transcriber") },
    tts: { synthesize: unused("text to speech") },
    transportMode: "media-stream",
    conversationEngine: "openai-realtime",
    outboundConversationEngine: "openai-realtime",
    openaiRealtime,
  }
}

export async function runLocalAudioLeave(agentName: string, deps: Pick<LocalAudioJoinDeps, "agentRoot">): Promise<string> {
  const paths = localAudioPaths(deps.agentRoot(agentName))
  const active = await inspectActiveJoin(paths)
  if (!active) return NO_SESSION
  const reply = await sendLocalAudioControl(paths, "leave")
  if (!reply.ok && active.state === "starting") {
    // The join has not opened its control socket yet; its stop-signal handler is already registered.
    const pid = stopLockHolder(paths)
    if (pid !== null) return `Told the local audio session that is still starting (process ${pid}) to stop.`
  }
  if (!reply.ok) return `Could not leave the local audio session: ${reply.error}`
  return `Left local audio session ${active.callSid}.`
}

export async function runLocalAudioStatus(agentName: string, deps: Pick<LocalAudioJoinDeps, "agentRoot">): Promise<string> {
  const active = await inspectActiveJoin(localAudioPaths(deps.agentRoot(agentName)))
  if (!active) return NO_SESSION
  return `Local audio session ${active.callSid} is ${active.state}${active.startedAt ? ` (since ${active.startedAt})` : ""}.`
}

export interface LaunchChild {
  pid?: number
  unref(): void
  on(event: "exit", listener: (code: number | null) => void): unknown
}

export interface LocalAudioLaunchDeps {
  agentRoot: (agentName: string) => string
  execPath: string
  cliEntry: string
  spawn: (command: string, args: string[]) => LaunchChild
  sleep: (ms: number) => Promise<void>
  now: () => number
  timeoutMs: number
  /** Signals a process or, with a negative pid, its whole process group. Defaults to process.kill. */
  kill?: (pid: number, signal: NodeJS.Signals) => void
}

export interface LocalAudioLaunchResult {
  ok: boolean
  callSid?: string
  message: string
}

/** A detached child with stdout and stderr appended to the join log. */
export function defaultLaunchSpawn(paths: LocalAudioPaths): LocalAudioLaunchDeps["spawn"] {
  return (command, args) => {
    fs.mkdirSync(paths.dir, { recursive: true, mode: 0o700 })
    const log = fs.openSync(paths.logFile, "a", 0o600)
    try {
      return nodeSpawn(command, args, { detached: true, stdio: ["ignore", log, log] })
    } finally {
      fs.closeSync(log)
    }
  }
}

const POLL_MS = 250

/**
 * The launcher gave up waiting, so the detached join must not be left running unsupervised. If it
 * already opened its control socket it is asked to leave (a clean stop); otherwise its process group
 * gets SIGTERM, which its stop handler turns into a clean end.
 */
async function stopTimedOutJoin(paths: LocalAudioPaths, pid: number | undefined, kill: NonNullable<LocalAudioLaunchDeps["kill"]>): Promise<string> {
  const reply = await sendLocalAudioControl(paths, "leave", 10_000)
  if (reply.ok) return "I asked it to leave."
  if (pid === undefined) return "I could not stop it (no process id), so check for a stray join."
  try {
    kill(-pid, "SIGTERM")
    return "I stopped it."
  } catch {
    return "I could not stop it, so check for a stray join."
  }
}

/** Starts `ouro voice join` as a detached process and waits for it to report joined or failed. */
export async function launchLocalAudioJoin(request: LocalAudioJoinRequest, deps: LocalAudioLaunchDeps): Promise<LocalAudioLaunchResult> {
  const paths = localAudioPaths(deps.agentRoot(request.agentName))
  const active = await inspectActiveJoin(paths)
  if (active) return { ok: false, message: `A local audio session is already running (${active.callSid}). Run \`ouro voice leave\` first.` }
  fs.rmSync(paths.statusFile, { force: true })
  const child = deps.spawn(deps.execPath, [deps.cliEntry, ...localAudioJoinArgs(request)])
  let exitCode: number | null | undefined
  child.on("exit", (code) => { exitCode = code })
  child.unref()
  emitNervesEvent({
    component: "senses",
    event: "senses.voice_local_launch",
    message: "launched a detached local audio join",
    meta: { agentName: request.agentName, pid: child.pid },
  })
  const deadline = deps.now() + deps.timeoutMs
  for (;;) {
    const status = readJoinStatus(paths)
    if (status?.state === "joined") {
      return { ok: true, callSid: status.callSid, message: `Joined local audio session ${status.callSid}.` }
    }
    if (status?.state === "failed") return { ok: false, message: status.reason ?? "The local audio join failed." }
    if (status?.state === "ended") return { ok: false, message: `The local audio join ended before it finished starting (${status.reason ?? "no reason recorded"}).` }
    if (exitCode !== undefined) {
      return { ok: false, message: `The local audio join process exited (code ${exitCode}) before joining. See ${paths.logFile}.` }
    }
    if (deps.now() >= deadline) {
      const outcome = await stopTimedOutJoin(paths, child.pid, deps.kill ?? process.kill.bind(process))
      return { ok: false, message: `The local audio join did not report within ${Math.round(deps.timeoutMs / 1000)}s, so ${outcome} See ${paths.logFile}.` }
    }
    await deps.sleep(POLL_MS)
  }
}

/** `OURO_LOCAL_AUDIO_OUTPUT_LATENCY_MS`: the owner's own estimate of speaker latency, in milliseconds. */
function configuredOutputLatencyMs(): number | undefined {
  const value = Number(process.env.OURO_LOCAL_AUDIO_OUTPUT_LATENCY_MS)
  return process.env.OURO_LOCAL_AUDIO_OUTPUT_LATENCY_MS !== undefined && Number.isFinite(value) && value >= 0 ? value : undefined
}

export function defaultLocalAudioJoinDeps(overrides: Partial<LocalAudioJoinDeps> = {}): LocalAudioJoinDeps {
  const agentRoot = overrides.agentRoot ?? ((agentName: string) => getAgentRoot(agentName))
  return {
    agentRoot,
    resolveRealtime: (agentName) => resolveLocalAudioRealtimeOptions(agentName),
    createTransport: (request, bridge) => {
      const paths = localAudioPaths(bridge.agentRoot ?? agentRoot(request.agentName))
      return new LocalAudioDeviceTransport(request, {
        spawner: { spawn: (command, args, options) => nodeSpawn(command, args, { detached: options.detached, stdio: ["pipe", "pipe", "ignore"] }) },
        bridgeOptions: bridge,
        pidFile: paths.soxPidFile,
        metadataDir: paths.callsDir,
        inspectRouting: inspectVoiceAudioRouting,
        queryMute: createSwiftMuteQuery({ dir: path.join(paths.dir, "tools") }),
        outputLatencyMs: configuredOutputLatencyMs(),
      })
    },
    notifyOwner: async (agentName, target, text) => {
      await notifyOwnerLive(agentName, target, text, { agentRoot: agentRoot(agentName) })
    },
    write: (text) => { process.stdout.write(text) },
    onStopSignal: (callback) => {
      process.on("SIGINT", callback)
      process.on("SIGTERM", callback)
      return () => {
        process.off("SIGINT", callback)
        process.off("SIGTERM", callback)
      }
    },
    ...overrides,
  }
}
