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

    if (
      isKnownVersion(deps.localVersion) &&
      isKnownVersion(runningVersion) &&
      runningVersion !== deps.localVersion
    ) {
      try {
        await deps.stopDaemon()
      } catch (error) {
        const reason = formatErrorReason(error)
        return {
          alreadyRunning: true,
          message: `daemon already running (${deps.socketPath}; could not replace stale daemon ${runningVersion} -> ${deps.localVersion}: ${reason})`,
        }
      }

      deps.cleanupStaleSocket(deps.socketPath)
      const started = await deps.startDaemonProcess(deps.socketPath)
      return {
        alreadyRunning: false,
        message: `restarted stale daemon from ${runningVersion} to ${deps.localVersion} (pid ${started.pid ?? "unknown"})`,
      }
    }

    if (!isKnownVersion(deps.localVersion) || !isKnownVersion(runningVersion)) {
      return {
        alreadyRunning: true,
        message: `daemon already running (${deps.socketPath}; unable to verify version)`,
      }
    }
  } catch (error) {
    const reason = formatErrorReason(error)
    return {
      alreadyRunning: true,
      message: `daemon already running (${deps.socketPath}; unable to verify version: ${reason})`,
    }
  }

  return {
    alreadyRunning: true,
    message: `daemon already running (${deps.socketPath})`,
  }
}
