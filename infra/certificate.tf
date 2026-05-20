# =============================================================================
# Certificate Manager — managed TLS (Let's Encrypt, DNS-01, auto-renew)
# =============================================================================
#
# Wildcard `*.sepshn.ru` + apex covers: demo., app., js., docs., status.
# Single cert, single auto-renew job. Attached к API Gateway по `certificate_id`.
#
# DNS-01 challenge via _acme-challenge CNAME (см. dns.tf:acme_challenge).
# YC handles ACME on its side → no manual TXT updates на renewals.

resource "yandex_cm_certificate" "sepshn_wildcard" {
  folder_id   = yandex_resourcemanager_folder.infra.id
  name        = "sepshn-wildcard"
  description = "Wildcard managed cert for *.sepshn.ru + apex sepshn.ru (Let's Encrypt DNS-01, auto-renew)"

  domains = [var.domain, "*.${var.domain}"]

  managed {
    challenge_type = "DNS_CNAME"
  }
}
