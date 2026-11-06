/**
 * Sync failure taxonomy classifier — Layer 2 of the harness-hardening sequence.
 *
 * Pure pattern-matcher over (error, context) that turns common git failure
 * shapes into the locked taxonomy variants. Used by `runBootSyncProbe` (the
 * `ouro up` pre-flight pull orchestrator) and by `postTurnPush`'s legacy
 * push-rejected/conflict path so both producers share one vocabulary.
 *
 * Pattern priority — most actionable / specific wins:
 *   1. Abort signal (timeout-soft / timeout-hard) — caller explicitly aborted.
 *   2. not-found-404 — 404 / "Repository not found": remote endpoint gone.
 *   3. auth-failed — 401 / 403 / "Authentication failed".
 *   4. network-down — ENOTFOUND / ECONNREFUSED / "Could not resolve host".
 *   5. dirty-working-tree — "would be overwritten" / "stash them".
 *   6. merge-conflict — CONFLICT marker in stderr (also collects file list).
 *   7. non-fast-forward — "non-fast-forward" / "fetch first".
 *   8. unknown — fallthrough.
 *
 * The classifier never throws and never writes to disk. It calls
 * `git status --porcelain=v1` only when it has already classified the error
 * as a merge conflict, to enumerate unmerged paths for the consumer.
 */

import { execFileSync } from "child_process"

/**
 * Locked Layer-2 taxonomy. Includes legacy variants (`push_rejected`,
 * `pull_rebase_conflict`, `unknown`) so the sync.ts `PendingSyncRecord`
 * union can be the same shape — additive extension, no breaking change.
 */
export type SyncClassification =
  | "auth-failed"
  | "not-found-404"
  | "network-down"
  | "dirty-working-tree"
  | "non-fast-forward"
  | "merge-conflict"
  | "timeout-soft"
  | "timeout-hard"
  | "push_rejected"
  | "pull_rebase_conflict"
  | "unknown"

export interface SyncContext {
  /** Bundle root (used to enumerate rebase conflict files via git status). */
  agentRoot: string
  /**
   * When the caller knows the error came from `AbortSignal`, indicates whether
   * it was the soft-warning timeout or the hard-cut timeout. Defaults to
   * "hard" if the error is an AbortError but the caller didn't disambiguate.
   */
  abortReason?: "soft" | "hard"
}

export interface SyncClassificationResult {
  classification: SyncClassification
  /** Original error message (or stringified non-Error throw). */
  error: string
  /** Conflict file list — populated only for `merge-conflict` results. */
  conflictFiles: string[]
}

/**
 * Enumerate unmerged paths via `git status --porcelain=v1`. Pulled out as a
 * pure helper so the classifier can be tested without a live git repo (the
 * caller mocks `child_process.execFileSync`).
 *
 * Mirrors `sync.ts:collectRebaseConflictFiles` — kept as a separate copy here
 * so this module has zero internal dep on `sync.ts`. The caller of
 * `classifySyncFailure` doesn't see the duplication; the runtime cost is one
 * git invocation per merge-conflict classification, same as before.
 */
function collectConflictFiles(agentRoot: string): string[] {
  try {
    const output = execFileSync("git", ["status", "--porcelain=v1"], {
      cwd: agentRoot,
      stdio: "pipe",
      timeout: 5000,
    }).toString()
    const files: string[] = []
    for (const line of output.split("\n")) {
      // Unmerged paths in porcelain v1 are prefixed with UU/AA/DD/AU/UA/DU/UD.
      if (/^(UU|AA|DD|AU|UA|DU|UD) /.test(line)) {
        files.push(line.slice(3).trim())
      }
    }
    return files
  } catch {
    /* v8 ignore next -- defensive: git status failure inside a git repo would require a corrupt repo @preserve */
    return []
  }
}

function isAbortError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false
  const candidate = error as { name?: unknown; code?: unknown }
  if (candidate.name === "AbortError") return true
  if (candidate.code === "ABORT_ERR") return true
  return false
}

function readMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === "string") return error
  if (error === null || error === undefined) return String(error)
  try {
    return JSON.stringify(error)
  } catch {
    /* v8 ignore next -- defensive: JSON.stringify only fails on circular/BigInt; real-world git errors don't trigger it @preserve */
    return String(error)
  }
}

function readErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined
  const code = (error as { code?: unknown }).code
  return typeof code === "string" ? code : undefined
}

/**
 * Classify a sync failure into one of the locked taxonomy variants.
 *
 * Pure: never throws, never writes. Calls `git status` only when the error
 * was already classified as a merge conflict, to enumerate unmerged files.
 */
export function classifySyncFailure(
  error: unknown,
  context: SyncContext,
): SyncClassificationResult {
  const message = readMessage(error)
  const errorCode = readErrorCode(error)

  // 1. Abort signal — highest priority. Caller's signal trumps content match.
  if (isAbortError(error)) {
    const reason = context.abortReason ?? "hard"
    return {
      classification: reason === "soft" ? "timeout-soft" : "timeout-hard",
      error: message,
      conflictFiles: [],
    }
  }

  // Lowercased copy for case-insensitive substring matching.
  const lower = message.toLowerCase()

  // 2. Not-found-404 — most actionable diagnosis when both 404 and other
  // signals are present. "404" and "Repository not found" are the canonical
  // shapes.
  if (lower.includes("404") || lower.includes("repository not found")) {
    return {
      classification: "not-found-404",
      error: message,
      conflictFiles: [],
    }
  }

  // 3. Auth failed — 401 / 403 / "Authentication failed" / "Permission denied".
  if (
    lower.includes("401")
    || lower.includes("403")
    || lower.includes("authentication failed")
    || lower.includes("permission denied")
  ) {
    return {
      classification: "auth-failed",
      error: message,
      conflictFiles: [],
    }
  }

  // 4. Network down — DNS / connection errors.
  if (
    errorCode === "ENOTFOUND"
    || errorCode === "ECONNREFUSED"
    || lower.includes("enotfound")
    || lower.includes("econnrefused")
    || lower.includes("could not resolve host")
    || lower.includes("connection refused")
  ) {
    return {
      classification: "network-down",
      error: message,
      conflictFiles: [],
    }
  }

  // 5. Dirty working tree — pull / merge would clobber uncommitted changes.
  if (
    lower.includes("would be overwritten")
    || lower.includes("commit your changes or stash them")
  ) {
    return {
      classification: "dirty-working-tree",
      error: message,
      conflictFiles: [],
    }
  }

  // 6. Merge conflict — CONFLICT marker in stderr. Collect unmerged files.
  if (lower.includes("conflict")) {
    return {
      classification: "merge-conflict",
      error: message,
      conflictFiles: collectConflictFiles(context.agentRoot),
    }
  }

  // 7. Non-fast-forward — push rejected because remote moved.
  if (
    lower.includes("non-fast-forward")
    || lower.includes("fetch first")
    || lower.includes("rejected")
  ) {
    return {
      classification: "non-fast-forward",
      error: message,
      conflictFiles: [],
    }
  }

  // 8. Fallthrough.
  return {
    classification: "unknown",
    error: message,
    conflictFiles: [],
  }
}
