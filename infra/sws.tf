# =============================================================================
# Yandex Smart Web Security — REMOVED FOR DEMO (Round 14.5 2026-05-27)
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
# Single empirical fix без полумер: remove SWS Security Profile binding целиком
# с demo subdomain. Защита перешла на app-layer:
#   - apps/backend/src/middleware/rate-limit.ts (in-process token bucket)
#   - apps/backend/src/lib/captcha-gate.ts (SmartCaptcha verify + bypass token)
#   - apps/backend/src/middleware/security-headers.ts (CSP + HSTS + etc)
#
# Re-activation план для app.sepshn.ru (production cloud):
#   - Деплоится в отдельный cloud `sepshn-prod` (subdomain canon 2026-05-22)
#   - SWS reactivate когда revenue justify ~₽27k/мес tier (1M req/мес default)
#   - Tier-up к Subscription Start (~₽51k/мес × 100M req) break-even ~1.85M/мес
#   - Tax: cloudapi `enable_logging` для Security Profile audit_trails feed
#
# Lockbox `sepshn-sws-bypass-token` ID/version vars retained — captcha-gate.ts
# обращается к ним для backend timing-safe X-Bypass-Token check (defense-in-
# depth pattern was double-layer, теперь single backend-layer).
#
# Reference: feedback_round_7_v3_sws_canon_2026_05_25.md (superseded by this).

variable "sws_bypass_lockbox_secret_id" {
  description = "Lockbox secret ID — DEMO unused (SWS removed). Backend captcha-gate.ts reads it directly for X-Bypass-Token verify."
  type        = string
  default     = ""
}

variable "sws_bypass_lockbox_version_id" {
  description = "Lockbox version ID — bump on bypass-token rotation."
  type        = string
  default     = ""
}
