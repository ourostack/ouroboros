import * as fs from "node:fs"
import * as path from "node:path"
import { emitNervesEvent } from "../../nerves/runtime"

export function findObsoleteBlueBubblesThreadSessions(trunkSessionPath: string): string[] {
  const normalized = trunkSessionPath.trim()
  if (!normalized.endsWith(".json")) return []

  const trunkName = path.basename(normalized)
  if (trunkName.includes("_thread_")) return []
  if (!fs.existsSync(normalized)) return []

  const dir = path.dirname(normalized)
  const prefix = trunkName.slice(0, -".json".length)
  const threadLaneFiles: string[] = []

  for (const entry of fs.readdirSync(dir)) {
    if (!entry.endsWith(".json")) continue
    if (!entry.startsWith(`${prefix}_thread_`)) continue
    threadLaneFiles.push(path.join(dir, entry))
  }

  if (threadLaneFiles.length > 0) {
    emitNervesEvent({
      level: "warn",
      component: "senses",
      event: "senses.bluebubbles_thread_lane_artifacts_detected",
      message: "detected obsolete bluebubbles thread-lane sessions",
      meta: {
        sessionPath: normalized,
        artifactCount: threadLaneFiles.length,
      },
    })
  }

  return threadLaneFiles
}
