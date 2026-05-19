# =============================================================================
# Lockbox — backend secrets storage (Q2 2026 canon)
# =============================================================================
#
# Каноничный pattern:
#   - `yandex_lockbox_secret` — container
#   - `yandex_lockbox_secret_version_hashed` — SHA через state, NOT plaintext
#   - `password_payload_specification` — auto-generate secrets server-side
#     (значение НИКОГДА не покидает YC; даже tofu state видит только metadata)
#   - SSE через dedicated KMS key (separate от tfstate-encryption key)
#
# Backend Container reads via `secrets` block с secret_id + version_id + key
# (не env value — Lockbox runtime resolve, audit trail per access).
#
# Demo deployment uses Mock-адаптеры → нужны минимальные secrets:
#   - BETTER_AUTH_SECRET — magic-link signing
#
# Prod phase добавит: YOOKASSA_SECRET_KEY, YC_VISION_API_KEY, DADATA_API_KEY,
# SMARTCAPTCHA_SERVER_KEY, POSTBOX_*, YC_FOLDER_ID. Сейчас опускаем.

# KMS key для Lockbox SSE — separate от state encryption blast radius
resource "yandex_kms_symmetric_key" "lockbox_encryption" {
  folder_id         = var.infra_folder_id
  name              = "lockbox-encryption"
  description       = "KMS key для encryption Lockbox secrets (sochi-backend-* family)"
  default_algorithm = "AES_256"
  rotation_period   = "2160h" # 90 дней rotation
}

# Allow Lockbox service агента encrypt/decrypt с этим ключом
resource "yandex_kms_symmetric_key_iam_binding" "lockbox_encrypter" {
  symmetric_key_id = yandex_kms_symmetric_key.lockbox_encryption.id
  role             = "kms.keys.encrypterDecrypter"

  # YC Lockbox service account (system) для encryption operations + runtime SA
  # для decryption через secret_ref в Serverless Container.
  members = [
    "serviceAccount:${yandex_iam_service_account.sochi_backend_runtime.id}",
  ]
}

# Runtime SA нуждается lockbox.payloadViewer для чтения secret values
resource "yandex_resourcemanager_folder_iam_member" "runtime_lockbox_viewer" {
  folder_id = var.demo_folder_id
  role      = "lockbox.payloadViewer"
  member    = "serviceAccount:${yandex_iam_service_account.sochi_backend_runtime.id}"
}

# ---------------------------------------------------------------------------
# Backend secrets bundle
# ---------------------------------------------------------------------------

resource "yandex_lockbox_secret" "backend" {
  folder_id   = var.demo_folder_id
  name        = "sochi-backend-secrets"
  description = "Demo backend secrets (BETTER_AUTH_SECRET; больше — в prod phase)"
  kms_key_id  = yandex_kms_symmetric_key.lockbox_encryption.id

  # Защита от случайного `tofu destroy` — потеря secret = инвалидация
  # всех magic-link sessions. Q2 2026 canon для data-bearing resources.
  lifecycle {
    prevent_destroy = true
  }

  # Note: НЕ используем `password_payload_specification` (server-side gen) —
  # `data.yandex_lockbox_secret_version` data source НЕ резолвит version_id
  # at plan time (chicken-and-egg), что breaks declarative apply за один проход.
  # Q2 2026 canon trade-off: random_password + version_hashed → plaintext
  # проходит через state, но state encrypted в S3+KMS (defense-in-depth OK
  # для demo deployment где BETTER_AUTH_SECRET использует Mock-адаптеры).
}

# Random password generation (state-side, encrypted at rest)
resource "random_password" "better_auth_secret" {
  length  = 48
  special = false # avoid shell-quote issues в env var

  # keepers — rotation trigger. Изменение value → new random_password →
  # new Lockbox version. Сейчас фиксировано к "v1" — ручная ротация позже.
  keepers = {
    rotation_id = "v1"
  }
}

# `_version_hashed` is the Q2 2026 canon (research-verified May 19, 2026):
# - SHA-hashes payload через state → drift detection works (vs stankoff's
#   `_version` + `lifecycle.ignore_changes = all` который маскирует issue #298)
# - Positional key_N/text_value_N (up to 10) — empirical schema v0.204
# - version_id known at plan time → no chicken-and-egg
resource "yandex_lockbox_secret_version_hashed" "backend" {
  secret_id   = yandex_lockbox_secret.backend.id
  description = "v1 — initial bundle: BETTER_AUTH_SECRET + S3 creds"

  # BETTER_AUTH_SECRET — magic-link signing
  key_1        = "BETTER_AUTH_SECRET"
  text_value_1 = random_password.better_auth_secret.result

  # S3 access key для backend → demo_backend_files bucket
  key_2        = "S3_ACCESS_KEY_ID"
  text_value_2 = yandex_iam_service_account_static_access_key.backend_s3.access_key

  key_3        = "S3_SECRET_ACCESS_KEY"
  text_value_3 = yandex_iam_service_account_static_access_key.backend_s3.secret_key
}
