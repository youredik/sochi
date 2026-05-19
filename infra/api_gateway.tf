# =============================================================================
# API Gateway — public edge для backend (custom domain demo.sepshn.ru)
# =============================================================================
#
# Canon Q2 2026:
#   - OpenAPI 3.0 spec с `x-yc-apigateway-integration: serverless_containers`
#   - Catch-all proxy `/{path+}` к Serverless Container backend
#   - Custom domain `demo.sepshn.ru` attached с TLS cert sepshn-wildcard
#   - CORS configured at gateway level (Origin: demo.sepshn.ru same-origin)
#   - Static SPA served via object_storage integration → bucket sepshn-demo-frontend
#     (later — пока backend-only)
#
# Reference: yandex.cloud/en/docs/api-gateway/operations/api-gw-domains

resource "yandex_api_gateway" "demo" {
  folder_id   = var.demo_folder_id
  name        = "sochi-gateway-demo"
  description = "Edge API Gateway для demo.sepshn.ru (Track A)"

  spec = templatefile("${path.module}/api_gateway_spec.yaml", {
    container_id            = yandex_serverless_container.backend.id
    runtime_service_account = yandex_iam_service_account.sochi_backend_runtime.id
    frontend_bucket         = yandex_storage_bucket.demo_frontend.bucket
  })

  # Custom domain attached via nested block (Q2 2026 canon — separate resource
  # `yandex_api_gateway_custom_domain` НЕ существует в provider v0.204).
  # Cert sepshn-wildcard уже ISSUED (verified 2026-05-19).
  custom_domains {
    fqdn           = var.demo_subdomain
    certificate_id = yandex_cm_certificate.sepshn_wildcard.id
  }

  labels = {
    managed_by  = "opentofu"
    environment = "demo"
  }

  depends_on = [yandex_serverless_container.backend]
}

output "gateway_domain" {
  description = "API Gateway managed domain (для DNS CNAME target)"
  value       = yandex_api_gateway.demo.domain
}

output "demo_url" {
  description = "Public demo URL"
  value       = "https://${var.demo_subdomain}"
}
