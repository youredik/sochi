#!/usr/bin/env bash
# =============================================================================
# Day 2 — SourceCraft CI secrets seeding via API (canon Q2 2026)
# =============================================================================
#
# Programmatic seeding of 12 SourceCraft secrets via REST API. Stankoff canon
# (see memory `reference_sourcecraft_secrets_api.md` — empirically verified
# 2026-04-22 + senior rule re: base64-encoding from 2026-04-29 forget-cost
# episode).
#
# API: PUT https://api.sourcecraft.tech/repos/{org}/{repo}/secrets/{KEY}
#      Body: {"value": "<base64-encoded>"}
#      Auth: Bearer PAT
#
# Usage:
#   export SOURCECRAFT_PAT='your-personal-access-token'  # get from UI:
#     # https://sourcecraft.dev/-/profile/tokens/new
#     # → name=sochi-bootstrap, scope=admin:secrets, expires=24h
#   bash scripts/day-2-sourcecraft-secrets.sh
#
# Note: SSH remote (sochi default) does NOT embed PAT в git URL. PAT must be
# obtained explicitly from UI Profile → Personal Access Tokens (one-time, ~30s).
#
# Idempotent: PUT is upsert (creates OR updates). Safe re-run после rotation.
# =============================================================================

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
INFRA_DIR="$REPO_ROOT/infra"
ORG="sepshn"
REPO="sepshn"
API_BASE="https://api.sourcecraft.tech"

if [[ -z "${SOURCECRAFT_PAT:-}" ]]; then
    cat <<HELP
ERROR: SOURCECRAFT_PAT env var required.

Get a Personal Access Token (one-time, ~30s):
  1. Open https://sourcecraft.dev/-/profile/tokens/new
  2. Name: 'sochi-bootstrap', scope: 'admin:secrets' or 'all', expiry: 24h
  3. Copy generated token

Then:
  export SOURCECRAFT_PAT='paste_pat_here'
  bash scripts/day-2-sourcecraft-secrets.sh
HELP
    exit 1
fi

if [[ ! -f /Users/ed/.yc-keys/tf-bot-s3-access.json ]]; then
    echo "ERROR: tf-bot S3 key not found at ~/.yc-keys/tf-bot-s3-access.json"
    exit 1
fi

# tf-bot creds for tofu state read.
export AWS_ACCESS_KEY_ID=$(python3 -c "import json; print(json.load(open('/Users/ed/.yc-keys/tf-bot-s3-access.json'))['access_key']['key_id'])")
export AWS_SECRET_ACCESS_KEY=$(python3 -c "import json; print(json.load(open('/Users/ed/.yc-keys/tf-bot-s3-access.json'))['secret'])")
export YC_TOKEN="$(yc iam create-token)"

cd "$INFRA_DIR"

echo "[1/3] Pulling tofu state (read-only)..."
STATE_JSON=$(tofu state pull 2>/dev/null)

extract_attr() {
    local type=$1 name=$2 attr=$3
    echo "$STATE_JSON" | python3 -c "
import json, sys
state = json.load(sys.stdin)
for r in state.get('resources', []):
    if r['type'] == '$type' and r['name'] == '$name':
        v = r['instances'][0]['attributes'].get('$attr', '')
        if v: print(v)
        break
"
}

RUNTIME_SA_ID=$(extract_attr yandex_iam_service_account sochi_backend_runtime id)
LOCKBOX_ID=$(extract_attr yandex_lockbox_secret backend id)
LOCKBOX_VERSION_ID=$(extract_attr yandex_lockbox_secret_version_hashed backend id)
YDB_ENDPOINT=$(extract_attr yandex_ydb_database_serverless demo ydb_full_endpoint)
S3_AK=$(extract_attr yandex_iam_service_account_static_access_key backend_s3 access_key)
S3_SK=$(extract_attr yandex_iam_service_account_static_access_key backend_s3 secret_key)

# Validate all critical values present
for var in RUNTIME_SA_ID LOCKBOX_ID LOCKBOX_VERSION_ID YDB_ENDPOINT S3_AK S3_SK; do
    if [[ -z "${!var}" ]]; then
        echo "ERROR: $var empty (tofu state extraction failed)"
        exit 1
    fi
done

echo "[2/3] Seeding 12 secrets via SourceCraft API..."

