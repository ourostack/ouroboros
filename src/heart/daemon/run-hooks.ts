import { emitNervesEvent } from "../../nerves/runtime"
import { bundleMetaHook } from "./hooks/bundle-meta"
import { agentConfigV2Hook } from "./hooks/agent-config-v2"
import type { UpdateHook } from "./update-hooks"

export interface RunHooksDeps {
  bundlesRoot: string
  applyPendingUpdates: (bundlesRoot: string, currentVersion: string) => Promise<void>
  registerUpdateHook: (hook: UpdateHook) => void
  getPackageVersion: () => string
}

export async function runHooks(deps: RunHooksDeps): Promise<number> {
  emitNervesEvent({
    component: "daemon",
    event: "daemon.run_hooks_start",
    message: "running update hooks",
    meta: { bundlesRoot: deps.bundlesRoot },
  })

  try {
    deps.registerUpdateHook(bundleMetaHook)
    deps.registerUpdateHook(agentConfigV2Hook)
    const currentVersion = deps.getPackageVersion()
    await deps.applyPendingUpdates(deps.bundlesRoot, currentVersion)

    emitNervesEvent({
      component: "daemon",
      event: "daemon.run_hooks_success",
      message: "update hooks completed successfully",
      meta: { bundlesRoot: deps.bundlesRoot },
    })
    return 0
  } catch (err) {
    emitNervesEvent({
      component: "daemon",
      event: "daemon.run_hooks_error",
      message: "update hooks failed",
      meta: {
        bundlesRoot: deps.bundlesRoot,
        error: err instanceof Error ? err.message : /* v8 ignore next -- defensive: non-Error catch branch @preserve */ String(err),
      },
    })
    return 1
  }
}
