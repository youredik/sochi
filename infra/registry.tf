# =============================================================================
# Container Registry — Docker image storage
# =============================================================================

resource "yandex_container_registry" "sepshn_cr" {
  folder_id = yandex_resourcemanager_folder.infra.id
  name      = "sepshn-cr"

  labels = {
    managed_by = "opentofu"
  }
}

# ---------------------------------------------------------------------------
# Repositories (logical namespaces within the registry)
# ---------------------------------------------------------------------------
#
# Каноничный pattern Q2 2026: один repository per image type.
# Image URL: `cr.yandex/<registry_id>/<repo_name>:<tag>`
# Example: cr.yandex/crp4um8fg84qoro1voi6/backend:v1.0.0

resource "yandex_container_repository" "backend" {
  name = "${yandex_container_registry.sepshn_cr.id}/backend"
}

# Lifecycle policy — stankoff-v2 production canon (Apr-May 2026, tightened
# from 10/720h на 2026-04-24 после cost audit). Settings:
#
#   - Tagged: keep 5 newest + 7-day expire — matches 4-5 deploys/day cadence
#     с 1-2 day rollback window. Beyond 5, anything older 7d is pruned даже
#     if newer than top-5 list (defense against rapid-debug iteration trains
#     like cf4bc2c-* on 2026-05-19 — 9 debug tags shipped in 3 hours).
#   - Untagged: 48h prune — sha256-only refs (artifacts от docker buildx
#     provenance / multi-arch manifest stubs) are short-lived debug artifacts.
#
# Defense against unbounded storage cost (cr.yandex billed per GB-month).
# Policy runs nightly via YC scheduler — declarative canon (no imperative
# `yc image delete` loops, which safety classifier blocks anyway).
#
# TODO (prod): enable vulnerability scanner via console UI (Q2 2026 — нет TF
# resource yet, see github.com/yandex-cloud/terraform-provider-yandex issue).
resource "yandex_container_repository_lifecycle_policy" "backend_retention" {
  name          = "backend-stankoff-canon"
  status        = "active"
  repository_id = yandex_container_repository.backend.id

  rule {
    description   = "Keep 5 newest tagged + prune older 7d"
    untagged      = false
    tag_regexp    = ".*"
    retained_top  = 5
    expire_period = "168h" # 7 days
  }

  rule {
    description   = "Prune untagged (sha256-only stubs) > 48h"
    untagged      = true
    expire_period = "48h"
  }
}

# Runtime SA нуждается container-registry.images.puller роль для pull image
# при container revision deploy
resource "yandex_container_registry_iam_binding" "runtime_puller" {
  registry_id = yandex_container_registry.sepshn_cr.id
  role        = "container-registry.images.puller"
  members     = ["serviceAccount:${yandex_iam_service_account.sochi_backend_runtime.id}"]
}

# Bootstrap claude SA — explicit pusher role на registry для CI/manual deploy.
# Canon: TF-managed binding (cleaner audit than ad-hoc `yc add-access-binding`).
# `claude` SA was created manually via console (one-time bootstrap), но IAM
# bindings — TF. SA ID параметризован via var.bootstrap_claude_sa_id.
resource "yandex_container_registry_iam_binding" "claude_pusher" {
  registry_id = yandex_container_registry.sepshn_cr.id
  role        = "container-registry.images.pusher"
  members     = ["serviceAccount:${var.bootstrap_claude_sa_id}"]
}

# =============================================================================
# Playwright mirror repo — anonymous pull для SC CI prepare-image phase
# =============================================================================
#
# Empirical 2026-05-21 (run #22, #26): SC builder pulls image в prepare-image phase
# ДО любого `script:` где можно docker login. Поэтому private cr.yandex pull
# fails 401 Unauthorized. Workaround per канон 2026:
#
# Image mirror MCR Playwright (public upstream) — корректно разрешить anonymous
# pull on this specific repo. Mainstream pattern verified Yandex docs:
# `system:allUsers` member = unauthenticated access (yandex_container_repository
# _iam_binding upstream docs, TF provider v0.204.0 2026-05-18).
#
# Sources verified 2026-05-20:
# - github.com/yandex-cloud/terraform-provider-yandex/blob/master/docs/resources/
#   container_repository_iam_binding.md
# - yandex.cloud/en/docs/container-registry/cli-ref/repository/add-access-binding
#
# Least-privilege: repository-level binding (NOT registry-level) — backend repo
# остаётся private.
# Auto-import — repo создан crane copy в run #21 ДО появления TF resource.
# OpenTofu 1.5+ canon 2026: declarative `import` block, runs автоматически
# на `tofu plan/apply` (vs imperative `tofu import` CLI command).
# Source: opentofu.org/docs/language/import/ (verified 2026-05)
import {
  to = yandex_container_repository.playwright
  id = "crpg9ndtebgb4u6t47l0"
}

resource "yandex_container_repository" "playwright" {
  name = "${yandex_container_registry.sepshn_cr.id}/playwright"
}

resource "yandex_container_repository_iam_binding" "playwright_anon_pull" {
  repository_id = yandex_container_repository.playwright.id
  role          = "container-registry.images.puller"
  members       = ["system:allUsers"]
}

# Lifecycle для playwright — keep last 3 tagged (rare bumps, no need for many).
resource "yandex_container_repository_lifecycle_policy" "playwright_retention" {
  name          = "playwright-mirror-retention"
  status        = "active"
  repository_id = yandex_container_repository.playwright.id

  rule {
    description   = "Keep 3 newest mirror tags + 30-day expire (rare bumps)"
    untagged      = false
    tag_regexp    = ".*"
    retained_top  = 3
    expire_period = "720h" # 30 days
  }

  rule {
    description   = "Prune untagged stubs > 48h"
    untagged      = true
    expire_period = "48h"
  }
}
