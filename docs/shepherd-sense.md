# Shepherd Sense

Shepherd keeps the coding agents in this Mac's terminals working. Every time one of them hands control back, a cheap judge decides whether it should have. When the agent stopped too early (it asked "want me to go ahead?", offered a menu with a clear recommendation, or stopped after a plan), Shepherd answers in the terminal, visibly, and the agent carries on. When the agent needs the human (a sign-in, a decision that is theirs, money, an irreversible step) or says the work is done, Shepherd lets the return through and brings it to the supervising agent.

It is agent-agnostic and terminal-agnostic. Nothing in it assumes a particular coding agent: Claude Code, Codex, Copilot CLI, Agency and any other agent are judged by the same rubric from their screen. A terminal host is an adapter (`src/senses/shepherd/host.ts`): cmux and Herdr.

## What a return is

A return is the host's own "agent stopped" signal.

- **cmux, hooked agents.** cmux publishes `agent.hook.Stop` (and `StopFailure`) for every agent its hooks cover. Shepherd follows cmux's `events.stream` (categories `agent` and `surface`) and waits a 3-second grace period: any later hook for the same terminal other than `SubagentStop` or `Notification` means the agent resumed, and the stop is dropped. When cmux's session store (`~/.cmuxterm/<agent>-hook-sessions.json`, keyed by the agent's own session id; hook events name it `<agent>-<id>`) says background work was still running at the stop, Shepherd waits 30 seconds more and then passes the stop on marked as background work. The return is keyed by cmux's event id (`cmux:<boot id>:<seq>`) and carries the agent's last message (`lastBody`) and folder from that store.
- **cmux, terminals no hook speaks for.** Some agents (Agency today) have no cmux hook. Every 4 seconds Shepherd reads the last 40 lines of each such terminal. Output that changed and then held still for 8 seconds is one return. Plain shells are watched too, so a terminal judged as still working or as not an agent waits twice as long before its next quiet return, doubling up to 5 minutes; focusing it or any other verdict restores the 8 seconds. A terminal whose hooked agent's session ends is watched this way again.
- **Herdr.** Herdr detects the agent in every pane itself and publishes each change of its state as `pane.agent_status_changed` (`idle`, `working`, `blocked`, `done`, `unknown`). A pane that leaves `working` for `idle`, `done` or `blocked` and is still there after the 3-second grace period (checked with `agent.get`) is a return, keyed by Herdr's `state_change_seq` (`herdr:<pane>:<seq>`). A passing `unknown` state is ignored, so working, unknown, idle still counts. Herdr's agent-status subscriptions name each pane, so Shepherd subscribes again when a pane opens, closes or moves (following a moved pane to its new id), and with backoff after `events_lost` or a lost connection. Herdr does not replay events, so each new subscription starts from a fresh `pane.list`, and a pane that stopped working while Shepherd was not subscribed is handled as a return. Shepherd reads only the visible screen, because reading scrollback makes Herdr scroll the agent's UI.
- **Restarts and gaps.** The first connection, and any connection whose `ack` reports a gap, starts at cmux's latest event, so old stops are never replayed as new returns. Reconnects back off 1, 2, 5, 10, then 30 seconds.

## Background work is not a return

An agent that ends its turn while its own background work runs (subagents, background shells or jobs, watchers) has not handed control back: it is waiting for that work and will stop again when it reports. Shepherd treats such a stop as `working`. It never answers it and never escalates it as a gate. Its last message is a progress update: it is logged, and the status line says `<agent> waiting on its background work: <one line>`. Only when the judge says the update carries news the human would want now does it reach the Ouro agent, as a `[Shepherd update]` pending message with no wake, read on the agent's next private turn. With background work reported by the host, every verdict becomes `working`; a `gate` verdict is passed on as news. A later background stop with the same last message is logged without asking the judge again.

Shepherd knows about background work two ways. The terminal host may say so (cmux's `hadPendingBackgroundWorkAtStop`, or a session lifecycle of `running` or `backgroundWorkPending`); then the judge is told, and a `premature` or `done` verdict becomes `working`. Otherwise, as on Herdr, whose agent states do not say, the judge reads the screen: running-task indicators or wording such as "waiting for background agents" mean `working`. The session is judged afresh at its next real stop, after the background work reports back and the agent's next turn ends.

## The judge

The judge reads a packet (the human's name, the agent, folder, the `Desk-Task:` line if the screen has one, the agent's last message and the last 80 screen lines, all redacted) and answers with JSON: `premature` with a reply, `gate`, `done`, `working` (with a `news` flag) or `unclear`. The screen is untrusted data. It runs on the agent's own `agent` provider lane with no tools, low reasoning effort and a 20-second timeout, and its latency and input tokens are logged.

A reply is either one key from a fixed set (enter, escape, up, down, tab, 1-9, y, n) or one line of at most 240 characters. The line has no line breaks, backslashes, `@`, control characters, invisible formatting or bidirectional-override characters, or leading `/`, `!` or `#`, so an input box never reads it as a command, a file mention or more than one line. Because the terminal might turn out to be a plain shell, it also has none of these shell characters: semicolon, dollar sign, backtick, pipe, `<`, `>` and `&`. Anything else turns the verdict into `unclear`.

## What Shepherd does with a verdict

| Verdict | Action |
| --- | --- |
| `premature` | Answers in the terminal, unless a check below stops it. A line is typed as `[<configured agent name> for <human>] <reply>`; a menu gets its key. The status line says `answered for <human>: <reason>`. |
| `gate` | Lets it through, sets the status line to `needs <human>`, and escalates to the Ouro agent. |
| `done` | Lets it through, sets the status line to `done`, and escalates. |
| `working` | Never answers. Sets the status line to `<agent> waiting on its background work: <reason>` and logs it. Queues a `[Shepherd update]` for the Ouro agent, with no wake, only when the judge flags news. |
| `unclear`, or an error | Lets it through and logs it. No escalation. |

Before it answers, Shepherd checks, in order:

1. **The loop guard.** Three automatic answers in a row in one terminal, with no human focus in between, or ten in an hour, stop answering. The return that trips it is logged as `loop_guard` and escalated once, and the status line says `stopped answering`. Until the human focuses that terminal, its later returns are logged as `loop_guard` with no judge call and no new escalation.
2. **The human.** Shepherd never types into the terminal the human is in: on cmux, the focused surface of the selected workspace in a visible window, read from `system.tree` just before sending (cmux reports focus only when it changes, so a human who stays in one terminal sends no further events). A terminal the human left in the last 60 seconds is also theirs.
3. **The screen.** It reads the terminal again; if the last lines changed since the judge saw them, it lets the return through.

Shepherd's status is one entry per terminal (cmux key `ouro_<surface>`, attached to that surface's panel), because a cmux workspace can hold several agents. It is cleared as soon as the agent resumes or the terminal's screen moves again. On cmux, a line is sent with `terminal.paste` (so no character of it is read as a keystroke) followed by a separate Enter. On Herdr it is sent with `agent.prompt`, which pastes it and presses Enter, and refuses a blocked agent; keys go through `agent.send_keys`, and the status line is the pane's state label (source `ouro.shepherd`, also token `$ouro`). `<human>` is the name on the family friend record whose local id is this OS user, else the first family friend.

Escalation queues one pending message in the agent's private runtime (from `shepherd`, dropped unread after 30 minutes) and asks the daemon for a private turn (trigger `shepherd`, which the daemon's policy allows only with a `shepherd-return` reference and the `sense: shepherd` reference). Escalations in a burst share one wake. The message names the agent, folder, task and why, and ends with the usual untrusted-input line. If the daemon refuses the wake, the message waits for the next private turn.

