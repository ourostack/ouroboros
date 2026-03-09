# Teams Sense — Deployment & Operations

Ouroboros Teams sense runs as an Azure App Service (Linux, Node 22) serving the Microsoft Teams Bot Framework protocol. It supports single-bot or dual-bot configurations on one App Service.

## Architecture

```
Teams / Copilot
  └─ Bot Framework Service
       └─ App Service (ouroboros-bot.azurewebsites.net)
            ├─ /api/messages           → primary bot (port 3978)
            └─ /api/messages-secondary → proxy → secondary bot (localhost:3979)
```

- **Entry point**: `dist/senses/teams-entry.js --agent <name>`
- **Startup script**: `scripts/teams-sense/startup.sh` (hydrates secrets, starts bot)
- **Build**: `npm run build` (tsc) — NOT esbuild

## Prerequisites

### Azure Resources

Create these before running `deploy-azure.sh`:

1. **Resource Group** — container for all resources
2. **Bot Channel Registration(s)** — one per bot; each gets a `clientId`
3. **App Registration(s)** — matching each bot registration
4. **Managed Identity** (optional) — for passwordless auth on prod bot
5. **OAuth Connection Settings** on each bot registration:
   - `graph` — Microsoft Graph (delegated: `User.Read`, etc.)
   - `ado` — Azure DevOps (`499b84ac-1321-427f-aa17-267ca6975798`)
   - `github` — GitHub (optional)

### Teams Manifest

Each bot registration needs a manifest zip uploaded to Teams Admin Center. Manifests live in the agent bundle (NOT this repo). A manifest contains:

- `manifest.json` — bot ID, scopes (`personal`, `copilot`), messaging endpoint, valid domains
- `color.png` (192x192) + `outline.png` (32x32)

The bot's messaging endpoint must match the App Service URL:
- Primary: `https://<APP_NAME>.azurewebsites.net/api/messages`
- Secondary: `https://<APP_NAME>.azurewebsites.net/api/messages-secondary`

## Configuration

All config comes from `~/.agentsecrets/<agent>/secrets.json`. On Azure, `startup.sh` writes this from the `OUROBOROS_SECRETS` app setting.

### secrets.json structure

```json
{
  "providers": {
    "azure": {
      "endpoint": "https://<resource>.openai.azure.com",
      "deployment": "<deployment-name>",
      "apiKey": "<key>",
      "apiVersion": "2025-04-01-preview"
    }
  },
  "teams": {
    "clientId": "<primary-bot-app-id>",
    "clientSecret": "<secret-or-empty-if-managed-identity>",
    "tenantId": "<azure-ad-tenant-id>",
    "managedIdentityClientId": "<mi-client-id-or-empty>"
  },
  "teamsSecondary": {
    "clientId": "<secondary-bot-app-id-or-empty>",
    "clientSecret": "<secret>",
    "tenantId": "<tenant-id>",
    "managedIdentityClientId": ""
  },
  "oauth": {
    "graphConnectionName": "graph",
    "adoConnectionName": "ado",
    "githubConnectionName": "",
    "tenantOverrides": {
      "<tenant-uuid>": {
        "graphConnectionName": "graph-alt",
        "adoConnectionName": "ado-alt"
      }
    }
  },
  "teamsChannel": {
    "skipConfirmation": true,
    "port": 3978,
    "flushIntervalMs": 1000
  }
}
```

### Auth modes (per bot)

The adapter picks mode based on which fields are populated:

| Mode | Fields required | Use case |
|------|----------------|----------|
| Client secret | `clientId` + `clientSecret` | Dev/test tenants |
| Managed identity | `clientId` + `managedIdentityClientId` | Production |
| DevtoolsPlugin | neither | Local dev (Teams Toolkit) |

### Dual-bot setup

To serve two bot registrations from one App Service (e.g. dev tenant with client secret + prod tenant with managed identity):

1. Populate both `teams` and `teamsSecondary` in secrets.json
2. Register the primary bot's endpoint as `/api/messages`
3. Register the secondary bot's endpoint as `/api/messages-secondary`

The secondary bot runs on an internal port (3979) and the primary app proxies requests to it. Both bots share the same friend store and session storage.

If `teamsSecondary.clientId` is empty, only the primary bot starts.

### Per-tenant OAuth

Different tenants can use different OAuth connection names via `oauth.tenantOverrides`. The adapter resolves connection names from the incoming activity's `tenantId`. Falls back to top-level defaults.

## Deployment

### First-time setup

```bash
export AZURE_SUBSCRIPTION="<sub-id>"
export AZURE_RG="<resource-group>"
export AZURE_BOT_NAME="<bot-registration-name>"
export AZURE_MI_NAME="<managed-identity-name>"
# Optional: AZURE_LOCATION (default: westcentralus), AZURE_PLAN_NAME, AZURE_APP_NAME

bash scripts/teams-sense/deploy-azure.sh
```

