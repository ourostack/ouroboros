import { createHash } from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import type { RuntimeCredentialConfig } from "../../heart/runtime-credentials"
import type {
  ContinuityConfig, ContinuityFileIdentity, ContinuityProfile, ContinuityRoot, ContinuityRunner,
} from "./continuity-types"

function invalid(field: string): never {
  throw new Error(`Invalid Shepherd continuity configuration: ${field}`)
}

function object(value: unknown, keys: string[], field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid(field)
  const result = value as Record<string, unknown>
  if (Object.keys(result).some(key => !keys.includes(key)) || keys.some(key => !Object.hasOwn(result, key))) invalid(field)
  return result
}

function text(value: unknown, limit: number, field: string): string {
  if (typeof value !== "string" || !value.length || value.length > limit || /[\x00-\x1f\x7f]/.test(value)) invalid(field)
  if (/(?:https?:\/\/)[^\s/]*@|(?:bearer\s|(?:api[_-]?key|token|password|secret|authorization)\s*[=:])/i.test(value)) invalid(field)
  return value
}

function id(value: unknown, field: string): string {
  const result = text(value, 64, field)
  if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(result)) invalid(field)
  return result
}

function list(value: unknown, limit: number, field: string): unknown[] {
  if (!Array.isArray(value) || value.length > limit) invalid(field)
  return value
}

function relative(value: unknown, field: string): string {
  const result = text(value, 1024, field)
  if (path.isAbsolute(result) || result.includes("\\") || result.split("/").some(part => !part || part === "." || part === "..")) invalid(field)
  return result
}

function identity(stat: fs.Stats): ContinuityFileIdentity {
  return { dev: stat.dev, ino: stat.ino }
}

function absolute(value: unknown, field: string): string {
  const result = text(value, 4096, field)
  if (!path.isAbsolute(result) || result.split(path.sep).includes("..")) invalid(field)
  return result
}

function directory(value: unknown, field: string): { path: string; identity: ContinuityFileIdentity } {
  const input = absolute(value, field)
  const stat = fs.lstatSync(input)
  if (!stat.isDirectory() || (stat.mode & 0o022) !== 0 || (stat.uid !== process.getuid!() && stat.uid !== 0)) invalid(field)
  return { path: fs.realpathSync(input), identity: identity(stat) }
}

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex")
}

function unique<T extends { id: string }>(values: T[], field: string): T[] {
  if (new Set(values.map(value => value.id)).size !== values.length) invalid(field)
  return values
}

function root(value: unknown): ContinuityRoot {
  const raw = object(value, ["id", "path", "namespace", "receiptBase", "launchRoots", "worktreeRoots"], "root")
  const canonical = directory(raw.path, "root.path")
  return {
    id: id(raw.id, "root.id"), path: canonical.path, identity: canonical.identity,
    namespace: relative(raw.namespace, "root.namespace"),
    receiptBase: relative(raw.receiptBase, "root.receiptBase"),
    launchRoots: list(raw.launchRoots, 32, "root.launchRoots").map(value => directory(value, "launchRoot").path),
    worktreeRoots: list(raw.worktreeRoots, 32, "root.worktreeRoots").map(value => directory(value, "worktreeRoot").path),
  }
}

