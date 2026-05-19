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

# Lifecycle policy — keep last 10 tagged images, delete untagged older 7 days.
# Защищает от unbounded storage cost (Container Registry billed по GB-month).
# TODO (prod): enable vulnerability scanner via console UI (Q2 2026 — нет TF
# resource yet, see github.com/yandex-cloud/terraform-provider-yandex issue).
resource "yandex_container_repository_lifecycle_policy" "backend_retention" {
  name          = "backend-keep-last-10"
  status        = "active"
  repository_id = yandex_container_repository.backend.id

  rule {
    description  = "Keep last 10 tagged images (any tag pattern), delete older"
    untagged     = false
    tag_regexp   = ".*"
    retained_top = 10
  }

  rule {
    description   = "Delete untagged > 7 days"
    untagged      = true
    expire_period = "168h" # 7 days
  }
}

# Runtime SA нуждается container-registry.images.puller роль для pull image
# при container revision deploy
resource "yandex_container_registry_iam_binding" "runtime_puller" {
  registry_id = yandex_container_registry.sepshn_cr.id
  role        = "container-registry.images.puller"
  members     = ["serviceAccount:${yandex_iam_service_account.sochi_backend_runtime.id}"]
}
