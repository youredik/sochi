# =============================================================================
# Resource Manager — folders
# =============================================================================
#
# `infra` folder создан manually (renamed from auto-created `default` 2026-05-19).
# `demo` folder создан manually (через yc CLI 2026-05-19, до перехода к IaC).
# Импортируем для tofu-управляемости.
#
# Future: env folders (staging, prod) — создаются через tofu после первого deploy.

resource "yandex_resourcemanager_folder" "infra" {
  cloud_id    = var.yc_cloud_id
  name        = "infra"
  description = "Shared infra: DNS zone, Container Registry, KMS, Lockbox, Audit Trails, VPC sepshn-vpc"

  labels = {
    managed_by  = "opentofu"
    environment = "shared"
  }
}

resource "yandex_resourcemanager_folder" "demo" {
  cloud_id    = var.yc_cloud_id
  name        = "demo"
  description = "Track A: always-on demo deployment (Mock adapters, public demo.sepshn.ru)"

  labels = {
    managed_by  = "opentofu"
    environment = "demo"
  }
}