put_secret() {
    local key=$1 value=$2
    local b64=$(printf "%s" "$value" | base64)
    local response=$(curl -sS -w "\n%{http_code}" -X PUT \
        -H "Authorization: Bearer $SOURCECRAFT_PAT" \
        -H "Content-Type: application/json" \
        "$API_BASE/repos/$ORG/$REPO/secrets/$key" \
        -d "{\"value\":\"$b64\"}")
    local http_code=$(echo "$response" | tail -1)
    local body=$(echo "$response" | sed '$d')
    if [[ "$http_code" =~ ^2 ]]; then
        echo "  ✓ $key"
    else
        echo "  ✗ $key — HTTP $http_code: $body"
        return 1
    fi
}

put_secret YC_CONTAINER_NAME          "sochi-backend-demo"
put_secret YC_DEMO_FOLDER_ID          "b1gcqa89an0n32mqpuvo"
put_secret YC_RUNTIME_SA_ID           "$RUNTIME_SA_ID"
put_secret YC_LOCKBOX_SECRET_ID       "$LOCKBOX_ID"
put_secret YC_LOCKBOX_VERSION_ID      "$LOCKBOX_VERSION_ID"
put_secret YDB_CONNECTION_STRING      "$YDB_ENDPOINT"
put_secret S3_BACKEND_FILES_BUCKET    "sepshn-demo-backend-files"
put_secret FRONTEND_S3_BUCKET         "sepshn-demo-frontend"
put_secret FRONTEND_S3_ACCESS_KEY_ID  "$S3_AK"
put_secret FRONTEND_S3_SECRET_ACCESS_KEY "$S3_SK"
put_secret TF_BOT_S3_ACCESS_KEY_ID    "$AWS_ACCESS_KEY_ID"
put_secret TF_BOT_S3_SECRET_ACCESS_KEY "$AWS_SECRET_ACCESS_KEY"

echo ""
echo "[3/3] Verifying via list endpoint..."
LIST_RESPONSE=$(curl -sS \
    -H "Authorization: Bearer $SOURCECRAFT_PAT" \
    "$API_BASE/repos/$ORG/$REPO/secrets")

EXPECTED_COUNT=12
ACTUAL_COUNT=$(echo "$LIST_RESPONSE" | python3 -c "
import json, sys
try:
    data = json.load(sys.stdin)
    secrets = data.get('secrets', [])
    expected = {
        'YC_CONTAINER_NAME','YC_DEMO_FOLDER_ID','YC_RUNTIME_SA_ID',
        'YC_LOCKBOX_SECRET_ID','YC_LOCKBOX_VERSION_ID','YDB_CONNECTION_STRING',
        'S3_BACKEND_FILES_BUCKET','FRONTEND_S3_BUCKET',
        'FRONTEND_S3_ACCESS_KEY_ID','FRONTEND_S3_SECRET_ACCESS_KEY',
        'TF_BOT_S3_ACCESS_KEY_ID','TF_BOT_S3_SECRET_ACCESS_KEY'
    }
    present = {s['key'] for s in secrets}
    missing = expected - present
    if missing:
        print(f'MISSING: {missing}', file=sys.stderr)
    print(len(expected & present))
except Exception as e:
    print(f'PARSE ERR: {e}', file=sys.stderr)
    print(0)
")

cd "$REPO_ROOT"

if [[ "$ACTUAL_COUNT" -eq "$EXPECTED_COUNT" ]]; then
    echo "  ✓ All 12 secrets verified в API list"
else
    echo "  ⚠ Only $ACTUAL_COUNT/$EXPECTED_COUNT secrets verified"
    exit 1
fi

cat <<DONE

==============================================================================
Done. Next steps:

1. Service Connection (~2 min UI only — no API):
   https://sourcecraft.dev/$ORG/$REPO/-/settings/service-connections
   → New → name=deploy-connection, type=Yandex Cloud OIDC,
     scope=org, folder=b1gcqa89an0n32mqpuvo, SA=$RUNTIME_SA_ID

2. Activate workflows:
   cd $REPO_ROOT
   git mv .sourcecraft/ci.yaml.draft .sourcecraft/ci.yaml
   git commit -m "feat(ci): activate SourceCraft workflows — secrets seeded via API"
   git push origin main

3. Watch first run:
   https://sourcecraft.dev/$ORG/$REPO/-/pipelines
==============================================================================
DONE
