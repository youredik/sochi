-- 0058_channel_changefeeds.sql — M10 / A7.1.fix
-- per project_event_architecture.md canon: «CDC-first outbox + polymorphic
-- activity table; default для всех доменов с audit/events».
--
-- Adds CHANGEFEED on channelDispatch (0052) + channelInbox (0053) tables +
-- activity_writer consumers. After this migration:
--   * Every INSERT/UPDATE/DELETE на channelDispatch row эмитится в
--     `channelDispatch/channelDispatch_events` topic (NEW_AND_OLD_IMAGES JSON).
--   * Every INSERT/UPDATE/DELETE на channelInbox row эмитится в
--     `channelInbox/channelInbox_events` topic.
--   * `activity_writer` consumer projects events → activity rows
--     (created / statusChange / fieldChange / deleted) per cdc-handlers.ts canon.
--
-- Why audit MUST для channel manager events:
--   - Operator timeline visibility: pending → sent | dlq | disabled per
--     dispatch + tampered/duplicate/processed per inbox.
--   - 152-ФЗ ст.6 ч.3 + cross-border-transfer compliance: audit trail
--     обязателен для PII flowing через external recipients.
--   - Admin overlay (A7.5) drills down к timeline of fake-sync events
--     (mock/sandbox modes) and real events (live mode).
--
-- RETENTION_PERIOD = 72h: matches folio_events / migrationRegistration_events.
-- Activity projection runs continuously, so events processed long before
-- retention expiry. 72h covers consumer downtime within YC Serverless cap.

ALTER TABLE channelDispatch ADD CHANGEFEED channelDispatch_events WITH (
    MODE = 'NEW_AND_OLD_IMAGES',
    FORMAT = 'JSON',
    VIRTUAL_TIMESTAMPS = TRUE,
    RETENTION_PERIOD = Interval("PT72H"),
    TOPIC_AUTO_PARTITIONING = 'ENABLED'
);

ALTER TOPIC `channelDispatch/channelDispatch_events` ADD CONSUMER `activity_writer`;

ALTER TABLE channelInbox ADD CHANGEFEED channelInbox_events WITH (
    MODE = 'NEW_AND_OLD_IMAGES',
    FORMAT = 'JSON',
    VIRTUAL_TIMESTAMPS = TRUE,
    RETENTION_PERIOD = Interval("PT72H"),
    TOPIC_AUTO_PARTITIONING = 'ENABLED'
);

ALTER TOPIC `channelInbox/channelInbox_events` ADD CONSUMER `activity_writer`;
