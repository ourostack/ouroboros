import { execFile } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { promisify } from "node:util"
import type { ContinuityBinding, ContinuityProfile, ContinuityRunner, ProcessGeneration } from "./continuity-types"

export type ProcessProofObservation =
  | { state: "absent" }
  | { state: "unknown"; reason: string }
  | {
    state: "present"
    generation: ProcessGeneration
    parentPid: number
    processGroupId: number
    foregroundProcessGroupId: number | null
    ttyDevice: number | null
    executable: string
    entryScript: string | null
    cwd: string | null
  }

export type ProcessProofCapability =
  | { supported: false; reason: string }
  | { supported: true; platform: "linux"; helperPath: null }
  | { supported: true; platform: "darwin"; helperPath: string; helperSha256: string; sourceSha256: string; architecture: string }

export interface ProcessProofBuildDeps {
  compilerPath?: string
  sdkPath?: string
  run?: (command: string, args: string[], timeoutMs: number) => Promise<string>
}

export interface ProcessProofDeps {
  platform: NodeJS.Platform
  capability?: ProcessProofCapability
  inspect?: (pid: number) => Promise<ProcessProofObservation>
  run?: (command: string, args: string[], timeoutMs: number) => Promise<string>
  procRoot?: string
  deadline?: number
  nativeEntries?: Array<{ runner: ContinuityRunner; executable: string; entryScript: string | null; version: string }>
  knownOwners?: (binding: ContinuityBinding) => Promise<{ complete: boolean; owners: ProcessGeneration[] }>
}

export type ContinuityCallerProof =
  | { state: "unsupported" | "blocked"; reason: string }
  | { state: "verified"; profileId: string; generation: ProcessGeneration; wrapper: ProcessGeneration | null; nativeSessionId: string; cwd: string | null }

export interface ContinuityTerminationProof {
  source: "ended" | "live" | "unknown"
  survivingOwners: "clear" | "present" | "unknown"
  eligible: boolean
  reasons: string[]
}

const exec = promisify(execFile)
async function run(command: string, args: string[], timeoutMs: number): Promise<string> {
  return (await exec(command, args, { timeout: timeoutMs, maxBuffer: 32768, encoding: "utf8" })).stdout
}
const sha = (bytes: Buffer | string): string => createHash("sha256").update(bytes).digest("hex")
const unknown = (reason: string): ProcessProofObservation => ({ state: "unknown", reason })
const unsupported = (reason: string): ProcessProofCapability => ({ supported: false, reason })
const validPid = (pid: number): boolean => Number.isInteger(pid) && pid > 0 && pid <= 2147483647
const clean = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 4096 && !/[\x00-\x1f\x7f]/.test(value)
const absolute = (value: unknown): value is string => clean(value) && path.isAbsolute(value)
const nullablePath = (value: unknown): value is string | null => value === null || absolute(value)
const integer = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0
const nullableInteger = (value: unknown): value is number | null => value === null || integer(value)

function privateFile(file: string, limit: number, executable = false, source = false): Buffer {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
  try {
    const stat = fs.fstatSync(fd)
    if (!stat.isFile() || stat.nlink !== 1 || (stat.uid !== process.getuid!() && !(source && stat.uid === 0)) ||
      (stat.mode & (source ? 0o022 : 0o077)) !== 0 || stat.size > limit || (executable && (stat.mode & 0o100) === 0)) throw new Error("untrusted process proof cache")
    const bytes = fs.readFileSync(fd)
    const after = fs.fstatSync(fd)
    if (bytes.length > limit || stat.dev !== after.dev || stat.ino !== after.ino || stat.size !== after.size || stat.mtimeMs !== after.mtimeMs) throw new Error("process proof cache changed")
    return bytes
  } finally { fs.closeSync(fd) }
}

