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

# Sprint C+ Round 6 5-expert audit fix 2026-05-24 (YC ecosystem expert):
# Default log group has only 3-day retention. 152-ФЗ ст.21 ч.4 forensic trail
# requires «возможность установления содержания» — РКН inspection canon
# expects ≥90 days for any PII processing audit log.
#
# **Retention compromise 2026-05-24**: YC free-tier quota `logging.retentionDays`
# default = 3 days. terraform apply run #79 failed «Quota limit logging.retention
# Days.count exceeded» на 2160h (90d). Set к 72h temporarily для quota-compliance.
# **USER-ACTION required**: request quota increase к 2160h (90d) через YC Console
# → Quotas → «Cloud Logging» service. После increase change `retention_period`
# к "2160h" + rerun `tofu apply`.
resource "yandex_logging_group" "sochi_demo_90d" {
  folder_id        = yandex_resourcemanager_folder.demo.id
  name             = "sochi-demo-90d"
  description      = "Demo backend logs — 152-ФЗ ст.21 ч.4 (target 90d, current 72h — quota pending)"
  retention_period = "72h" # 3 days — quota-compliant; raise после quota increase
}

# Legacy default group reference kept для existing-state compat. Audit trail
# теперь uses explicit 90d group. Future: migrate container's log_options
# к new group via terraform apply (container.tf needs log_options block).
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
    # Sprint C+ Round 6 fix: 90-day retention group (ст.21 ч.4 canon).
    log_group_id = yandex_logging_group.sochi_demo_90d.id
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

    # Sprint C+ Round 5 5-expert security audit fix 2026-05-24 (T4):
    # Round 2 memo CLAIMED audit_trails data events были on passport-scans bucket —
    # security pentester verified это was FALSE (only management_events_filter
    # existed). Без data events РКН inspection cannot reconstruct «кто получил
    # доступ к какой scan когда» — ст.21 ч.4 forensic gap.
    # Now S3 GetObject/PutObject/DeleteObject events surface в YC Cloud Logging
    # с full request context (SA + IP + timestamp + objectKey).
    data_events_filter {
      service = "storage"
      resource_scope {
        resource_id   = yandex_storage_bucket.demo_passport_scans.id
        resource_type = "storage.bucket"
      }
    }
  }

  depends_on = [
    yandex_resourcemanager_folder_iam_member.audit_publisher_audit_viewer,
    yandex_resourcemanager_folder_iam_member.audit_publisher_log_writer,
  ]
}

# Out-of-band (TF provider ~>0.204 gaps):
#   - vulnerability scanner: DONE 2026-05-29 via CI scan-gate (см. registry.tf +
#     `.sourcecraft/ci.yaml` deploy-backend `scan-gate` cube). NOT scan-on-push
#     policy (no TF resource) — CI-gate scans exact deployed :SHA, blocks CRITICAL.
#   - yandex_monitoring_alert — Issue #166 still open. Alerts на revision deploy
#     failures + error rates — через UI / monitoring CLI. (P1 backlog: CI failure
#     notifications via SourceCraft webhooks — Q4'25 feature, см. ci-audit canon.)

output "audit_trail_id" {
  value = yandex_audit_trails_trail.demo_trail.id
}
