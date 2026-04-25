# Mail Convergence Pass 2 Planning

## Goal

Run the second post-full-moon convergence pass on agent mail by repairing the remaining operating-model seams Slugger called out after pass 1: make import failures classify themselves instead of leaving recovery implicit, make mail lanes and browser-downloaded artifacts legible through a first-class mail status surface, and remove the hosted-registry `sender policy: skipped (registryPath missing)` smell from family Screener decisions.

## Scope

### In Scope

- Add explicit mail-import failure classifications and stronger recovery hints to background-operation / `query_active_work` surfaces.
- Add a first-class mail-native status surface that shows the canonical lane map, delegated-source bindings, recent browser-download/import artifacts, and current import truth without requiring mental reconstruction from multiple tools.
- Make hosted mail setups read delegated alias/source-grant status from hosted registry coordinates instead of pretending the answer is unknown when `registryPath` is absent.
- Persist sender policy changes from Screener decisions in hosted-registry setups so happy-path family flows do not emit `sender policy: skipped (registryPath missing)`.
- Update docs/tests so future agents are oriented to the repaired model.
- Reload the live runtime and have Slugger evaluate the new surface again.

### Out of Scope

- A generic browser-download inventory for non-mail workflows.
- Full Mailbox UI redesign or a new visual lane dashboard.
- Reworking HEY onboarding/export itself.
- Autonomous native-send scope changes.

## Completion Criteria

- [ ] Failed mail-import operations carry an explicit recovery/failure classification and stronger next-step truth in `query_active_work`.
- [ ] A first-class mail status surface exposes the native/delegated lane map plus recent import/download truth.
- [ ] Hosted mail setups no longer degrade delegated alias/source-grant truth to `unknown` merely because `registryPath` is absent.
- [ ] Happy-path hosted Screener/link-family decisions do not emit `sender policy: skipped (registryPath missing)`.
- [ ] Automated tests cover all changed behavior at 100% for modified files.
- [ ] Runtime is reloaded locally and verified against the live Slugger setup.
- [ ] Slugger reviews the new pass and either signs off or produces the next convergence feedback set.

## Code Coverage Requirements

- 100% coverage on every changed branch in modified files.
- Add focused tests for hosted-registry policy persistence, lane/download status rendering, and failure classification surfaces.
- Run the repo coverage gate before closing the pass.

## Open Questions

- None for this pass. The user explicitly asked for continuous convergence loops without stopping at approval gates mid-run.

## Decisions Made

- The pass will improve the operating model, not just wording: recovery classes, lane map, and hosted-registry writes are all real behavioral changes.
- The browser-download truth surface will remain mail-scoped rather than becoming a generic browser abstraction.
- Lane clarity belongs in a first-class mail status surface, not in scattered status footnotes.
- Hosted registry truth should use the same runtime config shape the reader already trusts; `registryPath` is not the architectural primitive.

## Context / References

- `slugger/tasks/2026-04-24-1102-planning-mail-convergence-pass1.md`
- `slugger/tasks/2026-04-24-1102-doing-mail-convergence-pass1.md`
- `docs/agent-mail-setup.md`
- `docs/agent-mail-recovery.md`
- `src/repertoire/tools-mail.ts`
- `src/mailroom/reader.ts`
- `src/heart/active-work.ts`
- `src/heart/daemon/cli-exec.ts`
- Slugger post-pass-1 review from `mcp__ouro_slugger__.send_message` on 2026-04-24

## Notes

- Spark:
  Slugger should be able to operate mail from one truthful mental model: what lanes exist, what the latest browser/mail artifacts are, what failed, and which class of repair is appropriate.
- Observed terrain:
  Hosted mail setups already have enough registry coordinates to read truth, but several operator surfaces still overfit `registryPath`.
  `mail_decide` persists sender policy only when a filesystem registry path exists, which is why hosted happy paths still print the wrong smell.
  `query_active_work` now carries ids/timestamps/path truth, but failures still read as prose rather than an explicit recovery class.
  There is no dedicated mail-native status surface, so lane/alias/download truth is still reconstructed from `mail_recent`, `query_active_work`, and docs.
- Surviving shape:
  One mail status surface should expose the lane map and recent mail-ingest artifacts.
  One registry helper path should serve both file-backed and hosted registry reads/writes.
  One explicit failure classification should ride with mail-import background operations so recovery is machine-legible.
- Scrutiny notes:
  Tinfoil Hat: adding only better prose to `query_active_work` leaves operators guessing whether an issue is retry-safe or structural.
  Stranger With Candy: a generic browser-download API would feel satisfying but would solve the wrong boundary; the useful primitive is “mail-visible recent import artifacts.”
- Thin slice:
  Add a `mail_status` tool, add hosted registry write support for sender policy, and classify mail-import failures into a few operator-meaningful buckets with explicit output.
- Non-goals for this pass:
  Big UI work, cross-domain browser inventory, and HEY-specific onboarding automation changes.

## Progress Log

- 2026-04-24 11:36 Planning doc created for the second convergence pass.