function cacheDirectory(homeDir: string, sourceHash: string): string {
  if (!absolute(homeDir)) throw new Error("invalid process proof home")
  const home = fs.lstatSync(homeDir)
  if (!home.isDirectory() || home.isSymbolicLink() || home.uid !== process.getuid!() || (home.mode & 0o022) !== 0) throw new Error("untrusted process proof home")
  const parts = [".ouro-cli", "state", "shepherd-continuity-process", `${sourceHash}-${process.arch}`]
  let current = homeDir
  for (const part of parts) {
    current = path.join(current, part)
    if (!fs.existsSync(current)) fs.mkdirSync(current, { mode: 0o700 })
    const stat = fs.lstatSync(current)
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid!() || (stat.mode & 0o022) !== 0) throw new Error("untrusted process proof directory")
    if (part.startsWith(sourceHash) && (stat.mode & 0o777) !== 0o700) throw new Error("process proof directory is not private")
  }
  return current
}

async function probeHelper(helper: string, execute: NonNullable<ProcessProofBuildDeps["run"]>): Promise<boolean> {
  return (await execute(helper, ["0"], 10000)).trim() === '{"state":"unknown","reason":"pid-invalid"}'
}

export async function prepareContinuityProcessProof(
  input: { homeDir: string; platform: NodeJS.Platform; sourcePath: string }, deps: ProcessProofBuildDeps = {},
): Promise<ProcessProofCapability> {
  if (input.platform === "linux") return { supported: true, platform: "linux", helperPath: null }
  if (input.platform !== "darwin") return unsupported("platform-unsupported")
  try {
    const source = privateFile(input.sourcePath, 65536, false, true)
    if (!source.length) return unsupported("source-invalid")
    const sourceSha256 = sha(source)
    const directory = cacheDirectory(input.homeDir, sourceSha256)
    const helperPath = path.join(directory, "process-proof")
    const receiptPath = path.join(directory, "build.json")
    if (fs.existsSync(helperPath) || fs.existsSync(receiptPath)) {
      const receipt: unknown = JSON.parse(privateFile(receiptPath, 16384).toString("utf8"))
      if (!receipt || typeof receipt !== "object" || Array.isArray(receipt) || Object.keys(receipt).sort().join(",") !== "architecture,helperSha256,sourceSha256") return unsupported("cache-invalid")
      const fields = receipt as Record<string, unknown>
      if (fields.sourceSha256 !== sourceSha256 || fields.architecture !== process.arch || fields.helperSha256 !== sha(privateFile(helperPath, 1024 * 1024, true))) return unsupported("cache-invalid")
      if (!await probeHelper(helperPath, deps.run ?? run)) return unsupported("helper-probe-failed")
      return { supported: true, platform: "darwin", helperPath, helperSha256: fields.helperSha256 as string, sourceSha256, architecture: process.arch }
    }
    const compiler = deps.compilerPath ?? "/Library/Developer/CommandLineTools/usr/bin/clang"
    const sdk = deps.sdkPath ?? "/Library/Developer/CommandLineTools/SDKs/MacOSX.sdk"
    if (!absolute(compiler) || compiler === "/usr/bin/clang" || !fs.existsSync(compiler)) return unsupported("compiler-unavailable")
    const compilerStat = fs.statSync(compiler)
    if (!compilerStat.isFile() || !(compilerStat.mode & 0o111) || (compilerStat.mode & 0o022) || (compilerStat.uid !== 0 && compilerStat.uid !== process.getuid!())) return unsupported("compiler-untrusted")
    if (!absolute(sdk) || !fs.statSync(sdk).isDirectory()) return unsupported("sdk-unavailable")
    const output = path.join(directory, `build-${randomUUID()}`)
    const sourceSnapshot = path.join(directory, `source-${randomUUID()}.c`)
    fs.writeFileSync(sourceSnapshot, source, { mode: 0o600, flag: "wx" })
    await (deps.run ?? run)(compiler, ["-std=c11", "-Wall", "-Wextra", "-Werror", "-O2", "-isysroot", sdk, sourceSnapshot, "-o", output], 10000)
    fs.chmodSync(output, 0o700)
    const helperSha256 = sha(privateFile(output, 1024 * 1024, true))
    if (!await probeHelper(output, deps.run ?? run)) return unsupported("helper-probe-failed")
    if (fs.existsSync(helperPath) || fs.existsSync(receiptPath)) return unsupported("concurrent-build")
    fs.copyFileSync(output, helperPath, fs.constants.COPYFILE_EXCL)
    fs.chmodSync(helperPath, 0o700)
    fs.writeFileSync(receiptPath, JSON.stringify({ architecture: process.arch, helperSha256, sourceSha256 }), { mode: 0o600, flag: "wx" })
    return { supported: true, platform: "darwin", helperPath, helperSha256, sourceSha256, architecture: process.arch }
  } catch { return unsupported("build-or-cache-unavailable") }
}

