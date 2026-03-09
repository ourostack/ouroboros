import { emitNervesEvent } from "../../nerves/runtime"
import type { UpdateHook } from "./update-hooks"

export interface RunHooksDeps {
  bundlesRoot: string
  applyPendingUpdates: (bundlesRoot: string, currentVersion: string) => Promise<void>
  registerUpdateHook: (hook: UpdateHook) => void
  getPackageVersion: () => string
}

export async function runHooks(_deps: RunHooksDeps): Promise<number> {
  emitNervesEvent({
    component: "daemon",
    event: "daemon.run_hooks_stub",
    message: "run-hooks stub",
    meta: {},
  })
  throw new Error("not implemented")
}
