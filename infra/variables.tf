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

variable "infra_folder_id" {
  description = "Infra folder ID (shared resources: DNS zone, Container Registry, KMS, Cert Manager)"
  type        = string
}

variable "demo_folder_id" {
  description = "Demo folder ID (Track A always-on demo: YDB, S3, Serverless Container, API Gateway)"
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
