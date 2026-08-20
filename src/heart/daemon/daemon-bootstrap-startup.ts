import { emitNervesEvent } from "../../nerves/runtime"
import { writeDaemonTombstone } from "./daemon-tombstone"

const REDACTED_BOOTSTRAP_STARTUP_ERROR = "container credential bootstrap rejected; recoverable claim retained for reconciliation"

export interface DaemonBootstrapStartupInput {
  loadBootstrap: () => Promise<unknown>
  startDaemon: () => Promise<void>
  markStartupFailure: () => void
  exit: (code: number) => void
}

export function failFastContainerCredentialBootstrapStartup(input: {
  exit: (code: number) => void
}): void {
  const error = new Error(REDACTED_BOOTSTRAP_STARTUP_ERROR)
  try {
    writeDaemonTombstone("startupFailure", error)
  } catch {
    // Exit remains mandatory even if best-effort tombstone reporting fails.
  }
  try {
    emitNervesEvent({
      level: "error",
      component: "daemon",
      event: "daemon.entry_error",
      message: "daemon entrypoint failed before server startup",
      meta: { error: REDACTED_BOOTSTRAP_STARTUP_ERROR },
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
  await input.startDaemon()
  return true
}
