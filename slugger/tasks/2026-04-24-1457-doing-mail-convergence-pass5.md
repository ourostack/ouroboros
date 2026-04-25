# Mail Convergence Pass 5 Doing

Planning: `slugger/tasks/2026-04-24-1457-planning-mail-convergence-pass5.md`
Execution Mode: direct
Artifacts: `slugger/tasks/2026-04-24-1457-doing-mail-convergence-pass5/`

## Goal

Execute the fifth convergence pass on agent mail by aligning delegated historical retrieval with the way Slugger actually searches during live work.

## Completion Criteria

- [x] Delegated `mail_search` finds older imported travel mail beyond the recent-window slice.
- [x] `mail_search` supports simple `OR` disjunction queries that match when any term appears.
- [x] Docs/tests clearly teach `mail_recent` versus `mail_search`.
- [x] Coverage gate passes at 100% on changed code paths.
- [x] Local runtime is rebuilt/reloaded and live-verified against Slugger’s setup.
- [x] Slugger retries the summer-travel update in the audited iMessage lane and either updates the plan artifacts or produces the next real blocker.

## Code Coverage Requirements

- 100% coverage on new and modified code paths.
- Focus tests on historical delegated retrieval, `OR` query behavior, and retrieval-model docs.
- Run focused verification first, then the repo coverage gate.

## Units

### ✅ Unit 1a: Historical retrieval red tests

What:
- Add failing tests that bury delegated travel mail beneath a large newer message set and prove `mail_search` still finds it.

Acceptance:
- The previous recent-window behavior fails until the retrieval change lands.

### ✅ Unit 1b: Historical retrieval implementation

What:
- Make `mail_search` operate over the full visible scoped corpus instead of a recent-window slice.

Acceptance:
- Older imported HEY travel mail stays searchable inside a noisy delegated mailbox.

### ✅ Unit 2a: Natural-query red tests

What:
- Add failing tests for the simple `OR` disjunction pattern Slugger used in the audited travel-update lane.

Acceptance:
- The literal-only implementation fails until the disjunction support lands.

### ✅ Unit 2b: Natural-query implementation and coverage closeout

What:
- Implement small, literal `OR` disjunction support, remove any unreachable helper branches, and close the remaining coverage gap honestly.

Acceptance:
- The changed retrieval logic is fully covered at 100% without fake branches or fake tests.

### ✅ Unit 3a: BlueBubbles stranded-inbound recovery fix

What:
- Separate BlueBubbles inbound capture from handled-message truth so a captured iMessage is not silently treated as completed work, then add honest recovery for captured-but-unprocessed messages.

Acceptance:
- The inbound sidecar remains audit truth only.
- Duplicate suppression still blocks expensive double-processing.
- A captured but unhandled iMessage can be recovered without a human resend or mechanic nudge.

### ⬜ Unit 3b: Runtime reload and watched Slugger retry

What:
- Reload the runtime from this worktree, verify live health, and watch the audited iMessage lane while Slugger retries the summer travel update from mail.

Acceptance:
- Live runtime reflects the retrieval fixes.
- Slugger either updates the travel plan artifacts or exposes the next concrete blocker through the audited lane.

## Notes

- Match Slugger’s natural behavior; do not teach around the bug.
- Keep the boundary sharp: mechanic fixes tooling, Slugger does the actual travel work.
- Prefer tiny truthful semantics over a grand search-language detour.

## Progress Log

- 2026-04-24 14:57 Doing doc created for the fifth convergence pass.
- 2026-04-24 14:57 Units 1a, 1b, and 2a were already substantially underway in the live pass and were captured here to preserve the paper trail before closing the remaining coverage/runtime/retry work.
- 2026-04-24 17:03 Convergence resumed after the audited travel-update lane stalled again. The real runtime bug was not "Slugger needs nudging"; BlueBubbles was treating the inbound sidecar as both capture log and completion marker, which let a live iMessage be stranded after capture.
- 2026-04-24 17:25 The current live blocker is delegated `mail_search`, not BlueBubbles. Slugger searched for exact travel identifiers (`9FLJTF`, `24LEBB`, `2433516539`) from the audited iMessage lane and hit hosted Mailroom failures like `download messages/... timed out after 20000ms` and `RestError: Error reading response as text: aborted`.
- 2026-04-24 17:25 Live evidence check:
  - the primary HEY archive `.playwright-mcp/HEY-emails-ari-mendelow-me.mbox` definitely contains the missing Aer Lingus / hotel identifiers;
  - local mail-search cache only has a small warm subset instead of the full historical corpus;
  - successful import operations exist and point at the right `.playwright-mcp` archive;
  - therefore the repair target is the delegated historical search lane, not Slugger's behavior.
