# =============================================================================
# Object Storage — buckets для static SPA + backend files
# =============================================================================

# Static SPA frontend bucket (served via API Gateway object_storage integration
# OR via direct public ACL — production: API Gateway path, demo: direct OK)
resource "yandex_storage_bucket" "demo_frontend" {
  bucket    = "sepshn-demo-frontend"
  folder_id = yandex_resourcemanager_folder.demo.id

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
  folder_id = yandex_resourcemanager_folder.demo.id

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

# =============================================================================
# Passport scan photos — SEPARATE bucket for PII isolation + 90-day lifecycle
# =============================================================================
# Sprint B 2026-05-22 — 152-ФЗ ст.21 ч.7 «не дольше необходимого для целей».
# Изоляция от media bucket (versioning enabled там = previous versions persist
# past retention → privacy leak). Этот bucket версионирование ВЫКЛЮЧЕНО.
resource "yandex_storage_bucket" "demo_passport_scans" {
  bucket    = "sepshn-demo-passport-scans"
  folder_id = yandex_resourcemanager_folder.demo.id

  default_storage_class = "STANDARD"

  # Round 2 self-review YDB P0: explicit `acl = "private"` — даже если default
  # это private, explicit signal к operator audit + defends против Terraform
  # state drift где default может shift в future provider versions. 152-ФЗ
  # PII bucket MUST never anonymous-readable.
  acl = "private"

  # Versioning DISABLED — privacy canon. Once deleted, no recoverable copy.
  # 152-ФЗ data minimization: previous versions = retention contract violation.
  versioning {
    enabled = false
  }

  # Native YC bucket lifecycle: 90-day auto-delete без application cron.
  # Per migration 0037 doc + 152-ФЗ ст.21 ч.7 «retention не дольше цели».
  # Tag-based filtering: lifecycle применяется ТОЛЬКО к objects с
  # `retention=90d` metadata — это safety guard если кто-то upload'ит
  # без passport-photo-storage adapter (force-tag invariant).
  lifecycle_rule {
    id      = "passport-90day-expiration"
    enabled = true

    filter {
      tag {
        key   = "retention"
        value = "90d"
      }
    }

    expiration {
      days = 90
    }
  }

  # Sprint C+ post-deploy fix 2026-05-24: removed `abort_incomplete_multipart_upload`
  # block + `server_side_encryption_configuration` block — Yandex provider v0.204.0
  # rejects both («Unsupported block type» and «kms_master_key_id required»).
  # Web research May 2026 expert: Yandex Object Storage SSE only supports `aws:kms`
  # algorithm с customer-managed KMS key (NOT bare AES256 server-side default).
  # Application-level adapter передаёт `ServerSideEncryption: 'AES256'` per-object
  # (passport-photo-storage.ts createYandexS3PassportStorage) — this provides
  # per-object encryption without provider-block; defense-in-depth remains via
  # bucket private ACL + IAM allow-list narrowing. Future: add `aws:kms` block
  # с Yandex KMS key when SSE-KMS budget approved.
}

# Backend runtime SA — storage.editor на passport scans bucket.
resource "yandex_storage_bucket_iam_binding" "passport_scans_runtime" {
  bucket  = yandex_storage_bucket.demo_passport_scans.bucket
  role    = "storage.editor"
  members = ["serviceAccount:${yandex_iam_service_account.sochi_backend_runtime.id}"]
}
