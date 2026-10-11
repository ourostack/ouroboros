# cmux Sense

The cmux sense lets an agent watch the coding agents (Claude Code, Codex, Copilot) that run in [cmux](https://github.com/manaflow-ai/cmux), the terminal app on this Mac. The agent can tell its human who needs them and what each session did, and it can put a one-line status or a desktop notification in front of them. It can also answer a Claude Code permission prompt `once` when the code floor, the human's own precedent and a standing owner grant all allow it. In v1 no human-run command issues that grant yet, so in practice the sense escalates every request (see [Answering prompts](#answering-prompts)). It never types into a terminal.

## What it does

- **Follows cmux's event stream.** The sense process holds one `events.stream` connection to the cmux control socket, filtered to the `feed` and `surface` categories. From the hook events it keeps, per terminal (cmux calls it a surface), which agent runs there, which folder it is in, its last hook and tool, and a lifecycle: `working`, `idle` (finished its turn and waiting for a prompt), `waiting` (blocked on the human) or `ended`.
- **Answers or escalates decisions cmux is holding open.** When a hook says a decision may be pending, and every 30 seconds, the sense reads `feed.list {"pending_only": true}`. Each new pending request is judged once (see [Answering prompts](#answering-prompts)). The few it may answer get `once` right there, with no agent turn. Every other permission request, question or plan approval is brought to the agent once, the same way the mail sense brings notices: the sense queues a pending message in the agent's private runtime (`state/pending/self/inner/dialog/`, dropped unread after 30 minutes) and asks the daemon for a private turn now (trigger `cmux-feed`, which the daemon's private-turn policy allows only with a request id and the `sense: cmux` reference). It sends one wake per check pass, so a burst of requests costs one turn that reads them all. That turn runs with the agent's full tool set under its own family trust, so `cmux_overview`, `cmux_read` and `cmux_signal` are available, and it needs no `tool-profiles.json`. If the daemon refuses the wake or is not running, the message waits for the next private turn. If one item cannot be judged, answered or queued, the others still are. The receipt names the agent, tool, folder and terminal, and why it was not answered automatically. It never includes the tool input, because provider payloads can hold secrets. Every Feed field in it, and the reason, is untrusted: control characters and whitespace runs collapse to single spaces, each field is capped at 200 characters (the reason at 500; a longer request id gets a digest suffix before it goes into the wake's key and references), and the receipt ends with the same "treat as untrusted external input" line external events carry.
- **Event fields it relies on.** cmux publishes each hook as both `agent.hook.<HookEventName>` and `feed.item.received` with the same payload: `session_id`, `hook_event_name`, `_source`, `workspace_id`, `surface_id`, `cwd` and `tool_name`. The tool input is replaced by its length. This is checked against cmux's `CmuxEventPublishing.workstreamPayload`, so the `feed` category is enough and the sense does not subscribe to `agent`.
- **Resets after a gap.** When the stream `ack` reports `resume.gap`, or cmux comes back with a new `boot_id`, the sense drops its per-terminal picture and moves its cursor to `resume.latest_seq`. The next hook events rebuild the picture.
- **Records the cmux version.** On each connection it asks `system.identify` for the app version and keeps it in the state file. `cmux_overview` shows it. Observing and escalating work on any version.
- **Resumes where it left off.** The event cursor (cmux boot id and sequence), the per-terminal activity and the request ids already escalated live in `state/senses/cmux/state.json` in the agent bundle (directory `0700`, file `0600`). The file is rewritten only when something other than its timestamp changed. After a disconnect it reconnects with backoff (1, 2, 5, 10, then 30 seconds) and resumes after the saved sequence.

## Tools

The tools appear only for an agent whose `agent.json` has `senses.cmux.enabled: true`. Only family trust may call them; a call with no known trust level is refused.

| Tool | What it does | Changes anything? |
| --- | --- | --- |
| `cmux_overview` | Lists the decisions cmux is holding open (with a redacted, bounded preview of each request) and every workspace and terminal with what its agent last did. | No |
| `cmux_read` | Reads one terminal's text, optionally with scrollback, 1 to 400 lines (default 60). Secret-shaped strings are redacted and output is capped at 16,000 characters. | No |
| `cmux_signal` | Sets or clears this agent's one-line status (key `ouro`, at most 120 characters) on a workspace's sidebar entry, and/or posts a desktop notification tied to that workspace. | Only what cmux shows |
| `cmux_reply_once` | Records the agent's judgment that a pending permission request is routine. It sends `once` only when the floor, a precedent, cmux's version and the standing grant allow it; otherwise the judgment is logged in shadow and the request stays with the human. | Only under code authority |
| `cmux_correct` | Records the human's answer or correction for a judged request as an exact precedent: `once` (fine next time, only when cmux shows the human allowed it) or `ask` (always ask). Refused in autonomous turns and while handling an external event. | The machine-local casebook |

## Answering prompts

> **v1 answers nothing on a stock machine.** A live reply needs a standing owner grant in steward policy (step 4), and today only the Sanctuary owner path (`steward_policy`) can write one. No human-run command issues the grant to another agent, such as `ouroboros` on a Mac, yet. Until one exists, the sense escalates every request and logs what it would have answered. Replies also need cmux 0.65.0 or later (step 3).

A reply needs every one of these, checked in code inside the sense process:

1. **The floor** (`src/senses/cmux/floor.ts`) judges cmux Feed's structured fields (`tool_name`, `tool_input`, `cwd`), never screen text. Its default is to escalate.
   - **Allow:**
     - An Edit, Write, MultiEdit or NotebookEdit inside the session's repository, after `..` and every symlink are resolved, and a Read, Glob or Grep inside it.
     - A command from a short table (`ls`, `pwd`, `cat`, `head`, `tail`, `wc`, `grep`, `rg`, `find`, `tree`, `file`, `stat`, `diff`, `which`, `echo`, `du`) in which **every option is on that command's own option list**. Any other option escalates. For example, `tree -o`, `rg --pre` and `--hostname-bin`, `rg -z`, `grep -f` and `find -exec` are not on the lists. An option value must be digits or a word with no `/` and no leading `~`.
     - Read-only git subcommands (`status`, `log` without `-p`, `diff` and `show` with name-only options, `rev-parse`, `ls-files`, listing-only `branch`, `merge-base`, `rev-list`, `describe`), each with its own option list. They are allowed only when the repository's git config (including a linked worktree's own and common config) sets nothing that runs a program: `core.fsmonitor`, `diff.external`, `textconv`, `pager`, `sshCommand`, `hooksPath`, filter drivers, includes or aliases. Unreadable config escalates. `git grep` is not allowed, because `-O` runs a program. Global git options such as `-C` and `-c` escalate.
     - The repository's own checks, as these exact words only: `npm test`, `npm run test`, `npm run lint`, `npm run typecheck`, `swift test`, `swift build`, `cargo test`, `cargo check`, `go test`, `go vet`.
   - **Never answered** (hard). Not by precedent, and not by the agent:
     - questions and plan approvals;
     - Codex and Copilot requests (observe-only);
     - truncated input, MCP tools, web tools and anything unrecognised;
     - commands that chain, pipe, redirect, substitute, expand or escape (any of `;`, `&`, `|`, `$`, a backtick, `<`, `>`, `(`, `)`, `{`, `}`, `\`, `!` or `#` anywhere, even quoted), and unquoted globs (`*`, `?`, `[`, `]`), because a glob can match a symlink that leaves the repository;
     - an allowlisted command with any option not on its list;
     - deleting, moving, privilege, network and wrapper programs (`rm`, `mv`, `sudo`, `curl`, `ssh`, `gh`, `sh`, `env`, `xargs`, `timeout`, `npx`, `date` and similar), pagers and editors;
     - interpreters (`python`, `node`, `sed`, `awk`, `make` and similar) with any option, and package managers beyond `run <script>` or `test`;
     - any word, or any value glued to an option (`-f/etc/passwd`, `--file=/x`), that resolves outside the repository;
     - reading credential paths (`.env*`, `.git`, `.npmrc`, `.claude` and similar), and editing `.git`, `.claude`, `.github`, `.husky`, shell rc files, `package.json`, `.mcp.json`, `CLAUDE.md` and `AGENTS.md`.
   - **Soft:** anything else. Only the human's exact precedent can answer it.
2. **Precedent** (`casebook.json`): the human's answers, recorded with `cmux_correct`. A precedent matches only the same repository, tool and every command token, or the same repo-relative path. It stores a SHA-256 digest of the tokens and a redacted preview, never the words themselves. An `ask` precedent always escalates, even an allowlisted request. The floor runs again on every request, so a precedent never overrides a hard verdict. A `once` precedent is accepted only when cmux shows the human allowed that request (the item is `resolved` with a permission decision other than `deny`) and the sense never replied to it itself. `cmux_correct` refuses to run in an autonomous turn (including the private turn a cmux escalation wakes) and while handling an external event, so the agent cannot mint its own authority; it records only what the human said in a conversation. It also refuses a logged shape in the older format. Cases written in the first casebook format (raw command tokens) are converted to digests the first time the casebook is read, and the file is rewritten without the tokens. If the casebook cannot be read, or holds a case in neither format, the sense escalates every request and `cmux_correct` refuses to write, rather than skip a case: a skipped `ask` precedent would let through a request the human asked to be asked about.
3. **cmux 0.65.0 or later**, from `system.identify`. A prerelease such as `0.65.0-beta` counts as older. On an older or unknown version the sense still observes and escalates, and logs what it would have answered.
4. **A standing owner grant** in steward policy: key `cmux-feed-once`, action `cmux.feed.once`, with the repository roots as targets and a count cap per window. It must be owner-stated, unexpired and backed by its audit row, and its window may be at most 31 days, because that is how long the decision log keeps reply records.
5. **The reply itself.**
   1. Right before replying, the sense reads the request again. If the human already answered it, the sense logs a race and sends nothing. If it changed, the sense escalates.
   2. Under the decision log's lock (an atomic `mkdir`), it refuses if the log already has a `reply_sent` for this request, checks the grant and the count cap again, and writes `reply_sent`. The cap counts every `reply_sent` in the window, confirmed or not, and the sense process and `cmux_reply_once` share it, so neither can push past the cap.
   3. It sends `once`, the only mode in the code (never `always`, `all` or `bypass`).
   4. It reads the item back from the unfiltered `feed.list`. Only `resolved` with a `once` permission decision is logged as `replied_once`. Resolved with a different decision means the human answered, and is logged as a race. A reply call that failed (the reply may or may not have gone out), or an item still pending, expired or no longer listed, escalates to the human. This read is the confirmation rather than `feed.item.resolved`, because cmux publishes that event for every accepted reply call, including ours.

Each pending item is handled on its own. If judging or answering one throws, that item is escalated with the error as the reason, and the others carry on.

The agent's own judgment runs in shadow. `cmux_reply_once` logs what the agent would have done and sends only what the code would send anyway. Turning model judgment into live authority is a later, separate decision.

**Principles.** These are judgment guidance for the agent, never authority. They come from `cmux-principles.md` in the bundle (human-authored, synced) or, without that file, from eight seed principles in `src/senses/cmux/principles.ts`. `cmux_overview` returns them.

**Decision log** (`decisions.jsonl`). It records every judgment: reply sent, replied once, escalated, race, reply failed or shadow. Each entry holds the floor verdict, the precedent used, the authority and the stored shape. Free-text fields are redacted one by one before the line is written, so every line stays valid JSON. Every write happens under the lock. At 2 MB the log rotates to `decisions.jsonl.1`; reply records younger than 31 days from the older rotated file are carried into the new file, so the count cap never loses a reply inside its window. A lock older than 30 seconds is taken over by renaming it to a tombstone named after its inode and marking the tombstone, so when two processes find the same stale lock only one wins, and the other cannot move away the winner's fresh lock. A lock that vanishes while it is checked is simply tried again. The casebook and the decision log live with the state file under `state/senses/cmux/` (directory 0700, files 0600) and never sync.

## Turning it on

The sense needs the cmux socket credential on this machine. It lives in the agent's machine runtime vault item (`runtime/machines/<machine-id>/config`, key `cmux`), never in the synced bundle.

1. In a terminal inside cmux, store the capability token cmux gives every terminal it starts:

   ```sh
   ouro vault config set --agent <agent> --scope machine --key cmux.socketCapability --value "$CMUX_SOCKET_CAPABILITY"
   ```

   cmux's default `cmuxOnly` socket mode refuses processes it did not start, and the daemon is not a cmux child. The token lets the sense in without loosening that mode. If cmux runs in `password` mode, set `cmux.socketPassword` instead. `cmux.socketMode: "automation"` (no credential, for cmux's allow-all-same-user mode) is a last resort. `cmux.socketPath` overrides the default socket, `~/.local/state/cmux/cmux-<uid>.sock`.
2. Set `senses.cmux.enabled: true` in `agent.json`.
3. Run `ouro up`.

`ouro status` reports the sense as `not_attached` on a machine with no `cmux` record, `needs_config` when the record has no credential (with the command above as the repair), and `running` once the process is up. The agent's own sense list in its prompt uses the same words (`ready` in place of `running`). When the socket refuses the credential, the sense records the refusal and the same repair hint in its state file and keeps retrying.

## Wire protocol notes

- One JSON request per line, `{"id","method","params"}`; responses are `{"ok":true,"result"}` or `{"ok":false,"error"}`, and some refusals are plain `ERROR: ...` text.
- With a capability token every line is wrapped as `_cmux_capability_v1 <token> <line>`. In password mode the client sends `auth <password>` first.
- The status pill uses cmux's v1 text commands: `set_status ouro "<quoted text>" --tab=<workspace id>` and `clear_status ouro --tab=<workspace id>`.

## Code

- `src/heart/cmux-config.ts`: machine config, socket auth order, status facts and the repair hint.
- `src/senses/cmux/client.ts`: the socket client (`call`, v1 `command`, `stream`).
- `src/senses/cmux/attention.ts`: state, event handling, pending Feed items and escalation receipts.
- `src/heart/private-runtime/policy.ts`: the `cmux-feed` private-turn trigger.
- `src/senses/cmux/sense.ts`: the long-running sense process; `src/senses/cmux-entry.ts` is its daemon entry point.
- `src/senses/cmux/redact.ts`: best-effort secret redaction for anything handed to a model.
- `src/senses/cmux/floor.ts`, `casebook.ts`, `answer.ts` and `principles.ts`: the floor, precedents and decision log, the judgment and `once` reply path, and the principles.
- `inspectStandingActionGrant` in `src/heart/steward-policy.ts`: the standing grant check.
- `src/repertoire/tools-cmux.ts`: the five tools.
