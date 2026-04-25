# Mail Convergence Pass 3 Planning

## Goal

Run the third post-full-moon convergence pass on agent mail by turning `mail_status` from inferential freshness truth into explicit freshness truth, making archive identity self-explaining when filenames and delegated bindings diverge, and re-proving the exact hosted family-link sender-policy path Slugger still does not trust in practice.

## Scope

### In Scope

- Make `mail_status` explicitly classify archive freshness for delegated mail instead of forcing the operator to mentally compare archive mtimes and import operations.
- Add identity/mapping explanation in `mail_status` when a discovered archive filename implies one account while the recorded owner/source binding says another.
- Strengthen hosted Screener/family decision proof on the exact `link-friend` happy path so `registryPath missing` residue cannot hide under an adjacent test.
- Update docs and tests so the repaired freshness and identity model is taught directly.
- Reload the live runtime and have Slugger evaluate the result, including the exact concerns he raised in his post-pass-2 review.

### Out of Scope

- New generic browser-download infrastructure outside mail.
- A large Mailbox UI redesign.
- Broad rework of decryption/missing-key surfaces outside what is directly needed for truthful mail-status/archive identity guidance.
- HEY onboarding or export automation changes.

## Completion Criteria

- [ ] `mail_status` explicitly answers whether a delegated archive is imported/current, newer than the last import, or ambiguous/stale-risky.
- [ ] `mail_status` explains why an archive is mapped to a delegated owner/source when the filename suggests a different account label.
- [ ] Hosted family-link sender-policy proof covers the exact `link-friend` path without any `registryPath missing` smell.
- [ ] Docs and contract tests teach the stronger freshness/identity model.
- [ ] Automated tests cover all changed behavior at 100% for modified files.
- [ ] Runtime is reloaded locally and verified against the live Slugger setup.
- [ ] Slugger reviews the new pass and either signs off or produces the next convergence feedback set.

## Code Coverage Requirements

- 100% coverage on every changed branch in modified files.
- Add focused tests for archive freshness language, filename-vs-binding identity explanation, and hosted `link-friend` sender-policy persistence.
- Run the repo coverage gate before closing the pass if touched branches widen beyond focused verification.

## Open Questions

- None for this pass. The user explicitly requested continuous convergence loops without pausing for approval gates mid-run.

## Decisions Made

- Freshness truth belongs in `mail_status` itself, not in docs or operator folklore.
- Archive identity explanation should teach that delegated binding comes from the explicit owner/source lane, not from the local filename alone.
- The hosted sender-policy proof must exercise the exact family/link path Slugger mistrusted, not a nearby allow-sender surrogate.
- This pass will prefer compact operational wording over a larger new mail state model.

## Context / References

- `slugger/tasks/2026-04-24-1136-planning-mail-convergence-pass2.md`
- `slugger/tasks/2026-04-24-1136-doing-mail-convergence-pass2.md`
- `src/repertoire/tools-mail.ts`
- `src/mailroom/reader.ts`
- `src/mailroom/source-state.ts`
- `src/heart/background-operations.ts`
- `src/__tests__/mailroom/tools-mail-hosted.test.ts`
- `docs/agent-mail-setup.md`
- `docs/agent-mail-recovery.md`
- Slugger post-pass-2 review from `mcp__ouro_slugger__.send_message` on 2026-04-24

## Notes

- Spark:
  Slugger should be able to look at `mail_status` and know, without mental arithmetic, whether delegated HEY archive state is current, stale, or suspicious, and why a given local file maps to a particular delegated lane.
- Observed terrain:
  `mail_status` currently reports imported vs `ready (newer than last import ...)`, but the operator still has to infer whether the archive is the newest known one for that owner/source.
  Archive status currently records owner/source from the import operation, but it does not explain when the filename hint disagrees with the delegated binding.
  Hosted sender-policy persistence is fixed in generic hosted tests, but the exact `link-friend` family path Slugger remembers was not re-proven explicitly.
- Surviving shape:
  Keep the primitive small: teach archive freshness and archive identity inline in `mail_status`, and add the exact hosted family-link proof test instead of inventing a new state machine.
- Scrutiny notes:
  Tinfoil Hat: if freshness stays implicit, operators will still misread “imported once” as “current enough.”
  Stranger With Candy: a generic filename parser would look clever but would lie; the truthful rule is “binding comes from the explicit delegated lane, filename is only a hint.”
- Thin slice:
  Add freshness classification and mapping notes to `mail_status`, add exact hosted `link-friend` proof coverage, update docs, reload runtime, and let Slugger try again.
- Non-goals for this pass:
  New browser abstractions, broad decryption-state redesign, and any change that muddles native vs delegated ownership.

## Progress Log

- 2026-04-24 12:51 Planning doc created for the third convergence pass.
