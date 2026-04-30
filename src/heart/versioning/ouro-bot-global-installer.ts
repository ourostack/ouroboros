import { execFileSync as defaultExecFileSync } from "child_process"
import * as fs from "fs"
import * as path from "path"
import { emitNervesEvent } from "../../nerves/runtime"
import { getRuntimeMetadata } from "../daemon/runtime-metadata"

export interface GlobalOuroBotInstallResult {
  installed: boolean
  version: string
  installedVersion: string | null
  executableOwner: string | null
}

export interface GlobalOuroBotInstallerDeps {
  execFileSync?: (file: string, args: string[], options?: Record<string, unknown>) => string | Buffer
  existsSync?: (target: string) => boolean
  readFileSync?: (target: string, encoding: BufferEncoding) => string
  realpathSync?: (target: string) => string
  runtimeVersion?: string
  platform?: NodeJS.Platform
}

function normalizeOutput(output: string | Buffer): string {
  return (typeof output === "string" ? output : output.toString("utf-8")).trim()
}

function resolveGlobalPrefix(
  execFileSyncImpl: NonNullable<GlobalOuroBotInstallerDeps["execFileSync"]>,
): string {
  return normalizeOutput(execFileSyncImpl("npm", ["prefix", "-g"], { encoding: "utf-8" }))
}

function resolveGlobalRoot(
  execFileSyncImpl: NonNullable<GlobalOuroBotInstallerDeps["execFileSync"]>,
): string {
  return normalizeOutput(execFileSyncImpl("npm", ["root", "-g"], { encoding: "utf-8" }))
}

function readInstalledWrapperVersion(
  globalRoot: string,
  existsSyncImpl: NonNullable<GlobalOuroBotInstallerDeps["existsSync"]>,
  readFileSyncImpl: NonNullable<GlobalOuroBotInstallerDeps["readFileSync"]>,
): string | null {
  const packageJsonPath = path.join(globalRoot, "ouro.bot", "package.json")
  if (!existsSyncImpl(packageJsonPath)) return null
  try {
    const parsed = JSON.parse(readFileSyncImpl(packageJsonPath, "utf-8")) as { version?: unknown }
    return typeof parsed.version === "string" && parsed.version.trim().length > 0 ? parsed.version.trim() : null
  } catch {
    return null
  }
}

function resolveExecutableOwner(
  globalPrefix: string,
  platform: NodeJS.Platform,
  existsSyncImpl: NonNullable<GlobalOuroBotInstallerDeps["existsSync"]>,
  realpathSyncImpl: NonNullable<GlobalOuroBotInstallerDeps["realpathSync"]>,
): string | null {
  const binName = platform === "win32" ? "ouro.bot.cmd" : "ouro.bot"
  const binPath = platform === "win32"
    ? path.join(globalPrefix, binName)
    : path.join(globalPrefix, "bin", binName)
  if (!existsSyncImpl(binPath)) return null
  try {
    const resolved = realpathSyncImpl(binPath)
    if (resolved.includes(`${path.sep}node_modules${path.sep}ouro.bot${path.sep}`)) return "wrapper"
    if (resolved.includes(`${path.sep}node_modules${path.sep}@ouro.bot${path.sep}cli${path.sep}`)) return "cli"
    return "other"
  } catch {
    return "unknown"
  }
}

export function syncGlobalOuroBotWrapper(
  deps: GlobalOuroBotInstallerDeps = {},
): GlobalOuroBotInstallResult {
  /* v8 ignore start -- dependency-injection defaults are only exercised in the live runtime */
  const execFileSyncImpl = deps.execFileSync ?? defaultExecFileSync
  const existsSyncImpl = deps.existsSync ?? fs.existsSync
  const readFileSyncImpl = deps.readFileSync ?? fs.readFileSync
  const realpathSyncImpl = deps.realpathSync ?? fs.realpathSync
  const runtimeVersion = deps.runtimeVersion ?? getRuntimeMetadata().version
  const platform = deps.platform ?? process.platform
  /* v8 ignore stop */

  emitNervesEvent({
    component: "daemon",
    event: "daemon.ouro_bot_global_sync_start",
    message: "checking global ouro.bot wrapper",
    meta: { version: runtimeVersion },
  })

  const globalPrefix = resolveGlobalPrefix(execFileSyncImpl)
  const globalRoot = resolveGlobalRoot(execFileSyncImpl)
  const installedVersion = readInstalledWrapperVersion(globalRoot, existsSyncImpl, readFileSyncImpl)
  const executableOwner = resolveExecutableOwner(globalPrefix, platform, existsSyncImpl, realpathSyncImpl)
  const installTarget = `ouro.bot@${runtimeVersion}`

  if (executableOwner === "wrapper" && installedVersion === runtimeVersion) {
    emitNervesEvent({
      component: "daemon",
      event: "daemon.ouro_bot_global_sync_end",
      message: "global ouro.bot wrapper already current",
      meta: { version: runtimeVersion, installedVersion, executableOwner, installed: false, installTarget },
    })
    return {
      installed: false,
      version: runtimeVersion,
      installedVersion,
      executableOwner,
    }
  }

  execFileSyncImpl(
    "npm",
    ["install", "-g", "--force", installTarget],
    { stdio: "pipe", encoding: "utf-8" },
  )

  emitNervesEvent({
    component: "daemon",
    event: "daemon.ouro_bot_global_sync_end",
    message: "global ouro.bot wrapper synced",
    meta: { version: runtimeVersion, installedVersion, executableOwner, installed: true, installTarget },
  })

  return {
    installed: true,
    version: runtimeVersion,
    installedVersion,
    executableOwner,
  }
}
