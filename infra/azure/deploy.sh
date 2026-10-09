#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RG_NAME="${AZURE_RESOURCE_GROUP:-art-explorer-prod-rg}"
LOCATION="${AZURE_LOCATION:-westus3}"
MODE="${1:-preview}"

if [[ "$MODE" != "preview" && "$MODE" != "apply" ]]; then
  echo "Usage: bash infra/azure/deploy.sh [preview|apply]" >&2
  exit 1
fi

: "${AZURE_SUBSCRIPTION_ID:?Set AZURE_SUBSCRIPTION_ID to the intended subscription.}"
: "${PG_ADMIN_PASSWORD:?Set PG_ADMIN_PASSWORD to a strong password; reuse it on redeploy.}"

for tool in az node; do
  command -v "$tool" >/dev/null || { echo "Missing required tool: $tool" >&2; exit 1; }
done

CURRENT_SUB="$(az account show --subscription "$AZURE_SUBSCRIPTION_ID" --query id -o tsv)"
if [[ "$CURRENT_SUB" != "$AZURE_SUBSCRIPTION_ID" ]]; then
  echo "Active Azure subscription does not match AZURE_SUBSCRIPTION_ID." >&2
  exit 1
fi
if [[ "$RG_NAME" == "art-guide"* ]]; then
  echo "Refusing to target Art Guide's resource group." >&2
  exit 1
fi

# Keep the password out of command arguments and repository files.
PARAM_FILE="$(mktemp)"
chmod 600 "$PARAM_FILE"
trap 'rm -f "$PARAM_FILE"' EXIT
export LOCATION
node - "$SCRIPT_DIR/parameters.prod.json" "$PARAM_FILE" <<'NODE'
const fs = require("fs");
const [source, target] = process.argv.slice(2);
const params = JSON.parse(fs.readFileSync(source, "utf8"));
params.parameters.location = { value: process.env.LOCATION };
params.parameters.pgAdminPassword = { value: process.env.PG_ADMIN_PASSWORD };
fs.writeFileSync(target, JSON.stringify(params));
NODE

az bicep build --file "$SCRIPT_DIR/main.bicep" --stdout >/dev/null

if [[ "$(az group exists --subscription "$AZURE_SUBSCRIPTION_ID" --name "$RG_NAME" -o tsv)" != "true" ]]; then
  if [[ "$MODE" == "preview" ]]; then
    echo "Resource group does not exist. Template compilation succeeded."
    echo "Apply will create $RG_NAME in $LOCATION, then show the resource what-if."
    exit 0
  fi
  az group create --subscription "$AZURE_SUBSCRIPTION_ID" --name "$RG_NAME" --location "$LOCATION" \
    --tags project=art-explorer managedBy=bicep --output none
fi

DEPLOY_APP=false
APP_IMAGE="${AZURE_APP_IMAGE:-}"
if [[ -n "$APP_IMAGE" ]]; then
  if [[ "$APP_IMAGE" == *"artguide"* || "$APP_IMAGE" == *"art-guide"* || "$APP_IMAGE" == *"helloworld"* ]]; then
    echo "Refusing an Art Guide or placeholder image; provide an Art Explorer image." >&2
    exit 1
  fi
  DEPLOY_APP=true
fi

az deployment group what-if \
  --subscription "$AZURE_SUBSCRIPTION_ID" \
  --resource-group "$RG_NAME" \
  --template-file "$SCRIPT_DIR/main.bicep" \
  --parameters "$PARAM_FILE" \
  --parameters deployApp="$DEPLOY_APP" appImage="$APP_IMAGE" \
    restoreClientIp="${RESTORE_CLIENT_IP:-}"

if [[ "$MODE" == "preview" ]]; then
  exit 0
fi

az deployment group create \
  --subscription "$AZURE_SUBSCRIPTION_ID" \
  --resource-group "$RG_NAME" \
  --template-file "$SCRIPT_DIR/main.bicep" \
  --parameters "$PARAM_FILE" \
  --parameters deployApp="$DEPLOY_APP" appImage="$APP_IMAGE" \
    restoreClientIp="${RESTORE_CLIENT_IP:-}" \
  --query properties.outputs --output json
