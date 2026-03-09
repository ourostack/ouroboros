# Planning: Remote Tools And BlueBubbles Fidelity

**Status**: approved
**Created**: 2026-03-08 17:30

## Goal
Fix the current trusted remote iMessage experience so Slugger can actually operate like a capable coding agent in BlueBubbles: full feasible tools in trusted 1:1 chats, inspectable coding output, real attachment/media support, and the core iMessage feedback loop of debug activity, typing, reads, and outgoing edits.

**DO NOT include time estimates (hours/days) — planning should focus on scope and criteria, not duration.**

## Scope
### In Scope
- Trusted remote 1:1 tool availability:
  - remove the blanket BlueBubbles/Teams remote ban on local tools for trusted one-to-one contexts
  - keep the implementation simple and truth-based instead of channel-name-based
- Remote coding inspectability:
  - make coding session output inspectable from remote senses via `coding_status` and/or a dedicated tail tool
  - resolve the current “blind remote coding” failure mode
- Claude/Codex remote coding usability:
  - fix the current Claude nested-session failure mode in the intended remote workflow
  - make the supported remote coding path obvious and functional
- BlueBubbles inbound fidelity:
  - make photos, voice notes, and other supported attachments usable input rather than placeholder summaries
  - keep OG-card/link-preview support working
- Full BlueBubbles feature envelope for this sense:
  - preserve and validate DM and group routing/session identity
  - preserve and validate replies/threads, including thread persistence and reply metadata
  - preserve and validate proactive outbound messaging to known friends
  - preserve and validate reactions, edits, unsends, and read/delivery mutations
  - preserve and validate link previews, attachments, photos, audio, voice notes, and supported files
  - preserve and validate repair/enrichment by GUID rather than webhook-only truth
- BlueBubbles outbound fidelity:
  - add outgoing message edits
  - add typing indicators
  - add mark-as-read behavior
- BlueBubbles debug activity lane:
  - one persistent per-turn debug/status message
  - edited across turn lifecycle
  - stays visible after the final answer
- Thin sense design:
  - factor only the minimum shared lifecycle/tooling code needed
  - keep BlueBubbles as a thin transport/rendering adapter

### Out of Scope
- Broad “policy engine” redesign for all channels
- Polished non-debug iMessage-native activity phrasing as a separate UX mode
- Group-chat-specific permission changes beyond what naturally falls out of trusted 1:1 fixes
- New environment-variable-based configuration
- Large tool-system rewrites not required for the validated failures above

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

## Code Coverage Requirements
- Maintain complete coverage for all new and modified code.
- Add focused tests for tool gating, coding-status inspectability, BlueBubbles media hydration, edit/typing/read operations, and activity-message lifecycle behavior.
- Keep `npm test` and `npx tsc --noEmit` green.

## Open Questions
- None currently. The main product decisions for this scope are already locked from live validation.

## Decisions Made
- Use a Slugger-owned worktree/branch for planning and execution.
- Keep this as one combined plan instead of splitting BlueBubbles fidelity and remote-coding AX into separate implementation plans.
- Optimize for great AX and implementation ease; do not overengineer.
- Trusted family-style 1:1 remote conversations should have the full feasible tool surface for that channel.
- Preserve the full BlueBubbles feature set that materially affects UX/AX; do not fix one gap by regressing other BB primitives that already work.
- The BlueBubbles debug activity message should stay visible after the final answer during validation.
- Outgoing edits are required, not optional polish.
- Read receipts and typing indicators are in scope now.
- Keep the sense layer thin; share only the minimum lifecycle/tooling code that obviously reduces duplication.

