# =============================================================================
# IAM — service accounts + role bindings
# =============================================================================
#
# Bootstrap SAs (managed via _bootstrap/bootstrap.sh + console UI, NOT here):
#   - `tf-bot` (ajer6tlq2rcccuuln5vq) — state backend ownership
#   - `claude` (ajel5mli0hshm053amt8) — bootstrap cloud-admin (var.bootstrap_claude_sa_id)
#
# tofu-managed SAs ниже — declarative product runtime accounts.

# Demo backend runtime SA (used by Serverless Container)
resource "yandex_iam_service_account" "sochi_backend_runtime" {
  folder_id   = yandex_resourcemanager_folder.demo.id
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

# Frontend bucket bindings: viewer (READ для API Gateway integration) +
# editor (WRITE для deploy script via aws s3 sync). Both explicit:
#
#   - viewer: API Gateway `x-yc-apigateway-integration: object_storage` acts
#     on behalf of this SA (Q2 2026 canon — gateway issues signed requests
#     к S3 endpoint via SA identity, не anonymous, даже когда bucket has
#     anonymous_access_flags.read=true в storage.tf)
#
#   - editor: deploy script (sync dist/ → bucket с Cache-Control headers
#     via `aws s3 cp --cache-control`). One SA serves both read+write paths.
#
# YC IAM canon: editor IS NOT а superset of viewer at API Gateway level —
# объект_storage integration ONLY accepts viewer-class roles for read path.
# Hence both bindings explicit (defense-in-depth + future role-narrowing OK).
resource "yandex_storage_bucket_iam_binding" "frontend_runtime_viewer" {
  bucket = yandex_storage_bucket.demo_frontend.bucket
  role   = "storage.viewer"
  members = [
    "serviceAccount:${yandex_iam_service_account.sochi_backend_runtime.id}",
  ]
}

resource "yandex_storage_bucket_iam_binding" "frontend_runtime_editor" {
  bucket = yandex_storage_bucket.demo_frontend.bucket
  role   = "storage.editor"
  members = [
    "serviceAccount:${yandex_iam_service_account.sochi_backend_runtime.id}",
  ]
}

# Sprint C+ Round 5 (2026-05-24): Yandex Vision OCR access для passport scan flow.
# `ai.vision.user` is the least-privilege role for calling recognizePassport / recognizeText
# endpoints. Granted to backend runtime SA at demo folder scope (Vision API resources
# не attached к specific resource — folder-level grant is canonical YC pattern для AI
# services). Quota counted к folder; cost ~71 копеек/passport per Yandex AI Studio 2026-Q2.
resource "yandex_resourcemanager_folder_iam_member" "runtime_vision_user" {
  folder_id = yandex_resourcemanager_folder.demo.id
  role      = "ai.vision.user"
  member    = "serviceAccount:${yandex_iam_service_account.sochi_backend_runtime.id}"
}

# Static API key для Yandex Vision OCR. Vision API accepts API-key auth (in
# `Authorization: Api-Key <value>` header — see vision adapter в backend).
# Key generated server-side, value sensitive — proxied через Lockbox в lockbox.tf
# для container injection. Rotation: terraform recreate by changing description
# (key_id changes → new value → new Lockbox version).
resource "yandex_iam_service_account_api_key" "backend_vision" {
  service_account_id = yandex_iam_service_account.sochi_backend_runtime.id
  description        = "Vision OCR API key для passport-scan (sochi-backend-runtime, Sprint C+ 2026-05-24)"
}
