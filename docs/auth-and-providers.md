# Auth And Providers

This is the locked runtime contract for credentials, provider selection, repair, and hatch bootstrap.

The short version: each agent owns one vault. Provider/model choice lives in the agent bundle. The daemon loads credentials into memory and reuses them. Humans own browser login, MFA, provider dashboards, vault unlock secrets, and raw secret entry. Agents can diagnose, refresh, verify, and explain without ever seeing raw secrets.

The mental model is simple: an agent needs a password manager in the same way a human does. The agent vault is that password manager. Most items are just the agent's stored credentials for tools and services; a few well-known items are harness-readable because Ouro must use them on the agent's behalf, such as model providers, Perplexity search, Teams, and local sense attachments.

## Sources Of Truth

| Concept | Source Of Truth | Notes |
| --- | --- | --- |
| Agent identity, phrases, senses, context, vault coordinates | `~/AgentBundles/<agent>.ouro/agent.json` | Vault coordinates are not secrets. |
| Provider/model selection | `~/AgentBundles/<agent>.ouro/agent.json` | Two lanes: `outward` and `inner`. Legacy `humanFacing`/`agentFacing` fields are compatibility aliases only. There is no silent fallback between lanes. |
| Provider credentials | The agent's Bitwarden/Vaultwarden vault item `providers/<provider>` | One vault per agent. No shared machine credential pool. |
| Portable runtime/integration credentials | The agent's Bitwarden/Vaultwarden vault item `runtime/config` | Teams, OAuth connection names, Perplexity, embeddings, ElevenLabs TTS, and similar credentials that should travel with the agent. |
| Local sense attachments on this machine | The agent's Bitwarden/Vaultwarden vault item `runtime/machines/<machine-id>/config` | BlueBubbles server URL/password/listener config, Whisper.cpp CLI/model paths, and other local-only attachments. Missing local attachments are `not_attached`, not broken. |
| Travel/tool credentials | Ordinary items in the agent's Bitwarden/Vaultwarden vault | Examples: `duffel.com`, `stripe.com`, or other service domains. |
| Vault unlock material on this machine | Local unlock store | Prefer macOS Keychain, Windows DPAPI, or Linux Secret Service. Plaintext fallback is allowed only by explicit human choice. |
| Hot runtime | Process memory | Loaded from vault at defined refresh points, never fetched from the remote vault per request. |

The only Ouro-owned durable credential locations are the bundle and the agent vault. Local unlock material is a machine-local cache, not a credential source of truth.

Do not introduce a second credential source of truth. Raw credentials belong in the owning agent's vault. Bundle files may contain references, configuration, state, and vault coordinates, but not raw credentials.

## Provider Selection

Every agent has two provider lanes in `agent.json`:

- `outward`: CLI, Teams, BlueBubbles, Mail, Voice, and other human-facing senses.
- `inner`: inner dialogue and agent-facing model calls.

Both lanes must be complete on each machine:

```bash
ouro use --agent <agent> --lane outward --provider <provider> --model <model>
ouro use --agent <agent> --lane inner --provider <provider> --model <model>
```

`ouro use` changes the provider/model choice in `agent.json`. It does not create or update credentials.

## Credentials

Provider credentials are stored with:

```bash
ouro auth --agent <agent> --provider <provider>
```

`ouro auth` stores credentials in that agent's vault. It does not switch a provider lane. In a human terminal it keeps a visible checklist for the auth attempt, vault write, refresh, and verification steps so browser login or vault IO never looks like a dead cursor.

Credential verification is explicit:

```bash
ouro auth verify --agent <agent>
ouro auth verify --agent <agent> --provider <provider>
```

Provider credential refresh is explicit and also participates in retry:

```bash
ouro provider refresh --agent <agent>
```

Refresh means: read the latest provider credential records from the agent vault, update the daemon's in-memory credential cache, and rebuild provider runtime objects only when the credential revision or provider/model binding changed.

Guided integration and local-sense setup starts with:

```bash
ouro connect --agent <agent>
ouro connect providers --agent <agent>
ouro connect perplexity --agent <agent>
ouro connect embeddings --agent <agent>
ouro connect teams --agent <agent>
ouro connect bluebubbles --agent <agent>
ouro connect voice --agent <agent>
```

