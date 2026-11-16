# App-sessions Sense

The app-sessions sense lets an agent read and write the GitHub Copilot app's sessions on the machine it runs on: the
same sidebar the person sees. It is machine-scoped: every machine whose agent turns it on sees that machine's app, and
nothing else.

Turn it on in the agent's `agent.json` (it is off by default, and needs no vault config):

```json
{ "senses": { "app-sessions": { "enabled": true } } }
```

Then restart with `ouro up`. The daemon runs `senses/app-sessions-entry.js` for the agent, and the agent's tool menu
gains the `app_sessions_*` tools.

## What the agent can do

The tools are the ones a coordinating session of the app has, under the same names and in the same shapes.
`src/senses/app-sessions/app-interface.ts` sends each as a request on the app's local WebSocket, as an observer client.

| Tool | What it does |
| --- | --- |
| `list_sessions_and_chats` | Every open session and chat: id, app_url, name, project, branch, creator. |
| `get_sessions_status` `{ state? }` | What every session is doing (`busy`, `idle`, `waiting`, `stuck`), with counts and what each blocked one waits on (`awaiting_input` with its `request_id`). |
| `get_session` `{ session_id }` | One session's details and what it waits on. |
| `send_session_message` `{ session_id, message, delivery_mode?, notify_on_idle? }` | Delivers a message the way the message box does (`immediate` or `enqueue`) and waits up to two minutes for the app to accept it. |
| `create_session` `{ name?, project_id?, session_kind?, workspace_type?, branch_name?, kickoff?, notify_on_idle? }` | A chat, or with `project_id` a project session in its own worktree (or the project's checkout). The app does not run a kickoff for outside clients, so the first message and mode are sent explicitly. |
| `answer_session_input` `{ session_id, answer }` | Answers an `ask_user` question the session is blocked on. |
| `respond_to_session_plan_v2` `{ session_id, approved, selected_action?, feedback? }` | Approves or rejects a plan the session paused on. |
| `archive_session` `{ session_id }` | Archives a session this agent created. |
| `navigate_to` `{ id }` | Shows a session in the app's window. |
| `save_session_automation`, `get_session_automation` | Schedule, read or clear a session's wake-up automation. |
| `list_workflows`, `run_workflow` | The app's automations, and running one now. |
| `app_sessions_tail` `{ session_id, count? }` | The session's last visible messages (default 6, at most 50), current name and state, and local-history coverage. |
| `app_sessions_restart` `{ action?: "status" \| "enqueue", why? }` | Reads the restart in progress or the last one, or starts one through Housesitter. |

A session is named by its id or a unique prefix of it (the first eight characters are enough). Every write is a nerves
event; none is gated beyond the harness's usual trust rule (the tools are family-only, like Shepherd's).

**What an outside client cannot do.** An observer client is anonymous: the app ignores creator and coordination fields,
so a created session has no coordinator and nothing reports back (`notify_on_idle` makes this sense watch it instead).
`publish_chat_update` and `relay_session_input` have no WebSocket form. A question or plan is announced once, only to
clients connected at that moment, so the sense keeps a persistent listener (`prompts.ts`) that records them in
`pending.json`; `answer_session_input` and `respond_to_session_plan_v2` need a recorded `request_id`. A session whose
question was asked while the sense was down reports it in `get_session` but cannot be answered from here.

**Stuck** means the app does not say the session is running, but its own history (`events.jsonl`) shows its agent loop
stopped mid-turn, or between turns after asking for tools, more than two minutes ago. **Waiting** means an `ask_user`,
plan approval or permission request is open.

