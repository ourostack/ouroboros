import { execFileSync } from "child_process"
import * as fs from "fs"
import * as path from "path"
import { emitNervesEvent } from "../nerves/runtime"
import type { SyncConfig } from "./config"

export interface SyncResult {
  ok: boolean
  error?: string
}

/**
 * Turn-scoped write tracker.
 * Continuity writers (episodes, obligations, cares, intentions, diary, presence)
 * call trackSyncWrite() after every fs write. drainSyncWrites() returns the
 * accumulated set and resets it for the next turn.
 */
const turnWrites = new Set<string>()

/** Register an absolute file path written during this turn. */
export function trackSyncWrite(absolutePath: string): void {
  turnWrites.add(absolutePath)
}

/** Return all paths written this turn and clear the set. */
export function drainSyncWrites(): string[] {
  const paths = [...turnWrites]
  turnWrites.clear()
  return paths
}

/**
 * Pre-turn pull: sync the agent bundle from remote before assembling the start-of-turn packet.
 */
export function preTurnPull(agentRoot: string, config: SyncConfig): SyncResult {
  emitNervesEvent({
    component: "heart",
    event: "heart.sync_pull_start",
    message: "pre-turn pull starting",
    meta: { agentRoot, remote: config.remote },
  })

  try {
    execFileSync("git", ["pull", config.remote], {
      cwd: agentRoot,
      stdio: "pipe",
      timeout: 30000,
    })

    emitNervesEvent({
      component: "heart",
      event: "heart.sync_pull_end",
      message: "pre-turn pull complete",
      meta: { agentRoot },
    })

    return { ok: true }
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)

    emitNervesEvent({
      component: "heart",
      event: "heart.sync_pull_error",
      message: "pre-turn pull failed",
      meta: { agentRoot, error },
    })

    return { ok: false, error }
  }
}

/**
 * Post-turn push: commit and push files written during this turn.
 * Receives an explicit list of absolute paths (from drainSyncWrites) instead of
 * discovering changes via git status. Empty list = no changes = skip.
 */
export function postTurnPush(agentRoot: string, config: SyncConfig, writtenPaths: string[]): SyncResult {
  emitNervesEvent({
    component: "heart",
    event: "heart.sync_push_start",
    message: "post-turn push starting",
    meta: { agentRoot, remote: config.remote },
  })

  if (writtenPaths.length === 0) {
    emitNervesEvent({
      component: "heart",
      event: "heart.sync_push_end",
      message: "post-turn push: no changes to sync",
      meta: { agentRoot },
    })
    return { ok: true }
  }

  // Convert absolute paths to relative (for git add)
  const relativePaths = writtenPaths
    .map((p) => path.relative(agentRoot, p))
    .filter((p) => p.length > 0 && !p.startsWith(".."))

  if (relativePaths.length === 0) {
    emitNervesEvent({
      component: "heart",
      event: "heart.sync_push_end",
      message: "post-turn push: no in-bundle paths to sync",
      meta: { agentRoot },
    })
    return { ok: true }
  }

  try {
    // Stage only the specific files written during this turn
    execFileSync("git", ["add", "--", ...relativePaths], {
      cwd: agentRoot,
      stdio: "pipe",
      timeout: 10000,
    })

    execFileSync("git", ["commit", "-m", "sync: post-turn update"], {
      cwd: agentRoot,
      stdio: "pipe",
      timeout: 10000,
    })

    try {
      execFileSync("git", ["push", config.remote], {
        cwd: agentRoot,
        stdio: "pipe",
        timeout: 30000,
      })
    } catch {
      // Push rejected -- try pull-rebase-push
      try {
        execFileSync("git", ["pull", "--rebase", config.remote], {
          cwd: agentRoot,
          stdio: "pipe",
          timeout: 30000,
        })
        execFileSync("git", ["push", config.remote], {
          cwd: agentRoot,
          stdio: "pipe",
          timeout: 30000,
        })
      } catch (retryErr) {
        // Second failure -- write pending-sync.json
        const retryError = retryErr instanceof Error ? retryErr.message : String(retryErr)
        const pendingSyncPath = path.join(agentRoot, "state", "pending-sync.json")
        fs.mkdirSync(path.join(agentRoot, "state"), { recursive: true })
        fs.writeFileSync(
          pendingSyncPath,
          JSON.stringify({
            error: retryError,
            failedAt: new Date().toISOString(),
            paths: relativePaths,
          }, null, 2),
          "utf-8",
        )

        emitNervesEvent({
          component: "heart",
          event: "heart.sync_push_error",
          message: "post-turn push failed after retry",
          meta: { agentRoot, error: retryError },
        })

        return { ok: false, error: retryError }
      }
    }

    emitNervesEvent({
      component: "heart",
      event: "heart.sync_push_end",
      message: "post-turn push complete",
      meta: { agentRoot, changedCount: relativePaths.length },
    })

    return { ok: true }
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)

    emitNervesEvent({
      component: "heart",
      event: "heart.sync_push_error",
      message: "post-turn push failed",
      meta: { agentRoot, error },
    })

    return { ok: false, error }
  }
}
