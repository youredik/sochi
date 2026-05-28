#!/usr/bin/env bash
#
# coverage-gate.sh — aggregate backend coverage floor (CI audit 2026-05-29).
#
# Why this exists: bun's built-in `coverageThreshold` (bunfig.toml) is checked
# PER-FILE, not aggregate — empirically unusable as a project floor (any single
# low-coverage file fails any positive threshold). This script parses the
# «All files» summary row from `bun test --coverage --coverage-reporter=text`
# and enforces an AGGREGATE floor on functions + lines.
#
# Floor calibrated 2026-05-29 from fast-suite (no-YDB, as CI quality runner sees):
# 76.24% funcs / 82.56% lines. Floors set just below — ratchet canon: don't break
# at start, catch >~2% regression. Raise as coverage grows (like weak_assertions).
#
# Usage: bash scripts/coverage-gate.sh   (run from repo root; cwd-independent)
# Exit: 0 if both metrics >= floor, 1 otherwise (CI cube fails → blocks deploy).

set -euo pipefail

FUNC_FLOOR="${COVERAGE_FUNC_FLOOR:-74.0}"
LINE_FLOOR="${COVERAGE_LINE_FLOOR:-80.0}"

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT/apps/backend"

echo "Running backend coverage (fast suite, no-YDB)…"
# text reporter → parsed for the aggregate gate; lcov → coverage/lcov.info for
# the CI artifact (SourceCraft 14-day retention). Ignore db tests (need YDB,
# absent in CI quality runner) — matches the suite test-fast cube runs.
COV_OUT="$(bun test --coverage --coverage-reporter=text --coverage-reporter=lcov \
  --path-ignore-patterns='**/*.db.test.ts' 2>&1)"

# «All files» row: `All files  |   76.24 |   82.56 |`  → $2 funcs, $3 lines.
SUMMARY_LINE="$(echo "$COV_OUT" | grep -E '^All files' | tail -1)"
if [ -z "$SUMMARY_LINE" ]; then
	echo "FAIL: could not find 'All files' coverage summary row"
	echo "$COV_OUT" | tail -30
	exit 1
fi

FUNCS="$(echo "$SUMMARY_LINE" | awk -F'|' '{gsub(/ /,"",$2); print $2}')"
LINES="$(echo "$SUMMARY_LINE" | awk -F'|' '{gsub(/ /,"",$3); print $3}')"

echo "Coverage — funcs=${FUNCS}% (floor ${FUNC_FLOOR}%) lines=${LINES}% (floor ${LINE_FLOOR}%)"

# Float compare via awk (POSIX shell has no float arithmetic).
FAIL=0
awk "BEGIN{exit !($FUNCS < $FUNC_FLOOR)}" && {
	echo "FAIL: function coverage ${FUNCS}% < floor ${FUNC_FLOOR}%"
	FAIL=1
}
awk "BEGIN{exit !($LINES < $LINE_FLOOR)}" && {
	echo "FAIL: line coverage ${LINES}% < floor ${LINE_FLOOR}%"
	FAIL=1
}

if [ "$FAIL" -ne 0 ]; then
	echo "coverage-gate FAILED — раскрыть регрессию или поднять покрытие"
	exit 1
fi

echo "coverage-gate PASSED"
