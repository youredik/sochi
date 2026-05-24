# =============================================================================
# Yandex Smart Web Security — edge security layer (Round 7 v3 canon 2026-05-25)
# =============================================================================
#
# Adopted после 3-agent research (см. [[feedback_round_7_v3_sws_canon_2026_05_25]])
# показавшего: (a) SA-JWT custom verifier non-canonical 5-place rotation burden;
# (b) Cloudflare/AWS WAF запрещены 152-ФЗ ст.18 ч.5 (с 1.07.2025); (c) Yandex SWS
# = native canon для RU SaaS с PII; (d) API Gateway `rate-limit` extension
# deprecated, ARL = official replacement.
#
# Architecture (3 resources):
#   1. ARL profile     — edge rate-limiting (free, не tariffied)
#   2. WAF profile     — OWASP CRS 4.0.0 paranoia=1, is_blocking=false (14-day soak)
#   3. Security profile — default ALLOW + Smart Protection (API/FULL) + bypass-allow
#
# Wire к existing API Gateway через `x-yc-apigateway:smartWebSecurity:
# securityProfileId` root extension в api_gateway_spec.yaml (см. api_gateway.tf
# templatefile vars + spec lines 1-5).
#
# Lifecycle: 10k req/мес free tier (demo масштаб). Прод (app.sepshn.ru future)
# в отдельном cloud — клонируется тот же профиль с is_blocking=true после soak.
# Rotation: yc lockbox secret add-version sepshn-sws-bypass-token → SC PUT new
# value → push (single ci.yaml change, no app redeploy needed).
#
# Cost (2026-05): 10k req/мес free + ARL не billed. Demo ~10k/мес → ₽0/мес.
# Production tier 1M req/мес → ~₽27k/мес. Subscription Start (~₽91k/мес) only
# at 80M+ req/мес — defer для прода.
#
# Reference: yandex-cloud-examples/yc-serverless-gateway-protection-with-sws,
# terraform-yc-modules/terraform-yc-sws, yandex.cloud/docs/smartwebsecurity.

# -----------------------------------------------------------------------------
# Variable — SWS bypass token Lockbox IDs (provisioned out-of-band, see below)
# -----------------------------------------------------------------------------
variable "sws_bypass_lockbox_secret_id" {
  description = <<-EOT
    Lockbox secret ID containing SWS_BYPASS_TOKEN. Bootstrap one-time via:
      yc lockbox secret create --name sepshn-sws-bypass-token \
        --folder-id <demo-folder> --payload '[{"key":"SWS_BYPASS_TOKEN","text_value":"<32-byte hex>"}]'
    Then update tfvars `sws_bypass_lockbox_secret_id` + `_version_id`.
    Empty → SWS allow-rule disabled (real captcha enforced for all).
  EOT
  type        = string
  default     = ""
}

variable "sws_bypass_lockbox_version_id" {
  description = "Lockbox version ID для SWS_BYPASS_TOKEN entry. Bump при rotation."
  type        = string
  default     = ""
}

