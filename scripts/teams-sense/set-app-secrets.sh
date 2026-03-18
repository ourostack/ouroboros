#!/usr/bin/env bash
set -euo pipefail

# Build a minimal secrets.json from local config and push it to the App Service.
# Only includes: provider config, teams config, and oauth connection names.
# The startup.sh script writes this to disk before the bot starts.
#
# Required env vars (or edit defaults below):
#   AZURE_SUBSCRIPTION, AZURE_RG, AZURE_APP_NAME
#   TEAMS_CLIENT_ID, TEAMS_TENANT_ID
#   Optional: TEAMS_CLIENT_SECRET (for client-secret auth), TEAMS_MI_CLIENT_ID (for managed identity)
#
# Usage: bash scripts/teams-sense/set-app-secrets.sh

SUB="${AZURE_SUBSCRIPTION:?Set AZURE_SUBSCRIPTION}"
RG="${AZURE_RG:?Set AZURE_RG}"
APP_NAME="${AZURE_APP_NAME:-ouroboros-bot}"
SECRETS_FILE="${SECRETS_FILE:-$HOME/.agentsecrets/ouroboros/secrets.json}"

TEAMS_CLIENT_ID="${TEAMS_CLIENT_ID:?Set TEAMS_CLIENT_ID}"
TEAMS_TENANT_ID="${TEAMS_TENANT_ID:?Set TEAMS_TENANT_ID}"
TEAMS_CLIENT_SECRET="${TEAMS_CLIENT_SECRET:-}"
TEAMS_MI_CLIENT_ID="${TEAMS_MI_CLIENT_ID:-}"

if [ ! -f "$SECRETS_FILE" ]; then
  echo "Error: $SECRETS_FILE not found"
  exit 1
fi

echo "==> Building minimal secrets from $SECRETS_FILE"

# Extract only the fields needed for deployed bot
SECRETS_JSON=$(python3 -c "
import json, os, sys
with open('$SECRETS_FILE') as f:
    full = json.load(f)
azure = full.get('providers', {}).get('azure', {})
# Remove apiKey (managed identity is used instead)
azure.pop('apiKey', None)
# Ensure managedIdentityClientId is set for DefaultAzureCredential
if 'managedIdentityClientId' not in azure:
    azure['managedIdentityClientId'] = ''
minimal = {
    'providers': {
        'azure': azure
    },
    'teams': {
        'clientId': '$TEAMS_CLIENT_ID',
        'clientSecret': '$TEAMS_CLIENT_SECRET',
        'tenantId': '$TEAMS_TENANT_ID',
        'managedIdentityClientId': '$TEAMS_MI_CLIENT_ID'
    },
    'oauth': {
        'graphConnectionName': full.get('oauth', {}).get('graphConnectionName', 'graph'),
        'adoConnectionName': full.get('oauth', {}).get('adoConnectionName', 'ado'),
        'githubConnectionName': full.get('oauth', {}).get('githubConnectionName', '')
    },
    'teamsChannel': {
        'skipConfirmation': True,
        'port': 3978
    }
}
print(json.dumps(minimal))
")

echo "==> Setting OUROBOROS_SECRETS app setting"
az webapp config appsettings set \
  --name "$APP_NAME" \
  --resource-group "$RG" \
  --subscription "$SUB" \
  --settings "OUROBOROS_SECRETS=$SECRETS_JSON" \
  --output none

echo "==> Restarting app to pick up new secrets"
az webapp restart \
  --name "$APP_NAME" \
  --resource-group "$RG" \
  --subscription "$SUB"

echo "Done. Deployed secrets (provider + teams + oauth connections only)."
