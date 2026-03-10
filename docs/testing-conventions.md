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

For runtime code changes, keep these green:

```bash
npm test
npx tsc --noEmit
npm run test:coverage
```

Treat warnings as problems to fix, not background noise.

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
- [ ] new or changed code is fully covered
- [ ] runtime observability contracts remain valid

## Documentation-Only Changes

For docs-only work, the main requirement is truthfulness.

That usually means:

- fix or remove stale claims
- run targeted stale-reference searches over touched docs
- make sure the docs match the current code and workflow

If you changed runtime code and docs together, follow the full runtime test rules above.
