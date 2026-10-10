import * as crypto from "node:crypto"
import * as fs from "fs"
import * as net from "net"
import * as os from "os"
import * as path from "path"
import { emitNervesEvent } from "../../nerves/runtime"
import { defaultInspectProcess } from "./local-audio-devices"
import type { LocalAudioStatus } from "./local-audio-transport"

/**
 * `ouro voice leave` reaches a running join over a unix socket inside the agent's private state
 * directory (0700, socket 0600), and nothing else: there is no TCP listener and no HTTP route.
 */
export interface LocalAudioPaths {
  dir: string
  socketPath: string
  pidFile: string
  statusFile: string
  soxPidFile: string
  callsDir: string
  logFile: string
  lockFile: string
}

/** macOS unix socket paths are limited to about 104 bytes. */
const MAX_SOCKET_PATH = 100
const MAX_REQUEST_BYTES = 1024
const DEFAULT_CLIENT_TIMEOUT_MS = 10_000

export function localAudioPaths(agentRoot: string): LocalAudioPaths {
  const dir = path.join(agentRoot, "state", "voice", "local-audio")
  let socketPath = path.join(dir, "control.sock")
  if (socketPath.length > MAX_SOCKET_PATH) {
    const digest = crypto.createHash("sha256").update(dir).digest("hex").slice(0, 12)
    socketPath = path.join(os.tmpdir(), `ouro-la-${digest}.sock`)
  }
  return {
    dir,
    socketPath,
    pidFile: path.join(dir, "join.pid"),
    statusFile: path.join(dir, "status.json"),
    soxPidFile: path.join(dir, "sox.pids"),
    callsDir: path.join(dir, "calls"),
    logFile: path.join(dir, "join.log"),
    lockFile: path.join(dir, "join.lock"),
  }
}

export interface LocalAudioControlHandler {
  status(): LocalAudioStatus
  leave(): Promise<void>
}

export interface LocalAudioControlReply {
  ok: boolean
  status?: unknown
  error?: string
  /** Why a client call failed: nothing is listening, no answer in time, or an unreadable reply. */
  code?: "unreachable" | "timeout" | "protocol"
}

export class LocalAudioControlServer {
  private server: net.Server | undefined

  constructor(
    private readonly paths: LocalAudioPaths,
    private readonly handler: LocalAudioControlHandler,
  ) {}

  async start(): Promise<void> {
    fs.mkdirSync(this.paths.dir, { recursive: true, mode: 0o700 })
    fs.chmodSync(this.paths.dir, 0o700)
    fs.rmSync(this.paths.socketPath, { force: true })
    this.server = net.createServer((socket) => this.serve(socket))
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject)
      this.server!.listen(this.paths.socketPath, resolve)
    })
    fs.chmodSync(this.paths.socketPath, 0o600)
    fs.writeFileSync(this.paths.pidFile, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }), { mode: 0o600 })
    emitNervesEvent({
      component: "senses",
      event: "senses.voice_local_control_started",
      message: "local audio control socket listening",
      meta: { socketPath: this.paths.socketPath },
    })
  }

  async close(): Promise<void> {
    const server = this.server
    this.server = undefined
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()))
    fs.rmSync(this.paths.socketPath, { force: true })
    fs.rmSync(this.paths.pidFile, { force: true })
  }

  private serve(socket: net.Socket): void {
    let buffer = ""
    let answered = false
    const reply = (body: LocalAudioControlReply): void => {
      socket.end(`${JSON.stringify(body)}\n`)
    }
    socket.on("error", () => undefined)
    socket.on("data", (chunk) => {
      // One request per connection: later bytes can never trigger a second leave or reply.
      if (answered) return
      buffer += chunk.toString()
      if (buffer.length > MAX_REQUEST_BYTES) {
        answered = true
        reply({ ok: false, error: "request too large" })
        return
      }
      const newline = buffer.indexOf("\n")
      if (newline === -1) return
      answered = true
      void this.handle(buffer.slice(0, newline), reply)
    })
  }

  private async handle(line: string, reply: (body: LocalAudioControlReply) => void): Promise<void> {
    let command: unknown
    try {
      command = (JSON.parse(line) as { cmd?: unknown }).cmd
    } catch {
      reply({ ok: false, error: "invalid request" })
      return
    }
    try {
      if (command === "status") {
        reply({ ok: true, status: this.handler.status() })
      } else if (command === "leave") {
        await this.handler.leave()
        reply({ ok: true, status: this.handler.status() })
      } else {
        reply({ ok: false, error: "unknown command" })
      }
    } catch (error) {
      reply({ ok: false, error: error instanceof Error ? error.message : String(error) })
    }
  }
}

