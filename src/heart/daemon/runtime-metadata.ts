import { createHash } from "crypto"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import * as childProcess from "child_process"
import { getAgentBundlesRoot, getAgentDaemonLoggingConfigPath, getRepoRoot } from "../identity"
import { emitNervesEvent } from "../../nerves/runtime"

export interface RuntimeMetadata {
  version: string
  lastUpdated: string
  repoRoot: string
  configFingerprint: string
}

export interface RuntimeMetadataDeps {
  repoRoot?: string
  bundlesRoot?: string
  secretsRoot?: string
  daemonLoggingPath?: string
  readFileSync?: typeof fs.readFileSync
  statSync?: typeof fs.statSync
  readdirSync?: typeof fs.readdirSync
  existsSync?: typeof fs.existsSync
  execFileSync?: typeof childProcess.execFileSync
}

const UNKNOWN_METADATA = "unknown"

function optionalFunction<T extends (...args: never[]) => unknown>(
  target: object,
  key: string,
): T | null {
  try {
    const candidate = (target as Record<string, unknown>)[key]
    return typeof candidate === "function" ? candidate as T : null
  } catch {
    return null
  }
}

function readVersion(
  packageJsonPath: string,
  readFileSyncImpl: typeof fs.readFileSync,
): string {
  try {
    const parsed = JSON.parse(readFileSyncImpl(packageJsonPath, "utf-8")) as { version?: unknown }
    return typeof parsed.version === "string" && parsed.version.trim().length > 0
      ? parsed.version.trim()
      : UNKNOWN_METADATA
  } catch {
    return UNKNOWN_METADATA
  }
}

