# cmux Sense

The cmux sense lets an agent watch the coding agents (Claude Code, Codex, Copilot) that run in [cmux](https://github.com/manaflow-ai/cmux), the terminal app on this Mac. The agent can tell its human who needs them and what each session did, and it can put a one-line status or a desktop notification in front of them. This first version only watches and signals: it never types into a terminal and never answers a coding agent's permission prompt.

## What it does

- **Follows cmux's event stream.** The sense process holds one `events.stream` connection to the cmux control socket, filtered to the `feed` and `surface` categories. From the hook events it keeps, per terminal (cmux calls it a surface), which agent runs there, which folder it is in, its last hook and tool, and a lifecycle: `working`, `idle` (finished its turn and waiting for a prompt), `waiting` (blocked on the human) or `ended`.
- **Escalates decisions cmux is holding open.** When a hook says a decision may be pending, and every 30 seconds, the sense reads `feed.list {"pending_only": true}`. Each new pending permission request, question or plan approval becomes one external event (source `cmux`, event id `feed:<request id>`), so the agent's attention sees it once. The receipt names the agent, tool, folder and terminal, never the tool input: provider payloads can hold secrets.
- **Resumes where it left off.** The event cursor (cmux boot id and sequence), the per-terminal activity and the request ids already escalated live in `state/senses/cmux/state.json` in the agent bundle (directory `0700`, file `0600`). After a disconnect it reconnects with backoff (1, 2, 5, 10, then 30 seconds) and resumes after the saved sequence.

## Tools

The tools appear only for an agent whose `agent.json` has `senses.cmux.enabled: true`, and only at family trust.

| Tool | What it does | Changes anything? |
| --- | --- | --- |
| `cmux_overview` | Lists the decisions cmux is holding open (with a redacted, bounded preview of each request) and every workspace and terminal with what its agent last did. | No |
| `cmux_read` | Reads one terminal's text, optionally with scrollback, 1 to 400 lines (default 60). Secret-shaped strings are redacted and output is capped at 16,000 characters. | No |
| `cmux_signal` | Sets or clears this agent's one-line status (key `ouro`, at most 120 characters) on a workspace's sidebar entry, and/or posts a desktop notification tied to that workspace. | Only what cmux shows |

## Turning it on

The sense needs the cmux socket credential on this machine. It lives in the agent's machine runtime vault item (`runtime/machines/<machine-id>/config`, key `cmux`), never in the synced bundle.

1. In a terminal inside cmux, store the capability token cmux gives every terminal it starts:

   ```sh
   ouro vault config set --agent <agent> --scope machine --key cmux.socketCapability --value "$CMUX_SOCKET_CAPABILITY"
   ```

   cmux's default `cmuxOnly` socket mode refuses processes it did not start, and the daemon is not a cmux child. The token lets the sense in without loosening that mode. If cmux runs in `password` mode, set `cmux.socketPassword` instead. `cmux.socketMode: "automation"` (no credential, for cmux's allow-all-same-user mode) is a last resort. `cmux.socketPath` overrides the default socket, `~/.local/state/cmux/cmux-<uid>.sock`.
2. Set `senses.cmux.enabled: true` in `agent.json`.
3. Run `ouro up`.

`ouro status` reports the sense as `not_attached` on a machine with no `cmux` record, `needs_config` when the record has no credential (with the command above as the repair), and `running` once the process is up. When the socket refuses the credential, the sense records the refusal and the same repair hint in its state file and keeps retrying.

## Wire protocol notes

- One JSON request per line, `{"id","method","params"}`; responses are `{"ok":true,"result"}` or `{"ok":false,"error"}`, and some refusals are plain `ERROR: ...` text.
- With a capability token every line is wrapped as `_cmux_capability_v1 <token> <line>`. In password mode the client sends `auth <password>` first.
- The status pill uses cmux's v1 text commands: `set_status ouro "<quoted text>" --tab=<workspace id>` and `clear_status ouro --tab=<workspace id>`.

## Code

- `src/heart/cmux-config.ts`: machine config, socket auth order, status facts and the repair hint.
- `src/senses/cmux/client.ts`: the socket client (`call`, v1 `command`, `stream`).
- `src/senses/cmux/attention.ts`: state, event handling, pending Feed items and escalation receipts.
- `src/senses/cmux/sense.ts`: the long-running sense process; `src/senses/cmux-entry.ts` is its daemon entry point.
- `src/senses/cmux/redact.ts`: best-effort secret redaction for anything handed to a model.
- `src/repertoire/tools-cmux.ts`: the three tools.