This creates: App Service Plan (S1 Linux), Web App, attaches managed identity, sets startup command, enables always-on, updates bot messaging endpoint, builds and deploys code.

### Push secrets

```bash
export AZURE_SUBSCRIPTION="<sub-id>"
export AZURE_RG="<resource-group>"
export TEAMS_CLIENT_ID="<bot-app-id>"
export TEAMS_TENANT_ID="<tenant-id>"
# Optional: TEAMS_CLIENT_SECRET, TEAMS_MI_CLIENT_ID

bash scripts/teams-sense/set-app-secrets.sh
```

Extracts minimal secrets from local `secrets.json`, pushes as `OUROBOROS_SECRETS` app setting, and restarts the app.

### Subsequent deploys

Build and zip-deploy:

```bash
npm run build
az webapp deploy --name ouroboros-bot --resource-group <rg> --type zip --src-path <zip> --clean true
```

`--clean true` wipes `/home/site/wwwroot` but NOT `/home/.agentstate/` (persistent storage).

## Persistent Storage

On Azure (`WEBSITE_SITE_NAME` env set), storage lives under `/home/.agentstate/<agent>/`:

| Path | Contents |
|------|----------|
| `friends/` | Friend records (identity, notes, token usage) |
| `sessions/<friend-id>/teams/<conv-id>.json` | Conversation sessions |

`/home/` is persistent across deploys. `/home/site/wwwroot/` is wiped by `--clean true`.

For non-Azure (CLI, local dev), friends live in `<agent-bundle>/friends/`, sessions in `~/.agentstate/<agent>/sessions/`.

### Open: Azure deployment migration

The current Azure deployment predates the `~/AgentBundles/*.ouro` convention. On the running App Service:

- **Agent bundle** lives in wwwroot (`/home/site/wwwroot/ouroboros/`) — the new code expects `~/AgentBundles/ouroboros.ouro/` which doesn't exist on Azure
- **Friend data** is at `/home/site/wwwroot/ouroboros/friends/` — the new code looks at `/home/.agentstate/<agent>/friends/`
- `agent.json`, `psyche/`, `skills/` are all in wwwroot, not at the new bundle path

Before redeploying, we need to:
1. Decide how the agent bundle reaches the Azure host (bake into wwwroot? copy to `/home/AgentBundles/`? startup script?)
2. Migrate existing friend data from wwwroot to the persistent location
3. Ensure `getAgentRoot()` resolves correctly on Azure

## Streaming & Throttling

Teams throttles streaming updates to 1 req/sec with exponential backoff. The adapter uses chunked streaming:

- Text accumulates in a buffer, flushed every `flushIntervalMs` (default: 1000ms)
- First flush uses `stream.emit()` (primary response), subsequent use `ctx.send()` (separate messages)
- **Copilot 15s timeout**: Copilot Custom Engine Agents require `stream.emit()` within 15s or show "this response was stopped". The adapter emits a placeholder on first tool start.
- **413 recovery**: If emit/send fails with 413 (payload too large), falls back to splitting into 4000-char chunks.

## Message Flow

1. Mention stripping (`<at>...</at>` tags removed)
2. Confirmation resolution (yes/no for pending tool confirmations)
3. Turn serialization (one active turn per conversation; follow-ups queued)
4. OAuth token fetch (Graph, ADO, GitHub — silent failures)
5. Friend resolution (AAD object ID or conversation ID → friend UUID)
6. Trust gate check
7. Slash command dispatch (`/new`, `/commands`)
8. Session load + orphaned tool-call repair
9. Agent loop with streaming callbacks
10. Post-loop OAuth signin cards (if tools returned `AUTH_REQUIRED:<service>`)
11. Context trim + session save + token usage accumulation

## Scripts

| Script | Purpose |
|--------|---------|
| `deploy-azure.sh` | First-time App Service + infrastructure setup |
| `set-app-secrets.sh` | Push secrets to App Service app settings |
| `startup.sh` | Azure startup command (hydrates secrets, starts bot) |
| `self-restart.sh` | Local wrapper: rebuilds on exit code 42 (self-deploy) |
| `bulk-provision-ado.sh` | Utility: bulk-provision tenant users into an ADO org |

## Local Development

Use Teams Toolkit / DevtoolsPlugin mode:

1. Leave `teams.clientId` empty in secrets.json
2. Run `node dist/senses/teams-entry.js --agent ouroboros`
3. The adapter starts in DevtoolsPlugin mode with a local dev tunnel

Or use `self-restart.sh` for auto-rebuild on code changes:

```bash
bash scripts/teams-sense/self-restart.sh --agent ouroboros
```
