# Auth And Providers

This is the locked runtime contract for credentials, provider selection, repair, and hatch bootstrap.

The short version: each agent owns one vault. Provider/model choice is local to each machine. The daemon loads credentials into memory and reuses them. Humans own browser login, MFA, provider dashboards, vault unlock secrets, and raw secret entry. Agents can diagnose, refresh, verify, and explain without ever seeing raw secrets.

## Sources Of Truth

| Concept | Source Of Truth | Notes |
| --- | --- | --- |
| Agent identity, phrases, senses, context, vault coordinates | `~/AgentBundles/<agent>.ouro/agent.json` | Vault coordinates are not secrets. |
| Provider/model selection on this machine | `~/AgentBundles/<agent>.ouro/state/providers.json` | Two lanes: `outward` and `inner`. There is no silent fallback between lanes. |
| Provider credentials | The agent's Bitwarden/Vaultwarden vault item `providers/<provider>` | One vault per agent. No machine-wide provider credential pool. |
| Runtime/sense/integration credentials | The agent's Bitwarden/Vaultwarden vault item `runtime/config` | Teams, BlueBubbles, OAuth connection names, Perplexity, embeddings, and similar runtime credentials. |
| Travel/tool credentials | Ordinary items in the agent's Bitwarden/Vaultwarden vault | Examples: `duffel.com`, `stripe.com`, or other service domains. |
| Vault unlock material on this machine | Local unlock store | Prefer macOS Keychain, Windows DPAPI, or Linux Secret Service. Plaintext fallback is allowed only by explicit human choice. |
| Hot runtime | Process memory | Loaded from vault at defined refresh points, never fetched from the remote vault per request. |

The only Ouro-owned durable credential locations are the bundle and the agent vault. Local unlock material is a machine-local cache, not a credential source of truth.

Do not introduce a second credential source of truth. Raw credentials belong in the owning agent's vault. Bundle files may contain references, configuration, state, and vault coordinates, but not raw credentials.

## Provider Selection

Every agent has two local provider lanes:

- `outward`: CLI, Teams, BlueBubbles, and other human-facing senses.
- `inner`: inner dialogue and agent-facing model calls.

Both lanes must be complete on each machine:

```bash
ouro use --agent <agent> --lane outward --provider <provider> --model <model>
ouro use --agent <agent> --lane inner --provider <provider> --model <model>
```

`ouro use` changes the machine-local provider/model choice. It does not create or update credentials.

`agent.json` may bootstrap missing local state during setup, but once local provider state exists, `state/providers.json` is authoritative for that machine.

## Credentials

Provider credentials are stored with:

```bash
ouro auth --agent <agent> --provider <provider>
```

`ouro auth` stores credentials in that agent's vault. It does not switch a provider lane.

Credential verification is explicit:

```bash
ouro auth verify --agent <agent>
ouro auth verify --agent <agent> --provider <provider>
```

Provider credential refresh is explicit and also participates in retry:

```bash
ouro provider refresh --agent <agent>
```

Refresh means: read the latest provider credential snapshot from the agent vault, update the daemon's in-memory credential cache, and rebuild provider runtime objects only when the credential revision or provider/model binding changed.

Runtime/sense/integration credentials are stored field by field with:

```bash
ouro vault config set --agent <agent> --key bluebubbles.password
ouro vault config set --agent <agent> --key teams.clientSecret
```

The values are written into the `runtime/config` vault item and are not printed back.

## Runtime Caching

The remote vault is not in the hot path.

Normal model calls use this path:

```text
LLM request -> in-memory provider runtime -> provider API
```

They must not use this path:

```text
LLM request -> Bitwarden/Vaultwarden -> provider API
```

The daemon may read the vault at these boundaries:

- daemon startup
- `ouro vault unlock`
- `ouro auth`
- `ouro auth verify`
- `ouro provider refresh`
- `ouro use` provider/model checks
- one bounded refresh attempt during provider failure retry

