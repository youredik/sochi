# =============================================================================
# Yandex Cloud Postbox — transactional email (SES-compatible API)
# =============================================================================
#
# Based on official `yandex-cloud-examples/yc-postbox-tf` (2026 canon).
#
# Архитектура:
#   - **admin SA** (`postbox-admin`) — управляет identity через AWS SESv2 API,
#     создаёт DKIM signing config. Static access key используется AWS-provider'ом.
#   - **sender SA** (`postbox-sender`, текущий `sochi_backend_runtime`) — отправляет
#     emails в runtime через @aws-sdk/client-sesv2. Static access key → Lockbox →
#     backend container env (AWS_ACCESS_KEY_ID/SECRET).
#   - **DKIM private key** — generated locally один раз, загружен в отдельный Lockbox
#     `postbox-dkim` (bootstrap, см. bootstrap.md). TF читает через data source.
#   - **DKIM public key** — выводится через `aws_sesv2_email_identity` атрибуты
#     `dkim_signing_attributes.tokens` (CNAME records), записывается в DNS как TXT.
#
# Folder placement:
#   - admin SA + identity + sender SA + static keys → `demo` folder (per-env workload)
#   - DKIM private key Lockbox → `infra` folder (shared cross-resource)
#   - DNS records → `infra` folder (где DNS zone)
#
# Per subdomain canon `[[project_subdomain_architecture_canon_2026_05_22]]`:
# Сейчас identity = `noreply@sepshn.ru`. Когда появится prod (отдельный cloud
# `sepshn-prod`) — там будет отдельная identity `noreply@app.sepshn.ru`.

# ---------------------------------------------------------------------------
# admin SA — TF использует через AWS provider для управления Postbox identity
# ---------------------------------------------------------------------------

resource "yandex_iam_service_account" "postbox_admin" {
  folder_id   = yandex_resourcemanager_folder.demo.id
  name        = "sepshn-postbox-admin"
  description = "Postbox admin SA — TF создаёт/управляет email identity via AWS SESv2 API"
}

resource "yandex_resourcemanager_folder_iam_member" "postbox_admin_role" {
  folder_id = yandex_resourcemanager_folder.demo.id
  role      = "postbox.admin"
  member    = "serviceAccount:${yandex_iam_service_account.postbox_admin.id}"
}

resource "yandex_iam_service_account_static_access_key" "postbox_admin_key" {
  service_account_id = yandex_iam_service_account.postbox_admin.id
  description        = "Static key для Postbox admin (AWS provider auth, identity management)"
}

# ---------------------------------------------------------------------------
# sender SA — runtime backend container отправляет emails
# ---------------------------------------------------------------------------
# Используем existing `sochi_backend_runtime` SA — добавляем postbox.sender роль.

resource "yandex_resourcemanager_folder_iam_member" "runtime_postbox_sender" {
  folder_id = yandex_resourcemanager_folder.demo.id
  role      = "postbox.sender"
  member    = "serviceAccount:${yandex_iam_service_account.sochi_backend_runtime.id}"
}

# Static access key для runtime SA — runtime использует через @aws-sdk/client-sesv2.
# Отдельный key (не shared с S3 key) — least-privilege + independent rotation.
resource "yandex_iam_service_account_static_access_key" "runtime_postbox_key" {
  service_account_id = yandex_iam_service_account.sochi_backend_runtime.id
  description        = "Static key для Postbox email sending в runtime (@aws-sdk/client-sesv2)"
}

# ---------------------------------------------------------------------------
# AWS provider — auth через admin SA static key, endpoint к Yandex Postbox
# ---------------------------------------------------------------------------
# Provider settings reference SA static key — TF resolves dynamically at apply time.
# Per `yc-postbox-tf` canon — works через ordering (SA создаётся first).

provider "aws" {
  region     = "ru-central1"
  access_key = yandex_iam_service_account_static_access_key.postbox_admin_key.access_key
  secret_key = yandex_iam_service_account_static_access_key.postbox_admin_key.secret_key

  # AWS SDK validation skips — Yandex Postbox не имеет AWS account/region semantics.
  skip_region_validation      = true
  skip_credentials_validation = true
  skip_requesting_account_id  = true
  skip_metadata_api_check     = true

  endpoints {
    sesv2 = "https://postbox.cloud.yandex.net"
  }
}

# ---------------------------------------------------------------------------
# DKIM private key — bootstrap'нут в отдельный Lockbox secret
# ---------------------------------------------------------------------------
# One-time generation: `openssl genrsa 2048 > /tmp/postbox_dkim.pem` →
# `yc lockbox secret create --name sepshn-postbox-dkim --payload [...]`.
# См. bootstrap.md шаг 3.

data "yandex_lockbox_secret_version" "postbox_dkim" {
  secret_id = var.lockbox_postbox_dkim_secret_id
}

