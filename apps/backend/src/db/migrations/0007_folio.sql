-- =============================================================================
-- Migration 0007 — M6 Payment domain pt.1: Folio + FolioLine
-- =============================================================================
--
-- First slice of the payment domain (see memory `project_payment_domain_canonical.md`).
-- Folio MUST land before payment (0008) because payment.folioId references it.
--
-- ## What this migration creates
--
--   1. `folio` — first-class accounting container per booking (Apaleo / Mews /
--      Opera Cloud canonical pattern). One booking → 1+ folios; V1 ships with a
--      single guest folio per booking (group masters + ota_receivable / ota_payable
--      / company / transitory folios are reserved as enum values for Phase 3).
--
--   2. `folioLine` — line items posted to a folio (accommodation, tourism tax,
--      F&B, minibar, parking, etc.). `category` is a closed enum so reporting
--      and routing rules can reason about it. `isAccommodationBase` flags rows
--      that participate in the tourism-tax base (per НК РФ ch.33.1; see memory
--      `project_ru_compliance_blockers.md` #2). `routingRuleId` is the snapshot
--      of which routing rule decided the target folio at post time — editing
--      the rule later does NOT retroactively re-route past charges (54-ФЗ
--      reproducibility, Apaleo snapshot principle).
--
--   3. `booking.folioId Utf8 Nullable` — link from existing booking rows to
--      their primary folio. Stays nullable forever; V2 split-folios introduces
--      `folio.bookingId` reverse lookup as the canonical relation.
--
--   4. `ALTER TABLE folio ADD CHANGEFEED folio_events` — the in-process CDC
--      consumer (apps/backend/src/workers/cdc-consumer.ts) projects folio state
--      changes into `activity` and recomputes balances. Migration 0015 wires
--      the `folio_balance_writer` + `activity_writer` consumers separately
--      (per the same pattern as 0005 for booking).
--
-- ## Money model — Int64 минор копейки (NOT amountMicros)
--
-- Booking domain uses `Int64 amountMicros` (× 10^6) because of the `Decimal`
-- workaround documented in memory `project_ydb_specifics.md` #13. Payments
-- domain consciously diverges: ЮKassa/T-Kassa/СБП/НСПК всё native API works
-- in копейки as `Int64`; storing folio balance also in копейки avoids a
-- conversion at every webhook handler.
--
-- Conversion at the post boundary: `amountMinor = round(totalMicros / 10000)`
-- when posting an accommodation line from a booking timeSlice. See
-- `apps/backend/src/domains/folio/lib/folio-balance.ts` for the helper.
--
-- ## Per-row version + state-transition timestamps
--
-- Both folio and folioLine carry `version Uint32` for OCC CAS and explicit
-- state-transition timestamps (closedAt, settledAt for folio; postedAt,
-- voidedAt for folioLine). CDC sees `oldImage.closedAt = null,
-- newImage.closedAt = ...` → consumer knows the semantic event "folio.closed"
-- without a separate event table (per `project_event_architecture.md` §3).
--
-- ## Why no `currency` validation here
--
-- V1 is single-currency RUB. The `currency Utf8 NOT NULL` column is reserved
-- so V2 multi-currency is a code change, not a migration. Domain layer asserts
-- `Payment.currency = Folio.currency` per invariant #14.
--
-- ## Indexes
--
--   - `ixFolioBooking GLOBAL SYNC ON (tenantId, bookingId)` — single-shard
--     read of all folios per booking (group bookings have multiple).
--   - `ixFolioStatus GLOBAL SYNC ON (tenantId, propertyId, status)` —
--     receivables/aging dashboard (open + closed-but-unpaid).
--   - `ixFolioLineCategory GLOBAL SYNC ON (tenantId, folioId, category)` —
--     report queries (sum accommodation by booking, sum F&B by folio).
--
-- =============================================================================

-- 1. Folio — accounting container. PK leads with tenantId+propertyId so all
--    folios for one property live on the same shard (range scans for the
--    receivables dashboard are single-shard).
CREATE TABLE folio (
    tenantId         Utf8 NOT NULL,
    propertyId       Utf8 NOT NULL,
    bookingId        Utf8 NOT NULL,
    id               Utf8 NOT NULL,
    -- folio kind: see memory canonical for the full enum
    --   'guest' | 'company' | 'group_master' | 'ota_receivable' | 'ota_payable' | 'transitory'
    kind             Utf8 NOT NULL,
    -- 5-state machine: open → closed → settled (terminal). closed→open only by
    -- supervisor RBAC + audit row + 24h window (the SOLE non-monotonic transition).
    status           Utf8 NOT NULL,
    -- ISO 4217. V1 RUB only; column reserved for V2 multi-currency.
    currency         Utf8 NOT NULL,
    -- Materialized projection of (sum charges - sum payments_applied + sum refunds_applied).
    -- CDC consumer recomputes on every folioLine / payment / refund commit.
    balanceMinor     Int64 NOT NULL,
    -- OCC CAS: each UPDATE bumps version by exactly 1; concurrent writers see
    -- `version mismatch` and retry. Invariant #6 (monotonic).
    -- OCC version. Int32 (not Uint32) per `project_ydb_specifics.md` #9 —
    -- @ydbjs/query infers JS `number` as Int32, which YDB rejects against
    -- Uint32 columns with `ERROR(1030): Type annotation`. Domain contract
    -- enforces version >= 1, so signed Int32 is fine.
    version          Int32 NOT NULL,
    -- State-transition timestamps. CDC diffs them → activity rows.
    closedAt         Timestamp,
    settledAt        Timestamp,
    closedBy         Utf8,
    -- Optional FK-by-convention to an org-level company profile (Phase 3).
    companyId        Utf8,
    -- Audit
    createdAt        Timestamp NOT NULL,
    updatedAt        Timestamp NOT NULL,
    createdBy        Utf8 NOT NULL,
    updatedBy        Utf8 NOT NULL,
    PRIMARY KEY (tenantId, propertyId, bookingId, id),
    -- All folios under one booking (group bookings have many)
    INDEX ixFolioBooking GLOBAL SYNC ON (tenantId, bookingId),
    -- Receivables / aging dashboard
    INDEX ixFolioStatus GLOBAL SYNC ON (tenantId, propertyId, status)
);

ALTER TABLE folio SET (AUTO_PARTITIONING_BY_LOAD = ENABLED);

-- 2. FolioLine — individual postings. PK starts with tenantId+folioId so a
--    "load all lines for this folio" query is a single-shard range scan.
CREATE TABLE folioLine (
    tenantId          Utf8 NOT NULL,
    folioId           Utf8 NOT NULL,
    id                Utf8 NOT NULL,
    -- charge category — closed enum (see memory canonical)
    --   accommodation | tourismTax | fnb | minibar | spa | parking | laundry
    --   | phone | misc | cancellationFee | noShowFee
    category          Utf8 NOT NULL,
    -- Human-readable description (e.g. "Проживание 25-27 апреля, номер №201")
    description       Utf8 NOT NULL,
    -- Money in минор копейки. Negative values represent reversals/discounts.
    amountMinor       Int64 NOT NULL,
    -- Tourism tax base flag — true iff this line participates in the tax base
    -- per НК РФ ch.33.1 (room-only revenue, NOT F&B / parking / extras).
    isAccommodationBase Bool NOT NULL,
    -- НДС rate in basis points (0 = 0%, 2200 = 22%). Hotel accommodation services
    -- in RU are 0% per ФНС (Постановление-1860 classification, продлено до 31.12.2030).
    taxRateBps        Int32 NOT NULL,
    -- Sub-state: draft (not yet posted) → posted → void.
    -- void requires same-day reversal; cross-day uses compensating posting.
    lineStatus        Utf8 NOT NULL,
    -- Snapshot of the routing rule that decided where this line goes. Editing
    -- the rule does NOT re-route past lines (54-ФЗ + Apaleo snapshot principle).
    routingRuleId     Utf8,
    -- State-transition timestamps
    postedAt          Timestamp,
    voidedAt          Timestamp,
    voidReason        Utf8,
    -- OCC version (Int32, see folio.version note above for rationale)
    version           Int32 NOT NULL,
    -- Audit
    createdAt         Timestamp NOT NULL,
    updatedAt         Timestamp NOT NULL,
    createdBy         Utf8 NOT NULL,
    updatedBy         Utf8 NOT NULL,
    PRIMARY KEY (tenantId, folioId, id),
    -- Per-folio category aggregation (sum accommodation / F&B / etc.)
    INDEX ixFolioLineCategory GLOBAL SYNC ON (tenantId, folioId, category)
);

ALTER TABLE folioLine SET (AUTO_PARTITIONING_BY_LOAD = ENABLED);

-- 3. booking.folioId — link to the primary (guest) folio. Nullable forever:
--    on V2 split-folios the canonical relation moves to `folio.bookingId`
--    (reverse lookup via ixFolioBooking) and this column becomes informational.
--    Pre-existing booking rows are backfilled by `apps/backend/src/db/backfill-folios.ts`.
ALTER TABLE booking ADD COLUMN folioId Utf8;

-- 4. CDC changefeed for folio — single source of folio events. The CDC consumer
--    diffs oldImage/newImage and projects to:
--      - activity (audit log via createAuditHandler)
--      - folio balance recompute (folio_balance_writer consumer)
--      - notification queue (pending payment reminders, etc.)
--    72h retention is the local Docker / Dedicated tier default. Yandex Cloud
--    Serverless caps at 24h; deploy migration will ALTER TOPIC to shrink.
ALTER TABLE folio ADD CHANGEFEED folio_events WITH (
    MODE = 'NEW_AND_OLD_IMAGES',
    FORMAT = 'JSON',
    VIRTUAL_TIMESTAMPS = TRUE,
    RETENTION_PERIOD = Interval("PT72H"),
    TOPIC_AUTO_PARTITIONING = 'ENABLED'
);

-- folioLine does NOT get its own changefeed — line-level audit lands in
-- `activity` via the folio CDC consumer (one event per folio update covers
-- the line state because the consumer also reads the line table on each
-- folio diff to enrich the activity row). Saves one consumer slot.