The daemon should keep provider credentials only in process memory after loading them. There is no local provider-key cache on disk. The vault remains the credential source of truth.

## Failure And Repair

Provider failure handling should use the same shared repair model everywhere: CLI errors, `ouro up`, `ouro status`, start-of-turn provider visibility, and prompt guidance.

The retry ladder is:

1. A provider request fails.
2. Classify the failure, but still treat it as eligible for bounded retry because failures can be misleading.
3. Clear the provider runtime cache for the affected lane.
4. Refresh the provider credential snapshot from the agent vault.
5. If the credential revision or provider/model binding changed, rebuild the provider runtime.
6. Retry the request within the bounded retry policy.
7. If it still fails, mark the lane degraded and surface exact repair guidance.

Repair guidance must include an actor:

- `agent-runnable`: safe for the agent to run when it has tool access, such as status, verify, and refresh commands.
- `human-required`: requires browser login, MFA, provider dashboard access, API token creation, or secret entry.
- `human-choice`: requires the human to decide which provider/model this machine should use.

Agents may run agent-runnable checks and refreshes. Agents must not ask the user to paste secrets into chat. When repair requires a human, the agent should say why and direct the human to the terminal, browser auth flow, or provider console.

Example human-required repair:

```text
openai-codex / gpt-5.4 failed after refresh retry.

Why I cannot fix this automatically:
  OpenAI Codex auth requires a human browser login or refreshed OAuth credentials.

Do this in your terminal:
  ouro auth --agent slugger --provider openai-codex

Then verify:
  ouro auth verify --agent slugger --provider openai-codex
```

Example manual API-key repair:

```text
anthropic / claude-opus-4-6 has no valid credentials.

Why I cannot fix this automatically:
  Anthropic API keys must be created or rotated by a human in the provider console.

Do this:
  1. Create a new Anthropic API key in the Anthropic console.
  2. Run:
     ouro auth --agent slugger --provider anthropic
  3. Paste the key into the terminal prompt, not into chat.
```

## Agent-Facing Knowledge

Agents need compact live operational truth, not a long tutorial in every prompt.

The system prompt should render a small provider section from current runtime state:

```text
runtime uses local provider bindings for this machine:
- outward: minimax / MiniMax-M2.5 [ready; credentials: vault]
- inner: openai-codex / gpt-5.4 [failed: auth; repair: ouro auth --agent slugger --provider openai-codex]
```

When provider state is degraded, prompt guidance should include:

```text
If my provider is degraded, I can run agent-runnable repair commands when I have tool access.
I cannot complete browser login, MFA, provider dashboard token creation, or secret entry.
I never ask the user to paste secrets into chat; I direct them to the terminal/browser/provider console.
```

The full mental model lives in this doc. Runtime behavior and repair strings should be generated by shared code, not copied into prompt text, CLI text, and docs separately.

## SerpentGuide And Hatch

SerpentGuide needs provider credentials to run the adoption conversation.

Interactive hatch should bootstrap SerpentGuide like this:

1. Discover usable provider credentials from already installed agents whose vaults are unlockable on this machine.
2. Show where each option came from, such as `minimax from slugger` or `anthropic from ouroboros`.
3. If no usable credentials are found, prompt the human: "No credentials found. What should your new agent use?"
4. Guide the human through provider-specific auth without asking for secrets in chat.
5. Ping-check the selected provider credentials.
6. Use the selected credentials to run SerpentGuide in memory.
7. Prompt the human outside model context for a human-chosen hatchling vault unlock secret.
8. Create/configure the hatchling bundle and hatchling vault.
9. Store the selected provider credentials into the hatchling vault.

The hatchling vault unlock secret is not generated, printed, included in tool arguments, or sent through chat. The terminal secret prompt does not echo it. The human must save the hatchling vault unlock secret outside Ouro if they want to unlock that new agent on another machine.