`ouro connect` opens the connect bay as a shared wizard: one recommended next step, separate sections for providers, portable capabilities, and machine-local attachments, and a prompt that lets the human choose by number or name instead of remembering subcommands first. Every time the root connect bay opens, Ouro uses the shared provider credential read and live ping machinery, but with an orientation policy: one live attempt, a short hard timeout, and no provider-lane mutation. That keeps the menu truthful without spending the full startup retry budget before the human can choose a setup task. `ouro up`, `ouro check`, `ouro auth verify`, and chat startup still own full provider retry behavior. Portable capabilities with saved keys, such as Perplexity search and memory embeddings, are live-checked there too. Before the menu appears, Ouro prints a short `checking current connections` progress step while it verifies providers and reads portable and machine-local runtime settings. If a provider is slow, that step says which provider/model is being checked and then routes the quick failure into the menu as `needs attention` instead of leaving the terminal looking dead.

Guided connectors open with a short capability guide that answers three questions up front: what this unlocks, what the human needs, and where the credential will live. They close with the same shared outcome guide language used by auth, vault, and hatch: a calm title, `What changed`, and `Next moves`.

When a human runs bare `ouro` in a TTY, Ouro opens the same command family from the home deck instead of silently behaving like `ouro up`. The home deck routes into `ouro up`, `ouro connect`, `ouro repair`, `ouro chat`, `ouro hatch`, and help without requiring the human to remember exact command names first.

`ouro connect providers` routes into the same provider auth flow as `ouro auth`, but from the connect bay instead of making the human remember the auth command first.

`ouro connect perplexity` connects Perplexity search. It prompts for the API key without echoing it, stores `integrations.perplexityApiKey` in `runtime/config`, and runs a live Perplexity probe before claiming the capability is ready.

`ouro connect embeddings` connects memory embeddings. It prompts for the OpenAI embeddings API key without echoing it, stores `integrations.openaiEmbeddingsApiKey` in `runtime/config`, and runs a live embeddings probe before claiming the capability is ready.

`ouro connect teams` connects the Teams sense. It prompts for `teams.clientId`, `teams.clientSecret`, `teams.tenantId`, and optional `teams.managedIdentityClientId`, stores them in `runtime/config`, and enables `senses.teams.enabled` in `agent.json`.

`ouro connect bluebubbles` attaches this machine to BlueBubbles. It prompts for the local server URL, app password, webhook listener settings, stores them in `runtime/machines/<machine-id>/config`, and enables `senses.bluebubbles.enabled` in `agent.json`. If Ouro is already running, the connector recycles the daemon once so the local listener starts with the freshly saved machine attachment; if Ouro is not running, the next `ouro up` loads it. It does not make that local Mac Messages bridge portable to every machine.

`ouro connect voice` describes the current voice foundation and the required config fields. Voice is one sense with multiple transports. ElevenLabs TTS uses `integrations.elevenLabsApiKey` and `integrations.elevenLabsVoiceId` in portable `runtime/config`. Whisper.cpp STT uses this machine's `voice.whisperCliPath` and `voice.whisperModelPath` in `runtime/machines/<machine-id>/config`. Enabling `senses.voice.enabled` gives the agent first-class `voice` sessions; those sessions are transcript-first and appear in Ouro Mailbox as text. Meeting links have URL intake plus BlackHole/Multi-Output readiness checks. The Twilio phone transport can be tested locally through Cloudflare Tunnel with Twilio Record -> Whisper.cpp -> voice session -> ElevenLabs -> Twilio Play. Live browser join/injection remains a handoff edge until provider automation lands.

When a CLI auth/connect/vault repair command mutates the bundle, such as writing vault coordinates or enabling BlueBubbles in `agent.json`, Ouro runs the existing bundle sync path if `sync.enabled` is true. A successful command stays successful even if the bundle push fails, but the output includes a compact `bundle sync` line so the human and agent know whether the bundle change reached the remote.

Low-level runtime fields can still be stored directly:

