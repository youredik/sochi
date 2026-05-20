#!/usr/bin/env bash
#
# mirror-playwright-image.sh — mirror Microsoft Container Registry Playwright
# image to Yandex Container Registry for fast intra-DC pull in CI cubes.
#
# Empirical 2026-05-20 run #18: prepare-image-for-playwright-smoke = 114s
# (1.5GB MCR pull from cross-border RU). После mirror — ~30-50s pull из
# cr.yandex (1Gbps internal vs 100Mbps cross-border).
#
# Canon 2026 tool: `crane copy` (Google go-containerregistry).
# Direct registry-to-registry copy, NO local layer storage. Mainstream
# pattern (Depot, WarpBuild, Vercel patterns 2026).
#
# Source: github.com/google/go-containerregistry/blob/main/cmd/crane/doc/crane_copy.md
#
# Usage:
#   ./scripts/mirror-playwright-image.sh                    # default v1.60.0-noble
#   PW_VERSION=v1.61.0-noble ./scripts/mirror-playwright-image.sh
#
# Trigger: bump @playwright/test in package.json → rerun this script with
# matching tag → update ci.yaml playwright-smoke image reference.
#
# Prerequisites:
#   - `crane` (brew install crane)
#   - yc CLI profile `sepshn-new` configured

set -euo pipefail

PW_VERSION="${PW_VERSION:-v1.60.0-noble}"
SRC="mcr.microsoft.com/playwright:${PW_VERSION}"
DST_REGISTRY="${DST_REGISTRY:-cr.yandex/crp4um8fg84qoro1voi6}"
DST="${DST_REGISTRY}/playwright:${PW_VERSION}"

command -v crane >/dev/null || { echo "crane not found. brew install crane"; exit 1; }
command -v yc >/dev/null || { echo "yc CLI not found. Install Yandex Cloud CLI"; exit 1; }

echo "=== Mirror $SRC -> $DST ==="

# Temp docker config bypasses YC credential helper (which doesn't support
# direct docker login). crane reads DOCKER_CONFIG env var for auth.
TEMP_CONFIG=$(mktemp -d)
trap 'rm -rf "$TEMP_CONFIG"' EXIT

TOKEN=$(yc iam create-token --profile sepshn-new)
AUTH=$(printf "iam:%s" "$TOKEN" | base64)
cat > "$TEMP_CONFIG/config.json" <<JSON
{
  "auths": {
    "cr.yandex": { "auth": "$AUTH" }
  }
}
JSON

DOCKER_CONFIG="$TEMP_CONFIG" crane copy "$SRC" "$DST"

echo ""
echo "=== Verify ==="
DOCKER_CONFIG="$TEMP_CONFIG" crane digest "$DST"
echo ""
echo "✓ Mirrored. Update .sourcecraft/ci.yaml playwright-smoke:"
echo "  image: $DST"
