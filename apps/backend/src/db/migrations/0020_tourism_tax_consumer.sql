-- Migration 0020 — register the `tourism_tax_writer` CDC consumer on
-- `booking/booking_events`.
--
-- Driven by M7.A.3 (2026-04-26):
--   - Apaleo Russia / TravelLine canon: tourism tax посттится AT CHECK-OUT
--     одной строкой, не per-night. Handler fires когда status crosses INTO
--     'checked_out' и computes tax per НК РФ ст. 418 (база — стоимость
--     accommodation БЕЗ НДС/turNalog, минимум 100 ₽ × ночей × номеров).
--   - Idempotency: deterministic folioLine.id `tax_<bookingId>` — PK collision
--     = no-op, replay safe. Handler ALSO pre-checks PK, чтобы избежать
--     UPSERT-overwrite race в случае concurrent CDC redelivery.

ALTER TOPIC `booking/booking_events` ADD CONSUMER tourism_tax_writer;
