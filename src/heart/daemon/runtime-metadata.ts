import * as fs from "fs"
import * as path from "path"
import * as childProcess from "child_process"
import { getRepoRoot } from "../identity"
import { emitNervesEvent } from "../../nerves/runtime"

export interface RuntimeMetadata {
  version: string
  lastUpdated: string
}

export interface RuntimeMetadataDeps {
  repoRoot?: string
  readFileSync?: typeof fs.readFileSync
  statSync?: typeof fs.statSync
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

export function getRuntimeMetadata(deps: RuntimeMetadataDeps = {}): RuntimeMetadata {
  const repoRoot = deps.repoRoot ?? getRepoRoot()
  const readFileSyncImpl = deps.readFileSync ?? optionalFunction<typeof fs.readFileSync>(fs, "readFileSync")?.bind(fs) ?? null
  const statSyncImpl = deps.statSync ?? optionalFunction<typeof fs.statSync>(fs, "statSync")?.bind(fs) ?? null
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

  emitNervesEvent({
    component: "daemon",
    event: "daemon.runtime_metadata_read",
    message: "read runtime metadata",
    meta: {
      version,
      lastUpdated: lastUpdated.value,
      lastUpdatedSource: lastUpdated.source,
    },
  })

  return {
    version,
    lastUpdated: lastUpdated.value,
  }
}
