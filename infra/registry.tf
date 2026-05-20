# =============================================================================
# Container Registry — Docker image storage
# =============================================================================

resource "yandex_container_registry" "sepshn_cr" {
  folder_id = var.infra_folder_id
  name      = "sepshn-cr"

  labels = {
    managed_by = "opentofu"
  }
}

# ---------------------------------------------------------------------------
# Repositories (logical namespaces within the registry)
# ---------------------------------------------------------------------------
#
# Каноничный pattern Q2 2026: один repository per image type.
# Image URL: `cr.yandex/<registry_id>/<repo_name>:<tag>`
# Example: cr.yandex/crprdhmq3p9f9a5j5ck6/backend:v1.0.0

resource "yandex_container_repository" "backend" {
  name = "${yandex_container_registry.sepshn_cr.id}/backend"
}

# Lifecycle policy — stankoff-v2 production canon (Apr-May 2026, tightened
# from 10/720h на 2026-04-24 после cost audit). Settings:
#
#   - Tagged: keep 5 newest + 7-day expire — matches 4-5 deploys/day cadence
#     с 1-2 day rollback window. Beyond 5, anything older 7d is pruned даже
#     if newer than top-5 list (defense against rapid-debug iteration trains
#     like cf4bc2c-* on 2026-05-19 — 9 debug tags shipped in 3 hours).
#   - Untagged: 48h prune — sha256-only refs (artifacts от docker buildx
#     provenance / multi-arch manifest stubs) are short-lived debug artifacts.
#
# Defense against unbounded storage cost (cr.yandex billed per GB-month).
# Policy runs nightly via YC scheduler — declarative canon (no imperative
# `yc image delete` loops, which safety classifier blocks anyway).
#
# TODO (prod): enable vulnerability scanner via console UI (Q2 2026 — нет TF
# resource yet, see github.com/yandex-cloud/terraform-provider-yandex issue).
resource "yandex_container_repository_lifecycle_policy" "backend_retention" {
  name          = "backend-stankoff-canon"
  status        = "active"
  repository_id = yandex_container_repository.backend.id

  rule {
    description   = "Keep 5 newest tagged + prune older 7d"
    untagged      = false
    tag_regexp    = ".*"
    retained_top  = 5
    expire_period = "168h" # 7 days
  }

  rule {
    description   = "Prune untagged (sha256-only stubs) > 48h"
    untagged      = true
    expire_period = "48h"
  }
}

# Runtime SA нуждается container-registry.images.puller роль для pull image
# при container revision deploy
resource "yandex_container_registry_iam_binding" "runtime_puller" {
  registry_id = yandex_container_registry.sepshn_cr.id
  role        = "container-registry.images.puller"
  members     = ["serviceAccount:${yandex_iam_service_account.sochi_backend_runtime.id}"]
}
