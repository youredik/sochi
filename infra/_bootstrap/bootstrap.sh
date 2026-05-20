#!/usr/bin/env bash
# =============================================================================
# OpenTofu state-backend bootstrap (one-time chicken-and-egg)
# =============================================================================
#
# Этот скрипт создаёт минимальный набор ресурсов для S3+KMS state backend
# OpenTofu. После его выполнения ВСЁ остальное управляется через `.tf` файлы
# в `infra/`. Скрипт НЕ повторяемый — если ресурсы уже существуют, команды
# падают; это by-design (один раз навсегда).
#
# Canon Q2 2026 (verified empirically 2026-05-19):
#   - YC Object Storage S3-compatible backend ([yandex.cloud/docs/tutorials/infrastructure-management/terraform-state-storage])
#   - `use_lockfile = true` (S3 native conditional PUT — OpenTofu 1.10+ /
#     Terraform 1.11+). НЕ YDB Document table — устаревший pattern.
#   - SSE-KMS encryption (defense-in-depth, state file содержит sensitive
#     данные: IAM access keys в outputs, lockbox secret ids, и т.д.)
#   - Bucket versioning (recovery от accidental `tofu destroy`)
#
# Bootstrap-only resources (НЕ управляются через OpenTofu):
#   - tf-bot SA + static access key (auth для backend itself)
#   - State bucket `sepshn-tfstate` (backend storage)
#   - KMS key `tfstate-encryption` (SSE-KMS)
#
# Run prerequisites:
#   - yc CLI installed (1.0.0+)
#   - yc profile activated с cloud-level admin role (для folder/SA/KMS create)
#   - Cloud `sepshn` и folder `infra` существуют
#
# Usage: ./bootstrap.sh
# =============================================================================

set -euo pipefail

# Config (hardcoded — single-cloud bootstrap)
# Updated 2026-05-20: migration к new cloud (Сэпшн org) после удаления старого
# (youredik org). Original cloud b1g444ngoknombq45l4t / folder b1g6abh503j0dvitdccg
# deleted via console UI. Bucket name `sepshn-tfstate` глобально занято старым
# (S3 namespace global) — используем `-v2` suffix.
CLOUD_ID="b1gisf466novulsg0a0n"
INFRA_FOLDER_ID="b1gp4bo808jr6qvrnltu"
SA_NAME="tf-bot"
SA_DESCRIPTION="OpenTofu state-backend + IaC bootstrap operator (Q2 2026 canon)"
KMS_KEY_NAME="tfstate-encryption"
KMS_KEY_DESCRIPTION="KMS key для SSE-KMS state bucket sepshn-tfstate-v2"
BUCKET_NAME="sepshn-tfstate-v2"
KEYS_DIR="${HOME}/.yc-keys"
ACCESS_KEY_FILE="${KEYS_DIR}/tf-bot-s3-access.json"

echo "▶ Step 1/6: Create tf-bot SA (${SA_NAME}) в folder ${INFRA_FOLDER_ID}"
yc iam service-account create \
  --name "${SA_NAME}" \
  --description "${SA_DESCRIPTION}" \
  --folder-id "${INFRA_FOLDER_ID}"

SA_ID=$(yc iam service-account get --name "${SA_NAME}" --folder-id "${INFRA_FOLDER_ID}" --format json | python3 -c "import sys, json; print(json.load(sys.stdin)['id'])")
echo "  SA id: ${SA_ID}"

echo "▶ Step 2/6: Grant storage.editor на folder infra"
yc resource-manager folder add-access-binding "${INFRA_FOLDER_ID}" \
  --role storage.editor \
  --service-account-id "${SA_ID}"

echo "▶ Step 3/6: Create KMS symmetric key (${KMS_KEY_NAME})"
yc kms symmetric-key create \
  --name "${KMS_KEY_NAME}" \
  --description "${KMS_KEY_DESCRIPTION}" \
  --default-algorithm AES_256 \
  --rotation-period 2160h \
  --folder-id "${INFRA_FOLDER_ID}"

KMS_KEY_ID=$(yc kms symmetric-key get --name "${KMS_KEY_NAME}" --folder-id "${INFRA_FOLDER_ID}" --format json | python3 -c "import sys, json; print(json.load(sys.stdin)['id'])")
echo "  KMS key id: ${KMS_KEY_ID}"

echo "▶ Step 4/6: Grant kms.keys.encrypterDecrypter на KMS key"
yc kms symmetric-key add-access-binding "${KMS_KEY_ID}" \
  --role kms.keys.encrypterDecrypter \
  --service-account-id "${SA_ID}"

echo "▶ Step 5/6: Create static access key (S3 backend auth)"
mkdir -p "${KEYS_DIR}" && chmod 700 "${KEYS_DIR}"
yc iam access-key create \
  --service-account-id "${SA_ID}" \
  --description "S3 access key для OpenTofu backend (tf-bot)" \
  --format json > "${ACCESS_KEY_FILE}"
chmod 600 "${ACCESS_KEY_FILE}"
echo "  Saved к ${ACCESS_KEY_FILE} (chmod 600)"

ACCESS_KEY_ID=$(python3 -c "import json; print(json.load(open('${ACCESS_KEY_FILE}'))['access_key']['key_id'])")
SECRET_KEY=$(python3 -c "import json; print(json.load(open('${ACCESS_KEY_FILE}'))['secret'])")

echo "▶ Step 6/6: Create state bucket ${BUCKET_NAME} + versioning + SSE-KMS"
export AWS_ACCESS_KEY_ID="${ACCESS_KEY_ID}"
export AWS_SECRET_ACCESS_KEY="${SECRET_KEY}"
yc storage bucket create \
  --name "${BUCKET_NAME}" \
  --folder-id "${INFRA_FOLDER_ID}" \
  --default-storage-class standard \
  --max-size 1073741824

yc storage bucket update "${BUCKET_NAME}" \
  --folder-id "${INFRA_FOLDER_ID}" \
  --versioning versioning-enabled

yc storage bucket update "${BUCKET_NAME}" \
  --folder-id "${INFRA_FOLDER_ID}" \
  --encryption key-id="${KMS_KEY_ID}"

echo ""
echo "✓ Bootstrap complete. Next steps:"
echo "  1. Export auth env vars (см. infra/_bootstrap/env.sh):"
echo "       export AWS_ACCESS_KEY_ID=${ACCESS_KEY_ID}"
echo "       export AWS_SECRET_ACCESS_KEY=<see ${ACCESS_KEY_FILE}>"
echo "       export YC_TOKEN=\$(yc iam create-token)"
echo "  2. cd infra && tofu init && tofu plan"
echo ""
echo "Resource IDs (record для ${BUCKET_NAME}/init.tfvars):"
echo "  cloud_id          = ${CLOUD_ID}"
echo "  infra_folder_id   = ${INFRA_FOLDER_ID}"
echo "  tf_bot_sa_id      = ${SA_ID}"
echo "  tf_state_kms_id   = ${KMS_KEY_ID}"
echo "  tf_state_bucket   = ${BUCKET_NAME}"
