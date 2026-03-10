# Workflow Helpers

These files are the source-of-truth workflow helpers for:

- `work-planner`
- `work-doer`
- `work-merger`

They are written to stay generic enough for different agent shells, while following this repo’s local rules through `AGENTS.md`.

## What They Do

- `work-planner.md`
  Creates and refines planning docs, then converts approved plans into doing docs.
- `work-doer.md`
  Executes approved doing docs unit by unit with strict validation discipline.
- `work-merger.md`
  Syncs with `main`, resolves conflicts, creates the PR, handles CI, and merges.

## Important Repo-Specific Truth

These helpers do not hardcode task-doc paths. They are expected to read project instructions to discover them.

In this repo, that means:

- task docs live in `~/AgentBundles/<agent>.ouro/tasks/one-shots/`
- not inside the repo

## Installing For Claude Code

```bash
mkdir -p ~/.claude/agents
cp subagents/*.md ~/.claude/agents/
```

## Installing For Codex-Style Skills

```bash
mkdir -p ~/.codex/skills/work-planner ~/.codex/skills/work-doer ~/.codex/skills/work-merger
cp subagents/work-planner.md ~/.codex/skills/work-planner/SKILL.md
cp subagents/work-doer.md ~/.codex/skills/work-doer/SKILL.md
cp subagents/work-merger.md ~/.codex/skills/work-merger/SKILL.md
```

If you prefer symlinks or hard-links, that is fine too, but plain copies are easier to reason about and easier to repair when editors replace files.

## Keeping Local Skill Copies Fresh

After editing any `subagents/*.md` file, resync your local installed copies.

The repo workflow usually checks this with diffs like:

```bash
diff -q ~/.codex/skills/work-planner/SKILL.md subagents/work-planner.md
diff -q ~/.codex/skills/work-doer/SKILL.md subagents/work-doer.md
```

## Restart Behavior

Some tools only discover new skills on startup. If a shell/app does not see updates immediately, restart that shell/app after syncing.