```bash
ouro vault config set --agent <agent> --key teams.clientSecret
ouro vault config set --agent <agent> --key integrations.perplexityApiKey
ouro vault config set --agent <agent> --key bluebubbles.password --scope machine
ouro vault config set --agent <agent> --key integrations.elevenLabsApiKey
ouro vault config set --agent <agent> --key integrations.elevenLabsVoiceId
ouro vault config set --agent <agent> --key voice.whisperCliPath --scope machine
ouro vault config set --agent <agent> --key voice.whisperModelPath --scope machine
ouro vault config set --agent <agent> --key voice.twilioAccountSid
ouro vault config set --agent <agent> --key voice.twilioAuthToken
ouro vault config set --agent <agent> --key voice.twilioPublicUrl --scope machine
ouro vault config set --agent <agent> --key voice.twilioPort --value 18910 --scope machine
```

The values are written into the selected vault item and are not printed back. Prefer `ouro connect` for guided setup when it exists; use `vault config set` for fields that do not have a guided connector yet.

## Vault Items, Managed Workflows, And Bindings

The primitive is a vault item / credential: a private record in the owning agent vault with a stable item name/path, hidden secret material, optional public fields, freeform notes, folder-ish organization, timestamps/provenance, and no assumed use.

Everything else lives outside that item.

### Managed workflow

`ouro connect` is not a generic password-manager entry tool. It is reserved for harness-managed workflows whose runtime behavior Ouro owns: model providers, portable integrations, local sense attachments, and Agent Mail. A credential should get an `ouro connect <name>` flow only when the harness can explain the capability, store it in a known runtime location, verify it, repair it, and apply the resulting runtime state.

### Freeform vault item

Use freeform vault items when an agent or human needs to store a credential or secret without teaching Ouro a new capability:

```bash
ouro vault item set --agent <agent> --item <path> --secret-field <name> [--public-field <key=value>] [--note <text>]
ouro vault item set --agent <agent> --item <path> --template porkbun-api
ouro vault item status --agent <agent> --item <path>
ouro vault item list --agent <agent> [--prefix <path-prefix>]
```

Templates are convenience only. A template may shape hidden prompts and field names, but it does not create a new credential species. `--template porkbun-api` stores an ordinary vault item with hidden `apiKey` and `secretApiKey` fields.

Notes are for humans and agents. Code must not parse meaning out of notes. Notes can explain what the item is, what not to assume, how it was obtained, who can rotate it, and recovery hints. If a workflow needs machine-readable facts, put them in explicit workflow binding fields or committed non-secret run config, not prose.

### Binding / run config

A binding is non-secret configuration that says a workflow should use a specific vault item for a specific task.

For example, a DNS workflow binding may say:

```yaml
domain: ouro.bot
driver: porkbun
credentialItem: ops/registrars/porkbun/accounts/ari@mendelow.me
resourceAllowlist:
  - ouro.bot
```

That binding does not make the referenced vault item a DNS credential, provider credential, ops credential, or authority. It only says this workflow plans to use that ordinary item through this driver and allowlist.

The older Porkbun helper remains as a deprecated compatibility alias:

```bash
ouro vault ops porkbun set --agent <agent> --account <porkbun-account>
ouro vault ops porkbun status --agent <agent> --account <porkbun-account>
```

It should store and report an ordinary vault item, then point humans and agents toward `ouro vault item set --template porkbun-api`.

## Human CLI Progress

Human-facing commands must not turn into a wall of text or a silent blinking cursor. Any command that may wait on browser login, vault IO, daemon startup, daemon restart, provider live checks, or guided connector setup should use the shared checklist progress surface.

The checklist contract is:

- start with the fewest words that orient a non-terminal user
- print or animate the active step when work may take more than about three seconds
- show changed substeps such as `reading vault items`, `storing openai-codex credentials`, or `opening credential vault`
- for daemon replacement, say that Ouro is replacing the running background service and keep the step unresolved until the replacement is actually answering
- complete with a compact success/failure summary, `What changed`, and a `Next moves` landing
- never print raw secrets, OAuth tokens, provider API keys, vault unlock secrets, or machine-local passwords

TTY help/readiness surfaces should share one visual language instead of every command inventing its own transcript. The shared board layer is the intended human surface for `ouro`, `ouro up`, `ouro connect`, `ouro auth verify`, `ouro repair`, `ouro help`, `ouro whoami`, `ouro versions`, and the `ouro hatch` welcome shell. Non-TTY and automation paths should stay compact plain text.

