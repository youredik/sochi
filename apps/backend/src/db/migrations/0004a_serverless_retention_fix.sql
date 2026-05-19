-- =============================================================================
-- Migration 0004a — Fix CHANGEFEED retention to fit YDB Serverless contract
-- =============================================================================
--
-- Empirical canon Q2 2026 (verified 2026-05-19 on YC Serverless ru-central1):
--
-- YDB Serverless rejects topic configs that fit neither tier:
--     Tier A:  hours ∈ [0, 24],    storage = 0          (in-memory queue)
--     Tier B:  hours ∈ [0, 168],   storage ∈ [50, 1024] GB (persistent)
--
-- Migration 0004 created `booking/booking_events` with
-- `RETENTION_PERIOD = Interval("PT72H")` + default storage 0 →
-- belongs to NEITHER tier. YC Serverless accepts the CHANGEFEED INTO
-- `scheme describe` (Enabled state, visible to read paths) BUT silently
-- corrupts internal topic metadata, so the FIRST `ALTER TOPIC ADD CONSUMER`
-- attempt fails при ExecuteAlterTopic с issueCode 1060:
--
--   "retention hours and storage megabytes must fit one of:
--    { hours : [0, 24], storage : [0, 0] },
--    { hours : [0, 168], storage : [51200, 1048576] },
--    provided values: hours 72, storage 0"
--
-- Fix: drop the broken changefeed, recreate with `PT24H` (Tier A — fits
-- in-memory queue, no persistent storage tier needed for our 24h replay
-- budget). Demo deployment doesn't need >24h replay; at-least-once consumer
-- recovery is offset-based, not retention-based.
--
-- 0004 itself remains immutable (historical record). Fresh deployments
-- still execute 0004 with PT72H first, then this fix immediately overwrites.
-- The brief PT72H window during cold boot is harmless — no consumer
-- attached yet, no read traffic.
--
-- Production-grade alternative (Dedicated YDB): PT72H works natively.
-- This migration is a no-op on Dedicated — DROP+ADD with same MODE/FORMAT
-- semantically idempotent.
--
-- =============================================================================

ALTER TABLE booking DROP CHANGEFEED booking_events;

ALTER TABLE booking ADD CHANGEFEED booking_events WITH (
    MODE = 'NEW_AND_OLD_IMAGES',
    FORMAT = 'JSON',
    VIRTUAL_TIMESTAMPS = TRUE,
    RETENTION_PERIOD = Interval("PT24H"),
    TOPIC_AUTO_PARTITIONING = 'ENABLED'
);