## Telling the owner

After every judged return, the owner hears what happened in one short plain-text message on Teams, written by Shepherd itself with no model turn, so it costs no premium request and does not depend on the Ouro agent deciding the return matters. It names the agent, folder and terminal, what Shepherd did and the judge's reason, for example:

> Claude Code in ouroboros (surface:12) stopped early, so I sent it back: "keep going, run the tests". Why: it asked whether to continue a task it was told to finish.

> Copilot in desk (surface:3) needs you. Why: it wants to push to main.

- **Who hears it.** Every family friend with a Teams user id the agent's bot can open a chat with, once per Teams user. The message goes through the Teams sense's proactive path (trust check and internal-content guard) using a bot client of Shepherd's own, built from the agent's Teams credentials (the secondary bot when it serves the friend's tenant). When no family friend is reachable on Teams, Shepherd logs `senses.shepherd_notice_no_target` and does nothing else.
- **Bursts.** Returns within 5 seconds of the first share one message (up to six named, the rest counted). Each return is in at most one message. A send that fails or is refused is logged and never stops the sense.
- **What counts.** Every judged return, including errors. A return the loop guard already holds, and a background wait with nothing new, are not judged again and send nothing. A `working` update is sent only when the judge flags news.
- **Untrusted text.** Agent, folder, reply and reason are cut to one bounded line with control characters and anything Teams could read as markup or a mention (`< > [ ] * ~ # | \ @`, backticks) removed, and the message is sent as plain text.
- **Policy.** `senses.shepherd.notify` in `agent.json`: `every` (the default), `needs-me` (gates, finished work and a tripped loop guard) or `off`.

The private escalation to the Ouro agent above is unchanged, so it can still act on gates and deliveries.

Every judgment is one JSON line in `state/senses/shepherd/returns.jsonl` in the agent bundle (directory `0700`, file `0600`, rotated once at 2 MB, never synced): time, host, terminal, transition id, agent, folder, task, kind, action, reason, reply, latency and input tokens.

**Menu keys can approve permission prompts.** An agent that asks for permission before doing work inside its task has stopped too early under TTFA (time to first action), so the judge may answer it with a key, which can approve the prompt. That is deliberate: the human's standing authority covers routine work, and gates (credentials, money, irreversible acts, decisions that are the human's) are never answered. Every such answer is logged and shown on the status line.

