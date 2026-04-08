import * as path from "path"
import type { SpawnSyncReturns } from "child_process"
import { emitNervesEvent } from "../../nerves/runtime"

export interface StagedRestartDeps {
  execSync: (command: string) => void
  spawnSync: (command: string, args: string[], options: Record<string, unknown>) => SpawnSyncReturns<Buffer>
  /** Install (and ideally activate) the requested version. Defaults to
   *  `npm install -g @ouro.bot/cli@{version}` for backward compatibility.
   *  Production callers (the daemon's update checker) inject a
   *  version-managed installer so the new code lands at a deterministic
   *  path that resolveNewCodePath can find. */
  installNewVersion?: (version: string) => void
  resolveNewCodePath: (version: string) => string | null
  gracefulShutdown: () => Promise<void>
  spawnNewDaemon: (entryPath: string, socketPath: string) => { pid: number | null }
  nodePath: string
  bundlesRoot: string
  socketPath?: string
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
    if (deps.installNewVersion) {
      deps.installNewVersion(version)
    } else {
      // Backward-compat fallback for callers that haven't migrated to the
      // version-managed installer. Tests use this path with a mocked
      // execSync; production callers inject installNewVersion.
      deps.execSync(`npm install -g @ouro.bot/cli@${version}`)
    }
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : /* v8 ignore next -- defensive: non-Error catch branch @preserve */ String(err)
    emitNervesEvent({
      component: "daemon",
      event: "daemon.staged_restart_install_failed",
      message: "install failed",
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

  // Step 4: Graceful shutdown then self-spawn new daemon
  // We can't rely on launchd KeepAlive — the plist may not be loaded.
  // Instead: shut down (releases socket), spawn new daemon from updated code.
  emitNervesEvent({
    component: "daemon",
    event: "daemon.staged_restart_hooks_passed",
    message: "hooks passed, shutting down and spawning new daemon",
    meta: { version },
  })

  let shutdownError: string | undefined
  try {
    await deps.gracefulShutdown()
  } catch (err) {
    shutdownError = err instanceof Error ? err.message : /* v8 ignore next -- defensive: non-Error catch branch @preserve */ String(err)
    emitNervesEvent({
      component: "daemon",
      event: "daemon.staged_restart_shutdown_error",
      message: "graceful shutdown encountered error (continuing with spawn)",
      meta: { version, error: shutdownError },
    })
  }

  // Spawn new daemon from updated code path
  const newEntry = path.join(newCodePath, "dist", "heart", "daemon", "daemon-entry.js")
  const socketArg = deps.socketPath ?? "/tmp/ouroboros-daemon.sock"

  try {
    const { pid } = deps.spawnNewDaemon(newEntry, socketArg)
    emitNervesEvent({
      component: "daemon",
      event: "daemon.staged_restart_spawned",
      message: "new daemon spawned successfully",
      meta: { version, pid, entry: newEntry },
    })
  } catch (err) {
    const spawnError = err instanceof Error ? err.message : /* v8 ignore next -- defensive: non-Error catch branch @preserve */ String(err)
    emitNervesEvent({
      component: "daemon",
      event: "daemon.staged_restart_respawn_failed",
      message: "failed to spawn new daemon after shutdown",
      meta: { version, error: spawnError, entry: newEntry },
    })
    return { ok: false, error: `shutdown succeeded but failed to spawn new daemon: ${spawnError}`, shutdownError }
  }

  return { ok: true, shutdownError }
}
