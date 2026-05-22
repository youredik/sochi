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
