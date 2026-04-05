import { emitNervesEvent } from "../../../nerves/runtime"
import { migrateAgentConfigV1ToV2 } from "../../migrate-config"
import type { UpdateHookContext, UpdateHookResult } from "../../versioning/update-hooks"

export async function agentConfigV2Hook(ctx: UpdateHookContext): Promise<UpdateHookResult> {
  emitNervesEvent({
    component: "daemon",
    event: "daemon.agent_config_v2_hook_start",
    message: "running agent-config-v2 update hook",
    meta: { agentRoot: ctx.agentRoot, currentVersion: ctx.currentVersion },
  })

  try {
    migrateAgentConfigV1ToV2(ctx.agentRoot)
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : /* v8 ignore next -- defensive: non-Error catch branch @preserve */ String(err)
    emitNervesEvent({
      component: "daemon",
      event: "daemon.agent_config_v2_hook_error",
      message: "agent-config-v2 hook migration failed",
      meta: { agentRoot: ctx.agentRoot, error: errorMessage },
    })
    return { ok: false, error: errorMessage }
  }

  emitNervesEvent({
    component: "daemon",
    event: "daemon.agent_config_v2_hook_end",
    message: "agent-config-v2 hook completed",
    meta: { agentRoot: ctx.agentRoot },
  })

  return { ok: true }
}
