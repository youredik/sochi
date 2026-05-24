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

  # Sprint C+ Round 6 5-expert audit fix 2026-05-24 (YC ecosystem #19):
  # Object Lock COMPLIANCE mode + 90-day retention = legally-immutable objects.
  # Without это, operator с storage.editor может overwrite / delete scans mid-
  # retention-window — opens forensic-tampering vector (152-ФЗ ст.21 ч.4
  # «возможность установления содержания» violated если scan tampered).
  #
  # Object Lock requires `versioning.enabled = true` (Yandex provider canon
  # AWS-compat). Sets per-object retention enforced даже against root user —
  # ONLY waits for retention_until_date наступает then lifecycle_rule deletes.
  # Effect: passport scan immutable + cannot delete EARLIER than 90 days +
  # auto-cleanup at 90 days.
  versioning {
    enabled = true
  }
  object_lock_configuration {
    object_lock_enabled = "Enabled"
    rule {
      default_retention {
        mode = "COMPLIANCE"
        days = 90
      }
    }
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

  # Sprint C+ Round 5 5-expert audit fix 2026-05-24 (Web research P0):
  # SSE-KMS canonical для passport PII bucket per 152-ФЗ ст.18 + 19.
  # Yandex Object Storage только supports `aws:kms` algorithm с customer-managed
  # KMS key (нет AES256 default option per cloud.yandex.com/ru/docs/storage/operations/buckets/encrypt).
  # Earlier today I dropped the entire SSE block после tf provider error
  # «kms_master_key_id required» — wrong fix (block IS supported, just needs
  # correct key reference). Restored с dedicated `passport_scans_encryption`
  # KMS key (separate от lockbox_encryption для blast-radius isolation).
  server_side_encryption_configuration {
    rule {
      apply_server_side_encryption_by_default {
        kms_master_key_id = yandex_kms_symmetric_key.passport_scans_encryption.id
        sse_algorithm     = "aws:kms"
      }
    }
  }
}

# Dedicated KMS key для passport-scans bucket SSE — separate blast radius vs
# Lockbox encryption key (lockbox.tf), 90-day rotation per Q2 2026 canon.
resource "yandex_kms_symmetric_key" "passport_scans_encryption" {
  folder_id         = yandex_resourcemanager_folder.demo.id
  name              = "passport-scans-encryption"
  description       = "KMS key для SSE на demo_passport_scans bucket (152-ФЗ ст.18 + 19 PII encryption at rest)"
  default_algorithm = "AES_256"
  rotation_period   = "2160h" # 90 дней rotation
  # Sprint C+ Round 6 self-review fix 2026-05-24 (Terraform state verify P1):
  # WITHOUT deletion_protection, accidental `terraform destroy` OR misconfigured
  # tfstate diff = key destroyed → ALL passport scans encrypted under it become
  # PERMANENTLY UNREADABLE (Object Lock COMPLIANCE keeps the objects but без
  # KMS key они дешифровать невозможно). 152-ФЗ ст.21 ч.4 audit retention contract
  # broken. Always-on for PII encryption keys per canon.
  deletion_protection = true
}

# IAM: bucket SSE requires that the SA writing objects has kms.keys.encrypterDecrypter
# на the KMS key. Sochi backend runtime SA uploads passport scans → needs encrypt grant.
resource "yandex_kms_symmetric_key_iam_binding" "passport_scans_encrypter" {
  symmetric_key_id = yandex_kms_symmetric_key.passport_scans_encryption.id
  role             = "kms.keys.encrypterDecrypter"
  members = [
    "serviceAccount:${yandex_iam_service_account.sochi_backend_runtime.id}",
  ]
}

# Backend runtime SA — storage.editor на passport scans bucket.
resource "yandex_storage_bucket_iam_binding" "passport_scans_runtime" {
  bucket  = yandex_storage_bucket.demo_passport_scans.bucket
  role    = "storage.editor"
  members = ["serviceAccount:${yandex_iam_service_account.sochi_backend_runtime.id}"]
}
