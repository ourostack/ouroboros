# Mail Convergence Pass 2 Doing

Planning: `slugger/tasks/2026-04-24-1136-planning-mail-convergence-pass2.md`
Execution Mode: direct
Artifacts: `slugger/tasks/2026-04-24-1136-doing-mail-convergence-pass2/`

## Goal

Execute the second convergence pass on agent mail by adding explicit recovery classes for mail-import failures, introducing a first-class mail status surface for lane/download/import truth, and removing the hosted-registry sender-policy gap from family Screener decisions.

## Completion Criteria

- [ ] Failed mail-import operations carry an explicit recovery/failure classification and stronger next-step truth in `query_active_work`.
- [ ] A first-class mail status surface exposes the native/delegated lane map plus recent import/download truth.
- [ ] Hosted mail setups no longer degrade delegated alias/source-grant truth to `unknown` merely because `registryPath` is absent.
- [ ] Happy-path hosted Screener/link-family decisions do not emit `sender policy: skipped (registryPath missing)`.
- [x] Coverage gate passes with 100% on changed code paths.
- [ ] Local runtime is rebuilt/reloaded and live-verified against Slugger’s setup.
- [ ] Slugger reviews the result and either signs off or seeds the next pass.

## Code Coverage Requirements

- 100% coverage on new and modified code paths.
- Focus tests on hosted registry truth, mail status rendering, and failure classification branches.
- Run `npm run test:coverage` before closing the pass.

## Units

### ✅ Unit 1a: Hosted-registry and status red tests

What:
- Add failing tests for hosted delegated alias truth, hosted sender-policy persistence, and the new first-class mail status surface.

Acceptance:
- Tests fail first for the current `registryPath` overfit and for the missing status surface.

### ✅ Unit 1b: Hosted-registry and status implementation

What:
- Implement hosted registry read/write helpers as needed and add the new mail status surface.

Acceptance:
- Hosted setups can read/write the registry truth without a filesystem registry path.
- Mail status renders a compact lane/download/import map that is operationally useful.

### ✅ Unit 2a: Failure-classification red tests

What:
- Add failing tests for explicit mail-import failure classifications and stronger recovery output in active-work.

Acceptance:
- Tests pin the failure classes and the rendered output before implementation.

### ✅ Unit 2b: Failure-classification implementation

What:
- Implement classification of mail-import failures and surface the result in background-operation / active-work rendering.

Acceptance:
- `query_active_work` exposes the failure class and recovery truth clearly enough for Slugger to operate from it.

### ✅ Unit 2c: Docs/coverage verification

What:
- Update docs and contract tests for the new status/failure model and run focused/full verification.

Acceptance:
- Docs teach the repaired model.
- Coverage gate passes at 100%.

### ⬜ Unit 3: Runtime reload and Slugger review

What:
- Reload the runtime onto this branch, verify live health, and get Slugger’s post-pass review.

Acceptance:
- Live runtime reflects the pass.
- Slugger either signs off or provides the next concrete feedback set.

## Notes

- Keep the mail status surface operational and compact; it is a control surface, not a marketing summary.
- Preserve the native-vs-delegated boundary everywhere.
- Do not let hosted registry support become a second mail-config ontology.

## Progress Log

- 2026-04-24 11:36 Doing doc created for the second convergence pass.
- 2026-04-24 11:46 Added hosted-registry write support, `mail_status`, archive freshness truth, and explicit import failure metadata.
- 2026-04-24 11:47 Updated docs and contract tests so the repaired mail operating model is taught explicitly.
- 2026-04-24 11:59 Hardened tracked foreground import failures so discovery ambiguity and early archive failures persist classified background-operation records instead of disappearing before `query_active_work`.
- 2026-04-24 12:00 Repaired background-operation writes to normalize on disk at write time, not only on later reads.
- 2026-04-24 12:14 Closed the remaining branch-coverage gaps across hosted mail status, background-operation normalization, and tracked import discovery failures.
- 2026-04-24 12:20 `npm run test:coverage` passed with 100% statements/branches/functions/lines and the nerves audit stayed green.
