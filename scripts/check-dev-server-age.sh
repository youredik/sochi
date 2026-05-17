#!/usr/bin/env bash
# 2026-05-17 — Pre-flight check для dev-server staleness
# (per `[[dev-server-staleness-canon]]` 2026-05-17).
#
# **Why this exists**: Vite HMR does NOT reload on:
#   - `vite.config.ts` changes (e.g. new plugins like vite-plugin-pwa)
#   - Newly added dependencies (`pnpm add foo` after dev start)
#   - TanStack Router `routeTree.gen.ts` regenerations
#   - Service Worker registration changes
#   - `packages/shared/*` Zod schema changes (consumed by frontend)
#
# Caught 2026-05-17 in user-facing session: dev server ran 2 days 10 hours
# through G3+G4+G5+G6+G7+G8+G9+G10+G11 commits. UI served stale code while
# Claude debug-cycled phantom data issues for 5+ minutes. Cost of restart =
# 3 seconds (Vite ready in 706ms). Cost of NOT checking = entire session.
#
# **Behaviour**:
#   - Exit 0 + no output если dev server fresh enough
#   - Exit 0 + WARN on stderr если stale (non-blocking — script is advisory)
#   - Compares server start time vs `vite.config.ts` + `package.json` mtime
#
# **Hooked into lefthook `pre-commit`** as advisory (non-blocking) check —
# print warning, never block the commit. Operator decides whether к restart.

set -uo pipefail

# Default frontend port; override с PORT env for staging/preview.
FRONTEND_PORT="${FRONTEND_PORT:-5273}"

# Locate listening PID on that port. macOS + Linux compatible via lsof.
SERVER_PID="$(lsof -i ":${FRONTEND_PORT}" -P 2>/dev/null | awk '$NF~/LISTEN/{print $2; exit}')"

if [ -z "$SERVER_PID" ]; then
	# No dev server running — no staleness possible.
	exit 0
fi

# Elapsed seconds since process start. macOS `ps` only supports `etime`
# (string format `[[DD-]HH:]MM:SS`), NOT `etimes` (Linux extension).
# Parse manually для cross-platform reliability.
ETIME_RAW="$(ps -p "$SERVER_PID" -o etime= 2>/dev/null | tr -d ' ')"
if [ -z "$ETIME_RAW" ]; then
	exit 0
fi

# Parse `[[DD-]HH:]MM:SS` → seconds. Splits on `-` then `:`.
case "$ETIME_RAW" in
	*-*) DAYS="${ETIME_RAW%%-*}"; HMS="${ETIME_RAW#*-}";;
	*)   DAYS=0; HMS="$ETIME_RAW";;
esac
# Pad HMS к HH:MM:SS if shorter.
case "$HMS" in
	*:*:*) ;;
	*:*)   HMS="00:$HMS";;
	*)     HMS="00:00:$HMS";;
esac
HH="${HMS%%:*}"
REST="${HMS#*:}"
MM="${REST%%:*}"
SS="${REST#*:}"
# strip leading zeros (avoid octal interpretation в arithmetic)
HH=$((10#$HH))
MM=$((10#$MM))
SS=$((10#$SS))
ELAPSED_SEC=$((DAYS * 86400 + HH * 3600 + MM * 60 + SS))

# 12h ceiling — most Vite-config / dep changes happen within a session.
# Long-running servers across days reliably miss canonical reloads.
MAX_AGE_SEC=$((12 * 60 * 60))

# Files whose mtime forces a restart even если age < ceiling.
RESTART_TRIGGERS=(
	"apps/frontend/vite.config.ts"
	"apps/frontend/package.json"
	"packages/shared/src" # дает rough «shared schema touched» signal
	"pnpm-lock.yaml"
)

WARN_REASON=""

if [ "$ELAPSED_SEC" -gt "$MAX_AGE_SEC" ]; then
	HOURS=$((ELAPSED_SEC / 3600))
	WARN_REASON="uptime ${HOURS}h > 12h ceiling"
else
	# Compute server start epoch from `now - elapsed` — portable arithmetic
	# avoids `ps -o lstart=` quirks (column-name parse differs macOS/Linux).
	NOW_EPOCH="$(date +%s)"
	START_EPOCH=$((NOW_EPOCH - ELAPSED_SEC))
	for trigger in "${RESTART_TRIGGERS[@]}"; do
		if [ -e "$trigger" ]; then
			# Recursively find newest mtime under trigger (handles dirs).
			# `stat -f '%m'` is macOS BSD-stat; Linux GNU-stat would use `-c %Y`.
			# Pre-commit runs on developer machines (macOS-primary in this team).
			NEWEST="$(find "$trigger" -type f -exec stat -f '%m' {} \; 2>/dev/null | sort -nr | head -1)"
			if [ -n "$NEWEST" ] && [ "$NEWEST" -gt "$START_EPOCH" ]; then
				WARN_REASON="${trigger} modified after server start"
				break
			fi
		fi
	done
fi

if [ -n "$WARN_REASON" ]; then
	# Yellow ANSI warning к stderr (advisory, non-blocking).
	# Operator restart command: kill PID + `pnpm --filter @horeca/frontend dev`
	# OR for full env: `pnpm dev:all` (if defined).
	printf '\033[33m⚠ dev-server (PID %s on port %s) potentially stale: %s\n' "$SERVER_PID" "$FRONTEND_PORT" "$WARN_REASON" >&2
	printf '  Restart: kill %s && pnpm --filter @horeca/frontend dev\033[0m\n' "$SERVER_PID" >&2
fi

exit 0
