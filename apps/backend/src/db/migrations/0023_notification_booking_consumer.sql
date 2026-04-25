-- Migration 0023 — register `notification_writer` consumer on
-- `booking/booking_events` so booking_confirmed notifications fire on
-- booking INSERT (M7.B.3, 2026-04-26).
--
-- The same `notification_writer` handler is bound to multiple topics; the
-- factory call selects the source variant ('booking' vs 'payment' vs
-- 'receipt') and the deriveKind() inside maps status transitions accordingly.
-- Idempotent via existing ixNotificationDedup UNIQUE on
-- (tenantId, sourceEventDedupKey).

ALTER TOPIC `booking/booking_events` ADD CONSUMER notification_writer;
