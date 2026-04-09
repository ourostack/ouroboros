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
 * On-disk schema for `state/pending-sync.json`. Written when a post-turn
 * push fails irrecoverably so the agent can see a structured signal on
 * the next turn via bundle state detection.
 *
 * Backward compat: readers should tolerate entries without `classification`
 * or `conflictFiles` (pre-alpha.289 schema) — they fall back to "unknown".
 */
export interface PendingSyncRecord {
  error: string
  failedAt: string
  classification: "push_rejected" | "pull_rebase_conflict" | "unknown"
  conflictFiles: string[]
}

function writePendingSync(
  agentRoot: string,
  error: string,
  classification: PendingSyncRecord["classification"],
  conflictFiles: string[],
): void {
  const pendingSyncPath = path.join(agentRoot, "state", "pending-sync.json")
  fs.mkdirSync(path.join(agentRoot, "state"), { recursive: true })
  const record: PendingSyncRecord = {
    error,
    failedAt: new Date().toISOString(),
    classification,
    conflictFiles,
  }
  fs.writeFileSync(pendingSyncPath, JSON.stringify(record, null, 2), "utf-8")
}

function collectRebaseConflictFiles(agentRoot: string): string[] {
  try {
    const output = execFileSync("git", ["status", "--porcelain=v1"], {
      cwd: agentRoot,
      stdio: "pipe",
      timeout: 5000,
    }).toString()
    const files: string[] = []
    for (const line of output.split("\n")) {
      // Unmerged paths in porcelain v1 are prefixed with UU/AA/DD/AU/UA/DU/UD
      if (/^(UU|AA|DD|AU|UA|DU|UD) /.test(line)) {
        files.push(line.slice(3).trim())
      }
    }
    return files
  } catch {
    /* v8 ignore next -- git status --porcelain failure inside a repo would require a corrupt repo @preserve */
    return []
  }
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
      let rebaseError: string | null = null
      try {
        execFileSync("git", ["pull", "--rebase", config.remote], {
          cwd: agentRoot,
          stdio: "pipe",
          timeout: 30000,
        })
      } catch (err) {
        rebaseError = err instanceof Error ? err.message : String(err)
      }

      if (rebaseError === null) {
        try {
          execFileSync("git", ["push", config.remote], {
            cwd: agentRoot,
            stdio: "pipe",
            timeout: 30000,
          })
          // rebase + retry push both succeeded — fall through to success
          emitNervesEvent({
            component: "heart",
            event: "heart.sync_push_end",
            message: "post-turn push complete after rebase retry",
            meta: { agentRoot, changedCount },
          })
          return { ok: true }
        } catch (retryErr) {
          // Second push rejected — remote advanced again during rebase
          const retryError = retryErr instanceof Error ? retryErr.message : /* v8 ignore next -- defensive non-Error catch @preserve */ String(retryErr)
          writePendingSync(agentRoot, retryError, "push_rejected", [])
          emitNervesEvent({
            component: "heart",
            event: "heart.sync_push_error",
            message: "post-turn push failed after retry: push_rejected",
            meta: { agentRoot, error: retryError, classification: "push_rejected" },
          })
          return { ok: false, error: retryError }
        }
      }

      // Rebase failed — detect conflict files via git status. Preserve
      // the original rebase error message so callers see the real cause.
      const conflictFiles = collectRebaseConflictFiles(agentRoot)
      const classification: PendingSyncRecord["classification"] =
        conflictFiles.length > 0 ? "pull_rebase_conflict" : "unknown"
      writePendingSync(agentRoot, rebaseError, classification, conflictFiles)

      emitNervesEvent({
        component: "heart",
        event: "heart.sync_push_error",
        message: `post-turn push failed: ${classification}`,
        meta: { agentRoot, error: rebaseError, classification, conflictFiles },
      })

      return { ok: false, error: rebaseError }
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
