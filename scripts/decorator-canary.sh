#!/usr/bin/env bash
#
# decorator-canary.sh — block decorated-class + static-getter pattern that
# crashes tsgo TS 7 (microsoft/typescript-go#3817 + #3801, OPEN 2026-05-13).
#
# Why a script rather than a Lit-class fixture:
#   - The fixture itself would crash `pnpm typecheck` (tsgo crash on
#     diagnostics). So we can't ship a "deliberate trip-wire" file inside
#     `apps/widget-embed/src/`.
#   - Instead we grep widget-embed for the anti-pattern at pre-commit time.
#     If anyone adds `static get foo()` or `static set foo()` inside a Lit
#     `@customElement` class (Phase 16 / `chore/tsgo-pilot` branch), we
#     block with a link to the upstream issue.
#
# When to remove this canary:
#   - microsoft/typescript-go#3817 CLOSED + Sochi `@typescript/native-preview`
#     bumped past the fix. Re-test: `pnpm typecheck` should NOT crash even
#     when this anti-pattern is present. Then delete this script + lefthook
#     entry.
#
# Empirical status 2026-05-13: 0 hits in `apps/widget-embed/src/` (verified
# via `grep -rEB1 'static\s+(get|set)\s+\w+' apps/widget-embed/src`).
#
set -euo pipefail

SCAN_DIR="apps/widget-embed/src"

if [ ! -d "$SCAN_DIR" ]; then
	# Working tree state where widget-embed was moved/removed — canary
	# becomes a no-op; pre-commit shouldn't fail when scope changed.
	exit 0
fi

# POSIX-portable scan (macOS default bash 3.x — no mapfile).
hits_file=$(mktemp -t decorator-canary)
trap 'rm -f "$hits_file"' EXIT

# Find files with Lit `@customElement` AND `static (get|set) <name>`.
# Two-pass grep — outer filters to Lit-decorated files, inner finds the
# crash trigger.
grep -rl '@customElement' "$SCAN_DIR" 2>/dev/null | while IFS= read -r f; do
	if grep -nE 'static[[:space:]]+(get|set)[[:space:]]+[A-Za-z_]' "$f" >/dev/null 2>&1; then
		echo "$f" >>"$hits_file"
	fi
done

if [ -s "$hits_file" ]; then
	cat >&2 <<'EOF'
============================================================
DECORATOR CANARY: tsgo TS 7 crash pattern detected
============================================================
Files using Lit `@customElement` AND a `static (get|set) <name>`:

EOF
	while IFS= read -r f; do
		echo "  - $f" >&2
		grep -nE 'static[[:space:]]+(get|set)[[:space:]]+[A-Za-z_]' "$f" | sed 's/^/      /' >&2
	done <"$hits_file"
	cat >&2 <<'EOF'

This pattern crashes tsgo per microsoft/typescript-go#3817 + #3801
(OPEN as of 2026-05-13). Workaround: convert the static accessor to a
non-static getter or a class field. When the upstream issue closes and
`@typescript/native-preview` is bumped past the fix, this canary may
be removed (see header of scripts/decorator-canary.sh).
============================================================
EOF
	exit 1
fi

exit 0
