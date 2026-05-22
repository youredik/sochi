# =============================================================================
# Yandex SmartCaptcha — bot protection для magic-link forms
# =============================================================================
#
# Per `[[feedback_captcha_localhost_canon]]` + Yandex security canon
# «isolate test/prod» — captcha per-environment workload resource:
#
#   - **Demo** (этот файл): allowed_sites = [sepshn.ru], folder = demo
#   - **Prod** (future, отдельный cloud sepshn-prod): allowed_sites =
#     [app.sepshn.ru], folder = prod в новом cloud
#
# Workflow:
#   1. TF создаёт captcha → outputs client_key (public, prefix ysc1_)
#   2. **One-time manual** (terraform-provider issue #492): после `tofu apply`
#      запустить `yc smartcaptcha captcha get-secret-key <id>` → secret_key
#      (private, prefix ysc2_) → положить вручную в Lockbox `sochi-backend-
#      secrets` key `SMARTCAPTCHA_SERVER_KEY` (см. bootstrap.md). Keys
#      переменные не часто — manual ОК.
#   3. Backend reads `SMARTCAPTCHA_SERVER_KEY` через container secrets {}
#      block (see container.tf)
#   4. Frontend reads `VITE_YANDEX_CAPTCHA_SITE_KEY` (client_key) через
#      CI build env (see `.sourcecraft/ci.yaml` deploy-frontend.build.env)
#
# Pricing: 250k validated (status=ok) requests/month free, далее платно.
# Демо traffic мало → free tier хватит на год вперёд.

resource "yandex_smartcaptcha_captcha" "demo" {
  folder_id = yandex_resourcemanager_folder.demo.id
  name      = "sepshn-demo"

  # MEDIUM + CHECKBOX + IMAGE_TEXT — industry-standard UX. Stankoff canon
  # 2026-04-25 verified empirical. EASY = too easy, HARD = friction для
  # legit users. Bump к HARD только когда атаки наблюдаются.
  complexity     = "MEDIUM"
  pre_check_type = "CHECKBOX"
  challenge_type = "IMAGE_TEXT"

  # Apex sepshn.ru + автоматически all subdomains (per Yandex docs).
  # Защищает от widget embedding на attacker domains — token valid только
  # когда страница загружена с разрешённого host.
  allowed_sites = ["sepshn.ru"]

  # 152-ФЗ privacy stance: Yandex ML team не получает наши captcha data
  # для training. Сюр-плюс для compliance, минус — пустой («наши данные
  # помогают Yandex улучшать captcha» message в YC console).
  disallow_data_processing = true

  # Prod: prevent_destroy через `lifecycle.prevent_destroy`. Demo —
  # accidentally tofu destroy переживём (recreate + re-fetch server_key).
  # Когда будет prod в отдельном cloud — там deletion_protection = true.

  labels = {
    managed_by  = "opentofu"
    environment = "demo"
  }
}

# Public client_key — выходит в TF state как plain value (не sensitive).
# Используется в CI build cube as VITE_YANDEX_CAPTCHA_SITE_KEY env var.
# Безопасно committit к git/repo (ключ public по design — embedded в
# frontend bundle anyway).
output "smartcaptcha_client_key" {
  description = "SmartCaptcha public client key (ysc1_...). Inject в frontend build as VITE_YANDEX_CAPTCHA_SITE_KEY."
  value       = yandex_smartcaptcha_captcha.demo.client_key
}

output "smartcaptcha_id" {
  description = "SmartCaptcha resource ID для manual `yc smartcaptcha captcha get-secret-key` (one-time после первого apply, см. bootstrap.md)."
  value       = yandex_smartcaptcha_captcha.demo.id
}
