# Teams Sense Operator Scripts

This folder contains Azure/App Service helper scripts for the Teams sense.

They are operator utilities, not the main day-to-day runtime path. The primary runtime docs for the harness are:

- `README.md`
- `ARCHITECTURE.md`
- `docs/OAUTH-SETUP.md`

## What Is Here

- `deploy-azure.sh`
  Provisions or updates the App Service deployment shell around a Teams bot.
- `set-app-secrets.sh`
  Pushes a reduced `secrets.json` payload into the `OUROBOROS_SECRETS` app setting.
- `startup.sh`
  Startup script used by the App Service deployment path.
- `self-restart.sh`
  Local rebuild/restart helper for Teams-sense iteration.

## Important Truths

- These scripts are currently written for the `ouroboros` Teams deployment path.
- They depend on Azure CLI and manual operator inputs.
- They are not the same thing as `ouro up`.
- Review the script bodies before using them in a fresh environment.

## Secrets Shape

The deployment path still expects the real source of truth locally to be:

`~/.agentsecrets/<agent>/secrets.json`

`set-app-secrets.sh` extracts a deployment-sized subset from that file and writes it into the App Service app settings.

## OAuth

Use `docs/OAUTH-SETUP.md` for OAuth connection setup details. That doc is the shared reference for Graph, Azure DevOps, and GitHub OAuth requirements.
