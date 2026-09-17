import { spawn, type ChildProcess } from "node:child_process"
import { createHash } from "node:crypto"
import * as fs from "node:fs"
import * as path from "node:path"
import type { Readable } from "node:stream"
import { emitNervesEvent } from "../../nerves/runtime"

import type {
  SanctuaryHostSupervisorChild,
  SanctuaryHostSupervisorKernel,
} from "./sanctuary-host-supervisor"

const OUTPUT_LIMIT = 64 * 1024

function requireRootOwnedProgram(filePath: string, links = new Set<string>()): void {
  const parts = path.resolve(filePath).split("/").filter(Boolean)
  let current = "/"
  let stat = fs.lstatSync(current)
  for (let index = 0; index < parts.length; index += 1) {
    current = path.join(current, parts[index]!)
    stat = fs.lstatSync(current)
    if (stat.uid !== 0) throw new Error("Sanctuary host program path must be root-owned")
    if (stat.isSymbolicLink()) {
      if (links.has(current)) throw new Error("Sanctuary host program path has a symlink cycle")
      links.add(current)
      return requireRootOwnedProgram(path.resolve(path.dirname(current), fs.readlinkSync(current), ...parts.slice(index + 1)), links)
    }
    if ((stat.mode & 0o022) !== 0 || (index < parts.length - 1 && !stat.isDirectory())) {
      throw new Error("Sanctuary host program path must be root-owned and non-writable by other users")
    }
  }
  if (!stat.isFile() || (stat.mode & 0o111) === 0) throw new Error("Sanctuary host program must be an executable regular file")
}

