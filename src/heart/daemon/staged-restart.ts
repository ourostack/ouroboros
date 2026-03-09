import * as path from "path"
import type { SpawnSyncReturns } from "child_process"
import { emitNervesEvent } from "../../nerves/runtime"

export interface StagedRestartDeps {
  execSync: (command: string) => void
  spawnSync: (command: string, args: string[], options: Record<string, unknown>) => SpawnSyncReturns<Buffer>
  resolveNewCodePath: (version: string) => string | null
  gracefulShutdown: () => Promise<void>
  nodePath: string
  bundlesRoot: string
}

export interface StagedRestartResult {
  ok: boolean
  error?: string
  shutdownError?: string
}

export async function performStagedRestart(
  version: string,
  deps: StagedRestartDeps,
): Promise<StagedRestartResult> {
  emitNervesEvent({
    component: "daemon",
    event: "daemon.staged_restart_start",
    message: "starting staged restart",
    meta: { version },
  })

  // Step 1: Install new version
  try {
    deps.execSync(`npm install -g @ouro.bot/cli@${version}`)
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : /* v8 ignore next -- defensive: non-Error catch branch @preserve */ String(err)
    emitNervesEvent({
      component: "daemon",
      event: "daemon.staged_restart_install_failed",
      message: "npm install failed",
      meta: { version, error: errorMessage },
    })
    return { ok: false, error: errorMessage }
  }

  // Step 2: Resolve new code path
  const newCodePath = deps.resolveNewCodePath(version)
  if (!newCodePath) {
    emitNervesEvent({
      component: "daemon",
      event: "daemon.staged_restart_path_failed",
      message: "could not resolve new code path",
      meta: { version },
    })
    return { ok: false, error: "could not resolve new code path after install" }
  }

  // Step 3: Spawn hook runner on NEW code
  const hookRunnerPath = path.join(newCodePath, "dist", "heart", "daemon", "run-hooks.js")
  const spawnResult = deps.spawnSync(
    deps.nodePath,
    [hookRunnerPath, "--bundles-root", deps.bundlesRoot],
    { stdio: "inherit" },
  )

  if (spawnResult.error) {
    const errorMessage = spawnResult.error.message
    emitNervesEvent({
      component: "daemon",
      event: "daemon.staged_restart_spawn_failed",
      message: "hook runner spawn failed",
      meta: { version, error: errorMessage },
    })
    return { ok: false, error: errorMessage }
  }

  if (spawnResult.status !== 0) {
    emitNervesEvent({
      component: "daemon",
      event: "daemon.staged_restart_hooks_failed",
      message: "hook runner exited with non-zero status",
      meta: { version, exitCode: spawnResult.status },
    })
    return { ok: false, error: `hook runner exited with code ${spawnResult.status}` }
  }

  // Step 4: Graceful shutdown (launchd will restart with new code)
  emitNervesEvent({
    component: "daemon",
    event: "daemon.staged_restart_hooks_passed",
    message: "hooks passed, shutting down for restart",
    meta: { version },
  })

  try {
    await deps.gracefulShutdown()
  } catch (err) {
    const shutdownError = err instanceof Error ? err.message : /* v8 ignore next -- defensive: non-Error catch branch @preserve */ String(err)
    emitNervesEvent({
      component: "daemon",
      event: "daemon.staged_restart_shutdown_error",
      message: "graceful shutdown encountered error",
      meta: { version, error: shutdownError },
    })
    return { ok: true, shutdownError }
  }

  return { ok: true }
}