## Context / References
- Existing BlueBubbles implementation plan: [slugger/tasks/2026-03-07-2210-planning-bluebubbles-imessage-sense.md](/Users/arimendelow/Projects/ouroboros-agent-harness-slugger-bb-ax/slugger/tasks/2026-03-07-2210-planning-bluebubbles-imessage-sense.md)
- Existing daemon/sense status plan: [slugger/tasks/2026-03-08-0834-planning-daemon-bluebubbles-sense-status.md](/Users/arimendelow/Projects/ouroboros-agent-harness-slugger-bb-ax/slugger/tasks/2026-03-08-0834-planning-daemon-bluebubbles-sense-status.md)
- Live validation note in Slugger bundle: [2026-03-08-1702-bluebubbles-activity-debug-read-typing.md](/Users/arimendelow/AgentBundles/slugger.ouro/tasks/one-shots/2026-03-08-1702-bluebubbles-activity-debug-read-typing.md)
- Remote tool gating today: [src/repertoire/tools.ts](/Users/arimendelow/Projects/ouroboros-agent-harness-slugger-bb-ax/src/repertoire/tools.ts)
- Base local tools today: [src/repertoire/tools-base.ts](/Users/arimendelow/Projects/ouroboros-agent-harness-slugger-bb-ax/src/repertoire/tools-base.ts)
- Coding tool surface today: [src/repertoire/coding/tools.ts](/Users/arimendelow/Projects/ouroboros-agent-harness-slugger-bb-ax/src/repertoire/coding/tools.ts)
- Coding session state currently tracks `stdoutTail`/`stderrTail` internally: [src/repertoire/coding/manager.ts](/Users/arimendelow/Projects/ouroboros-agent-harness-slugger-bb-ax/src/repertoire/coding/manager.ts), [src/repertoire/coding/types.ts](/Users/arimendelow/Projects/ouroboros-agent-harness-slugger-bb-ax/src/repertoire/coding/types.ts)
- BlueBubbles client today only enriches link previews and not media content: [src/senses/bluebubbles-client.ts](/Users/arimendelow/Projects/ouroboros-agent-harness-slugger-bb-ax/src/senses/bluebubbles-client.ts)
- BlueBubbles model today collapses attachments to placeholder text: [src/senses/bluebubbles-model.ts](/Users/arimendelow/Projects/ouroboros-agent-harness-slugger-bb-ax/src/senses/bluebubbles-model.ts)
- BlueBubbles sense runtime callback surface: [src/senses/bluebubbles.ts](/Users/arimendelow/Projects/ouroboros-agent-harness-slugger-bb-ax/src/senses/bluebubbles.ts)
- CLI activity behavior to mirror: [src/senses/cli.ts](/Users/arimendelow/Projects/ouroboros-agent-harness-slugger-bb-ax/src/senses/cli.ts), [src/mind/phrases.ts](/Users/arimendelow/Projects/ouroboros-agent-harness-slugger-bb-ax/src/mind/phrases.ts), [src/mind/format.ts](/Users/arimendelow/Projects/ouroboros-agent-harness-slugger-bb-ax/src/mind/format.ts)
- BlueBubbles docs:
- [Private API overview](https://docs.bluebubbles.app/private-api)
- [IMCore documentation](https://docs.bluebubbles.app/private-api/imcore-documentation)
- [REST API and webhooks](https://docs.bluebubbles.app/server/developer-guides/rest-api-and-webhooks)
- Claude Code docs for broad tool / permission model reference:
- [Claude Code settings](https://code.claude.com/docs/en/settings)
- [Claude Code security](https://code.claude.com/docs/en/security)

## Notes
- The current live failure on photos/voice is not just a validation quirk; the shipped code path does not currently download or hand off attachment content to the model. It only records attachment summaries and placeholder text.
- The current remote tool denial is too coarse for the desired AX. The implementation should stay simple: trusted 1:1 remote contexts should be treated differently from shared/multi-party remote contexts.
- We should avoid using this task to redesign every channel policy. The minimum useful fix is a trust-aware unlock for the actual remote contexts Slugger uses today.
- The current remote coding inspectability gap is partly self-inflicted: the manager already tracks tails internally, but the tool surface does not expose enough of that state to the agent.
- The simplest path for debug activity is one per-turn status message whose content is edited across lifecycle events. We do not need a separate polished “native activity mode” for this task.

## Progress Log
- 2026-03-08 17:30 Created validated planning doc for trusted remote tools, coding inspectability, and BlueBubbles fidelity fixes.
- 2026-03-08 17:35 Approved the planning doc and expanded completion criteria to preserve the full BlueBubbles feature envelope.
