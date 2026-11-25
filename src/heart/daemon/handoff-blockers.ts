import { emitNervesEvent } from "../../nerves/runtime"
import type { StatusPayload } from "./cli-render"

/** One thing in `ouro status` that stops `ouro up` handing off: `key` names it, `text` says what is wrong now. */
export interface HandoffBlocker {
  key: string
  text: string
}

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
      const key = `${worker.agent}/${worker.worker}`
      return { key, text: `${key}: ${worker.status}${suffix}` }
    })
  const senses = payload.senses
    .filter((sense) => sense.enabled && !["running", "interactive", "disabled", "not_attached"].includes(sense.status))
    .map((sense) => {
      const key = `${sense.agent}/${sense.sense}`
      return { key, text: `${key}: ${sense.status} - ${sense.detail}` }
    })
  const healthChecks = payload.healthChecks
    .filter((check) => {
      if (check.status === "ok") return false
      if (check.status === "critical") return true
      return check.name === "agent-processes"
        || check.name === "cron-health"
        || check.name === "sense-probes"
        || check.name.startsWith("sense-probe:")
    })
    .map((check) => ({ key: check.name, text: `${check.name}: ${check.status} - ${check.message}` }))
  return [...workers, ...senses, ...healthChecks]
}

export interface RestartAfterUpFailureInput {
  /** Why `ouro up` failed. */
  upFailure: string
  expectedVersion: string
  /** The version the daemon answered with afterwards, or null when it did not answer. */
  seenVersion: string | null
  /** What blocked handoff on the daemon this update replaced, or null when its status was unreadable. */
  before: HandoffBlocker[] | null
  /** What blocks handoff on the new daemon, or null when its status was unreadable. */
  after: HandoffBlocker[] | null
}

/**
 * Whether a release whose `ouro up` refused to hand off still came up healthy for the updater.
 *
 * `ouro up` refuses while any sense is down, so one sense's outage (BlueBubbles while its macOS account is logged
 * out) rolled back every release for a day and marked each one failed (2026-10-24, and alpha.1559 to alpha.1586 on
 * 2026-11-25). A release is only at fault for what it broke: it passes when the daemon answers on it and every
 * blocker it reports was already there before the update.
 */
export function judgeRestartAfterUpFailure(input: RestartAfterUpFailureInput): { ok: boolean; detail: string } {
  if (input.seenVersion !== input.expectedVersion) {
    const answered = input.seenVersion ? `; the daemon answered with ${input.seenVersion}` : "; the daemon did not answer"
    return { ok: false, detail: `${input.upFailure}${answered}` }
  }
  if (input.before === null || input.after === null) {
    return { ok: false, detail: `${input.upFailure}; could not compare daemon status before and after the update` }
  }
  const knownBefore = new Set(input.before.map((blocker) => blocker.key))
  const introduced = input.after.filter((blocker) => !knownBefore.has(blocker.key))
  if (introduced.length > 0) {
    return { ok: false, detail: `${input.upFailure}; new since the update: ${introduced.map((blocker) => blocker.text).join("; ")}` }
  }
  const carried = input.after.map((blocker) => blocker.text)
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
      ? `came up on ${input.expectedVersion}; still blocked by what was already wrong before the update: ${carried.join("; ")}`
      : `came up on ${input.expectedVersion}`,
  }
}