export function sendLocalAudioControl(
  paths: LocalAudioPaths,
  cmd: "status" | "leave",
  timeoutMs = DEFAULT_CLIENT_TIMEOUT_MS,
): Promise<LocalAudioControlReply> {
  return new Promise((resolve) => {
    let buffer = ""
    // A promise settles once, so a late second `done` (end after error) only repeats harmless cleanup.
    const done = (reply: LocalAudioControlReply): void => {
      clearTimeout(timer)
      socket.destroy()
      resolve(reply)
    }
    const socket = net.createConnection(paths.socketPath)
    const timer = setTimeout(() => done({ ok: false, code: "timeout", error: "local audio session did not answer in time" }), timeoutMs)
    socket.on("connect", () => socket.write(`${JSON.stringify({ cmd })}\n`))
    socket.on("data", (chunk) => { buffer += chunk.toString() })
    socket.on("end", () => {
      try {
        done(JSON.parse(buffer.trim()) as LocalAudioControlReply)
      } catch {
        done({ ok: false, code: "protocol", error: "local audio session sent an unreadable reply" })
      }
    })
    socket.on("error", (error: NodeJS.ErrnoException) => {
      // Only a refused or missing socket proves nobody is listening; anything else may be a live, busy session.
      const unreachable = error.code === "ECONNREFUSED" || error.code === "ENOENT" || error.code === "ENOTSOCK"
      done(unreachable
        ? { ok: false, code: "unreachable", error: "no local audio session is running" }
        : { ok: false, code: "protocol", error: `could not reach the local audio session (${error.code})` })
    })
  })
}

/**
 * The live status when a join is running; otherwise null. A join that holds the lock but has not
 * opened its socket yet reports "starting". Leftover socket and pid files are deleted only when the
 * socket is provably dead (connection refused, missing, or not a socket) and no live process holds the lock; a
 * timeout never deletes anything, because a slow session is still a session.
 */
export async function inspectActiveJoin(paths: LocalAudioPaths, timeoutMs = 2_000): Promise<LocalAudioStatus | null> {
  const reply = await sendLocalAudioControl(paths, "status", timeoutMs)
  if (reply.ok) return reply.status as LocalAudioStatus
  const holder = readJoinLock(paths)
  if (holder.live) return { state: "starting", callSid: "starting" } as LocalAudioStatus
  if (reply.code === "unreachable") {
    fs.rmSync(paths.socketPath, { force: true })
    fs.rmSync(paths.pidFile, { force: true })
  }
  return null
}

/**
 * True when `pid` is a live process of ours that is still the one that wrote the lock. A process we
 * may not signal (EPERM) belongs to someone else, so it is never ours; a recorded start time must
 * match, so a pid reused after a crash or reboot does not count.
 */
export function lockOwnerAlive(
  pid: number,
  startTime?: string,
  inspect: (pid: number) => { startTime: string } | null = defaultInspectProcess,
): boolean {
  try {
    process.kill(pid, 0)
  } catch {
    return false
  }
  return startTime === undefined || inspect(pid)?.startTime === startTime
}

/** A lock file with no readable owner is treated as held for this long (its owner may be mid-write). */
const UNREADABLE_LOCK_GRACE_MS = 5_000

interface LockRecord {
  text: string
  pid: number | undefined
  startTime?: string
  mtimeMs: number
}

type LockOwnerCheck = (pid: number, startTime?: string) => boolean

/** A missing or unreadable lock reads as an old, ownerless record: stale, never held. */
function readLockFile(file: string): LockRecord {
  let text = ""
  let mtimeMs = 0
  try {
    text = fs.readFileSync(file, "utf8")
    mtimeMs = fs.statSync(file).mtimeMs
  } catch { /* leave the record empty and old */ }
  try {
    const { pid, startTime } = JSON.parse(text) as { pid?: unknown; startTime?: unknown }
    return { text, pid: typeof pid === "number" ? pid : undefined, ...(typeof startTime === "string" ? { startTime } : {}), mtimeMs }
  } catch {
    return { text, pid: undefined, mtimeMs }
  }
}

/** Held means a live owner, or an ownerless file young enough that its owner may be mid-write. */
function lockIsHeld(lock: LockRecord, isAlive: LockOwnerCheck): boolean {
  return lock.pid === undefined ? Date.now() - lock.mtimeMs < UNREADABLE_LOCK_GRACE_MS : isAlive(lock.pid, lock.startTime)
}

