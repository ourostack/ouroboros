import * as semver from "semver"
import { emitNervesEvent } from "../../nerves/runtime"

export interface UpdateCheckerDeps {
  fetchRegistryJson: () => Promise<unknown>
  distTag: string
}

export interface CheckForUpdateResult {
  available: boolean
  latestVersion?: string
  error?: string
}

export interface StartUpdateCheckerOptions {
  currentVersion: string
  intervalMs?: number
  onUpdate?: (result: CheckForUpdateResult) => void | Promise<void>
  deps: UpdateCheckerDeps
}

const DEFAULT_INTERVAL_MS = 30 * 60 * 1000 // 30 minutes
export const CLI_UPDATE_CHECK_TIMEOUT_MS = 3_000

export async function checkForUpdate(
  currentVersion: string,
  deps: UpdateCheckerDeps,
): Promise<CheckForUpdateResult> {
  emitNervesEvent({
    component: "daemon",
    event: "daemon.update_check",
    message: "checking for update",
    meta: { currentVersion, distTag: deps.distTag },
  })

  let registryData: Record<string, unknown>
  try {
    registryData = (await deps.fetchRegistryJson()) as Record<string, unknown>
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : /* v8 ignore next -- defensive: non-Error catch branch @preserve */ String(err)
    return { available: false, error: errorMessage }
  }

  const distTags = registryData?.["dist-tags"] as Record<string, string> | undefined
  if (!distTags) {
    return { available: false, error: "registry response missing dist-tags" }
  }

  const latestVersion = distTags[deps.distTag]
  if (!latestVersion) {
    return { available: false, error: `dist-tag "${deps.distTag}" not found in registry` }
  }

  const available = semver.gt(latestVersion, currentVersion)

  emitNervesEvent({
    component: "daemon",
    event: "daemon.update_check_result",
    message: available ? "update available" : "no update available",
    meta: { currentVersion, latestVersion, available },
  })

  return { available, latestVersion }
}

let _intervalId: ReturnType<typeof setInterval> | null = null

export function startUpdateChecker(options: StartUpdateCheckerOptions): void {
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS

  emitNervesEvent({
    component: "daemon",
    event: "daemon.update_checker_start",
    message: "starting update checker",
    meta: { intervalMs, currentVersion: options.currentVersion },
  })

  _intervalId = setInterval(() => {
    void (async () => {
      const result = await checkForUpdate(options.currentVersion, options.deps)
      if (result.available && options.onUpdate) {
        await options.onUpdate(result)
      }
    })().catch((err) => {
      emitNervesEvent({
        component: "daemon",
        event: "daemon.update_checker_error",
        level: "warn",
        message: "update checker tick failed",
        meta: { reason: err instanceof Error ? err.message : /* v8 ignore next -- defensive: non-Error catch branch @preserve */ String(err) },
      })
    })
  }, intervalMs)
}

export function stopUpdateChecker(): void {
  if (_intervalId) {
    clearInterval(_intervalId)
    _intervalId = null
  }
  // `_end` (not `_stop`) to satisfy the nerves audit's start/end pairing
  // rule — counterpart to `daemon.update_checker_start` above.
  emitNervesEvent({
    component: "daemon",
    event: "daemon.update_checker_end",
    message: "stopping update checker",
    meta: {},
  })
}
