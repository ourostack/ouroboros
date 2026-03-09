import type { UpdateHookContext, UpdateHookResult } from "../update-hooks"
import { emitNervesEvent } from "../../../nerves/runtime"

export async function bundleMetaHook(_ctx: UpdateHookContext): Promise<UpdateHookResult> {
  emitNervesEvent({
    component: "daemon",
    event: "daemon.bundle_meta_hook",
    message: "bundle-meta hook stub",
    meta: {},
  })
  throw new Error("not implemented")
}
