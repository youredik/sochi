# =============================================================================
# Object Storage — buckets для static SPA + media
# =============================================================================

# Static SPA frontend bucket (served via API Gateway object_storage integration
# OR via direct public ACL — production: API Gateway path, demo: direct OK)
resource "yandex_storage_bucket" "demo_frontend" {
  bucket    = "sepshn-demo-frontend"
  folder_id = var.demo_folder_id

  # SPA assets are public — index.html, JS bundles, CSS
  anonymous_access_flags {
    read = true
  }

  # SPA fallback: index.html для всех client-routed paths
  website {
    index_document = "index.html"
    error_document = "index.html"
  }
}
