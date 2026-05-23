-- 0066_passport_scan_ttl.sql — Sprint B 2026-05-22 native YDB TTL для двух tables.
--
-- WHY native TTL вместо application-level cron:
--   - Zero application code (no scheduled task, no error handling)
--   - YDB удаляет в background automatically (per documentation)
--   - Atomicity-safe (no race between write + cleanup)
--   - Aligns с canon: 0001_init session/verification, 0004_booking_m4 activity,
--     0004_booking_m4 idempotencyKey — все используют native TTL
--
-- ─── photoConsentLog: 5 лет (152-ФЗ ст.5 ч.7 «не дольше необходимого») ───
-- + миграционное законодательство ст.21 ч.7 + Roskomnadzor 5-year inspection.
-- P1825D = 5 × 365 days. Без cron — native sweep.
ALTER TABLE photoConsentLog SET (TTL = Interval("P1825D") ON createdAt);
ALTER TABLE photoConsentLog SET (AUTO_PARTITIONING_BY_LOAD = ENABLED);

-- ─── passportOcrAudit: 90 дней (per 0037 doc + 152-ФЗ ст.21 ч.7) ───
-- Existing rows старше 90 дней будут удалены при первом TTL sweep после apply.
-- Это OK — pre-Sprint-B rows писались mock-only из тестов (no real PII).
ALTER TABLE passportOcrAudit SET (TTL = Interval("P90D") ON createdAt);
