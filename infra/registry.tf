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
