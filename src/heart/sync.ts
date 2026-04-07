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
 * Check whether the bundle is initialized as a git repo.
 * Used by both pre-turn pull and post-turn push to surface a clear,
 * actionable error when sync is enabled but the user never ran `git init`
 * inside their bundle. This error is propagated all the way into the
 * agent's start-of-turn packet as a Sync warning, so the agent can
 * either ask the user or run `git init` itself.
 */
function ensureGitRepo(agentRoot: string): SyncResult {
  if (fs.existsSync(path.join(agentRoot, ".git"))) {
    return { ok: true }
  }
  const error = `bundle is not a git repo; run \`git init\` inside ${agentRoot} to enable sync (or disable sync in agent.json)`
  return { ok: false, error }
}

/**
 * Pre-turn pull: sync the agent bundle from remote before assembling the start-of-turn packet.
 *
 * If the bundle has no git remote configured, the pull is skipped and the function
 * returns ok — matching the no-remote behavior of postTurnPush. This supports the
 * "local-only sync" mode where the bundle accumulates a commit log without ever
 * pushing or pulling from a remote.
 */
export function preTurnPull(agentRoot: string, config: SyncConfig): SyncResult {
  emitNervesEvent({
    component: "heart",
    event: "heart.sync_pull_start",
    message: "pre-turn pull starting",
    meta: { agentRoot, remote: config.remote },
  })

  // Check that the bundle is actually a git repo before touching git at all.
  // Surfaces a clear, actionable error via syncFailure → start-of-turn packet
  // so the agent can propose running `git init` (or just do it).
  const repoCheck = ensureGitRepo(agentRoot)
  if (!repoCheck.ok) {
    emitNervesEvent({
      level: "warn",
      component: "heart",
      event: "heart.sync_not_a_repo",
      message: "pre-turn pull failed: bundle is not a git repo",
      meta: { agentRoot },
    })
    return repoCheck
  }

  // Check if any remote is configured. If not, skip the pull (local-only mode).
  try {
    const remoteOutput = execFileSync("git", ["remote"], {
      cwd: agentRoot,
      stdio: "pipe",
      timeout: 5000,
    }).toString().trim()

    if (remoteOutput.length === 0) {
      emitNervesEvent({
        component: "heart",
        event: "heart.sync_pull_end",
        message: "pre-turn pull skipped: no remote configured",
        meta: { agentRoot },
      })
      return { ok: true }
    }
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)

    emitNervesEvent({
      component: "heart",
      event: "heart.sync_pull_error",
      message: "pre-turn pull failed: git remote check failed",
      meta: { agentRoot, error },
    })

    return { ok: false, error }
  }

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
 * Post-turn push: discover dirty files via `git status`, commit, and push.
 * Uses git-status-based discovery instead of explicit path tracking, ensuring
 * all file writers are captured regardless of whether they call a tracking API.
 */
export function postTurnPush(agentRoot: string, config: SyncConfig): SyncResult {
  emitNervesEvent({
    component: "heart",
    event: "heart.sync_push_start",
    message: "post-turn push starting",
    meta: { agentRoot, remote: config.remote },
  })

  // Same git-repo check as preTurnPull. This is the more common failure path
  // since postTurnPush runs after every turn while preTurnPull only runs on
  // user-initiated turns. Prior to this guard, an un-init'd bundle would fail
  // the git-status invocation below with a generic "not a git repository"
  // error; now we catch it explicitly with an actionable message.
  const repoCheck = ensureGitRepo(agentRoot)
  if (!repoCheck.ok) {
    emitNervesEvent({
      level: "warn",
      component: "heart",
      event: "heart.sync_not_a_repo",
      message: "post-turn push failed: bundle is not a git repo",
      meta: { agentRoot },
    })
    return repoCheck
  }

  let statusOutput: string
  try {
    statusOutput = execFileSync("git", ["status", "--porcelain"], {
      cwd: agentRoot,
      stdio: "pipe",
      timeout: 10000,
    }).toString().trim()
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    emitNervesEvent({
      component: "heart",
      event: "heart.sync_push_error",
      message: "post-turn push: git status failed",
      meta: { agentRoot, error },
    })
    return { ok: false, error }
  }

  if (statusOutput.length === 0) {
    emitNervesEvent({
      component: "heart",
      event: "heart.sync_push_end",
      message: "post-turn push: no changes to sync",
      meta: { agentRoot },
    })
    return { ok: true }
  }

  const changedCount = statusOutput.split("\n").length

  try {
    execFileSync("git", ["add", "-A"], {
      cwd: agentRoot,
      stdio: "pipe",
      timeout: 10000,
    })

    execFileSync("git", ["commit", "-m", "sync: post-turn update"], {
      cwd: agentRoot,
      stdio: "pipe",
      timeout: 10000,
    })

    // Check if a remote exists
    const remoteOutput = execFileSync("git", ["remote"], {
      cwd: agentRoot,
      stdio: "pipe",
      timeout: 5000,
    }).toString().trim()

    if (remoteOutput.length === 0) {
      emitNervesEvent({
        component: "heart",
        event: "heart.sync_push_end",
        message: "post-turn push: committed locally, no remote configured",
        meta: { agentRoot, changedCount },
      })
      return { ok: true }
    }

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
      meta: { agentRoot, changedCount },
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
