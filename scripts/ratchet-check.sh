#!/usr/bin/env bash
# Ratchet check — fails CI/pre-push if any tracked metric regresses past
# `.ratchet/baseline.json`. Adapted from stankoff-v2 canonical pattern
# (`fix(test): vitest 4 isolate:false` lineage 2026-05-08).
#
# Doctrine: each metric is "max allowed". If a check ships above baseline,
# the gate fails. To improve: ship the fix + lower baseline value in same
# commit (reviewer sees both diffs).
#
# Run: bash scripts/ratchet-check.sh
#
# Excluded by design (documented in baseline.json `_excluded`):
#   - mutation_score   — too slow for per-PR ratchet; on-demand Stryker only
#   - biome_warnings   — hygiene track, not a regression gate
#   - test_leaks       — Vitest 4 false positives на Promise.race losing
#                         branches per stankoff research 2026-04-25

set -euo pipefail

cd "$(dirname "$0")/.."

BASELINE_FILE=".ratchet/baseline.json"
if [ ! -f "$BASELINE_FILE" ]; then
	echo "ERROR: $BASELINE_FILE missing — cannot ratchet without baseline"
	exit 2
fi

read_baseline() {
	jq -r ".${1}" "$BASELINE_FILE"
}

FAIL=0

# 1. depcruise — file path / DAG / cross-domain rule violations
DEPCR_OUT=$(pnpm depcruise 2>&1 || true)
DEPCR=$(echo "$DEPCR_OUT" | grep -oE '[0-9]+ violation' | head -1 | grep -oE '^[0-9]+' || echo 0)
DEPCR_MAX=$(read_baseline depcruise_violations_max)
if [ "$DEPCR" -gt "$DEPCR_MAX" ]; then
	echo "FAIL: depcruise $DEPCR > baseline $DEPCR_MAX"
	FAIL=1
fi

# 2. knip — unused exports/files/deps
# `set +o pipefail` localized so empty output (clean knip) deterministically
# yields 0 instead of pipeline-error noise.
KNIP_OUT=$(pnpm knip --no-progress 2>&1 || true)
KNIP=$(set +o pipefail; echo "$KNIP_OUT" | grep -oE '\([0-9]+\)' | grep -oE '[0-9]+' | awk '{s+=$1} END {print (s==""?0:s)}')
KNIP_MAX=$(read_baseline knip_unused_max)
if [ "$KNIP" -gt "$KNIP_MAX" ]; then
	echo "FAIL: knip $KNIP > baseline $KNIP_MAX"
	FAIL=1
fi

# 3. pnpm audit high+critical (CVE gate)
AUDIT_OUT=$(pnpm audit --audit-level=high --json 2>/dev/null || true)
AUDIT=$(echo "$AUDIT_OUT" | jq '[.advisories // {} | to_entries[].value | select(.severity == "high" or .severity == "critical")] | length' 2>/dev/null || echo 0)
AUDIT_MAX=$(read_baseline audit_high_critical_max)
if [ "$AUDIT" -gt "$AUDIT_MAX" ]; then
	echo "FAIL: audit high+critical $AUDIT > baseline $AUDIT_MAX"
	FAIL=1
fi

# 4. typecheck (strict mode errors)
# `pnpm typecheck` is canonical = tsgo parallel (TS 7 Beta, Phase 4 full
# 2026-05-12). Microsoft endorsement: TS 7 Beta «ready for CI pipelines
# today» (devblog 2026-04-21). Pilot baseline: 0 divergence vs tsc on
# full codebase; known issues (Storybook hang #3335, --build mode, JSDoc
# generics) — none apply. Audit trail: post-push.yml shadow diff-runner.
# Triage path on suspect failure: `pnpm typecheck:fallback` (parallel tsc).
if ! pnpm typecheck > /dev/null 2>&1; then
	TS_ERR=1
else
	TS_ERR=0
fi
TS_MAX=$(read_baseline ts_strict_errors_max)
if [ "$TS_ERR" -gt "$TS_MAX" ]; then
	echo "FAIL: typecheck errors $TS_ERR > baseline $TS_MAX"
	FAIL=1
fi

