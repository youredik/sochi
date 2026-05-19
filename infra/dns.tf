# =============================================================================
# DNS — zone + records
# =============================================================================
#
# Zone delegated к YC DNS NS servers (ns1.yandexcloud.net + ns2.yandexcloud.net)
# через reg.ru registrar (2026-05-19). NS + SOA records — auto-managed by YC DNS,
# не tofu-imported.

resource "yandex_dns_zone" "sepshn_ru" {
  folder_id         = var.infra_folder_id
  name              = "sepshn-ru"
  description       = "Public DNS zone for sepshn.ru (registered at reg.ru, delegated to YC NS)"
  zone              = "${var.domain}."
  public            = true
  deletion_protection = false
}

# ---------------------------------------------------------------------------
# Yandex 360 (corporate email) records
# ---------------------------------------------------------------------------

# MX — Yandex 360 mail servers
resource "yandex_dns_recordset" "y360_mx" {
  zone_id = yandex_dns_zone.sepshn_ru.id
  name    = "${var.domain}."
  type    = "MX"
  ttl     = 21600
  data    = ["10 mx.yandex.net."]
}

# Apex TXT — yandex-verification + SPF (single recordset, two values per canon
# «one SPF per domain» RFC 7208).
# YC DNS provider canon: TXT values wrapped в literal RFC `"..."` (escaped quotes
# в HCL = одинарные backslashes).
resource "yandex_dns_recordset" "apex_txt" {
  zone_id = yandex_dns_zone.sepshn_ru.id
  name    = "${var.domain}."
  type    = "TXT"
  ttl     = 3600
  data = [
    "\"yandex-verification: 9334b7bd1c5cf369\"",
    "\"v=spf1 include:_spf.yandex.net ~all\"",
  ]
}

# DKIM key для Yandex 360 outbound mail signing
resource "yandex_dns_recordset" "y360_dkim" {
  zone_id = yandex_dns_zone.sepshn_ru.id
  name    = "mail._domainkey.${var.domain}."
  type    = "TXT"
  ttl     = 3600
  data = [
    "\"v=DKIM1; k=rsa; t=s; p=MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDcW/gLuX88RTZ+JrsYOSQ28Vjb3PdFcrmh04uCAICsFrS6yIrAkbe4ouS1oeVreAq6U5ARIc4Ot4TA/jbRQ2AqE5yBqn0eyyIswtRzOLwUCT0phvpTcQlLAIjWTqlTcncyAcUBqfraXtwl70uMVapGr3btcInF1tc2cnJP0qMjLQIDAQAB\"",
  ]
}

# ---------------------------------------------------------------------------
# Cert Manager — ACME DNS-01 challenge CNAME (auto-renew via YC)
# ---------------------------------------------------------------------------

resource "yandex_dns_recordset" "acme_challenge" {
  zone_id = yandex_dns_zone.sepshn_ru.id
  name    = "_acme-challenge.${var.domain}."
  type    = "CNAME"
  ttl     = 300
  data    = ["${yandex_cm_certificate.sepshn_wildcard.id}.cm.yandexcloud.net."]
}

# ---------------------------------------------------------------------------
# Demo public endpoint — demo.sepshn.ru → API Gateway
# ---------------------------------------------------------------------------

resource "yandex_dns_recordset" "demo_cname" {
  zone_id = yandex_dns_zone.sepshn_ru.id
  name    = "${var.demo_subdomain}."
  type    = "CNAME"
  ttl     = 600
  data    = ["${yandex_api_gateway.demo.domain}."]
}
