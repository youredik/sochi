#!/usr/bin/env bash
# Round 12 R12V-2 systemic fix — assert frontend `_demo/` api-client BASE
# constants match backend `_demo/index.ts` mount paths. Prevents the
# Round 9-shipped bug where Ostrovok api-client had an extra `/api/b2b/v3`
# suffix that the backend did NOT serve, breaking the entire Ostrovok demo
# flow в UI while unit tests greenwashed «correctness» с the wrong path
# pinned.
#
# Backend mount canonical site:
#   apps/backend/src/domains/_demo/index.ts → app.route('/api/_mock-ota/<channel>/v1', ...)
# Frontend BASE canonical sites (discovered via glob — Round 12 self-review SR-3):
#   apps/frontend/src/_demo/**/api-client.ts → `const [BASE|API_BASE] = '...'`
#
# Algorithm:
#   1. Grep backend mount lines, extract path strings.
#   2. Glob ALL frontend `_demo/**/api-client.ts` files (covers future channels
#      added beyond yandex/ostrovok — was hardcoded к 2 files в первой версии,
#      catched by self-review as P1 brittleness).
#   3. For each frontend BASE, check it MATCHES exactly one backend mount.
#   4. Print mismatches + exit 1.
#
# This is a STATIC check (~50ms) — safe для pre-commit.

set -euo pipefail

cd "$(dirname "$0")/.."

BACKEND_FILE='apps/backend/src/domains/_demo/index.ts'

if [ ! -f "$BACKEND_FILE" ]; then
	echo "WARN: $BACKEND_FILE missing — skipping API-BASE consistency check"
	exit 0
fi

# Backend mounts — grep `app.route('/api/_mock-ota/<channel>/v1', ...)`
backend_mounts=$(
	grep -oE "app\.route\('[^']+',? " "$BACKEND_FILE" | grep -oE "'[^']+'" | tr -d "'" || true
)

if [ -z "$backend_mounts" ]; then
	echo "WARN: no backend mounts grepped from $BACKEND_FILE — skipping"
	exit 0
fi

# Round 12 self-review SR-3 — glob discover ALL api-client.ts files в _demo
# subtrees. Catches future channels (travel-line/booking-com/etc) added beyond
# the two hardcoded paths. Skips api-client.test.ts (tests pin URLs, не source).
frontend_files=$(
	find apps/frontend/src/_demo -name 'api-client.ts' -not -name '*.test.ts' 2>/dev/null || true
)

if [ -z "$frontend_files" ]; then
	echo "WARN: no frontend api-client.ts found via glob — skipping"
	exit 0
fi

fail=0
checked=0
while IFS= read -r file; do
	[ -z "$file" ] && continue
	frontend_bases=$(
		grep -oE "^const [A-Z_]*BASE\s*=\s*'[^']+'" "$file" | grep -oE "'[^']+'" | tr -d "'" || true
	)
	if [ -z "$frontend_bases" ]; then
		echo "[skip] $file — no BASE constant grepped"
		continue
	fi
	while IFS= read -r base; do
		[ -z "$base" ] && continue
		checked=$((checked + 1))
		if ! echo "$backend_mounts" | grep -qx "$base"; then
			echo "[$file] FAIL: frontend BASE='$base' does NOT match any backend mount"
			echo "  backend mounts:"
			echo "$backend_mounts" | sed 's/^/    /'
			fail=1
		fi
	done <<<"$frontend_bases"
done <<<"$frontend_files"

if [ "$fail" -ne 0 ]; then
	echo
	echo "Round 12 R12V-2 canon: frontend api-client BASE must match the backend"
	echo "mount path verbatim. If you need a different shape for adapter parity,"
	echo "update BOTH sides symmetrically."
	exit 1
fi

backend_count=$(echo "$backend_mounts" | wc -l | tr -d ' ')
echo "API-BASE consistency OK ($backend_count backend mounts <-> $checked frontend bases aligned)"