export interface LinuxSanctuaryHostKernelOptions {
  cgroupRoot: string
  shellPath: string
  launcherPath: string
  prlimitPath: string
  setsidPath: string
  pollIntervalMs?: number
  spawn?: typeof spawn
  kill?: (pid: number, signal: NodeJS.Signals) => void
  bootId?: () => string
  processStartTime?: (pid: number) => string
  processCgroup?: (pid: number) => string | null
  sleep?: (milliseconds: number) => Promise<void>
  now?: () => string
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

function cgroupEmpty(cgroupPath: string): boolean {
  const events = fs.readFileSync(path.join(cgroupPath, "cgroup.events"), "utf8")
  const populated = events.split("\n").find((line) => line.startsWith("populated "))
  if (!populated) throw new Error("Sanctuary host cgroup populated state is unavailable")
  return populated === "populated 0"
}

function defaultProcessCgroup(pid: number): string | null {
  try {
    return fs.readFileSync(`/proc/${pid}/cgroup`, "utf8")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null
    throw error
  }
}

function processInCgroup(value: string, cgroupPath: string): boolean {
  const relative = cgroupPath.startsWith("/sys/fs/cgroup")
    ? cgroupPath.slice("/sys/fs/cgroup".length)
    : cgroupPath
  return value.split("\n").some((line) => line.endsWith(`:${relative}`))
}

function fileDigest(filePath: string): string {
  const stat = fs.lstatSync(filePath)
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Sanctuary host verification target is not a regular file")
  const descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
  const hash = createHash("sha256")
  const buffer = Buffer.allocUnsafe(64 * 1024)
  try {
    let count: number
    do {
      count = fs.readSync(descriptor, buffer, 0, buffer.length, null)
      if (count > 0) hash.update(buffer.subarray(0, count))
    } while (count > 0)
  } finally {
    fs.closeSync(descriptor)
  }
  return `sha256:${hash.digest("hex")}`
}

function outputCollector(child: ChildProcess, timeoutMs: number): {
  completion: SanctuaryHostSupervisorChild["completion"]
  drained: SanctuaryHostSupervisorChild["drained"]
} {
  let stdout: Buffer = Buffer.alloc(0)
  let stderr: Buffer = Buffer.alloc(0)
  let stdoutBytes = 0
  let stderrBytes = 0
  const stdoutHash = createHash("sha256")
  const stderrHash = createHash("sha256")
  let overflowed = false
  let settle!: (value: Awaited<SanctuaryHostSupervisorChild["completion"]>) => void
  let reject!: (error: Error) => void
  let settled = false
  const completion = new Promise<Awaited<SanctuaryHostSupervisorChild["completion"]>>((resolve, rejectPromise) => {
    settle = resolve
    reject = rejectPromise
  })
  let settleDrained!: (value: Awaited<SanctuaryHostSupervisorChild["drained"]>) => void
  let rejectDrained!: (error: Error) => void
  const drained = new Promise<Awaited<SanctuaryHostSupervisorChild["drained"]>>((resolve, rejectPromise) => {
    settleDrained = resolve
    rejectDrained = rejectPromise
  })
  const finish = (value: Awaited<SanctuaryHostSupervisorChild["completion"]>): void => {
    if (settled) return
    settled = true
    clearTimeout(deadline)
    settle(value)
  }
  const append = (current: Buffer, value: Buffer): { bytes: Buffer; overflow: boolean } => {
    const remaining = Math.max(0, OUTPUT_LIMIT - current.length)
    const next = remaining > 0 ? Buffer.concat([current, value.subarray(0, remaining)]) : current
    return { bytes: next, overflow: value.length > remaining }
  }
  const finishOverflow = (): void => {
    if (overflowed) return
    overflowed = true
    finish({
      exitCode: null,
      signal: null,
      stdout: stdout.toString("utf8"),
      stderr: stderr.toString("utf8"),
      outputOverflow: true,
      migrationSuspected: false,
      deadlineExpired: false,
    })
  }
  child.stdout?.on("data", (value: Buffer) => {
    stdoutHash.update(value)
    stdoutBytes += value.length
    const next = append(stdout, value)
    stdout = next.bytes
    if (next.overflow) finishOverflow()
  })
  child.stderr?.on("data", (value: Buffer) => {
    stderrHash.update(value)
    stderrBytes += value.length
    const next = append(stderr, value)
    stderr = next.bytes
    if (next.overflow) finishOverflow()
  })
  const deadline = setTimeout(() => finish({
    exitCode: null,
    signal: null,
    stdout: stdout.toString("utf8"),
    stderr: stderr.toString("utf8"),
    outputOverflow: overflowed,
    migrationSuspected: false,
    deadlineExpired: true,
  }), timeoutMs)
  deadline.unref()
  child.once("error", (error) => {
    if (settled) return
    settled = true
    clearTimeout(deadline)
    reject(error)
    rejectDrained(error)
  })
  child.once("close", (exitCode, signal) => {
    finish({
        exitCode,
        signal,
        stdout: stdout.toString("utf8"),
        stderr: stderr.toString("utf8"),
        outputOverflow: overflowed,
        migrationSuspected: false,
        deadlineExpired: false,
      })
    settleDrained({
      stdout: stdout.toString("utf8"),
      stderr: stderr.toString("utf8"),
      stdoutDigest: `sha256:${stdoutHash.digest("hex")}`,
      stderrDigest: `sha256:${stderrHash.digest("hex")}`,
      stdoutBytes,
      stderrBytes,
    })
  })
  return { completion, drained }
}

export class LinuxSanctuaryHostSupervisorKernel implements SanctuaryHostSupervisorKernel {
  readonly #options: LinuxSanctuaryHostKernelOptions

  constructor(options: LinuxSanctuaryHostKernelOptions) {
    for (const value of [options.cgroupRoot, options.shellPath, options.launcherPath, options.prlimitPath, options.setsidPath]) {
      if (!path.isAbsolute(value)) throw new Error("Sanctuary host Linux kernel paths must be absolute")
    }
    this.#options = options
  }

