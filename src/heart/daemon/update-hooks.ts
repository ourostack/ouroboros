import { emitNervesEvent } from "../../nerves/runtime"

export interface UpdateHookContext {
  agentRoot: string
  currentVersion: string
  previousVersion: string | undefined
}

export interface UpdateHookResult {
  ok: boolean
  error?: string
}

export type UpdateHook = (ctx: UpdateHookContext) => UpdateHookResult | Promise<UpdateHookResult>

const _hooks: UpdateHook[] = []

export function registerUpdateHook(hook: UpdateHook): void {
  _hooks.push(hook)
  emitNervesEvent({
    component: "daemon",
    event: "daemon.update_hook_registered",
    message: "registered update hook",
    meta: {},
  })
}

export function getRegisteredHooks(): readonly UpdateHook[] {
  return _hooks
}

export function clearRegisteredHooks(): void {
  _hooks.length = 0
}

export async function applyPendingUpdates(_bundlesRoot: string, _currentVersion: string): Promise<void> {
  throw new Error("Not implemented")
}
