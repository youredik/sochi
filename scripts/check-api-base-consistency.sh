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
# Frontend BASE canonical sites:
#   apps/frontend/src/_demo/ota-showcase/yandex/api-client.ts → `const API_BASE = '...'`
#   apps/frontend/src/_demo/ota-showcase/ostrovok/api-client.ts → `const BASE = '...'`
#
# Algorithm:
#   1. Grep backend mount lines, extract path strings.
#   2. Grep frontend BASE/API_BASE lines, extract path strings.
#   3. For each frontend BASE, check it MATCHES exactly one backend mount.
#   4. Print mismatches + exit 1.
#
# This is a STATIC check (~50ms) — safe для pre-commit. Layered into ratchet.

set -euo pipefail

cd "$(dirname "$0")/.."

BACKEND_FILE='apps/backend/src/domains/_demo/index.ts'
YANDEX_FILE='apps/frontend/src/_demo/ota-showcase/yandex/api-client.ts'
OSTROVOK_FILE='apps/frontend/src/_demo/ota-showcase/ostrovok/api-client.ts'

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

fail=0
check_frontend() {
	local file="$1"
	local label="$2"
	if [ ! -f "$file" ]; then return; fi
	# Match `const FOO_BASE = '...'` OR `const BASE = '...'`
	local frontend_bases
	frontend_bases=$(
		grep -oE "^const [A-Z_]*BASE\s*=\s*'[^']+'" "$file" | grep -oE "'[^']+'" | tr -d "'" || true
	)
	if [ -z "$frontend_bases" ]; then
		echo "[$label] no BASE constant grepped from $file"
		return
	fi
	while IFS= read -r base; do
		if ! echo "$backend_mounts" | grep -qx "$base"; then
			echo "[$label] FAIL: frontend BASE='$base' does NOT match any backend mount"
			echo "  backend mounts:"
			echo "$backend_mounts" | sed 's/^/    /'
			fail=1
		fi
	done <<<"$frontend_bases"
}

check_frontend "$YANDEX_FILE" yandex
check_frontend "$OSTROVOK_FILE" ostrovok

if [ "$fail" -ne 0 ]; then
	echo
	echo "Round 12 R12V-2 canon: frontend api-client BASE must match the backend"
	echo "mount path verbatim. If you need a different shape for adapter parity,"
	echo "update BOTH sides symmetrically."
	exit 1
fi

echo "API-BASE consistency OK ($(echo "$backend_mounts" | wc -l | tr -d ' ') backend mounts, frontend bases aligned)"
