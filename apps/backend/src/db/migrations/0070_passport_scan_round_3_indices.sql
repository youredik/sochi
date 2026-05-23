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
-- ALL ALTERS additive. CREATE INDEX is async-build in YDB — non-blocking.
--
-- **DEFERRED: TOPIC_AUTO_PARTITIONING на CHANGEFEED**: empirical 2026-05-23
-- (local YDB 2.29.0) REJECTS `ALTER TOPIC ... SET (TOPIC_AUTO_PARTITIONING)`
-- с error «unknown topic setting». YDB supports this option ONLY at CHANGEFEED
-- CREATE time (in WITH clause), NOT via ALTER TOPIC SET. Migration 0068 already
-- created the changefeed without it; safe path = DROP CHANGEFEED + ADD CHANGEFEED
-- with full clause, but DROP loses topic offsets/consumers (data loss risk).
-- Defer until next major bump: when we need to recreate the changefeed for any
-- reason (e.g. format change), bundle the auto-partitioning option then.
-- Сейчас single-partition topic OK at current write rate (~1500/h).

-- ─── (tenantId, photoConsentLogId) indices for RTBF cascade SLA ───
-- Composite index matches WHERE clause shape exactly. GLOBAL SYNC because
-- RTBF query is consistency-critical (subject's право отзыва — cannot
-- tolerate eventual-consistency «not found» false negative).
ALTER TABLE guestDocument
    ADD INDEX idxGuestDocumentTenantConsent GLOBAL SYNC ON (tenantId, photoConsentLogId);

ALTER TABLE passportOcrAudit
    ADD INDEX idxOcrAuditTenantConsent GLOBAL SYNC ON (tenantId, photoConsentLogId);
