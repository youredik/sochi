#!/usr/bin/env bash
# Verify all local infra components are healthy and reachable.
# Usage: ./scripts/verify-infra.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR/.."

echo "=== HoReCa SaaS — local infra health check ==="
echo

# --- YDB ---
echo -n "[1/3] YDB (grpc://localhost:2236) ... "
if docker compose exec -T ydb /ydb -e grpc://localhost:2236 -d /local --no-discovery sql -s "SELECT 1" >/dev/null 2>&1; then
    echo "OK"
else
    echo "FAIL"
    exit 1
fi

echo -n "       YDB monitoring UI (http://localhost:8865) ... "
if curl -sf -o /dev/null http://localhost:8865/; then
    echo "OK"
else
    echo "FAIL"
    exit 1
fi

# --- MinIO ---
echo -n "[2/3] MinIO S3 API (http://localhost:9100) ... "
if curl -sf -o /dev/null http://localhost:9100/minio/health/live; then
    echo "OK"
else
    echo "FAIL"
    exit 1
fi

echo -n "       MinIO bucket 'horeca-files' ... "
if docker compose exec -T minio mc alias set local http://localhost:9000 minioadmin minioadmin >/dev/null 2>&1 \
    && docker compose exec -T minio mc ls local/horeca-files >/dev/null 2>&1; then
    echo "OK"
else
    echo "MISSING (run: docker compose up -d minio-init)"
fi

# --- Mailpit ---
echo -n "[3/3] Mailpit SMTP (localhost:1125) ... "
if nc -z localhost 1125 2>/dev/null; then
    echo "OK"
else
    echo "FAIL"
    exit 1
fi

echo -n "       Mailpit Web UI (http://localhost:8125) ... "
if curl -sf -o /dev/null http://localhost:8125/api/v1/info; then
    echo "OK"
else
    echo "FAIL"
    exit 1
fi

echo
echo "=== All services healthy ==="
echo
echo "UIs:"
echo "  - YDB monitoring:  http://localhost:8865/"
echo "  - MinIO console:   http://localhost:9101/       (minioadmin / minioadmin)"
echo "  - Mailpit:         http://localhost:8125/"
echo
echo "Connection strings for the future backend:"
echo "  - YDB:     grpc://localhost:2236/local"
echo "  - S3:      http://localhost:9100           (minioadmin / minioadmin)"
echo "  - SMTP:    localhost:1125                  (no auth)"