  async prepareCgroup(permitId: string, limits: {
    cpuMax: "50000 100000"
    memoryMax: "1073741824"
    pidsMax: "256"
  }): Promise<string> {
    const cgroupPath = path.join(this.#options.cgroupRoot, permitId)
    fs.mkdirSync(cgroupPath, { recursive: false, mode: 0o700 })
    fs.writeFileSync(path.join(cgroupPath, "cpu.max"), limits.cpuMax, "utf8")
    fs.writeFileSync(path.join(cgroupPath, "memory.max"), limits.memoryMax, "utf8")
    fs.writeFileSync(path.join(cgroupPath, "pids.max"), limits.pidsMax, "utf8")
    return cgroupPath
  }

  async launch(input: Parameters<SanctuaryHostSupervisorKernel["launch"]>[0]): Promise<SanctuaryHostSupervisorChild> {
    requireRootOwnedProgram(input.executable)
    const spawnImpl = this.#options.spawn ?? spawn
    const child = spawnImpl(this.#options.shellPath, [
      this.#options.launcherPath,
      path.join(input.cgroupPath, "cgroup.procs"),
      this.#options.prlimitPath,
      this.#options.setsidPath,
      input.executable,
      ...input.arguments,
    ], {
      cwd: input.cwd,
      env: input.environment,
      detached: false,
      stdio: ["ignore", "pipe", "pipe", "pipe"],
    })
    if (!child.pid || !child.stdio[3]) throw new Error("Sanctuary host launcher failed to start")
    emitNervesEvent({ component: "daemon", event: "daemon.sanctuary_host_launcher_spawned", message: "Sanctuary host launcher spawned; handshake pending" })
    const handshake = child.stdio[3] as Readable
    const ready = new Promise<void>((resolve, reject) => {
      let bytes = ""
      handshake.setEncoding("utf8")
      handshake.on("data", (value: string) => { bytes += value })
      handshake.once("error", reject)
      handshake.once("close", () => {
        if (bytes === "ready\n") resolve()
        else reject(new Error("Sanctuary host launcher handshake is invalid"))
      })
    })
    const { completion, drained } = outputCollector(child, input.timeoutMs)
    const processCgroup = this.#options.processCgroup ?? defaultProcessCgroup
    let migrationSuspected = false
    const inspectCgroup = (): void => {
      try {
        const cgroup = processCgroup(child.pid!)
        if (cgroup !== null && !processInCgroup(cgroup, input.cgroupPath)) migrationSuspected = true
      } catch {
        migrationSuspected = true
      }
    }
    inspectCgroup()
    const migrationMonitor = setInterval(inspectCgroup, this.#options.pollIntervalMs ?? 25)
    migrationMonitor.unref()
    const observedCompletion = completion.then((value) => {
      inspectCgroup()
      return {
        ...value,
        migrationSuspected,
      }
    }).finally(() => clearInterval(migrationMonitor))
    return {
      pid: child.pid,
      bootId: this.#options.bootId?.() ?? fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim(),
      processStartTime: this.#options.processStartTime?.(child.pid)
        ?? fs.readFileSync(`/proc/${child.pid}/stat`, "utf8").trim().split(" ")[21]
        ?? "",
      ready,
      completion: observedCompletion,
      drained,
      signalGroup: (signal) => {
        try {
          (this.#options.kill ?? process.kill)(-child.pid!, signal)
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error
        }
      },
    }
  }

  async waitForCgroupEmpty(cgroupPath: string, timeoutMs: number): Promise<boolean> {
    const interval = this.#options.pollIntervalMs ?? 25
    const attempts = Math.max(1, Math.ceil(timeoutMs / interval))
    for (let index = 0; index < attempts; index += 1) {
      if (cgroupEmpty(cgroupPath)) return true
      await (this.#options.sleep ?? sleep)(interval)
    }
    return false
  }

  async killCgroup(cgroupPath: string): Promise<void> {
    fs.writeFileSync(path.join(cgroupPath, "cgroup.kill"), "1", "utf8")
  }

  async removeCgroup(cgroupPath: string): Promise<void> {
    fs.rmdirSync(cgroupPath)
  }

  async sleep(milliseconds: number): Promise<void> {
    await (this.#options.sleep ?? sleep)(milliseconds)
  }

  now(): string {
    return this.#options.now?.() ?? new Date().toISOString()
  }

  async verify(
    request: Parameters<SanctuaryHostSupervisorKernel["verify"]>[0],
    phase: Parameters<SanctuaryHostSupervisorKernel["verify"]>[1],
    permit: Parameters<SanctuaryHostSupervisorKernel["verify"]>[2],
  ): Promise<{ digest: string } | { matches: boolean; digest: string }> {
    if (request.profile !== "file.digest.v1") throw new Error("Sanctuary host verification profile is unsupported")
    const digest = fileDigest(permit.targetResource)
    return phase === "before" ? { digest } : { matches: digest === request.expectedStateDigest, digest }
  }
}
