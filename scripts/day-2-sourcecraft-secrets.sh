#!/usr/bin/env bash
# =============================================================================
# Day 2 — SourceCraft CI secrets bootstrap (canon Q2 2026, stankoff-aligned)
# =============================================================================
#
# Stankoff canon (per docs/plans/sourcecraft-migration.md:225-229): 30-минутный
# manual UI seeding step (Phase 0.4/0.5). No public CLI / API for SourceCraft
# secrets — UI-only confirmed empirically 2026-05-20.
#
# This script PRINTS the yc/tofu commands you run locally к extract each
# secret value. It deliberately DOES NOT print values into the shell history.
# Each command reads ONE value к stdout — copy-paste прямо в SourceCraft UI.
#
# Usage:
#   bash scripts/day-2-sourcecraft-secrets.sh    # prints commands к screen
#
# Pre-req:
#   - `yc` CLI authenticated к sepshn cloud
#   - tofu state accessible (tf-bot S3 creds в ~/.yc-keys/)
#   - Browser open: https://sourcecraft.dev/sepshn/sepshn/-/settings/secrets
# =============================================================================

cat <<'SETUP'
==============================================================================
SourceCraft CI bootstrap — 2 phases
==============================================================================

Phase 1 (manual UI, ~5 min):
  https://sourcecraft.dev/sepshn/sepshn/-/settings/service-connections
  → New service connection → name=`deploy-connection`
  → Type: Yandex Cloud OIDC
  → Scope: this repo + branch=main
  → Folder ID: b1gcqa89an0n32mqpuvo (demo folder)
  → Service Account: <run command #5 below for ID>

Phase 2 (~10 min):
  https://sourcecraft.dev/sepshn/sepshn/-/settings/secrets
  → New secret × 12 (one per command below)
  → Run each command locally, paste output as value, name as shown.

==============================================================================
Static values (no command needed — paste literally):
==============================================================================

  REGISTRY                   = cr.yandex/crprdhmq3p9f9a5j5ck6
  YC_CONTAINER_NAME          = sochi-backend-demo
  YC_DEMO_FOLDER_ID          = b1gcqa89an0n32mqpuvo
  S3_BACKEND_FILES_BUCKET    = sepshn-demo-backend-files
  FRONTEND_S3_BUCKET         = sepshn-demo-frontend

==============================================================================
Dynamic values — run command, copy output к SourceCraft secret of same name:
==============================================================================

# tf-bot creds setup (one-time)
export AWS_ACCESS_KEY_ID=$(python3 -c "import json; print(json.load(open('/Users/ed/.yc-keys/tf-bot-s3-access.json'))['access_key']['key_id'])")
export AWS_SECRET_ACCESS_KEY=$(python3 -c "import json; print(json.load(open('/Users/ed/.yc-keys/tf-bot-s3-access.json'))['secret'])")
export YC_TOKEN="$(yc iam create-token)"
cd infra

# 1. YC_RUNTIME_SA_ID
tofu state show yandex_iam_service_account.sochi_backend_runtime | grep '^[[:space:]]*id ' | awk -F'"' '{print $2}'

# 2. YC_LOCKBOX_SECRET_ID
tofu state show yandex_lockbox_secret.backend | grep '^[[:space:]]*id ' | awk -F'"' '{print $2}'

# 3. YC_LOCKBOX_VERSION_ID
tofu state show yandex_lockbox_secret_version_hashed.backend | grep '^[[:space:]]*id ' | awk -F'"' '{print $2}'

# 4. YDB_CONNECTION_STRING
tofu state show yandex_ydb_database_serverless.demo | grep ydb_full_endpoint | awk -F'"' '{print $2}'

# 5. FRONTEND_S3_ACCESS_KEY_ID  (also use this SA для service-connection in Phase 1)
tofu state pull | python3 -c "
import json, sys
for r in json.load(sys.stdin).get('resources', []):
    if r['type'] == 'yandex_iam_service_account_static_access_key' and r['name'] == 'backend_s3':
        print(r['instances'][0]['attributes']['access_key'])
"

# 6. FRONTEND_S3_SECRET_ACCESS_KEY  ⚠️ sensitive — paste, не commit
tofu state pull | python3 -c "
import json, sys
for r in json.load(sys.stdin).get('resources', []):
    if r['type'] == 'yandex_iam_service_account_static_access_key' and r['name'] == 'backend_s3':
        print(r['instances'][0]['attributes']['secret_key'])
"

# 7. TF_BOT_S3_ACCESS_KEY_ID
python3 -c "import json; print(json.load(open('/Users/ed/.yc-keys/tf-bot-s3-access.json'))['access_key']['key_id'])"

# 8. TF_BOT_S3_SECRET_ACCESS_KEY  ⚠️ sensitive
python3 -c "import json; print(json.load(open('/Users/ed/.yc-keys/tf-bot-s3-access.json'))['secret'])"

==============================================================================
Phase 3 (commit + verify, ~2 min):
==============================================================================

  cd /Users/ed/dev/sochi
  git mv .sourcecraft/ci.yaml.draft .sourcecraft/ci.yaml
  git commit -m "feat(ci): activate SourceCraft workflows — secrets seeded"
  git push origin main
  # Watch first run: https://sourcecraft.dev/sepshn/sepshn/-/pipelines

==============================================================================
SETUP