function parseObservation(value: unknown, pid: number): ProcessProofObservation {
  if (!value || typeof value !== "object" || Array.isArray(value)) return unknown("inspection-invalid")
  const raw = value as Record<string, unknown>
  if (raw.state === "absent" && Object.keys(raw).length === 1) return { state: "absent" }
  if (raw.state === "unknown" && Object.keys(raw).sort().join(",") === "reason,state" && clean(raw.reason)) return unknown("native-inspection-unavailable")
  const keys = ["state", "generation", "parentPid", "processGroupId", "foregroundProcessGroupId", "ttyDevice", "executable", "entryScript", "cwd"]
  if (raw.state !== "present" || Object.keys(raw).length !== keys.length || keys.some(key => !Object.hasOwn(raw, key))) return unknown("inspection-invalid")
  const g = raw.generation
  if (!g || typeof g !== "object" || Array.isArray(g)) return unknown("inspection-invalid")
  const generation = g as Record<string, unknown>
  if (Object.keys(generation).sort().join(",") !== "birth,pid,uid" || generation.pid !== pid ||
    !clean(generation.birth) || !/^(?:darwin:\d+:\d{1,6}|linux:[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}:\d+)$/.test(generation.birth) ||
    !integer(generation.uid)) return unknown("inspection-invalid")
  if (!integer(raw.parentPid) || !integer(raw.processGroupId) || !validPid(raw.processGroupId) ||
    !nullableInteger(raw.foregroundProcessGroupId) || (raw.foregroundProcessGroupId !== null && !validPid(raw.foregroundProcessGroupId)) ||
    !nullableInteger(raw.ttyDevice) ||
    !absolute(raw.executable) || !nullablePath(raw.entryScript) || !nullablePath(raw.cwd)) return unknown("inspection-invalid")
  return {
    state: "present", generation: { pid, birth: generation.birth, uid: generation.uid },
    parentPid: raw.parentPid, processGroupId: raw.processGroupId, foregroundProcessGroupId: raw.foregroundProcessGroupId,
    ttyDevice: raw.ttyDevice, executable: raw.executable, entryScript: raw.entryScript, cwd: raw.cwd,
  }
}

function procRead(root: string, relative: string, max: number): string {
  const file = path.join(root, relative)
  const fd = fs.openSync(file, fs.constants.O_RDONLY)
  try {
    const buffer = Buffer.alloc(max + 1)
    const size = fs.readSync(fd, buffer, 0, buffer.length, 0)
    if (size > max) throw new Error("oversized proc observation")
    return buffer.subarray(0, size).toString("utf8")
  } finally { fs.closeSync(fd) }
}

