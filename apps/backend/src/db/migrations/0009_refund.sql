-- =============================================================================
-- Migration 0009 — M6 Payment domain pt.3: Refund table
-- =============================================================================
--
-- Third slice of the payment domain. Refund depends on Payment (0008) — the
-- PK starts with `paymentId` so cumulative-refund queries are single-shard
-- (the canon-#1 cap check needs `SUM(refunds.amountMinor) WHERE paymentId=?`
-- to be hot, low-latency).
--
-- ## What this creates
--
--   1. `refund` — provider-agnostic refund row. One Payment → 0+ Refunds:
--      partial refunds compose toward `capturedMinor`. Canon #1 enforces
--      cumulative cap; this migration provides the storage shape.
--
--      Money: `Int64 amountMinor` копейки (same convention as payment).
--      Status SM (3-state): pending → succeeded | failed. Both terminal.
--
--      `causalityId Utf8 Nullable` UNIQUE — disambiguates origin:
--        - `userInitiated:<userId>` — manual refund from ops dashboard
--        - `dispute:<disputeId>` — auto-created on dispute lost (canon #15)
--        - `tkassa_cancel:<paymentId>` — polymorphic T-Kassa cancel-after-capture
--      UNIQUE prevents double-creation against the same trigger (e.g.
--      dispute-lost retry shouldn't insert a second compensating refund).
--      NULL allowed multiple times (each NULL unique per YDB UNIQUE semantics).
--
--      `providerRefundId Utf8 Nullable` UNIQUE — provider's own id; populated
--      after provider call. Same NULL-multiplicity semantic as payment.
--
--      `version Int32` (NOT Uint32 per gotcha #9). OCC CAS column.
--
--   2. `ALTER TABLE refund ADD CHANGEFEED refund_events` — CDC for the
--      consumer (M6.5) that projects refund.status='succeeded' into
--      `payment.status` derived flip (succeeded → partially_refunded → refunded
--      via `deriveRefundStatus`) and folio balance recompute.
--
-- ## Indexes (UNIQUE inline only — gotcha #12)
--
--   - PK `(tenantId, paymentId, id)` — single-shard cumulative query
--   - `ixRefundProvider GLOBAL UNIQUE SYNC ON (tenantId, providerCode, providerRefundId)`
--   - `ixRefundCausality GLOBAL UNIQUE SYNC ON (tenantId, causalityId)`
--   - `ixRefundStatus GLOBAL SYNC ON (tenantId, status)` — for ops dashboard
--     "all pending refunds" query (drives the retry-pending job).
--
-- ## providerCode column
--
-- Refund provider code MUST match the parent payment's providerCode. Domain
-- layer asserts this at create time. Storing a copy on the refund row keeps
-- the UNIQUE on `(tenantId, providerCode, providerRefundId)` self-contained
-- without a JOIN.
--
-- =============================================================================

CREATE TABLE refund (
    tenantId         Utf8 NOT NULL,
    paymentId        Utf8 NOT NULL,
    id               Utf8 NOT NULL,
    -- Mirror of payment.providerCode at refund creation time. Frozen.
    providerCode     Utf8 NOT NULL,
    -- Provider's refund id. NULL until provider returns it.
    providerRefundId Utf8,
    -- Causality marker. NULL allowed multiple times (each NULL unique).
    -- Format: 'userInitiated:<userId>' | 'dispute:<disputeId>' | 'tkassa_cancel:<paymentId>'.
    causalityId      Utf8,
    -- 3-state Refund SM: pending → succeeded | failed. Terminal: succeeded, failed.
    status           Utf8 NOT NULL,
    -- Money in минор копейки. MUST be positive at insert time (canon #20
    -- refund-amount-positive — domain layer asserts; this allows reversals
    -- via separate compensating refunds, not negatives).
    amountMinor      Int64 NOT NULL,
    currency         Utf8 NOT NULL,
    -- Free-form reason from caller (UI / dispute system).
    reason           Utf8 NOT NULL,
    -- OCC version (Int32 per gotcha #9).
    version          Int32 NOT NULL,
    -- State-transition timestamps. CDC diffs them → activity rows.
    requestedAt      Timestamp NOT NULL,
    succeededAt      Timestamp,
    failedAt         Timestamp,
    -- Free-form failure reason from provider (PAN never included).
    failureReason    Utf8,
    -- Audit
    createdAt        Timestamp NOT NULL,
    updatedAt        Timestamp NOT NULL,
    createdBy        Utf8 NOT NULL,
    updatedBy        Utf8 NOT NULL,
    PRIMARY KEY (tenantId, paymentId, id),
    -- Provider-side dedup
    INDEX ixRefundProvider GLOBAL UNIQUE SYNC ON (tenantId, providerCode, providerRefundId),
    -- Causality dedup (dispute retry, tkassa_cancel replay)
    INDEX ixRefundCausality GLOBAL UNIQUE SYNC ON (tenantId, causalityId),
    -- Ops dashboard: "all pending refunds" query
    INDEX ixRefundStatus GLOBAL SYNC ON (tenantId, status)
);

ALTER TABLE refund SET (AUTO_PARTITIONING_BY_LOAD = ENABLED);

ALTER TABLE refund ADD CHANGEFEED refund_events WITH (
    MODE = 'NEW_AND_OLD_IMAGES',
    FORMAT = 'JSON',
    VIRTUAL_TIMESTAMPS = TRUE,
    RETENTION_PERIOD = Interval("PT72H"),
    TOPIC_AUTO_PARTITIONING = 'ENABLED'
);