Interactive hatch must not create, mutate, or persist a SerpentGuide vault. Persistent SerpentGuide provider credentials are not a supported state: there is no durable human-custody path for a SerpentGuide vault unlock secret, and a packaged bootstrap specialist should not become a hidden credential owner.

Direct/noninteractive hatch may accept explicit provider credentials to run the flow, but must store them in the hatchling vault only. If the flow needs to create a hatchling vault, it still requires a non-echoing human-provided vault unlock secret prompt; it must not generate and print one.

## Continue An Existing Agent Bundle

When a bundle is copied, pulled, or cloned onto a machine, the durable Ouro-owned story is bundle plus vault:

1. The bundle brings identity, vault coordinates, sync settings, and local-state templates.
2. The remote vault brings raw provider, runtime, sense, integration, travel, and tool credentials.
3. The remote vault does not live inside the bundle, and raw credentials do not live in the bundle.
4. Local unlock material is recreated per machine by unlocking the agent vault once.

Start from the bundle remote:

```bash
ouro clone <bundle-git-remote>
```

If the bundle already exists at `~/AgentBundles/<agent>.ouro`, start at unlock:

```bash
ouro vault unlock --agent <agent>
```

Then refresh and verify what this machine can use:

```bash
ouro repair --agent <agent>
ouro provider refresh --agent <agent>
ouro auth verify --agent <agent>
ouro vault config status --agent <agent>
```

Start the daemon when the vault and provider state are ready:

```bash
ouro up
```

Windows DPAPI means a CurrentUser-protected encrypted local unlock file. Windows keeps the protection keys; Ouro stores only the encrypted blob. This fits local unlock caching because the blob is usable by the same Windows user on the same machine, not as a portable credential source.

Linux Secret Service is the freedesktop desktop-secret API usually backed by GNOME Keyring, KWallet, or another `libsecret` provider. It is often unavailable on headless servers, minimal Linux installs, and WSL.

If the machine has no usable local secret store, the harness may offer an explicit plaintext unlock fallback in ignored local state. That fallback must be opt-in, clearly labeled, and never selected silently.

## Existing Agents

There is no hidden recovery path for a lost vault unlock secret.

For an existing agent with no vault locator, run `ouro vault create --agent <agent>`. The command prompts for a human-chosen vault unlock secret without echoing it, writes vault coordinates to `agent.json`, and stores local unlock material for this machine. The human must keep that unlock secret outside Ouro; Ouro will not print it, write a portable copy into the bundle, or store it inside the vault.

For an existing agent with a vault locator and a saved unlock secret, run `ouro vault unlock --agent <agent>` on each new machine and enter the saved agent vault unlock secret from the human/operator who controls that vault. Ouro stores only local unlock material for that machine.

For an existing agent whose unlock secret was not saved or is lost, Ouro cannot recover it from the remote vault or expose it from Keychain, DPAPI, Secret Service, or plaintext fallback. The repair is to create the agent vault and re-auth/re-enter credentials into it.

Use `ouro vault replace --agent <agent>` when there is no local credential export to import. This is the normal path for pre-vault agents that were updated after they already existed. By default it uses the stable agent vault email, `<agent>@ouro.bot`; it does not invent timestamped `+replaced` addresses. It creates an empty vault, writes vault coordinates to `agent.json`, stores local unlock material on this machine, and imports nothing.

Use `ouro vault recover --agent <agent> --from <json>` only when the human still has a local JSON credential export from an earlier alpha. By default it uses the stable agent vault email and imports the JSON once without printing credential values.

If the stable vault account already exists, the command stops. If the human has the unlock secret, run `ouro vault unlock --agent <agent>`. If the unlock secret is truly lost and the operator intentionally wants a different vault account, only use `--email <email>` when intentionally moving the agent; rerun `replace` or `recover` with that explicit address.

## Old Auth-Style Agents

Use this checklist for any existing agent that predates the vault-backed credential model.