locals {
  # PEM от `openssl genrsa` включает headers (BEGIN/END PRIVATE KEY) +
  # multi-line base64 body + newlines. AWS provider for SESv2 требует
  # pure base64 без headers/whitespace («must be base64-encoded» error).
  # Empirical Run #49 2026-05-22.
  postbox_dkim_pem_raw = [
    for e in data.yandex_lockbox_secret_version.postbox_dkim.entries :
    e.text_value if e.key == "POSTBOX_DKIM_PRIVATE_KEY"
  ][0]

  # Strip PEM markers + flatten newlines/whitespace → pure base64.
  # Handles both PKCS8 (`-----BEGIN PRIVATE KEY-----`) and PKCS1
  # (`-----BEGIN RSA PRIVATE KEY-----`) форматы.
  postbox_dkim_private_key = replace(
    replace(
      replace(
        replace(
          replace(local.postbox_dkim_pem_raw, "-----BEGIN PRIVATE KEY-----", ""),
          "-----END PRIVATE KEY-----", ""
        ),
        "-----BEGIN RSA PRIVATE KEY-----", ""
      ),
      "-----END RSA PRIVATE KEY-----", ""
    ),
    "\n", ""
  )

  # Selector для DKIM. Postbox требует selector в DNS как
  # `{selector}._domainkey.{domain}`. «postbox» — convention.
  dkim_selector = "postbox"
}

# ---------------------------------------------------------------------------
# Email identity — через AWS SESv2 API (= Yandex Postbox identity)
# ---------------------------------------------------------------------------

resource "aws_sesv2_email_identity" "sepshn" {
  email_identity = var.domain # sepshn.ru

  dkim_signing_attributes {
    domain_signing_selector    = local.dkim_selector
    domain_signing_private_key = local.postbox_dkim_private_key
  }

  depends_on = [
    yandex_iam_service_account.postbox_admin,
    yandex_iam_service_account_static_access_key.postbox_admin_key,
    yandex_resourcemanager_folder_iam_member.postbox_admin_role,
  ]
}

# ---------------------------------------------------------------------------
# DNS records (DKIM, SPF, DMARC) — все в same DNS zone sepshn.ru
# ---------------------------------------------------------------------------

# DKIM TXT — public key для DKIM verification by receiving MTAs.
# Postbox identity create возвращает public DKIM key fingerprint via
# `dkim_signing_attributes` атрибуты после apply. Selector format:
# `{selector}._domainkey.{domain}` (e.g. postbox._domainkey.sepshn.ru).
resource "yandex_dns_recordset" "postbox_dkim_txt" {
  zone_id = yandex_dns_zone.sepshn_ru.id
  name    = "${local.dkim_selector}._domainkey.${var.domain}."
  type    = "TXT"
  ttl     = 3600
  data = [
    # Public DKIM key derived from private (RSA standard p= attribute).
    # Format: `v=DKIM1; k=rsa; p=<base64-public-key>` — Postbox auto-derives
    # public from private. Manually computed in bootstrap.md шаг 3 OR auto
    # via tls_private_key resource (future improvement).
    "\"v=DKIM1; k=rsa; p=${var.postbox_dkim_public_key}\"",
  ]

  depends_on = [aws_sesv2_email_identity.sepshn]
}

# SPF TXT — приём mailservers видит, что sepshn.ru авторизован Postbox-у
# слать письма. Канон 2026: include только Postbox; `~all` (soft-fail —
# не reject, suspect-mark) — мягкий старт. Через 2-4 недели → `-all` (hard).
#
# IMPORTANT: ОДИН SPF recordset per domain (RFC 7208). Текущий apex_txt
# в dns.tf уже содержит SPF — модифицируем его, НЕ дублируем.
# (см. dns.tf modification ниже)

# DMARC TXT — отчёты о spoofing, начинаем с `p=none` (monitoring-only),
# через 1-2 недели → `p=quarantine`, через ещё 2 — `p=reject`.
#
# `rua` — куда mail receivers шлют aggregate reports. `dmarc@sepshn.ru`
# создаётся через Yandex 360 для домена (manual one-time bootstrap).
resource "yandex_dns_recordset" "dmarc_txt" {
  zone_id = yandex_dns_zone.sepshn_ru.id
  name    = "_dmarc.${var.domain}."
  type    = "TXT"
  ttl     = 3600
  data = [
    "\"v=DMARC1; p=none; rua=mailto:dmarc@${var.domain}; fo=1; adkim=r; aspf=r\"",
  ]
}

# ---------------------------------------------------------------------------
# Outputs
# ---------------------------------------------------------------------------

output "postbox_identity_arn" {
  description = "Postbox email identity ARN (per AWS SESv2 schema)."
  value       = aws_sesv2_email_identity.sepshn.arn
}

output "postbox_sender_access_key_id" {
  description = "AWS access key ID для backend runtime sender. SENSITIVE — переходит в Lockbox через `lockbox.tf`."
  value       = yandex_iam_service_account_static_access_key.runtime_postbox_key.access_key
  sensitive   = true
}
