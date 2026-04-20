import { emitNervesEvent } from "../../nerves/runtime"

export interface DaemonRuntimeSyncDeps {
  socketPath: string
  localVersion: string
  localLastUpdated?: string
  localRepoRoot?: string
  localConfigFingerprint?: string
  localManagedAgents?: string
  fetchRunningVersion: () => Promise<string>
  fetchRunningRuntimeMetadata?: () => Promise<{
    version?: string
    lastUpdated?: string
    repoRoot?: string
    configFingerprint?: string
    managedAgents?: string
  }>
  stopDaemon: () => Promise<void>
  cleanupStaleSocket: (socketPath: string) => void
  startDaemonProcess: (socketPath: string) => Promise<{ pid: number | null }>
  checkSocketAlive?: (socketPath: string) => Promise<boolean>
  onProgress?: (message: string) => void
  waitForDaemonStartup?: (options: { pid: number | null }) => Promise<{
    ok: boolean
    reason?: string
  }>
}

export interface DaemonRuntimeSyncResult {
  ok: boolean
  alreadyRunning: boolean
  message: string
  verifyStartupStatus?: boolean
  startedPid?: number | null
  startupFailureReason?: string | null
}

/* v8 ignore start -- daemon liveness poll: real socket timing untestable in vitest @preserve */
async function verifyDaemonStarted(deps: DaemonRuntimeSyncDeps): Promise<boolean> {
  if (!deps.checkSocketAlive) return true
  const maxWaitMs = 10_000
  const pollIntervalMs = 500
  const deadline = Date.now() + maxWaitMs
  deps.onProgress?.("waiting for the replacement background service to answer")
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
  managedAgents: string
}

interface RuntimeDriftReason {
  key: "version" | "lastUpdated" | "repoRoot" | "configFingerprint" | "managedAgents"
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
    managedAgents: typeof value.managedAgents === "string" ? value.managedAgents : "unknown",
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
  if (
    isKnownRuntimeValue(local.managedAgents)
    && isKnownRuntimeValue(running.managedAgents)
    && local.managedAgents !== running.managedAgents
  ) {
    reasons.push({
      key: "managedAgents",
      label: "managed agents",
      local: local.managedAgents,
      running: running.managedAgents,
    })
  }

  return reasons
}

function formatRuntimeDriftPublicSummary(
  reasons: RuntimeDriftReason[],
): string {
  return reasons.map((reason) => reason.label).join(", ")
}

export async function ensureCurrentDaemonRuntime(
  deps: DaemonRuntimeSyncDeps,
): Promise<DaemonRuntimeSyncResult> {
  deps.onProgress?.("checking whether an older background service is already running")
  const localRuntime = normalizeRuntimeIdentity({
    version: deps.localVersion,
    lastUpdated: deps.localLastUpdated,
    repoRoot: deps.localRepoRoot,
    configFingerprint: deps.localConfigFingerprint,
    managedAgents: deps.localManagedAgents,
  })

  try {
    const runningRuntime = await readRunningRuntimeIdentity(deps)
    const runningVersion = runningRuntime.version
    const driftReasons = collectRuntimeDriftReasons(localRuntime, runningRuntime)
    let result: DaemonRuntimeSyncResult

    if (driftReasons.length > 0) {
      const includesVersionDrift = driftReasons.some((entry) => entry.key === "version")
      const publicDriftSummary = formatRuntimeDriftPublicSummary(driftReasons)
      try {
        deps.onProgress?.("stopping the older background service")
        await deps.stopDaemon()
      } catch (error) {
        const reason = formatErrorReason(error)
        result = {
          ok: false,
          alreadyRunning: true,
          message: includesVersionDrift
            ? `daemon already running (${deps.socketPath}; could not replace the older background service ${runningVersion} -> ${deps.localVersion}: ${reason})`
            : `daemon already running (${deps.socketPath}; could not replace the older background service after runtime drift ${publicDriftSummary}: ${reason})`,
          startupFailureReason: includesVersionDrift
            ? "could not replace the older background service"
            : "could not replace the older background service after runtime drift",
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
            localManagedAgents: localRuntime.managedAgents,
            runningVersion,
            runningLastUpdated: runningRuntime.lastUpdated,
            runningRepoRoot: runningRuntime.repoRoot,
            runningConfigFingerprint: runningRuntime.configFingerprint,
            runningManagedAgents: runningRuntime.managedAgents,
            action: "stale_replace_failed",
            driftKeys: driftReasons.map((entry) => entry.key),
            reason,
          },
        })
        return result
      }

      deps.cleanupStaleSocket(deps.socketPath)
      deps.onProgress?.("starting the replacement background service")
      const started = await deps.startDaemonProcess(deps.socketPath)
      const pid = started.pid ?? "unknown"
      const startupCheck = deps.waitForDaemonStartup
        ? await deps.waitForDaemonStartup({ pid: started.pid ?? null })
        : { ok: await verifyDaemonStarted(deps) }
      const verified = startupCheck.ok
      /* v8 ignore next -- daemon liveness failure: requires real daemon crash timing @preserve */
      const suffix = verified
        ? ""
        : `\n${startupCheck.reason ?? "replacement background service did not answer in time"}; check logs with \`ouro logs\` or run \`ouro doctor\`.`
      result = {
        ok: verified,
        alreadyRunning: false,
        message: includesVersionDrift
          ? `replaced an older background service ${runningVersion} -> ${deps.localVersion} (pid ${pid})${suffix}`
          : `replaced an older background service after runtime drift: ${publicDriftSummary} (pid ${pid})${suffix}`,
        verifyStartupStatus: verified,
        startedPid: started.pid ?? null,
        startupFailureReason: verified ? null : (startupCheck.reason ?? "replacement background service did not answer in time"),
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
          localManagedAgents: localRuntime.managedAgents,
          runningVersion,
          runningLastUpdated: runningRuntime.lastUpdated,
          runningRepoRoot: runningRuntime.repoRoot,
          runningConfigFingerprint: runningRuntime.configFingerprint,
          runningManagedAgents: runningRuntime.managedAgents,
          action: "stale_restarted",
          driftKeys: driftReasons.map((entry) => entry.key),
          pid: started.pid ?? null,
        },
      })
      return result
    }

    if (!isKnownVersion(localRuntime.version) || !isKnownVersion(runningVersion)) {
      result = {
        ok: true,
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
          localManagedAgents: localRuntime.managedAgents,
          runningVersion,
          runningLastUpdated: runningRuntime.lastUpdated,
          runningRepoRoot: runningRuntime.repoRoot,
          runningConfigFingerprint: runningRuntime.configFingerprint,
          runningManagedAgents: runningRuntime.managedAgents,
          action: "unknown_version",
        },
      })
      return result
    }
  } catch (error) {
    const reason = formatErrorReason(error)
    const result = {
      ok: true,
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
        localManagedAgents: localRuntime.managedAgents,
        action: "status_lookup_failed",
        reason,
      },
    })
    return result
  }

  const result = {
    ok: true,
    alreadyRunning: true,
    message: `daemon already running (${deps.socketPath})`,
    verifyStartupStatus: true,
    startedPid: null,
    startupFailureReason: null,
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
      localManagedAgents: localRuntime.managedAgents,
      action: "already_current",
    },
  })
  return result
}
