import { createHash } from "node:crypto"
import { spawn } from "node:child_process"
import * as fs from "node:fs"
import * as path from "node:path"

import type {
  HostSupervisor,
  HostSupervisorAttempt,
} from "./sanctuary-host-executor"

const SCHEMA_VERSION = 1 as const
const DIGEST = /^sha256:[a-f0-9]{64}$/u
const PERMIT_ID = /^permit-[A-Za-z0-9_-]{43}$/u

interface DetachedSupervisorSpec {
  schemaVersion: typeof SCHEMA_VERSION
  permitId: string
  permitArtifact: Parameters<HostSupervisor["execute"]>[0]["permitArtifact"]
  keyId: string
  publicKeyPem: string
  executable: string
  arguments: string[]
  cwd: "/"
  environment: Readonly<Record<string, string>>
  timeoutMs: number
  cgroupRoot: string
  launcherPath: string
  launcherDigest: string
  prlimitPath: string
  prlimitDigest: string
  setsidPath: string
  setsidDigest: string
  shellPath: string
  shellDigest: string
  supervisorProgramPath: string
  supervisorProgramDigest: string
  readyPath: string
  terminalPath: string
  lockPath: string
  spawnPath: string
  startPath: string
}

interface SupervisorBinding {
  schemaVersion: typeof SCHEMA_VERSION
  permitId: string
  specDigest: string
  supervisorPid: number
  bootId: string
  processStartTime: string
}

interface TerminalRecord extends SupervisorBinding {
  attempt: HostSupervisorAttempt
}

interface DetachedChild {
  pid?: number
  unref(): void
}

export interface DetachedSanctuaryHostSupervisorOptions {
  stateRoot: string
  cgroupRoot: string
  programPath: string
  programDigest: string
  launcherPath: string
  launcherDigest: string
  prlimitPath: string
  prlimitDigest: string
  setsidPath: string
  setsidDigest: string
  shellPath: string
  shellDigest: string
  expectedUid: number
  keyId: string
  publicKeyPem: string
  bootId?: () => string
  processStartTime?: (pid: number) => string
  processAlive?: (pid: number) => boolean
  spawn?: (input: {
    programPath: string
    specPath: string
    readyPath: string
    terminalPath: string
    detached: true
  }) => DetachedChild
  sleep?: (milliseconds: number) => Promise<void>
  now?: () => string
  killCgroup?: (cgroupPath: string) => void
  cgroupEmpty?: (cgroupPath: string) => boolean
  removeCgroup?: (cgroupPath: string) => void
  signalProcess?: (pid: number, signal: NodeJS.Signals) => void
  readyTimeoutMs?: number
}

function digest(bytes: string | Buffer): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function assertAbsolute(value: string, label: string): void {
  if (!path.isAbsolute(value)) throw new Error(`Sanctuary host ${label} path must be absolute`)
}

function assertPinnedProgram(filePath: string, expectedDigest: string, expectedUid: number): void {
  if (!DIGEST.test(expectedDigest)) throw new Error("Sanctuary host program digest is invalid")
  const stat = fs.lstatSync(filePath)
  if (
    !stat.isFile()
    || stat.isSymbolicLink()
    || stat.uid !== expectedUid
    || (stat.mode & 0o111) === 0
    || (stat.mode & 0o022) !== 0
  ) {
    throw new Error(`Sanctuary host program metadata is invalid: ${filePath}`)
  }
  const descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
  try {
    if (digest(fs.readFileSync(descriptor)) !== expectedDigest) {
      throw new Error(`Sanctuary host program digest changed: ${filePath}`)
    }
  } finally {
    fs.closeSync(descriptor)
  }
}

function writePrivate(filePath: string, bytes: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 })
  fs.chmodSync(path.dirname(filePath), 0o700)
  const temporaryPath = `${filePath}.${process.pid}.tmp`
  const descriptor = fs.openSync(
    temporaryPath,
    fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW,
    0o600,
  )
  try {
    fs.writeFileSync(descriptor, bytes, "utf8")
    fs.fsyncSync(descriptor)
  } finally {
    fs.closeSync(descriptor)
  }
  fs.renameSync(temporaryPath, filePath)
  fs.chmodSync(filePath, 0o600)
}