1. Pull the latest bundle and harness.

   ```bash
   ouro clone <bundle-git-remote>
   ```

   If the bundle is already present, pull it with normal git sync or run `ouro up` once so bundle update hooks can run.

2. Check whether the bundle has vault coordinates.

   ```bash
   ouro vault status --agent <agent>
   ```

   If the status says `vault locator: not configured in agent.json`, the agent has not set up its vault yet. Create one:

   ```bash
   ouro vault create --agent <agent>
   ```

   Enter a human-chosen unlock secret when prompted. The prompt does not echo the secret. Save that unlock secret outside Ouro immediately. Another machine cannot unlock this agent vault without it. After this, re-enter provider/runtime credentials with the auth and vault config commands below.

3. If the bundle has vault coordinates but nobody saved an unlock secret, choose the repair path that matches what actually exists.

   If there is no local credential export, create an empty agent vault:

   ```bash
   ouro vault replace --agent <agent>
   ```

   This is the expected path for agents that already existed before provider credentials moved into per-agent vaults. Enter a human-chosen unlock secret when prompted, and save it outside Ouro immediately. The prompt does not echo the secret. The command stores vault coordinates in `agent.json` and imports no credentials.

   If the human does have a local JSON credential export, recover into the agent vault and import it:

   ```bash
   ouro vault recover --agent <agent> --from <json>
   ```

   Repeat `--from <json>` for each local JSON export that should be imported. Enter a human-chosen unlock secret when prompted, and save it outside Ouro immediately. The prompt does not echo the secret. The command stores vault coordinates in `agent.json`, imports provider credentials into `providers/*`, imports runtime/sense/integration credentials into `runtime/config`, and prints only field/provider summaries.

4. Unlock the vault on this machine.

   ```bash
   ouro vault unlock --agent <agent>
   ```

   If you just ran `ouro vault replace` or `ouro vault recover`, this machine is already unlocked for the agent vault; run `ouro vault status --agent <agent>` to confirm.

5. Re-enter provider credentials into the agent vault if recovery did not import them or if they are stale.

   ```bash
   ouro auth --agent <agent> --provider <provider>
   ```

   Repeat for every provider the agent should be able to use. Do not copy old local credential files into the bundle. Do not paste raw secrets into chat.

6. Re-enter runtime, sense, integration, travel, and tool credentials into vault items if recovery did not import them or if they are stale.

   ```bash
   ouro vault config set --agent <agent> --key bluebubbles.serverUrl
   ouro vault config set --agent <agent> --key bluebubbles.password
   ouro vault config set --agent <agent> --key teams.clientId
   ```

   Use the relevant field names for the senses and integrations that agent actually uses.

7. Choose this machine's provider/model lanes.

   ```bash
   ouro use --agent <agent> --lane outward --provider <provider> --model <model>
   ouro use --agent <agent> --lane inner --provider <provider> --model <model>
   ```

8. Refresh, verify, and start.

   ```bash
   ouro repair --agent <agent>
   ouro provider refresh --agent <agent>
   ouro auth verify --agent <agent>
   ouro vault config status --agent <agent>
   ouro up
   ```

9. After vault-backed auth verifies, remove obsolete local credential artifacts by hand. They are not a supported fallback and must not be committed.

## Command Vocabulary

Keep the core auth/provider vocabulary small:

```bash
ouro vault unlock --agent <agent>
ouro vault status --agent <agent>
ouro vault replace --agent <agent>
ouro vault recover --agent <agent> --from <json> [--from <json>]
ouro vault config set --agent <agent> --key <field>
ouro vault config status --agent <agent>
ouro auth --agent <agent> --provider <provider>
ouro auth verify --agent <agent> [--provider <provider>]
ouro repair --agent <agent>
ouro provider refresh --agent <agent>
ouro use --agent <agent> --lane outward|inner --provider <provider> --model <model>
```

Deprecated or compatibility command paths should not become new architecture. This harness is still alpha; prefer the simple contract over legacy shims.
