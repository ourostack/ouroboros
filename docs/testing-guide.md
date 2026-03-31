# Testing Guide

This is the operator smoke guide for the current runtime. It focuses on the real user path:

`npx ouro.bot` -> `ouro up` -> `ouro status` -> `ouro chat` / daemon senses -> `ouro stop`

For local development: `npm run dev` (builds and starts daemon from local repo) or `ouro dev` (if the `ouro` binary is current).

## 1. Bootstrap And Launcher Truth

Run this from outside the repo so you exercise the published bootstrap path rather than a local workspace binary:

```bash
cd ~
npx ouro.bot -v
npx ouro.bot up
ouro -v
ouro status
```

Expected:

- `npx ouro.bot -v` and `ouro -v` report the same version.
- `ouro status` shows:
  - daemon overview
  - version
  - last updated
  - discovered agents
  - senses
  - workers

If the launcher was stale, `ouro up` should repair it instead of leaving you split across different runtime paths.

## 2. Existing-Agent Chat Smoke

Open a chat with an existing bundle:

```bash
ouro chat <agent>
```

Expected:

- the agent starts from the current runtime
- prompt/runtime info is available
- the agent responds without cold-start confusion

Good probes:

- `what senses do you have?`
- `what version are you on?`
- `what does interactive mean?`

## 3. First-Run / Hatch Smoke

To exercise agent creation:

```bash
ouro hatch
```

Or explicitly:

```bash
ouro hatch --agent Hatchling --human Ari --provider anthropic --setup-token <token>
```

Expected:

- system setup happens first
- Adoption Specialist runs
- a canonical bundle is created under `~/AgentBundles/Hatchling.ouro/`
- secrets are written under `~/.agentsecrets/Hatchling/secrets.json`

Verify:

- `~/AgentBundles/Hatchling.ouro/agent.json`
- `~/AgentBundles/Hatchling.ouro/bundle-meta.json`
- canonical psyche/task/skill/state directories exist

## 4. Provider Auth Recovery Smoke

When a provider needs first-time setup, reauth, or a deliberate switch, use the
installed runtime path instead of repo-local scripts:

```bash
ouro auth --agent Hatchling
ouro auth --agent Hatchling --provider openai-codex
```

Expected:

- `ouro auth --agent Hatchling` reauths the provider already selected in `~/AgentBundles/Hatchling.ouro/agent.json`
- `--provider <provider>` is optional and meant for an explicit provider add/switch
- an explicit provider override updates `agent.json` so the newly authenticated provider becomes live runtime truth
- if a session already failed, the follow-up move is to retry the failed `ouro` command or reconnect the session

## 5. Daemon Messaging Smoke

From another terminal:

```bash
ouro msg --to <agent> --session smoke --task smoke-task "status ping"
ouro poke <agent> --task smoke-task
```

Expected:

- `ouro msg` queues or delivers through the daemon cleanly
- `ouro poke` triggers task work for that agent

## 6. Sense Smoke

### CLI

CLI is `interactive`, so it should appear in `ouro status` without pretending the daemon hosts it.

### BlueBubbles

If BlueBubbles is enabled and configured:

- `ouro status` should show `BlueBubbles` as `ready` or `running`
- inbound iMessages should create or continue the correct chat trunk
- typing and read behavior should feel immediate

### Teams

If Teams is enabled and configured:

- `ouro status` should show `Teams` as `ready` or `running`
- the adapter should respond without boot-introducing itself

## 7. Logs And Shutdown

```bash
ouro logs
ouro stop
ouro status
```

Expected:

- `ouro logs` tails daemon/runtime logs
- `ouro stop` shuts down cleanly
- `ouro status` shows the stopped state clearly instead of raw socket errors

## 8. Repo-Code Validation

For runtime code changes inside the repo:

```bash
npm test
npx tsc --noEmit
npm run test:coverage
```

All three should pass before merge.

## Troubleshooting

### `ouro` and `npx ouro.bot` disagree on version

Run:

```bash
cd ~
npx ouro.bot up
ouro -v
```

`ouro up` should repair the local launcher and current daemon state.

### `ouro status` cannot reach the daemon

Run:

```bash
ouro up
ouro status
```

If the daemon is not running, status should describe that plainly rather than surfacing raw socket noise.

### A provider says to reauthenticate

Run:

```bash
ouro auth --agent <agent>
```

Use this only when you need to authenticate or reauthenticate the provider already
selected in `agent.json`.

If you are deliberately adding or switching providers, run:

```bash
ouro auth --agent <agent> --provider <provider>
```

After reauth succeeds, retry the failed `ouro` command or reconnect the session that
already errored.

### A sense shows `needs_config`

Check:

- `~/AgentBundles/<agent>.ouro/agent.json`
- `~/.agentsecrets/<agent>/secrets.json`

Sense enablement lives in `agent.json`; secret material lives in `secrets.json`.

### BlueBubbles or Teams behavior feels wrong

Use:

```bash
ouro status
ouro logs
```

Then verify the sense-specific config block is complete in `secrets.json` and that the sense is actually enabled in `agent.json`.