function readPrivateJson(filePath: string, expectedUid: number): unknown {
  const stat = fs.lstatSync(filePath)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== expectedUid || (stat.mode & 0o777) !== 0o600) {
    throw new Error(`Sanctuary host supervisor record metadata is invalid: ${filePath}`)
  }
  const descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
  try {
    return JSON.parse(fs.readFileSync(descriptor, "utf8")) as unknown
  } finally {
    fs.closeSync(descriptor)
  }
}

function binding(value: unknown, permitId: string, specDigest: string): SupervisorBinding {
  if (
    !isObject(value)
    || value.schemaVersion !== SCHEMA_VERSION
    || value.permitId !== permitId
    || value.specDigest !== specDigest
    || !Number.isSafeInteger(value.supervisorPid)
    || (value.supervisorPid as number) < 1
    || typeof value.bootId !== "string"
    || value.bootId.length === 0
    || typeof value.processStartTime !== "string"
    || value.processStartTime.length === 0
  ) {
    throw new Error("Sanctuary host supervisor binding is invalid")
  }
  return value as unknown as SupervisorBinding
}

function defaultBootId(): string {
  return fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim()
}

function defaultProcessStartTime(pid: number): string {
  const fields = fs.readFileSync(`/proc/${pid}/stat`, "utf8").trim().split(" ")
  if (fields.length < 22 || !fields[21]) throw new Error("Sanctuary host supervisor process start time is unavailable")
  return fields[21]
}

function defaultProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM"
  }
}

function cgroupEmpty(cgroupPath: string): boolean {
  const events = fs.readFileSync(path.join(cgroupPath, "cgroup.events"), "utf8")
  const populated = events.split("\n").find((line) => line.startsWith("populated "))
  if (!populated) throw new Error("Sanctuary host cgroup populated state is unavailable")
  return populated === "populated 0"
}

export class DetachedSanctuaryHostSupervisor implements HostSupervisor {
  readonly #options: DetachedSanctuaryHostSupervisorOptions
  #active = false

  constructor(options: DetachedSanctuaryHostSupervisorOptions) {
    for (const [label, value] of [
      ["state root", options.stateRoot],
      ["cgroup root", options.cgroupRoot],
      ["supervisor", options.programPath],
      ["launcher", options.launcherPath],
      ["prlimit", options.prlimitPath],
      ["setsid", options.setsidPath],
      ["shell", options.shellPath],
    ]) assertAbsolute(value, label)
    this.#options = options
  }

  verifyInstallation(): void {
    this.#assertPins()
  }

  async execute(input: Parameters<HostSupervisor["execute"]>[0]): Promise<HostSupervisorAttempt> {
    return this.#run(input, false)
  }

  async resume(input: Parameters<HostSupervisor["execute"]>[0]): Promise<HostSupervisorAttempt> {
    return this.#run(input, true)
  }

