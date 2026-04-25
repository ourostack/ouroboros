# Mail Convergence Pass 3 Doing

Planning: `slugger/tasks/2026-04-24-1251-planning-mail-convergence-pass3.md`
Execution Mode: direct
Artifacts: `slugger/tasks/2026-04-24-1251-doing-mail-convergence-pass3/`

## Goal

Execute the third convergence pass on agent mail by making delegated archive freshness explicit in `mail_status`, explaining archive identity when filenames and delegated bindings diverge, and proving the exact hosted family-link sender-policy path Slugger still doubts.

## Completion Criteria

- [x] `mail_status` explicitly answers whether a delegated archive is imported/current, newer than the last import, or ambiguous/stale-risky.
- [x] `mail_status` explains why an archive is mapped to a delegated owner/source when the filename suggests a different account label.
- [x] Hosted family-link sender-policy proof covers the exact `link-friend` path without any `registryPath missing` smell.
- [x] Docs and contract tests teach the stronger freshness/identity model.
- [x] Coverage gate passes with 100% on changed code paths.
- [ ] Local runtime is rebuilt/reloaded and live-verified against Slugger’s setup.
- [ ] Slugger reviews the result and either signs off or seeds the next pass.

## Code Coverage Requirements

- 100% coverage on new and modified code paths.
- Focus tests on `mail_status` freshness semantics, archive identity explanation, and hosted `link-friend` sender-policy persistence.
- Run focused verification first, then broaden to the coverage gate if the change fans out.

## Units

### ✅ Unit 1a: Freshness/identity red tests

What:
- Add failing tests for explicit archive freshness wording and filename-vs-binding explanation in `mail_status`.

Acceptance:
- Tests fail first for the current inferential freshness wording and missing identity explanation.

### ✅ Unit 1b: Freshness/identity implementation

What:
- Implement archive freshness classification and mapping explanation in `mail_status` using the existing import/discovery truth.

Acceptance:
- `mail_status` makes freshness and binding truth explicit enough that Slugger does not need to reconstruct it by hand.

### ✅ Unit 2a: Hosted family-link proof red test

What:
- Add a failing hosted test for the exact `link-friend` family/Screener sender-policy happy path.

Acceptance:
- The exact path Slugger distrusted is covered and fails before implementation if the hosted registry write path regresses.

### ✅ Unit 2b: Hosted family-link proof implementation and docs

What:
- Repair any remaining hosted family-link sender-policy gaps, then update docs/contract tests for the stronger freshness and identity model.

Acceptance:
- Hosted `link-friend` path is boring and clean in tests.
- Docs teach the repaired model directly.

### ✅ Unit 2c: Coverage verification

What:
- Run focused/full verification and close any remaining branch-coverage gaps.

Acceptance:
- Coverage gate passes at 100%.

### ⬜ Unit 3: Runtime reload and Slugger review

What:
- Reload the runtime onto this branch, verify live health, and get Slugger’s post-pass review focused on freshness truth, archive identity clarity, and the family-link confidence gap.

Acceptance:
- Live runtime reflects the pass.
- Slugger either signs off or provides the next concrete feedback set.

## Notes

- Keep the fix inside the existing operating model; do not invent a second delegated-mail state system just to word freshness more loudly.
- Preserve the native-vs-delegated boundary everywhere.
- Filename hints may be useful, but the delegated binding is the canonical truth.

## Progress Log

- 2026-04-24 12:51 Doing doc created for the third convergence pass.
- 2026-04-24 13:43 Landed explicit delegated-archive freshness truth and inline filename-vs-binding identity notes in `mail_status`, including guarded malformed-email handling and focused helper coverage.
- 2026-04-24 13:43 Added exact hosted `link-friend` sender-policy proof coverage, updated setup/recovery docs and contract tests, and passed the full 100% coverage gate plus nerves audit.
