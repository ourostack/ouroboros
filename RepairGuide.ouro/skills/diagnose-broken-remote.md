# diagnose-broken-remote

Broken-remote fires when the configured git remote for an agent's bundle cannot be reached or rejects auth.

## Inputs from the finding inventory

The user message includes a `bootSyncFindings` JSON block when sync probe surfaced any findings. Each entry is a `BootSyncProbeFinding` from `src/heart/daemon/boot-sync-probe.ts`:

```ts
interface BootSyncProbeFinding {
  agent: string
  classification: SyncClassification
  error: string                // original or synthesised error text
  conflictFiles: string[]      // populated only for merge-conflict
  warnings: string[]           // soft-timeout warnings
  advisory: boolean            // hint for routing; not a blocking signal
}
```

The remote URL itself is NOT a field on `BootSyncProbeFinding` — extract it from the `error` text when present (e.g., `git`'s 404 message includes the URL).

This skill handles entries where `classification` is one of:
- `not-found-404` — remote responds 404 (URL stale, repo deleted, wrong account)
- `auth-failed` — 401/403/permission denied; credentials revoked or rotated
- `network-down` — `ENOTFOUND` / `ECONNREFUSED` / DNS/socket failure
- `timeout-hard` — abort cut the op (the remote was hung; could be transient or genuinely down)

For each of these, `advisory` is `false` (blocking — agent can't sync until fixed). For local-tree problems (dirty/non-FF/conflict), see `diagnose-sync-blocked.md`.

## Diagnosis

| `classification` | Likely cause | Proposed action |
|---|---|---|
| `not-found-404` | Remote URL stale or repo deleted/renamed | No typed action; surface in `notes` with the URL extracted from `error` text |
| `auth-failed` | Credentials revoked or rotated | `provider-auth` if the auth context is a provider credential; otherwise `notes` |
| `network-down` | Transient | `provider-retry` to re-attempt after backoff |
| `timeout-hard` | Hung remote / very slow remote | `provider-retry` (transient) OR `notes` (if persistent) |

## Proposed action shape

```json
{
  "kind": "provider-retry",
  "agent": "slugger",
  "reason": "boot sync probe: network-down on slugger.ouro (transient — DNS resolution failed)"
}
```

The `kind` must be one of the typed catalog values from `src/heart/daemon/readiness-repair.ts` (e.g., `provider-auth`, `provider-retry`, `provider-use`). Anything else gets dropped by `parseRepairProposals` with a warning.

## Notes-only cases

For `not-found-404` (no typed action available), emit a `notes` entry, citing the URL parsed out of the `error` field when possible:

```
slugger: origin returns 404 — verify the URL is current or push to a fresh remote (error: "fatal: repository 'https://github.com/me/old-repo.git/' not found")
```

The harness surfaces these as advisory text in the boot summary.

## Cross-skill boundary

This skill ONLY handles findings about the remote itself (remote URL, network, auth-to-remote, hung remote). Findings about the local working tree state (`dirty-working-tree`, `non-fast-forward`, `merge-conflict`, `timeout-soft`) belong to `diagnose-sync-blocked.md`.
