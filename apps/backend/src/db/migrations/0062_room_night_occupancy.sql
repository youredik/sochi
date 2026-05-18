-- 0062_room_night_occupancy.sql — Overbooking-prevention canon (2026-05-18)
--
-- DB-level invariant: no two bookings can pin the same physical room on the
-- same night. Mass-import / channel-manager push / repo-bypass paths get a
-- hard `PRECONDITION_FAILED: insert_pk` from YDB instead of silently corrupting
-- the booking ledger.
--
-- Pattern: per-night materialized occupancy row per (tenantId, propertyId,
-- roomId, date). Primary key uniqueness IS the constraint. YDB 25.3+ has no
-- CHECK / EXCLUDE / range-types, and `ALTER TABLE ADD INDEX UNIQUE` is
-- doc-ambiguous on populated tables — so PK-as-invariant is the canonical
-- YDB-native shape per agent research 2026-05-18 (Apaleo + Mews 2026 canon
-- match this exactly: «UnitGroup + Unit per night» × «Space + Resource per
-- night»; we materialize Unit×Night when pin happens).
--
-- Write seam: `booking.repo` only — `assignRoom`, `moveDates` (when pinned),
-- `cancel`, plus repo-internal bookkeeping. Mass-import scripts that UPSERT
-- bookings raw will get a hard reject if they also try to populate this table
-- without a unique (roomId, date) tuple — which is the desired behavior.
--
-- Bookkeeping policy (matches `availability.sold` semantics):
--   - INSERT on `assignRoom` (pin specific room).
--   - DELETE + INSERT on `moveDates` when pinned (overlap = PK conflict).
--   - DELETE on `changeRoomType` (pin gets nulled per current repo canon).
--   - DELETE on `cancel` (room returns к pool, matches sold-- decrement).
--   - KEEP on `checkIn` / `checkOut` / `markNoShow` (past nights don't
--     conflict with future bookings; matches sold-retention canon).
--
-- `idxOccupancyByBooking` enables O(1) DELETE-by-bookingId lookups (rebalance
-- paths). Not UNIQUE — one booking owns N nights, all sharing bookingId.
--
-- Companion: `availability.oversellDelta` column (Apaleo «Allowed Overbooking»
-- canon). Operator-set per-day delta; effective allotment =
-- `allotment + oversellDelta`. Nullable on read; treated as 0 when absent.
-- Validation in repo: `allotment + oversellDelta >= 0`. Closes Gap C
-- (operator drops allotment < sold) via repo guard since YDB has no CHECK.

CREATE TABLE roomNightOccupancy (
    tenantId   Utf8 NOT NULL,
    propertyId Utf8 NOT NULL,
    roomId     Utf8 NOT NULL,
    date       Date NOT NULL,
    bookingId  Utf8 NOT NULL,
    createdAt  Timestamp NOT NULL,
    PRIMARY KEY (tenantId, propertyId, roomId, date),
    INDEX idxOccupancyByBooking GLOBAL SYNC ON (tenantId, bookingId)
);

ALTER TABLE roomNightOccupancy SET (AUTO_PARTITIONING_BY_LOAD = ENABLED);

ALTER TABLE availability ADD COLUMN oversellDelta Int32;
