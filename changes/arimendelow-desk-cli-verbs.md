`ouro desk` now calls the tools the agent's built-in Desk actually has, so each verb works instead of failing at Desk:
- Tasks are named `<track>/<slug>` everywhere. `ouro desk task new <track>/<slug>` (or `<slug> --track <track>`) takes an optional `--title`, which is the slug when you leave it out.
- `ouro desk task done <track>/<slug>` needs its proof: `--pr <url>` or `--commit <sha>`.
- `ouro desk task archive <track>/<slug>` archives a done task. Add `--cancelled` to archive one that was dropped.
- `ouro desk track new <slug>` needs `--title <title>` and `--scope "<what belongs>; not <what doesn't>"`.
- `ouro desk lesson add <text>` needs `--scope personal|desk|team` and `--topic <short name>`.
- `ouro desk status` shows whether the desk is ready, `ouro desk doctor` diagnoses the Desk server, and `ouro desk reindex` re-reads the desk into search.
- `ouro desk thread` is gone, because Desk has no such tool.
- `--desk <name>` on any of these verbs uses another desk named in the agent's agent.json instead of the main one. The `ouro task ...` shortcut takes the same arguments.
- `ouro desk track show <slug>` lists that track's tasks. `ouro desk track list` is gone, because Desk doesn't keep tracks in its search; `ouro desk task list` shows each task's track.
