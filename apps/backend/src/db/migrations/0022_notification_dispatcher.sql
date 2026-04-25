-- Migration 0022 — extend `notificationOutbox` for the dispatcher worker
-- (M7.B.1, 2026-04-26).
--
--   nextAttemptAt — exponential-backoff schedule; dispatcher polls
--     `WHERE status='pending' AND nextAttemptAt <= now()`. Without this,
--     every poll cycle re-fetches all transient-failed rows immediately,
--     blowing through retryCount in seconds.
--
--   messageId — Postbox / Yandex Cloud SES MessageId returned on 200.
--     Stored для observability + future RFC 5322 idempotency (М9 SES Raw).
--
-- Compatible with existing rows — both columns are NULLable, и worker
-- treats NULL as "ready" (initial pending row created with NULL → first
-- attempt fires immediately, then exponential backoff sets nextAttemptAt).

ALTER TABLE notificationOutbox ADD COLUMN nextAttemptAt Timestamp;
ALTER TABLE notificationOutbox ADD COLUMN messageId Utf8;
