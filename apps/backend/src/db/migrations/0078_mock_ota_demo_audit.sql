-- Round 13 honest-claim closure (canon `feedback_round_12_polish_canon_2026_05_26.md`).
--
-- Round 9 demo OTA mock-server canon claimed «triple defense»:
--   1. env-gate (APP_MODE !== 'production') at `_demo/index.ts` mount site
--   2. reserved-test-ranges shield (Round 8 P0-4)
--   3. YDB native TTL P1D on `mockOta_*` tables
--
-- Round 10 P0-b honest-corrected #3: «реально double-defense — mockOta tables
-- never created». Round 13 closes the gap by creating the tables.
--
-- DESIGN CHOICE — audit trail vs primary state:
--   `mockOtaReservationAudit` is an AUDIT TRAIL (write-only от mock OTA routes
--   когда они fire CloudEvents webhook к own backend). The in-memory `state.ts`
--   modules remain the PRIMARY state (fast, simple, suits Phase-1 wow-effect).
--   This split avoids forcing demo flows через YDB round-trips while still
--   providing operational visibility («какие demo bookings прошли last 24h»)
--   и honoring 152-ФЗ ст.21 ч.4 retention canon (PII-bearing payload auto-
--   deleted at P1D).
--
-- Schema notes:
--   - `tenantId` always === 'demo-tenant' but kept в PK для multi-tenant
--     parity (тот же pattern что production channelInbox).
--   - `payloadJson` carries reserved-test-PII (Иванов/Петров + example.com
--     emails + +70000 phones) — shield enforces shape so this is non-real
--     PII, но TTL still strict ('belt and braces').
--   - `correlatedEventId` links к real channelInbox row created downstream
--     when webhook lands.

CREATE TABLE IF NOT EXISTS mockOtaReservationAudit (
    tenantId            Utf8 NOT NULL,           -- always 'demo-tenant' для Phase-1
    channelId           Utf8 NOT NULL,           -- 'YT' | 'ETG'
    mockOrderId         Utf8 NOT NULL,           -- e.g. 'yt-order-abc123' | partnerOrderId UUIDv4
    receivedAt          Timestamp NOT NULL,      -- when mock-OTA route persisted
    payloadJson         Json,                    -- reserved-test PII shape (Round 8 shield)
    correlatedEventId   Utf8,                    -- CloudEvent id fired к own webhook receiver
    PRIMARY KEY (tenantId, channelId, mockOrderId)
)
WITH (
    TTL = Interval("P1D") ON receivedAt
);

CREATE TABLE IF NOT EXISTS mockOtaInventoryPool (
    tenantId            Utf8 NOT NULL,
    propertyId          Utf8 NOT NULL,
    availabilityDate    Date NOT NULL,
    roomsAvailable      Uint32 NOT NULL,
    seededAt            Timestamp NOT NULL,
    PRIMARY KEY (tenantId, propertyId, availabilityDate)
)
WITH (
    TTL = Interval("P1D") ON seededAt
);
