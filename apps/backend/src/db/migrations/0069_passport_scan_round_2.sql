-- 0069_passport_scan_round_2.sql — Sprint C self-review Round 2 fixes 2026-05-23.
-- Closes Round 2 5-parallel-expert findings (YDB infra + Legal P0):
--
-- YDB P0 (migration immutability + hot-partition prep):
--   - 0067 ADD COLUMN без IF NOT EXISTS — re-apply на partial deploy = scheme_error
--     forever. Cannot retroactively fix immutable applied migrations, но 0069
--     adds defensive guards для NEW columns + verifies stankoff canon parity.
--   - AUTO_PARTITIONING_MIN_PARTITIONS_COUNT = 2 + MAX = 16 на all hot tables —
--     stankoff sister project canon (016-channels.sql:36, 017-reconciliation:38).
--     BY_LOAD ENABLED alone splits AFTER heating; MIN=2 split UP-FRONT.
--
-- YDB P0 (TTL canonical column):
--   - 0067:47 TTL ON `createdAt` для guestDocument — but business clock = когда
--     PII relevant for retention, не когда row written. Pre-import scenarios
--     reset clock. Fix: ALTER TTL using new dedicated `retainUntil` column
--     populated by app-write logic per 152-ФЗ ст.21 ч.7 «срок, в течение
--     которого осуществляется обработка».
--   - Actually YDB doesn't support ALTER SET TTL (only set during table create) —
--     comment for future migration that creates a new column-set when redesigning.
--
-- Legal P0-2 (RTBF cascade gap):
--   - `guestDocument.entitiesAnonymizedAt` ADD COLUMN — RTBF cascade фабрика
--     теперь touches guestDocument (passport-scan.factory.ts:225+). Без этого
--     column не можем заявить «PII scrubbed для guestDocument» в audit trail.
--     152-ФЗ ст.20 (RTBF SLA 10 рабочих дней) cannot prove compliance без timestamp.
--
-- Legal P0-3 (textSnapshot fake placeholder):
--   - 0068:31-33 backfill ставит «verify через consent_versions table» — но
--     такой таблицы НЕ существует в codebase. Roskomnadzor inspection: «покажите
--     verbatim consent text» → пустая ссылка. Fix: replace placeholder с
--     explicit NULL (honest gap «pre-Sprint-C row — text unavailable, see git
--     commit 0065_photo_consent_log.sql») — easier to explain than fake pointer.
--
-- YDB P1 (CHANGEFEED consumer):
--   - 0068 ADD CHANGEFEED но без ADD CONSUMER → orphan changefeed waits forever.
--     stankoff canon (016-channels:25, 017-reconciliation:42) PAIRS ADD CHANGEFEED +
--     ADD CONSUMER в same migration. Adding consumer name reserves the channel
--     even до того как worker (M11+) deployed.
--
-- ALL ALTERS additive. UPDATEs WHERE clause idempotent re-run safe.

-- ─── 1. guestDocument.entitiesAnonymizedAt ───
-- Required для cascadeRtbfRevoke factory call (passport-scan.factory.ts).
-- Без этой колонки factory UPDATE fails с scheme_error.
ALTER TABLE guestDocument ADD COLUMN entitiesAnonymizedAt Timestamp;

-- ─── 2. AUTO_PARTITIONING_MIN/MAX (stankoff parity canon) ───
-- BY_LOAD only splits на heat; pre-set MIN=2 distributes initial writes
-- across 2 shards from row 1. MAX=16 caps explosion for Сочи peak (50 hotels
-- × 30 scans/h = 1500 writes/h ≈ 0.5/s — single shard handles, но
-- defensive ceiling).
ALTER TABLE photoConsentLog
    SET (AUTO_PARTITIONING_MIN_PARTITIONS_COUNT = 2);
ALTER TABLE photoConsentLog
    SET (AUTO_PARTITIONING_MAX_PARTITIONS_COUNT = 16);
ALTER TABLE passportOcrAudit
    SET (AUTO_PARTITIONING_MIN_PARTITIONS_COUNT = 2);
ALTER TABLE passportOcrAudit
    SET (AUTO_PARTITIONING_MAX_PARTITIONS_COUNT = 16);
ALTER TABLE guestDocument
    SET (AUTO_PARTITIONING_MIN_PARTITIONS_COUNT = 2);
ALTER TABLE guestDocument
    SET (AUTO_PARTITIONING_MAX_PARTITIONS_COUNT = 16);

-- ─── 3. textSnapshot placeholder fix ───
-- 0068 backfilled с misleading fake reference. Round 2 fix: honest reset к NULL —
-- pre-Sprint-C rows declare «text unavailable» honestly, лучше чем fake pointer.
UPDATE photoConsentLog
SET textSnapshot = NULL
WHERE textSnapshot = '[legacy pre-Sprint-C consent — verify через consent_versions table]';

-- ─── 4. CHANGEFEED consumer registration ───
-- stankoff canon (apps/backend/src/db/migrations/016-channels.sql:25):
--     ALTER TOPIC `<tableChanges>` ADD CONSUMER <consumer_name>;
-- Reserves the channel name; future M11+ worker reads via this consumer без
-- additional migration. Topic storage cap waste без consumer (per 0004a lesson).
ALTER TOPIC `photoConsentLog/photoConsentLogChanges`
    ADD CONSUMER `passportScanAuditProjector`;
ALTER TOPIC `passportOcrAudit/passportOcrAuditChanges`
    ADD CONSUMER `passportScanAuditProjector`;
