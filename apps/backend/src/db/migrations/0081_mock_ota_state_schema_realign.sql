-- Round 14.6.4 follow-up — mockOta state schema realignment.
--
-- **Root cause** (caught via Playwright browser walk на prod 2026-05-28 + YC
-- CLI YDB schema describe): production prod YDB has TWO entries в
-- `_migration_history`:
--
--   0080_mock_ota_primary_state.sql   ← older Round 14.5 rolled-back attempt
--   0080_mock_ota_state_tables.sql    ← current Round 14.5 re-do canon
--
-- Older migration created tables с separate-columns shape (`token`, `hotelId`,
-- `checkinDate`, `adults`, `childrenCount`, `totalPriceMicros`, `issuedAt`).
-- Re-do migration uses canonical BLOB shape (`bookingToken`, `contextJson`)
-- но `CREATE TABLE IF NOT EXISTS` semantics skip table-mutation — tables stuck
-- on old schema while app code writes the new shape → SCHEME_ERROR → 503
-- DB_ERROR on every anonymous demo.sepshn.ru yandex search.
--
-- Wow-effect SILENTLY BROKEN end-to-end since Round 14.5 re-do.
--
-- Fix: DROP + CREATE all 5 mockOta state tables с canonical schema. Tables
-- are ephemeral demo state (TTL 24h-7d native YDB), so data loss = expected
-- (clean slate matches 24h TTL semantics anyway). Idempotent via DROP IF
-- EXISTS — re-running migration on clean DB is no-op for missing tables.
--
-- Canon: `feedback_round_14_6_per_tenant_demo_canon_2026_05_28.md` Round
-- 14.6.4 section «A7.5 root-cause + schema realignment».

DROP TABLE IF EXISTS mockOtaYandexBookingToken;
DROP TABLE IF EXISTS mockOtaYandexOrder;
DROP TABLE IF EXISTS mockOtaOstrovokBookHash;
DROP TABLE IF EXISTS mockOtaOstrovokFormStage;
DROP TABLE IF EXISTS mockOtaOstrovokBooking;

CREATE TABLE mockOtaOstrovokBookHash (
    tenantId        Utf8 NOT NULL,
    bookHash        Utf8 NOT NULL,
    contextJson     Json,
    expiresAt       Timestamp NOT NULL,
    createdAt       Timestamp NOT NULL,
    PRIMARY KEY (tenantId, bookHash)
)
WITH (
    TTL = Interval("PT24H") ON expiresAt
);

CREATE TABLE mockOtaOstrovokFormStage (
    tenantId        Utf8 NOT NULL,
    partnerOrderId  Utf8 NOT NULL,
    contextJson     Json,
    expiresAt       Timestamp NOT NULL,
    createdAt       Timestamp NOT NULL,
    PRIMARY KEY (tenantId, partnerOrderId)
)
WITH (
    TTL = Interval("PT1H") ON expiresAt
);

CREATE TABLE mockOtaOstrovokBooking (
    tenantId        Utf8 NOT NULL,
    partnerOrderId  Utf8 NOT NULL,
    bookingJson     Json,
    status          Utf8 NOT NULL,
    createdAt       Timestamp NOT NULL,
    PRIMARY KEY (tenantId, partnerOrderId)
)
WITH (
    TTL = Interval("PT24H") ON createdAt
);

CREATE TABLE mockOtaYandexBookingToken (
    tenantId        Utf8 NOT NULL,
    bookingToken    Utf8 NOT NULL,
    contextJson     Json,
    expiresAt       Timestamp NOT NULL,
    createdAt       Timestamp NOT NULL,
    PRIMARY KEY (tenantId, bookingToken)
)
WITH (
    TTL = Interval("PT24H") ON expiresAt
);

CREATE TABLE mockOtaYandexOrder (
    tenantId        Utf8 NOT NULL,
    orderId         Utf8 NOT NULL,
    orderJson       Json,
    status          Utf8 NOT NULL,
    createdAt       Timestamp NOT NULL,
    PRIMARY KEY (tenantId, orderId)
)
WITH (
    TTL = Interval("PT24H") ON createdAt
);
