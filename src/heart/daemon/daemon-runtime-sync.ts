import { emitNervesEvent } from "../../nerves/runtime"

export interface DaemonRuntimeSyncDeps {
  socketPath: string
  localVersion: string
  localLastUpdated?: string
  localRepoRoot?: string
  localConfigFingerprint?: string
  fetchRunningVersion: () => Promise<string>
  fetchRunningRuntimeMetadata?: () => Promise<{
    version?: string
    lastUpdated?: string
    repoRoot?: string
    configFingerprint?: string
  }>
  stopDaemon: () => Promise<void>
  cleanupStaleSocket: (socketPath: string) => void
  startDaemonProcess: (socketPath: string) => Promise<{ pid: number | null }>
  checkSocketAlive?: (socketPath: string) => Promise<boolean>
}

export interface DaemonRuntimeSyncResult {
  alreadyRunning: boolean
  message: string
}

/* v8 ignore start -- daemon liveness poll: real socket timing untestable in vitest @preserve */
async function verifyDaemonStarted(deps: DaemonRuntimeSyncDeps): Promise<boolean> {
  if (!deps.checkSocketAlive) return true
  const maxWaitMs = 10_000
  const pollIntervalMs = 500
  const deadline = Date.now() + maxWaitMs
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, pollIntervalMs))
    if (await deps.checkSocketAlive(deps.socketPath)) return true
  }
  return false
}
/* v8 ignore stop */

function isKnownVersion(version: string): boolean {
  return version !== "unknown" && version.trim().length > 0
}

function isKnownRuntimeValue(value: string | undefined): value is string {
  return typeof value === "string" && value.trim().length > 0 && value !== "unknown"
}