- 2026-04-24 17:25 Patch shape for Unit 3b:
  - make archive-hydrated delegated search cheap enough to use on real HEY exports instead of reconstructing every message before the first text match;
  - avoid letting a partial cached result block imported-archive search when the search scope still includes delegated mail;
  - reload runtime and watch the audited lane until Slugger updates the travel artifacts from mail evidence.
- 2026-04-24 18:10 Unit 3a is now honestly green:
  - `npm test -- --run src/__tests__/mailroom/mbox-import.test.ts src/__tests__/mailroom/tools-mail-hosted.test.ts src/__tests__/senses/bluebubbles/index.test.ts` passed during the tightening loop;
  - `npm run test:coverage` passed with the repo's 100% code-coverage gate and `nerves audit: pass`;
  - the last residue was not another mail bug, but two impossible-for-webhook guard branches in `src/senses/bluebubbles/index.ts` plus one real guidless-sidecar recovery path, which are now captured by the code/tests instead of left as murky defensive ghosts.
- 2026-04-24 18:10 Next live step:
  - commit this convergence unit;
  - reload the daemon from this worktree so Slugger is no longer on the stale 14:57 runtime;
  - then watch the audited iMessage lane for either autonomous resumption or the next concrete blocker.
- 2026-04-24 18:27 Slugger's next blocker was finally truthful and specific: the booking emails were already present in `state/mail-search/` with exact hits for `9FLJTF` and `24LEBB`, but his natural comma-separated anchor lists were being treated as one literal query string.
- 2026-04-24 18:27 Repair shape:
  - teach `mail_search` to treat simple comma-separated anchor lists like the existing `OR` disjunction path;
  - add one hosted regression and one HEY golden-path regression so cached delegated travel mail stays discoverable when Slugger pastes natural booking-code/vendor lists;
  - update recovery docs so the operator truth matches the real supported query shapes.
- 2026-04-24 18:34 Verification after the query-parser repair:
  - `npm test -- --run src/__tests__/mailroom/tools-mail-hosted.test.ts src/__tests__/mailroom/hey-golden-path.test.ts` passed;
  - `npm run test:coverage` passed again at 100% with `nerves audit: pass`;
  - next live step is runtime reload plus the same audited Slugger retry, with no new hints about the hidden itinerary change.
- 2026-04-24 18:45 The first "reload" was fake-green. `rsync` updated the installed CLI `dist`, but `ouro up` left the already-running daemon/worker in place, so Slugger's retry was still hitting stale in-memory code. The honest repair was `ouro down` followed by `ouro up`, then verifying the worker pid changed before asking him to retry.
- 2026-04-24 18:49 After the real restart, the audited iMessage lane converged cleanly:
  - Slugger immediately moved from failing delegated retrieval to `mail_thread`, then into `bookings.md` and `itinerary.md`;
  - the travel docs on disk updated from April 8 mtimes to fresh April 24 mtimes;
  - `git -C /Users/arimendelow/AgentBundles/slugger.ouro diff -- travel/2026-summer-trip/bookings.md travel/2026-summer-trip/itinerary.md` confirmed the hidden itinerary change was recovered from email evidence;
  - Slugger's audited closeout named the concrete updates: Lufthansa/Edelweiss fare, baggage, total price, and ticket numbers for `9FLJTF`; Aer Lingus arrival corrected from `23:55` to `23:50`; bag details and total-price context added for `24LEBB`; itinerary note changed to "Arrive Dublin just before midnight"; blocker `none`.
