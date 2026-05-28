-- Round 14.5 re-do — multi-instance state YDB migration.
--
-- Refactors `_demo/mock-ota-server/{yandex,ostrovok}/state.ts` from
-- in-memory `Map<string, ...>` to YDB-backed Store DI pattern. Closes
-- pre-existing race ETG-SMOKE / YT-SMOKE / R12-11 / R13-9 in Playwright
-- smoke when YC Serverless scales the container to multiple instances.
--
-- Previous attempt (Round 14 self-review #6, commits e7c69d9 + 805e8b0)
-- broke production and was rolled back в `eefc54d`. This re-do follows
-- `feedback_deploy_as_debug_antipattern_2026_05_19` strictly: tables
-- empirically tested против local YDB Docker BEFORE push.
--
-- Table layout — one table per FSM stage per channel:
--   Ostrovok (ETG 5-stage flow):
--     mockOtaOstrovokBookHash    — search-result tokens (24h TTL)
--     mockOtaOstrovokFormStage   — pre-book stage (60min TTL)
--     mockOtaOstrovokBooking     — finalized bookings (no TTL — terminal)
--   Yandex.Путешествия:
--     mockOtaYandexBookingToken  — search-result tokens (24h TTL)
--     mockOtaYandexOrder         — confirmed orders (no TTL — terminal)
--
-- TTL strategy: hot tokens (book_hash, form_stage, booking_token) get YDB
-- native TTL matching the original in-memory `TOKEN_TTL_MS` constants —
-- demo state pool stays small, no application sweep needed. Finalized
-- bookings/orders kept indefinitely (terminal state, presenter may
-- inspect history). All tables carry `tenantId` first PK column для
-- multi-tenant parity with production tables (`channelInbox` etc) —
-- demo always uses `'demo-tenant'` but the column shape stays consistent.
--
-- JSON storage: `contextJson` / `bookingJson` / `orderJson` columns
-- carry the full structured payload. We use `Json` (server stores as
-- serialized text) not `JsonDocument` because @ydbjs/value 6.1.0 lacks
-- `JsonDocument` wrapper и we don't need server-side path indexing —
-- reads are by primary key only.

CREATE TABLE IF NOT EXISTS mockOtaOstrovokBookHash (
    tenantId        Utf8 NOT NULL,
    bookHash        Utf8 NOT NULL,
    contextJson     Json,
    expiresAt       Timestamp NOT NULL,
    createdAt       Timestamp NOT NULL,
    PRIMARY KEY (tenantId, bookHash)
)
WITH (
    TTL = Interval("P1D") ON expiresAt
);

CREATE TABLE IF NOT EXISTS mockOtaOstrovokFormStage (
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

CREATE TABLE IF NOT EXISTS mockOtaOstrovokBooking (
    tenantId        Utf8 NOT NULL,
    partnerOrderId  Utf8 NOT NULL,
    bookingJson     Json,
    status          Utf8 NOT NULL,   -- 'confirmed' | 'cancelled'
    createdAt       Timestamp NOT NULL,
    PRIMARY KEY (tenantId, partnerOrderId)
)
WITH (
    TTL = Interval("P7D") ON createdAt
);

CREATE TABLE IF NOT EXISTS mockOtaYandexBookingToken (
    tenantId        Utf8 NOT NULL,
    bookingToken    Utf8 NOT NULL,
    contextJson     Json,
    expiresAt       Timestamp NOT NULL,
    createdAt       Timestamp NOT NULL,
    PRIMARY KEY (tenantId, bookingToken)
)
WITH (
    TTL = Interval("P1D") ON expiresAt
);

CREATE TABLE IF NOT EXISTS mockOtaYandexOrder (
    tenantId        Utf8 NOT NULL,
    orderId         Utf8 NOT NULL,
    orderJson       Json,
    status          Utf8 NOT NULL,   -- 'CONFIRMED' | 'CANCELLED'
    createdAt       Timestamp NOT NULL,
    PRIMARY KEY (tenantId, orderId)
)
WITH (
    TTL = Interval("P7D") ON createdAt
);
