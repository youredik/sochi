-- 0063_room_type_night_slot.sql — Variant 3 «strongest possible» overbooking-prevention (2026-05-18)
--
-- Closes Gap F-unassigned (final piece of overbooking-prevention canon).
-- Migration 0062 added `roomNightOccupancy` for PINNED bookings (assigned к
-- specific physical room). This migration adds `roomTypeNightSlot` for ALL
-- bookings — including unassigned ones — by allocating an integer slot
-- 0..(allotment+oversellDelta-1) per night per roomType.
--
-- Combined invariant:
--   - `roomTypeNightSlot` PK uniqueness prevents > effective-allotment
--     bookings on same (roomType, date), even if all are unassigned.
--   - `roomNightOccupancy` PK uniqueness prevents two pinned bookings on
--     same (room, date).
--
-- Bypass routes that previously slipped through:
--   - Seed scripts that UPSERT booking rows directly without going through
--     booking.repo — now fail PK collision on slot table if they try к
--     write a booking that overflows the per-night allotment.
--   - Channel-manager pushes that bypass repo — same.
--   - Manual `UPSERT INTO booking` from operator console — same.
--
-- Slot allocation algorithm (in booking.repo.create per night):
--   1. SELECT existing slotNumbers for (tenantId, propertyId, roomTypeId, date)
--   2. Pick lowest free `slot ∈ [0, allotment+oversellDelta)` not in existing
--   3. INSERT slot row — PK collision = race lost, tx rolls back, idempotent retry
--   4. NoInventoryError if all slots taken (sold >= effective allotment)
--
-- Coexists с `availability.sold` counter (defense-in-depth):
--   - `availability.sold` = fast aggregate count, used by API endpoints
--     showing «N rooms left» (single-row read).
--   - `roomTypeNightSlot` = per-slot detail, INVARIANT enforcement.
--   Both updated atomically in the same `sql.begin` tx.
--
-- Lifecycle (matches sold-counter semantics):
--   - INSERT on `booking.create`, `moveDates` new-nights, `changeRoomType`
--     new-roomType nights, `checkIn` (no slot change unless dates change).
--   - DELETE on `cancel`, `checkOut`, `changeRoomType` old-roomType nights,
--     `moveDates` old-nights.
--   - KEEP on `markNoShow` (consistent с sold-retain canon).
--
-- Canon refs:
--   - `[[overbooking-prevention-canon-2026-05-18]]` (extends migration 0062)
--   - Agent research 2026-05-18 «Variant 3 strongest possible» — slot
--     allocation pattern, PK-as-invariant, defense-in-depth
--   - `[[no-half-measures]]` — close Gap F-unassigned at DB level, not app
--   - `[[silent-clamp-anti-pattern]]` — NoInventoryError throw, no silent
--     drop когда allotment exhausted

CREATE TABLE roomTypeNightSlot (
    tenantId    Utf8 NOT NULL,
    propertyId  Utf8 NOT NULL,
    roomTypeId  Utf8 NOT NULL,
    date        Date NOT NULL,
    slotNumber  Int32 NOT NULL,
    bookingId   Utf8 NOT NULL,
    createdAt   Timestamp NOT NULL,
    PRIMARY KEY (tenantId, propertyId, roomTypeId, date, slotNumber),
    INDEX idxSlotByBooking GLOBAL SYNC ON (tenantId, bookingId)
);

ALTER TABLE roomTypeNightSlot SET (AUTO_PARTITIONING_BY_LOAD = ENABLED);
