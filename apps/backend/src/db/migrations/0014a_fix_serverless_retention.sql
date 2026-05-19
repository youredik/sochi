-- =============================================================================
-- Migration 0014a — Fix retention on changefeeds applied BEFORE the
-- serverless-compat rewrite landed в migrate.ts (2026-05-19 hot-patch).
-- =============================================================================
--
-- Empirical canon Q2 2026 (verified 2026-05-19 against YC Serverless ru-central1):
--
-- YDB Serverless rejects topic configs that fit neither tier:
--     Tier A:  hours ∈ [0, 24],   storage_megabytes = 0
--     Tier B:  hours ∈ [0, 168],  storage_megabytes ∈ [51200, 1048576]
--
-- Migrations 0007 (folio), 0008 (payment), 0009 (refund), 0011 (receipt),
-- 0012 (dispute) created changefeed-derived topics с `RETENTION_PERIOD =
-- Interval("PT72H")` + default storage 0 → fit NEITHER tier. YC Serverless
-- accepted the CHANGEFEED into scheme (Enabled state) but ANY subsequent
-- `ALTER TOPIC ADD CONSUMER` fails при validation:
--
--   issueCode 1060: "retention hours and storage megabytes must fit one of:
--    { hours : [0, 24], storage : [0, 0] },
--    { hours : [0, 168], storage : [51200, 1048576] },
--    provided values: hours 72, storage 0"
--
-- Booking changefeed (0004) was fixed by 0004a (drop+recreate). For 0007-0012
-- we use `ALTER TOPIC ... SET (retention_period = ...)` which shrinks
-- retention in-place — cleaner than drop+recreate and idempotent (running
-- against an already-PT24H topic is a no-op SET).
--
-- Sort order: 0014 → 0014a → 0015. 0015 ADD CONSUMER ops succeed after
-- this normalizes parent topics к Tier A.
--
-- Going forward (0015+, 0040, 0058 etc.) migrate.ts `applyServerlessCompat`
-- transparently rewrites PT72H → PT24H at apply time, so future migrations
-- create changefeeds correctly первый раз.
--
-- =============================================================================

ALTER TOPIC `folio/folio_events` SET (RETENTION_PERIOD = Interval("PT24H"));

ALTER TOPIC `payment/payment_events` SET (RETENTION_PERIOD = Interval("PT24H"));

ALTER TOPIC `refund/refund_events` SET (RETENTION_PERIOD = Interval("PT24H"));

ALTER TOPIC `receipt/receipt_events` SET (RETENTION_PERIOD = Interval("PT24H"));

ALTER TOPIC `dispute/dispute_events` SET (RETENTION_PERIOD = Interval("PT24H"));