function readJoinLock(paths: LocalAudioPaths, isAlive: LockOwnerCheck = lockOwnerAlive): { live: boolean; pid?: number } {
  const lock = readLockFile(paths.lockFile)
  return { live: lockIsHeld(lock, isAlive), ...(lock.pid !== undefined ? { pid: lock.pid } : {}) }
}

/** Tells the process holding the join lock to stop (SIGTERM). Returns its pid, or null when nobody live holds it. */
export function stopLockHolder(
  paths: LocalAudioPaths,
  kill: (pid: number, signal: NodeJS.Signals) => void = process.kill.bind(process),
  isAlive: LockOwnerCheck = lockOwnerAlive,
): number | null {
  const holder = readJoinLock(paths, isAlive)
  if (!holder.live || holder.pid === undefined || holder.pid === process.pid) return null
  try {
    kill(holder.pid, "SIGTERM")
  } catch {
    return null
  }
  return holder.pid
}

export type JoinLock = { ok: true; release: () => void } | { ok: false; holderPid: number | undefined }

/**
 * The single-join lock: an exclusive (O_EXCL) file holding the owner's pid. Another live process
 * holding it means a join is running or starting, so the caller must not touch its sox, socket or
 * files. A lock whose owner is dead is reclaimed; the reclaim renames the file away first and puts
 * it back if it turns out to belong to someone else, so two reclaimers cannot both win.
 */
export function acquireJoinLock(
  paths: LocalAudioPaths,
  pid: number = process.pid,
  isAlive: LockOwnerCheck = lockOwnerAlive,
  startTimeOf: (pid: number) => string | undefined = (owner) => defaultInspectProcess(owner)?.startTime,
): JoinLock {
  fs.mkdirSync(paths.dir, { recursive: true, mode: 0o700 })
  fs.chmodSync(paths.dir, 0o700)
  for (;;) {
    try {
      const fd = fs.openSync(paths.lockFile, "wx", 0o600)
      try {
        const startTime = startTimeOf(pid)
        fs.writeSync(fd, JSON.stringify({ pid, ...(startTime ? { startTime } : {}), startedAt: new Date().toISOString() }))
      } finally {
        fs.closeSync(fd)
      }
      return {
        ok: true,
        release: () => {
          if (readLockFile(paths.lockFile)?.pid === pid) fs.rmSync(paths.lockFile, { force: true })
        },
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
    }
    const seen = readLockFile(paths.lockFile)
    if (lockIsHeld(seen, isAlive)) return { ok: false, holderPid: seen.pid }
    const claimed = `${paths.lockFile}.claim.${pid}.${crypto.randomBytes(4).toString("hex")}`
    try {
      fs.renameSync(paths.lockFile, claimed)
    } catch {
      continue
    }
    const taken = readLockFile(claimed)
    fs.rmSync(claimed, { force: true })
    if (taken.text !== seen.text) {
      // We moved aside a lock another process had just created: give it back and report it held.
      try {
        fs.writeFileSync(paths.lockFile, taken.text, { flag: "wx", mode: 0o600 })
      } catch { /* its owner already wrote a new one */ }
      return { ok: false, holderPid: taken.pid }
    }
  }
}

export interface JoinStatusFile {
  state: "starting" | "joined" | "failed" | "ended"
  callSid?: string
  reason?: string
  updatedAt?: string
}

export function writeJoinStatus(paths: LocalAudioPaths, status: JoinStatusFile): void {
  fs.mkdirSync(paths.dir, { recursive: true, mode: 0o700 })
  fs.writeFileSync(paths.statusFile, JSON.stringify({ ...status, updatedAt: new Date().toISOString() }), { mode: 0o600 })
}

export function readJoinStatus(paths: LocalAudioPaths): JoinStatusFile | null {
  try {
    return JSON.parse(fs.readFileSync(paths.statusFile, "utf8")) as JoinStatusFile
  } catch {
    return null
  }
}

const UNSAFE_SEGMENT = /[/\\\0]|^\.{1,2}$/

/** `friend:channel:key` (the key may contain colons). Refuses anything that could leave the pending directory. */
export function parseNotifySession(value: string): { friendId: string; channel: string; key: string } | null {
  const first = value.indexOf(":")
  const second = value.indexOf(":", first + 1)
  if (first <= 0 || second <= first + 1) return null
  const friendId = value.slice(0, first)
  const channel = value.slice(first + 1, second)
  const key = value.slice(second + 1)
  if (!key) return null
  for (const segment of [friendId, channel, key]) if (UNSAFE_SEGMENT.test(segment)) return null
  return { friendId, channel, key }
}
