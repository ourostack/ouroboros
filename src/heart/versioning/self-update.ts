import { emitNervesEvent } from "../../nerves/runtime"
import { compareCliVersions } from "./ouro-version-manager"
import type { ReleaseLookup, ReleaseSourceName } from "./release-sources"
import type { SelfUpdateOutcome, SelfUpdateState } from "./update-state"
import type { VersionIntent } from "./version-intent"

/**
 * One unattended update pass. It never starts a stopped daemon, never leaves
 * the machine on a version that failed its checks, and always records what
 * happened in update-state.json so `ouro status` can report it.
 *
 * Steps:
 *  1. Honor a human pin (`ouro rollback`) for PIN_MAX_AGE_MS, then expire it
 *     by rewriting the intent to "latest". A pin without a timestamp gets
 *     one the first time a pass sees it.
 *  2. Ask every release source for the newest version. When nothing is newer
 *     but a running daemon still reports an older version (a pass was killed
 *     between activation and restart), restart it on CurrentVersion.
 *  3. Install it, validate the payload and run its `--version` smoke test.
 *  4. Activate it. If the daemon was running, restart it on the new version
 *     and check that it answers; otherwise leave the daemon stopped.
 *  5. On a failed check, reactivate the previous version, pin it with reason
 *     "auto-rollback", restart the daemon on it, and never retry the failed
 *     version.
 */
export const PIN_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000

export interface SelfUpdateDeps {
  now: () => number
  getCurrentVersion: () => string | null
  readIntent: () => VersionIntent | null
  writeIntent: (intent: VersionIntent) => void
  readState: () => SelfUpdateState | null
  writeState: (state: SelfUpdateState) => void
  lookupLatest: () => Promise<ReleaseLookup>
  install: (version: string, lookup: ReleaseLookup) => Promise<ReleaseSourceName>
  validate: (version: string) => { ok: boolean; message?: string }
  smokeTest: (version: string) => Promise<{ ok: boolean; detail?: string }>
  activate: (version: string) => void
  isDaemonRunning: () => Promise<boolean>
  /** The version a running daemon reports, or null when none answers. */
  runningDaemonVersion: () => Promise<string | null>
  /** Restart a running daemon on the active version and confirm it answers with that version. */
  restartDaemon: (expectedVersion: string) => Promise<{ ok: boolean; detail?: string }>
  /** True while `ouro dev` owns the daemon; the updater must not replace a dev daemon. */
  isDevMode: () => boolean
  acquireLock: () => (() => void) | null
}

