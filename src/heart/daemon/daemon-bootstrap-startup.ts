import { emitNervesEvent } from "../../nerves/runtime"
import { writeDaemonTombstone } from "./daemon-tombstone"

const REDACTED_BOOTSTRAP_STARTUP_ERROR = "container credential bootstrap rejected; recoverable claim retained for reconciliation"
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

export interface DaemonBootstrapStartupInput {
  loadBootstrap: () => Promise<unknown>
  prepareDaemon?: () => Promise<void>
  startDaemon: () => Promise<void>
  markStartupFailure: () => void
  exit: (code: number) => void
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

export async function startDaemonAfterContainerCredentialBootstrap(
  input: DaemonBootstrapStartupInput,
): Promise<boolean> {
  try {
    await input.loadBootstrap()
  } catch {
    input.markStartupFailure()
    failFastContainerCredentialBootstrapStartup({ exit: input.exit })
    return false
  }
  try {
    await input.prepareDaemon?.()
  } catch (error) {
    input.markStartupFailure()
    const controlledMessage = error instanceof DaemonPreparationFailure ? error.message : null
    failFastDaemonStartup({
      exit: input.exit,
      errorMessage: controlledMessage ?? REDACTED_DAEMON_PREPARATION_ERROR,
      eventMessage: controlledMessage ?? REDACTED_DAEMON_PREPARATION_ERROR,
    })
    return false
  }
  await input.startDaemon()
  return true
}
