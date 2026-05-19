# =============================================================================
# Object Storage — buckets для static SPA + backend files
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

# Backend file storage (passport scans, media uploads, etc.) — PRIVATE.
# Even demo (Mock vision) requires bucket existence для backend env startup.
resource "yandex_storage_bucket" "demo_backend_files" {
  bucket    = "sepshn-demo-backend-files"
  folder_id = var.demo_folder_id

  # Private — backend reads/writes via static access key (см. iam.tf)
  default_storage_class = "STANDARD"

  versioning {
    enabled = true
  }
}

# Runtime SA gets storage.editor on backend files bucket
resource "yandex_storage_bucket_iam_binding" "backend_files_runtime" {
  bucket  = yandex_storage_bucket.demo_backend_files.bucket
  role    = "storage.editor"
  members = ["serviceAccount:${yandex_iam_service_account.sochi_backend_runtime.id}"]
}