function linuxObservation(pid: number, root: string): ProcessProofObservation {
  try {
    const boot = procRead(root, "sys/kernel/random/boot_id", 128).trim()
    if (!/^[a-f0-9-]{36}$/.test(boot)) return unknown("boot-identity-unavailable")
    const start = procRead(root, `${pid}/stat`, 16384)
    if (!start.startsWith(`${pid} (`) || start.lastIndexOf(")") < 0) return unknown("process-record-invalid")
    const tail = start.slice(start.lastIndexOf(")") + 2).trim().split(/\s+/)
    const uid = /^Uid:\s+\d+\s+(\d+)/m.exec(procRead(root, `${pid}/status`, 16384))
    if (!uid || !/^\d+$/.test(tail[19])) return unknown("birth-identity-unavailable")
    const executable = fs.readlinkSync(path.join(root, `${pid}/exe`))
    const cwd = fs.readlinkSync(path.join(root, `${pid}/cwd`))
    const args = procRead(root, `${pid}/cmdline`, 16384).split("\0")
    const observation = {
      state: "present", generation: { pid, birth: `linux:${boot}:${tail[19]}`, uid: Number(uid[1]) },
      parentPid: Number(tail[1]), processGroupId: Number(tail[2]), foregroundProcessGroupId: Number(tail[5]) > 0 ? Number(tail[5]) : null,
      ttyDevice: Number(tail[4]) > 0 ? Number(tail[4]) : null, executable,
      entryScript: /\/node(?:js)?$/.test(executable) && absolute(args[1]) ? args[1] : null, cwd,
    }
    const after = procRead(root, `${pid}/stat`, 16384).slice(start.lastIndexOf(")") + 2).trim().split(/\s+/)
    if (tail[19] !== after[19] || tail[1] !== after[1]) return unknown("process-observation-changed")
    return parseObservation(observation, pid)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" && fs.existsSync(path.join(root, "sys/kernel/random/boot_id")) && !fs.existsSync(path.join(root, String(pid)))) return { state: "absent" }
    return unknown("inspection-failed")
  }
}

