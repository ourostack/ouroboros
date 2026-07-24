import { execSync, spawnSync } from "child_process"
import { randomUUID } from "crypto"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { emitNervesEvent } from "../../nerves/runtime"
import type { CrontabCronDeps, OsCommandOptions, OsCommandResult, OsCronDeps } from "./os-cron"

function runStructured(executable: string, argv: string[], options: OsCommandOptions = {}): OsCommandResult {
  try {
    const result = spawnSync(executable, argv, {
      encoding: "utf8",
      input: options.stdin,
      timeout: options.timeoutMs,
      maxBuffer: 1024 * 1024,
      windowsHide: true,
    })
    return {
      status: result.status,
      stdout: result.stdout ?? "",
      stderr: result.stderr || result.error?.message || "",
      timedOut: result.error !== undefined && "code" in result.error && result.error.code === "ETIMEDOUT",
    }
  } catch (error) {
    return {
      status: null,
      stdout: "",
      stderr: error instanceof Error ? error.message : String(error),
      timedOut: false,
    }
  }
}

function writeFileAtomic(filePath: string, content: string): void {
  const tempPath = `${filePath}.tmp-${process.pid}-${randomUUID()}`
  let descriptor: number | null = null
  try {
    descriptor = fs.openSync(tempPath, "wx", 0o600)
    fs.writeFileSync(descriptor, content, "utf8")
    fs.fsyncSync(descriptor)
    fs.closeSync(descriptor)
    descriptor = null
    fs.renameSync(tempPath, filePath)
  } finally {
    if (descriptor !== null) fs.closeSync(descriptor)
    try {
      fs.unlinkSync(tempPath)
    } catch {
      // Atomic rename already consumed the temporary path.
    }
  }
}

export interface RealOsCronDepsOptions {
  homeDir?: string
  uid?: number
}

export function createRealOsCronDeps(options: RealOsCronDepsOptions = {}): OsCronDeps {
  emitNervesEvent({
    component: "daemon",
    event: "daemon.os_cron_deps_created",
    message: "created real OS cron deps",
    meta: { platform: process.platform },
  })

  return {
    exec: runStructured,
    writeFileAtomic,
    readFile: (filePath: string) => fs.readFileSync(filePath, "utf8"),
    removeFile: (filePath: string) => {
      try {
        fs.unlinkSync(filePath)
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error
      }
    },
    existsFile: (filePath: string) => fs.existsSync(filePath),
    listDir: (dir: string) => {
      try {
        return fs.readdirSync(dir)
      } catch {
        return []
      }
    },
    mkdirp: (dir: string) => fs.mkdirSync(dir, { recursive: true }),
    homeDir: options.homeDir ?? os.homedir(),
    envPath: process.env.PATH ?? "",
    uid: options.uid ?? process.getuid?.() ?? 0,
  }
}

export interface RealCrontabDepsOptions {
  executable?: string
}

export function createRealCrontabDeps(options: RealCrontabDepsOptions = {}): CrontabCronDeps {
  emitNervesEvent({
    component: "daemon",
    event: "daemon.crontab_deps_created",
    message: "created real crontab deps",
    meta: {},
  })
  return {
    exec: runStructured,
    crontabPath: options.executable ?? "/usr/bin/crontab",
  }
}

/* v8 ignore start -- ouro path resolution: probes process.argv, filesystem layout, and PATH; branches depend on install method and runtime environment @preserve */
export function resolveOuroBinaryPath(): string {
  const scriptPath = process.argv[1]
  if (scriptPath) {
    const distDir = path.resolve(path.dirname(scriptPath))
    const packageBin = path.resolve(distDir, "..", "..", "..", "node_modules", ".bin", "ouro")
    if (fs.existsSync(packageBin)) return packageBin

    const repoOuro = path.resolve(distDir, "..", "..", "..", "scripts", "ouro.sh")
    if (fs.existsSync(repoOuro)) return repoOuro
  }

  try {
    const result = execSync("which ouro", { encoding: "utf-8" }).trim()
    if (result.length > 0) return result
  } catch {
    // Not on PATH.
  }

  emitNervesEvent({
    component: "daemon",
    event: "daemon.ouro_path_fallback",
    message: "could not resolve full ouro binary path, falling back to 'ouro'",
    meta: {},
  })
  return "ouro"
}
/* v8 ignore stop */
