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

export async function checkForUpdate(
  _currentVersion: string,
  _deps: UpdateCheckerDeps,
): Promise<CheckForUpdateResult> {
  emitNervesEvent({
    component: "daemon",
    event: "daemon.update_check",
    message: "checking for update",
    meta: {},
  })
  throw new Error("not implemented")
}

let _intervalId: ReturnType<typeof setInterval> | null = null

export function startUpdateChecker(
  _options: StartUpdateCheckerOptions,
): void {
  emitNervesEvent({
    component: "daemon",
    event: "daemon.update_checker_start",
    message: "starting update checker",
    meta: {},
  })
  throw new Error("not implemented")
}

export function stopUpdateChecker(): void {
  if (_intervalId) {
    clearInterval(_intervalId)
    _intervalId = null
  }
  emitNervesEvent({
    component: "daemon",
    event: "daemon.update_checker_stop",
    message: "stopping update checker",
    meta: {},
  })
}
