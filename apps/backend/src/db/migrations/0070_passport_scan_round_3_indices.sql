-- 0070_passport_scan_round_3_indices.sql — Sprint C+ 5-expert audit fixes 2026-05-23d.
-- Closes round-3 audit findings (YDB + Senior):
--
-- YDB P0 (RTBF cascade full-scan):
--   - cascadeRtbfRevoke (passport-scan.factory.ts:198-209) queries:
--       SELECT objectStoragePath FROM guestDocument
--       WHERE tenantId = ? AND photoConsentLogId = ?;
--     and:
--       findObjectKeysByConsentId on passportOcrAudit (same predicate).
--     Both tables have NO index on (tenantId, photoConsentLogId) → full-table
--     scan per revoke. At 100k scans/tenant, scan ≈ seconds. 152-ФЗ ст.20
--     право отзыва + ст.21 ч.5 30-day SLA — current code fits SLA easily,
--     но index is canonical для production scale + Roskomnadzor read-replica.
--
-- YDB P0 (hot-shard prevention on changefeed topics):
--   - 0068 ADD CHANGEFEED omitted `TOPIC_AUTO_PARTITIONING = 'ENABLED'` —
--     stankoff canon (0004:118, 0008:137, 0040:34, 0058:31,41) ALL set it.
--     Under hot-tenant burst (Сочи peak: 50 hotels × 30 scans/h = 1500 writes/h),
--     single topic partition becomes throughput bottleneck. Enable splitting.
--
-- ALL ALTERS additive. CREATE INDEX is async-build in YDB — non-blocking.

-- ─── 1. (tenantId, photoConsentLogId) indices for RTBF cascade SLA ───
-- Composite index matches WHERE clause shape exactly. GLOBAL SYNC because
-- RTBF query is consistency-critical (subject's право отзыва — cannot
-- tolerate eventual-consistency «not found» false negative).
ALTER TABLE guestDocument
    ADD INDEX idxGuestDocumentTenantConsent GLOBAL SYNC ON (tenantId, photoConsentLogId);

ALTER TABLE passportOcrAudit
    ADD INDEX idxOcrAuditTenantConsent GLOBAL SYNC ON (tenantId, photoConsentLogId);

-- ─── 2. TOPIC_AUTO_PARTITIONING for new CHANGEFEED topics ───
-- stankoff canon: 0004a_serverless_retention_fix.sql:46 sets this at
-- ADD CHANGEFEED time. 0068 missed it — patch via ALTER TOPIC.
-- Tier A constraint (YDB Serverless): retention stays at PT24H — see 0004a
-- comment for empirical Tier A/B boundary. We don't touch retention here.
ALTER TOPIC `photoConsentLog/photoConsentLogChanges`
    SET (TOPIC_AUTO_PARTITIONING = 'ENABLED');

ALTER TOPIC `passportOcrAudit/passportOcrAuditChanges`
    SET (TOPIC_AUTO_PARTITIONING = 'ENABLED');