**History is message-bounded, not byte-tailed.** The reader scans backwards in bounded-memory chunks until it finds
the requested visible messages or reaches the beginning. Tool-only assistant events, hooks, usage records and model
snapshots do not consume the requested count. Messages over 4,000 characters carry `truncated: true`; malformed or
oversized event lines (over 8 MiB) are skipped with an explicit `skippedEvents` count and `coverage: "incomplete"`.
The result includes `observedAt`, `source: "local_event_log"`, requested/returned counts, scanned/log bytes,
`beginningReached`, and `missing`. A missing log is not proof of no conversation. Remote sessions carry
`coverage: "local-only"`: the harness cannot prove this Mac has received every remote event.

**Observations are not live status.** Tail results include the current sidebar name, state and last activity.
`renamedFrom` flags a difference from the watched name. Re-read `get_sessions_status` and `app_sessions_tail` before
reporting current progress or promising an update; a historical reply does not establish what work a session owns
now. A name change invalidates the old attribution, not necessarily the session itself.

**Sending waits.** A session whose runtime is not loaded loads first, often for more than 20 seconds, and closing the
socket before the app answers cancels the send. The tool always waits for the app's `session_message_sent` or
`session_message_queued`.

**Restarting is Housesitter's job.** The harness never restarts the app itself. `enqueue` runs
`housesitter restart-copilot --resume --detach` (found at `HOUSESITTER_BIN`, `~/code/housesitter/bin/housesitter.mjs`, or
`housesitter` on PATH), a launchd job that outlives the app: working sessions are asked to reach a safe point, the app
is quit through its Quit menu (waiting while a person is using the Mac), relaunched, and every session that was working
gets a resume message and is checked to have taken a turn. `status` reads `housesitter restart-copilot --status`.
Housesitter's resume watcher (`housesitter restart-copilot --install-keeper`) does the same resume after a crash or a
login. Without Housesitter the tool says so and restarts nothing.

## Perception

The sense process does three things:

- Every minute it snapshots the sidebar into `state/senses/app-sessions/snapshot.json`: counts by state and the stuck
  sessions. The prompt's sense list and `ouro status` show it, for example
  `app-sessions: ready (16 working, 0 waiting, 1 stuck, 50 idle; stuck: 1a2b3c4d-… (Babysitter), as of …)`.
- Each minute the sense also stats every local session's `events.jsonl` (never reading it). One over 500 MB is flagged in `oversize.json`
  (the never-resume list: `neverResume(agentRoot)`), because the app loads a whole history into memory whenever it resumes
  that session, and a few multi-GB ones froze a Mac. Its coordinator, or the session itself when it is running and has no smaller
  coordinator, is asked once to hand off to a fresh successor (checkpoint, the tail of the old log, then archive), and to
  keep images out of chat, since inline images are nearly all of a history's size. A session that is not running and has no
  smaller coordinator is never messaged, which would reload it; the owner is told once instead. No model turn is used.
- The same snapshot lists the sessions waiting on a **permission prompt**, which only the person can answer in the app
  and which freezes the session while it is open. A prompt open for more than two minutes
  is told once to the owner, with no model turn, through the proactive owner-notice path Shepherd uses (Teams or
  BlueBubbles): the session's name, what it waits on, and that only the owner can answer it. A prompt is never told
  twice (`waiting-prompts.json` keeps the told ones until the prompt is answered), a prompt older than a day is
  shown but not announced, and a notice that could not reach the owner is retried each minute. `ouro status` lists
  each as `waiting on you: 1a2b3c4d (Babysitter) for 5 min: run a shell command`. The prompt comes from the open
  `permission.requested` event in the session's own history, the same source that makes the session `waiting`.
- Every ten seconds it reads the new part of each **watched** session's history. Sending to a session (or resuming it,
  or opening it with a first message) watches it for a day after the last write. When a watched session finishes a
  reply (an assistant message that asks for no tools), the reply is queued for the agent's private runtime and the
  runtime is woken (`triggerSource: "app-sessions"`), the way Shepherd's returns arrive. So a conversation with another
  session, such as a steward session, works both ways.

