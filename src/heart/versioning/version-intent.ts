import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { emitNervesEvent } from "../../nerves/runtime"

export interface VersionIntent {
  schemaVersion: 1
  mode: "pinned" | "latest"
  targetVersion: string
}

export interface VersionIntentDeps {
  homeDir?: string
  readFileSync?: (path: string, encoding: BufferEncoding) => string
  mkdirSync?: (path: string, options: fs.MakeDirectoryOptions) => void
  writeFileSync?: (path: string, data: string, options: fs.WriteFileOptions) => void
  renameSync?: (oldPath: string, newPath: string) => void
  unlinkSync?: (path: string) => void
  randomUUID?: () => string
}

export function versionIntentPath(homeDir = os.homedir()): string {
  return path.join(homeDir, ".ouro-cli", "version-intent.json")
}

function parseVersionIntent(raw: string): VersionIntent {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    throw new Error("invalid version intent: malformed JSON")
  }
  if (
    !value
    || typeof value !== "object"
    || (value as Record<string, unknown>).schemaVersion !== 1
    || !["pinned", "latest"].includes(String((value as Record<string, unknown>).mode))
    || typeof (value as Record<string, unknown>).targetVersion !== "string"
    || !(value as Record<string, unknown>).targetVersion
  ) {
    throw new Error("invalid version intent: expected schemaVersion=1, mode, and targetVersion")
  }
  return value as VersionIntent
}

export function readVersionIntent(deps: Pick<VersionIntentDeps, "homeDir" | "readFileSync"> = {}): VersionIntent | null {
  const readFileSync = deps.readFileSync ?? fs.readFileSync
  try {
    return parseVersionIntent(readFileSync(versionIntentPath(deps.homeDir), "utf8"))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null
    throw error
  }
}

export function writeVersionIntent(intent: VersionIntent, deps: VersionIntentDeps = {}): void {
  const mkdirSync = deps.mkdirSync ?? fs.mkdirSync
  const writeFileSync = deps.writeFileSync ?? fs.writeFileSync
  const renameSync = deps.renameSync ?? fs.renameSync
  const unlinkSync = deps.unlinkSync ?? fs.unlinkSync
  const randomUUID = deps.randomUUID ?? (() => `${process.pid}-${Date.now()}`)
  const destination = versionIntentPath(deps.homeDir)
  const temporary = `${destination}.${randomUUID()}.tmp`

  emitNervesEvent({
    component: "daemon",
    event: "daemon.version_intent_write_start",
    message: "writing CLI version intent",
    meta: { mode: intent.mode, targetVersion: intent.targetVersion },
  })
  try {
    mkdirSync(path.dirname(destination), { recursive: true })
    writeFileSync(temporary, `${JSON.stringify(intent, null, 2)}\n`, { encoding: "utf8", mode: 0o600 })
    renameSync(temporary, destination)
    emitNervesEvent({
      component: "daemon",
      event: "daemon.version_intent_write_end",
      message: "CLI version intent written",
      meta: { mode: intent.mode, targetVersion: intent.targetVersion },
    })
  } catch (error) {
    try { unlinkSync(temporary) } catch { /* best-effort temporary cleanup */ }
    emitNervesEvent({
      component: "daemon",
      event: "daemon.version_intent_write_error",
      level: "error",
      message: "failed to write CLI version intent",
      meta: { mode: intent.mode, targetVersion: intent.targetVersion, error: error instanceof Error ? error.message : String(error) },
    })
    throw error
  }
}
