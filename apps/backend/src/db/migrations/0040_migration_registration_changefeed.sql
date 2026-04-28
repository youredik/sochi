-- 0040_migration_registration_changefeed.sql — M8.A.5.cdc.B
-- per project_event_architecture.md canon: «CDC-first outbox + polymorphic
-- activity table; default для всех доменов с audit/events».
--
-- Adds CHANGEFEED on migrationRegistration table + activity_writer consumer.
-- After this migration:
--   * Every INSERT/UPDATE/DELETE на migrationRegistration row эмитится в
--     `migrationRegistration/migrationRegistration_events` topic (NEW_AND_OLD_IMAGES JSON).
--   * `activity_writer` consumer projects events → activity rows
--     (created / statusChange / fieldChange / deleted) per cdc-handlers.ts canon.
--
-- Why audit MUST для миграционного учёта:
--   - 152-ФЗ ст.6 ч.3: audit trail обязателен для compliance ops с PII.
--   - Operator UI (M8.A.6) показывает timeline: «черновик создан →
--     submit → polled → finalized | refused» по audit rows.
--   - Forensic trace: при ЕПГУ-разногласиях нужно показать full transition
--     history (когда / кем / какой статус).
--
-- RETENTION_PERIOD = 72h: same as folio_events. Local Docker default; Yandex
-- Cloud Serverless caps at 24h, deploy migration will ALTER TOPIC if needed.
-- Activity projection runs continuously, so events processed long before
-- retention expiry. 72h is safety net на consumer downtime.
--
-- Forward-compat: M8.A.5.cancel + M8.A.5.note дополнительные status
-- transitions (10 = manually cancelled, operatorNote field add) тоже будут
-- проектироваться через этот же consumer без миграции — diff captures
-- automatically per cdc-handlers SYSTEM_FIELDS skip-list.

ALTER TABLE migrationRegistration ADD CHANGEFEED migrationRegistration_events WITH (
    MODE = 'NEW_AND_OLD_IMAGES',
    FORMAT = 'JSON',
    VIRTUAL_TIMESTAMPS = TRUE,
    RETENTION_PERIOD = Interval("PT72H"),
    TOPIC_AUTO_PARTITIONING = 'ENABLED'
);

ALTER TOPIC `migrationRegistration/migrationRegistration_events` ADD CONSUMER `activity_writer`;
