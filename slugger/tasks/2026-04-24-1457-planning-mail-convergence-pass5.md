# Mail Convergence Pass 5 Planning

## Goal

Run the fifth convergence pass on agent mail by making delegated historical retrieval behave the way Slugger naturally reaches for it during real work: wide-corpus search first, simple `OR` disjunctions for messy human query strings, and operator guidance that teaches the difference between recency inspection and archive retrieval.

## Scope

### In Scope

- Make delegated `mail_search` search the full visible scoped corpus instead of a recent-window slice so older imported HEY travel mail remains reachable in a busy mailbox.
- Support simple `OR` disjunction query strings because that is how Slugger naturally searched when trying to pull together trip bookings from mixed airline and confirmation-code clues.
- Tighten tests and docs around the retrieval model, including the fact that `mail_recent` is for recency inspection while `mail_search` is the historical retrieval tool.
- Reload the runtime from this branch and watch the audited iMessage lane while Slugger retries the summer-travel update from email.

### Out of Scope

- Doing the travel-update work for Slugger.
- Changing HEY onboarding, browser download behavior, or import semantics in this pass.
- Adding a richer mail query language than simple disjunction support.
- Reworking mail provenance, lane ownership, or native/delegated semantics.

## Completion Criteria

- [ ] Delegated `mail_search` can find older imported travel mail even when many newer delegated messages exist.
- [ ] `mail_search` supports simple `OR`-joined query strings that match when any term is present.
- [ ] Docs/tests teach the recency-vs-retrieval distinction explicitly enough to avoid future operator churn.
- [ ] Modified files remain at 100% coverage, including changed branches.
- [ ] Runtime is reloaded locally from this worktree and verified healthy.
- [ ] Slugger retries the summer-travel update in the audited iMessage lane, and either updates the travel plan artifacts or exposes the next concrete blocker.

## Code Coverage Requirements

- 100% coverage on every changed branch in modified files.
- Add regression tests for buried historical delegated mail and for `OR` query behavior.
- Run focused verification first, then the repo coverage gate before closing the pass.

## Open Questions

- None for this pass. Slugger’s observed behavior in the audited lane gave us the shape directly.

## Decisions Made

- Prefer matching Slugger’s natural retrieval behavior over teaching him a more precious query ritual.
- Keep `OR` support intentionally small and literal for now; the point is retrieval ergonomics, not a full search language.
- Preserve the boundary: Slugger does the travel-update work; this pass only fixes the mail/tooling experience around him.

## Context / References

- `slugger/tasks/2026-04-24-1347-planning-mail-convergence-pass4.md`
- `slugger/tasks/2026-04-24-1347-doing-mail-convergence-pass4.md`
- `src/repertoire/tools-mail.ts`
- `src/mailroom/file-store.ts`
- `src/mailroom/blob-store.ts`
- `src/__tests__/mailroom/hey-golden-path.test.ts`
- `src/__tests__/mailroom/tools-mail.test.ts`
- `docs/agent-mail-recovery.md`
- Audited Messages thread with Slugger on 2026-04-24 showing `mail_search` use with mixed confirmation codes and `OR` disjunctions

## Notes

- Spark:
  Slugger should be able to search for summer travel the way a real assistant would under time pressure: throw a handful of codes, airline names, and place names into one search, hit the historical archive, and get useful results instead of a polite dead end.
- Observed terrain:
  The import lane and provenance model are real, but `mail_search` had two quiet ergonomics mismatches with live use: it searched only a recent slice and it treated `OR` as just more literal text.
  The audited iMessage lane already told us the right behavior shape because Slugger naturally tried `9FLJTF OR 24LEBB OR 2433516539 OR Edelweiss OR Aer Lingus ...`.
- Surviving shape:
  Search the full visible corpus, support simple disjunctions, keep docs crisp about when to use `mail_recent` versus `mail_search`, and then let Slugger retry without hand-holding.
- Scrutiny notes:
  Tinfoil Hat: if we only widen the corpus but leave the literal query behavior untouched, Slugger still fails on the exact search style he reached for.
  Stranger With Candy: if we overreact and add a mini search language, we risk making retrieval look smarter while actually getting harder to trust.
- Thin slice:
  Full-corpus delegated search, small `OR` support, explicit docs, runtime reload, watched retry.
- Non-goals for this pass:
  No travel-doc edits by the mechanic, no browser intervention, and no search-parser ambition beyond what the lane actually asked for.

## Progress Log

- 2026-04-24 14:57 Planning doc created for the fifth convergence pass.
