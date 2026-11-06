# diagnose-sync-blocked

Sync-blocked fires when the local working tree state prevents the boot sync probe from completing — even though the remote itself is reachable.

## Inputs from the finding inventory

The user message includes a `bootSyncFindings` JSON block when sync probe surfaced any findings. Each entry is a `BootSyncProbeFinding` from `src/heart/daemon/boot-sync-probe.ts`:

```ts
interface BootSyncProbeFinding {
  agent: string
  classification: SyncClassification
  error: string                // original error text from git stderr
  conflictFiles: string[]      // populated only for merge-conflict
  warnings: string[]           // soft-timeout warnings
  advisory: boolean            // hint for routing; not a blocking signal
}
```

This skill handles entries where `classification` is one of:
- `dirty-working-tree` — uncommitted changes in the bundle
- `non-fast-forward` — local commits ahead of remote
- `merge-conflict` — pull would conflict / rebase failed (look at `conflictFiles[]` for the file list)
- `timeout-soft` — pull was slow (warning fired) but completed; included here because it's a working-tree-side performance signal, not a remote failure

For all four, `advisory` is `true` (warn-and-continue: the agent likely still works on cached state, but the bundle is out of sync until resolved).

## Diagnosis

| `classification` | Likely cause | Proposed action |
|---|---|---|
| `dirty-working-tree` | Operator has uncommitted edits in the bundle | No typed action — operator must commit or stash. Surface in `notes`. |
| `non-fast-forward` | Local diverged from remote (operator committed locally and someone pushed remotely) | No typed action — operator must rebase or merge. Surface in `notes`. |
| `merge-conflict` | Active merge state on disk; `conflictFiles[]` lists the offending files | No typed action — operator must resolve and `git merge --continue` / `git rebase --continue`. Surface in `notes` with the file list. |
| `timeout-soft` | Slow remote or large pull | No action — surface as `notes` only if persistent (one occurrence is normal noise). |

## Notes-only output (the common case)

All four classifications require human-driven resolution. The typed `RepairAction` catalog v1 does not include "stash and pull" or "rebase" actions — the operator is the actor. Use `notes` entries:

```
slugger: dirty working tree — commit or stash before sync resumes (error: "Your local changes to the following files would be overwritten by merge: psyche/SOUL.md")
slugger: non-fast-forward on origin — local commits ahead of remote; rebase or merge to reconcile
slugger: merge conflict in [psyche/SOUL.md, skills/diagnose-broken-remote.md] — resolve and `git rebase --continue`
slugger: pull was slow (>8s) on this boot — investigate if persistent
```

## Cross-skill boundary

This skill ONLY handles findings about the local working tree state and pull-time performance (`dirty-working-tree`, `non-fast-forward`, `merge-conflict`, `timeout-soft`). Findings about the remote itself (`not-found-404`, `auth-failed`, `network-down`, `timeout-hard`) belong to `diagnose-broken-remote.md`. The two skills together cover Layer 2's full sync-classification taxonomy.

## Why this is a separate skill

Bundling remote and working-tree concerns into one skill conflates two different operator stories: "fix the remote" (configuration / credentials) vs "clean up local edits" (workflow). Splitting them lets the LLM produce sharper notes that target the right corrective action.