function validateArgs(runner: ContinuityRunner, launcher: "direct" | "agency", args: string[]): void {
  const nativeArgs = launcher === "agency" ? args.slice(1) : args
  if (launcher === "agency" && !(
    (runner === "copilot" && ["copilot", "cp"].includes(args[0])) ||
    (runner === "claude" && args[0] === "claude")
  )) invalid("profile.launcher pairing")
  if (runner === "copilot" && !nativeArgs.includes("--allow-all")) invalid("Copilot requires --allow-all")
  let expectsValue = false
  const valuedFlags = new Set(["--model", "--agent", "--plugin-dir", "--mcp-config", "--config-dir", "--additional-dir", "--log-level", "--settings", "--setting-sources", "--permission-mode", "--allowedTools", "--disallowedTools"])
  if (runner === "codex") {
    valuedFlags.add("-c")
    valuedFlags.add("--config")
  }
  for (const arg of nativeArgs) {
    const flag = arg.split("=")[0]
    const value = arg.startsWith("-") && arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : arg
    if (/^\s*[\[{]/.test(value)) invalid("profile inline configuration; register a configuration path instead")
    if (/^(?:--(?:resume|continue|session-id|prompt|interactive|print|bootstrap(?:-.*)?|execute(?:-.*)?|receipt(?:-.*)?|nonce)|-r.*)$/.test(flag)) invalid("profile reserved argv")
    if (runner !== "codex" && /^-[pi].*/.test(flag)) invalid("profile interactive argv")
    if (runner === "claude" && (/^-c.*/.test(flag) || ["--fork-session", "--from-pr", "--teleport"].includes(flag))) invalid("Claude reuse argv")
    if (runner === "codex" && ["resume", "fork", "exec"].includes(arg)) invalid("Codex subcommand")
    if (/^[A-Z_][A-Z0-9_]*=/.test(arg) || /^(?:sh|bash|zsh|eval|env)$/.test(arg)) invalid("profile environment/shell argv")
    if (/^--(?:token|api-key|password|secret|authorization)(?:$|-)/i.test(flag)) invalid("profile credential argv")
    if (arg === "--" || (!arg.startsWith("-") && !expectsValue)) invalid("profile positional argv")
    if (expectsValue && arg.startsWith("-")) invalid("profile missing option value")
    expectsValue = !expectsValue && valuedFlags.has(flag) && !arg.includes("=")
  }
  if (expectsValue) invalid("profile missing option value")
}

function profile(value: unknown, roots: ContinuityRoot[]): ContinuityProfile {
  const raw = object(value, ["id", "runner", "launcher", "executable", "argv", "rootIds", "settingsPath", "version"], "profile")
  if (!["copilot", "claude", "codex"].includes(String(raw.runner))) invalid("profile.runner")
  if (raw.launcher !== "direct" && raw.launcher !== "agency") invalid("profile.launcher")
  const runner = raw.runner as ContinuityRunner
  const launcher = raw.launcher
  const inputExecutable = absolute(raw.executable, "profile.executable")
  if (path.basename(inputExecutable) !== (launcher === "agency" ? "agency" : runner)) invalid("profile executable pairing")
  const executable = fs.realpathSync(inputExecutable)
  const stat = fs.statSync(executable)
  if (!stat.isFile() || (stat.mode & 0o111) === 0 || (stat.mode & 0o022) !== 0 || (stat.uid !== process.getuid!() && stat.uid !== 0)) invalid("profile executable trust")
  const argv = list(raw.argv, 64, "profile.argv").map(value => text(value, 1024, "profile.argv element"))
  validateArgs(runner, launcher, argv)
  const rootIds = list(raw.rootIds, 32, "profile.rootIds").map(value => id(value, "profile.rootId"))
  if (!rootIds.length || new Set(rootIds).size !== rootIds.length || rootIds.some(value => !roots.some(root => root.id === value))) invalid("profile.rootIds references")
  const policy: Omit<ContinuityProfile, "fingerprint"> = {
    id: id(raw.id, "profile.id"), runner, launcher, executable, argv, rootIds,
    settingsPath: absolute(raw.settingsPath, "profile.settingsPath"),
    version: text(raw.version, 128, "profile.version"),
    executableIdentity: identity(stat),
  }
  return { ...policy, fingerprint: hash(policy) }
}

export function parseContinuityConfig(value: unknown): ContinuityConfig {
  const raw = object(value, ["schemaVersion", "roots", "profiles"], "document")
  if (raw.schemaVersion !== 1) invalid("schemaVersion")
  const roots = unique(list(raw.roots, 32, "roots").map(root), "duplicate root IDs")
  const profiles = unique(list(raw.profiles, 32, "profiles").map(value => profile(value, roots)), "duplicate profile IDs")
  return { schemaVersion: 1, roots, profiles }
}

export function continuityConfigFingerprint(config: ContinuityConfig): string {
  return hash(config)
}

export function readContinuityConfig(runtime: RuntimeCredentialConfig): ContinuityConfig | null {
  if (!Object.hasOwn(runtime, "shepherd")) return null
  const shepherd = runtime.shepherd
  if (!shepherd || typeof shepherd !== "object" || Array.isArray(shepherd)) invalid("shepherd")
  if (!Object.hasOwn(shepherd, "continuity")) return null
  return parseContinuityConfig((shepherd as Record<string, unknown>).continuity)
}

export function buildFreshRunnerArgs(profile: ContinuityProfile, brief: string, nativeSessionId: string): string[] {
  if (!brief.trim() || brief.length > 65536 || /[\x00\x01-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(brief)) invalid("restore brief")
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(nativeSessionId)) invalid("fresh nativeSessionId")
  validateArgs(profile.runner, profile.launcher, profile.argv)
  if (profile.runner === "codex") return [...profile.argv, brief]
  return [...profile.argv, "--session-id", nativeSessionId, ...(profile.runner === "copilot" ? ["--interactive"] : []), brief]
}
