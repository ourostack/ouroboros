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

| Tool | What it does |
| --- | --- |
| `app_sessions_list` `{ state? }` | Every sidebar session with its id, name, state (`working`, `waiting` for the person, `stuck`, `idle`), why, project and last activity, plus counts. |
| `app_sessions_tail` `{ session, count? }` | The session's last visible user and assistant messages (default 6, at most 50), current name/state and local-history coverage. |
| `app_sessions_send` `{ session, message, delivery?, watch? }` | Delivers a message the way the app's message box does (`send_message`, `immediate` or `enqueue`), and waits up to two minutes for the app to accept it. |
| `app_sessions_resume` `{ session, note? }` | Sends the resume nudge the Mac's app keeper sends after a restart, to a stuck or stopped session. |
| `app_sessions_new` `{ name?, prompt?, cwd?, agent?, model?, target? }` | Creates a general chat (for example a throwaway probe), with actual creation, initial-message acceptance and placement reported separately. `target: "workspace"` and project/workspace/parent requests are refused without creating anything. |
| `app_sessions_archive` `{ session }` | Archives a session the agent opened with `app_sessions_new`. |
| `app_sessions_restart` `{ action?: "status" \| "enqueue", why? }` | Reads the app keeper's restart status, or queues a courtesy restart through it. |
| `app_sessions_watch` `{ session, watch? }` | Starts or stops bringing a session's replies back to the agent. |

A session is named by its id or a unique prefix of it (the first eight characters are enough). Every write is a nerves
event; none is gated beyond the harness's usual trust rule (the tools are family-only, like Shepherd's).

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
`renamedFrom` flags a difference from the watched name. Re-read `app_sessions_list` and `app_sessions_tail` before
reporting current progress or promising an update; a historical reply does not establish what work a session owns
now. A name change invalidates the old attribution, not necessarily the session itself.

**Creation is not workspace placement.** This connector's `create_session` protocol creates `general_chat`.
Neither `cwd`, a repository mentioned in the prompt, nor a task-like title selects a project or tree parent.
Use native app project-session creation for workspace work. `app_sessions_new` reports `created`, `sessionId`,
`sent`, and `placement`: actual observed kind, name, workspace/project ids, known parent/creator ids, and
`sidebarPlacement`. Project association and creator provenance do not prove where a child appears in the sidebar.
`associationVerified` confirms the observed kind/association, not tree placement. This connector has no authoritative
sidebar hierarchy read, so `sidebarPlacement` stays `unknown` and `placement.verified` stays false, even when raw
parent ids are available. Missing hierarchy columns mean unknown, not a fabricated null parent. If a create acknowledgement cannot be
verified in the current sidebar, the result is `ok: false`, `created: true`, with unverified placement; do not create
a duplicate blindly. A failed first message likewise is not overall success, but the created session remains in
the agent's probe inventory for inspection/cleanup. `watching` requires actual message acceptance.

**Sending waits.** A session whose runtime is not loaded loads first, often for more than 20 seconds, and closing the
socket before the app answers cancels the send. The tool always waits for the app's `session_message_sent` or
`session_message_queued`.

**Restarting is the keeper's job.** The harness never restarts the app. `enqueue` asks the Mac's app keeper
(`com.arimendelow.copilot-app-keeper`, `app-keeper.mjs enqueue`): it restarts at once when nobody is at the Mac,
otherwise shows the person a "Restart now" / "Not now" panel, and resumes every working session afterwards. Without
the keeper the tool says it is not installed and queues nothing.

## Perception

The sense process does three things:

- Every minute it snapshots the sidebar into `state/senses/app-sessions/snapshot.json`: counts by state and the stuck
  sessions. The prompt's sense list and `ouro status` show it, for example
  `app-sessions: ready (16 working, 0 waiting, 1 stuck, 50 idle; stuck: 1a2b3c4d-… (Babysitter), as of …)`.
- The same snapshot lists the sessions waiting on a **permission prompt**, which only the person can answer in the app
  and which freezes the session (and one that created it) while it is open. A prompt open for more than two minutes
  is told once to the owner, with no model turn, through the proactive owner-notice path Shepherd uses (Teams or
  BlueBubbles): the session's name, what it waits on, and that only the owner can answer it. A prompt is never told
  twice (`waiting-prompts.json` keeps the told ones until the prompt is answered), a prompt older than a day is
  shown but not announced, and a notice that could not reach the owner is retried each minute. `ouro status` lists
  each as `waiting on you: 1a2b3c4d (Babysitter) for 5 min: run a shell command`. The prompt comes from the open
  `permission.requested` event in the session's own history, the same source that makes the session `waiting`. The app's
  repository-trust prompt leaves no such local record, so it is not detected here.
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

