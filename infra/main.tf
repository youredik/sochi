# =============================================================================
# Sepshn IaC — root module (Q2 2026 canon, May 2026)
# =============================================================================
#
# Tool: OpenTofu 1.10+ (license-clean MPL-2.0 fork of Terraform 1.5.x)
# Provider: yandex-cloud/yandex ~> 0.204 (May 2026, MPL-2.0)
#
# OpenTofu + YC empirical status (May 2026):
#   - Provider live в OpenTofu registry namespace `opentofu/yandex` (community
#     fork, до v0.127). Empirical 2026-05-19: 13 imports applied successfully.
#   - Latest 0.204 via Hashicorp registry URL ниже (`source = "registry.terraform.io/..."`)
#     OR через YC mirror `terraform-mirror.yandexcloud.net` в `~/.tofurc`.
#   - OpenTofu canon Q2 2026 для license-clean stack. Stankoff на Terraform —
#     inertia с April 2026, не technical блокер.
#
# State backend:
#   - YC Object Storage `sepshn-tfstate` (S3-compatible)
#   - SSE-KMS encryption via KMS key `tfstate-encryption`
#   - Native S3 conditional-write locking (`use_lockfile = true`,
#     OpenTofu 1.10+ canon — replaces YDB Document table)
#   - Bucket versioning enabled (rollback от accidental `tofu destroy`)
#
# Bootstrap reproducer: infra/_bootstrap/bootstrap.sh
#
# Auth canon:
#   - Local: `YC_TOKEN` env var via `yc iam create-token`
#   - CI: SourceCraft Service Connection (OIDC) → ephemeral IAM token
#   - S3 backend: AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY env (tf-bot static)

terraform {
  required_version = ">= 1.10"

  required_providers {
    yandex = {
      # Hashicorp registry URL — latest 0.204 (vs 0.127 в opentofu/yandex fork).
      # Empirically works with OpenTofu 1.12 (verified 2026-05-19 — 13 imports).
      # Alternative: `~/.tofurc` mirror к `terraform-mirror.yandexcloud.net`.
      source  = "registry.terraform.io/yandex-cloud/yandex"
      version = "~> 0.204"
    }
    # Yandex Cloud Postbox = SESv2 API-compatible. AWS provider используется
    # для управления Postbox identities/DKIM (canon pattern, см. yc-postbox-tf
    # github.com/yandex-cloud-examples/yc-postbox-tf).
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.89"
    }
    # `time_sleep` — bridge YC IAM eventual consistency (~5-30s) между
    # `*_iam_member` create и downstream resources that depend на role taking effect.
    time = {
      source  = "hashicorp/time"
      version = "~> 0.13"
    }
    # `random_password` для secrets generation (BETTER_AUTH_SECRET etc).
    # Hash через state — plaintext encrypted в S3+KMS state bucket.
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }

  # YC Object Storage S3-compatible backend.
  # Auth: AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY env vars (tf-bot static key).
  # Docs: yandex.cloud/docs/tutorials/infrastructure-management/terraform-state-storage
  backend "s3" {
    endpoints = {
      s3 = "https://storage.yandexcloud.net"
    }
    bucket = "sepshn-tfstate-v2"
    key    = "infra/terraform.tfstate"
    region = "ru-central1"

    skip_region_validation      = true
    skip_credentials_validation = true
    skip_requesting_account_id  = true
    skip_s3_checksum            = true

    # Native S3 conditional-write locking via `If-None-Match: *` PUT (OpenTofu 1.10+
    # canon, verified at yandex.cloud/en/docs/storage/operations/objects/upload).
    # Replaces YDB Document table lock pattern — simpler, fewer moving parts.
    use_lockfile = true
  }
}

# Yandex Cloud provider — auth via env vars (YC_TOKEN или YC_SERVICE_ACCOUNT_KEY_FILE),
# никакого conditional в HCL. cloud_id + folder_id из tfvars.
provider "yandex" {
  cloud_id = var.yc_cloud_id
  zone     = "ru-central1-d"
}
