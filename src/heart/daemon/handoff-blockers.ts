import { emitNervesEvent } from "../../nerves/runtime"
import { cliVersionAtLeast } from "../versioning/ouro-version-manager"
import type { StatusPayload } from "./cli-render"

/** One thing in `ouro status` that stops `ouro up` handing off: `key` names it, `text` says what is wrong now. */
export interface HandoffBlocker {
  key: string
  text: string
}

/** Everything `ouro up`'s final daemon check refuses on, in the order it reports them: workers, senses, health checks. */
/**
 * The exit code `ouro up` uses when it refuses to hand off only because the final daemon check found the daemon's
 * health blocked. Every other failure (a migration, a provider step, a crash, a timeout) keeps exit code 1, so the
 * self-updater can tell "the daemon came up but something is unhealthy" from "up itself failed".
 */
export const HANDOFF_HEALTH_REFUSED_EXIT_CODE = 3

/** Summary checks roll several problems into one row, so a new failure can hide behind an old warning by name alone. */
const SUMMARY_HEALTH_CHECKS = new Set(["agent-processes", "cron-health", "sense-probes"])

/** Everything `ouro up`'s final daemon check refuses on, in the order it reports them: workers, senses, health checks. */
export function finalHandoffBlockers(payload: StatusPayload): HandoffBlocker[] {
  const workers = payload.workers
    .filter((worker) => !(worker.autoStart === false && worker.status === "stopped") && worker.status !== "running")
    .map((worker) => {
      const detail = [
        worker.errorReason,
        worker.fixHint ? `fix: ${worker.fixHint}` : null,
      ].filter((part): part is string => part !== null).join("; ")
      const suffix = detail.length > 0 ? ` - ${detail}` : ""
      const name = `${worker.agent}/${worker.worker}`
      return { key: `${name}:${worker.status}`, text: `${name}: ${worker.status}${suffix}` }
    })
  const senses = payload.senses
    .filter((sense) => sense.enabled && !["running", "interactive", "disabled", "not_attached"].includes(sense.status))
    .map((sense) => {
      const name = `${sense.agent}/${sense.sense}`
      return { key: `${name}:${sense.status}`, text: `${name}: ${sense.status} - ${sense.detail}` }
    })
  const healthChecks = payload.healthChecks
    .filter((check) => {
      if (check.status === "ok") return false
      if (check.status === "critical") return true
      return SUMMARY_HEALTH_CHECKS.has(check.name) || check.name.startsWith("sense-probe:")
    })
    .map((check) => ({
      // Severity always counts; a summary row's message counts too, since it says which problems it rolls up.
      key: SUMMARY_HEALTH_CHECKS.has(check.name)
        ? `${check.name}:${check.status}:${check.message}`
        : `${check.name}:${check.status}`,
      text: `${check.name}: ${check.status} - ${check.message}`,
    }))
  return [...workers, ...senses, ...healthChecks]
}

/** What the updater compares across a restart: the blockers, plus enough to tell whether the new daemon has settled. */
export interface HandoffSnapshot {
  blockers: HandoffBlocker[]
  /** Every worker the daemon lists, as `agent/worker`, whatever its state. */
  workers: string[]
  healthCheckCount: number
}

export function handoffSnapshot(payload: StatusPayload): HandoffSnapshot {
  return {
    blockers: finalHandoffBlockers(payload),
    workers: payload.workers.map((worker) => `${worker.agent}/${worker.worker}`),
    healthCheckCount: payload.healthChecks.length,
  }
}

/**
 * Why a new daemon's status is not settled enough to judge yet, or null when it is: a status read before its health
 * checks run or its workers register shows fewer problems than it has.
 */
export function unsettledReason(before: HandoffSnapshot, after: HandoffSnapshot): string | null {
  if (after.healthCheckCount === 0) return "the new daemon has not reported any health checks yet"
  const listed = new Set(after.workers)
  const missing = before.workers.filter((worker) => !listed.has(worker))
  if (missing.length > 0) return `the new daemon does not list workers it had before: ${missing.join(", ")}`
  return null
}

export interface RestartAfterUpFailureInput {
  /** Why `ouro up` failed. */
  upFailure: string
  /** True only when `ouro up` exited with HANDOFF_HEALTH_REFUSED_EXIT_CODE. */
  upRefusedOnHandoffHealth: boolean
  expectedVersion: string
  /** The version the daemon answered with afterwards, or null when it did not answer. */
  seenVersion: string | null
  /** The daemon this update replaced, or null when its status was unreadable. */
  before: HandoffSnapshot | null
  /** The new daemon, or null when its status was unreadable. */
  after: HandoffSnapshot | null
}

/**
 * Whether a release whose `ouro up` refused to hand off still came up healthy for the updater.
 *
 * `ouro up` refuses while any sense is down, so one sense's outage (BlueBubbles while its macOS account is logged
 * out) rolled back every release for a day and marked each one failed (2026-10-24, and alpha.1559 to alpha.1586 on
 * 2026-11-25). A release is only at fault for what it broke: it passes when `ouro up` failed only on the final
 * health check, the daemon answers on it (or on a newer release) with a settled status, and every blocker it reports was already there,
 * at the same severity, before the update.
 */
export function judgeRestartAfterUpFailure(input: RestartAfterUpFailureInput): { ok: boolean; detail: string } {
  if (!input.upRefusedOnHandoffHealth) {
    return { ok: false, detail: input.upFailure }
  }
  if (input.seenVersion === null || !cliVersionAtLeast(input.seenVersion, input.expectedVersion)) {
    const answered = input.seenVersion ? `; the daemon answered with ${input.seenVersion}` : "; the daemon did not answer"
    return { ok: false, detail: `${input.upFailure}${answered}` }
  }
  if (input.before === null || input.after === null) {
    return { ok: false, detail: `${input.upFailure}; could not compare daemon status before and after the update` }
  }
  const unsettled = unsettledReason(input.before, input.after)
  if (unsettled !== null) {
    return { ok: false, detail: `${input.upFailure}; ${unsettled}` }
  }
  const knownBefore = new Set(input.before.blockers.map((blocker) => blocker.key))
  const introduced = input.after.blockers.filter((blocker) => !knownBefore.has(blocker.key))
  if (introduced.length > 0) {
    return { ok: false, detail: `${input.upFailure}; new since the update: ${introduced.map((blocker) => blocker.text).join("; ")}` }
  }
  const carried = input.after.blockers.map((blocker) => blocker.text)
  emitNervesEvent({
    level: "warn",
    component: "daemon",
    event: "daemon.self_update_preexisting_blockers_accepted",
    message: "accepted a release whose ouro up refused only on problems that predate the update",
    meta: { expectedVersion: input.expectedVersion, blockers: carried },
  })
  return {
    ok: true,
    detail: carried.length > 0
      ? `came up on ${input.seenVersion}; still blocked by what was already wrong before the update: ${carried.join("; ")}`
      : `came up on ${input.seenVersion}`,
  }
}
