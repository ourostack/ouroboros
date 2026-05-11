import * as fs from "fs"
import * as path from "path"
import { emitNervesEvent } from "../../nerves/runtime"
import { parseAwaitFile } from "./await-parser"
import { applyAwaitRuntimeState } from "./await-runtime-state"
import type { AwaitingCommitment } from "../commitments"

/**
 * Load the bundle's pending awaits, merged with runtime state, projected into
 * the AwaitingCommitment shape consumed by the commitments / prompt pipeline.
 *
 * Reads only `<bundle>/awaiting/` (never `.done/`). Skips malformed files
 * silently — those are surfaced via the scheduler's parseErrors path.
 */
export function loadPendingAwaitsForCommitments(agentRoot: string): AwaitingCommitment[] {
  const dir = path.join(agentRoot, "awaiting")
  let entries: string[]
  try {
    const raw = fs.readdirSync(dir)
    /* v8 ignore next -- defensive: real readdirSync returns string[]; this only fires when callers stub it to a non-array @preserve */
    entries = Array.isArray(raw) ? raw as string[] : []
  } catch {
    return []
  }

  const out: AwaitingCommitment[] = []
  for (const entry of entries) {
    if (!entry.endsWith(".md")) continue
    const filePath = path.join(dir, entry)
    try {
      const content = fs.readFileSync(filePath, "utf-8")
      const merged = applyAwaitRuntimeState(agentRoot, parseAwaitFile(content, filePath)) as ReturnType<typeof parseAwaitFile> & {
        last_checked?: string | null
        last_observation?: string | null
        checked_count?: number
      }
      if (merged.status !== "pending") continue
      if (!merged.condition) continue
      out.push({
        name: merged.name,
        condition: merged.condition,
        checkedCount: typeof merged.checked_count === "number" ? merged.checked_count : 0,
        lastCheckedAt: merged.last_checked ?? null,
        lastObservation: merged.last_observation ?? null,
      })
    } catch {
      // Skip unreadable/unparseable files — surfaced elsewhere
    }
  }

  emitNervesEvent({
    component: "engine",
    event: "engine.awaits_loaded_for_commitments",
    message: "loaded pending awaits for commitments",
    meta: { agentRoot, count: out.length },
  })

  return out
}
