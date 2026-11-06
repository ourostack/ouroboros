# diagnose-vault-expired

Vault-expired fires when a credential's revision in the vault no longer matches the revision the provider binding was issued against.

## Inputs from the finding inventory

- `typedDegraded: DegradedAgent[]` — typed degraded findings from the daemon health rollup.
- Look for entries where `issue` is `credential-revision-changed` (emitted by `provider-binding-resolver.ts`).

Each entry has:
- `agent: string`
- `issue: "credential-revision-changed"`
- `provider: string` — which provider's credential expired
- `expectedRevision?: string`
- `actualRevision?: string`

## Diagnosis

The credential the provider binding pinned has been rotated. The harness needs to re-resolve against the current vault revision.

| Sub-case | Proposed action |
|---|---|
| Vault has the credential, just at a newer revision | `vault-unlock` |
| Vault has the credential but it is itself expired (provider revoked) | `vault-replace` |
| Credential was deleted from vault entirely | `vault-create` |

The LLM has to decide between these based on the `actualRevision` value (present → unlock or replace; absent → create). When uncertain, default to `vault-unlock` and let the operator escalate.

## Proposed action shapes

```json
{
  "kind": "vault-unlock",
  "agent": "slugger",
  "provider": "anthropic",
  "reason": "credential-revision-changed: pinned rev abc123, current rev def456"
}
```

```json
{
  "kind": "vault-replace",
  "agent": "slugger",
  "provider": "anthropic",
  "reason": "credential-revision-changed: provider revoked rev abc123, no replacement in vault"
}
```

```json
{
  "kind": "vault-create",
  "agent": "slugger",
  "provider": "anthropic",
  "reason": "credential-revision-changed: vault has no credential for this provider"
}
```

## Recovery escalation

If `vault-unlock` fails, the operator can re-run with `vault-recover` (recovers from backup state). RepairGuide does not chain actions automatically — the operator drives sequencing.
