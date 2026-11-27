import { emitNervesEvent } from "../../nerves/runtime"
import { cliVersionAtLeast, compareCliVersions } from "./ouro-version-manager"
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
 *  3. Unless the disk is too full for another version, install it, validate the
 *     payload and run its `--version` smoke test.
 *  4. Activate it. If the daemon was running, restart it on the new version
 *     and check that it answers; otherwise leave the daemon stopped.
 *  5. On a failed check, reactivate the previous version, pin it with reason
 *     "auto-rollback", and never retry the failed version. Restart the daemon
 *     on the previous version only when the failed one is what runs (or
 *     nothing answers): a rollback never stops a daemon that answers on
 *     another version, and a daemon answering on a newer release than the
 *     target is a success, not a failure (2026-11-27).
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
  /**
   * Restart a running daemon on the active version and judge it by health: it passes when it comes up healthy on
   * that version or a newer one. `runningVersion` is what it answered with, when it answered.
   */
  restartDaemon: (expectedVersion: string) => Promise<{ ok: boolean; detail?: string; runningVersion?: string | null }>
  /**
   * True when a runtime replacement booted the daemon's launchd label out and
   * died before loading the new plist, so nothing will start the daemon again.
   * A label someone booted out on purpose does not count.
   */
  isDaemonReplacementStranded?: () => boolean
  /** True while `ouro dev` owns the daemon; the updater must not replace a dev daemon. */
  isDevMode: () => boolean
  acquireLock: () => (() => void) | null
  /**
   * Free disk where versions are installed and roughly what one more version needs, or null when unknown. A pass
   * that would fill the disk stops before installing; on a small device a half-written install can leave no room
   * for anything else.
   */
  diskSpace?: () => { freeBytes: number; neededBytes: number } | null
  /**
   * Frees disk by removing installed versions other than the current and previous ones. Called when an install would
   * not fit, before giving up: otherwise old versions on a small disk would stop every later update for good.
   */
  reclaimDisk?: () => void
  /**
   * Memory this machine has available and the floor below which an install
   * must not start, or null when unknown or not limited. An install peaks at
   * a few hundred MB; on a 1 GB device starting one too low starves the rest.
   */
  memory?: () => { availableBytes: number; floorBytes: number } | null
  /** Waits between memory checks before a restart; defaults to a timer. */
  sleep?: (ms: number) => Promise<void>
}

/**
 * Restarting the daemon briefly runs `ouro up` beside this pass and the daemon
 * it replaces, so a restart needs this much above the memory floor to keep the
 * floor while it runs.
 */
export const RESTART_MEMORY_HEADROOM_BYTES = 128 * 1024 * 1024
const RESTART_MEMORY_WAIT_MS = 180_000
const RESTART_MEMORY_POLL_MS = 10_000

