-- =============================================================================
-- Migration 0004 — M4 booking domain: ARI-complete booking + activity + idempotency
-- =============================================================================
--
-- Scope: this migration delivers the schema needed for the booking lifecycle —
-- atomic create/cancel/checkIn/checkOut/noShow with full fiscal correctness,
-- RU-compliance fields, and a CDC-driven audit pipeline. See memory notes
-- `project_horeca_domain_model.md`, `project_ru_compliance_blockers.md`,
-- `project_ydb_specifics.md` for the design rationale.
--
-- Five separate changes in one file:
--   1. Rebuild `booking` — new PK `(tenantId, propertyId, checkIn, id)` for
--      fast property-date range scans; Int64 micros for money (no Decimal
--      wrapper in @ydbjs/value, see memory #13); JSON snapshots of guest,
--      timeSlices, cancellation/no-show fees, external references; RU-compliance
--      columns (МВД registration + РКЛ check + tourism-tax base/computed);
--      state-transition timestamp columns so CDC diff = semantic event.
--   2. `ALTER TABLE booking ADD CHANGEFEED` — single source of events for the
--      in-process consumer that writes to `activity`. Stankoff-v2 pattern
--      (see `/Users/ed/dev/stankoff-v2/apps/backend/src/services/cdc-consumer.ts`).
--   3. `activity` — polymorphic audit log, tenant-scoped. Populated by the
--      CDC consumer when it sees oldImage/newImage diffs. 2-year TTL aligned
--      with 152-ФЗ retention expectations. Reusable for every future domain.
--   4. `idempotencyKey` — Stripe-style `Idempotency-Key` header storage for
--      mutation endpoints. 24h TTL is IETF `idempotency-key-header-07` default.
--      Complementary to the UNIQUE index on (externalId) used for OTA dedup.
--   5. `guest` RU-migration columns + `property.tourismTaxRateBps`. Both are
--      additive ALTERs — no data loss.
--
-- AUTO_PARTITIONING_BY_LOAD must be re-applied to booking (DROP loses it).
--
-- =============================================================================

-- 1. Drop + rebuild booking with new shape.
DROP TABLE booking;

CREATE TABLE booking (
    tenantId         Utf8 NOT NULL,
    propertyId       Utf8 NOT NULL,
    checkIn          Date NOT NULL,
    id               Utf8 NOT NULL,
    -- stay dimensions
    checkOut         Date NOT NULL,
    roomTypeId       Utf8 NOT NULL,
    ratePlanId       Utf8 NOT NULL,
    assignedRoomId   Utf8,
    guestsCount      Int32 NOT NULL,
    nightsCount      Int32 NOT NULL,
    -- guest linkage + snapshot
    primaryGuestId   Utf8 NOT NULL,
    guestSnapshot    Json NOT NULL,
    -- state machine (5 states: confirmed / in_house / checked_out / cancelled / no_show)
    -- `status` is the materialized current state; the *At columns are the
    -- audit trail that CDC sees as diffs and materializes into `activity`.
    status           Utf8 NOT NULL,
    confirmedAt      Timestamp NOT NULL,
    checkedInAt      Timestamp,
    checkedOutAt     Timestamp,
    cancelledAt      Timestamp,
    noShowAt         Timestamp,
    cancelReason     Utf8,
    -- channel attribution
    channelCode        Utf8 NOT NULL,
    externalId         Utf8,
    externalReferences Json,
    -- money + ARI snapshot (Int64 micros; Decimal unsupported in @ydbjs/value 6.x)
    totalMicros        Int64 NOT NULL,
    paidMicros         Int64 NOT NULL,
    currency           Utf8 NOT NULL,
    timeSlices         Json NOT NULL,
    cancellationFee    Json,
    noShowFee          Json,
    -- RU compliance (МВД + РКЛ + tourism tax)
    registrationStatus      Utf8 NOT NULL,
    registrationMvdId       Utf8,
    registrationSubmittedAt Timestamp,
    rklCheckResult          Utf8 NOT NULL,
    rklCheckedAt            Timestamp,
    tourismTaxBaseMicros    Int64 NOT NULL,
    tourismTaxMicros        Int64 NOT NULL,
    -- meta
    notes            Utf8,
    createdAt        Timestamp NOT NULL,
    updatedAt        Timestamp NOT NULL,
    createdBy        Utf8 NOT NULL,
    updatedBy        Utf8 NOT NULL,
    PRIMARY KEY (tenantId, propertyId, checkIn, id),
    -- Lookup by id alone (admin-UI deep link, rare but O(1))
    INDEX ixBookingId GLOBAL SYNC ON (id),
    -- Channel dedup — UNIQUE enforces "same OTA confirmation = same row"
    INDEX ixBookingExternal GLOBAL UNIQUE SYNC ON (tenantId, propertyId, externalId),
    -- Filter by status (housekeeping, arrivals-today queries)
    INDEX ixBookingStatus GLOBAL SYNC ON (tenantId, propertyId, status),
    -- Guest history across stays
    INDEX ixBookingGuest GLOBAL SYNC ON (tenantId, primaryGuestId, checkIn),
    -- Front-desk "who is in room N today"
    INDEX ixBookingRoom GLOBAL SYNC ON (tenantId, assignedRoomId, checkIn)
);

ALTER TABLE booking SET (AUTO_PARTITIONING_BY_LOAD = ENABLED);

-- 2. CDC changefeed — single source of domain events for the in-process
--    consumer. 72h retention gives plenty of replay budget for at-least-once
--    delivery under normal ops; auto-partitioning scales under peak-season
--    burst without manual reshard.
ALTER TABLE booking ADD CHANGEFEED booking_events WITH (
    MODE = 'NEW_AND_OLD_IMAGES',
    FORMAT = 'JSON',
    VIRTUAL_TIMESTAMPS = TRUE,
    RETENTION_PERIOD = Interval("PT72H"),
    TOPIC_AUTO_PARTITIONING = 'ENABLED'
);

-- 3. Polymorphic activity log (stankoff-v2 pattern, tenant-scoped).
--    Populated by the CDC consumer when it sees field diffs on booking
--    (and later: property, roomType, etc.). 2-year TTL aligns with 152-ФЗ
--    audit retention expectations; tax records live in folio, not here.
CREATE TABLE activity (
    tenantId     Utf8 NOT NULL,
    objectType   Utf8 NOT NULL,
    recordId     Utf8 NOT NULL,
    createdAt    Timestamp NOT NULL,
    id           Utf8 NOT NULL,
    activityType Utf8 NOT NULL,
    actorUserId  Utf8 NOT NULL,
    diffJson     Json NOT NULL,
    PRIMARY KEY (tenantId, objectType, recordId, createdAt, id)
) WITH (TTL = Interval("P730D") ON createdAt);

ALTER TABLE activity SET (AUTO_PARTITIONING_BY_LOAD = ENABLED);

-- 4. Idempotency-Key storage (IETF draft-07 + Stripe default of 24h).
--    Complementary to UNIQUE (externalId) — externalId handles OTA dedup,
--    this handles direct-from-UI safety-net retries after network glitches.
CREATE TABLE idempotencyKey (
    tenantId                 Utf8 NOT NULL,
    key                      Utf8 NOT NULL,
    requestFingerprintSha256 Utf8 NOT NULL,
    responseStatus           Int32 NOT NULL,
    responseBodyJson         Json NOT NULL,
    createdAt                Timestamp NOT NULL,
    PRIMARY KEY (tenantId, key)
) WITH (TTL = Interval("PT24H") ON createdAt);

ALTER TABLE idempotencyKey SET (AUTO_PARTITIONING_BY_LOAD = ENABLED);

-- 5a. Guest — RU migration fields (required for МВД notification on foreign guests
--     within 1 business day; see `project_ru_compliance_blockers.md` #1).
ALTER TABLE guest ADD COLUMN visaNumber Utf8;
ALTER TABLE guest ADD COLUMN visaType Utf8;
ALTER TABLE guest ADD COLUMN visaExpiresAt Date;
ALTER TABLE guest ADD COLUMN migrationCardNumber Utf8;
ALTER TABLE guest ADD COLUMN arrivalDate Date;
ALTER TABLE guest ADD COLUMN stayUntil Date;

-- 5b. Property — tourism tax rate in basis points (1 bp = 0.01%).
--     Sochi 2026 = 200 bps (2.00%). Integer math avoids float drift;
--     computed per-booking as max(base * rate / 10000, 100₽ * nightsCount)
--     per НК РФ chapter 33.1 (replaces repealed курортный сбор).
ALTER TABLE property ADD COLUMN tourismTaxRateBps Int32;
