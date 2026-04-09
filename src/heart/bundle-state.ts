/**
 * Bundle state detection: inspects an agent bundle's git + pending-sync
 * state and returns a structured list of issues the agent needs to remediate
 * via its `bundle_*` tools.
 *
 * Previously the sync pipeline surfaced a single free-form `syncFailure`
 * string that was good for humans but hard for the agent to act on. The
 * new `BundleStateIssue` enum lets the agent pattern-match on discrete
 * cases and pick the correct remediation tool (shipping in PR 6).
 *
 * Detection never throws: every git call is wrapped in try/catch so a
 * broken bundle or a missing git binary degrades to an empty array or a
 * `not_a_git_repo` signal rather than exploding the turn pipeline.
 *
 * The classification returned here is the subset that's detectable purely
 * from bundle state:
 *
 *   - `not_a_git_repo`: `.git` directory missing.
 *   - `no_remote_configured`: `git remote` returns empty.
 *   - `first_commit_never_happened`: `.git` exists but `git rev-parse HEAD`
 *     fails (fresh `git init` with nothing committed).
 *   - `pending_sync_exists`: `state/pending-sync.json` exists — the agent
 *     should inspect it and clear the pending state.
 *
 * Future extensions (deferred to a follow-up PR):
 *   - `remote_push_failed` / `pull_rebase_conflict`: derived from the
 *     `classification` field of pending-sync.json once sync.ts writes it.
 */
import { execFileSync } from "child_process"
import * as fs from "fs"
import * as path from "path"
import { emitNervesEvent } from "../nerves/runtime"

export type BundleStateIssue =
  | "not_a_git_repo"
  | "no_remote_configured"
  | "first_commit_never_happened"
  | "pending_sync_exists"

export interface DetectBundleStateDeps {
  execFileSync?: (file: string, args: string[], options: { cwd: string; stdio: "pipe"; timeout: number }) => Buffer
  existsSync?: (p: string) => boolean
}

export function detectBundleState(agentRoot: string, deps: DetectBundleStateDeps = {}): BundleStateIssue[] {
  const exec = deps.execFileSync ?? execFileSync
  const exists = deps.existsSync ?? fs.existsSync
  const issues: BundleStateIssue[] = []

  emitNervesEvent({
    component: "heart",
    event: "heart.bundle_state_detect_start",
    message: "detecting bundle state",
    meta: { agentRoot },
  })

  const gitDir = path.join(agentRoot, ".git")
  const isGitRepo = exists(gitDir)

  if (!isGitRepo) {
    issues.push("not_a_git_repo")
  } else {
    // Check remote presence
    try {
      const remoteOutput = exec("git", ["remote"], {
        cwd: agentRoot,
        stdio: "pipe",
        timeout: 5000,
      }).toString().trim()
      if (remoteOutput.length === 0) {
        issues.push("no_remote_configured")
      }
    } catch {
      // Git missing or broken — treat as no_remote_configured so the
      // agent surfaces a "fix git" signal rather than a silent pass.
      issues.push("no_remote_configured")
    }

    // Check for initial commit
    try {
      exec("git", ["rev-parse", "HEAD"], {
        cwd: agentRoot,
        stdio: "pipe",
        timeout: 5000,
      })
    } catch {
      issues.push("first_commit_never_happened")
    }
  }

  // Pending-sync file — independent of git state (could exist on a bundle
  // that was a repo and then had its .git deleted).
  const pendingSyncPath = path.join(agentRoot, "state", "pending-sync.json")
  if (exists(pendingSyncPath)) {
    issues.push("pending_sync_exists")
  }

  emitNervesEvent({
    component: "heart",
    event: "heart.bundle_state_detect_end",
    message: `bundle state detected: ${issues.length} issue(s)`,
    meta: { agentRoot, issues },
  })

  return issues
}

/**
 * First-person remediation hint text for the start-of-turn packet. Reads
 * as the agent's own voice per the "declarative first-person" memory rule.
 * Returns empty string when there are no issues (so the packet renderer
 * can skip the section entirely).
 */
export function renderBundleStateHint(issues: BundleStateIssue[]): string {
  if (issues.length === 0) return ""

  const labels: Record<BundleStateIssue, string> = {
    not_a_git_repo: "not a git repo",
    no_remote_configured: "no remote configured",
    first_commit_never_happened: "first commit never happened",
    pending_sync_exists: "pending sync from a prior turn",
  }

  const list = issues.map((issue) => labels[issue]).join(", ")
  return (
    `my bundle has unresolved git state: ${list}. ` +
    `i have the bundle_* tools available to fix this — i should run ` +
    `bundle_check_sync_status first, then use the appropriate remediation tool.`
  )
}
