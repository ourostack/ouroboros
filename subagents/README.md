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
mkdir -p ~/.agents/skills/work-planner ~/.agents/skills/work-doer ~/.agents/skills/work-merger

# Hard-link to keep one source of truth
ln -f "$(pwd)/subagents/work-planner.md" ~/.agents/skills/work-planner/SKILL.md
ln -f "$(pwd)/subagents/work-doer.md" ~/.agents/skills/work-doer/SKILL.md
ln -f "$(pwd)/subagents/work-merger.md" ~/.agents/skills/work-merger/SKILL.md
```

**Important:** For Codex/OpenAI skill installs, use the generic `~/.agents/skills` root and use hard links (`ln`, not `ln -s`). Installing the same skill into both `~/.agents/skills` and `~/.codex/skills` can produce duplicate entries in Codex. Symlinked `SKILL.md` files may load but are not advertised reliably by Codex surfaces. Hard-links break when editors save by replacing the file (new inode). After editing any `subagents/*.md` file, re-run the `ln -f` command for that file to restore the link. You can verify with `stat -f '%i'` — both files should share the same inode.

Optional UI metadata:

```bash
mkdir -p ~/.agents/skills/work-planner/agents ~/.agents/skills/work-doer/agents ~/.agents/skills/work-merger/agents
cat > ~/.agents/skills/work-planner/agents/openai.yaml << 'EOF'
interface:
  display_name: "Work Planner"
  short_description: "Create and gate planning/doing task docs"
  default_prompt: "Use $work-planner to create or update a planning doc, then stop at NEEDS_REVIEW."
EOF
cat > ~/.agents/skills/work-doer/agents/openai.yaml << 'EOF'
interface:
  display_name: "Work Doer"
  short_description: "Execute approved doing docs with strict TDD"
  default_prompt: "Use $work-doer to execute an approved doing doc unit by unit."
EOF
cat > ~/.agents/skills/work-merger/agents/openai.yaml << 'EOF'
interface:
  display_name: "Work Merger"
  short_description: "Merge feature branch into main via PR after work-doer completes"
  default_prompt: "Use $work-merger to merge the current feature branch into main."
EOF
```

## Keeping Local Skill Copies Fresh

After editing any `subagents/*.md` file, resync your local installed copies.

The repo workflow usually checks this with diffs like:

```bash
diff -q ~/.agents/skills/work-planner/SKILL.md subagents/work-planner.md
diff -q ~/.agents/skills/work-doer/SKILL.md subagents/work-doer.md
```

## Restart Behavior

Some tools only discover new skills on startup. If a shell/app does not see updates immediately, restart that shell/app after syncing.
