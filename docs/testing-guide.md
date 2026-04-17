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
- the hatchling vault unlock secret is typed and confirmed by the human in hidden terminal prompts, not generated or printed
- selected provider credentials are stored in the hatchling's vault
- interactive hatch does not create, mutate, or persist a SerpentGuide vault

Verify:

- `~/AgentBundles/Hatchling.ouro/agent.json`
- `~/AgentBundles/Hatchling.ouro/bundle-meta.json`
- canonical psyche/task/skill/state directories exist
- the hatchling vault is unlockable on this machine

## 4. Provider Auth Recovery Smoke

Provider credentials and provider selection are separate. `ouro auth` stores credentials in the owning agent's vault. Provider/model selection for each local machine lives in the bundle's `state/providers.json`.

When a provider needs first-time setup or reauth, use the installed runtime path instead of repo-local scripts:

```bash
ouro auth --agent Hatchling
ouro auth --agent Hatchling --provider openai-codex
```

Expected:

- `ouro auth` stores credentials only in the owning agent's vault
- `ouro auth --agent Hatchling` reauths the provider already selected for Hatchling's outward lane
- `--provider <provider>` authenticates that provider in the owning agent's vault without switching a lane
- auth, provider refresh, and guided connectors show a visible progress checklist while waiting on browser login, vault reads/writes, daemon reload, and verification
- root `ouro connect --agent <agent>` prints a short `checking current connections` preflight before the menu appears
- `ouro up` replacement paths say they are replacing the running background service and do not mark `starting daemon` complete before replacement readiness is known
- provider state remains in `~/AgentBundles/Hatchling.ouro/state/providers.json`
- use `ouro use --agent <agent> --lane <outward|inner> --provider <provider> --model <model>` to switch a lane after credentials exist and the provider/model check passes
- use `ouro provider refresh --agent <agent>` to refresh the daemon's in-memory credential snapshot from the vault
- use `ouro vault config status --agent <agent> --scope all` to inspect portable and machine-local runtime credential fields without printing values
- use `ouro connect --agent <agent>` for the guided connect bay, or jump directly to `ouro connect providers|perplexity|embeddings|teams|bluebubbles --agent <agent>`
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

If BlueBubbles is enabled and attached on this machine:

- `ouro status` should show `BlueBubbles` as `ready` or `running`
- inbound iMessages should create or continue the correct chat trunk
- typing and read behavior should feel immediate

If BlueBubbles is enabled but not attached here, `ouro status` should show `not_attached`, not degrade daemon startup. Attach it with:

```bash
ouro connect bluebubbles --agent <agent>
```

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

## 8. Human CLI Progress Smoke

For human-facing CLI changes, especially auth, repair, startup, and connector flows:

- any wait that may last more than a few seconds should have a current step on screen
- output should be a short checklist, not a repeated wall of repair text
- secret prompts must not echo or print the secret later
- success output should include where the credential/config was stored and the next action
- failure output should keep the last visible progress context and give one useful repair path

Agent-direct shortcuts can stay terse when they are meant for automation, but human-required and human-choice flows should be understandable to someone who does not know terminal vocabulary.

## 9. Repo-Code Validation

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

Use this when you need to authenticate or reauthenticate the provider already selected for that agent on this machine. `ouro auth` stores credentials only; it does not choose the runtime provider/model.

If you are deliberately adding credentials for another provider, run:

```bash
ouro auth --agent <agent> --provider <provider>
```

If you are deliberately switching a runtime lane, run:

```bash
ouro use --agent <agent> --lane <outward|inner> --provider <provider> --model <model>
```

After reauth succeeds, retry the failed `ouro` command or reconnect the session that
already errored.

If a repair message says the agent can run a refresh or verify command, that is agent-runnable. If it requires browser login, MFA, provider dashboard access, API token creation, or secret entry, it is human-required; enter secrets in the terminal or provider UI, never in chat.

### A sense shows `needs_config`

Check:

- `~/AgentBundles/<agent>.ouro/agent.json` (check sense enablement)
- `~/AgentBundles/<agent>.ouro/state/providers.json` (check outward/inner provider+model)
- the agent's vault provider credentials
- portable runtime config in `runtime/config`
- machine-local attachments in `runtime/machines/<machine-id>/config`

Sense enablement lives in `agent.json`; provider+model selection per machine lives in `state/providers.json`; all raw credentials live in the owning agent's vault.

### BlueBubbles or Teams behavior feels wrong

Use:

```bash
ouro status
ouro logs
```

Then verify the sense-specific credentials are configured for that integration, the sense is enabled in `agent.json`, and the relevant outward/inner lane is configured in `state/providers.json`. Prefer the guided connect bay for repairs. For BlueBubbles specifically, `ouro connect bluebubbles --agent <agent>` stores local server details under this machine's vault item.
