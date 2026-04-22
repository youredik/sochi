#!/usr/bin/env bash
# Apply schema migrations to local YDB via docker compose exec.
# Idempotent — YDB CREATE TABLE will fail harmlessly on existing tables; schema stays.
#
# Usage: ./scripts/apply-schema.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_ROOT"

YDB_ENDPOINT="grpc://localhost:2236"
YDB_DATABASE="/local"

echo "[apply-schema] Waiting for YDB to become healthy..."
for i in {1..30}; do
    if docker compose exec -T ydb /ydb -e "$YDB_ENDPOINT" -d "$YDB_DATABASE" --no-discovery sql -s "SELECT 1" >/dev/null 2>&1; then
        echo "[apply-schema] YDB is ready."
        break
    fi
    if [[ $i -eq 30 ]]; then
        echo "[apply-schema] ERROR: YDB did not become healthy in 30 attempts." >&2
        exit 1
    fi
    sleep 2
done

echo "[apply-schema] Applying schema/0001_init.yql..."
docker compose exec -T ydb /ydb \
    -e "$YDB_ENDPOINT" \
    -d "$YDB_DATABASE" \
    --no-discovery \
    sql -f /schema/0001_init.yql

echo "[apply-schema] Verifying tables..."
# scheme ls returns names space-separated on one line. Normalize to newlines then match.
LISTING=$(docker compose exec -T ydb /ydb \
    -e "$YDB_ENDPOINT" \
    -d "$YDB_DATABASE" \
    --no-discovery \
    scheme ls /local 2>/dev/null | tr -s ' \t\r\n' '\n')

EXPECTED=(user superAdmin session account verification organization organizationProfile member invitation
          property roomType room ratePlan booking guest
          job webhookInbox migrationReport consentLog)

MISSING=()
for tbl in "${EXPECTED[@]}"; do
    if ! grep -qx "$tbl" <<<"$LISTING"; then
        MISSING+=("$tbl")
    fi
done

FOUND=$((${#EXPECTED[@]} - ${#MISSING[@]}))
echo "[apply-schema] Tables present: $FOUND / ${#EXPECTED[@]}"

if [[ ${#MISSING[@]} -gt 0 ]]; then
    echo "[apply-schema] MISSING: ${MISSING[*]}" >&2
    exit 1
fi

echo "[apply-schema] Schema applied successfully."
