-- Round 14 self-review #6 — mockOta primary state YDB tables (P1 close).
--
-- Migration 0078 design doc explicitly admitted «in-memory state.ts modules
-- remain the PRIMARY state». Empirical Run #112 + #114 smoke failures
-- proved this assumption broken в YC Serverless multi-instance deployment:
--
--   1. POST /search/hp/ → instance A stores book_hash в process Map
--   2. POST /hotel/order/booking/form/ → instance B can't find → rate_not_found
--
-- User caught the halfmeasure 2026-05-27: «точно уверен? и даже по всем
-- нашим канонам?» Canon `feedback_p1_means_now_not_later` requires same-
-- session close, not «multi-day defer». This migration promotes state.ts
-- к YDB-backed primary state.
--
-- DESIGN:
--   - All tables TTL P1D (24h) per 152-ФЗ ст.21 ч.4 + reserved-test
--     PII shape (shield enforces non-real PII pre-INSERT).
--   - `tenantId` always === 'demo-tenant' но kept в PK для multi-tenant
--     parity с production channelInbox pattern.
--   - JSON columns для array/object data (children, guests, dailyPrices).
--   - `expiresAtMs` retained для app-level TTL check (defense-in-depth с
--     native TTL; YDB TTL eventually consistent vs app-immediate check).

-- ─────────────────────────────────────────────────────────────────────────
-- OSTROVOK / ETG 5-stage primary state
-- ─────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS mockOtaOstrovokBookHash (
    tenantId            Utf8 NOT NULL,           -- always 'demo-tenant'
    bookHash            Utf8 NOT NULL,           -- 32-hex token (randomBytes(16))
    hid                 Uint64 NOT NULL,
    checkin             Utf8 NOT NULL,           -- YYYY-MM-DD
    checkout            Utf8 NOT NULL,
    adults              Uint32 NOT NULL,
    childrenJson        Json,                    -- array of ages
    currency            Utf8 NOT NULL,           -- 'RUB'
    dailyPricesJson     Json NOT NULL,           -- array of integers
    totalPrice          Uint64 NOT NULL,         -- kopecks (Uint64 holds large RUB)
    roomName            Utf8 NOT NULL,
    mealName            Utf8 NOT NULL,
    issuedAt            Timestamp NOT NULL,
    expiresAt           Timestamp NOT NULL,
    PRIMARY KEY (tenantId, bookHash)
)
WITH (
    TTL = Interval("P1D") ON issuedAt
);

CREATE TABLE IF NOT EXISTS mockOtaOstrovokFormStage (
    tenantId            Utf8 NOT NULL,
    partnerOrderId      Utf8 NOT NULL,           -- UUIDv4 (client-supplied)
    bookHash            Utf8 NOT NULL,           -- FK к mockOtaOstrovokBookHash
    orderId             Uint64 NOT NULL,         -- 12-digit ETG-shape integer
    itemId              Uint64 NOT NULL,
    currency            Utf8 NOT NULL,
    totalAmount         Uint64 NOT NULL,
    createdAt           Timestamp NOT NULL,
    expiresAt           Timestamp NOT NULL,
    PRIMARY KEY (tenantId, partnerOrderId)
)
WITH (
    TTL = Interval("P1D") ON createdAt
);

CREATE TABLE IF NOT EXISTS mockOtaOstrovokBooking (
    tenantId            Utf8 NOT NULL,
    partnerOrderId      Utf8 NOT NULL,
    orderId             Uint64 NOT NULL,
    itemId              Uint64 NOT NULL,
    hid                 Uint64 NOT NULL,
    checkin             Utf8 NOT NULL,
    checkout            Utf8 NOT NULL,
    adults              Uint32 NOT NULL,
    childrenJson        Json,
    currency            Utf8 NOT NULL,
    totalAmount         Uint64 NOT NULL,
    status              Utf8 NOT NULL,           -- 'confirmed' | 'cancelled'
    customerEmail       Utf8 NOT NULL,           -- reserved-test only (shield)
    customerPhone       Utf8 NOT NULL,           -- reserved-test only (shield)
    guestsJson          Json NOT NULL,           -- ReadonlyArray<{firstName,lastName,isChild,age?}>
    createdAt           Timestamp NOT NULL,
    PRIMARY KEY (tenantId, partnerOrderId)
)
WITH (
    TTL = Interval("P1D") ON createdAt
);

-- ─────────────────────────────────────────────────────────────────────────
-- YANDEX.ПУТЕШЕСТВИЯ primary state
-- ─────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS mockOtaYandexBookingToken (
    tenantId            Utf8 NOT NULL,
    token               Utf8 NOT NULL,           -- 12-char alphanumeric
    hotelId             Utf8 NOT NULL,
    checkinDate         Utf8 NOT NULL,
    checkoutDate        Utf8 NOT NULL,
    adults              Uint32 NOT NULL,
    childrenCount       Uint32 NOT NULL,
    totalPriceMicros    Uint64 NOT NULL,         -- bigint kopecks*1M
    issuedAt            Timestamp NOT NULL,
    expiresAt           Timestamp NOT NULL,
    PRIMARY KEY (tenantId, token)
)
WITH (
    TTL = Interval("P1D") ON issuedAt
);

CREATE TABLE IF NOT EXISTS mockOtaYandexOrder (
    tenantId                Utf8 NOT NULL,
    orderId                 Utf8 NOT NULL,       -- 'yt-order-{12-hex}'
    bookingToken            Utf8 NOT NULL,
    customerEmail           Utf8 NOT NULL,       -- reserved-test only
    customerPhone           Utf8 NOT NULL,       -- reserved-test only
    status                  Utf8 NOT NULL,       -- 'CONFIRMED' | 'CANCELLED'
    externalReservationId   Utf8 NOT NULL,
    guestsJson              Json NOT NULL,
    createdAt               Timestamp NOT NULL,
    PRIMARY KEY (tenantId, orderId)
)
WITH (
    TTL = Interval("P1D") ON createdAt
);