export interface SelfUpdateResult {
  outcome: SelfUpdateOutcome | "busy"
  summary: string
  state?: SelfUpdateState
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** npm lists a version before it serves its tarball: ETARGET, or a 404 on that tarball's URL. */
export function isTarballNotServedYet(text: string): boolean {
  return /\bETARGET\b/.test(text) || (/\bE404\b/.test(text) && /\.tgz\b/.test(text))
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
   * `target` and pin and reactivate `fallback`; restart on it only when the
   * daemon runs `target` or does not answer. Returns the rolled-back result,
   * or the version the daemon is healthy on.
   */
  const restartOrRollBack = async (target: string, fallback: string | null, source?: ReleaseSourceName): Promise<SelfUpdateResult | { healthyOn: string }> => {
    const health = await deps.restartDaemon(target)
    if (health.ok) return { healthyOn: health.runningVersion ?? target }
    const why = health.detail ?? "no detail"
    const answering = await deps.runningDaemonVersion()
    if (answering && answering !== target && cliVersionAtLeast(answering, target)) {
      // A newer release came up while this pass waited on its own: the machine is ahead of the target, not broken.
      emitNervesEvent({
        level: "warn",
        component: "daemon",
        event: "daemon.self_update_newer_release_running",
        message: "the daemon came up on a newer release than the one this pass installed; counting it as healthy",
        meta: { target, running: answering, detail: why },
      })
      return { healthyOn: answering }
    }
    failedVersions.push(target)
    if (!fallback) {
      return finish("rolled-back", {
        summary: `${target} did not come up healthy (${why}) and there is no previous version to return to`,
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
    if (answering && answering !== target) {
      // The failed release is not what runs, so stopping the daemon would only take a healthy one down.
      return finish("rolled-back", {
        summary: `${target} did not come up healthy (${why}); rolled back to ${fallback} and left the daemon running on ${answering}`,
        latestVersion: target,
        source,
      })
    }
    const restored = await deps.restartDaemon(fallback)
    return finish("rolled-back", {
      summary: `${target} did not come up healthy (${why}); rolled back to ${fallback}${restored.ok ? "" : ` but the daemon did not answer on it either (${restored.detail ?? "no detail"})`}`,
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
    // A daemon ahead of CurrentVersion was updated by someone else and stays, unless it runs a release that failed here.
    const daemonNeedsRestart = daemonVersion !== null && daemonVersion !== currentVersion
      && (!cliVersionAtLeast(daemonVersion, currentVersion) || failedVersions.includes(daemonVersion))
    if (daemonVersion && daemonNeedsRestart) {
      const restart = await restartOrRollBack(currentVersion, failedVersions.includes(daemonVersion) ? null : daemonVersion)
      if (!("healthyOn" in restart)) return restart
      return finish("updated", {
        summary: `daemon was still running ${daemonVersion}; restarted it on ${currentVersion} and it is healthy`,
        latestVersion: latest,
        source: lookupSource,
      })
    }
    const failedSources = lookup.answers.filter((answer) => !answer.version).map((answer) => `${answer.source}: ${answer.error}`)
    let summary = `current at ${currentVersion}${failedSources.length ? ` (unreachable: ${failedSources.join("; ")})` : ""}`
    // 2026-11-16: an interrupted replacement left the daemon's job unloaded and
    // every pass reported "current" for six days while nothing ran.
    if (!daemonVersion && !deps.isDevMode() && deps.isDaemonReplacementStranded?.()) {
      const restart = await deps.restartDaemon(currentVersion)
      emitNervesEvent({
        level: restart.ok ? "warn" : "error",
        component: "daemon",
        event: "daemon.self_update_unloaded_daemon_restarted",
        message: "a runtime replacement left the daemon's launch agent unloaded; ran ouro up to load it again",
        meta: { currentVersion, ok: restart.ok, detail: restart.detail ?? null },
      })
      summary += restart.ok
        ? "; an interrupted daemon replacement had left nothing running, so started the daemon again and it is healthy"
        : `; an interrupted daemon replacement had left nothing running, and starting the daemon again failed: ${restart.detail ?? "no detail"}`
    }
    return finish("current", {
      summary,
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

  // 3. Install (when there is room), validate, smoke test.
  let space = deps.diskSpace?.() ?? null
  if (space && space.freeBytes < space.neededBytes && deps.reclaimDisk) {
    deps.reclaimDisk()
    space = deps.diskSpace?.() ?? null
  }
  if (space && space.freeBytes < space.neededBytes) {
    const mib = (bytes: number) => Math.round(bytes / (1024 * 1024))
    return finish("install-failed", {
      summary: `not enough free disk to install ${latest}: ${mib(space.freeBytes)} MiB free, about ${mib(space.neededBytes)} MiB needed; staying on ${currentVersion}`,
      latestVersion: latest,
    })
  }
  const memory = deps.memory?.() ?? null
  if (memory && memory.availableBytes < memory.floorBytes) {
    const mb = (bytes: number) => Math.round(bytes / (1024 * 1024))
    return finish("install-failed", {
      summary: `not enough free memory to install ${latest}: MemAvailable ${mb(memory.availableBytes)} MB, below the ${mb(memory.floorBytes)} MB floor; staying on ${currentVersion}`,
      latestVersion: latest,
    })
  }
  let installSource: ReleaseSourceName
  try {
    installSource = await deps.install(latest, lookup)
  } catch (error) {
    const said = errorText(error)
    if (isTarballNotServedYet(said)) {
      return finish("deferred", {
        summary: `${latest} is listed but its tarball is not served yet; staying on ${currentVersion} and trying again next pass`,
        detail: said,
        latestVersion: latest,
      })
    }
    return finish("install-failed", { summary: said, latestVersion: latest })
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
  if (daemonWasRunning && deps.memory) {
    const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
    let memory = deps.memory()
    for (let polls = 0; memory && memory.availableBytes < memory.floorBytes + RESTART_MEMORY_HEADROOM_BYTES && polls < RESTART_MEMORY_WAIT_MS / RESTART_MEMORY_POLL_MS; polls += 1) {
      await sleep(RESTART_MEMORY_POLL_MS)
      memory = deps.memory()
    }
    if (memory && memory.availableBytes < memory.floorBytes + RESTART_MEMORY_HEADROOM_BYTES) {
      const mb = (bytes: number) => Math.round(bytes / (1024 * 1024))
      return finish("deferred", {
        summary: `${latest} is installed, but MemAvailable stayed at ${mb(memory.availableBytes)} MB, under the ${mb(memory.floorBytes)} MB floor plus ${mb(RESTART_MEMORY_HEADROOM_BYTES)} MB for the restart; staying on ${currentVersion} and trying again next pass`,
        latestVersion: latest,
        source: installSource,
      })
    }
  }
  deps.writeIntent({ schemaVersion: 1, mode: "latest", targetVersion: latest })
  deps.activate(latest)
  let healthyOn = latest
  if (daemonWasRunning) {
    const restart = await restartOrRollBack(latest, currentVersion, installSource)
    if (!("healthyOn" in restart)) return restart
    healthyOn = restart.healthyOn
  }
  const healthy = healthyOn === latest ? "; daemon restarted and healthy" : `; daemon restarted and healthy on ${healthyOn}`
  return finish("updated", {
    summary: `updated ${currentVersion ?? "unknown"} -> ${latest} via ${installSource}${daemonWasRunning ? healthy : "; daemon was not running and was left stopped"}`,
    latestVersion: latest,
    source: installSource,
  })
}