function readLastUpdated(
  repoRoot: string,
  packageJsonPath: string,
  statSyncImpl: typeof fs.statSync,
  execFileSyncImpl: typeof childProcess.execFileSync,
): { value: string; source: "git" | "package-json-mtime" | "unknown" } {
  try {
    const raw = execFileSyncImpl("git", ["log", "-1", "--format=%cI"], {
      cwd: repoRoot,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim()
    if (raw.length > 0) {
      return { value: raw, source: "git" }
    }
  } catch {
    // fall through to mtime fallback
  }

  try {
    const stats = statSyncImpl(packageJsonPath)
    return {
      value: stats.mtime.toISOString(),
      source: "package-json-mtime",
    }
  } catch {
    return { value: UNKNOWN_METADATA, source: "unknown" }
  }
}

function readHomeDir(): string | null {
  const homedirImpl = optionalFunction<typeof os.homedir>(os, "homedir")
  if (!homedirImpl) {
    return null
  }

  try {
    return homedirImpl.call(os)
  } catch {
    return null
  }
}

function listConfigTargets(
  bundlesRoot: string,
  secretsRoot: string | null,
  daemonLoggingPath: string | null,
  readdirSyncImpl: typeof fs.readdirSync | null,
): string[] {
  if (!readdirSyncImpl) return []

  const targets = new Set<string>()
  if (daemonLoggingPath) {
    targets.add(daemonLoggingPath)
  }

  try {
    const bundleEntries = readdirSyncImpl(bundlesRoot, { withFileTypes: true }) as fs.Dirent[]
    for (const entry of bundleEntries) {
      if (!entry.isDirectory() || !entry.name.endsWith(".ouro")) continue
      targets.add(path.join(bundlesRoot, entry.name, "agent.json"))
    }
  } catch {
    // ignore unreadable bundle roots
  }

  if (secretsRoot) {
    try {
      const secretEntries = readdirSyncImpl(secretsRoot, { withFileTypes: true }) as fs.Dirent[]
      for (const entry of secretEntries) {
        if (!entry.isDirectory()) continue
        targets.add(path.join(secretsRoot, entry.name, "secrets.json"))
      }
    } catch {
      // ignore unreadable secrets roots
    }
  }

  return [...targets].sort()
}

function readConfigFingerprint(
  targets: string[],
  readFileSyncImpl: typeof fs.readFileSync | null,
  existsSyncImpl: typeof fs.existsSync | null,
): { value: string; source: "content-hash" | "unknown"; trackedFiles: number; presentFiles: number } {
  if (!readFileSyncImpl || !existsSyncImpl) {
    return {
      value: UNKNOWN_METADATA,
      source: "unknown",
      trackedFiles: targets.length,
      presentFiles: 0,
    }
  }

  const hash = createHash("sha256")
  let presentFiles = 0

  for (const target of targets) {
    hash.update(target)
    hash.update("\0")

    if (!existsSyncImpl(target)) {
      hash.update("missing")
      hash.update("\0")
      continue
    }

    presentFiles += 1
    hash.update("present")
    hash.update("\0")

    try {
      hash.update(readFileSyncImpl(target, "utf-8"))
    } catch {
      hash.update("unreadable")
    }

    hash.update("\0")
  }

  return {
    value: hash.digest("hex"),
    source: "content-hash",
    trackedFiles: targets.length,
    presentFiles,
  }
}

export function getRuntimeMetadata(deps: RuntimeMetadataDeps = {}): RuntimeMetadata {
  const repoRoot = deps.repoRoot ?? getRepoRoot()
  const bundlesRoot = deps.bundlesRoot ?? getAgentBundlesRoot()
  const homeDir = readHomeDir()
  const secretsRoot = deps.secretsRoot ?? (homeDir ? path.join(homeDir, ".agentsecrets") : null)
  const daemonLoggingPath = deps.daemonLoggingPath ?? getAgentDaemonLoggingConfigPath()
  const readFileSyncImpl = deps.readFileSync ?? optionalFunction<typeof fs.readFileSync>(fs, "readFileSync")?.bind(fs) ?? null
  const statSyncImpl = deps.statSync ?? optionalFunction<typeof fs.statSync>(fs, "statSync")?.bind(fs) ?? null
  const readdirSyncImpl = deps.readdirSync ?? optionalFunction<typeof fs.readdirSync>(fs, "readdirSync")?.bind(fs) ?? null
  const existsSyncImpl = deps.existsSync ?? optionalFunction<typeof fs.existsSync>(fs, "existsSync")?.bind(fs) ?? null
  const execFileSyncImpl = deps.execFileSync
    ?? optionalFunction<typeof childProcess.execFileSync>(childProcess, "execFileSync")?.bind(childProcess)
    ?? null
  const packageJsonPath = path.join(repoRoot, "package.json")

  const version = readFileSyncImpl
    ? readVersion(packageJsonPath, readFileSyncImpl)
    : UNKNOWN_METADATA
  const lastUpdated = statSyncImpl
    ? readLastUpdated(
        repoRoot,
        packageJsonPath,
        statSyncImpl,
        execFileSyncImpl ?? (() => {
          throw new Error("git unavailable")
        }),
      )
    : { value: UNKNOWN_METADATA, source: "unknown" as const }
  const configTargets = listConfigTargets(
    bundlesRoot,
    secretsRoot,
    daemonLoggingPath,
    readdirSyncImpl,
  )
  const configFingerprint = readConfigFingerprint(
    configTargets,
    readFileSyncImpl,
    existsSyncImpl,
  )

  emitNervesEvent({
    component: "daemon",
    event: "daemon.runtime_metadata_read",
    message: "read runtime metadata",
    meta: {
      version,
      lastUpdated: lastUpdated.value,
      lastUpdatedSource: lastUpdated.source,
      repoRoot,
      configFingerprint: configFingerprint.value === UNKNOWN_METADATA
        ? UNKNOWN_METADATA
        : configFingerprint.value.slice(0, 12),
      configFingerprintSource: configFingerprint.source,
      configTrackedFiles: configFingerprint.trackedFiles,
      configPresentFiles: configFingerprint.presentFiles,
    },
  })

  return {
    version,
    lastUpdated: lastUpdated.value,
    repoRoot,
    configFingerprint: configFingerprint.value,
  }
}
