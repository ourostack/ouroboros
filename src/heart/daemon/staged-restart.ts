import type { SpawnSyncReturns } from "child_process"
import { emitNervesEvent } from "../../nerves/runtime"

export interface StagedRestartDeps {
  execSync: (command: string) => void
  spawnSync: (command: string, args: string[], options: Record<string, unknown>) => SpawnSyncReturns<Buffer>
  resolveNewCodePath: (version: string) => string | null
  gracefulShutdown: () => Promise<void>
  nodePath: string
  bundlesRoot: string
}

export interface StagedRestartResult {
  ok: boolean
  error?: string
  shutdownError?: string
}

export async function performStagedRestart(
  _version: string,
  _deps: StagedRestartDeps,
): Promise<StagedRestartResult> {
  emitNervesEvent({
    component: "daemon",
    event: "daemon.staged_restart_stub",
    message: "staged restart stub",
    meta: {},
  })
  throw new Error("not implemented")
}
