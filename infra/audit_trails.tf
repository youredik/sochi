# =============================================================================
# Audit Trails — IAM/SA/Registry event capture к YC Logging
# =============================================================================
#
# Canon Q2 2026 (verified empirically 2026-05-20): `yandex_audit_trails_trail`
# TF resource exists в provider v0.204. Supports 3 destinations (logging /
# storage / data_stream — mutually exclusive). Wire к existing demo folder
# default log group для 152-ФЗ compliance + IAM event auditability.
#
# Trail covers: management events (cloud-wide) — все IAM/SA/Lockbox/Container
# revision/registry mutations.

resource "yandex_iam_service_account" "audit_trails_publisher" {
  folder_id   = yandex_resourcemanager_folder.infra.id
  name        = "audit-trails-publisher"
  description = "SA для Audit Trails публикации events к YC Logging (152-ФЗ canon)"
}

resource "yandex_resourcemanager_folder_iam_member" "audit_publisher_audit_viewer" {
  folder_id = yandex_resourcemanager_folder.infra.id
  role      = "audit-trails.viewer"
  member    = "serviceAccount:${yandex_iam_service_account.audit_trails_publisher.id}"
}

# Cloud-level audit-trails.viewer — Audit Trails requires permission TO COLLECT
# logs от cloud-scope resources (management events). Folder-only insufficient
# для resource_scope: cloud в filtering_policy.
resource "yandex_resourcemanager_cloud_iam_member" "audit_publisher_cloud_viewer" {
  cloud_id = var.yc_cloud_id
  role     = "audit-trails.viewer"
  member   = "serviceAccount:${yandex_iam_service_account.audit_trails_publisher.id}"
}

resource "yandex_resourcemanager_folder_iam_member" "audit_publisher_log_writer" {
  folder_id = yandex_resourcemanager_folder.demo.id
  role      = "logging.writer"
  member    = "serviceAccount:${yandex_iam_service_account.audit_trails_publisher.id}"
}

# Default log group в demo folder создаётся automatically YC при first container
# log emit (revision deploy уже triggered это).
data "yandex_logging_group" "default" {
  folder_id = yandex_resourcemanager_folder.demo.id
  name      = "default"
}

resource "yandex_audit_trails_trail" "demo_trail" {
  name        = "sochi-demo-audit-trail"
  folder_id   = yandex_resourcemanager_folder.infra.id
  description = "Audit trail для demo deployment: management events → YC Logging"

  service_account_id = yandex_iam_service_account.audit_trails_publisher.id

  logging_destination {
    log_group_id = data.yandex_logging_group.default.id
  }

  filtering_policy {
    # Management events — все изменения в cloud (IAM, SA создание, role bindings,
    # container revisions, Lockbox CRUD и т.д.)
    management_events_filter {
      resource_scope {
        resource_id   = var.yc_cloud_id
        resource_type = "resource-manager.cloud"
      }
    }
  }

  depends_on = [
    yandex_resourcemanager_folder_iam_member.audit_publisher_audit_viewer,
    yandex_resourcemanager_folder_iam_member.audit_publisher_log_writer,
  ]
}

# Out-of-band TODO (TF не поддерживает Q2 2026):
#   - yandex_container_registry_scanner — vulnerability scan-on-push: ENABLE
#     через UI или `yc container image scan` cron. Issue: scan-on-push toggle
#     отсутствует в provider v0.204.
#   - yandex_monitoring_alert — Issue #166 (May 2021) still open. Alerts на
#     revision deploy failures + error rates — через UI / monitoring CLI.

output "audit_trail_id" {
  value = yandex_audit_trails_trail.demo_trail.id
}
