# Teams Sense Operator Scripts

This folder contains Azure/App Service helper scripts for the Teams sense.

They are operator utilities, not the main day-to-day runtime path. The primary runtime docs for the harness are:

- `README.md`
- `ARCHITECTURE.md`
- `docs/OAUTH-SETUP.md`

## What Is Here

- `deploy-azure.sh`
  Provisions or updates the App Service deployment shell around a Teams bot.
- `startup.sh`
  Startup script used by the App Service deployment path.
- `self-restart.sh`
  Local rebuild/restart helper for Teams-sense iteration.
- `local-tunnel.sh`
  Controller for an existing launchd-supervised local Cloudflare quick tunnel.
  Requires `OURO_TEAMS_SUBSCRIPTION`, `OURO_TEAMS_BOT_RG`, and
  `OURO_TEAMS_BOT_NAME`; Azure operations always use that explicit subscription.
  The default receiver is port 3978. The controller requires Cloudflare's local
  readiness endpoint before updating and confirming the bot registration. A
  permanent tunnel rejection, failed registration, or three consecutive readiness
  failures exits nonzero so the existing supervisor can restart it. A live process
  or printed URL alone is not readiness.

## Important Truths

- These scripts are currently written for the `ouroboros` Teams deployment path.
- They depend on Azure CLI and manual operator inputs.
- They are not the same thing as `ouro up`.
- Review the script bodies before using them in a fresh environment.
- `local-tunnel.sh` does not install a supervisor or change bot identity/authentication.
  Point the existing launch wrapper at a reviewed copy, retaining its environment
  and a rollback copy of the prior wrapper. Set `OURO_TEAMS_CLOUDFLARED` to the
  installed binary if it is not `~/.local/bin/cloudflared-ouro`. It uses a loopback
  metrics listener at `127.0.0.1:20246` (override with
  `OURO_TEAMS_TUNNEL_METRICS` if occupied). `OURO_TEAMS_AZ` and `OURO_TEAMS_CURL`
  allow absolute command paths; tests use disposable fakes without cloud access.
  Restoring a registered route is not proof that a human request received a reply:
  conversational acceptance still requires a correlated new request and answer.

## Credential Shape

The deployment path uses the same source of truth as local runtime:

- non-secret agent configuration in the bundle
- raw Teams/OAuth/provider credentials in the agent's Bitwarden/Vaultwarden vault
- machine-local vault unlock material provisioned explicitly for that host

## OAuth

Use `docs/OAUTH-SETUP.md` for OAuth connection setup details. That doc is the shared reference for Graph, Azure DevOps, and GitHub OAuth requirements.
