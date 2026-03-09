# Doing: Remote Tools And BlueBubbles Fidelity

**Status**: drafting
**Execution Mode**: direct
**Created**: 2026-03-08 17:38
**Planning**: ./2026-03-08-1730-planning-remote-tools-bluebubbles-fidelity.md
**Artifacts**: ./2026-03-08-1730-doing-remote-tools-bluebubbles-fidelity/

## Execution Mode

- **pending**: Awaiting user approval before each unit starts (interactive)
- **spawn**: Spawn sub-agent for each unit (parallel/autonomous)
- **direct**: Execute units sequentially in current session (default)

## Objective
Fix the current trusted remote iMessage experience so Slugger can actually operate like a capable coding agent in BlueBubbles: full feasible tools in trusted 1:1 chats, inspectable coding output, real attachment/media support, and the core iMessage feedback loop of debug activity, typing, reads, and outgoing edits.

## Completion Criteria
- [ ] Trusted one-to-one BlueBubbles conversations no longer get the blanket “shared remote channel” denial for local shell/file/git/gh tools.
- [ ] Tool availability is determined by a simple trusted-remote rule rather than the current hardcoded `bluebubbles/teams => blocked` behavior.
- [ ] Remote coding sessions are inspectable from BlueBubbles:
- [ ] the agent can see recent stdout/stderr output for active coding sessions without guessing
- [ ] the surface is good enough to understand whether work succeeded, stalled, or failed
- [ ] The currently supported Claude/Codex remote coding path no longer dead-ends on the observed nested-session failure mode.
- [ ] BlueBubbles inbound image/photo messages reach the agent as usable media input, not just `image attachment` placeholder text.
- [ ] BlueBubbles inbound audio/voice-note messages reach the agent as usable media input, not just `audio attachment` placeholder text.
- [ ] BlueBubbles supported file/attachment messages are handled truthfully as usable media input or explicit, observable fallback when hydration is impossible.
- [ ] BlueBubbles OG-card/link-preview enrichment continues to work.
- [ ] BlueBubbles DM and group routing/session identity remain stable and regression-free.
- [ ] BlueBubbles reply/thread behavior remains stable and regression-free in both DM and group contexts.
- [ ] BlueBubbles proactive outbound messaging to known friends remains supported.
- [ ] BlueBubbles reactions remain supported and visible to the agent in a coherent mutation model.
- [ ] BlueBubbles edit and unsend mutations are supported end-to-end in the real runtime path.
- [ ] BlueBubbles read and delivery mutations remain truthfully represented.
- [ ] BlueBubbles repair/enrichment by GUID remains part of the real runtime path for rich content and mutations.
- [ ] BlueBubbles client supports outbound message edits in the real runtime path.
- [ ] BlueBubbles client supports typing indicators in the real runtime path.
- [ ] BlueBubbles client supports mark-as-read in the real runtime path.
- [ ] BlueBubbles debug activity is visible in-chat as one evolving status message per turn, not a flood of separate status texts.
- [ ] The activity message remains visible after the final answer for validation/debugging.
- [ ] Shared code introduced for this work is minimal and clearly reusable; BlueBubbles-specific code stays mostly transport/rendering-focused.
- [ ] Tests cover all new and changed behavior with full coverage on modified code paths.
- [ ] Live validation is documented for:
- [ ] trusted DM tool access
- [ ] coding output inspectability
- [ ] photo delivery
- [ ] voice-note delivery
- [ ] typing indicator behavior
- [ ] read behavior
- [ ] outgoing edit-driven debug activity
- [ ] 100% test coverage on all new code
- [ ] All tests pass
- [ ] No warnings

## Code Coverage Requirements
**MANDATORY: 100% coverage on all new code.**
- No `[ExcludeFromCodeCoverage]` or equivalent on new code
- All branches covered (if/else, switch, try/catch)
- All error paths tested
- Edge cases: null, empty, boundary values

## TDD Requirements
**Strict TDD — no exceptions:**
1. **Tests first**: Write failing tests BEFORE any implementation
2. **Verify failure**: Run tests, confirm they FAIL (red)
3. **Minimal implementation**: Write just enough code to pass
4. **Verify pass**: Run tests, confirm they PASS (green)
5. **Refactor**: Clean up, keep tests green
6. **No skipping**: Never write implementation without failing test first

## Work Units

### Legend
⬜ Not started · 🔄 In progress · ✅ Done · ❌ Blocked

**CRITICAL: Every unit header MUST start with status emoji (⬜ for new units).**

