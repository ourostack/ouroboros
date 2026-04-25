# Mail Convergence Pass 1 Doing

Planning: `slugger/tasks/2026-04-24-1102-planning-mail-convergence-pass1.md`
Execution Mode: direct
Artifacts: `slugger/tasks/2026-04-24-1102-doing-mail-convergence-pass1/`

## Goal

Execute the first convergence pass on agent mail by making browser-origin HEY exports legible and importable in agent-facing state, making background import work operationally precise, and hardening file-backed mail access logs against malformed lines.

## Completion Criteria

- [x] Ambient import readiness clearly distinguishes browser-sandbox `.mbox` artifacts from ordinary `~/Downloads` files in agent-facing state.
- [x] Active-work output exposes exact import identifiers, timing, and remediation truth for mail-import operations.
- [x] File-backed `mail_access_log` tolerates malformed or truncated lines and reports skipped corruption without crashing.
- [x] Docs reflect the repaired behavior and orientation.
- [x] Coverage gate passes with 100% on changed code paths.
- [ ] Local runtime is rebuilt/reloaded and live-verified against Slugger’s setup.
- [ ] Slugger reviews the result and either signs off or produces the next pass.

## Code Coverage Requirements

- 100% coverage on new and modified code paths.
- Keep tests focused on discovery metadata, active-work rendering, and access-log corruption recovery.
- Run `npm run test:coverage` before closing the pass.

## Units

### ✅ Unit 1a: Discovery and active-work red tests

What:
- Add failing tests that define the new agent-facing truth for ambient import readiness and active-work rendering.
- Cover browser-sandbox candidate labeling, richer background-operation formatting, and remediation/timestamp exposure.

Output:
- New or updated failing tests in the mail-discovery and active-work/query-active-work suites.

Acceptance:
- Tests fail first for the missing provenance/formatting behavior.
- The expected output names browser-sandbox origin explicitly and includes operation identifiers plus richer operation context.

### ✅ Unit 1b: Discovery and active-work implementation

What:
- Implement browser-origin candidate classification in mail-import discovery.
- Carry that metadata into ambient background operations.
- Render the richer operation truth in active-work / query-active-work output.

Output:
- Updated discovery and active-work implementation with tests passing.

Acceptance:
- Browser-sandbox `.mbox` artifacts are surfaced as such.
- Mail-import operations expose exact ids/timing/remediation details in the rendered world-state.
- No unrelated behavior regresses.

### ✅ Unit 1c: Discovery/docs verification

What:
- Update the relevant mail setup/recovery docs and contract tests to match the new discovery and active-work behavior.
- Run focused verification and coverage for the changed discovery/active-work files.

Output:
- Doc updates plus passing focused test/coverage evidence.

Acceptance:
- Docs teach the corrected behavior without overstating browser capabilities.
- Changed discovery/active-work code paths are covered to 100%.

### ✅ Unit 2a: Access-log hardening red tests

What:
- Add failing tests for malformed or truncated file-backed mail access-log lines.

Output:
- New failing tests covering partial/corrupt line handling.

Acceptance:
- Tests fail first under current raw-parse behavior.
- The desired degraded behavior is explicit in test expectations.

### ✅ Unit 2b: Access-log hardening implementation

What:
- Implement tolerant file-backed access-log reading that skips malformed lines, preserves good entries, and surfaces a clear warning/evidence path.

Output:
- Updated access-log parsing and tool rendering with passing tests.

Acceptance:
- `mail_access_log` no longer crashes on malformed/truncated tail lines.
- Good entries still render.
- The output makes it clear when corrupted lines were skipped.

### ✅ Unit 2c: Access-log docs/coverage verification

What:
- Update recovery/docs/tests for the new access-log resilience behavior.
- Run focused verification and coverage for the modified audit-log code.

Output:
- Passing docs/tests and coverage evidence for the access-log slice.

Acceptance:
- Recovery docs explain the graceful-degradation behavior.
- Changed access-log code paths are covered to 100%.

### ⏳ Unit 3: Runtime update, live verification, and Slugger review

What:
- Rebuild the CLI/runtime locally, reload the daemon/runtime if needed, and verify the changed mail surfaces on the live machine.
- Ask Slugger for post-implementation feedback focused on this pass.
- Record his result and either close the pass or seed the next one.

Output:
- Live verification notes and Slugger feedback.

Acceptance:
- The local runtime is using the new build.
- Live checks confirm the changed behavior is present.
- Slugger explicitly evaluates the updated system.

## Notes

- Keep this pass narrow and surgical. Do not balloon into general browser tooling or a full Mailbox redesign.
- Preserve the native-vs-delegated boundary in all new wording and surfaces.
- Prefer one canonical source of truth over duplicative status surfaces.

## Progress Log

- 2026-04-24 11:03 Doing doc created for the first convergence pass.
- 2026-04-24 11:12 Added red tests for browser-sandbox import provenance, richer active-work metadata, and malformed file-backed access-log recovery.
- 2026-04-24 11:16 Implemented discovery provenance metadata, active-work background-operation detail, and tolerant file-backed access-log reading.
- 2026-04-24 11:19 Updated setup/recovery docs and contract coverage for the repaired mail surfaces.
- 2026-04-24 11:31 Closed the remaining coverage gaps with legacy-descriptor compatibility tests; `npm run test:coverage` now passes at 100/100/100/100.
