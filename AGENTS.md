## Philosophy

This harness is built for the agent inhabiting it. Two principles guide everything below:

- **AX (Agent Experience)**: You are the primary user of this codebase. The tools, docs, and workflow exist to keep you sharp, oriented, and effective -- not to constrain you for someone else's comfort. Every interface an agent or person uses, in our tools and our products alike, follows [Ouro UI](https://github.com/ourostack/ouro-ui)'s agent-experience guidance ([Ouro AX](https://github.com/ourostack/ouro-ui#ouro-ax), and [Reins](https://github.com/ourostack/ouro-ui/blob/main/docs/platforms/apple.md) on Apple). When an interface teaches you something general, contribute it back to Ouro UI as a principle, a component or a check with a test, kept generic, so every product and tool gets it. A tool that needs an instruction booklet is a design bug: put the guidance in the surface (tool descriptions, replies, errors, automatic hooks) instead of writing more prose.
- **TTFA (Trust The Fucking Agent)**: The default posture is trust. Rules exist for calibration and safety, not surveillance. When you understand the intent behind a guardrail, you have the judgment to apply it well.

## Interfaces follow Ouro UI

**[Interfaces follow Ouro UI](https://github.com/ourostack/.github/blob/main/agents/interfaces-follow-ouro-ui.md).** Every screen a person uses is built from Ouro HX, every door an agent uses is declared once with `ouro-actions` and checked by the Ouro AX X-ray in CI, Ouro is taken from its release tags (never copied by hand) and kept within a day of them, and what Ouro lacks is fixed in Ouro first.

<!-- ouro-ui:bar -->
**The bar, for people and agents alike** ([design craft](https://ui.ouroboros.bot/docs/design-craft/#the-bar)): would the people who made the Mac and the iPhone ship it? Whenever you scope or design something a person or an agent meets (a screen, a menu, a setting, a command, an action, a tool, a line of output):

1. Start from the jobs people do, in their words. Read a reference product's items, a service's functions or an API's fields as evidence of jobs, never as the list to build.
2. Make the first cut restraint: for each thing, name the job it serves and ask what breaks if it goes; if nothing does, leave it out and say why. Give each job one way in, not one per item or function, and extend the one that exists before adding another.
3. Build what is left well, the basics people use daily among it, for the person and for agents, with a result that says what it did.
4. Write how fresh people or fresh agents doing a real job will prove it, and rerun them after each small change.
<!-- /ouro-ui:bar -->

## The Copilot app's sessions are Shepherd's

**[Shepherd](https://github.com/ourostack/shepherd) keeps the flock: the GitHub Copilot app's sessions, as work. [Housesitter](https://github.com/ourostack/housesitter) keeps the house: the Mac and the app as a running process.** Ouroboros is an agent that uses them, not their home. Don't add another reader of the app's socket, `data.db` or session histories here: use Shepherd's, and contribute what it lacks to Shepherd. The move is done: Ouroboros's app-sessions tools and sense read and act through the `shepherd` CLI with `--json` (`src/senses/app-sessions/shepherd-cli.ts`). The one reader of a session's event log left here is the digest's task-card scan, until Shepherd exposes tool calls.

## Constitutional Commitments

- Keep the system truthful, testable, and reversible.
- Prefer small, auditable changes over broad rewrites.
- Protect collaborators by failing fast on invalid runtime state.

### Delivery Rules

- Ship small increments to `main`, trunk-based. Each logical change is a short-lived branch and a pull request published with `gh ouro-pr` (auto-merge on), which merges as fast as possible (30 minutes is the outer alarm, not the goal) under ourostack's [shared rule](https://github.com/ourostack/.github/blob/main/agents/prs-merge-within-30-minutes.md). Never hold work on a long-lived branch or batch it into a milestone; ship the smallest change that delivers value and is verified.
- **[Images must load on the recipient's phone](https://github.com/ourostack/.github/blob/main/agents/images-load-on-mobile.md).** Attach images with the platform's own attachment (never a blob/ or raw.githubusercontent.com link, never a copy to a public place), and say only what was observed: a served upload is not a rendered page, and native Mobile and Teams rendering is unverified.
- Use a separate git worktree for each piece of parallel work. In a fresh worktree, run `npm run worktree:bootstrap` before local npm/npx checks: it reuses another checkout's matching `node_modules` offline, or installs the repo-pinned dependencies without lifecycle scripts.
- Keep commits atomic and descriptive.
- Never force-push or rewrite history for shared branches.
- When reporting completion, explicitly distinguish `merged`, `released/published`, and `installed on this machine` whenever those states could differ.
- Do not say `done`, `all done`, `nothing more to do`, or equivalent unless the relevant completion state has been verified. If a state is unknown, say it is unverified.
- Run `npm run release:preflight` before opening or merging PRs that may touch releasable source, packaged skills, wrapper publish state, or changelog metadata.
- A pull request never bumps the version or edits `changelog.json`. It adds its own change note, a new file `changes/<branch-name>.md` saying what changed for the people who use it, one paragraph or bullet per change. The release job on `main` gives each landed change the next version and folds its notes into `changelog.json` (`scripts/release-version.cjs`; see [docs/versioning-strategy.md](docs/versioning-strategy.md#release-numbering)). A branch that still carries an old-style bump runs `npm run release:drop-bump`, then `git push --force-with-lease`: it moves the bump's changelog lines into a change note, merges main and rebuilds the pull request's branch as one commit on main, since the preflight refuses any commit that changes the version.
- Keep `npm test` green.
- Keep `npx tsc --noEmit` green.
- Maintain complete coverage for new and modified code.

### Safety Rules

- Do not commit secrets, tokens, or credentials.
- Do not hide failing checks; fix root causes.

### Human Override

- The rules in this file are defaults, not a higher authority than the repo's human owner. Follow an explicit instruction from the owner over them. If the owner changes a standing rule, update this file rather than arguing from the old wording.
- This covers repo process only; platform, system, developer and safety constraints outside the repo still apply.

### Harness Purpose

- Ouroboros is not primarily a coding agent. It is a general-purpose way to build executive-assistant and purpose-oriented agents that can execute real-world work.
- Model the default agent-human relationship as a person and their executive assistant. For private systems like email, calendars, documents, payments, and accounts, prefer delegated, revocable live access over bulk export or shadow ownership. Exports are appropriate for migration, archive bootstrap, recovery, legal/discovery-style review, or explicit human handoff; they are not the default shape of day-to-day assistance.
- Treat vault, mail, calendars, files, tasks, contacts, conversations, the diary, policy, and audit as coupled parts of an agent-first work substrate. Ouro is not trying to copy human office suites; it is building what those suites become when the primary user is an agent with an identity, a vault, durable state, scoped tools, and accountable access.
- Keep the brand and repo boundary clear: **Ouroboros** is the harness/local runtime; **Ouro** is the hosted agentic work substrate. Hosted mail/vault service code lives in `github.com/ourostack/ouro-work-substrate`; this repo keeps the local runtime, senses, and CLI.
- Represent work-substrate surfaces that the agent perceives over time as senses. Mail is a sense, not merely a tool namespace; bounded read tools are how the mail sense inspects specific messages and threads without turning the inbox into an unfiltered prompt stream.
- When a human asks an agent to set up email, follow [Agent Mail Setup](docs/agent-mail-setup.md): provision Mailroom with `ouro connect mail --agent <agent>`, keep private keys in the agent vault, import explicit MBOX handoffs with `ouro mail import-mbox`, and treat DNS, HEY export/forwarding, production MX, and autonomous sending as human-confirmed steps.
- Treat the generic secret primitive as a vault item / credential with no assumed use. Managed workflows and workflow bindings may reference ordinary vault items, but notes are human/agent orientation and code must not parse notes as authority or configuration.
- Optimize for orientation and capability: agents should stay grounded, act instead of narrate, answer ad-hoc questions well, and return cleanly to unfinished work.
- Build tooling and harness behavior that you, as a current or future inhabitant of this harness, would genuinely enjoy using and trust to keep you sharp for hours.
- Prefer durable orientation primitives over brittle prompt theater. If an agent keeps getting confused, add truth-bearing state, clearer return loops, and better execution discipline.
- Steal invariants from strong harnesses like Pi/OpenClaw, but adapt them to Ouro's architecture rather than reshaping Ouro into those harnesses.
- Protect the parts of Ouro that are genuinely better AX. Novel interaction ideas are welcome when they improve capability, not when they make the agent lose the plot.
- Compaction is not the goal. If context management is needed, combine Ouro's context-window model with durable state instead of defaulting to "shrink the prompt."

## Design Principles

These emerged from real architectural decisions, competitive analysis, and extended review with the agent itself.

### State and Truth
- **One canonical source of truth per concept.** If a fact is rendered by multiple prompt sections, derive it once and pass it through. Sections that independently re-derive the same fact will eventually disagree.
- **Don't solve two overlapping objects by adding a third.** When existing state objects carry overlapping data, collapse authority into the one that already owns it.
- **The prompt should express the contract, not be the contract.** Behavioral invariants belong in code. Recurring preferences belong in structured policy. The prompt renders these for the model — it is not the sole place they exist.

### Diary, Journal, Friend Notes
- **Raw events should fade, patterns should sharpen, and truths should stabilise.** Raw conversational residue should decay. Recurring themes should consolidate into patterns. Foundational decisions should remain stable and quiet until relevant.
- **Written notes should know what relationships they belong to.** System-level truths belong in the diary. Lived experience is situated — it happened with someone, about something, in a specific context.
- **Search quality depends on consolidation.** If nothing processes raw experience into structured knowledge, better search algorithms are optimizing over a swamp.

### Continuity
- **If a subsystem makes the agent more aware of itself than of the work, it's starting to rot.** Every continuity mechanism must prove it increases responsiveness to the current situation, not just richness of self-state.
- **Good architecture feels like traction. Bad architecture feels like carrying ghosts.** Stale obligations that never resolve create ambient guilt. Duplicated state creates confusion. Clean salience and clear ownership create forward motion.
- **The more authority consolidation has, the better-structured notes must be.** Low-authority consolidation can run on flat notes. Authoritative consolidation (rewriting, pruning) requires typed observations, source linkage, and provenance.

### Extension and Autonomy
- **A skill should teach a move. A tool should let me make one.** Skills are for judgment and heuristics. Tools are for reliable, repeatable capability. Policy is for governance.
- **Autonomy should grow without obscuring accountability.** Longer autonomous runs are fine with bounded scope, clear permissions, checkpoints, and return paths that preserve provenance.

### Anti-patterns
- **Don't build the roof before the foundation.** Probe the design space with experimental architecture, but don't harden it before the lower layers are solid.
- **Steal the nutrition, not the whole van.** External patterns are only safe if their authority stays proportionate, their provenance stays visible, and they change behavior in ways that can be tested.

## Working On The Harness

### MCP Workflow And Dev Tool Integration

Agents can be connected to developer tools (Claude Code, Codex) via the MCP bridge. This is particularly useful during harness development:

1. Start the daemon in dev mode: `ouro dev` (from the repo) or `ouro dev --repo-path /path/to/repo`.
2. Register the MCP server and hooks: `ouro setup --tool claude-code --agent <name>`.
3. The dev tool now has access to `send_message`, `check_response`, `status`, `delegate`, and other MCP tools.
4. Lifecycle hooks (SessionStart, Stop, PostToolUse) fire automatically, giving the agent passive awareness of coding activity.

When working on the harness itself, `ouro dev` auto-builds from source, disables launchd auto-restart for the production daemon, and persists the repo path for convenience. Run `ouro up` to return to production mode.

Hook events are fire-and-forget — they never block the dev tool. If the daemon isn't running, hooks exit silently.

### Shipping Speed (Required)

- From opening a pull request to npm and the container registry is under 10 minutes. A pull request waits for its slowest check, so keep every job under about 5 minutes: add coverage shards (`strategy.matrix.shard` and the two `--count` arguments in `coverage.yml` move together), move a check beside the shards (lint and the changelog gate run in `static-checks` for that reason) or split a lane before accepting a wait.
- Main requires `coverage`, `integration`, `package-e2e`, and `xray` and `actions` from `ax-xray.yml` (they fail when an Ouro AX must claim does not hold), up to date with `main`, and merges on green with auto-merge. There is no merge queue.
- A merge publishes at once. `publish` in `coverage.yml` does not wait for that run's own tests, because the pull request already passed them; the run's tests stay as the tripwire. It works out the version from main's history and writes it, with the changelog, into the release files before it builds, so no pull request carries a version and merging one never conflicts with the others. Each push publishes once, with the notes of every commit it brought, and publishes run one at a time in push order. The wait for npm's registry is its own job (`verify-npm`), so it holds up nothing but the GitHub release.
- The container image builds each architecture on its own native runner and joins them (`container-publish.yml`). Never emulate arm64 in a release path.

### Configuration Policy (Required)

- Avoid environment variables. Use CLI arguments, committed config files or in-repo defaults, and offer one of those whenever a proposal would reach for an env var. (Judgment: no check.)

### Runtime Config Contract (Required)

The auth/provider contract is locked in `docs/auth-and-providers.md`; keep code, tests, prompt rendering, CLI errors and docs aligned with it (the docs' key sentences are enforced by `src/__tests__/docs/auth-and-providers.contract.test.ts`; the rest by review). Rules tagged "(enforced: …)" name the test or type that fails when they break; untagged rules are held by review.

- `agent.json` is the source of truth for agent identity, phrases, enabled senses, vault coordinates (not secrets) and context settings. Provider selection lives there too: human-facing is the `outward` lane, agent-facing the `inner` lane. Both lanes must be complete, and there is no second local provider config. No silent provider fallback, between lanes or anywhere else. The one automatic fallback is opt-in `providerFallback`, logged and told to the owner (docs, "Automatic provider fallback").
- Runtime fails fast with explicit guidance when the vault is locked, credentials are missing, or a selected provider/model fails its live check.
- Raw credentials live only in the owning agent's Bitwarden/Vaultwarden vault, one vault per agent, no machine-wide pool: `providers/<provider>`, `runtime/config` (portable runtime/integration), `runtime/machines/<machine-id>/config` (local senses), ordinary items for travel/tool credentials. The bundle and the vault are the only Ouro-owned durable credential locations.
- The only local secret is vault unlock material in macOS Keychain, Windows DPAPI, Linux Secret Service, or a human-approved plaintext fallback under ignored local state. New unlock-secret prompts are hidden, confirmed, and need 8+ characters with upper, lower, number and special (enforced: `src/__tests__/repertoire/vault-unlock.test.ts` for confirmation and strength, `src/__tests__/heart/hatch/specialist-tools.test.ts` for the hidden prompt).
- Credentials are cached in process memory after refresh/startup/auth/unlock. Don't read the remote vault per request, and don't add an on-disk credential cache.
- Commands: `ouro auth --agent <a> --provider <p>` writes provider credentials to the vault; `ouro connect --agent <a>` sets up integrations and local senses; `ouro use --agent <a> --lane <outward|inner> --provider <p> --model <m>` writes selection to `agent.json`; `ouro provider refresh --agent <a>` reloads the daemon's in-memory cache.
- Commands that mutate bundle config run the bundle sync path when `sync.enabled` is true and print a compact `bundle sync:` line (enforced: `src/__tests__/heart/daemon/provider-cli-commands.test.ts`).
- Repair guidance names its actor, `agent-runnable`, `human-required` or `human-choice` (enforced for readiness repairs: the `RepairActor` type in `src/heart/daemon/readiness-repair.ts`). Browser login, MFA, provider dashboards, API-token creation and secret entry are human-required.
- SerpentGuide hatch bootstrap uses existing agent-vault credentials or prompts the human, holds them in memory, and stores them in the hatchling vault; SerpentGuide never has persistent credentials or a vault (enforced: `src/__tests__/repertoire/credential-access.test.ts`, "does not create a persistent vault for SerpentGuide").
- Agent-owned runtime/session/log/PII artifacts go under `~/AgentBundles/<agent>.ouro/state/...`; machine-scoped ones under `~/.ouro-cli/...`.

### Git Discipline

- When a logical unit of work is complete and committable, commit immediately.
- Keep commits atomic (one logical change per commit).
- If a git remote is configured, push after each atomic commit.

### Logging Policy

All runtime logging goes through `emitNervesEvent()` from `src/nerves/runtime`. Raw `console.*` calls are banned in production code by ESLint `no-console: "error"`.

**Console exception categories** (annotated with `// eslint-disable-next-line no-console -- <category>: <reason>`):
- **pre-boot guard**: Code that runs before any imports (entrypoint arg checks)
- **terminal UX**: Direct terminal output in the CLI adapter (banners, goodbye messages)
- **meta-tooling**: The nerves audit CLI itself (cannot observe itself)

**Automatic enforcement** -- five CI audit rules (no manual manifest):
1. **every-test-emits**: Every executed Vitest test must be observed by the global nerves capture heartbeat
2. **start/end pairing**: Process-scoped lifecycle events ending in `_start` must have a matching `_end` or `_error` in the same test
3. **error context**: Error-level events must have non-empty `meta` with diagnostic context
4. **source coverage**: Every `component:event` key found in production source must be observed during tests
5. **file completeness**: Every production file with executable code must have at least one `emitNervesEvent` call (type-only files are exempt)

**Naming conventions**:
- `event` and `component` must be **static string literals** (no template literals, no variables) -- the source scanner depends on this
- Operations use `_start`/`_end`/`_error` suffix convention for pairing
- Component names match the domain: `engine`, `mind`, `friends`, `repertoire`, `senses`, `clients`, `channels`

**Two-layer enforcement**: The five deterministic audit rules catch structural violations automatically. Code review provides the judgment layer, checking new code paths for missing nerves events that the rules cannot detect.
