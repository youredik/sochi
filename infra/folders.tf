# =============================================================================
# Resource Manager — folders (canon Q2 2026, stankoff-aligned 2-folder structure)
# =============================================================================
#
# `infra` folder — shared infra: DNS zone, Container Registry, KMS, Lockbox
#   secret + version, Audit Trails. Created manually 2026-05-20 в новом cloud
#   (one-time bootstrap via console UI), import'ится TF для канон lifecycle.
#
# `demo` folder — Track A always-on demo (Mock adapters, public demo.sepshn.ru):
#   Serverless Container, runtime SA, S3 buckets (frontend + backend-files),
#   YDB serverless, API Gateway. Создаётся через TF (полная IaC ownership).
#
# Future folders (staging, prod) — следующие environments. Тот же pattern:
# создаются через TF.

resource "yandex_resourcemanager_folder" "infra" {
  cloud_id    = var.yc_cloud_id
  name        = "infra"
  description = "Shared infra: DNS zone, Container Registry, KMS, Lockbox"

  labels = {
    managed_by  = "opentofu"
    environment = "shared"
  }
}

resource "yandex_resourcemanager_folder" "demo" {
  cloud_id    = var.yc_cloud_id
  name        = "demo"
  description = "Track A always-on demo (Mock adapters, public demo.sepshn.ru)"

  labels = {
    managed_by  = "opentofu"
    environment = "demo"
  }
}
