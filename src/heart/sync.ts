import { execFileSync } from "child_process"
import * as fs from "fs"
import * as path from "path"
import { emitNervesEvent } from "../nerves/runtime"
import type { SyncConfig } from "./config"

export interface SyncResult {
  ok: boolean
  error?: string
}

/** Sync-tracked path prefixes — only files under these roots are staged for push. */
const SYNC_PATH_PREFIXES = ["arc/", "diary/", "friends/", "tasks/"]

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
 * Post-turn push: sync changed arc/diary/friends/tasks files to remote after a turn.
 * Stages only the specific changed files (not entire directories) to avoid sweeping in unrelated WIP.
 */
export function postTurnPush(agentRoot: string, config: SyncConfig): SyncResult {
  emitNervesEvent({
    component: "heart",
    event: "heart.sync_push_start",
    message: "post-turn push starting",
    meta: { agentRoot, remote: config.remote },
  })

  try {
    // Check for changes in tracked sync paths
    const statusOutput = execFileSync("git", ["status", "--porcelain"], {
      cwd: agentRoot,
      stdio: "pipe",
      timeout: 10000,
    }).toString()

    const changedFiles = statusOutput
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => line.slice(3))
      .filter((filePath) => SYNC_PATH_PREFIXES.some((prefix) => filePath.startsWith(prefix)))

    if (changedFiles.length === 0) {
      emitNervesEvent({
        component: "heart",
        event: "heart.sync_push_end",
        message: "post-turn push: no changes to sync",
        meta: { agentRoot },
      })
      return { ok: true }
    }

    // Stage only the specific changed files (not entire directories)
    execFileSync("git", ["add", "--", ...changedFiles], {
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
            paths: changedFiles,
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
      meta: { agentRoot, changedCount: changedFiles.length },
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
