# =============================================================================
# Yandex Smart Web Security — PHASE A DETACH (Round 14.5 2026-05-27)
# =============================================================================
#
# История: Round 7 v3 (2026-05-25) adopted SWS как whole edge security layer.
# Empirical billing audit 27.05.2026 опроверг канон «Cost demo ₽0/мес»:
# фактически ~10 000 ₽/мес (12k req/день × 27,45 ₽/1000 финальных ALLOW).
#
# Опровергнутые гипотезы оптимизации (empirically verified via cloudapi proto +
# yandex.cloud docs 27.05.2026):
#
#   1. «ARL ALLOW shadow для static» — НЕВОЗМОЖНО.
#      cloudapi/yandex/cloud/smartwebsecurity/v1/advanced_rate_limiter/
#      advanced_rate_limiter_profile.proto enum Action = {ACTION_UNSPECIFIED,
#      DENY}. ALLOW отсутствует by design. Terraform v0.205.0 rejects.
#
#   2. «Path-scope smart_protection снизит биллинг» — ОПРОВЕРГНУТО.
#      yandex.cloud/ru/docs/smartwebsecurity/pricing:
#        «В тарификации учитываются только легитимные запросы. Это запросы,
#         которые были разрешены всеми правилами и пропущены к защищаемому
#         ресурсу.»
#      Биллинг per-final-ALLOW reaching origin, НЕ per-rule-matched. Path-scope
#      smart_protection снижает только Yandex ML calls, не cost.
#
#   3. «ARL processing exempt = shadow path» — ARL exempt только для blocked-
#      by-ARL. Passthrough к Security Profile → ALLOW → тарифицируется.
#
# =============================================================================
# PHASE A — DETACH ONLY (this commit)
# =============================================================================
#
# Goal: убрать SWS Security Profile binding из API Gateway spec (uжe сделано
# в api_gateway_spec.yaml + api_gateway.tf), НО оставить SWS resources в state
# чтобы избежать race condition с terraform parallel apply.
#
# Run #119 + #120 апплаи провалились на:
#   «unable to delete security profile: it is used by serverless API gateway»
# Root cause: terraform parallel пускал yandex_sws_security_profile destroy +
# yandex_api_gateway update одновременно. Destroy упал т.к. profile still
# attached в live state до того как gateway update propagated.
#
# Phase A strategy: SWS resources в config MATCH current state (no destroy
# planned). Apply делает только API Gateway spec update. После success в
# live YC: ALB virtual host (implicit YC-managed) auto-detaches SWS.
#
# Phase B (next commit, после Phase A success): удалить SWS resources из
# config → destroy plan → теперь orphan, destroy clean.
#
# Defense migration (app-layer canon):
#   - apps/backend/src/middleware/rate-limit.ts — in-process token bucket
#   - apps/backend/src/lib/auth/captcha-gate.ts — SmartCaptcha + X-Bypass-Token
#   - apps/backend/src/middleware/security-headers.ts — CSP + HSTS
#
# SWS edge layer was redundant к этой app-layer защите. Полное снятие
# завершается в Phase B.
#
# Reference: feedback_round_7_v3_sws_canon_2026_05_25.md (superseded by this).

variable "sws_bypass_lockbox_secret_id" {
  description = "Lockbox secret ID для X-Bypass-Token. Backend captcha-gate.ts reads directly."
  type        = string
  default     = ""
}

variable "sws_bypass_lockbox_version_id" {
  description = "Lockbox version ID — bump on bypass-token rotation."
  type        = string
  default     = ""
}

data "yandex_lockbox_secret_version" "sws_bypass_token" {
  count      = var.sws_bypass_lockbox_secret_id != "" ? 1 : 0
  secret_id  = var.sws_bypass_lockbox_secret_id
  version_id = var.sws_bypass_lockbox_version_id
}

locals {
  sws_bypass_token = var.sws_bypass_lockbox_secret_id != "" ? (
    [for e in data.yandex_lockbox_secret_version.sws_bypass_token[0].entries : e.text_value if e.key == "SWS_BYPASS_TOKEN"][0]
  ) : ""
}

# -----------------------------------------------------------------------------
# Phase A — ARL profile retained matching live state (no changes planned)
# -----------------------------------------------------------------------------
# Will be destroyed in Phase B after API Gateway detach propagates.
resource "yandex_sws_advanced_rate_limiter_profile" "demo" {
  folder_id   = yandex_resourcemanager_folder.demo.id
  name        = "sepshn-demo-arl"
  description = "Edge rate-limiter — magic-link 100/10min/IP (dry_run 14-day soak) + X-Bypass-Token exempt"

  advanced_rate_limiter_rule {
    name        = "magic-link-ip-throttle"
    description = "100 magic-link calls / 10 minutes / source IP — dry_run soak first 14 days, X-Bypass-Token exempt"
    priority    = 100
    dry_run     = true
    static_quota {
      action = "DENY"
      limit  = 100
      period = 600
      condition {
        request_uri {
          path {
            exact_match = "/api/auth/sign-in/magic-link"
          }
        }
        dynamic "headers" {
          for_each = local.sws_bypass_token != "" ? [1] : []
          content {
            name = "X-Bypass-Token"
            value {
              exact_not_match = local.sws_bypass_token
            }
          }
        }
      }
    }
  }

  labels = {
    managed_by  = "opentofu"
    environment = "demo"
  }
}

# -----------------------------------------------------------------------------
# Phase A — Security profile retained matching live state (no changes planned)
# -----------------------------------------------------------------------------
# Will be destroyed in Phase B. API Gateway spec уже БЕЗ x-yc-apigateway:
# smartWebSecurity extension (см. api_gateway_spec.yaml). Apply Phase A:
# updates gateway spec → ALB virtual host auto-detaches → ready для Phase B
# destroy.
resource "yandex_sws_security_profile" "demo" {
  folder_id                        = yandex_resourcemanager_folder.demo.id
  name                             = "sepshn-demo-sws"
  description                      = "Edge security для demo.sepshn.ru — ARL + WAF + Smart Protection + bypass"
  default_action                   = "ALLOW"
  captcha_id                       = yandex_smartcaptcha_captcha.demo.id
  advanced_rate_limiter_profile_id = yandex_sws_advanced_rate_limiter_profile.demo.id

  dynamic "security_rule" {
    for_each = local.sws_bypass_token != "" ? [1] : []
    content {
      name        = "bypass-trusted-callers"
      description = "Skip Smart Protection ML for callers с valid X-Bypass-Token (CI smoke + AI agent)"
      priority    = 8500
      rule_condition {
        action = "ALLOW"
        condition {
          headers {
            name = "X-Bypass-Token"
            value {
              exact_match = local.sws_bypass_token
            }
          }
        }
      }
    }
  }

  security_rule {
    name        = "smart-protection-api"
    description = "ML bot scoring для /api/* — verdict в response header, no captcha redirect"
    priority    = 999900
    smart_protection {
      mode = "API"
    }
  }

  security_rule {
    name        = "smart-protection-full"
    description = "ML bot scoring + SmartCaptcha redirect для browser navigation"
    priority    = 999990
    smart_protection {
      mode = "FULL"
    }
  }

  labels = {
    managed_by  = "opentofu"
    environment = "demo"
  }
}
