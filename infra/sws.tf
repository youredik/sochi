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
# Cost canon (2026-05-27 — empirical correction после billing audit):
#   - Тариф: 27,45 ₽/1000 финальных ALLOW запросов на тире 1М/мес
#   - Free tier: 10 000 запросов/мес (НЕ /день — был мой просчёт в Round 7 v3)
#   - ARL processing официально НЕ тарифицируется (docs: «не учитываются»)
#   - Blocked (DENY) запросы НЕ тарифицируются; dry_run-passed = тарифицируются
#
# Empirical 26.05.2026: 12 000 req/день × 27,45 ₽/1000 = 331 ₽/день = ~10к ₽/мес.
# Старый канон «Demo ~10k/мес → ₽0/мес» опровергнут — был наивный расчёт.
#
# Optimization (Round 14.5 2026-05-27):
#   1. ARL ALLOW shadow для static (priority 50) → static не доходит до
#      Security Profile → 0 ₽ за static traffic (~50-70% запросов).
#   2. Smart Protection API scope к /api/* — ML только на XHR/fetch.
#   3. Smart Protection FULL scope к non-/api — ML только на HTML pages.
#
# Expected post-optimization: ~140-500 ₽/мес на demo baseline.
# Production (1M+ req/мес app.sepshn.ru future): ~27 000 ₽/мес default tier;
# Subscription Start ₽50 833/мес break-even at ~1,85M req/мес.
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
# ARL — Advanced Rate Limiter (edge rate-limiting + cost-exempt static shadow)
# -----------------------------------------------------------------------------
# CANON 2026-05-27 (cost optimization после 27.05 billing audit — 12k req/день
# ALLOW × 27,45 ₽/1000 = 331 ₽/день, free tier 10k/мес исчерпан за час):
#
# ARL processing официально НЕ тарифицируется per yandex.cloud/ru/docs/
# smartwebsecurity/pricing: «Обработка запроса правилами из профилей ARL не
# учитываются в потреблении». Static-assets ALLOW rule в ARL = единственный
# документированный способ снять конкретные пути со счёта Security Profile.
#
# Two rules:
#   1. static-allow-exempt (priority 50, ALLOW) — assets/favicon/pwa/logo →
#      ARL processes → НЕ доходит до Security Profile → 0 ₽ за static traffic.
#   2. magic-link-ip-throttle (priority 100, DENY) — abuse-targeted rate-limit
#      на signup endpoint. `dry_run=true` first 14 days log-only (canonical
#      soak). Header-conditional bypass для CI smoke + AI agent X-Bypass-Token.
#
# Priority semantic в ARL: lower wins. Static rule 50 < throttle 100 — static
# matched first → ALLOW → ARL processing done → exempt billing.
#
# App-layer auth-signup-rate-limit.ts retained as defense-in-depth (app
# catches single-instance bursts ARL не видит, per [[feedback_token_bucket_
# upstream_canon_2026_05_24]]).
resource "yandex_sws_advanced_rate_limiter_profile" "demo" {
  folder_id   = yandex_resourcemanager_folder.demo.id
  name        = "sepshn-demo-arl"
  description = "Edge rate-limiter + static-cost-exempt — magic-link 100/10min/IP + ARL ALLOW shadow для static"

  # Rule 1: ARL ALLOW shadow для static assets — снимает биллинг Security
  # Profile per Yandex docs «ARL processing не учитывается в потреблении».
  # PIRE regex covers: /assets/* (Vite chunks), /favicon.ico, /pwa-*.png,
  # /apple-touch-icon-*.png, /logo.svg, /manifest.*, /theme-init.js,
  # /robots.txt, /sitemap.xml, /.well-known/* (security.txt + acme).
  advanced_rate_limiter_rule {
    name        = "static-allow-exempt"
    description = "ARL ALLOW для static paths → exempt из Security Profile billing (27,45 ₽/1000 ALLOW saved)"
    priority    = 50
    dry_run     = false
    static_quota {
      action = "ALLOW"
      limit  = 1000000 # эффективно «всегда ALLOW» для static
      period = 60
      condition {
        request_uri {
          path {
            pire_regex_match = "^/(assets/|favicon\\.ico|favicon|pwa-[0-9]+x[0-9]+\\.png|apple-touch-icon|logo\\.svg|manifest\\.webmanifest|manifest\\.json|theme-init\\.js|robots\\.txt|sitemap\\.xml|\\.well-known/).*"
          }
        }
      }
    }
  }

  # Rule 2: magic-link signup throttle — defense-in-depth с app-layer limiter.
  advanced_rate_limiter_rule {
    name        = "magic-link-ip-throttle"
    description = "100 magic-link calls / 10 minutes / source IP — dry_run soak first 14 days, X-Bypass-Token exempt"
    priority    = 100
    dry_run     = true # canonical soak — flip к false после 14-day audit
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
        # Header-conditional exemption: rule applies ONLY когда X-Bypass-Token
        # absent или mismatch. Trusted callers с valid token skip ARL entirely.
        # `exact_not_match` evaluates true когда header absent OR value differs.
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
# WAF profile — OWASP Core Rule Set 4.0.0 (provider v0.150.0+ canonical schema)
# -----------------------------------------------------------------------------
# Root cause Run #95 fail: provider v0.150.0 (2025-08-12) introduced new
# top-level `rule_set { action priority core_rule_set {...} }` shape AND
# DEPRECATED the legacy top-level `core_rule_set` block. terraform-yc-modules
# wrapper still uses deprecated shape → empty `rule_sets` field → API rejects
# с «must have at least one rule set».
#
# Canonical config (verbatim mirror of official provider example
# examples/sws_waf_profile/r_sws_waf_profile_1.tf):
#   - Top-level `rule_set` block с action=DENY (required enum), priority, etc.
#   - `core_rule_set` NESTED inside rule_set
#   - `type = "CORE"` inside innermost rule_set descriptor
#   - Per-rule `is_blocking = false` for 14-day soak (NOT resource-level —
#     schema doesn't have profile-wide blocking toggle)
#   - paranoia_level <= filter (NOT >= as terraform-yc-modules uses; module
#     bug — official semantic is "enable all rules with paranoia ≤ this")
#
# Reference: yandex-cloud/terraform-provider-yandex master HEAD 2026-05-25.
data "yandex_sws_waf_rule_set_descriptor" "owasp4" {
  name    = "OWASP Core Ruleset"
  version = "4.0.0"
}

resource "yandex_sws_waf_profile" "demo" {
  folder_id   = yandex_resourcemanager_folder.demo.id
  name        = "sepshn-demo-waf"
  description = "OWASP CRS 4.0.0 paranoia=1 — 14-day soak (per-rule is_blocking=false), then flip per audit logs"

  rule_set {
    action     = "DENY"
    is_enabled = true
    priority   = 1
    core_rule_set {
      inbound_anomaly_score = 25
      paranoia_level        = 1
      rule_set {
        # Run #100 fix: API requires `id` field IN ADDITION TO name/version/type.
        # Provider's official example examples/sws_waf_profile/r_sws_waf_profile_1.tf
        # is INCOMPLETE (omits id) — would fail same API check. Authoritative source
        # is provider's acceptance test (resource_yandex_sws_waf_profile_test.go
        # testAccSmartwebsecurityWafProfileBasic lines 109-145).
        # Resolves to literal "OWASP_CRS_4_0_0".
        id      = data.yandex_sws_waf_rule_set_descriptor.owasp4.id
        name    = "OWASP Core Ruleset"
        version = "4.0.0"
        type    = "CORE"
      }
    }
  }

  dynamic "rule" {
    for_each = [
      for r in data.yandex_sws_waf_rule_set_descriptor.owasp4.rules : r
      if r.paranoia_level <= 1
    ]
    content {
      rule_id     = rule.value.id
      is_enabled  = true
      is_blocking = false # 14-day LOG_ONLY soak — flip after FP review
    }
  }

  analyze_request_body {
    is_enabled        = true
    size_limit        = 8
    size_limit_action = "IGNORE" # canonical soak; "DENY" would block oversize bodies даже в dry-run
  }

  labels = {
    managed_by  = "opentofu"
    environment = "demo"
  }
}

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
  #
  # CANON 2026-05-27 cost optimization: condition.request_uri.path.prefix_match
  # = "/api/" — ML scoring применяется ТОЛЬКО к /api/* (XHR/fetch endpoints).
  # Provider это поддерживает (опровергнут старый комментарий «не поддерживает»
  # на основе terraform-yc-modules/terraform-yc-sws variables.tf schema +
  # cloudapi proto security_profile.proto). Static via ARL exempt (priority 50).
  security_rule {
    name        = "smart-protection-api"
    description = "ML bot scoring для /api/* only — XHR/fetch endpoints с JSON verdict"
    priority    = 999900
    smart_protection {
      mode = "API"
      condition {
        request_uri {
          path {
            prefix_match = "/api/"
          }
        }
      }
    }
  }

  # Rule 3: Smart Protection mode=FULL для browser navigation (non-/api).
  # Suspect requests redirected к SmartCaptcha challenge.
  #
  # prefix_not_match "/api/" — FULL mode применяется к HTML page loads
  # (`/`, `/o/{slug}`, `/demo/*`). Static уже на ARL exempt — сюда не попадёт.
  security_rule {
    name        = "smart-protection-full"
    description = "ML bot scoring + SmartCaptcha redirect для browser navigation (non-/api/)"
    priority    = 999990
    smart_protection {
      mode = "FULL"
      condition {
        request_uri {
          path {
            prefix_not_match = "/api/"
          }
        }
      }
    }
  }

  # WAF attached as security_rule per canon (priority < smart_protection
  # 999900 → WAF runs first on signature checks, Smart Protection scores after).
  # Mode API: returns verdict, не redirects к captcha. FULL = browser redirect.
  security_rule {
    name        = "waf-owasp"
    description = "OWASP CRS 4.0.0 WAF — paranoia=1, all rules dry-run первые 14 дней"
    priority    = 888800
    waf {
      mode           = "API"
      waf_profile_id = yandex_sws_waf_profile.demo.id
    }
  }

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

output "sws_waf_profile_id" {
  description = "WAF Profile ID — 14-day soak с per-rule is_blocking=false. Flip after audit logs review."
  value       = yandex_sws_waf_profile.demo.id
}
