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
