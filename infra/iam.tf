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
