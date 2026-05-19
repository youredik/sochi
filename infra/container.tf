# =============================================================================
# Serverless Container — backend (Hono + Bun --compile, distroless)
# =============================================================================
#
# Canon Q2 2026:
#   - Image от Container Registry (с SHA pin OR :latest для first-deploy)
#   - PORT env auto-injected by YC — backend reads via process.env.PORT
#   - Secrets через `secrets {}` block с Lockbox secret_ref (НЕ env value)
#   - Runtime SA с container-registry.images.puller (см. registry.tf) +
#     lockbox.payloadViewer (см. lockbox.tf) + ydb.editor (см. iam.tf)
#   - provisioned_instances=2 (mirror stankoff canon) для warm path
#   - concurrency=4 per Stankoff post-OOM tune (M8.B research)

variable "container_image_tag" {
  description = "Backend image tag (:sha for prod, :latest для first-deploy fallback)"
  type        = string
  default     = "latest"
}

variable "container_memory_mb" {
  description = "Container memory (MB). 1024 default per Stankoff canon после OOM tune."
  type        = number
  default     = 1024
}

variable "container_concurrency" {
  description = "Max concurrent requests per instance"
  type        = number
  default     = 4
}

variable "container_provisioned" {
  description = "Pre-warmed instances (0 = cold-start OK, 2 = stankoff canon)"
  type        = number
  default     = 2
}

resource "yandex_serverless_container" "backend" {
  folder_id          = var.demo_folder_id
  name               = "sochi-backend-demo"
  description        = "Demo backend (Hono + Bun --compile, distroless): demo.sepshn.ru/api/*"
  memory             = var.container_memory_mb
  cores              = 1
  core_fraction      = 100
  concurrency        = var.container_concurrency
  execution_timeout  = "30s"
  service_account_id = yandex_iam_service_account.sochi_backend_runtime.id

  provision_policy {
    min_instances = var.container_provisioned
  }

  image {
    url = "cr.yandex/${yandex_container_registry.sepshn_cr.id}/backend:${var.container_image_tag}"

    # Backend reads PORT from env (YC auto-injects). Other env vars
    # для demo deployment — Mock-адаптеры активны по DEMO_DEPLOYMENT=true,
    # YDB connection auto-derived, остальное defaults.
    environment = {
      APP_MODE                         = "sandbox"
      NODE_ENV                         = "production"
      LOG_LEVEL                        = "info"
      DEMO_DEPLOYMENT                  = "true"
      HOST                             = "demo.sepshn.ru"
      PUBLIC_BASE_URL                  = "https://demo.sepshn.ru"
      BETTER_AUTH_URL                  = "https://demo.sepshn.ru"
      BETTER_AUTH_TRUSTED_ORIGINS      = "https://demo.sepshn.ru"
      YDB_CONNECTION_STRING            = yandex_ydb_database_serverless.demo.ydb_full_endpoint
      # Use metadata service для IAM token (Q2 2026 canon — no SA key file).
      # SDK polls 169.254.169.254 при container start.
      YDB_METADATA_CREDENTIALS         = "1"
      PAYMENT_PROVIDER                 = "stub"
      VISION_PROVIDER                  = "mock"
      POSTBOX_ENABLED                  = "false"
      APP_MODE_PERMITTED_MOCK_ADAPTERS = "email.demo-inbox,sms.demo-inbox,payment.stub,vision.mock"

      # S3 non-secret: endpoint + region + bucket name (canon — secrets via Lockbox)
      S3_ENDPOINT = "https://storage.yandexcloud.net"
      S3_REGION   = "ru-central1"
      S3_BUCKET   = yandex_storage_bucket.demo_backend_files.bucket

      # Email — demo использует DemoInboxAdapter (capture-only).
      EMAIL_FROM_ADDRESS = "noreply@demo.sepshn.ru"
      EMAIL_FROM_NAME    = "Sochi HoReCa Demo"
    }
  }

  # Lockbox secret refs (Q2 2026 canon): высоко-чувствительные creds через
  # Lockbox runtime resolve. Container instances cache до 5 минут после revoke.
  secrets {
    id                   = yandex_lockbox_secret.backend.id
    version_id           = yandex_lockbox_secret_version_hashed.backend.id
    key                  = "BETTER_AUTH_SECRET"
    environment_variable = "BETTER_AUTH_SECRET"
  }

  secrets {
    id                   = yandex_lockbox_secret.backend.id
    version_id           = yandex_lockbox_secret_version_hashed.backend.id
    key                  = "S3_ACCESS_KEY_ID"
    environment_variable = "S3_ACCESS_KEY_ID"
  }

  secrets {
    id                   = yandex_lockbox_secret.backend.id
    version_id           = yandex_lockbox_secret_version_hashed.backend.id
    key                  = "S3_SECRET_ACCESS_KEY"
    environment_variable = "S3_SECRET_ACCESS_KEY"
  }

  labels = {
    managed_by  = "opentofu"
    environment = "demo"
  }

  # CI manages image revisions via `yc-actions/yc-sls-container-deploy@v4` —
  # TF ignores image[0].url drift к не revert revisions при routine `tofu apply`.
  # env vars / secrets / resources stay под TF management (image block is the
  # only CI-mutable surface). Q2 2026 canon (verified empirically May 19).
  lifecycle {
    ignore_changes = [image[0].url]
  }

  depends_on = [
    yandex_container_registry_iam_binding.runtime_puller,
    yandex_resourcemanager_folder_iam_member.runtime_lockbox_viewer,
  ]
}

output "backend_container_id" {
  description = "Backend Serverless Container ID для API Gateway integration"
  value       = yandex_serverless_container.backend.id
}