# 5. Biome errors (not warnings — those are hygiene track per `_excluded`)
BIOME_OUT=$(pnpm lint --reporter=summary 2>&1 || true)
BIOME_ERR=$(echo "$BIOME_OUT" | grep -oE 'Found [0-9]+ errors?' | head -1 | grep -oE '[0-9]+' || echo 0)
BIOME_MAX=$(read_baseline biome_errors_max)
if [ "$BIOME_ERR" -gt "$BIOME_MAX" ]; then
	echo "FAIL: biome errors $BIOME_ERR > baseline $BIOME_MAX"
	FAIL=1
fi

# 6. Weak assertions — Contract-First violation per `feedback_strict_tests.md`.
# Counts `.toBeDefined() / .toBeTruthy() / .toBeFalsy() / .toBeInstanceOf(Array)`
# in test files. Replace with concrete expected values (`toBe`/`toEqual`) или
# `schema.parse()` для contract enforcement.
#
# `--exclude-dir` set: Stryker leaves untracked sandbox copies of the entire
# `apps/backend/src/` tree under `.stryker-tmp/sandbox-XXXXXX/` (gitignored)
# during/after mutation runs — without exclusion the same assertions are
# counted N+1 times и pre-push falsely fails. node_modules / dist excluded
# defensively даже though глобы restrict to `.test.{ts,tsx}` already.
WEAK_ASSERTIONS=$( { grep -rcE '\.toBeDefined\(\)|\.toBeTruthy\(\)|\.toBeFalsy\(\)|\.toBeInstanceOf\(Array\)' apps packages --include='*.test.ts' --include='*.test.tsx' --exclude-dir='.stryker-tmp' --exclude-dir='node_modules' --exclude-dir='dist' 2>/dev/null || true; } | awk -F: '{s+=$2} END {print (s==""?0:s)}')
WEAK_MAX=$(read_baseline weak_assertions_max)
if [ "$WEAK_ASSERTIONS" -gt "$WEAK_MAX" ]; then
	echo "FAIL: weak assertions $WEAK_ASSERTIONS > baseline $WEAK_MAX"
	echo "  Replace с конкретными values (toBe/toEqual) или schema.parse() для contract enforcement."
	echo "  See feedback_strict_tests.md canon."
	FAIL=1
fi

# 7. Multi-line `// biome-ignore` anti-pattern — biome-ignore comments only
# suppress the IMMEDIATELY NEXT line. Multi-line continuations leak. Caught
# 2026-05-12 in M10 backend tests (channel-dispatcher.test.ts + webhook.routes.test.ts).
# Counts comment-line-followed-by-comment-line patterns starting with `// biome-ignore`.
MULTI_BI=$( { grep -rE '^\s*// biome-ignore' apps packages --include='*.ts' --include='*.tsx' --exclude-dir='.stryker-tmp' --exclude-dir='node_modules' --exclude-dir='dist' -A 1 2>/dev/null | grep -cE '^.*-\s*//[^[:alnum:]]' || true; } | head -1 || echo 0)
MULTI_BI=${MULTI_BI:-0}
MULTI_BI_MAX=$(read_baseline multi_line_biome_ignore_max)
if [ "$MULTI_BI" -gt "$MULTI_BI_MAX" ]; then
	echo "FAIL: multi-line biome-ignore $MULTI_BI > baseline $MULTI_BI_MAX"
	echo "  Multi-line // biome-ignore only suppresses NEXT line. Move it directly above the violation."
	FAIL=1
fi

if [ "$FAIL" = "1" ]; then
	echo ""
	echo "Ratchet baseline: $BASELINE_FILE"
	echo "If improvement is shipped, lower the value in same commit with reasoning."
	exit 1
fi

echo "Ratchet OK: depcruise=$DEPCR knip=$KNIP audit_high=$AUDIT ts_err=$TS_ERR biome_err=$BIOME_ERR weak_assertions=$WEAK_ASSERTIONS multi_biome_ignore=$MULTI_BI"
# Note: oxlint_type_aware_{errors,warnings}_max baselines tracked in
# .ratchet/baseline.json but enforced via `scripts/oxlint-ratchet-check.sh`
# in post-push.yml (BLOCKING). The ~15s runtime exceeds pre-push 30s cap;
# post-push runs the full safety net before macOS Sosumi RED notification.
