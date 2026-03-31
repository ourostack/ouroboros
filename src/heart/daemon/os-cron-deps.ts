import { execSync } from "child_process"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { emitNervesEvent } from "../../nerves/runtime"
import type { OsCronDeps, CrontabCronDeps } from "./os-cron"

export function createRealOsCronDeps(): OsCronDeps {
  emitNervesEvent({
    component: "daemon",
    event: "daemon.os_cron_deps_created",
    message: "created real OS cron deps",
    meta: { platform: process.platform },
  })

  return {
    exec: (cmd: string) => {
      try {
        execSync(cmd, { stdio: "ignore" })
      } catch {
        /* best effort */
      }
    },
    writeFile: (p: string, c: string) => fs.writeFileSync(p, c, "utf-8"),
    removeFile: (p: string) => {
      try {
        fs.unlinkSync(p)
      } catch {
        /* best effort — file may already be gone */
      }
    },
    existsFile: (p: string) => fs.existsSync(p),
    listDir: (dir: string) => {
      try {
        return fs.readdirSync(dir)
      } catch {
        return []
      }
    },
    mkdirp: (dir: string) => fs.mkdirSync(dir, { recursive: true }),
    homeDir: os.homedir(),
  }
}

export function createRealCrontabDeps(): CrontabCronDeps {
  emitNervesEvent({
    component: "daemon",
    event: "daemon.crontab_deps_created",
    message: "created real crontab deps",
    meta: {},
  })

  /* v8 ignore start -- crontab exec closures: calling these in tests would modify the real system crontab @preserve */
  return {
    execOutput: (cmd: string) => execSync(cmd, { encoding: "utf-8" }),
    execWrite: (cmd: string, stdin: string) => {
      execSync(cmd, { input: stdin, stdio: ["pipe", "ignore", "ignore"] })
    },
  }
  /* v8 ignore stop */
}

/* v8 ignore start -- ouro path resolution: probes process.argv, filesystem layout, and PATH; branches depend on install method and runtime environment @preserve */
export function resolveOuroBinaryPath(): string {
  // Try to resolve from process.argv[1] — the script being run
  const scriptPath = process.argv[1]
  if (scriptPath) {
    // If running via node dist/heart/daemon/daemon-entry.js, resolve the ouro wrapper
    // The ouro binary is typically at the package root's bin
    const distDir = path.resolve(path.dirname(scriptPath))
    const packageBin = path.resolve(distDir, "..", "..", "..", "node_modules", ".bin", "ouro")
    if (fs.existsSync(packageBin)) {
      return packageBin
    }

    // Try the repo-local scripts/ouro.sh
    const repoOuro = path.resolve(distDir, "..", "..", "..", "scripts", "ouro.sh")
    if (fs.existsSync(repoOuro)) {
      return repoOuro
    }
  }

  // Try which ouro
  try {
    const result = execSync("which ouro", { encoding: "utf-8" }).trim()
    if (result.length > 0) return result
  } catch {
    /* not on PATH */
  }

  // Fallback: use "ouro" and rely on PATH
  emitNervesEvent({
    component: "daemon",
    event: "daemon.ouro_path_fallback",
    message: "could not resolve full ouro binary path, falling back to 'ouro'",
    meta: {},
  })
  return "ouro"
}
/* v8 ignore stop */
