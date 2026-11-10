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
| `app_sessions_tail` `{ session, count? }` | The session's last user and assistant messages (default 6, at most 50). |
| `app_sessions_send` `{ session, message, delivery?, watch? }` | Delivers a message the way the app's message box does (`send_message`, `immediate` or `enqueue`), and waits up to two minutes for the app to accept it. |
| `app_sessions_resume` `{ session, note? }` | Sends the resume nudge the Mac's app keeper sends after a restart, to a stuck or stopped session. |
| `app_sessions_new` `{ name?, prompt?, cwd?, agent?, model? }` | Opens a new chat session (for example a throwaway probe). |
| `app_sessions_archive` `{ session }` | Archives a session the agent opened with `app_sessions_new`. |
| `app_sessions_restart` `{ action?: "status" \| "enqueue", why? }` | Reads the app keeper's restart status, or queues a courtesy restart through it. |
| `app_sessions_watch` `{ session, watch? }` | Starts or stops bringing a session's replies back to the agent. |

A session is named by its id or a unique prefix of it (the first eight characters are enough). Every write is a nerves
event; none is gated beyond the harness's usual trust rule (the tools are family-only, like Shepherd's).

**Stuck** means the app does not say the session is running, but its own history (`events.jsonl`) shows its agent loop
stopped mid-turn, or between turns after asking for tools, more than two minutes ago. **Waiting** means an `ask_user`,
plan approval or permission request is open.

**Sending waits.** A session whose runtime is not loaded loads first, often for more than 20 seconds, and closing the
socket before the app answers cancels the send. The tool always waits for the app's `session_message_sent` or
`session_message_queued`.

**Restarting is the keeper's job.** The harness never restarts the app. `enqueue` asks the Mac's app keeper
(`com.arimendelow.copilot-app-keeper`, `app-keeper.mjs enqueue`): it restarts at once when nobody is at the Mac,
otherwise shows the person a "Restart now" / "Not now" panel, and resumes every working session afterwards. Without
the keeper the tool says it is not installed and queues nothing.

## Perception

The sense process does two things:

- Every minute it snapshots the sidebar into `state/senses/app-sessions/snapshot.json`: counts by state and the stuck
  sessions. The prompt's sense list and `ouro status` show it, for example
  `app-sessions: ready (16 working, 0 waiting, 1 stuck, 50 idle; stuck: 1a2b3c4d-… (Babysitter), as of …)`.
- Every ten seconds it reads the new part of each **watched** session's history. Sending to a session (or resuming it,
  or opening it with a first message) watches it for a day after the last write. When a watched session finishes a
  reply (an assistant message that asks for no tools), the reply is queued for the agent's private runtime and the
  runtime is woken (`triggerSource: "app-sessions"`), the way Shepherd's returns arrive. So a conversation with another
  session, such as a steward session, works both ways.

## How it talks to the app

`src/senses/app-sessions/client.ts` is the per-machine client, with no harness dependencies beyond logging, so other
senses (the fleet view) build on it:

- the sidebar from the app's database, `~/.copilot/data.db`, opened read-only;
- what a session said from `~/.copilot/session-state/<id>/events.jsonl`;
- every write as a request on the app's local WebSocket (`ws://127.0.0.1:<port>?token=<token>&observer=1`, port and
  token in `~/.copilot/run/`): `send_message`, `create_session`, `rename_session`, `archive_session`,
  `archive_workspace`;
- the keeper through its launch agent (`launchctl print`, then `node app-keeper.mjs status --json` or `enqueue`).

Its exports: `listAppSessions`, `snapshot`, `tailAppSession`, `sendToAppSession`, `resumeAppSession`, `openAppChat`,
`archiveAppSession`, `restartEnqueue`, `restartStatus`, `appRunning`, and the event-log helpers the sense uses.
