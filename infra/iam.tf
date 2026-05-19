# =============================================================================
# IAM — service accounts + role bindings
# =============================================================================
#
# Bootstrap SAs (managed via _bootstrap/bootstrap.sh, NOT here):
#   - `tf-bot` (ajeh7mk9muf6gbsee66l) — state backend ownership
#   - `claude` (aje8q3kjgtmh2a09fckk) — bootstrap cloud-admin
#
# tofu-managed SAs ниже — declarative product runtime accounts.

# Demo backend runtime SA (used by Serverless Container)
resource "yandex_iam_service_account" "sochi_backend_runtime" {
  folder_id   = var.demo_folder_id
  name        = "sochi-backend-runtime"
  description = "Demo backend runtime SA: YDB editor + Object Storage viewer + Container invoker"
}

# YDB editor binding — backend reads/writes demo database
resource "yandex_ydb_database_iam_binding" "runtime_ydb_editor" {
  database_id = yandex_ydb_database_serverless.demo.id
  role        = "ydb.editor"
  members     = ["serviceAccount:${yandex_iam_service_account.sochi_backend_runtime.id}"]
}

# Serverless Container invoker — нужен для API Gateway → backend container invoke.
# Same SA serves dual roles: runtime identity внутри container + invoker от
# API Gateway integration (см. api_gateway_spec.yaml service_account_id).
resource "yandex_serverless_container_iam_binding" "runtime_invoker" {
  container_id = yandex_serverless_container.backend.id
  role         = "serverless.containers.invoker"
  members      = ["serviceAccount:${yandex_iam_service_account.sochi_backend_runtime.id}"]
}

# Static access key для S3-compatible API access (backend reads/writes
# files в bucket sepshn-demo-backend-files). Secret_key sensitive — passes
# через state encrypted в S3+KMS. Для prod canon — переход к Lockbox с
# rotation.
resource "yandex_iam_service_account_static_access_key" "backend_s3" {
  service_account_id = yandex_iam_service_account.sochi_backend_runtime.id
  description        = "S3 static key для backend → demo_backend_files bucket"
}

# Runtime SA needs viewer-level access to frontend bucket so API Gateway
# object_storage integration can serve SPA assets (Q2 2026 canon — gateway
# acts on behalf of SA whose id is referenced in `x-yc-apigateway-integration`).
# The bucket itself is anonymous-read для browsers, но the gateway integration
# call uses SA identity (not anonymous) per YC documented contract.
resource "yandex_storage_bucket_iam_binding" "frontend_runtime_viewer" {
  bucket = yandex_storage_bucket.demo_frontend.bucket
  role   = "storage.viewer"
  members = [
    "serviceAccount:${yandex_iam_service_account.sochi_backend_runtime.id}",
  ]
}

# Editor binding для same SA — нужен для CI/script upload via `aws s3 sync`
# с two-pass cache-control. Сегодня одноразовый manual deploy, завтра CI
# использует тот же static_access_key.backend_s3 → can write к frontend bucket.
resource "yandex_storage_bucket_iam_binding" "frontend_runtime_editor" {
  bucket = yandex_storage_bucket.demo_frontend.bucket
  role   = "storage.editor"
  members = [
    "serviceAccount:${yandex_iam_service_account.sochi_backend_runtime.id}",
  ]
}
