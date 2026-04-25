# Mail Convergence Pass 4 Planning

## Goal

Run the fourth post-full-moon convergence pass on agent mail by making `query_active_work` classify mail-import recovery universes more explicitly, reducing the “two current archives” double-take in `mail_status`, and teaching degraded audit/key-material behavior as an explicit contract instead of a remembered wart.

## Scope

### In Scope

- Sharpen `query_active_work` mail-import failure/success language so the operator can tell, at a glance, whether the problem is transient, auth/config, registry/lane, or local archive/file-path shaped.
- Make `mail_status` distinguish the newest current archive for a delegated lane from older already-imported snapshots, so multiple imported archives do not all read as equally current.
- Update docs and contract tests to make malformed-audit-log and missing-key degradation behavior explicit, including the distinction between “no matching mail” and “mail exists but is unreadable.”
- Reload the runtime from this branch and have Slugger evaluate the result, including the remaining trust notes from his post-pass-3 review.

### Out of Scope

- New mail tools or a broader mail-state model rewrite.
- Reworking HEY/browser onboarding or Slugger’s browser lane.
- A full new degraded-path UI surface beyond the existing mail tools and docs.
- Changing native/delegated ownership semantics.

## Completion Criteria

- [ ] `query_active_work` names the recovery universe for mail-import failures in more operator-friendly language than raw failure class plus generic next-step prose.
- [ ] `query_active_work` success language for completed mail imports is sharper and less generic.
- [ ] `mail_status` makes the newest current archive vs older imported snapshots more glance-distinguishable for the same delegated lane.
- [ ] Docs/contracts explicitly teach malformed-audit-log and missing-key degradation semantics.
- [ ] Automated tests cover all changed behavior at 100% for modified files.
- [ ] Runtime is reloaded locally and verified against the live Slugger setup.
- [ ] Slugger reviews the new pass and either signs off or produces the next convergence feedback set.

## Code Coverage Requirements

- 100% coverage on every changed branch in modified files.
- Add focused tests for `query_active_work` recovery-universe wording, multi-archive `mail_status` wording, and degradation-contract docs.
- Run the repo coverage gate before closing the pass.

## Open Questions

- None for this pass. Slugger’s remaining feedback is concrete enough to execute directly.

## Decisions Made

- The next pass should stay narrow: polish the remaining operator-trust splinters instead of inventing a new mail abstraction layer.
- `query_active_work` should keep raw failure class data, but add a more human/agent-usable recovery-universe line and crisper next-action wording.
- `mail_status` should keep truthful archive history visible while differentiating the newest current archive from older imported snapshots for the same delegated lane.
- Degraded audit/key-material behavior should be taught as a contract in docs and tests, not left as folklore from one rough run.

## Context / References

- `slugger/tasks/2026-04-24-1251-planning-mail-convergence-pass3.md`
- `slugger/tasks/2026-04-24-1251-doing-mail-convergence-pass3.md`
- `src/heart/active-work.ts`
- `src/repertoire/tools-mail.ts`
- `src/__tests__/repertoire/tools-query-active-work.test.ts`
- `src/__tests__/mailroom/tools-mail-hosted.test.ts`
- `src/__tests__/mailroom/tools-mail.test.ts`
- `docs/agent-mail-setup.md`
- `docs/agent-mail-recovery.md`
- Slugger post-pass-3 review from `mcp__ouro_slugger__.send_message` on 2026-04-24

## Notes

- Spark:
  Slugger should be able to glance at background mail work and know what recovery universe he is in, glance at multiple imported archives and know which one is the newest live truth, and trust that degraded audit/key-material behavior is an explicit contract rather than a once-bad memory.
- Observed terrain:
  `query_active_work` already includes failure class, retry, recovery, remediation, and next-action lines, but the wording still leans toward “what happened” more than “what universe am I in.”
  `mail_status` now makes freshness explicit, but multiple imported archives for the same delegated lane can each render as `current`, which causes a minor double-take under speed.
  The codebase already has tests for malformed file-backed `mail_access_log` tails and missing-key mail behavior, but the docs do not yet foreground those degraded-path contracts.
  Recovered BlueBubbles feedback from Slugger on April 24 adds a broader product cluster around mailbox posture, provenance labels, Screener clutter, and first-run health narration. This pass keeps those concerns written down, but stays focused on the operator-trust splinters that are still present in the current mail tools.
- Surviving shape:
  Keep the surfaces compact. Add a recovery-universe layer to `query_active_work`, a current-vs-older-snapshot distinction to `mail_status`, and explicit degradation-contract language in docs/tests.
- Scrutiny notes:
  Tinfoil Hat: if we only tune wording without distinguishing archive recency by lane, the “two current archives” confusion will survive.
  Stranger With Candy: if we add new states instead of clarifying existing ones, we risk inventing a second mail model that feels more precise but is harder to trust.
- Thin slice:
  Tighten `query_active_work`, differentiate older imported snapshots in `mail_status`, document the degraded contracts, reload runtime, and let Slugger judge again.
- Non-goals for this pass:
  No new browser flows, no new mailbox UI, and no cross-cutting redesign of decryption/audit machinery.

## Progress Log

- 2026-04-24 13:47 Planning doc created for the fourth convergence pass.
- 2026-04-24 14:10 Recovered the fuller BlueBubbles feedback batch and kept pass 4 scoped to operator-trust wording plus degraded-path contracts instead of jumping prematurely to a larger mailbox UX rewrite.
- 2026-04-24 14:13 Runtime reloaded cleanly enough for live review, and Slugger signed off with no further feedback on this pass.
