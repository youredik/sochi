# =============================================================================
# Serverless Container — backend (Node 24 Alpine + pnpm deploy --legacy)
# =============================================================================
#
# Canon Q2 2026 (verified empirically 2026-05-19):
#   - Image от Container Registry с SHA pin (current: cf4bc2c-flatten — see
#     handover_2026_05_19 в memory for revision lineage)
#   - Runtime: Node 24 Alpine + `node --import=amaro/strip src/index.ts`
#     (Bun --compile abandoned — bundler не copies .node native deps; see
#     Dockerfile commentary). 6 CVEs vs Debian slim 27.
#   - PORT env auto-injected by YC — backend reads via process.env.PORT
#   - Secrets через `secrets {}` block с Lockbox secret_ref (НЕ env value)
#   - Runtime SA с container-registry.images.puller (см. registry.tf) +
#     lockbox.payloadViewer (см. lockbox.tf) + ydb.editor (см. iam.tf) +
#     storage.viewer/editor на frontend bucket (для API Gateway integration)
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
  description = <<-EOT
    Pre-warmed instances. Default `1` для demo: `DemoInboxAdapter` стейт
    in-memory per instance — multi-instance создаёт 50/50 race для prospect
    polling. Production track когда переходит к real SMTP сможет вернуть к
    `2` (stankoff canon). Per `[[demo_inbox_multi_instance_canon_2026_05_22]]`.
  EOT
  type        = number
  default     = 1
}

resource "yandex_serverless_container" "backend" {
  folder_id          = yandex_resourcemanager_folder.demo.id
  name               = "sochi-backend-demo"
  description        = "Demo backend (Node 24 Alpine + Hono): demo.sepshn.ru/api/*"
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
      APP_MODE                    = "sandbox"
      NODE_ENV                    = "production"
      LOG_LEVEL                   = "info"
      DEMO_DEPLOYMENT             = "true"
      HOST                        = "demo.sepshn.ru"
      PUBLIC_BASE_URL             = "https://demo.sepshn.ru"
      BETTER_AUTH_URL             = "https://demo.sepshn.ru"
      BETTER_AUTH_TRUSTED_ORIGINS = "https://demo.sepshn.ru"
      YDB_CONNECTION_STRING       = yandex_ydb_database_serverless.demo.ydb_full_endpoint
      # Use metadata service для IAM token (Q2 2026 canon — no SA key file).
      # SDK polls 169.254.169.254 при container start.
      YDB_METADATA_CREDENTIALS = "1"
      PAYMENT_PROVIDER         = "stub"
      VISION_PROVIDER          = "mock"
      # Phase 2 2026-05-22: Postbox active для dual-write (DemoInbox capture +
      # real email через Postbox). Backend `createEmailAdapter` factory routes
      # via DEMO_DEPLOYMENT=true → DemoInboxAdapter(downstream=PostboxAdapter).
      POSTBOX_ENABLED                  = "true"
      POSTBOX_ENDPOINT                 = "https://postbox.cloud.yandex.net"
      APP_MODE_PERMITTED_MOCK_ADAPTERS = "email.demo-inbox,sms.demo-inbox,payment.stub,vision.mock"

      # S3 non-secret: endpoint + region + bucket name (canon — secrets via Lockbox)
      S3_ENDPOINT = "https://storage.yandexcloud.net"
      S3_REGION   = "ru-central1"
      S3_BUCKET   = yandex_storage_bucket.demo_backend_files.bucket

      # Email — Phase 2 dual-write: DemoInboxAdapter captures + PostboxAdapter
      # sends real email. From address must match Postbox identity (sepshn.ru).
      EMAIL_FROM_ADDRESS = "noreply@sepshn.ru"
      EMAIL_FROM_NAME    = "Сэпшн"
      # Reply-To: recipient'ы жмущие «Reply» направляются к живому Yandex 360
      # inbox `hi@sepshn.ru` (manual setup в admin.yandex.ru — см. bootstrap.md
      # шаг 2.3). До настройки inbox — отвечать будут bounce'ить, no harm.
      EMAIL_REPLY_TO_ADDRESS = "hi@sepshn.ru"
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

  # SmartCaptcha server-key — bootstrap'нут в отдельный Lockbox secret
  # вне TF state (issue #492 — server_key not exposed via TF). Когда vars
  # smartcaptcha_lockbox_secret_id + _version_id заполнены (после bootstrap.md
  # шага 2), container mounts SMARTCAPTCHA_SERVER_KEY env var.
  # Default empty vars → block skipped → captcha disabled (backend canon
  # `captcha-gate.ts` пропускает запросы без validation если no key).
  dynamic "secrets" {
    for_each = var.smartcaptcha_lockbox_secret_id != "" ? [1] : []
    content {
      id                   = var.smartcaptcha_lockbox_secret_id
      version_id           = var.smartcaptcha_lockbox_version_id
      key                  = "SMARTCAPTCHA_SERVER_KEY"
      environment_variable = "SMARTCAPTCHA_SERVER_KEY"
    }
  }

  # DaData API key — bootstrap'нут в отдельный Lockbox secret вне TF state
  # (mirror SmartCaptcha pattern — никогда не trip через tofu state).
  # Default empty vars → block skipped → backend creates mock-dadata
  # (only 4 canonical Сочи ИНН lookupable). Live API enables full onboarding.
  dynamic "secrets" {
    for_each = var.dadata_lockbox_secret_id != "" ? [1] : []
    content {
      id                   = var.dadata_lockbox_secret_id
      version_id           = var.dadata_lockbox_version_id
      key                  = "DADATA_API_KEY"
      environment_variable = "DADATA_API_KEY"
    }
  }

  # Postbox sender AWS-style creds (2026-05-22 Phase 2 activated).
  # Reuses `backend` Lockbox bundle — TF auto-derives current version_id
  # via `yandex_lockbox_secret_version_hashed.backend.id`. CI deploy-backend
  # cube must mirror these `--secret` flags AND reference matching version
  # else apply ↔ CI revision races (TF wins eventually after operator
  # syncs SC secret `YC_LOCKBOX_VERSION_ID`).
  secrets {
    id                   = yandex_lockbox_secret.backend.id
    version_id           = yandex_lockbox_secret_version_hashed.backend.id
    key                  = "POSTBOX_ACCESS_KEY_ID"
    environment_variable = "POSTBOX_ACCESS_KEY_ID"
  }
  secrets {
    id                   = yandex_lockbox_secret.backend.id
    version_id           = yandex_lockbox_secret_version_hashed.backend.id
    key                  = "POSTBOX_SECRET_ACCESS_KEY"
    environment_variable = "POSTBOX_SECRET_ACCESS_KEY"
  }

  labels = {
    managed_by  = "opentofu"
    environment = "demo"
  }

  # Image revisions managed OUT-OF-BAND of TF: currently manual via `yc
  # serverless container revision deploy ...` (Day 0/1 deploy log). Future:
  # `.sourcecraft/ci.yaml` deploy workflow (currently .draft pending syntax
  # verify, see handover_2026_05_19). TF ignores image[0].url drift к не
  # revert revision pin при routine `tofu apply`. Env vars / secrets /
  # resources stay под TF management. Q2 2026 canon — stankoff-v2 mirror.
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
