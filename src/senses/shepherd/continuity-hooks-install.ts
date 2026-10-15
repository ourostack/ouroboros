import { createHash, randomUUID } from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { emitNervesEvent } from "../../nerves/runtime"
import { CONTINUITY_NATIVE_VERSIONS } from "./continuity-hook"
import type { ContinuityRunner } from "./continuity-types"

export interface ContinuityHookInstallRequest {
  agent: string
  runner: ContinuityRunner
  version: string
  ouroEntry: string
  settingsPath: string
}
export interface ContinuityHookInstallPlan {
  request: ContinuityHookInstallRequest
  document: Record<string, unknown>
  sourceHash: string | null
  changed: boolean
}
export interface ContinuityHookInstallReceipt {
  installed: boolean
  settingsPath: string
  sha256: string
  reload: "unverified"
}
const LIMIT = 262144
const digest = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex")
const quote = (value: string) => `'${value.replace(/'/g, "'\\''")}'`
function refuse(code: string): never {
  emitNervesEvent({ level: "warn", component: "senses", event: "senses.shepherd_continuity_install_refused",
    message: "continuity native hook install refused", meta: { code } })
  throw new Error(`Shepherd continuity hook install: ${code}`)
}
function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}
function trustedPath(file: string, executable = false): void {
  if (typeof file !== "string" || !path.isAbsolute(file) || path.normalize(file) !== file || /[\x00-\x1f\x7f]/.test(file)) refuse("absolute trusted path required")
  const parts = file.split("/").filter(Boolean)
  let current = ""
  for (let index = 0; index < parts.length; index++) {
    current += `/${parts[index]}`
    let stat: fs.Stats
    try { stat = fs.lstatSync(current) } catch (error) {
      if (index === parts.length - 1 && !executable && (error as NodeJS.ErrnoException).code === "ENOENT") return
      throw error
    }
    if (stat.isSymbolicLink() || (index < parts.length - 1 && !stat.isDirectory())) refuse("symlink or non-directory path")
    // The system temp ancestor can be sticky and world-writable, but never the selected file's parent.
    if (index >= parts.length - 2 && ((stat.mode & 0o022) !== 0 || (stat.uid !== process.getuid!() && stat.uid !== 0))) refuse("untrusted path ownership or mode")
    if (index === parts.length - 1 && (!stat.isFile() || stat.nlink !== 1 || !Number.isSafeInteger(stat.ino) ||
      executable && (stat.mode & 0o111) === 0)) refuse("untrusted regular file")
  }
}
function readSource(file: string): { bytes: Buffer; hash: string } | null {
  trustedPath(file)
  let fd: number
  try { fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null
    throw error
  }
  try {
    const before = fs.fstatSync(fd)
    if (!before.isFile() || before.nlink !== 1 || before.size > LIMIT) refuse("settings byte limit or file type")
    const bytes = Buffer.alloc(LIMIT + 1)
    let size = 0
    while (size < bytes.length) {
      const count = fs.readSync(fd, bytes, size, bytes.length - size, size)
      if (!count) break
      size += count
    }
    const after = fs.fstatSync(fd)
    const named = fs.lstatSync(file)
    if (size > LIMIT || size !== before.size || before.dev !== named.dev || before.ino !== named.ino ||
      before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) refuse("settings descriptor changed")
    trustedPath(file)
    return { bytes: bytes.subarray(0, size), hash: digest(bytes.subarray(0, size)) }
  } finally { fs.closeSync(fd) }
}
function command(request: ContinuityHookInstallRequest): string {
  return [request.ouroEntry, "shepherd", "hook", "--agent", request.agent, "--runner", request.runner].map(quote).join(" ")
}
export function planContinuityHookInstall(input: ContinuityHookInstallRequest): ContinuityHookInstallPlan {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(input.agent)) refuse("invalid agent")
  if (input.version !== CONTINUITY_NATIVE_VERSIONS[input.runner]) refuse("unsupported version")
  trustedPath(input.ouroEntry, true)
  const source = readSource(input.settingsPath)
  let document: unknown = {}
  if (source) {
    try { document = JSON.parse(source.bytes.toString("utf8")) } catch { refuse("invalid settings JSON") }
  }
  if (!record(document)) refuse("settings object required")
  const original = JSON.stringify(document)
  if (input.runner === "copilot") {
    if (document.version !== undefined && document.version !== 1) refuse("Copilot hook version")
    document.version = 1
  }
  if (document.hooks !== undefined && !record(document.hooks)) refuse("hooks object required")
  const hooks: Record<string, unknown> = record(document.hooks) ? document.hooks : {}
  document.hooks = hooks
  const key = input.runner === "copilot" ? "agentStop" : "Stop"
  if (hooks[key] !== undefined && !Array.isArray(hooks[key])) refuse("native hooks list required")
  const entries: unknown[] = Array.isArray(hooks[key]) ? hooks[key] : []
  const ownCommand = command(input)
  const matches = entries.flatMap(entry => {
    if (!record(entry)) return []
    if (input.runner === "copilot") return entry.bash === ownCommand ? [entry] : []
    return Array.isArray(entry.hooks) ? entry.hooks.filter((hook): hook is Record<string, unknown> =>
      record(hook) && hook.command === ownCommand) : []
  })
  if (matches.length > 1) refuse("duplicate owned hooks")
  if (!matches.length) entries.push(input.runner === "copilot" ?
    { type: "command", bash: ownCommand, timeoutSec: 5 } :
    { hooks: [{ type: "command", command: ownCommand, timeout: 5 }] })
  else {
    const hook = matches[0]
    if (hook.type !== "command" || hook[input.runner === "copilot" ? "timeoutSec" : "timeout"] !== 5) refuse("owned hook differs from required contract")
  }
  hooks[key] = entries
  if (Buffer.byteLength(JSON.stringify(document)) > LIMIT) refuse("planned settings byte limit")
  return { request: { ...input }, document, sourceHash: source?.hash ?? null, changed: original !== JSON.stringify(document) }
}
export function installContinuityHook(plan: ContinuityHookInstallPlan): ContinuityHookInstallReceipt {
  // Rebuild from the trusted request: a preview object is not permission to write arbitrary JSON.
  const current = planContinuityHookInstall(plan.request)
  if (current.sourceHash !== plan.sourceHash || JSON.stringify(current.document) !== JSON.stringify(plan.document)) refuse("settings revision changed")
  const file = plan.request.settingsPath
  const bytes = Buffer.from(JSON.stringify(current.document, null, 2) + "\n")
  if (!current.changed) return { installed: false, settingsPath: file, sha256: current.sourceHash!, reload: "unverified" }
  if (bytes.length > LIMIT) refuse("formatted settings byte limit")
  const lock = `${file}.shepherd-install-lock`
  const archive = `${file}.shepherd-install-${randomUUID()}.interrupted`
  // Kernel O_EXCL ownership never expires. A suspended installer retains exclusion.
  const fd = fs.openSync(lock, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600)
  const pin = fs.fstatSync(fd)
  let committed = false
  try {
    fs.writeFileSync(fd, bytes)
    fs.fsyncSync(fd)
    if ((readSource(file)?.hash ?? null) !== plan.sourceHash) refuse("settings revision changed while reserved")
    trustedPath(file)
    const named = fs.lstatSync(lock)
    if (named.dev !== pin.dev || named.ino !== pin.ino || named.isSymbolicLink()) refuse("install reservation changed")
    fs.renameSync(lock, file)
    committed = true
    const observed = readSource(file)
    if (!observed || observed.hash !== digest(bytes)) refuse("install readback uncertain")
    emitNervesEvent({ component: "senses", event: "senses.shepherd_continuity_hooks_installed",
      message: "native hook file installed and read back; reload remains unverified", meta: { runner: plan.request.runner } })
    return { installed: true, settingsPath: file, sha256: observed.hash, reload: "unverified" }
  } finally {
    fs.closeSync(fd)
    if (!committed) {
      const named = fs.lstatSync(lock)
      if (named.dev === pin.dev && named.ino === pin.ino && !named.isSymbolicLink()) fs.renameSync(lock, archive)
    }
  }
}
