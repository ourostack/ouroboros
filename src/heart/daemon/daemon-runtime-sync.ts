import { emitNervesEvent } from "../../nerves/runtime"

export interface DaemonRuntimeSyncDeps {
  socketPath: string
  localVersion: string
  fetchRunningVersion: () => Promise<string>
  stopDaemon: () => Promise<void>
  cleanupStaleSocket: (socketPath: string) => void
  startDaemonProcess: (socketPath: string) => Promise<{ pid: number | null }>
}

export interface DaemonRuntimeSyncResult {
  alreadyRunning: boolean
  message: string
}

function isKnownVersion(version: string): boolean {
  return version !== "unknown" && version.trim().length > 0
}

function formatErrorReason(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export async function ensureCurrentDaemonRuntime(
  deps: DaemonRuntimeSyncDeps,
): Promise<DaemonRuntimeSyncResult> {
  try {
    const runningVersion = await deps.fetchRunningVersion()
    let result: DaemonRuntimeSyncResult

    if (
      isKnownVersion(deps.localVersion) &&
      isKnownVersion(runningVersion) &&
      runningVersion !== deps.localVersion
    ) {
      try {
        await deps.stopDaemon()
      } catch (error) {
        const reason = formatErrorReason(error)
        result = {
          alreadyRunning: true,
          message: `daemon already running (${deps.socketPath}; could not replace stale daemon ${runningVersion} -> ${deps.localVersion}: ${reason})`,
        }
        emitNervesEvent({
          level: "warn",
          component: "daemon",
          event: "daemon.runtime_sync_decision",
          message: "evaluated daemon runtime sync outcome",
          meta: { socketPath: deps.socketPath, localVersion: deps.localVersion, runningVersion, action: "stale_replace_failed", reason },
        })
        return result
      }

      deps.cleanupStaleSocket(deps.socketPath)
      const started = await deps.startDaemonProcess(deps.socketPath)
      result = {
        alreadyRunning: false,
        message: `restarted stale daemon from ${runningVersion} to ${deps.localVersion} (pid ${started.pid ?? "unknown"})`,
      }
      emitNervesEvent({
        component: "daemon",
        event: "daemon.runtime_sync_decision",
        message: "evaluated daemon runtime sync outcome",
        meta: { socketPath: deps.socketPath, localVersion: deps.localVersion, runningVersion, action: "stale_restarted", pid: started.pid ?? null },
      })
      return result
    }

    if (!isKnownVersion(deps.localVersion) || !isKnownVersion(runningVersion)) {
      result = {
        alreadyRunning: true,
        message: `daemon already running (${deps.socketPath}; unable to verify version)`,
      }
      emitNervesEvent({
        component: "daemon",
        event: "daemon.runtime_sync_decision",
        message: "evaluated daemon runtime sync outcome",
        meta: { socketPath: deps.socketPath, localVersion: deps.localVersion, runningVersion, action: "unknown_version" },
      })
      return result
    }
  } catch (error) {
    const reason = formatErrorReason(error)
    const result = {
      alreadyRunning: true,
      message: `daemon already running (${deps.socketPath}; unable to verify version: ${reason})`,
    }
    emitNervesEvent({
      level: "warn",
      component: "daemon",
      event: "daemon.runtime_sync_decision",
      message: "evaluated daemon runtime sync outcome",
      meta: { socketPath: deps.socketPath, localVersion: deps.localVersion, action: "status_lookup_failed", reason },
    })
    return result
  }

  const result = {
    alreadyRunning: true,
    message: `daemon already running (${deps.socketPath})`,
  }
  emitNervesEvent({
    component: "daemon",
    event: "daemon.runtime_sync_decision",
    message: "evaluated daemon runtime sync outcome",
    meta: { socketPath: deps.socketPath, localVersion: deps.localVersion, action: "already_current" },
  })
  return result
}