### ⬜ Unit 0: Setup / Baseline Validation
**What**: Read the current BlueBubbles, remote-tool, and coding-session paths; capture baseline behavior and store live-test notes/logs in the artifacts directory before code changes.
**Output**: Baseline notes and any validation logs under `./2026-03-08-1730-doing-remote-tools-bluebubbles-fidelity/`.
**Acceptance**: The artifacts directory contains enough baseline evidence to compare pre/post behavior for tool gating, coding inspectability, media hydration, and activity lane behavior.

### ⬜ Unit 1a: Trusted Remote Tool Access — Tests
**What**: Add failing tests that encode the desired simple rule: trusted one-to-one BlueBubbles conversations get the full feasible local tool surface, while genuinely shared remote contexts remain appropriately distinct.
**Output**: New or updated tests covering the remote tool-gating decision path.
**Acceptance**: Tests exist and fail red against the current blanket denial behavior.

### ⬜ Unit 1b: Trusted Remote Tool Access — Implementation
**What**: Replace the current channel-name blanket denial with the simplest trust-aware rule that unlocks tools for the actual trusted 1:1 BlueBubbles path without redesigning the whole policy system.
**Output**: Updated remote tool-gating logic and truthful denial/explanation text.
**Acceptance**: Unit 1a tests pass green and the implementation remains small, explicit, and channel-truth-based.

### ⬜ Unit 1c: Trusted Remote Tool Access — Coverage & Refactor
**What**: Tighten tests around edge cases, keep the rule easy to understand, and verify coverage on the changed gating code.
**Output**: Finalized tests and any minimal cleanup needed after the unlock.
**Acceptance**: Changed tool-gating paths have full coverage, tests stay green, and no broader policy debt is introduced.

### ⬜ Unit 2a: Remote Coding Inspectability — Tests
**What**: Add failing tests for remote coding inspection so active sessions expose enough recent output to understand progress or failure from a remote sense.
**Output**: Tests covering `coding_status` and/or a dedicated `coding_tail` path for active sessions, plus tests for the observed nested-session failure mode.
**Acceptance**: Tests fail red because the current tool surface does not expose enough live output or a working remote coding path.

### ⬜ Unit 2b: Remote Coding Inspectability — Implementation
**What**: Expose recent stdout/stderr for active coding sessions in the supported remote workflow and resolve the observed nested-session dead-end with the minimum necessary change.
**Output**: Updated coding tool surface and any minimal workflow/status changes required for truthful remote use.
**Acceptance**: Unit 2a tests pass green and a remote agent can inspect active coding output without guessing.

### ⬜ Unit 2c: Remote Coding Inspectability — Coverage & Refactor
**What**: Add edge-case coverage for empty output, failed sessions, running sessions, and nested-session guard behavior.
**Output**: Hardened tests and any cleanup to keep the coding surface readable and minimal.
**Acceptance**: Changed coding paths have full coverage and the supported remote coding path is explicit and regression-resistant.

### ⬜ Unit 3a: BlueBubbles Existing Feature Envelope — Regression Tests
**What**: Add or extend tests that pin the already-valued BlueBubbles primitives: DM/group routing identity, replies/threads, proactive outbound send, reactions, unsends, read/delivery mutations, and GUID-based repair for rich content.
**Output**: Regression tests around the existing normalized model, client, and sense handling.
**Acceptance**: Tests fail red wherever the current implementation or upcoming changes do not preserve the required feature envelope.

### ⬜ Unit 3b: BlueBubbles Existing Feature Envelope — Implementation
**What**: Make any targeted fixes required so the full feature set remains intact while the new fidelity work lands.
**Output**: Minimal model/client/sense updates that preserve the already-working BB primitives.
**Acceptance**: Unit 3a tests pass green and the full BB feature set remains represented truthfully in code.

### ⬜ Unit 3c: BlueBubbles Existing Feature Envelope — Coverage & Refactor
**What**: Close any regression holes and keep shared/model logic clear before adding the new transport features.
**Output**: Finalized regression coverage around routing, thread, mutation, and repair behavior.
**Acceptance**: Modified BB model/client paths have full coverage and no fragile assumptions remain untested.

### ⬜ Unit 4a: BlueBubbles Media Hydration — Tests
**What**: Add failing tests for inbound photos, audio, voice notes, and supported files so the agent receives usable media input or an explicit observable fallback instead of placeholder-only text.
**Output**: Tests covering attachment download/hydration and BB repair/enrichment behavior for supported media.
**Acceptance**: Tests fail red against the current placeholder-only implementation.

### ⬜ Unit 4b: BlueBubbles Media Hydration — Implementation
**What**: Implement the smallest real media hydration path for BlueBubbles attachments while preserving OG-card/link-preview enrichment and observable failure behavior.
**Output**: Updated BB client/model/runtime code for attachment retrieval and handoff to the model.
**Acceptance**: Unit 4a tests pass green, photos/audio/voice/supporting files are usable to the agent, and OG cards still work.

