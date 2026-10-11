# Shepherd Sense

Shepherd keeps the coding agents in this Mac's terminals working. Every time one of them hands control back, a cheap judge decides whether it should have. When the agent stopped too early (it asked "want me to go ahead?", offered a menu with a clear recommendation, or stopped after a plan), Shepherd answers in the terminal, visibly, and the agent carries on. When the agent needs the human (a sign-in, a decision that is theirs, money, an irreversible step) or says the work is done, Shepherd lets the return through and brings it to the Ouro agent.

It is agent-agnostic and terminal-agnostic. Nothing in it assumes a particular coding agent: Claude Code, Codex, Copilot CLI, Agency and any other agent are judged by the same rubric from their screen. A terminal host is an adapter (`src/senses/shepherd/host.ts`): cmux and Herdr.

## What a return is

A return is the host's own "agent stopped" signal.

- **cmux, hooked agents.** cmux publishes `agent.hook.Stop` (and `StopFailure`) for every agent its hooks cover. Shepherd follows cmux's `events.stream` (categories `agent` and `surface`) and waits a 3-second grace period: any later hook for the same terminal other than `SubagentStop` or `Notification` means the agent resumed, and the stop is dropped. It is also dropped when cmux's session store (`~/.cmuxterm/<agent>-hook-sessions.json`) says background work was pending at the stop. The return is keyed by cmux's event id (`cmux:<boot id>:<seq>`) and carries the agent's last message (`lastBody`) and folder from that store.
- **cmux, terminals no hook speaks for.** Some agents (Agency today) have no cmux hook. Every 4 seconds Shepherd reads the last 40 lines of each such terminal. Output that changed and then held still for 8 seconds is one return.
- **Herdr.** Herdr detects the agent in every pane itself and publishes each change of its state as `pane.agent_status_changed` (`idle`, `working`, `blocked`, `done`, `unknown`). A pane that leaves `working` for `idle`, `done` or `blocked` and is still there after the 3-second grace period (checked with `agent.get`) is a return, keyed by Herdr's `state_change_seq` (`herdr:<pane>:<seq>`). Herdr's agent-status subscriptions name each pane, so Shepherd subscribes again when a pane opens or closes, and with backoff after `events_lost` or a lost connection.
- **Restarts and gaps.** The first connection, and any connection whose `ack` reports a gap, starts at cmux's latest event, so old stops are never replayed as new returns. Reconnects back off 1, 2, 5, 10, then 30 seconds.

## The judge

The judge reads a packet (the human's name, the agent, folder, the `Desk-Task:` line if the screen has one, the agent's last message and the last 80 screen lines, all redacted) and answers with JSON: `premature` with a reply, `gate`, `done` or `unclear`. The screen is untrusted data. It runs on the agent's own `agent` provider lane with no tools, low reasoning effort and a 20-second timeout, and its latency and input tokens are logged.

A reply is either one key from a fixed set (enter, escape, up, down, tab, 1-9, y, n) or one line of at most 240 characters with no line breaks, backslashes, `@`, control characters or leading `/`, `!` or `#`, so an input box never reads it as a command, a file mention or more than one line. Anything else turns the verdict into `unclear`.

## What Shepherd does with a verdict

| Verdict | Action |
| --- | --- |
| `premature` | Answers in the terminal, unless a check below stops it. A line is typed as `[Ouro for <human>] <reply>`; a menu gets its key. The status line says `answered for <human>: <reason>`. |
| `gate` | Lets it through, sets the status line to `needs <human>`, and escalates to the Ouro agent. |
| `done` | Lets it through, sets the status line to `done`, and escalates. |
| `unclear`, or an error | Lets it through and logs it. No escalation. |

Before it answers, Shepherd checks, in order:

1. **The loop guard.** Three automatic answers in a row in one terminal, with no human focus in between, or ten in an hour, stop answering: the return is logged as `loop_guard`, escalated, and the status line says `stopped answering`. Focusing the terminal resets the streak.
2. **The human.** A terminal the human focused in the last 60 seconds is theirs; Shepherd lets the return through.
3. **The screen.** It reads the terminal again; if the last lines changed since the judge saw them, it lets the return through.

