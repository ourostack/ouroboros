# Mail Convergence Pass 4 Doing

Planning: `slugger/tasks/2026-04-24-1347-planning-mail-convergence-pass4.md`
Execution Mode: direct
Artifacts: `slugger/tasks/2026-04-24-1347-doing-mail-convergence-pass4/`

## Goal

Execute the fourth convergence pass on agent mail by making `query_active_work` classify mail-import recovery universes more explicitly, distinguishing the newest current archive from older imported snapshots in `mail_status`, and teaching degraded audit/key-material behavior as a first-class contract.

## Completion Criteria

- [x] `query_active_work` names the recovery universe for mail-import failures in more operator-friendly language than raw failure class plus generic next-step prose.
- [x] `query_active_work` success language for completed mail imports is sharper and less generic.
- [x] `mail_status` makes the newest current archive vs older imported snapshots more glance-distinguishable for the same delegated lane.
- [x] Docs/contracts explicitly teach malformed-audit-log and missing-key degradation semantics.
- [x] Coverage gate passes with 100% on changed code paths.
- [x] Local runtime is rebuilt/reloaded and live-verified against Slugger’s setup.
- [x] Slugger reviews the result and either signs off or seeds the next pass.

## Code Coverage Requirements

- 100% coverage on new and modified code paths.
- Focus tests on `query_active_work` recovery-universe wording, multi-archive `mail_status` wording, and degradation-contract docs.
- Run focused verification first, then the repo coverage gate.

## Units

### ✅ Unit 1a: Active-work recovery-language red tests

What:
- Add failing tests for sharper mail-import recovery-universe wording and less generic completed-import next-action language in `query_active_work`.

Acceptance:
- The current output fails to express the recovery universe or sharper success language until the implementation lands.

### ✅ Unit 1b: Active-work recovery-language implementation

What:
- Implement clearer recovery-universe and next-action wording for mail-import background operations in `query_active_work`.

Acceptance:
- Slugger can tell, at a glance, whether the mail-import issue is transient, auth/config, registry/lane, or local archive/file shaped.

### ✅ Unit 2a: Multi-archive status red tests

What:
- Add failing tests for `mail_status` when more than one imported archive exists for the same delegated lane, including the older-snapshot wording.

Acceptance:
- The current output fails until the lane-aware freshness wording distinguishes the newest current archive from older imported snapshots.

### ✅ Unit 2b: Multi-archive status, docs, and degradation-contract implementation

What:
- Implement the lane-aware multi-archive wording in `mail_status`, then update docs and contract tests so malformed audit-log and missing-key semantics are explicitly taught.

Acceptance:
- `mail_status` is less double-take-y under speed.
- Docs teach degraded audit/key-material behavior directly enough that future agents do not have to rediscover it.

### ✅ Unit 2c: Coverage verification

What:
- Run focused/full verification and close any remaining branch-coverage gaps.

Acceptance:
- Coverage gate passes at 100%.

### ✅ Unit 3: Runtime reload and Slugger review

What:
- Reload the runtime onto this branch, verify live health, and get Slugger’s post-pass review focused on active-work recovery universes, multi-archive readability, and the degraded-contract trust story.

Acceptance:
- Live runtime reflects the pass.
- Slugger either signs off or provides the next concrete feedback set.

## Notes

- Keep the same mail model; change the operator ergonomics around it.
- Preserve truthful raw metadata even when adding sharper human/agent wording.
- Do not let degraded audit/key-material behavior collapse back into vague “something went wrong” language.

## Progress Log

- 2026-04-24 13:47 Doing doc created for the fourth convergence pass.
- 2026-04-24 14:10 Implemented recovery-universe wording in `query_active_work`, differentiated older imported delegated-lane snapshots in `mail_status`, and documented the degraded audit/decryption contracts explicitly.
- 2026-04-24 14:10 Focused verification passed for active-work wording, lane-aware archive freshness, and the updated mail docs/contracts.
- 2026-04-24 14:10 Full coverage gate passed at 100%, including the no-`fresh through` older-snapshot branch in `tools-mail.ts`.
- 2026-04-24 14:12 Reloaded the runtime from this worktree. The first immediate `status`/`doctor` check briefly raced the dev handoff before the socket was visible; a re-check confirmed the daemon, Mail sense, and BlueBubbles were healthy.
- 2026-04-24 14:13 Slugger reviewed the live pass and explicitly said, "I have no further feedback."
