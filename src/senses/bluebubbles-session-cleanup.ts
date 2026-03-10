import * as fs from "node:fs"
import * as path from "node:path"
import { emitNervesEvent } from "../nerves/runtime"

export function cleanupObsoleteBlueBubblesThreadSessions(trunkSessionPath: string): string[] {
  const normalized = trunkSessionPath.trim()
  if (!normalized.endsWith(".json")) return []

  const trunkName = path.basename(normalized)
  if (trunkName.includes("_thread_")) return []
  if (!fs.existsSync(normalized)) return []

  const dir = path.dirname(normalized)
  const prefix = trunkName.slice(0, -".json".length)
  const removed: string[] = []

  for (const entry of fs.readdirSync(dir)) {
    if (!entry.endsWith(".json")) continue
    if (!entry.startsWith(`${prefix}_thread_`)) continue
    const target = path.join(dir, entry)
    fs.rmSync(target, { force: true })
    removed.push(target)
  }

  if (removed.length > 0) {
    emitNervesEvent({
      component: "senses",
      event: "senses.bluebubbles_thread_lane_cleanup",
      message: "removed obsolete bluebubbles thread-lane sessions",
      meta: {
        trunkSessionPath: normalized,
        removedCount: removed.length,
      },
    })
  }

  return removed
}
