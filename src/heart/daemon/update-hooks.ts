import * as fs from "fs"
import * as path from "path"
import { emitNervesEvent } from "../../nerves/runtime"
import type { BundleMeta } from "../../mind/bundle-manifest"

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

export interface UpdateSummaryEntry {
  agent: string
  from: string | undefined
  to: string
}

export interface UpdateSummary {
  updated: UpdateSummaryEntry[]
}

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

export async function applyPendingUpdates(bundlesRoot: string, currentVersion: string): Promise<UpdateSummary> {
  const summary: UpdateSummary = { updated: [] }

  emitNervesEvent({
    component: "daemon",
    event: "daemon.apply_pending_updates_start",
    message: "applying pending updates",
    meta: { bundlesRoot, currentVersion },
  })

  if (!fs.existsSync(bundlesRoot)) {
    return summary
  }

  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(bundlesRoot, { withFileTypes: true })
  } catch {
    return summary
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.endsWith(".ouro")) continue

    const agentRoot = path.join(bundlesRoot, entry.name)
    let previousVersion: string | undefined

    const metaPath = path.join(agentRoot, "bundle-meta.json")
    try {
      if (fs.existsSync(metaPath)) {
        const raw = fs.readFileSync(metaPath, "utf-8")
        const meta = JSON.parse(raw) as BundleMeta
        previousVersion = meta.runtimeVersion

        if (previousVersion === currentVersion) {
          continue
        }
      }
    } catch {
      // Malformed or unreadable bundle-meta.json -- treat as needing update
      previousVersion = undefined
    }

    const ctx: UpdateHookContext = { agentRoot, currentVersion, previousVersion }

    for (const hook of _hooks) {
      try {
        await hook(ctx)
      } catch (err) {
        emitNervesEvent({
          component: "daemon",
          event: "daemon.update_hook_error",
          message: "update hook threw",
          meta: {
            agentRoot,
            error: err instanceof Error ? err.message : /* v8 ignore next -- defensive: non-Error catch branch @preserve */ String(err),
          },
        })
      }
    }

    summary.updated.push({
      agent: entry.name.replace(/\.ouro$/, ""),
      from: previousVersion,
      to: currentVersion,
    })
  }

  emitNervesEvent({
    component: "daemon",
    event: "daemon.apply_pending_updates_end",
    message: "pending updates applied",
    meta: { bundlesRoot },
  })

  return summary
}
