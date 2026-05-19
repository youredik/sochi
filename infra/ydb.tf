# =============================================================================
# YDB Serverless — demo database
# =============================================================================
#
# Serverless tier: scales к zero, $0 idle, pay-per-request. Endpoint:
#   grpcs://ydb.serverless.yandexcloud.net:2135/?database=/ru-central1/<cloud>/<id>
#
# Auth для backend container: IAM token from runtime SA (см. iam.tf).
# No VPC subnet required — public gRPCs endpoint с IAM.

resource "yandex_ydb_database_serverless" "demo" {
  folder_id   = var.demo_folder_id
  name        = "demo"
  description = "Demo deployment YDB Serverless — Track A (DEMO_DEPLOYMENT=true)"

  deletion_protection = false
}
