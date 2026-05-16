-- 0060_property_block.sql — G9 (2026-05-16)
-- per plans/grid-bookings-modernization-plan.md §G9 + R1+R2 ≥ 2026-05-16
-- research-agent canon (Mews ResourceBlock / Apaleo Block / OPERA OOO /
-- Cloudbeds maintenance / Bnovo «закрытие продажи»).
--
-- Operator-side maintenance / out-of-order / personal-use block at the
-- ROOM level (per-room, not per-roomType — matches all leaders). Distinct
-- domain from `booking`:
--   * no guest, no folio, no payment, no PII window
--   * separate read path — queries don't need WHERE type='guest' filter
--   * different lifecycle: created/active/expired (auto by date), no SM
--
-- Reason enum (4 values, RU labels — Bnovo's 3-bucket refined):
--   * repair        — Ремонт (сантехника, мебель, электрика)
--   * deep_clean    — Генеральная уборка (сезонная / после долгого гостя)
--   * personal_use  — Личное пользование (владелец, VIP, служебное)
--   * hold_other    — Прочая блокировка (резерв / фотосъёмка / событие)
--
-- 152-ФЗ exposure: zero PII by design. `comment` field is PII-guarded
-- at the Zod schema layer (refuse digit≥10 or email regex) — defense-in-
-- depth. Audit log entry on create/edit/delete (activity domain CDC).
--
-- Overlap with bookings:
--   * Block-over-booking: HARD-BLOCK при create (Apaleo/OPERA/Cloudbeds
--     canon). Operator must remove booking first. RU regulatory + 2%
--     туристический налог reporting нуждается в clean denominator.
--   * Booking-over-block: soft-warn (banner) + allow force-confirm
--     (Bnovo RU flex). Allows intentional override с двумя кликами.
--
-- Indexes:
--   * Primary: (tenantId, propertyId, startDate, id) — supports the
--     window-range scan used by `GET /properties/:propertyId/blocks?from=&to=`
--     (same shape as bookings list endpoint).
--   * Secondary: (tenantId, roomId, startDate) — per-room overlap
--     lookups when checking «is room X free for [from, to]?». Used by
--     property-block.repo.findOverlapping() AND by booking.service
--     auto-assign + assignRoom для block awareness.
--
-- Cross-tenant data isolation: tenantId is the partition key. Every
-- read MUST `WHERE tenantId = ?`. propertyId is checked AT service
-- layer (defence-in-depth — block belongs к single property).

CREATE TABLE IF NOT EXISTS propertyBlock (
    tenantId            Utf8 NOT NULL,
    id                  Utf8 NOT NULL,             -- newId('propertyBlock') — 'pblk_…'

    propertyId          Utf8 NOT NULL,
    roomId              Utf8 NOT NULL,             -- per-room (NOT per-roomType)

    -- Date range. startDate INCLUSIVE, endDate EXCLUSIVE — matches
    -- booking.checkIn/checkOut canon (last blocked night = endDate-1).
    -- Enforced at Zod: startDate < endDate.
    startDate           Date NOT NULL,
    endDate             Date NOT NULL,

    -- Hard enum — backend Zod validator owns canonical values:
    -- 'repair' | 'deep_clean' | 'personal_use' | 'hold_other'.
    reason              Utf8 NOT NULL,

    -- Optional free-text. ≤200 chars + PII-guarded at Zod
    -- (`isPropertyBlockCommentPII` from shared schema). Nullable.
    comment             Utf8,

    -- Operator identity (audit trail).
    createdBy           Utf8 NOT NULL,             -- userId

    createdAt           Timestamp NOT NULL,
    updatedAt           Timestamp NOT NULL,

    PRIMARY KEY (tenantId, propertyId, startDate, id),

    -- Per-room overlap scans (most-frequent query — every create-booking
    -- live-overlap check hits this).
    INDEX idxPropertyBlockRoom GLOBAL SYNC ON (tenantId, roomId, startDate),

    -- Direct-by-id lookup for edit/delete + tenant verification.
    INDEX idxPropertyBlockId GLOBAL SYNC ON (tenantId, id)
);
