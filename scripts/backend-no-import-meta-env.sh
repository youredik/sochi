#!/usr/bin/env bash
#
# backend-no-import-meta-env.sh — block `import.meta.env` in backend code.
#
# Why: Bun #21097 (OPEN 2026-05-13) — `import.meta.env` empties to `{}` in
# `bun build --compile` distroless binary, silently dropping env-dependent
# code paths. Bun test runtime also does not populate `import.meta.env` the
# way Vite does (oven-sh/bun#4667). Backend must use `process.env.*`.
#
# Canon source: phase_16_closure_done half-measures inventory item #6
# ("Bun #21097 import.meta.env in --compile breaks — backend audited
# (0 hits) but worth a lint rule to prevent accidental addition").
#
# When to remove this canary:
#   - oven-sh/bun#21097 CLOSED + Sochi `bun` bumped past the fix, AND
#   - oven-sh/bun#4667 CLOSED so test-runtime semantics match Vite, AND
#   - we decide backend should adopt `import.meta.env` for any reason.
# Until all three: keep the guard.
#
# Empirical status 2026-05-13: 0 hits in `apps/backend/src/`.
#
set -euo pipefail

SCAN_DIRS=(
	"apps/backend/src"
	"packages/shared/src"
)

hits_file=$(mktemp -t bk-no-iom-env)
trap 'rm -f "$hits_file"' EXIT

for dir in "${SCAN_DIRS[@]}"; do
	[ -d "$dir" ] || continue
	# Pattern: `import.meta.env` token (any usage — read, deref, spread).
	# Whitespace between dots forbidden by the same grep — TS forbids it
	# syntactically, so a tight `\.` match suffices.
	grep -rnE 'import\.meta\.env' "$dir" 2>/dev/null \
		| grep -v -E '(^|/)[^:]*\.(test|spec)\.(ts|tsx|js|mjs)' >>"$hits_file" || true
done

if [ -s "$hits_file" ]; then
	cat >&2 <<'EOF'
============================================================
BACKEND CANARY: `import.meta.env` not allowed in backend code
============================================================
Found `import.meta.env` references outside test files:

EOF
	sed 's/^/  /' "$hits_file" >&2
	cat >&2 <<'EOF'

Reason:
  - Bun #21097 (OPEN): `import.meta.env` empties to {} in `bun build
    --compile` — distroless prod binary drops env-dependent branches.
  - Bun #4667 (OPEN): test runtime does not Vite-replace `import.meta.env`.

Use `process.env.<VAR>` instead — universal across Bun build/test/run
and Node. See feedback_bun_test_canons_2026_05_13 memory for canon.
============================================================
EOF
	exit 1
fi

exit 0