## Issue drains

A drain is a Copilot app session that works one GitHub repository's issues. The sense wakes it when an issue is new or changed, so the drain spends no model turns on idle checks. List the drains in `agent.json`:

```json
{ "senses": { "app-sessions": { "enabled": true, "issuePollMinutes": 5, "issueDrains": [
  { "repo": "ourostack/desk", "session": "58fbd57e-e371-4169-b013-2f413ab4a046", "account": "arimendelow" },
  { "repo": "gim-home/CIT", "session": "48a0f0ab-56ad-406d-8831-5352815be337", "account": "arimendelow_microsoft" }
] } } }
```

`account` is a login the GitHub CLI is signed in to (`gh auth token --user`); without it the CLI's active account polls. `issuePollMinutes` defaults to 5.

`ignoredBodyTrailers` is optional per drain: a list of trailer keys, such as `["Active-at", "Waiting-for", "Waiting-until"]`, for `Key: value` lines that lanes rewrite in an issue body on a schedule (plan data, not news). Lines that start with one of those keys (case-insensitive) are left out of the body digest, so an edit that changes only them does not wake the drain. Any other body edit still does. Adding or changing the list never wakes the drain by itself: issues recorded under the old list are compared again from their next change.

- **Poll.** Every cycle lists each repository's open issues (pull requests excluded) over the REST API. The first successful poll only records what is already open.
- **Dedupe.** `updated_at` only says that something changed, and the drain's own label edits and status comment move it too. For each repository and issue the poll keeps the revision it last recorded: `updated_at`, a digest of the title and body, and, once the issue closes, when it left the open list. An issue with a new `updated_at` wakes the drain only if someone other than the drain changed it since: it is new to the drain, its title or body was edited, a comment other than the drain's status comment was created or edited after the recorded revision, or it was reopened or got a label outside the `drain:` namespace. Any other change is recorded and ignored. The same revision never wakes the drain twice.
- **Record, then wake.** Events and seen markers are saved to `state/senses/app-sessions/issue-drains.json` before the message goes out. One message per repository per poll, queued behind the drain's current work: `New or changed issues in <repo>: #n <title>, … Drain them.` If the app refuses it, the events stay `pending` and go out with the next poll. A crash between sending and recording the send can repeat one wake.
- **The drain's own edits.** The drain's status comment carries `<!-- ouro-drain-status -->`. A comment counts as the drain's when it has the marker and the polling account wrote it; its creation and every edit are skipped, whichever other changes land beside it. A comment by the same account without the marker, or a marked comment by someone else, still wakes the drain. Changes to labels that start with `drain:` (`drain: triaged`, `drain: in progress`) are skipped; closes, assignments and unexplained timestamp bumps do not wake it either.
- **Closed issues.** The poll lists open issues, so a closed issue never wakes the drain, and a waiting event for an issue that has since closed is dropped. The issue's record is kept for 30 days: one that comes back unchanged is not new, and one that was reopened wakes the drain once.
- **Failures.** A missing token, an HTTP error or a network error is recorded as the drain's last error, with every marker and pending event left alone and nobody woken. The next poll retries.
- **Status.** `ouro status` lists each drain under the app-sessions row: last poll, open issues, events waiting, last wake and last error. The state file is the single source for it.

The poller runs inside the app-sessions sense process, so it lives and dies with that sense: `ouro up` restarts it and it resumes from the state file.

## How it talks to the app

`src/senses/app-sessions/client.ts` is the per-machine client, with no harness dependencies beyond logging, so other
senses (the fleet view) build on it:

- the sidebar from the app's database, `~/.copilot/data.db`, opened read-only;
- what a session said from `~/.copilot/session-state/<id>/events.jsonl`;
- every write as a request on the app's local WebSocket (`ws://127.0.0.1:<port>?token=<token>&observer=1`, port and
  token in `~/.copilot/run/`): `send_message`, `create_session`, `rename_session`, `archive_session`,
  `archive_workspace`;
- the keeper through its launch agent (`launchctl print`, then `node app-keeper.mjs status --json` or `enqueue`).

Its exports: `listAppSessions`, `snapshot`, `tailAppSession`, `readAppSessionHistory`, `readNewAppEvents`, `sendToAppSession`, `resumeAppSession`, `openAppChat`,
`archiveAppSession`, `restartEnqueue`, `restartStatus`, `appRunning`, and the event-log helpers the sense uses.
