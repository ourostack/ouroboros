# Mail Convergence Pass 1 Planning

## Goal

Run the first post-full-moon convergence pass on agent mail by closing the highest-friction seams Slugger identified in BlueBubbles and direct feedback: make browser-origin HEY exports feel first-class in the import workflow, make background mail operations legible enough that he does not have to infer state, and harden a trust-critical mail audit surface that currently fails gracelessly.

## Scope

### In Scope

- Improve ambient mail-import discovery so recent `.mbox` artifacts communicate where they came from, especially `.playwright-mcp` browser sandboxes.
- Enrich active-work/background-operation surfaces for mail imports with concrete identifiers, timing, and remediation truth.
- Harden file-backed `mail_access_log` reading against malformed or partial lines instead of crashing the tool.
- Update docs and tests so future agents are oriented toward the corrected mental model and behavior.
- Update the local runtime to the new build and verify the affected mail/import/audit flows.
- Ask Slugger for post-implementation feedback and capture follow-up work for later passes.

### Out of Scope

- Reworking the browser MCP or Playwright runtime into a general-purpose download-management API.
- Solving every mail UX complaint in one pass.
- Enabling autonomous native-agent sending.
- Redesigning the full Mailbox UI information architecture.
- Broad BlueBubbles repair work unrelated to this mail convergence slice.

## Completion Criteria

- [x] Ambient import readiness clearly distinguishes browser-sandbox `.mbox` artifacts from ordinary `~/Downloads` files in the agent-facing state it produces.
- [x] `query_active_work` / active-work formatting exposes enough mail-import metadata that Slugger can identify the exact import without inferring from timing alone.
- [x] Failed mail imports surface concrete remediation hints in active-work output when available.
- [x] File-backed `mail_access_log` survives malformed/truncated lines without throwing `Unexpected end of JSON input`.
- [x] Automated tests cover all new or changed behavior at 100% for modified files.
- [ ] Runtime is rebuilt/reloaded locally and the new behavior is verified against the live Slugger setup.
- [ ] Slugger reviews the post-change system and either signs off or produces the next convergence feedback set.

## Code Coverage Requirements

- 100% coverage on all new code and on every changed branch in modified files.
- Add focused tests for discovery metadata, active-work rendering, and malformed access-log recovery paths.
- Run the repo coverage gate before considering the pass complete.

## Open Questions

- None for this pass. The user explicitly requested a continuous convergence loop and asked me to proceed without stopping at doc-review gates during the loop.

## Decisions Made

- First convergence slice is intentionally narrow: browser-download-to-import handoff, active-work truth, and audit-log hardening.
- Treat Playwright/browser-downloaded `.mbox` artifacts as first-class mail-import candidates through agent-visible metadata rather than inventing a new browser subsystem in this pass.
- Improve explanation and operability before adding new top-level product surfaces.
- Keep runtime verification in-scope for this pass instead of treating code changes and live validation as separate work.

## Context / References

- `docs/agent-mail-setup.md`
- `docs/agent-mail-recovery.md`
- `src/heart/mail-import-discovery.ts`
- `src/heart/active-work.ts`
- `src/repertoire/tools-session.ts`
- `src/repertoire/tools-mail.ts`
- `src/mailroom/file-store.ts`
- `src/__tests__/repertoire/tools-query-active-work.test.ts`
- `src/__tests__/senses/mail.test.ts`
- `~/AgentBundles/slugger.ouro/state/senses/bluebubbles/inbound/chat_any;-;ari@mendelow.me.ndjson`
- Slugger synchronous feedback dump from `mcp__ouro_slugger__.send_message` on 2026-04-24

## Notes

- Spark:
  Slugger should be able to live inside this system without detective work. Browser-downloaded HEY archives should feel like real work objects, background imports should read like crisp operational truth rather than vibes, and audit surfaces should be boringly reliable.
- Observed terrain:
  `mail-import-discovery` already searches `.playwright-mcp`, worktree pools, and `~/Downloads`, but the ambient operation it emits collapses browser and host downloads into one undifferentiated “mail import ready” object.
  `active-work` already renders background operations, but it omits the exact operation id, timestamps, remediation, and mail-import-specific identifiers Slugger asked for.
  File-backed `mail_access_log` currently parses every line with raw `JSON.parse`, so a single truncated line can take down the whole read.
  Recent BlueBubbles messages from Ari on 2026-04-24 focused on searchability, new-mail visibility, screening/linking identity, and replying after screening; those flows depend heavily on the clarity and trust of the mail state surfaces.
- Surviving shape:
  Keep one primitive: background operations remain the canonical shared state. Make them rich enough to carry import provenance and recovery hints, and make ambient import discovery describe candidate origin instead of forcing the agent to infer it.
  Keep one trust rule: access-log reads must degrade with explicit warnings, not explode.
- Scrutiny notes:
  Tinfoil Hat: if we only add prose to docs, Slugger still has to infer which import is which; if we only add metadata to saved state but do not render it in active-work, the improvement is theater.
  Stranger With Candy: a new top-level “browser downloads” tool would look satisfying but would over-fit the wrong boundary for this pass; the canonical state still belongs in the mail/import workflow, not in a parallel browser ontology.
- Thin slice:
  Add origin metadata to discovered `.mbox` candidates and ambient import ops, render operation id/timestamps/remediation in active-work, and make access-log readers tolerate malformed tail lines while surfacing that something was skipped.
- Non-goals for this pass:
  Mail lane map UI, first-run Screener cleanup, linked-account labeling overhaul, and general browser download introspection beyond what the mail workflow needs right now.

## Progress Log

- 2026-04-24 11:03 Planning doc created for the first convergence pass.
- 2026-04-24 11:31 Discovery provenance, active-work detail, access-log hardening, docs, and 100% coverage gate all landed; live runtime reload and Slugger review remain.