export async function inspectContinuityProcess(pid: number, deps: ProcessProofDeps): Promise<ProcessProofObservation> {
  if (!validPid(pid)) return unknown("pid-invalid")
  if (deps.deadline !== undefined && Date.now() >= deps.deadline) return unknown("inspection-deadline")
  try {
    if (deps.inspect) return parseObservation(await deps.inspect(pid), pid)
    if (deps.platform === "linux") return linuxObservation(pid, deps.procRoot ?? "/proc")
    const capability = deps.capability
    if (deps.platform !== "darwin" || !capability?.supported || capability.platform !== "darwin") return unknown("capability-unavailable")
    if (sha(privateFile(capability.helperPath, 1024 * 1024, true)) !== capability.helperSha256) return unknown("helper-integrity-failed")
    const timeout = Math.max(1, Math.min(500, (deps.deadline ?? Date.now() + 500) - Date.now()))
    const output = await (deps.run ?? run)(capability.helperPath, [String(pid)], timeout)
    if (Buffer.byteLength(output) > 32768) return unknown("inspection-oversized")
    const observation = parseObservation(JSON.parse(output), pid)
    if (observation.state === "present" && /\/node(?:js)?$/.test(observation.executable)) {
      const argv = await (deps.run ?? run)("/bin/ps", ["-ww", "-p", String(pid), "-o", "command="], timeout)
      const match = /^(\S+)\s+(\/[^\s\\'"]+)(?:\s|$)/.exec(argv.trim())
      if (match && (match[1] === observation.executable || match[1] === path.basename(observation.executable))) observation.entryScript = match[2]
    }
    return observation
  } catch { return unknown("inspection-failed") }
}

function matches(observation: Extract<ProcessProofObservation, { state: "present" }>, executable: string, entryScript: string | null = executable): boolean {
  return observation.executable === executable || (/\/node(?:js)?$/.test(observation.executable) && entryScript !== null && observation.entryScript === entryScript)
}

export async function resolveContinuityCaller(
  input: { adapterPid: number; nativeSessionId: string; runner: ContinuityRunner; profiles: ContinuityProfile[] }, deps: ProcessProofDeps,
): Promise<ContinuityCallerProof> {
  if (!clean(input.nativeSessionId)) return { state: "blocked", reason: "native-session-invalid" }
  const bounded = { ...deps, deadline: deps.deadline ?? Date.now() + 1500 }
  const chain: Array<Extract<ProcessProofObservation, { state: "present" }>> = []
  let pid = input.adapterPid
  for (let i = 0; i < 16; i++) {
    if (chain.some(item => item.generation.pid === pid)) return { state: "blocked", reason: "ancestry-cycle" }
    const observation = await inspectContinuityProcess(pid, bounded)
    if (observation.state !== "present") return { state: "unsupported", reason: "ancestry-unavailable" }
    chain.push(observation)
    if (observation.parentPid <= 1) break
    pid = observation.parentPid
    if (i === 15) return { state: "unsupported", reason: "ancestry-too-deep" }
  }
  if (chain[0].generation.uid !== process.getuid!()) return { state: "blocked", reason: "adapter-owner-mismatch" }
  const candidates: Array<{ profile: ContinuityProfile; actor: typeof chain[number]; wrapper: typeof chain[number] | null }> = []
  for (const p of input.profiles.filter(p => p.runner === input.runner)) {
    for (const actor of chain.slice(1)) {
      if (p.launcher === "direct" && matches(actor, p.executable)) candidates.push({ profile: p, actor, wrapper: null })
      if (p.launcher === "agency") {
        const entry = deps.nativeEntries?.find(entry => entry.runner === p.runner && entry.version === p.version && matches(actor, entry.executable, entry.entryScript))
        const wrapper = chain.slice(chain.indexOf(actor) + 1).find(parent => matches(parent, p.executable))
        if (entry && wrapper) candidates.push({ profile: p, actor, wrapper })
      }
    }
  }
  if (candidates.length === 0) return { state: "unsupported", reason: "native-profile-unmatched" }
  if (candidates.length !== 1) return { state: "blocked", reason: "native-profile-ambiguous" }
  const candidate = candidates[0]
  if (candidate.actor.generation.uid !== process.getuid!() || (candidate.wrapper && candidate.wrapper.generation.uid !== process.getuid!())) return { state: "blocked", reason: "native-owner-mismatch" }
  if (candidate.actor.ttyDevice === null || candidate.actor.foregroundProcessGroupId !== candidate.actor.processGroupId) return { state: "blocked", reason: "native-not-foreground" }
  for (const observed of chain) {
    const now = await inspectContinuityProcess(observed.generation.pid, bounded)
    if (now.state !== "present" || JSON.stringify(now.generation) !== JSON.stringify(observed.generation) ||
      now.parentPid !== observed.parentPid || now.executable !== observed.executable || now.entryScript !== observed.entryScript ||
      now.processGroupId !== observed.processGroupId || now.foregroundProcessGroupId !== observed.foregroundProcessGroupId || now.ttyDevice !== observed.ttyDevice) return { state: "blocked", reason: "ancestry-changed" }
  }
  return { state: "verified", profileId: candidate.profile.id, generation: candidate.actor.generation, wrapper: candidate.wrapper?.generation ?? null, nativeSessionId: input.nativeSessionId, cwd: candidate.actor.cwd }
}

function generationDisposition(generation: ProcessGeneration, observation: ProcessProofObservation): "ended" | "live" | "unknown" {
  if (observation.state === "absent") return "ended"
  if (observation.state === "unknown") return "unknown"
  if (observation.generation.birth !== generation.birth) return "ended"
  return observation.generation.uid === generation.uid ? "live" : "unknown"
}

export async function observeContinuityTermination(binding: ContinuityBinding, deps: ProcessProofDeps): Promise<ContinuityTerminationProof> {
  const source = generationDisposition(binding.process, await inspectContinuityProcess(binding.process.pid, deps))
  if (source !== "ended") return { source, survivingOwners: "unknown", eligible: false, reasons: [`source-${source}`] }
  try {
    const inventory = deps.knownOwners ? await deps.knownOwners(binding) : { complete: false, owners: [] }
    const owners = [...inventory.owners, ...(binding.wrapper ? [binding.wrapper] : [])]
    let survivingOwners: ContinuityTerminationProof["survivingOwners"] = inventory.complete ? "clear" : "unknown"
    for (const owner of owners) {
      const disposition = generationDisposition(owner, await inspectContinuityProcess(owner.pid, deps))
      if (disposition === "live") survivingOwners = "present"
      else if (disposition === "unknown" && survivingOwners !== "present") survivingOwners = "unknown"
    }
    return { source, survivingOwners, eligible: survivingOwners === "clear", reasons: survivingOwners === "clear" ? [] : [`surviving-owners-${survivingOwners}`] }
  } catch { return { source, survivingOwners: "unknown", eligible: false, reasons: ["owner-inventory-unavailable"] } }
}