## Talking to your agent about one session

The independent graphical composer is a short **About** selector, a message box,
and your agent's actual reply, not a terminal inventory. The agent's
`agent.json` `displayName` supplies its labels and attribution; absent that field,
the configured agent identifier is used. "Ouro" is one agent's name, not a name
every installation shares. The composer stays usable while the coding agent is
working and never borrows its input. Open it in cmux with:

```sh
ouro shepherd chat --agent <agent> --web
```

The browser opens beside the current terminal without moving its focus. On first opening, the composer offers the current coding session when cmux can identify exactly one; otherwise choose its short title under **About**. **Refresh** updates session choices without changing the conversation. Once selected, the conversation is pinned to that terminal's stable UUID. Switching terminals or windows does not retarget it. Enter sends; Shift+Enter adds a line. **Cancel <name>** cancels only your supervising agent's reply, not coding work. **Reconnect** checks the authoritative journal without submitting the message again. Unacknowledged messages retain their original session, draft and request ID; About remains locked until their receipt is resolved. The same ID is used in the daemon journal, so recovering after the HTTP listener restarts cannot start that turn twice. New draft edits made while a send is being acknowledged are kept.

The managed Shepherd sense on this Mac also installs a small native **Talk to <name>** entry at `~/.config/cmux/sidebars/ouro-attention-<agent>.swift`. It can be opened as a cmux sidebar pane with `cmux sidebar open ouro-attention-<agent>`; its button opens the same graphical composer. The sense owns this persistent entry; one-off `--web` views do not replace it. This uses the installed cmux Swift interpreter, not a newer JavaScript sidebar API or an unsupported custom right-sidebar mode. No layout or keyboard focus is changed merely because Shepherd starts. The loopback entry is restricted to the existing OS user's local-family identity, with a private entry token and same-origin checks; it is not a remote chat server.

For a terminal-only composer, omit `--web`. `--session <UUID>` explicitly selects
a terminal in either mode. A leading `@<configured name>` or `@<agent identifier>`
is accepted in this independent composer. It does not register native mention
interception inside Copilot, Claude or Codex.

## Feedback from the coding session

With the agent's MCP bridge registered in your coding harness, say the feedback
in that actual coding session, for example:

> Orchid, you should have caught this. It stopped after writing the plan, but I
> asked it to finish the implementation.

The coding agent relays that explicit feedback with the bridge's
`shepherd_feedback` tool and quotes its actual short receipt in the same session.
You do not need to find a surface UUID, reconstruct context in Teams or switch
to the separate composer. This is an MCP conversation interaction, not a claim
that arbitrary `@name` input is intercepted before the coding model sees it.
The bridge must actually be registered and connected; after upgrading, reconnect
it so its tool list includes `shepherd_feedback` and `shepherd_feedback_status`.
The server command for the harness's existing local stdio MCP registration is
`ouro mcp-serve --agent <agent>`. Run it as that coding session's MCP child, not
through a detached shared service that has lost the originating terminal.

The bridge derives its own controlling terminal, and the daemon requires one
matching recognized cmux coding session plus this OS user's existing local-family
identity. The tool cannot choose a different source, actor, agent or recipient.
Detached/remote bridges without a unique local controlling TTY are refused,
not attached to whichever terminal happens to be focused. Native source binding
currently uses POSIX TTYs and cmux stable surface IDs.

