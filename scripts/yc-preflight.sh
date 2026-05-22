#!/usr/bin/env bash
# yc-preflight.sh — verify yc CLI active profile + cloud + folder match
# Sepshn's canonical IDs BEFORE running any yc-touching script.
#
# Usage:  source scripts/yc-preflight.sh
# Returns non-zero if mismatch (caller may `set -e` to abort).
#
# Per `[[feedback_yc_profile_canon_2026_05_22]]` — каждая yc-команда против
# wrong cloud creates orphan resources / pays на чужой billing. 2026-05-22
# инцидент: SmartCaptcha создалась в STANKOFF cloud вместо SEPSHN, пришлось
# удалить + recreate. Этот script ловит class заранее.

set -u

EXPECTED_CLOUD="b1gisf466novulsg0a0n"          # sepshn cloud (new, 2026-05-20+)
EXPECTED_FOLDER="b1gp4bo808jr6qvrnltu"          # infra folder (consolidated)
EXPECTED_ORG="bpfar26apvm2ljel57ta"             # org Сэпшн

actual_cloud="$(yc config get cloud-id 2>/dev/null || true)"
actual_folder="$(yc config get folder-id 2>/dev/null || true)"
active_profile="$(yc config profile list 2>/dev/null | awk '/ACTIVE/{print $1}')"

ok=1
if [[ "$actual_cloud" != "$EXPECTED_CLOUD" ]]; then
    echo "❌ yc CLI cloud mismatch:"
    echo "   expected: $EXPECTED_CLOUD (sepshn-new)"
    echo "   actual:   $actual_cloud  (profile=$active_profile)"
    echo "   fix:      yc config profile activate sepshn-new"
    ok=0
fi

if [[ "$actual_folder" != "$EXPECTED_FOLDER" ]]; then
    echo "❌ yc CLI folder mismatch:"
    echo "   expected: $EXPECTED_FOLDER (infra — TF-consolidated)"
    echo "   actual:   $actual_folder"
    echo "   fix:      yc config set folder-id $EXPECTED_FOLDER"
    ok=0
fi

if [[ $ok -eq 1 ]]; then
    echo "✓ yc CLI: profile=$active_profile, cloud=sepshn, folder=infra"
fi

# Source-time `return` if sourced, `exit` if executed directly.
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
    [[ $ok -eq 1 ]] && exit 0 || exit 1
else
    [[ $ok -eq 1 ]] || return 1
    return 0
fi