On cmux, a line is sent with `terminal.paste` (so no character of it is read as a keystroke) followed by a separate Enter. On Herdr it is sent with `agent.prompt`, which pastes it and presses Enter, and refuses a blocked agent; keys go through `pane.send_keys`, and the status line is the pane's state label (source `ouro.shepherd`, also token `$ouro`). `<human>` is the name on the family friend record whose local id is this OS user, else the first family friend.

Escalation queues one pending message in the agent's private runtime (from `shepherd`, dropped unread after 30 minutes) and asks the daemon for a private turn (trigger `shepherd`, which the daemon's policy allows only with a `shepherd-return` reference and the `sense: shepherd` reference). Escalations in a burst share one wake. The message names the agent, folder, task and why, and ends with the usual untrusted-input line. If the daemon refuses the wake, the message waits for the next private turn.

Every judgment is one JSON line in `state/senses/shepherd/returns.jsonl` in the agent bundle (directory `0700`, file `0600`, rotated once at 2 MB, never synced): time, host, terminal, transition id, agent, folder, task, kind, action, reason, reply, latency and input tokens.

## Tools

The tools appear only for an agent whose `agent.json` has `senses.shepherd.enabled: true`. Only family trust may call them.

| Tool | What it does |
| --- | --- |
| `shepherd_overview` | Lists every terminal with its agent and the last return Shepherd judged there. |
| `shepherd_read` | Reads one terminal's text, 1 to 400 lines (default 60), redacted and capped at 16,000 characters. |
| `shepherd_signal` | Sets or clears the one-line status (at most 120 characters) on a terminal's workspace, and can post a desktop notification. |

## Turning it on

Shepherd uses the terminal host named in the agent's machine runtime vault item. cmux wins when both are set.

**Herdr.** Add a `herdr` record; Herdr's socket is same-user and needs no credential. `herdr.socketPath` overrides the default, `~/.config/herdr/herdr.sock`:

```sh
ouro vault config set --agent <agent> --scope machine --key herdr.socketPath --value "$HOME/.config/herdr/herdr.sock"
```

**cmux.** Shepherd needs the cmux socket credential on this machine. It lives in the agent's machine runtime vault item (`runtime/machines/<machine-id>/config`, key `cmux`), never in the synced bundle.

1. In a terminal inside cmux, store the capability token cmux gives every terminal it starts:

   ```sh
   ouro vault config set --agent <agent> --scope machine --key cmux.socketCapability --value "$CMUX_SOCKET_CAPABILITY"
   ```

   cmux's default `cmuxOnly` socket mode refuses processes it did not start, and the daemon is not a cmux child. The token lets Shepherd in without loosening that mode. If cmux runs in `password` mode, set `cmux.socketPassword` instead. `cmux.socketMode: "automation"` is a last resort. `cmux.socketPath` overrides the default socket, `~/.local/state/cmux/cmux-<uid>.sock`.
2. Set `senses.shepherd.enabled: true` in `agent.json`.
3. Run `ouro up`.

`ouro status` reports the sense as `not_attached` on a machine with no terminal host, `needs_config` when the `cmux` record has no credential (with the command above as the repair), and `running` once the process is up.

## Code

- `src/heart/shepherd-config.ts`: the terminal host connection from machine config, status facts and the repair hint.
- `src/senses/shepherd/host.ts`: the host adapter seam.
- `src/senses/shepherd/cmux.ts` and `client.ts`: the cmux adapter and its socket client.
- `src/senses/shepherd/herdr.ts`: the Herdr adapter and its socket client.
- `src/senses/shepherd/judge.ts`: the judge and the reply safety rules.
- `src/senses/shepherd/sense.ts`: the sense process (checks, answers, escalation); `src/senses/shepherd-entry.ts` is its daemon entry point.
- `src/senses/shepherd/returns.ts`: the returns log.
- `src/senses/shepherd/redact.ts`: best-effort secret redaction.
- `src/heart/private-runtime/policy.ts`: the `shepherd` private-turn trigger.
- `src/repertoire/tools-shepherd.ts`: the three tools.