Watch reads advance forward from their cursor in bounded batches, so a large burst is drained over several polls
rather than silently jumping over earlier replies. An oversized or malformed event produces an observation-gap
notice, not a fabricated session reply. Failed delivery leaves the cursor and name unchanged for retry.
Each delivered burst carries the observation time, current sidebar identity/state when available, and message
timestamps. Renames trigger a notice even without a finished reply; after delivery the watch adopts the current
name. If the sidebar cannot be read, reply attribution is explicitly unverified.

## Wake runners

The sense can run a command on a cadence and deliver the wakes it prints to Copilot app sessions, so a session spends no model turns watching for work. The sense knows nothing about what the command watches. How a team organizes and watches its work (for example, a drain session that works one repository's issues) belongs to Desk: its `drains.js poll` command lists each configured repository's issues, records what changed and prints the wakes. See Desk's issue-drains documentation for its config, state and filters.

List the runners in `agent.json`:

```json
{ "senses": { "app-sessions": { "enabled": true, "wakeRunners": [
  { "name": "issue drains", "command": ["/usr/local/bin/node", "<desk>/plugins/desk/mcp/scripts/drains.js", "poll"], "everySeconds": 300 }
] } } }
```

`command` is the program and its arguments, run with no shell. `everySeconds` is 10 or more and defaults to 300. `session` is optional: the session that receives a wake that names none. `delivery` is `"immediate"` (default) or `"enqueue"`. Each run has a two-minute limit.

The command prints one JSON value on stdout:

```json
{ "wakes": [{ "session": "<session id>", "message": "New or changed issues in owner/name: #12 Title. Drain them.", "replaces": "New or changed issues in owner/name:", "done": ["/usr/local/bin/node", ".../drains.js", "ack", "--repo", "owner/name", "--wake", "…"] }],
  "status": ["issue drain owner/name -> 58fbd57e: polled just now, 7 open, 0 waiting, last wake 12m ago (1 issue)"] }
```

- **Deliver.** Each `message` is sent to its `session` (else the runner's) and the app admits it at that session's next turn boundary. A session that works for hours in one run never goes idle, so a message queued behind that run (`"enqueue"`) can wait for hours and arrive about issues that have since closed; choose `"enqueue"` only for a wake that must never interrupt.
- **Replace.** A wake can name `replaces`, a message prefix (Desk's wakes name `New or changed issues in owner/name:`). Before the wake is sent, the messages the session still holds in the app's own queue that start with that prefix and come from the user side (`source: "user"`, never another session's or an agent's) are removed through the app's `get_session_queue` and `remove_session_queue_item`, so a newer wake replaces older undelivered ones instead of queueing behind them. A wake that replaces is sent, not held.
- **One at a time.** The app keeps an accepted message in its own queue until the session reaches a turn boundary, and nothing can take it back. So a session has one wake in flight: while the last wake sent to it has not appeared in its event log, the next wake for it is held, reported with `--error "held: …"`, and offered again by the command's next run, which re-derives its state. After 30 minutes without appearing, a wake counts as lost. The runner's state keeps the wake in flight per session (`open`).
- **Report.** `done` is the argv that reports a wake's delivery. It runs after a successful send, and with `--error <reason>` added after a failed one, so the command can keep the wake pending and send it again with its next run. A run that dies between sending and reporting can repeat one wake.
- **Failures.** A non-zero exit, a timeout, output that is not this JSON or a failed delivery is recorded as the runner's last error. Nothing else happens: the command owns what is pending.
- **Status.** `ouro status` lists each runner under the app-sessions row (last run, wakes delivered, last error), then the command's own `status` lines. State lives in `state/senses/app-sessions/wake-runners.json`.

The runner lives and dies with the sense: `ouro up` restarts it. Anything else that can run a command on a schedule, such as a launchd job, can run the same command and deliver its wakes.

### Moving from `issueDrains`

Earlier versions polled drains here from `senses.app-sessions.issueDrains` with `issuePollMinutes`, keeping seen markers in `state/senses/app-sessions/issue-drains.json`. That poller is gone. A config that still has `issueDrains` shows a notice in `ouro status` and is otherwise ignored. To move it:

1. Copy the `issueDrains` array to Desk's drain config as `drains`; the fields are the same.
2. Copy `issue-drains.json` to Desk's `state.json`; the shape is the same, so the seen markers carry over and nothing wakes again.
3. Replace `issueDrains` and `issuePollMinutes` with a `wakeRunners` entry as above, then run `ouro up`.

## Status digest

Away from the Mac, the owner can still see how things are going, at almost no token cost. When the sense's `agent.json` block has a
`digest` object, the sense builds a **status digest** on a cadence with no model turn, keeps it in `state/senses/app-sessions/digest.json`,
and tells the owner only what needs them.

```json
{ "senses": { "app-sessions": { "enabled": true, "digest": {
  "everySeconds": 300,
  "drains": ["/path/to/node", "/path/to/drains.js", "status"],
  "deskRoots": ["~/desk", "~/team-desk/alias"],
  "mergedToday": [{ "label": "personal", "command": ["/path/to/gh-runner", "personal"] }]
} } } }
```

Every field is optional; without a `digest` block nothing runs. What it reads, all without a model:

- **Sessions**: every session's state (working, waiting, stuck), its last turn and, for sessions active in the last day, the task card it
  declared (the `task_focus` call in its own history, found by reading the log backwards once, then only what was added) with the card's
  status and next step from `<deskRoot>/<track>/<slug>/task.md`.
- **The Mac**: Housesitter's heartbeat, last restart and resume, and the health watch's sessions (`restart-copilot --status --json`).
- **Drains**: `drains` is a command that prints `{ "status": ["…"] }` (the shape a wake runner prints); drains whose last good poll is old are named.
- **Merged today**: `mergedToday` runs `command` plus `api …` for each account and counts the pull requests merged since local midnight.
  An answer under four minutes old is reused, and the request is conditional when GitHub gives an ETag. Search has its own quota, apart from the drains'.

A source that cannot be read is named in the digest (`Not read: …`), never guessed.

**Asking.** In Teams, the owner's `/status`, or a message that is only "how's it going?" (and a few plain variants), is answered from the digest
with **no model turn**: zero tokens, and the reply says how old the digest is when it is more than 15 minutes. It answers family only. Any other
phrasing goes to the agent, which has `app_sessions_digest` and answers from it in a few lines.

**Pushes.** Nothing is sent on a timer. The sense tells the owner, in one Teams message, only: work **ready for them** (a card that moved to
`collaborating`), work that is **done**, a session **waiting on an answer** for 10 minutes, and something that **stays broken**: a session stuck 20
minutes, the Mac watcher's heartbeat bad or stale for 10, a session failing the health watch, a drain not polling for 5, the app not running.
A condition must last before it counts, is told once until it clears, and one message carries everything due, at most one per half hour. A restart
never announces work that was already ready or done. Permission prompts and repository-trust cards keep their own notice (see Perception).

**Cost.** The digest is a few hundred tokens of text (`tokens` in `digest.json`, a fourth of its characters); the `/status` answer costs no model
tokens, and a model-written answer costs the digest plus a few lines. Each build and push is a nerves event carrying its size.

## How it talks to the app

`src/senses/app-sessions/app-interface.ts` is the thin client over the app's local WebSocket
(`ws://127.0.0.1:<port>/?token=<token>&observer=1`, port and token in `~/.copilot/run/`); `prompts.ts` is the
persistent listener that records questions and plans; `client.ts` holds the transport, the sidebar read
(`list_workspaces` and `list_general_chat_sessions`), the event-log readers that classify working, stuck and waiting
sessions (the socket reports only whether a session is running or was interrupted), and Housesitter's CLI
(`housesitter restart-copilot --status --json`, or `--resume --detach` to start a restart).
