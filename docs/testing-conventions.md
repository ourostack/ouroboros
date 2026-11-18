# Testing Conventions

These are the shared testing rules for code changes in this repo.

## Coverage Policy

Coverage is enforced at `100%` for:

- statements
- branches
- functions
- lines

Do not lower thresholds. If a change touches code, the changed behavior needs complete coverage.

## Required Commands

In a fresh worktree, install the repo-pinned local toolchain first:

```bash
npm run worktree:bootstrap
```

It reuses another checkout's `node_modules` when its installed versions match this `package-lock.json` (a copy-on-write clone on macOS, no network); otherwise it runs `npm install --ignore-scripts` without lifecycle scripts and explains any registry failure. Do not use direct `npx vitest`, `npx tsc`, or other local tool commands before bootstrapping; the repo `.npmrc` rejects new transient `npx` downloads, and Vitest config prints bootstrap guidance if an existing npm exec cache is reused without `node_modules`.

For runtime code changes, keep these green:

```bash
npm test
npx tsc --noEmit
npm run test:coverage
npm run test:integration
npm run test:e2e:package
npm run test:e2e:real-smoke -- --secrets-file /absolute/path/to/ouro-real-smoke.json
```

Treat warnings as problems to fix, not background noise. The real-smoke lane is the live external check; keep it ready in CI and run it locally whenever the change touches provider auth, portable capability onboarding, or live verification behavior and you have the sacrificial secrets file available.

## Cancelled Required Checks

The `Recover cancelled required checks` workflow handles completed CI runs, without a schedule. It requests one full rerun only for an open, non-draft PR with auto-merge enabled at the run's current head and a cancelled check required by its target branch, including the required GitHub App identity. A newer run covering that PR/head, any failed job or step, or a failed required check blocks recovery. In particular, a failed release preflight followed by whole-run cancellation is a failed gate, not a recoverable cancellation.

GitHub increments `run_attempt` on rerun; only attempt 1 is eligible. A manual rerun also consumes that lineage's budget. The handler serializes by run id and rechecks the live PR and attempt before requesting a rerun. Disarming auto-merge stops recovery. Cancellation actor identity is not inferred from the original run actor.

Recovery executes only trusted default-branch code, never the triggering PR's code or artifacts. Its dependency-free regression tests run with `node --test .github/scripts/recover-cancelled-checks.node-test.cjs`; the workflow enforces complete coverage for the recovery module. The `node-test` filename keeps Vitest from discovering a suite that belongs to a different runner.

## Dated npm Audit Exceptions

The existing release-preflight policy permits reviewed entries in `docs/audit-exceptions.json` when no patched release exists. A normal repository-reviewed PR and required-check merge authorize an entry; the policy does not name a separate approval role. General `intentional-debt.json` records do not accept npm advisories.

Each audit entry covers exactly its advisory URL and source dependency, with a reason and a valid UTC due date. Preflight stops accepting it on that date, so the release gate reopens without automatic renewal. Other advisories still fail unless independently covered. The picomatch risk remains open in [#1391](https://github.com/ourostack/ouroboros/issues/1391), owned by Ouroboros maintainers, and expires on 2026-11-24; it is not a vulnerability fix.

## TDD Rule

Use strict red -> green -> refactor.

1. Write or update tests first.
2. Run them and confirm the new behavior is not already passing by accident.
3. Implement the smallest change that makes them pass.
4. Refactor while staying green.
5. Re-run the full required commands.

## Mocking Rule

- Mock network boundaries and external SDK behavior.
- Keep tests deterministic.
- Prefer the existing local test patterns in `src/__tests__/`.
- Reset cached config/runtime state between tests when the code under test depends on it.

## Runtime Observability Rule

Testing here is not only about return values. New production paths must also participate correctly in the nerves audit model.

That means:

- production code emits nerves events
- tests observe those events
- source coverage and start/end pairing stay valid

## Doing-Doc Evidence

When working through a doing doc, keep auditable evidence in the task’s adjacent artifacts directory under the owning bundle.

Typical evidence:

- failing-test logs
- green-test logs
- coverage logs
- notes that explain validation decisions

## Completion Checklist

Before calling runtime work complete:

- [ ] approved doing doc units are complete
- [ ] `npm test` passes
- [ ] `npx tsc --noEmit` passes
- [ ] `npm run test:coverage` passes
- [ ] `npm run test:integration` passes for runtime/daemon/provider/auth changes
- [ ] `npm run test:e2e:package` passes for package-install or CLI distribution changes
- [ ] `npm run test:e2e:real-smoke -- --secrets-file /absolute/path/to/ouro-real-smoke.json` passes when live provider/capability verification changed and sacrificial credentials are available
- [ ] new or changed code is fully covered
- [ ] runtime observability contracts remain valid

## Documentation-Only Changes

For docs-only work, the main requirement is truthfulness.

That usually means:

- fix or remove stale claims
- run targeted stale-reference searches over touched docs
- make sure the docs match the current code and workflow

If you changed runtime code and docs together, follow the full runtime test rules above.