  async reconcileOrphans(knownPermitIds: readonly string[]): Promise<void> {
    this.verifyInstallation()
    const known = new Set(knownPermitIds)
    let stateEntries: string[] = []
    try {
      stateEntries = fs.readdirSync(this.#options.stateRoot)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    }

    for (const permitId of stateEntries) {
      if (!PERMIT_ID.test(permitId) || !known.has(permitId)) {
        throw new Error("Sanctuary host supervisor state is unmatched")
      }
    }
    for (const permitId of fs.readdirSync(this.#options.cgroupRoot)) {
      const cgroupPath = path.join(this.#options.cgroupRoot, permitId)
      if (!fs.lstatSync(cgroupPath).isDirectory()) continue
      if (!PERMIT_ID.test(permitId)) throw new Error("Sanctuary host cgroup entry is invalid")
      if (!known.has(permitId)) await this.#reconcileCgroup(cgroupPath)
    }
  }

  acknowledge(permitId: string): void {
    if (!PERMIT_ID.test(permitId)) throw new Error("Sanctuary host supervisor permit id is invalid")
    const permitRoot = path.join(this.#options.stateRoot, permitId)
    if (!fs.existsSync(permitRoot)) {
      if (fs.existsSync(path.join(this.#options.cgroupRoot, permitId))) {
        throw new Error("Sanctuary host supervisor cgroup is still present")
      }
      return
    }
    const specPath = path.join(permitRoot, "spec.json")
    const terminalPath = path.join(permitRoot, "terminal.json")
    const lockPath = path.join(permitRoot, "supervisor.lock")
    const acknowledgementPath = path.join(permitRoot, "acknowledgement.json")
    const recoveryPath = path.join(permitRoot, "recovery.json")
    if (fs.existsSync(lockPath) || fs.existsSync(path.join(this.#options.cgroupRoot, permitId))) {
      throw new Error("Sanctuary host supervisor is not safely terminal")
    }
    if (fs.existsSync(acknowledgementPath)) {
      const acknowledgement = readPrivateJson(acknowledgementPath, this.#options.expectedUid)
      if (!isObject(acknowledgement) || acknowledgement.schemaVersion !== SCHEMA_VERSION || acknowledgement.permitId !== permitId) {
        throw new Error("Sanctuary host supervisor acknowledgement changed")
      }
    } else if (fs.existsSync(specPath) || fs.existsSync(terminalPath) || fs.existsSync(recoveryPath)) {
      const specBytes = fs.readFileSync(specPath, "utf8")
      if (fs.existsSync(terminalPath)) {
        binding(readPrivateJson(terminalPath, this.#options.expectedUid), permitId, digest(specBytes))
      } else {
        const recovery = readPrivateJson(recoveryPath, this.#options.expectedUid)
        if (
          !isObject(recovery)
          || recovery.schemaVersion !== SCHEMA_VERSION
          || recovery.permitId !== permitId
          || recovery.specDigest !== digest(specBytes)
        ) {
          throw new Error("Sanctuary host supervisor recovery acknowledgement changed")
        }
      }
      writePrivate(acknowledgementPath, `${JSON.stringify({ schemaVersion: SCHEMA_VERSION, permitId })}\n`)
    }
    for (const name of ["start.json", "spawn.json", "ready.json", "terminal.json", "recovery.json", "spec.json", "acknowledgement.json"]) {
      const filePath = path.join(permitRoot, name)
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath)
    }
    fs.rmdirSync(permitRoot)
  }

  async #run(input: Parameters<HostSupervisor["execute"]>[0], resume: boolean): Promise<HostSupervisorAttempt> {
    if (this.#active) throw new Error("Sanctuary detached host supervisor is already active")
    if (!PERMIT_ID.test(input.permit.permitId)) throw new Error("Sanctuary detached host permit id is invalid")
    this.#active = true
    try {
      this.verifyInstallation()
      const permitRoot = path.join(this.#options.stateRoot, input.permit.permitId)
      const specPath = path.join(permitRoot, "spec.json")
      const readyPath = path.join(permitRoot, "ready.json")
      const terminalPath = path.join(permitRoot, "terminal.json")
      const lockPath = path.join(permitRoot, "supervisor.lock")
      const spawnPath = path.join(permitRoot, "spawn.json")
      const startPath = path.join(permitRoot, "start.json")
      const spec: DetachedSupervisorSpec = {
        schemaVersion: SCHEMA_VERSION,
        permitId: input.permit.permitId,
        permitArtifact: input.permitArtifact,
        keyId: this.#options.keyId,
        publicKeyPem: this.#options.publicKeyPem,
        executable: input.executable,
        arguments: input.arguments,
        cwd: input.cwd,
        environment: input.environment,
        timeoutMs: input.timeoutMs,
        cgroupRoot: this.#options.cgroupRoot,
        launcherPath: this.#options.launcherPath,
        launcherDigest: this.#options.launcherDigest,
        prlimitPath: this.#options.prlimitPath,
        prlimitDigest: this.#options.prlimitDigest,
        setsidPath: this.#options.setsidPath,
        setsidDigest: this.#options.setsidDigest,
        shellPath: this.#options.shellPath,
        shellDigest: this.#options.shellDigest,
        supervisorProgramPath: this.#options.programPath,
        supervisorProgramDigest: this.#options.programDigest,
        readyPath,
        terminalPath,
        lockPath,
        spawnPath,
        startPath,
      }
      const specBytes = `${JSON.stringify(spec)}\n`
      const specDigest = digest(specBytes)
      let ready: SupervisorBinding | undefined
      if (resume && !fs.existsSync(specPath)) {
        return this.#recoveryAttempt(input.permit.permitId)
      }
      if (fs.existsSync(specPath)) {
        const existing = fs.readFileSync(specPath, "utf8")
        if (existing !== specBytes) throw new Error("Sanctuary host supervisor specification changed")
        if (fs.existsSync(terminalPath)) return this.#terminal(terminalPath, input.permit.permitId, specDigest)
        try {
          if (fs.existsSync(readyPath)) {
            ready = binding(readPrivateJson(readyPath, this.#options.expectedUid), input.permit.permitId, specDigest)
          } else if (fs.existsSync(spawnPath)) {
            ready = binding(readPrivateJson(spawnPath, this.#options.expectedUid), input.permit.permitId, specDigest)
            this.#assertProcessBinding(ready)
            if (!fs.existsSync(startPath)) writePrivate(startPath, `${JSON.stringify({ schemaVersion: SCHEMA_VERSION, permitId: input.permit.permitId, specDigest })}\n`)
            ready = await this.#waitForReady(readyPath, input.permit.permitId, specDigest)
          } else {
            return this.#recoveryAttempt(input.permit.permitId, undefined, specDigest)
          }
          this.#assertLiveBinding(ready, lockPath)
        } catch {
          return this.#recoveryAttempt(input.permit.permitId, ready, specDigest)
        }
      } else {
        writePrivate(specPath, specBytes)
        const child = (this.#options.spawn ?? ((value) => {
          const spawned = spawn(process.execPath, [value.programPath, "--spec", value.specPath], {
            detached: true,
            stdio: "ignore",
          })
          return spawned
        }))({ programPath: this.#options.programPath, specPath, readyPath, terminalPath, detached: true })
        if (!child.pid) throw new Error("Sanctuary host supervisor failed to start")
        child.unref()
        ready = {
          schemaVersion: SCHEMA_VERSION,
          permitId: input.permit.permitId,
          specDigest,
          supervisorPid: child.pid,
          bootId: (this.#options.bootId ?? defaultBootId)(),
          processStartTime: (this.#options.processStartTime ?? defaultProcessStartTime)(child.pid),
        }
        writePrivate(spawnPath, `${JSON.stringify(ready)}\n`)
        writePrivate(startPath, `${JSON.stringify({ schemaVersion: SCHEMA_VERSION, permitId: input.permit.permitId, specDigest })}\n`)
        ready = await this.#waitForReady(readyPath, input.permit.permitId, specDigest)
        if (ready.supervisorPid !== child.pid) throw new Error("Sanctuary host supervisor binding changed")
        this.#assertLiveBinding(ready, lockPath)
      }
      try {
        return await this.#waitForTerminal(terminalPath, lockPath, ready, input.permit.permitId, specDigest, input.timeoutMs + 20_000)
      } catch {
        return this.#recoveryAttempt(input.permit.permitId, ready, specDigest)
      }
    } finally {
      this.#active = false
    }
  }

  #assertPins(): void {
    for (const [filePath, expectedDigest] of [
      [this.#options.programPath, this.#options.programDigest],
      [this.#options.launcherPath, this.#options.launcherDigest],
      [this.#options.prlimitPath, this.#options.prlimitDigest],
      [this.#options.setsidPath, this.#options.setsidDigest],
      [this.#options.shellPath, this.#options.shellDigest],
    ]) assertPinnedProgram(filePath, expectedDigest, this.#options.expectedUid)
  }

  #assertLiveBinding(value: SupervisorBinding, lockPath: string): void {
    this.#assertProcessBinding(value)
    const lock = readPrivateJson(lockPath, this.#options.expectedUid)
    if (
      !isObject(lock)
      || lock.schemaVersion !== SCHEMA_VERSION
      || lock.permitId !== value.permitId
      || lock.supervisorPid !== value.supervisorPid
    ) {
      throw new Error("Sanctuary host supervisor live binding changed")
    }
  }

  #assertProcessBinding(value: SupervisorBinding): void {
    const processAlive = this.#options.processAlive ?? defaultProcessAlive
    const bootId = this.#options.bootId ?? defaultBootId
    const processStartTime = this.#options.processStartTime ?? defaultProcessStartTime
    if (
      !processAlive(value.supervisorPid)
      || bootId() !== value.bootId
      || processStartTime(value.supervisorPid) !== value.processStartTime
    ) {
      throw new Error("Sanctuary host supervisor live binding changed")
    }
  }

  async #waitForReady(filePath: string, permitId: string, specDigest: string): Promise<SupervisorBinding> {
    const attempts = Math.max(1, Math.ceil((this.#options.readyTimeoutMs ?? 5_000) / 25))
    for (let index = 0; index < attempts; index += 1) {
      if (fs.existsSync(filePath)) return binding(readPrivateJson(filePath, this.#options.expectedUid), permitId, specDigest)
      await (this.#options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))))(25)
    }
    if (fs.existsSync(filePath)) return binding(readPrivateJson(filePath, this.#options.expectedUid), permitId, specDigest)
    throw new Error("Sanctuary host supervisor readiness timed out")
  }

  async #waitForTerminal(
    filePath: string,
    lockPath: string,
    ready: SupervisorBinding,
    permitId: string,
    specDigest: string,
    timeoutMs: number,
  ): Promise<HostSupervisorAttempt> {
    const attempts = Math.max(1, Math.ceil(timeoutMs / 25))
    for (let index = 0; index < attempts; index += 1) {
      if (fs.existsSync(filePath) && !fs.existsSync(lockPath)) return this.#terminal(filePath, permitId, specDigest)
      this.#assertProcessBinding(ready)
      await (this.#options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))))(25)
    }
    if (fs.existsSync(filePath) && !fs.existsSync(lockPath)) return this.#terminal(filePath, permitId, specDigest)
    throw new Error("Sanctuary host supervisor terminal record timed out")
  }

  #terminal(filePath: string, permitId: string, specDigest: string): HostSupervisorAttempt {
    const value = readPrivateJson(filePath, this.#options.expectedUid)
    const record = binding(value, permitId, specDigest)
    if (!isObject(value) || !("attempt" in value)) throw new Error("Sanctuary host supervisor terminal record is invalid")
    const terminal = { ...record, attempt: value.attempt } as TerminalRecord
    return terminal.attempt
  }

  async #recoveryAttempt(
    permitId: string,
    supervisor?: SupervisorBinding,
    specDigest?: string,
  ): Promise<HostSupervisorAttempt> {
    const startedAt = this.#options.now?.() ?? new Date().toISOString()
    if (supervisor && (this.#options.processAlive ?? defaultProcessAlive)(supervisor.supervisorPid)) {
      try {
        (this.#options.signalProcess ?? process.kill)(supervisor.supervisorPid, "SIGTERM")
      } catch (error) {
        if (!isObject(error) || error.code !== "ESRCH") throw error
      }
    }
    const cgroupPath = path.join(this.#options.cgroupRoot, permitId)
    let cleanup: HostSupervisorAttempt["cleanup"] = fs.existsSync(cgroupPath) && await this.#reconcileCgroup(cgroupPath)
      ? "cgroup_empty"
      : "cleanup_unproven"
    if (cleanup === "cgroup_empty" && supervisor) {
      const processAlive = this.#options.processAlive ?? defaultProcessAlive
      for (let attempt = 0; attempt < 400 && processAlive(supervisor.supervisorPid); attempt += 1) {
        await (this.#options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))))(25)
      }
      if (processAlive(supervisor.supervisorPid)) {
        cleanup = "cleanup_unproven"
      } else {
        const lockPath = path.join(this.#options.stateRoot, permitId, "supervisor.lock")
        if (fs.existsSync(lockPath)) {
          const lock = readPrivateJson(lockPath, this.#options.expectedUid)
          if (!isObject(lock) || lock.permitId !== permitId || lock.supervisorPid !== supervisor.supervisorPid) {
            throw new Error("Sanctuary host supervisor recovery lock changed")
          }
          fs.unlinkSync(lockPath)
        }
      }
    }
    if (cleanup === "cgroup_empty" && specDigest) {
      writePrivate(
        path.join(this.#options.stateRoot, permitId, "recovery.json"),
        `${JSON.stringify({ schemaVersion: SCHEMA_VERSION, permitId, specDigest })}\n`,
      )
    }
    return {
      startedAt,
      completedAt: this.#options.now?.() ?? new Date().toISOString(),
      exitCode: null,
      signal: null,
      timedOut: false,
      cancelled: false,
      outputOverflow: false,
      stdout: "",
      stderr: "",
      stdoutDigest: digest(""),
      stderrDigest: digest(""),
      stdoutBytes: 0,
      stderrBytes: 0,
      cleanup,
      containment: "unprovable_after_approved_root_migration",
      verificationBefore: null,
      verificationAfter: null,
    }
  }

  async #reconcileCgroup(cgroupPath: string): Promise<boolean> {
    if (this.#options.killCgroup) this.#options.killCgroup(cgroupPath)
    else fs.writeFileSync(path.join(cgroupPath, "cgroup.kill"), "1", "utf8")
    for (let attempt = 0; attempt < 400; attempt += 1) {
      if ((this.#options.cgroupEmpty ?? cgroupEmpty)(cgroupPath)) {
        (this.#options.removeCgroup ?? fs.rmdirSync)(cgroupPath)
        return true
      }
      await (this.#options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))))(25)
    }
    return false
  }
}
