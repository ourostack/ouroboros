import * as fs from "fs"
import * as path from "path"
import { getAgentBundlesRoot } from "../identity"
import { emitNervesEvent } from "../../nerves/runtime"

export interface PruneDeps {
  bundlesRoot?: string
  readdirSync?: (target: string, options: { withFileTypes: true }) => fs.Dirent[]
  existsSync?: (target: string) => boolean
  rmSync?: (target: string, options: { recursive: true; force: true }) => void
}

/**
 * Scan the bundles root for `.ouro` directories that have no `agent.json`
 * file (definitively dead ephemeral bundles) and delete them.
 *
 * Returns a list of pruned bundle directory names (e.g. `["stale.ouro"]`)
 * for display purposes. Bundles that have `agent.json` -- even if disabled
 * -- are never deleted. Errors on individual bundles are swallowed so that
 * one permission-denied doesn't block pruning the rest.
 */
export function pruneStaleEphemeralBundles(deps: PruneDeps = {}): string[] {
  const bundlesRoot = deps.bundlesRoot ?? getAgentBundlesRoot()
  const readdirSync = deps.readdirSync ?? fs.readdirSync
  const existsSync = deps.existsSync ?? fs.existsSync
  const rmSync = deps.rmSync ?? fs.rmSync

  let entries: fs.Dirent[]
  try {
    entries = readdirSync(bundlesRoot, { withFileTypes: true })
  } catch {
    return []
  }

  const pruned: string[] = []

  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.endsWith(".ouro")) continue

    const bundlePath = path.join(bundlesRoot, entry.name)
    const agentJsonPath = path.join(bundlePath, "agent.json")

    if (existsSync(agentJsonPath)) continue

    try {
      rmSync(bundlePath, { recursive: true, force: true })
      pruned.push(entry.name)
      emitNervesEvent({
        level: "info",
        component: "daemon",
        event: "daemon.stale_bundle_pruned",
        message: `pruned stale ephemeral bundle: ${entry.name}`,
        meta: { bundle: entry.name, bundlePath },
      })
    } catch (error) {
      emitNervesEvent({
        level: "warn",
        component: "daemon",
        event: "daemon.stale_bundle_prune_error",
        message: `failed to prune stale bundle: ${entry.name}`,
        meta: {
          bundle: entry.name,
          bundlePath,
          error: error instanceof Error ? error.message : String(error),
        },
      })
    }
  }

  return pruned
}