function formatErrorReason(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

interface RuntimeIdentity {
  version: string
  lastUpdated: string
  repoRoot: string
  configFingerprint: string
}

interface RuntimeDriftReason {
  key: "version" | "lastUpdated" | "repoRoot" | "configFingerprint"
  label: string
  local: string
  running: string
}

function normalizeRuntimeIdentity(
  value: Partial<RuntimeIdentity>,
): RuntimeIdentity {
  return {
    version: typeof value.version === "string" ? value.version : "unknown",
    lastUpdated: typeof value.lastUpdated === "string" ? value.lastUpdated : "unknown",
    repoRoot: typeof value.repoRoot === "string" ? value.repoRoot : "unknown",
    configFingerprint: typeof value.configFingerprint === "string" ? value.configFingerprint : "unknown",
  }
}

async function readRunningRuntimeIdentity(
  deps: DaemonRuntimeSyncDeps,
): Promise<RuntimeIdentity> {
  if (!deps.fetchRunningRuntimeMetadata) {
    return normalizeRuntimeIdentity({
      version: await deps.fetchRunningVersion(),
    })
  }

  const metadata = normalizeRuntimeIdentity(await deps.fetchRunningRuntimeMetadata())
  if (isKnownVersion(metadata.version)) return metadata
  return normalizeRuntimeIdentity({
    ...metadata,
    version: await deps.fetchRunningVersion(),
  })
}

function collectRuntimeDriftReasons(
  local: RuntimeIdentity,
  running: RuntimeIdentity,
): RuntimeDriftReason[] {
  const reasons: RuntimeDriftReason[] = []
  const comparableVersions = isKnownVersion(local.version) && isKnownVersion(running.version)

  if (comparableVersions && local.version !== running.version) {
    reasons.push({ key: "version", label: "version", local: local.version, running: running.version })
  }
  if (comparableVersions && isKnownRuntimeValue(local.lastUpdated) && isKnownRuntimeValue(running.lastUpdated) && local.lastUpdated !== running.lastUpdated) {
    reasons.push({ key: "lastUpdated", label: "last updated", local: local.lastUpdated, running: running.lastUpdated })
  }
  if (isKnownRuntimeValue(local.repoRoot) && isKnownRuntimeValue(running.repoRoot) && local.repoRoot !== running.repoRoot) {
    reasons.push({ key: "repoRoot", label: "code path", local: local.repoRoot, running: running.repoRoot })
  }
  if (
    isKnownRuntimeValue(local.configFingerprint)
    && isKnownRuntimeValue(running.configFingerprint)
    && local.configFingerprint !== running.configFingerprint
  ) {
    reasons.push({
      key: "configFingerprint",
      label: "config fingerprint",
      local: local.configFingerprint,
      running: running.configFingerprint,
    })
  }

  return reasons
}

function formatRuntimeValue(reason: RuntimeDriftReason): string {
  if (reason.key === "configFingerprint") {
    return `${reason.running.slice(0, 12)} -> ${reason.local.slice(0, 12)}`
  }
  return `${reason.running} -> ${reason.local}`
}

function formatRuntimeDriftSummary(
  reasons: RuntimeDriftReason[],
): string {
  return reasons.map((reason) => `${reason.label} ${formatRuntimeValue(reason)}`).join("; ")
}

export async function ensureCurrentDaemonRuntime(
  deps: DaemonRuntimeSyncDeps,
): Promise<DaemonRuntimeSyncResult> {
  const localRuntime = normalizeRuntimeIdentity({
    version: deps.localVersion,
    lastUpdated: deps.localLastUpdated,
    repoRoot: deps.localRepoRoot,
    configFingerprint: deps.localConfigFingerprint,
  })

  try {
    const runningRuntime = await readRunningRuntimeIdentity(deps)
    const runningVersion = runningRuntime.version
    const driftReasons = collectRuntimeDriftReasons(localRuntime, runningRuntime)
    let result: DaemonRuntimeSyncResult

    if (driftReasons.length > 0) {
      const includesVersionDrift = driftReasons.some((entry) => entry.key === "version")
      const driftSummary = formatRuntimeDriftSummary(driftReasons)
      try {
        await deps.stopDaemon()
      } catch (error) {
        const reason = formatErrorReason(error)
        result = {
          alreadyRunning: true,
          message: includesVersionDrift
            ? `daemon already running (${deps.socketPath}; could not replace stale daemon ${runningVersion} -> ${deps.localVersion}: ${reason})`
            : `daemon already running (${deps.socketPath}; could not replace drifted daemon ${driftSummary}: ${reason})`,
        }
        emitNervesEvent({
          level: "warn",
          component: "daemon",
          event: "daemon.runtime_sync_decision",
          message: "evaluated daemon runtime sync outcome",
          meta: {
            socketPath: deps.socketPath,
            localVersion: deps.localVersion,
            localLastUpdated: localRuntime.lastUpdated,
            localRepoRoot: localRuntime.repoRoot,
            localConfigFingerprint: localRuntime.configFingerprint,
            runningVersion,
            runningLastUpdated: runningRuntime.lastUpdated,
            runningRepoRoot: runningRuntime.repoRoot,
            runningConfigFingerprint: runningRuntime.configFingerprint,
            action: "stale_replace_failed",
            driftKeys: driftReasons.map((entry) => entry.key),
            reason,
          },
        })
        return result
      }

      deps.cleanupStaleSocket(deps.socketPath)
      const started = await deps.startDaemonProcess(deps.socketPath)
      const pid = started.pid ?? "unknown"
      const verified = await verifyDaemonStarted(deps)
      /* v8 ignore next -- daemon liveness failure: requires real daemon crash timing @preserve */
      const suffix = verified ? "" : " — but daemon failed to respond, check logs"
      result = {
        alreadyRunning: false,
        message: includesVersionDrift
          ? `restarted stale daemon from ${runningVersion} to ${deps.localVersion} (pid ${pid})${suffix}`
          : `restarted drifted daemon (${driftSummary}) (pid ${pid})${suffix}`,
      }
      emitNervesEvent({
        component: "daemon",
        event: "daemon.runtime_sync_decision",
        message: "evaluated daemon runtime sync outcome",
        meta: {
          socketPath: deps.socketPath,
          localVersion: deps.localVersion,
          localLastUpdated: localRuntime.lastUpdated,
          localRepoRoot: localRuntime.repoRoot,
          localConfigFingerprint: localRuntime.configFingerprint,
          runningVersion,
          runningLastUpdated: runningRuntime.lastUpdated,
          runningRepoRoot: runningRuntime.repoRoot,
          runningConfigFingerprint: runningRuntime.configFingerprint,
          action: "stale_restarted",
          driftKeys: driftReasons.map((entry) => entry.key),
          pid: started.pid ?? null,
        },
      })
      return result
    }

    if (!isKnownVersion(localRuntime.version) || !isKnownVersion(runningVersion)) {
      result = {
        alreadyRunning: true,
        message: `daemon already running (${deps.socketPath}; unable to verify version)`,
      }
      emitNervesEvent({
        component: "daemon",
        event: "daemon.runtime_sync_decision",
        message: "evaluated daemon runtime sync outcome",
        meta: {
          socketPath: deps.socketPath,
          localVersion: deps.localVersion,
          localLastUpdated: localRuntime.lastUpdated,
          localRepoRoot: localRuntime.repoRoot,
          localConfigFingerprint: localRuntime.configFingerprint,
          runningVersion,
          runningLastUpdated: runningRuntime.lastUpdated,
          runningRepoRoot: runningRuntime.repoRoot,
          runningConfigFingerprint: runningRuntime.configFingerprint,
          action: "unknown_version",
        },
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
      meta: {
        socketPath: deps.socketPath,
        localVersion: deps.localVersion,
        localLastUpdated: localRuntime.lastUpdated,
        localRepoRoot: localRuntime.repoRoot,
        localConfigFingerprint: localRuntime.configFingerprint,
        action: "status_lookup_failed",
        reason,
      },
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
    meta: {
      socketPath: deps.socketPath,
      localVersion: deps.localVersion,
      localLastUpdated: localRuntime.lastUpdated,
      localRepoRoot: localRuntime.repoRoot,
      localConfigFingerprint: localRuntime.configFingerprint,
      action: "already_current",
    },
  })
  return result
}
