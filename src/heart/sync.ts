import { execSync } from "child_process"
import * as fs from "fs"
import * as path from "path"
import { emitNervesEvent } from "../nerves/runtime"
import type { SyncConfig } from "./config"

export interface SyncResult {
  ok: boolean
  error?: string
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
    execSync(`git pull ${config.remote}`, {
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
    const statusOutput = execSync("git status --porcelain", {
      cwd: agentRoot,
      stdio: "pipe",
      timeout: 10000,
    }).toString()

    const syncPaths = ["arc/", "diary/", "friends/", "tasks/"]
    const changedLines = statusOutput
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .filter((line) => {
        const filePath = line.slice(3)
        return syncPaths.some((prefix) => filePath.startsWith(prefix))
      })

    if (changedLines.length === 0) {
      emitNervesEvent({
        component: "heart",
        event: "heart.sync_push_end",
        message: "post-turn push: no changes to sync",
        meta: { agentRoot },
      })
      return { ok: true }
    }

    // Stage, commit, push
    const pathsToAdd = syncPaths.map((p) => path.join(agentRoot, p))
    for (const p of pathsToAdd) {
      if (fs.existsSync(p)) {
        execSync(`git add ${p}`, { cwd: agentRoot, stdio: "pipe", timeout: 10000 })
      }
    }

    execSync('git commit -m "sync: post-turn update"', {
      cwd: agentRoot,
      stdio: "pipe",
      timeout: 10000,
    })

    try {
      execSync(`git push ${config.remote}`, {
        cwd: agentRoot,
        stdio: "pipe",
        timeout: 30000,
      })
    } catch {
      // Push rejected -- try pull-rebase-push
      try {
        execSync(`git pull --rebase ${config.remote}`, {
          cwd: agentRoot,
          stdio: "pipe",
          timeout: 30000,
        })
        execSync(`git push ${config.remote}`, {
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
            paths: changedLines.map((l) => l.slice(3)),
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
      meta: { agentRoot, changedCount: changedLines.length },
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