export interface SelfUpdateResult {
  outcome: SelfUpdateOutcome | "busy"
  summary: string
  state?: SelfUpdateState
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

const FAILURE_OUTCOMES: SelfUpdateOutcome[] = ["unreachable", "install-failed", "rejected", "rolled-back"]

export async function runSelfUpdate(deps: SelfUpdateDeps): Promise<SelfUpdateResult> {
  const release = deps.acquireLock()
  if (!release) {
    return { outcome: "busy", summary: "another ouro self-update is already running" }
  }
  try {
    return await runLocked(deps)
  } finally {
    release()
  }
}

async function runLocked(deps: SelfUpdateDeps): Promise<SelfUpdateResult> {
  const now = deps.now()
  const previous = deps.readState()
  const failedVersions = [...(previous?.failedVersions ?? [])]
  const currentVersion = deps.getCurrentVersion()

  const finish = (outcome: SelfUpdateOutcome, fields: Partial<SelfUpdateState> & { summary: string }): SelfUpdateResult => {
    const { summary, ...rest } = fields
    const state: SelfUpdateState = {
      schemaVersion: 1,
      lastRunAt: new Date(now).toISOString(),
      outcome,
      currentVersion: deps.getCurrentVersion(),
      failedVersions,
      consecutiveFailures: FAILURE_OUTCOMES.includes(outcome) ? (previous?.consecutiveFailures ?? 0) + 1 : 0,
      ...rest,
      detail: rest.detail ?? summary,
    }
    deps.writeState(state)
    emitNervesEvent({
      level: FAILURE_OUTCOMES.includes(outcome) ? "warn" : "info",
      component: "daemon",
      event: "daemon.self_update_result",
      message: summary,
      meta: { outcome, currentVersion: state.currentVersion, latestVersion: state.latestVersion ?? null },
    })
    return { outcome, summary, state }
  }

  /**
   * Restart the daemon on `target`. On a failed health check, never retry
   * `target`, pin and reactivate `fallback`, and restart on it. Returns the
   * rolled-back result, or null when `target` came up healthy.
   */
  const restartOrRollBack = async (target: string, fallback: string | null, source?: ReleaseSourceName): Promise<SelfUpdateResult | null> => {
    const health = await deps.restartDaemon(target)
    if (health.ok) return null
    failedVersions.push(target)
    if (!fallback) {
      return finish("rolled-back", {
        summary: `${target} did not come up healthy (${health.detail ?? "no detail"}) and there is no previous version to return to`,
        latestVersion: target,
        source,
      })
    }
    deps.writeIntent({
      schemaVersion: 1,
      mode: "pinned",
      targetVersion: fallback,
      pinnedAt: new Date(now).toISOString(),
      reason: "auto-rollback",
    })
    deps.activate(fallback)
    const restored = await deps.restartDaemon(fallback)
    return finish("rolled-back", {
      summary: `${target} did not come up healthy (${health.detail ?? "no detail"}); rolled back to ${fallback}${restored.ok ? "" : ` but the daemon did not answer on it either (${restored.detail ?? "no detail"})`}`,
      latestVersion: target,
      source,
    })
  }

  // 1. Pins.
  const intent = deps.readIntent()
  if (intent?.mode === "pinned" && intent.reason !== "auto-rollback") {
    let pinnedAt = intent.pinnedAt
    if (!pinnedAt || Number.isNaN(Date.parse(pinnedAt))) {
      // A pin written before pins carried a timestamp: start its clock now and
      // record it in the intent itself, so the pin cannot outlive its expiry.
      pinnedAt = new Date(now).toISOString()
      deps.writeIntent({ ...intent, pinnedAt })
    }
    const expiresAtMs = Date.parse(pinnedAt) + PIN_MAX_AGE_MS
    if (now < expiresAtMs) {
      const until = new Date(expiresAtMs).toISOString()
      return finish("pinned", {
        summary: `pinned to ${intent.targetVersion} by ouro rollback; unattended updates resume after ${until} (run \`ouro up --latest\` to resume now)`,
        detail: `pin honored until ${until}`,
      })
    }
    emitNervesEvent({
      level: "warn",
      component: "daemon",
      event: "daemon.self_update_pin_expired",
      message: "a rollback pin older than the maximum age no longer blocks updates",
      meta: { targetVersion: intent.targetVersion, pinnedAt },
    })
    deps.writeIntent({ schemaVersion: 1, mode: "latest", targetVersion: intent.targetVersion })
  }

  // 2. Lookup.
  const lookup = await deps.lookupLatest()
  const sourceSummary = lookup.answers.map((answer) => `${answer.source}: ${answer.version ?? answer.error}`).join("; ")
  const latest = lookup.latestVersion
  if (!latest) {
    return finish("unreachable", { summary: `no release source answered (${sourceSummary})` })
  }
  const lookupSource = lookup.answers.find((answer) => answer.version === latest)?.source
  if (currentVersion && compareCliVersions(latest, currentVersion) <= 0) {
    // A pass killed between activation and restart leaves the old daemon
    // running; finish the job instead of reporting "current" forever.
    const daemonVersion = deps.isDevMode() ? null : await deps.runningDaemonVersion()
    if (daemonVersion && daemonVersion !== currentVersion) {
      const restart = await restartOrRollBack(currentVersion, daemonVersion)
      if (restart) return restart
      return finish("updated", {
        summary: `daemon was still running ${daemonVersion}; restarted it on ${currentVersion} and it is healthy`,
        latestVersion: latest,
        source: lookupSource,
      })
    }
    const failedSources = lookup.answers.filter((answer) => !answer.version).map((answer) => `${answer.source}: ${answer.error}`)
    return finish("current", {
      summary: `current at ${currentVersion}${failedSources.length ? ` (unreachable: ${failedSources.join("; ")})` : ""}`,
      latestVersion: latest,
      source: lookupSource,
    })
  }
  if (failedVersions.includes(latest)) {
    return finish("rejected", {
      summary: `latest ${latest} failed its checks on this machine earlier; staying on ${currentVersion} until a newer release ships`,
      latestVersion: latest,
    })
  }

  // 3. Install, validate, smoke test.
  let installSource: ReleaseSourceName
  try {
    installSource = await deps.install(latest, lookup)
  } catch (error) {
    return finish("install-failed", { summary: errorText(error), latestVersion: latest })
  }
  const validation = deps.validate(latest)
  const smoke = validation.ok ? await deps.smokeTest(latest) : { ok: false, detail: validation.message }
  if (!smoke.ok) {
    failedVersions.push(latest)
    return finish("rejected", {
      summary: `${latest} failed its pre-activation check: ${smoke.detail ?? "no detail"}; staying on ${currentVersion}`,
      latestVersion: latest,
      source: installSource,
    })
  }

  // 4. Activate, then restart a running daemon on the new version.
  const daemonWasRunning = !deps.isDevMode() && await deps.isDaemonRunning()
  deps.writeIntent({ schemaVersion: 1, mode: "latest", targetVersion: latest })
  deps.activate(latest)
  if (daemonWasRunning) {
    const restart = await restartOrRollBack(latest, currentVersion, installSource)
    if (restart) return restart
  }
  return finish("updated", {
    summary: `updated ${currentVersion ?? "unknown"} -> ${latest} via ${installSource}${daemonWasRunning ? "; daemon restarted and healthy" : "; daemon was not running and was left stopped"}`,
    latestVersion: latest,
    source: installSource,
  })
}
