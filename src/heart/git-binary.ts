import { spawnSync } from "child_process"
import * as fs from "fs"
import * as path from "path"
import { emitNervesEvent } from "../nerves/runtime"

/**
 * Which `git` the bundle sync runs. The `git` first on a daemon's PATH is not always one that can fetch: the Copilot
 * app bundles a relocatable git that finds its helpers only through the `GIT_EXEC_PATH` the app sets, so a daemon
 * (or a shim that execs the first non-shim `git`) without it computes `//libexec/git-core` and every fetch dies with
 * "git: 'remote-https' is not a git command". Sync probes `git --exec-path` once per environment and, when the PATH
 * git cannot serve the https/ssh helpers, uses the first candidate that can.
 */
const FALLBACK_GITS = ["/usr/bin/git", "/opt/homebrew/bin/git", "/usr/local/bin/git"]

const resolved = new Map<string, string>()

/** Forget probed results (tests). */
export function resetGitBinaryCache(): void {
  resolved.clear()
}

function execPathOf(binary: string, env: NodeJS.ProcessEnv): string | null {
  const run = spawnSync(binary, ["--exec-path"], { env, encoding: "utf-8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] })
  return run.status === 0 && run.stdout.trim() ? run.stdout.trim() : null
}

/** A git can serve the network when its exec path holds the transport helpers. */
function healthy(binary: string, env: NodeJS.ProcessEnv, exists: (p: string) => boolean): boolean {
  const execPath = execPathOf(binary, env)
  return execPath !== null && exists(path.join(execPath, "git-remote-https"))
}

function candidates(env: NodeJS.ProcessEnv): string[] {
  const onPath = (env.PATH ?? "").split(path.delimiter).filter(Boolean).map((dir) => path.join(dir, "git"))
  return [...new Set(["git", ...onPath, ...FALLBACK_GITS])]
}

/**
 * The environment git runs under. A `GIT_EXEC_PATH` that points at a deleted cache is dropped so git's own
 * (when it has one) applies.
 */
export function gitRuntimeEnv(env: NodeJS.ProcessEnv, exists: (p: string) => boolean = fs.existsSync): NodeJS.ProcessEnv {
  const kept = { ...env }
  const execPath = kept.GIT_EXEC_PATH
  if (execPath !== undefined && !exists(path.join(execPath, "git-remote-https"))) {
    delete kept.GIT_EXEC_PATH
    emitNervesEvent({
      level: "warn",
      component: "heart",
      event: "heart.git_exec_path_dropped",
      message: "git: ignored a GIT_EXEC_PATH that holds no transport helpers",
      meta: { execPath },
    })
  }
  for (const name of ["GIT_TEMPLATE_DIR", "GIT_CONFIG_SYSTEM"] as const) {
    const value = kept[name]
    if (value !== undefined && value !== "" && !exists(value)) delete kept[name]
  }
  return kept
}

/** The git executable that can reach a remote under `env`; `git` itself when none can (the failure then names the cause). */
export function resolveGitBinary(env: NodeJS.ProcessEnv, exists: (p: string) => boolean = fs.existsSync): string {
  const key = `${env.PATH ?? ""}\0${env.GIT_EXEC_PATH ?? ""}`
  const cached = resolved.get(key)
  if (cached !== undefined) return cached
  let chosen = "git"
  for (const candidate of candidates(env)) {
    if (healthy(candidate, env, exists)) {
      chosen = candidate
      break
    }
  }
  resolved.set(key, chosen)
  emitNervesEvent({
    level: chosen === "git" ? "info" : "warn",
    component: "heart",
    event: "heart.git_binary_resolved",
    message: chosen === "git" ? "git: the git on PATH can reach remotes" : "git: the git on PATH cannot reach remotes; using another",
    meta: { chosen },
  })
  return chosen
}
