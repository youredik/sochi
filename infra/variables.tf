# =============================================================================
# Sepshn IaC — variables
# =============================================================================

variable "yc_cloud_id" {
  description = "Yandex Cloud ID (cloud 'sepshn')"
  type        = string
}

variable "yc_organization_id" {
  description = "YC organization ID. Discover via `yc organization-manager organization list`."
  type        = string
}

# DEPRECATED 2026-05-20: folders теперь managed via folders.tf TF resources.
# All references use `yandex_resourcemanager_folder.{infra,demo}.id` directly.
# Vars retained for compat (terraform.tfvars references) — can drop в future cleanup.
variable "infra_folder_id" {
  description = "DEPRECATED — see folders.tf. Retained для terraform.tfvars compat."
  type        = string
  default     = ""
}

variable "demo_folder_id" {
  description = "DEPRECATED — see folders.tf. Retained для terraform.tfvars compat."
  type        = string
  default     = ""
}

# Bootstrap service accounts — claude (owner-created, admin) + tf-bot (state backend)
variable "bootstrap_claude_sa_id" {
  description = "Bootstrap admin SA (`claude`) — created manually via console during cloud bootstrap. Used для CI/manual image push to Container Registry."
  type        = string
}

variable "domain" {
  description = "Apex domain (sepshn.ru)"
  type        = string
  default     = "sepshn.ru"
}

variable "demo_subdomain" {
  description = "Subdomain где живёт demo (demo.sepshn.ru per North Star canon)"
  type        = string
  default     = "demo.sepshn.ru"
}

# Bootstrap resources (созданы вне tofu — оstateful references)
variable "tf_state_kms_key_id" {
  description = "KMS key id for state bucket SSE-KMS (created via bootstrap.sh)"
  type        = string
}

variable "tf_state_bucket" {
  description = "State backend bucket name (created via bootstrap.sh)"
  type        = string
  default     = "sepshn-tfstate"
}

variable "tf_bot_sa_id" {
  description = "tf-bot service account id (created via bootstrap.sh, owns state)"
  type        = string
}

# ---------------------------------------------------------------------------
# SmartCaptcha bootstrap — manual one-time после первого `tofu apply`
# ---------------------------------------------------------------------------
# Per Terraform provider issue yandex-cloud/terraform-provider-yandex#492
# server_key not exposed via TF output. Workflow:
#   1. `tofu apply` (first time) → создаёт captcha resource (см. smartcaptcha.tf)
#   2. Operator: `yc smartcaptcha captcha get-secret-key <captcha-id>` →
#      `ysc2_...` server-key
#   3. Operator: `yc lockbox secret create --name sepshn-smartcaptcha-server-key
#      --folder-id <demo-folder-id> --payload [...]`
#   4. Operator: `yc lockbox secret list-versions <secret-id>` → version-id
#   5. Update tfvars: smartcaptcha_lockbox_secret_id + _version_id
#   6. `tofu apply` второй раз → container mounts SMARTCAPTCHA_SERVER_KEY
# Подробности — bootstrap.md.

variable "smartcaptcha_lockbox_secret_id" {
  description = "Lockbox secret ID containing SMARTCAPTCHA_SERVER_KEY (bootstrap'нут manually post первого apply, см. bootstrap.md шаг 2)"
  type        = string
  default     = ""
}

variable "smartcaptcha_lockbox_version_id" {
  description = "Lockbox version ID для SMARTCAPTCHA_SERVER_KEY entry. Обновлять при rotation server-key."
  type        = string
  default     = ""
}

# ---------------------------------------------------------------------------
# Postbox Phase 2 — declared заранее чтобы `mv postbox.tf.skeleton postbox.tf`
# не упал с «Reference to undeclared variable». Bootstrap: см. bootstrap.md
# шаги 2.1-2.4 (DKIM keypair + Lockbox + tfvars).
# ---------------------------------------------------------------------------

variable "lockbox_postbox_dkim_secret_id" {
  description = "Lockbox secret ID containing POSTBOX_DKIM_PRIVATE_KEY (RSA 2048 PEM). Bootstrap one-time via openssl + yc lockbox secret create — см. bootstrap.md шаг 2.2."
  type        = string
  default     = ""
}

variable "postbox_dkim_public_key" {
  description = "Public DKIM key (base64, no PEM headers) для DNS TXT record. Generated from postbox_dkim private key — см. bootstrap.md шаг 2.1."
  type        = string
  default     = ""
}

# ---------------------------------------------------------------------------
# DaData (onboarding find-by-inn) — Phase 2.5 2026-05-22
# ---------------------------------------------------------------------------
# Per `[[reference_dadata_credentials]]` API key хранится в gitignored
# local .env. SmartCaptcha-style bootstrap (mirror canon): secret создаётся
# вне TF через `yc lockbox secret create`, TF принимает IDs через input vars.
# Это гарантирует что value никогда не trip через tofu state.
#
# Без этих IDs backend factory `createDaDataAdapter` deteрминированно
# создаёт mock-импл (см. apps/backend/src/domains/identity/dadata/factory.ts) —
# демо-онбординг работает только для 4 фиктивных ИНН с префиксом `2320`.
# При заполнении IDs backend переключается на live `suggestions.dadata.ru`
# API (free tier 10k req/day).

variable "dadata_lockbox_secret_id" {
  description = "Lockbox secret ID containing DADATA_API_KEY. Bootstrap one-time via `yc lockbox secret create --name sepshn-dadata-api-key --folder-id <infra> --payload '[{\"key\":\"DADATA_API_KEY\",\"text_value\":\"<key>\"}]'`. Empty → backend uses mock-dadata (4 canonical Сочи ИНН only)."
  type        = string
  default     = ""
}

variable "dadata_lockbox_version_id" {
  description = "Lockbox version ID для DADATA_API_KEY entry. Update при rotation."
  type        = string
  default     = ""
}

# Round 7 2026-05-24 — SMOKE_BYPASS_TOKEN Lockbox vars.
#
# Bootstrap (one-time):
#   yc lockbox secret create --name sepshn-smoke-bypass --folder-id <infra> \
#     --payload '[{"key":"SMOKE_BYPASS_TOKEN","text_value":"<openssl rand -hex 24>"}]'
#   yc lockbox secret list-versions <secret-id> → version-id
#   tofu apply with smoke_bypass_lockbox_secret_id + _version_id filled.
#
# Same secret value also stored as SC CI env var `SMOKE_BYPASS_TOKEN` —
# smoke spec reads `process.env.SMOKE_BYPASS_TOKEN` and sends as
# `X-Internal-Smoke-Bypass` header. Container compares timing-safe.
#
# Empty → block in container.tf skipped → bypass disabled (deploy-verify
# playwright-smoke continues failing on captcha, real users unaffected).
variable "smoke_bypass_lockbox_secret_id" {
  description = "Lockbox secret ID containing SMOKE_BYPASS_TOKEN (Round 7 2026-05-24, captcha-gate CI bypass)."
  type        = string
  default     = ""
}

variable "smoke_bypass_lockbox_version_id" {
  description = "Lockbox version ID для SMOKE_BYPASS_TOKEN entry. Update при rotation."
  type        = string
  default     = ""
}
