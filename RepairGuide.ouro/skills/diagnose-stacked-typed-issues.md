# diagnose-stacked-typed-issues

This skill is the catch-all for compound situations: when an agent has three or more typed degraded findings stacked at once, the activation contract fires (`typedDegraded.length >= 3`) and RepairGuide is asked to triage.

## Inputs from the finding inventory

- The full `typedDegraded: DegradedAgent[]` set.
- Any sync-probe or vault-related entries described in the sibling skills.

## Triage strategy

Stacked typed issues usually have one root cause and several downstream consequences. Examples:

1. **Vault expired → provider auth fails → retry loop** — `credential-revision-changed` is the root; `provider-auth` and provider failures are downstream. Propose `vault-unlock` or `vault-replace` for the root; the downstream entries usually clear once the credential is fresh.
2. **Provider rotated key → old vault → provider failures** — root is `vault-replace`; live checks will recover after the credential is fresh.
3. **Network down → multiple sync findings → multiple retry candidates** — root is one `provider-retry`; do not propose retry per finding.

## Output strategy

When you can identify a clear root cause:
- Emit ONE action targeting the root.
- Add a `notes` entry naming the downstream entries you believe will clear: "I expect provider-auth and live checks to resolve after vault-unlock; verify by re-running `ouro up`."

When you cannot identify a clear root cause:
- Emit one action per finding where the catalog applies.
- Add `notes` describing why you fanned out instead of consolidating.

## Why this skill exists

Without it, the LLM proposes one action per finding, which floods the interactive-repair surface and makes the operator triage. With it, the LLM is nudged to look for the root cause first.

## When NOT to fire

- If the activation contract fired solely on `untypedDegraded.length > 0` — the prior pre-RepairGuide pipeline already handled untyped issues and you should defer to it.
- If `typedDegraded.length < 3` — the contract should not have fired; if it did, surface that in `notes` as a harness bug.
