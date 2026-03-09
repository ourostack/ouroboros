import * as fs from "fs"
import * as path from "path"
import { emitNervesEvent } from "../../../nerves/runtime"
import type { BundleMeta } from "../../../mind/bundle-manifest"
import type { UpdateHookContext, UpdateHookResult } from "../update-hooks"

export async function bundleMetaHook(ctx: UpdateHookContext): Promise<UpdateHookResult> {
  emitNervesEvent({
    component: "daemon",
    event: "daemon.bundle_meta_hook_start",
    message: "running bundle-meta update hook",
    meta: { agentRoot: ctx.agentRoot, currentVersion: ctx.currentVersion },
  })

  const metaPath = path.join(ctx.agentRoot, "bundle-meta.json")

  let existing: BundleMeta | undefined
  try {
    if (fs.existsSync(metaPath)) {
      const raw = fs.readFileSync(metaPath, "utf-8")
      existing = JSON.parse(raw) as BundleMeta
    }
  } catch {
    // Malformed JSON -- treat as missing, will overwrite with fresh
    existing = undefined
  }

  const updated: BundleMeta = {
    runtimeVersion: ctx.currentVersion,
    bundleSchemaVersion: existing?.bundleSchemaVersion ?? 1,
    lastUpdated: new Date().toISOString(),
  }

  // Save old runtimeVersion as previousRuntimeVersion (if there was one)
  if (existing?.runtimeVersion) {
    updated.previousRuntimeVersion = existing.runtimeVersion
  }

  try {
    fs.writeFileSync(metaPath, JSON.stringify(updated, null, 2) + "\n", "utf-8")
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : /* v8 ignore next -- defensive: non-Error catch branch @preserve */ String(err)
    emitNervesEvent({
      component: "daemon",
      event: "daemon.bundle_meta_hook_error",
      message: "bundle-meta hook write failed",
      meta: { agentRoot: ctx.agentRoot, error: errorMessage },
    })
    return { ok: false, error: errorMessage }
  }

  emitNervesEvent({
    component: "daemon",
    event: "daemon.bundle_meta_hook_end",
    message: "bundle-meta updated",
    meta: {
      agentRoot: ctx.agentRoot,
      runtimeVersion: updated.runtimeVersion,
      previousRuntimeVersion: updated.previousRuntimeVersion,
    },
  })

  return { ok: true }
}