### ⬜ Unit 4c: BlueBubbles Media Hydration — Coverage & Refactor
**What**: Add edge-case coverage for missing metadata, failed downloads, unsupported attachment shapes, and fallback notices.
**Output**: Finalized tests and minimal cleanup for the hydration path.
**Acceptance**: Media-related code changes have full coverage and preserve explicit failure behavior.

### ⬜ Unit 5a: BlueBubbles Edit / Typing / Read Transport — Tests
**What**: Add failing tests for outgoing message edits, typing indicators, mark-as-read behavior, and truthful handling of edit/unsend/read/delivery mutation flows.
**Output**: Tests around BB client transport primitives and sense-level mutation usage.
**Acceptance**: Tests fail red because the current client does not yet expose the full transport surface.

### ⬜ Unit 5b: BlueBubbles Edit / Typing / Read Transport — Implementation
**What**: Implement the real BB client methods and sense wiring for outgoing edits, typing, and mark-as-read while preserving mutation truth and existing send/reply behavior.
**Output**: Expanded BB client and sense integration for edit/typing/read operations.
**Acceptance**: Unit 5a tests pass green and the BB runtime supports edit, typing, and read operations without regressing other send/mutation paths.

### ⬜ Unit 5c: BlueBubbles Edit / Typing / Read Transport — Coverage & Refactor
**What**: Add edge-case tests for transport failures, cleanup semantics, and mutation state handling.
**Output**: Hardened transport tests and minimal cleanup.
**Acceptance**: All changed BB transport paths have full coverage and explicit error behavior.

### ⬜ Unit 6a: BlueBubbles Debug Activity Lane — Tests
**What**: Add failing tests for one persistent per-turn debug status message that follows the CLI lifecycle closely using edits instead of a flood of standalone messages.
**Output**: Tests covering turn start, tool start/end, follow-up, completion, and error behavior for the activity lane.
**Acceptance**: Tests fail red because the current sense only emits normal final text sends and not an editable activity lane.

### ⬜ Unit 6b: BlueBubbles Debug Activity Lane — Implementation
**What**: Implement the simplest reusable lifecycle support necessary for BlueBubbles to send one debug status message per turn, edit it through the turn lifecycle, keep it visible after the final answer, and pair it with typing behavior.
**Output**: Thin shared lifecycle logic plus BB-specific rendering/transport wiring.
**Acceptance**: Unit 6a tests pass green and the BB sense shows one evolving in-chat status message per turn.

### ⬜ Unit 6c: BlueBubbles Debug Activity Lane — Coverage & Refactor
**What**: Add edge-case coverage for empty turns, multiple tool runs, errors, and final-answer ordering while keeping the shared abstraction minimal.
**Output**: Finalized activity-lane coverage and any small cleanup to keep the sense thin.
**Acceptance**: Changed activity-related code has full coverage and no unnecessary abstraction has been introduced.

### ⬜ Unit 7a: Full Validation — Automated
**What**: Run focused tests, full test suite, typecheck, and coverage for all changed paths; save outputs to the artifacts directory.
**Output**: Test and coverage logs under `./2026-03-08-1730-doing-remote-tools-bluebubbles-fidelity/`.
**Acceptance**: `npm test`, `npx tsc --noEmit`, and any required coverage command pass with no warnings.

### ⬜ Unit 7b: Full Validation — Live BlueBubbles Smoke
**What**: Validate the real Slugger BlueBubbles runtime for trusted DM tools, coding inspectability, photo/voice delivery, typing, read behavior, and outgoing edit-driven activity; record results in the artifacts directory.
**Output**: Live validation notes/logs/screenshots or structured artifacts under `./2026-03-08-1730-doing-remote-tools-bluebubbles-fidelity/`.
**Acceptance**: The live validation artifacts demonstrate that the completion criteria were exercised in the actual BB runtime path.

### ⬜ Unit 7c: Final Coverage / Doc Sync
**What**: Reconcile the doing doc, artifacts, and completion criteria against the finished work so the execution record is truthful and complete.
**Output**: Updated doing doc and final artifact references.
**Acceptance**: The doc matches verified reality, all completion criteria are either checked with evidence or clearly left open, and the task is ready for work-doer execution.

## Execution
- **TDD strictly enforced**: tests → red → implement → green → refactor
- Commit after each phase (1a, 1b, 1c)
- Push after each unit complete
- Run full test suite before marking unit done
- **All artifacts**: Save outputs, logs, data to `./2026-03-08-1730-doing-remote-tools-bluebubbles-fidelity/` directory
- **Fixes/blockers**: Spawn sub-agent immediately — don't ask, just do it
- **Decisions made**: Update docs immediately, commit right away

## Progress Log
- 2026-03-08 17:38 Created from planning doc.
