#!/usr/bin/env bash
# Oxlint type-aware ratchet gate — enforces `oxlint_type_aware_{errors,warnings}_max`
# baselines from .ratchet/baseline.json. Counts may ONLY decrease.
#
# Separated from `ratchet-check.sh` because `oxlint --type-aware` takes ~15s
# (full codebase scan with tsgolint), exceeding the pre-push 30s cap.
# Lives in post-push.yml as a BLOCKING step (macOS Sosumi RED on regression).
#
# Per-rule violation count via `pnpm oxlint:types` locally — fix priorities
# documented in `.ratchet/baseline.json _oxlint_type_aware_errors_note`.

set -euo pipefail

cd "$(dirname "$0")/.."

BASELINE_FILE=".ratchet/baseline.json"
if [ ! -f "$BASELINE_FILE" ]; then
	echo "ERROR: $BASELINE_FILE missing"
	exit 2
fi

OXLINT_OUT=$(pnpm exec oxlint --type-aware --format=github 2>&1 || true)
OXLINT_ERR=$(echo "$OXLINT_OUT" | grep -c '^::error' || true)
OXLINT_WARN=$(echo "$OXLINT_OUT" | grep -c '^::warning' || true)
OXLINT_ERR=${OXLINT_ERR:-0}
OXLINT_WARN=${OXLINT_WARN:-0}

OXLINT_ERR_MAX=$(jq -r '.oxlint_type_aware_errors_max' "$BASELINE_FILE")
OXLINT_WARN_MAX=$(jq -r '.oxlint_type_aware_warnings_max' "$BASELINE_FILE")

FAIL=0
if [ "$OXLINT_ERR" -gt "$OXLINT_ERR_MAX" ]; then
	echo "FAIL: oxlint type-aware errors $OXLINT_ERR > baseline $OXLINT_ERR_MAX"
	echo "  Local repro: pnpm oxlint:types"
	echo "  Priority rules: no-floating-promises, no-misused-promises, no-base-to-string."
	FAIL=1
fi
if [ "$OXLINT_WARN" -gt "$OXLINT_WARN_MAX" ]; then
	echo "FAIL: oxlint type-aware warnings $OXLINT_WARN > baseline $OXLINT_WARN_MAX"
	FAIL=1
fi

if [ "$FAIL" = "1" ]; then
	echo ""
	echo "Ratchet baseline: $BASELINE_FILE"
	echo "Ship the fix + lower the value in the same commit with reasoning."
	exit 1
fi

echo "Oxlint ratchet OK: errors=$OXLINT_ERR/$OXLINT_ERR_MAX warnings=$OXLINT_WARN/$OXLINT_WARN_MAX"
