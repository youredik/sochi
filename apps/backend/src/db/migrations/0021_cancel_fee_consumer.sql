-- Migration 0021 — register the `cancel_fee_writer` CDC consumer on
-- `booking/booking_events`.
--
-- Driven by M7.A.4 (2026-04-26). Handler fires on transitions:
--   oldStatus !== 'cancelled' && newStatus === 'cancelled' → post cancellationFee
--   oldStatus !== 'no_show'   && newStatus === 'no_show'   → post noShowFee
--
-- Fee snapshots live on booking.cancellationFee / booking.noShowFee Json
-- columns (snapshotted at booking creation per rate plan policy).
--
-- Idempotency via deterministic line id `cancelFee_<bookingId>` /
-- `noShowFee_<bookingId>` (PK collision = no-op).

ALTER TOPIC `booking/booking_events` ADD CONSUMER cancel_fee_writer;
