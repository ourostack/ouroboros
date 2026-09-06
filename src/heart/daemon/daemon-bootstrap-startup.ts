import { emitNervesEvent } from "../../nerves/runtime"
import { writeDaemonTombstone } from "./daemon-tombstone"

const REDACTED_BOOTSTRAP_STARTUP_ERROR = "container credential bootstrap rejected; recoverable claim retained for reconciliation"
const SANCTUARY_BUNDLE_RECOVERY_GUIDANCE = {
  restart_from_verified_release: "restart Mendelow Cloud Butler from its verified release so the installed bundle can finish updating",
  run_verified_update_recovery: "resume the reviewed Mendelow Cloud Butler update recovery procedure",
  roll_back_or_install_verified_release: "roll back to a verified Mendelow Cloud Butler release or install that release again",
} as const
const REDACTED_SANCTUARY_BUNDLE_PREPARATION_ERROR = `Sanctuary installation needs attention\n  human-required: ${SANCTUARY_BUNDLE_RECOVERY_GUIDANCE.run_verified_update_recovery}`
const REDACTED_DAEMON_PREPARATION_ERROR = "provider runtime preparation failed before startup; run `ouro doctor` for diagnosis"
export const PUBLIC_DAEMON_STARTUP_FAILURE_REASON = "startupFailurePublic"

class DaemonPreparationFailure extends Error {
  override readonly name = "DaemonPreparationFailure"
}

export function createProviderReadinessPreparationFailure(issues: ReadonlyArray<{
  summary: string
  actions: ReadonlyArray<{ actor: string; command: string }>
}>): Error {
  const lines = ["Provider checks need attention"]
  for (const issue of issues) {
    lines.push(issue.summary)
    lines.push(...issue.actions.map((action) => `  ${action.actor}: ${action.command}`))
  }
  return new DaemonPreparationFailure(lines.join("\n"))
}

export function createSanctuaryBundlePreparationFailure(action: keyof typeof SANCTUARY_BUNDLE_RECOVERY_GUIDANCE): Error {
  return new DaemonPreparationFailure(`Sanctuary installation needs attention\n  human-required: ${SANCTUARY_BUNDLE_RECOVERY_GUIDANCE[action]}`)
}

export interface DaemonBootstrapStartupInput {
  preflight?: () => Promise<void> | void
  loadBootstrap: () => Promise<unknown>
  prepareManagedBundle?: () => Promise<void> | void
  prepareDaemon?: () => Promise<void>
  startDaemon: () => Promise<void>
  markStartupFailure: () => void
  exit: (code: number) => void
}

function failDaemonPreparation(input: Pick<DaemonBootstrapStartupInput, "markStartupFailure" | "exit">, error: unknown, fallback: string): false {
  input.markStartupFailure()
  const controlledMessage = error instanceof DaemonPreparationFailure ? error.message : fallback
  failFastDaemonStartup({ exit: input.exit, errorMessage: controlledMessage, eventMessage: controlledMessage })
  return false
}

export function failFastContainerCredentialBootstrapStartup(input: {
  exit: (code: number) => void
}): void {
  failFastDaemonStartup({
    exit: input.exit,
    errorMessage: REDACTED_BOOTSTRAP_STARTUP_ERROR,
    eventMessage: "daemon entrypoint failed before server startup",
  })
}

function failFastDaemonStartup(input: {
  exit: (code: number) => void
  errorMessage: string
  eventMessage: string
}): void {
  const errorMessage = input.errorMessage
  const error = new Error(errorMessage)
  try {
    writeDaemonTombstone(PUBLIC_DAEMON_STARTUP_FAILURE_REASON, error)
  } catch {
    // Exit remains mandatory even if best-effort tombstone reporting fails.
  }
  try {
    emitNervesEvent({
      level: "error",
      component: "daemon",
      event: "daemon.entry_error",
      message: input.eventMessage,
      meta: { error: errorMessage },
    })
  } catch {
    // Exit remains mandatory even if best-effort event reporting fails.
  }
  input.exit(1)
}

export function failFastSanctuaryBundlePreparationStartup(input: { failure: unknown; exit: (code: number) => void }): void {
  const message = input.failure instanceof DaemonPreparationFailure ? input.failure.message : REDACTED_SANCTUARY_BUNDLE_PREPARATION_ERROR
  failFastDaemonStartup({ exit: input.exit, errorMessage: message, eventMessage: message })
}

export async function startDaemonAfterContainerCredentialBootstrap(
  input: DaemonBootstrapStartupInput,
): Promise<boolean> {
  try {
    const preflight = input.preflight?.()
    if (preflight) await preflight
  } catch (error) {
    return failDaemonPreparation(input, error, REDACTED_SANCTUARY_BUNDLE_PREPARATION_ERROR)
  }
  try {
    await input.loadBootstrap()
  } catch {
    input.markStartupFailure()
    failFastContainerCredentialBootstrapStartup({ exit: input.exit })
    return false
  }
  try {
    const preparation = input.prepareManagedBundle?.()
    if (preparation) await preparation
  } catch (error) {
    return failDaemonPreparation(input, error, REDACTED_SANCTUARY_BUNDLE_PREPARATION_ERROR)
  }
  try {
    await input.prepareDaemon?.()
  } catch (error) {
    return failDaemonPreparation(input, error, REDACTED_DAEMON_PREPARATION_ERROR)
  }
  await input.startDaemon()
  return true
}