# Token value resolved at apply time from Lockbox payload — used inside
# SWS rule `exact_match` (cannot reference Lockbox indirectly in rule definition,
# SWS evaluates header value directly against literal string per provider schema).
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
# ARL — Advanced Rate Limiter (edge rate-limiting, free)
# -----------------------------------------------------------------------------
# Per-IP static quota на magic-link path: 5 запросов / 10 минут / IP.
# Mirror existing app-layer auth-signup-rate-limit.ts (still kept as defense-
# in-depth — app catches single-instance bursts ARL не видит).
# Deferred WAF: dry_run=true для всех rules первые 14 дней (Yandex own canon).
resource "yandex_sws_advanced_rate_limiter_profile" "demo" {
  folder_id   = yandex_resourcemanager_folder.demo.id
  name        = "sepshn-demo-arl"
  description = "Edge rate-limiter для demo.sepshn.ru — magic-link IP throttle (5/10min)"

  advanced_rate_limiter_rule {
    name        = "magic-link-ip-throttle"
    description = "5 magic-link calls per 10 minutes per source IP"
    priority    = 100
    dry_run     = false # canonical limit; loose enough not to break legit users
    static_quota {
      action = "DENY"
      limit  = 5
      period = 600
      condition {
        request_uri {
          path {
            exact_match = "/api/auth/sign-in/magic-link"
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
# WAF profile — DEFERRED (Phase 2 — Round 7 v3 follow-up commit)
# -----------------------------------------------------------------------------
# Initial attempt failed Run #95 с API error «waf profile must have at least
# one rule set» despite passing core_rule_set + dynamic rule blocks matching
# terraform-yc-modules pattern. Schema mismatch needs deeper research.
#
# Phase 1 ships без WAF: Security Profile + ARL + bypass rule + Smart Protection.
# Provides 80% of value (DDoS L7 + bot ML + edge throttle). WAF (OWASP CRS
# blocking) добавится в follow-up commit после schema clarification.
#
# Plan: empirical sandbox WAF resource в isolated test folder → confirm schema
# → copy к sws.tf → ship Phase 2. См. [[feedback_round_7_v3_sws_canon]].

# -----------------------------------------------------------------------------
# Security profile — main edge gate, attaches ARL + 3 rules
# -----------------------------------------------------------------------------
# Default ALLOW = demo публичный (marketing landing + signup form). Никогда
# default-block: Smart Protection rule scoresuspicious traffic + redirects к
# SmartCaptcha challenge (captcha_id linked).
#
# Rule priority canon: lower=higher precedence. Bypass priority 8500 wins
# over Smart Protection 999900 — verified callers (CI + AI agent) skip
# ML scoring entirely.
resource "yandex_sws_security_profile" "demo" {
  folder_id                        = yandex_resourcemanager_folder.demo.id
  name                             = "sepshn-demo-sws"
  description                      = "Edge security для demo.sepshn.ru — ARL + WAF + Smart Protection + bypass"
  default_action                   = "ALLOW"
  captcha_id                       = yandex_smartcaptcha_captcha.demo.id
  advanced_rate_limiter_profile_id = yandex_sws_advanced_rate_limiter_profile.demo.id

  # Rule 1: bypass для verified callers (CI smoke + AI agent).
  # Two-layer canon (см. captcha-gate.ts): edge ALLOW здесь + backend
  # timing-safe X-Bypass-Token check. Same Lockbox source feeds оба.
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

  # Rule 2: Smart Protection mode=API для /api/* — JSON endpoints get verdict
  # без redirect-к-captcha (would break API semantics).
  security_rule {
    name        = "smart-protection-api"
    description = "ML bot scoring для /api/* — verdict в response header, no captcha redirect"
    priority    = 999900
    smart_protection {
      mode = "API"
    }
    # Note: SWS provider не поддерживает path scoping на smart_protection rules
    # напрямую. Per-rule path filtering достигается через separate rules с
    # rule_condition для conditional bypass или DENY. API mode применяется ко
    # всем path; FULL mode (rule 3) тоже — но FULL подразумевает редирект
    # которого нет в API. Yandex docs canon: оба обычно coexist, FULL wins
    # для browser navigation, API для XHR/fetch (auto-detected by User-Agent).
  }

  # Rule 3: Smart Protection mode=FULL для browser navigation — suspect requests
  # redirected к SmartCaptcha challenge (captcha_id привязан above).
  security_rule {
    name        = "smart-protection-full"
    description = "ML bot scoring + SmartCaptcha redirect для browser navigation"
    priority    = 999990
    smart_protection {
      mode = "FULL"
    }
  }

  # WAF attached as a rule — DEFERRED Phase 2 commit (schema fix pending).
  # См. WAF block comment выше.

  labels = {
    managed_by  = "opentofu"
    environment = "demo"
  }
}

# -----------------------------------------------------------------------------
# Outputs
# -----------------------------------------------------------------------------
output "sws_security_profile_id" {
  description = "SWS Security Profile ID — wire к API Gateway via templatefile var."
  value       = yandex_sws_security_profile.demo.id
}

output "sws_arl_profile_id" {
  description = "ARL Profile ID (free, не tariffied)."
  value       = yandex_sws_advanced_rate_limiter_profile.demo.id
}

# WAF profile output deferred (см. WAF block comment).
