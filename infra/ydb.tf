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
  folder_id   = yandex_resourcemanager_folder.demo.id
  name        = "demo"
  description = "Demo deployment YDB Serverless — Track A (DEMO_DEPLOYMENT=true)"

  # Sprint C+ Round 6 5-expert audit fix 2026-05-24 (SRE P0-4):
  # Single accidental `terraform destroy` OR misconfigured tfstate diff = entire
  # database wipe. Audit data, consent log, guest documents, scrub log — all
  # gone. 152-ФЗ ст.21 ч.4 audit retention contract = unrecoverable violation.
  # YDB Serverless built-in PITR = 7 days (free), но this guards against the
  # «human error / TF state drift» layer above PITR.
  deletion_protection = true
}
