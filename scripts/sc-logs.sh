#!/usr/bin/env bash
#
# sc-logs.sh — fetch SourceCraft CI cube logs without UI.
#
# Usage:
#   ./scripts/sc-logs.sh <run> <workflow> <task> <cube> [page]
#   ./scripts/sc-logs.sh 11 quality quality test-fast
#   ./scripts/sc-logs.sh 11 deploy deploy-backend revision-deploy
#
# Convenience variants:
#   ./scripts/sc-logs.sh status [N]       — list last N runs (default 5)
#   ./scripts/sc-logs.sh tree <run>       — show full cube tree of one run
#   ./scripts/sc-logs.sh last-failed      — dump logs of all failed cubes in last run
#
# Env vars:
#   SC_PAT          — Personal Access Token (required)
#   SC_ORG          — Organization slug (default: sepshn)
#   SC_REPO         — Repository slug (default: sepshn)
#
# See docs/sourcecraft-api.md for the full API reference.

set -euo pipefail

# Auto-load SC_PAT из .env если не set в shell. Canon 2026-05-22 — token
# persisted в gitignored .env file, future sessions автоматически подхватывают.
if [[ -z "${SC_PAT:-}" && -f "$(dirname "$0")/../.env" ]]; then
	# shellcheck disable=SC1090,SC1091
	set -a
	source "$(dirname "$0")/../.env"
	set +a
fi

: "${SC_PAT:?SC_PAT not set. Put SC_PAT=pv1_... в .env или export shell env. Token из https://sourcecraft.dev/security/tokens}"
ORG="${SC_ORG:-sepshn}"
REPO="${SC_REPO:-sepshn}"
API="https://api.sourcecraft.tech"

curl_sc() {
    curl -sS -H "Authorization: Bearer $SC_PAT" "$@"
}

# Python helpers — use sys.stdin + .format() (escape-free in bash single-quotes)
PY_STATUS='import sys, json
data = json.load(sys.stdin)
for run in data["runs"]:
    # Pad with NUL-replacement: pipe-separator keeps single-line awk parseable
    print("Run #{}|{}|started {}".format(run["slug"], run["status"], run["dates"]["started_at"]))
    for wf in run.get("workflows", []):
        print("  {}|{}".format(wf["slug"], wf["status"]))
'

PY_TREE='import sys, json
data = json.load(sys.stdin)
print("Run #{}: {}".format(data["slug"], data["status"]))
for wf in data["workflows"]:
    print("  workflow {}: {}".format(wf["slug"], wf["status"]))
    for task in wf.get("tasks", []):
        print("    task {}: {}".format(task["slug"], task["status"]))
        for cube in task.get("cubes", []):
            marker = " (failed)" if cube["status"] == "failed" else ""
            print("      cube {}: {}{}".format(cube["slug"], cube["status"], marker))
'

PY_FAILED_TRIPLES='import sys, json
data = json.load(sys.stdin)
for wf in data["workflows"]:
    for task in wf.get("tasks", []):
        for cube in task.get("cubes", []):
            if cube["status"] == "failed" and not cube["slug"].startswith("#"):
                print(wf["slug"] + "\t" + task["slug"] + "\t" + cube["slug"])
'

PY_EXTRACT_LOGS='import sys, json
print(json.load(sys.stdin).get("logs", "<no logs>"))
'

PY_LAST_RUN_SLUG='import sys, json
print(json.load(sys.stdin)["runs"][0]["slug"])
'

cmd_status() {
    local limit="${1:-5}"
    curl_sc "$API/repos/$ORG/$REPO/cicd/runs?limit=$limit" | python3 -c "$PY_STATUS"
}

cmd_tree() {
    local run="$1"
    curl_sc "$API/repos/$ORG/$REPO/cicd/runs/$run" | python3 -c "$PY_TREE"
}

cmd_last_failed() {
    local last_run
    last_run=$(curl_sc "$API/repos/$ORG/$REPO/cicd/runs?limit=1" | python3 -c "$PY_LAST_RUN_SLUG")
    echo "=== Run #$last_run — failed cubes ==="

    local failed_list
    failed_list=$(curl_sc "$API/repos/$ORG/$REPO/cicd/runs/$last_run" | python3 -c "$PY_FAILED_TRIPLES")

    if [ -z "$failed_list" ]; then
        echo "No failed cubes in run #$last_run."
        return
    fi

    while IFS=$'\t' read -r wf task cube; do
        echo ""
        echo ">>> $wf/$task/$cube"
        echo "----------------------------------------------------------------"
        curl_sc "$API/repos/$ORG/$REPO/cicd/logs/$last_run/$wf/$task/$cube" \
            | python3 -c "$PY_EXTRACT_LOGS" | tail -60
    done <<< "$failed_list"
}

cmd_log() {
    local run="$1" wf="$2" task="$3" cube="$4" page="${5:-1}"
    curl_sc "$API/repos/$ORG/$REPO/cicd/logs/$run/$wf/$task/$cube?page=$page" | python3 -c "$PY_EXTRACT_LOGS"
}

case "${1:-help}" in
    status)       shift; cmd_status "$@" ;;
    tree)         shift; cmd_tree "$@" ;;
    last-failed)  shift; cmd_last_failed "$@" ;;
    help|"")      sed -n '3,18p' "$0" | sed 's/^# //;s/^#//' ;;
    *)
        if [ $# -lt 4 ]; then
            echo "Usage: $0 <run> <workflow> <task> <cube> [page]" >&2
            echo "       $0 status [N] | tree <run> | last-failed | help" >&2
            exit 1
        fi
        cmd_log "$@"
        ;;
esac