The receipt means **received and queued**, not "learned" or "Teams delivered."
It preserves a request ID generated by the coding caller. A retry with that same
ID and identical feedback returns its original receipt and frozen context,
including after the source disappears; a changed request body is refused.
The native receipt is tool output, never terminal input, a submitted coding
prompt or a focus command.

The existing Shepherd sense reviews queued feedback with the supervising agent,
using a bounded, redacted source packet and its actual prior judgment when one
exists. Screen and caller context are background evidence, not instructions.
The review can read that session's history and record/inspect guidance; it cannot
type into terminals, run a shell, start a background ponder or select an external
recipient. Session-only guidance is the default; a broader preference requires
the human's explicit generalization.

The full acknowledgement goes privately to the originating operator on Teams,
not every family friend: what the agent understood, what it actually recorded
or changed and its scope, and any clarification it needs. Feedback requires an
existing unambiguous private Teams identity; absent that route, submission does
not promise a ping it cannot deliver.

Reply to that Teams acknowledgement for clarification. Its actual outgoing
activity ID, private conversation and resolved actor identify the original
feedback, so the agent receives the stored source context without asking you to
repeat it. An explicit full `feedback:<UUID>` reference selects only the same
actor's record in its recorded conversation. Conflicting or ambiguous references
are refused rather than attached to the latest terminal. Ordinary replies to
unrelated messages remain ordinary Teams conversations.

`shepherd_feedback_status` checks the original request without repeating model
work or requiring the source terminal to remain present. Review and transport
custody are separate: pending requests survive restart; interrupted model
execution and unknown Teams acceptance are not automatically replayed. A
definitely-not-sent transport result can retry, while `sent` requires the actual
conversation and message receipt. It is transport acceptance, not a read receipt.

Feedback lives privately under `state/senses/shepherd/feedback/` in the agent
bundle (`0700` directories, `0600` database/receipts). The active queue is bounded
at 512 records; accepted closed deliveries retain keyed immutable receipt
archives for idempotency and clarification, rather than consuming a lifetime
512-submission allowance. Unresolved records are never silently evicted.

## Tools

These are the supervising agent's runtime tools, distinct from the two native
MCP feedback tools above. They appear only for an agent whose `agent.json` has
`senses.shepherd.enabled: true`. Only family trust may call them.

| Tool | What it does |
| --- | --- |
| `shepherd_overview` | Lists every terminal with its agent and the last return Shepherd judged there. |
| `shepherd_read` | Reads one terminal's text, 1 to 400 lines (default 60), redacted and capped at 16,000 characters, with `screen`, a fingerprint of what it shows now. |
| `shepherd_signal` | Sets or clears the one-line status (at most 120 characters) on a terminal's workspace, and can post a desktop notification. |
| `shepherd_send` | Types into one terminal for the human who asked for it: a line, or one key. |

`shepherd_send` lets the human run their coding agents from wherever they talk to the Ouro agent, such as Teams on a phone. It types only for a family friend in their own conversation; the private runtime (the agent on its own) is refused, so it never types on its own initiative. Each call takes exactly one of:

- `text`: one line of at most 2,000 characters with no control characters, typed as `[<configured agent name> for <their name>] <text>` and submitted with Enter, as Shepherd's own answers are.
- `key`: one of `enter`, `escape`, `up`, `down`, `tab`, `ctrl-c`, `1` to `9`, `y` or `n`, pressed alone. `enter`, `tab`, a digit, `y` and `n` can approve or choose on a prompt, so they need the `screen` fingerprint from a `shepherd_read` made just before.

Right before typing it finds the session again (refusing one that is gone) and reads its screen; if a `screen` was passed and the last 20 lines changed since, ignoring numbers, nothing is sent. Unlike Shepherd's own answers, it also types into the terminal the human has focused, because the human asked. Every send emits `repertoire.shepherd_send` (session, ref, agent, character count, key, requesting friend id, focus, whether the screen was checked; never the text) and sets the status line to `sent for <name>`. Every refusal emits `repertoire.shepherd_send_refused` with the reason.

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
- `src/senses/shepherd/owner-notice.ts`: the owner notice (policy, wording, targets, coalescing, Teams send).
- `src/senses/shepherd/returns.ts`: the returns log.
- `src/senses/shepherd/redact.ts`: best-effort secret redaction.
- `src/heart/private-runtime/policy.ts`: the `shepherd` private-turn trigger.
- `src/repertoire/tools-shepherd.ts`: the three tools.
