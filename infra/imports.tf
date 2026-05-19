# =============================================================================
# Import blocks (OpenTofu 1.6+ / Terraform 1.5+ declarative imports)
# =============================================================================
#
# Эти блоки приводят existing resources (созданные через `yc` CLI до перехода
# к IaC 2026-05-19) под управление tofu. После первого успешного `tofu apply`
# import blocks больше не нужны — можно удалить (refactor PR).
#
# Verify zero-drift через `tofu plan` ДО apply.

# --- Folders ---
import {
  to = yandex_resourcemanager_folder.infra
  id = "b1g6abh503j0dvitdccg"
}

import {
  to = yandex_resourcemanager_folder.demo
  id = "b1gcqa89an0n32mqpuvo"
}

# --- IAM ---
import {
  to = yandex_iam_service_account.sochi_backend_runtime
  id = "aje6ae2vped6afe5k0au"
}

# --- DNS zone ---
import {
  to = yandex_dns_zone.sepshn_ru
  id = "dnsbq30sa6q8136ol7d9"
}

# --- DNS records (recordset id = "<zone_id>/<name>/<type>") ---
import {
  to = yandex_dns_recordset.y360_mx
  id = "dnsbq30sa6q8136ol7d9/sepshn.ru./MX"
}

import {
  to = yandex_dns_recordset.apex_txt
  id = "dnsbq30sa6q8136ol7d9/sepshn.ru./TXT"
}

import {
  to = yandex_dns_recordset.y360_dkim
  id = "dnsbq30sa6q8136ol7d9/mail._domainkey.sepshn.ru./TXT"
}

import {
  to = yandex_dns_recordset.acme_challenge
  id = "dnsbq30sa6q8136ol7d9/_acme-challenge.sepshn.ru./CNAME"
}

# --- Container Registry ---
import {
  to = yandex_container_registry.sepshn_cr
  id = "crprdhmq3p9f9a5j5ck6"
}

# --- YDB Serverless ---
import {
  to = yandex_ydb_database_serverless.demo
  id = "etn2aoiar0iqened9e5a"
}

# --- Object Storage ---
import {
  to = yandex_storage_bucket.demo_frontend
  id = "sepshn-demo-frontend"
}

# --- Certificate ---
import {
  to = yandex_cm_certificate.sepshn_wildcard
  id = "fpqvr0gchc1vjm6ehu1d"
}

# --- IAM bindings ---
# YDB role binding format: "<database_id>,<role>"
import {
  to = yandex_ydb_database_iam_binding.runtime_ydb_editor
  id = "etn2aoiar0iqened9e5a,ydb.editor"
}
