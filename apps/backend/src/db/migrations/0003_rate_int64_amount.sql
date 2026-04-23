-- =============================================================================
-- Migration 0003 — rewrite `rate.amount` Decimal(22,9) → `rate.amountMicros` Int64
-- =============================================================================
--
-- Why: @ydbjs/value 6.x does NOT ship a Decimal primitive wrapper, so we cannot
-- bind JS numbers/strings/bigints to Decimal(22,9) columns from the SDK —
-- YDB returns `ERROR(1030): Type annotation` on any interpolation attempt.
-- Even `CAST(${str} AS Decimal(22,9))` fails because the error is raised at
-- bind time, before CAST is evaluated. Details in `project_ydb_specifics.md` #13.
--
-- Industry workaround: store money as an integer in a sub-currency unit —
-- this is the exact pattern used by Google Ads, Google Cloud Billing, and
-- Stripe. We pick "micros" (× 10^6) so 1 RUB = 1_000_000 micros; 6 decimal
-- places is well above any currency's sub-unit need and Int64 max (9.2e18)
-- accommodates up to ~9e12 RUB per row — overkill for a nightly rate.
--
-- Conversions in application code (see `apps/backend/src/domains/rate/...`):
--   microsToDecimal(n: bigint): string  // "1234.567890"
--   decimalToMicros(s: string): bigint  // 1234567890n
--
-- `rate` is empty at this point (the Decimal version was never inserted into
-- from SDK code — the column wasn't wired up). Dropping + recreating loses
-- nothing.

DROP TABLE rate;

CREATE TABLE rate (
    tenantId     Utf8 NOT NULL,
    propertyId   Utf8 NOT NULL,
    roomTypeId   Utf8 NOT NULL,
    ratePlanId   Utf8 NOT NULL,
    date         Date NOT NULL,
    amountMicros Int64 NOT NULL,
    currency     Utf8 NOT NULL,
    createdAt    Timestamp NOT NULL,
    updatedAt    Timestamp NOT NULL,
    PRIMARY KEY (tenantId, propertyId, roomTypeId, ratePlanId, date)
);

-- Re-apply the partitioning tuning from 0002 (since we dropped+recreated).
ALTER TABLE rate SET (AUTO_PARTITIONING_BY_LOAD = ENABLED);
