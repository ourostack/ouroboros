# Sync And Merge Conventions

This document describes the shared merge behavior expected in this repo.

## Branch Naming

Use the `<agent>/<slug>` convention:

- `ouroboros/runtime-metadata`
- `slugger/bluebubbles-ax`

Do not create new `codex/<agent>` branches.

## Merge Strategy

- Merge to `main` through pull requests.
- Use merge commits, not squash or rebase, unless project policy explicitly changes.
- Do not push directly to `main`.

## Task-Doc Truth

Task docs are bundle-owned now. Do not assume they live in this repo.

The project-defined location is:

`~/AgentBundles/<agent>.ouro/tasks/one-shots/`

Planner/doer/merger should read `AGENTS.md` to discover that location rather than hardcoding it.

## Conflict Resolution

When main has moved since the feature branch split:

1. Read your own doing doc to understand your branch’s intent.
2. Use git history and diffs to understand what landed on `main`.
3. Optionally read other local task docs only if they materially clarify a conflict.
4. Resolve conflicts by preserving both intents whenever possible.

Primary git inputs:

```bash
git fetch origin main
git log origin/main --not HEAD --oneline
git diff --name-only HEAD...origin/main
```

Do not rely on repo-local task-doc globbing. That old model is gone.

## PR Workflow

After the branch is synced and tests pass:

1. push the feature branch
2. create a PR
3. wait for CI
4. self-repair fixable CI failures
5. merge to `main`
6. clean up the feature branch

PR descriptions should summarize the actual shipped change, not just paste work-unit names.

## CI Failure Handling

The merge agent should attempt self-repair first for:

- test failures
- type-check failures
- coverage failures
- merge-break regressions

Escalate only when:

- the intent is genuinely ambiguous
- `gh` is unavailable or unauthenticated
- there is no GitHub remote
- repeated repair attempts still do not converge

## Post-Merge Cleanup

After merge:

```bash
git checkout main
git pull origin main
git branch -d <branch>
git push origin --delete <branch>
```

## Source Of Truth

The detailed executable workflow lives in:

- `AGENTS.md` for repo-scoped merge policy and workflow gates
- `github.com/ouroborosbot/ouroboros-skills` (`skills/work-merger/SKILL.md`) for the shared work-merger skill definition

This doc exists to keep the repo-level policy discoverable, concise, and current.