Agent-runnable shortcuts may stay compact when they are intended for automation and already return structured results. Human-choice and human-required flows should choose friendliness over terseness.

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
- `ouro connect`
- one bounded refresh attempt during provider failure retry

The daemon should keep provider and runtime credentials only in process memory after loading them. There is no local provider-key or runtime-secret cache on disk. The vault remains the credential source of truth.

## Failure And Repair

Provider failure handling should use the same shared repair model everywhere: CLI errors, `ouro up`, `ouro status`, start-of-turn provider visibility, and prompt guidance.

The retry ladder is:

1. A provider request fails.
2. Classify the failure, but still treat it as eligible for bounded retry because failures can be misleading.
3. Clear the provider runtime cache for the affected lane.
4. Refresh provider credentials from the agent vault into the daemon's in-memory credential cache.
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
runtime uses provider bindings from agent.json:
- outward: minimax / MiniMax-M2.5 [ready; credentials: vault]
- inner: openai-codex / gpt-5.4 [failed: auth; repair: ouro auth --agent slugger --provider openai-codex]
```

When provider readiness is degraded, prompt guidance should include:

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
7. Prompt the human outside model context for a human-chosen hatchling vault unlock secret, confirm it, and enforce the same strength rules used by `ouro vault create`.
8. Create/configure the hatchling bundle and hatchling vault.
9. Store the selected provider credentials into the hatchling vault.

The hatchling vault unlock secret is not generated, printed, included in tool arguments, or sent through chat. The terminal secret prompt does not echo it and asks for confirmation. The human must save the hatchling vault unlock secret outside Ouro if they want to unlock that new agent on another machine.

Interactive hatch must not create, mutate, or persist a SerpentGuide vault. Persistent SerpentGuide provider credentials are not a supported state: there is no durable human-custody path for a SerpentGuide vault unlock secret, and a packaged bootstrap specialist should not become a hidden credential owner.

Direct/noninteractive hatch may accept explicit provider credentials to run the flow, but must store them in the hatchling vault only. If the flow needs to create a hatchling vault, it still requires a non-echoing human-provided vault unlock secret prompt with confirmation; it must not generate and print one.

## Continue An Existing Agent Bundle

When a bundle is copied, pulled, or cloned onto a machine, the durable Ouro-owned story is bundle plus vault:

1. The bundle brings identity, vault coordinates, sync settings, and local-state templates.
2. The remote vault brings raw provider, portable runtime/integration, local machine attachment, travel, and tool credentials.
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

Start the daemon when the vault and provider lanes are ready:

```bash
ouro up
```

Local attachments are per machine. If BlueBubbles is enabled for the agent but this computer is not attached, run:

```bash
ouro connect bluebubbles --agent <agent>
```

Windows DPAPI means a CurrentUser-protected encrypted local unlock file. Windows keeps the protection keys; Ouro stores only the encrypted blob. This fits local unlock caching because the blob is usable by the same Windows user on the same machine, not as a portable credential source.

Linux Secret Service is the freedesktop desktop-secret API usually backed by GNOME Keyring, KWallet, or another `libsecret` provider. It is often unavailable on headless servers, minimal Linux installs, and WSL.

If the machine has no usable local secret store, the harness may offer an explicit plaintext unlock fallback in ignored local state. That fallback must be opt-in, clearly labeled, and never selected silently.

## Existing Agents

There is no hidden recovery path for a lost vault unlock secret.

For an existing agent with no vault locator, run `ouro vault create --agent <agent>`. The command prompts twice for a human-chosen vault unlock secret without echoing it, writes vault coordinates to `agent.json`, and stores local unlock material for this machine. New unlock secrets must be at least 8 characters and include uppercase and lowercase letters, one number, and one special character. The human must keep that unlock secret outside Ouro; Ouro will not print it, write a portable copy into the bundle, or store it inside the vault.

For an existing agent with a vault locator and a saved unlock secret, run `ouro vault unlock --agent <agent>` on each new machine and enter the saved agent vault unlock secret from the human/operator who controls that vault. Ouro stores only local unlock material for that machine.

`ouro vault unlock` verifies the typed unlock secret against the agent vault before replacing this machine's saved local unlock material. A failed validation must not overwrite a previously working Keychain/DPAPI/Secret Service/plaintext entry.

When previously saved local unlock material is later rejected by the vault, Ouro clears that local entry and reports a human-required unlock/replace path instead of repeatedly retrying a known-bad machine cache. Legacy local unlock entries may be read for compatibility, but they are copied to canonical vault coordinates only after a successful vault login.

For an existing agent whose `agent.json` already has vault coordinates but whose unlock secret was not saved or is lost, Ouro cannot recover it from the remote vault or expose it from Keychain, DPAPI, Secret Service, or plaintext fallback. The repair is to create a replacement agent vault and re-auth/re-enter credentials into it.

Use `ouro vault replace --agent <agent>` only when the bundle already has vault coordinates and there is no local credential export to import. By default it uses the stable agent vault email, `<agent>@ouro.bot`; it does not invent timestamped `+replaced` addresses. It creates an empty vault, writes vault coordinates to `agent.json`, stores local unlock material on this machine, and imports nothing.

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

   Enter and confirm a human-chosen unlock secret when prompted. The prompt does not echo the secret. Save that unlock secret outside Ouro immediately. Another machine cannot unlock this agent vault without it. After this, re-enter provider/runtime credentials with the auth and vault config commands below.

3. If the bundle has vault coordinates but nobody saved an unlock secret, choose the repair path that matches what actually exists.

   If there is no local credential export, create an empty agent vault:

   ```bash
   ouro vault replace --agent <agent>
   ```

   This is the expected path for agents that already existed before provider credentials moved into per-agent vaults. Enter and confirm a human-chosen unlock secret when prompted, and save it outside Ouro immediately. The prompt does not echo the secret. The command stores vault coordinates in `agent.json` and imports no credentials.

   If the human does have a local JSON credential export, recover into the agent vault and import it:

   ```bash
   ouro vault recover --agent <agent> --from <json>
   ```

   Repeat `--from <json>` for each local JSON export that should be imported. Enter and confirm a human-chosen unlock secret when prompted, and save it outside Ouro immediately. The prompt does not echo the secret. The command stores vault coordinates in `agent.json`, imports provider credentials into `providers/*`, imports portable runtime/integration credentials into `runtime/config`, imports BlueBubbles local attachment fields into `runtime/machines/<machine-id>/config`, and prints only field/provider summaries.

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
   ouro connect --agent <agent>
   ouro connect perplexity --agent <agent>
   ouro connect embeddings --agent <agent>
   ouro connect teams --agent <agent>
   ouro connect bluebubbles --agent <agent>
   ouro connect voice --agent <agent>
   ```

   Use `ouro connect` when a guided connector exists. Use `vault config set` only for fields that do not have a guided connector yet. BlueBubbles and Voice transports are local attachments; run their connectors separately on each machine that should bridge iMessage, local audio, Twilio phone calls, or browser meeting audio.

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
ouro vault recover --agent <agent> --from <json> [--from <json> ...]
ouro vault config set --agent <agent> --key <field>
ouro vault config set --agent <agent> --key <field> --scope machine
ouro vault config status --agent <agent> [--scope agent|machine|all]
ouro vault item set --agent <agent> --item <path> --secret-field <field> [--public-field <key=value>] [--note <text>]
ouro vault item set --agent <agent> --item <path> --template porkbun-api
ouro vault item status --agent <agent> --item <path>
ouro vault item list --agent <agent> [--prefix <path-prefix>]
ouro vault ops porkbun set --agent <agent> --account <account>
ouro vault ops porkbun status --agent <agent> [--account <account>]
ouro connect --agent <agent>
ouro connect providers --agent <agent>
ouro connect perplexity --agent <agent>
ouro connect embeddings --agent <agent>
ouro connect teams --agent <agent>
ouro connect bluebubbles --agent <agent>
ouro connect voice --agent <agent>
ouro auth --agent <agent> --provider <provider>
ouro auth verify --agent <agent> [--provider <provider>]
ouro repair --agent <agent>
ouro provider refresh --agent <agent>
ouro use --agent <agent> --lane outward|inner --provider <provider> --model <model>
```

Deprecated or compatibility command paths should not become new architecture. This harness is still alpha; prefer the simple contract over legacy shims.
