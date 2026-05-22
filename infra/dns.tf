# =============================================================================
# DNS — zone + records
# =============================================================================
#
# Zone delegated к YC DNS NS servers (ns1.yandexcloud.net + ns2.yandexcloud.net)
# через reg.ru registrar (2026-05-19). NS + SOA records — auto-managed by YC DNS,
# не tofu-imported.

resource "yandex_dns_zone" "sepshn_ru" {
  folder_id           = yandex_resourcemanager_folder.infra.id
  name                = "sepshn-ru"
  description         = "Public DNS zone for sepshn.ru (registered at reg.ru, delegated to YC NS)"
  zone                = "${var.domain}."
  public              = true
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
#
# SPF includes:
#   - `_spf.yandex.net` — Yandex 360 для домена outbound (hi@sepshn.ru handle)
#   - `_spf.cloud.yandex.net` — Yandex Cloud Postbox transactional sends
#     (noreply@sepshn.ru магик-линки, см. postbox.tf — Phase 2 активирован 2026-05-22)
#
# `~all` (soft-fail) — мягкий старт. Через 2-4 недели после DKIM/DMARC
# pass-rate validation → `-all` (hard-fail, RFC-strict). Per
# `[[project_subdomain_architecture_canon]]` migration plan (Phase 3 DMARC roll-out).
#
# YC DNS provider canon: TXT values wrapped в literal RFC `"..."` (escaped quotes
# в HCL = одинарные backslashes).
resource "yandex_dns_recordset" "apex_txt" {
  zone_id = yandex_dns_zone.sepshn_ru.id
  name    = "${var.domain}."
  type    = "TXT"
  ttl     = 3600
  data = [
    "\"yandex-verification: 9334b7bd1c5cf369\"",
    "\"v=spf1 include:_spf.yandex.net include:_spf.cloud.yandex.net ~all\"",
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

# ---------------------------------------------------------------------------
# Apex endpoint — sepshn.ru → API Gateway (landing surface)
# ---------------------------------------------------------------------------
#
# Apex routing via Yandex Cloud DNS **ANAME** record (YC-native apex-
# flattening, equivalent Route53 ALIAS). RFC 1034 forbids CNAME at apex,
# поэтому стандартный CNAME здесь нельзя. ANAME — YC-proprietary record
# type, YC resolves server-side: external resolvers получают A answers
# (flattening behavior). Coexists с apex MX/TXT/SPF/DKIM records — это
# главный win ANAME over CNAME (CNAME blocked бы все siblings).
#
# Prerequisite: zone delegated к YC NS (verified 2026-05-19 via reg.ru).
# Если zone мигрирует к 3rd-party DNS — ANAME сломается, нужен IP A-record
# (но gateway IP может мутироваться).
#
# Empirical canon (research 2026-05-21):
# - yandex.cloud/en/docs/dns/concepts/resource-record («ANAME similar to
#   CNAME but can be used в same domain с other records»)
# - yandex.cloud/en/docs/api-gateway/operations/api-gw-domains («delegate
#   to YC DNS + create ANAME» — canonical apex procedure)
# - yandex.cloud/en/docs/storage/operations/hosting/own-domain (concrete
#   ANAME example: TTL 600, name="${domain}.", value="*.yandexcloud.net.")
resource "yandex_dns_recordset" "apex_aname" {
  zone_id = yandex_dns_zone.sepshn_ru.id
  name    = "${var.domain}."
  type    = "ANAME"
  ttl     = 600
  data    = ["${yandex_api_gateway.demo.domain}."]
}
