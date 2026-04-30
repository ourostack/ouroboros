#!/usr/bin/env bash
set -euo pipefail

# Deploy Ouroboros to Azure App Service
#
# Architecture:
#   - Harness code comes from npm (@ouro.bot/cli@alpha), installed on startup
#   - Agent bundle is uploaded separately to /home/AgentBundles/ouroboros.ouro/
#   - This script provisions infrastructure and uploads the startup script
#
# Usage: bash scripts/teams-sense/deploy-azure.sh
#
# Required env vars (or edit defaults below):
#   AZURE_SUBSCRIPTION, AZURE_RG, AZURE_LOCATION, APP_NAME, BOT_NAME, MI_NAME

SUB="${AZURE_SUBSCRIPTION:?Set AZURE_SUBSCRIPTION}"
RG="${AZURE_RG:?Set AZURE_RG}"
LOCATION="${AZURE_LOCATION:-westcentralus}"
PLAN_NAME="${AZURE_PLAN_NAME:-ouroboros-plan}"
APP_NAME="${AZURE_APP_NAME:-ouroboros-bot}"
BOT_NAME="${AZURE_BOT_NAME:?Set AZURE_BOT_NAME}"
MI_NAME="${AZURE_MI_NAME:?Set AZURE_MI_NAME}"
NODE_VERSION="22-lts"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "==> Setting subscription"
az account set --subscription "$SUB"

echo "==> Creating App Service Plan (S1, Linux)"
az appservice plan create \
  --name "$PLAN_NAME" \
  --resource-group "$RG" \
  --location "$LOCATION" \
  --sku S1 \
  --is-linux

echo "==> Creating Web App (Node $NODE_VERSION)"
az webapp create \
  --name "$APP_NAME" \
  --resource-group "$RG" \
  --plan "$PLAN_NAME" \
  --runtime "NODE|$NODE_VERSION"

echo "==> Attaching managed identity"
MI_ID=$(az identity show --name "$MI_NAME" --resource-group "$RG" --query 'id' -o tsv)
az webapp identity assign \
  --name "$APP_NAME" \
  --resource-group "$RG" \
  --identities "$MI_ID"

echo "==> Uploading startup script to /home/startup.sh"
az webapp deploy \
  --name "$APP_NAME" \
  --resource-group "$RG" \
  --src-path "$SCRIPT_DIR/startup.sh" \
  --target-path /home/startup.sh \
  --type static

echo "==> Configuring startup command"
az webapp config set \
  --name "$APP_NAME" \
  --resource-group "$RG" \
  --startup-file "bash /home/startup.sh"

echo "==> Enabling always-on"
az webapp config set \
  --name "$APP_NAME" \
  --resource-group "$RG" \
  --always-on true

echo "==> Updating bot messaging endpoint"
az bot update \
  --name "$BOT_NAME" \
  --resource-group "$RG" \
  --endpoint "https://${APP_NAME}.azurewebsites.net/api/messages"

echo ""
echo "Done! Infrastructure provisioned."
echo "Messaging endpoint: https://${APP_NAME}.azurewebsites.net/api/messages"
echo ""
echo "Remaining steps:"
echo "  1. Upload agent bundle to /home/AgentBundles/ouroboros.ouro/"
echo "  2. Set secrets: bash scripts/teams-sense/set-app-secrets.sh"
echo "  3. Restart the app: az webapp restart --name $APP_NAME --resource-group $RG"
echo "  4. Upload manifest zip to Teams Admin Center"
echo "  5. Message @Ouroboros in Teams"
