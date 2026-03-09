#!/usr/bin/env bash
# Bulk-provision all tenant users into an ADO org with Basic access.
# Requires: az cli logged in, jq installed.
# Usage: ./scripts/bulk-provision-ado.sh

set -euo pipefail

ORG="${ADO_ORG:?Set ADO_ORG}"
PROJECT="${ADO_PROJECT:?Set ADO_PROJECT}"

echo "=== Fetching ADO token..."
ADO_TOKEN=$(az account get-access-token --resource 499b84ac-1321-427f-aa17-267ca6975798 --query accessToken -o tsv)

echo "=== Fetching Graph token..."
GRAPH_TOKEN=$(az account get-access-token --resource https://graph.microsoft.com --query accessToken -o tsv)

echo "=== Getting project ID..."
PROJECT_ID=$(curl -s -H "Authorization: Bearer $ADO_TOKEN" \
  "https://dev.azure.com/${ORG}/_apis/projects?api-version=7.1" | \
  jq -r --arg name "$PROJECT" '.value[] | select(.name == $name) | .id')

if [ -z "$PROJECT_ID" ]; then
  echo "ERROR: Could not find project '$PROJECT' in org '$ORG'"
  exit 1
fi
echo "   Project ID: $PROJECT_ID"

echo "=== Listing tenant users from Graph..."
USERS=$(curl -s -H "Authorization: Bearer $GRAPH_TOKEN" \
  "https://graph.microsoft.com/v1.0/users?\$select=id,userPrincipalName,displayName&\$top=999" | \
  jq -c '.value[] | select(.userPrincipalName | test("#EXT#") | not)')

TOTAL=$(echo "$USERS" | wc -l | tr -d ' ')
echo "   Found $TOTAL users"

echo "=== Provisioning users on vsapm.dev.azure.com..."
SUCCESS=0
FAIL=0
SKIP=0

echo "$USERS" | while IFS= read -r user; do
  UPN=$(echo "$user" | jq -r '.userPrincipalName')
  NAME=$(echo "$user" | jq -r '.displayName')

  BODY=$(jq -n \
    --arg upn "$UPN" \
    --arg pid "$PROJECT_ID" \
    '{
      accessLevel: { accountLicenseType: "express", licensingSource: "account" },
      user: { principalName: $upn, subjectKind: "user" },
      projectEntitlements: [{ group: { groupType: "projectContributor" }, projectRef: { id: $pid } }]
    }')

  HTTP_CODE=$(curl -s -o /tmp/ado-provision-result.json -w "%{http_code}" \
    -X POST \
    -H "Authorization: Bearer $ADO_TOKEN" \
    -H "Content-Type: application/json" \
    -d "$BODY" \
    "https://vsapm.dev.azure.com/${ORG}/_apis/memberentitlementmanagement/memberentitlements?api-version=7.1-preview.3")

  if [ "$HTTP_CODE" = "200" ] || [ "$HTTP_CODE" = "201" ]; then
    IS_SUCCESS=$(jq -r '.isSuccess // true' /tmp/ado-provision-result.json 2>/dev/null || echo "true")
    if [ "$IS_SUCCESS" = "true" ]; then
      echo "   ✅ $NAME ($UPN)"
      SUCCESS=$((SUCCESS + 1))
    else
      echo "   ⚠️  $NAME ($UPN) — already exists or rule conflict"
      SKIP=$((SKIP + 1))
    fi
  elif [ "$HTTP_CODE" = "409" ]; then
    echo "   ⏭️  $NAME ($UPN) — already provisioned"
    SKIP=$((SKIP + 1))
  else
    MSG=$(cat /tmp/ado-provision-result.json 2>/dev/null || echo "no response body")
    echo "   ❌ $NAME ($UPN) — HTTP $HTTP_CODE: $MSG"
    FAIL=$((FAIL + 1))
  fi
done

echo ""
echo "=== Done. Success: $SUCCESS, Skipped: $SKIP, Failed: $FAIL"
