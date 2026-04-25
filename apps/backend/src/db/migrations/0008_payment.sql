-- =============================================================================
-- Migration 0008 — M6 Payment domain pt.2: Payment table
-- =============================================================================
--
-- Second slice of the payment domain (see memory `project_payment_domain_canonical.md`).
-- Payment depends on Folio (0007) — `folioId` here points at folio.id.
--
-- ## What this migration creates
--
--   1. `payment` — provider-agnostic payment intent + state machine row.
--      One booking → 1+ payments (multiple captures, partial pre-pays, etc.).
--      Each payment carries:
--        - Money: 3 columns (`amountMinor` requested, `authorizedMinor` actually
--          authorized, `capturedMinor` actually captured). Different from
--          booking domain's `amountMicros` — payments use Int64 копейки because
--          ЮKassa/T-Kassa/СБП APIs all work in копейки natively. Conversion
--          at the post boundary, see `apps/backend/src/domains/folio/lib/folio-balance.ts`
--          `microsToMinor`.
--        - State machine: 9 states (created/pending/waiting_for_capture/
--          succeeded/partially_refunded/refunded/canceled/failed/expired).
--          Terminal: failed/canceled/expired/refunded. Pseudo-terminal:
--          succeeded/partially_refunded (mutate only via Refund children).
--        - State-transition timestamps: CDC consumer diffs them → activity rows.
--          (canonical `project_event_architecture.md` §3 pattern).
--        - OCC: `version Int32` (NOT Uint32 per gotcha #9), bumped exactly +1
--          on every UPDATE; concurrent writers see CAS mismatch.
--      Reservation columns for 2026-2027 regulatory roadmap (canon):
--        - `payerInn` — СБП mandatory for B2B from 01.07.2026 (НСПК).
--        - `saleChannel` — 289-ФЗ Платформенная экономика from 01.10.2026.
--        - `anomalyScore Float?` — ML fraud signal slot.
--        - `holdExpiresAt` — provider auth-hold expiry (T+72h ЮKassa,
--          T+168h T-Kassa) for the scheduled `expire` job.
--      Indexes (UNIQUE inline because YDB rejects ALTER ADD UNIQUE INDEX,
--      gotcha #12):
--        - `ixPaymentOrgStatus` — for the receivables / aging dashboard.
--        - `ixPaymentProvider GLOBAL UNIQUE` — provider webhook dedup
--          (`(tenantId, providerCode, providerPaymentId)`). Nullable
--          providerPaymentId means multiple null-state rows are OK
--          (each NULL is unique per YDB UNIQUE semantics).
--        - `ixPaymentIdempotency GLOBAL UNIQUE` — IETF Idempotency-Key
--          header dedup `(tenantId, idempotencyKey)`. Mandatory for
--          retry-safe POST /payments.
--
--   2. `ALTER TABLE payment ADD CHANGEFEED payment_events` — CDC for the
--      consumer that projects status diffs into `activity` and recomputes
--      folio balance. Consumer registration in 0015 (mirror 0005 pattern).
--
-- ## Money model — same Int64 копейки convention as folio
--
-- See `project_payment_domain_canonical.md` "Money model". Three separate
-- amount columns instead of one because Stripe-style preauth/capture:
--   - `amountMinor`: requested at create (the "intent"). Frozen.
--   - `authorizedMinor`: actually authorized by provider. <= amount.
--   - `capturedMinor`: actually captured. <= authorized. Refunds decrement.
-- For SBP (no preauth) and stub: authorized == captured == amount on success.
--
-- =============================================================================

CREATE TABLE payment (
    tenantId         Utf8 NOT NULL,
    propertyId       Utf8 NOT NULL,
    bookingId        Utf8 NOT NULL,
    id               Utf8 NOT NULL,
    -- Folio link. Nullable so a payment can exist before its folio is created
    -- in edge flows (e.g. pre-booking deposit). Populated on creation in normal flow.
    folioId          Utf8,
    -- Provider taxonomy
    --   stub | yookassa | tkassa | sbp | digital_ruble (reserved 2026-09-01)
    providerCode     Utf8 NOT NULL,
    -- Provider's payment id. NULL until provider returns it. Becomes the
    -- dedup key for webhooks once set. UNIQUE prevents two local rows
    -- claiming the same provider txn.
    providerPaymentId Utf8,
    -- For ЮKassa-style flows: hosted-checkout URL the guest gets redirected to.
    -- Set by `initiate`, expires per provider rules (~30 min typical).
    confirmationUrl  Utf8,
    -- Payment method:
    --   card | sbp | digital_ruble | cash | bank_transfer | stub
    method           Utf8 NOT NULL,
    -- 9-state Payment SM. See canon for full transition matrix.
    --   created | pending | waiting_for_capture | succeeded | partially_refunded
    --   | refunded | canceled | failed | expired
    -- Terminal: failed/canceled/expired/refunded. Pseudo-terminal:
    -- succeeded/partially_refunded (mutate only via Refund children).
    status           Utf8 NOT NULL,
    -- Money triple — Int64 копейки. See header comment.
    amountMinor      Int64 NOT NULL,
    authorizedMinor  Int64 NOT NULL,
    capturedMinor    Int64 NOT NULL,
    currency         Utf8 NOT NULL,
    -- IETF Idempotency-Key (`Idempotency-Key` HTTP header) tenant-scoped.
    -- UNIQUE so the API path can detect "I already created this" via index hit.
    idempotencyKey   Utf8 NOT NULL,
    -- OCC version — Int32 (NOT Uint32 per gotcha #9, JS number → Int32 inference).
    version          Int32 NOT NULL,
    -- 2026-2027 regulatory reservations (see canon "2026-2027 forward radar")
    payerInn         Utf8,            -- СБП B2B mandatory 01.07.2026
    saleChannel      Utf8 NOT NULL,   -- direct | ota | platform (289-ФЗ 01.10.2026)
    anomalyScore     Float,           -- ML fraud signal (V2 ML pipeline)
    -- Provider auth-hold expiry. NULL for synchronous providers (СБП, stub
    -- on success). Used by scheduled `expire` job at T+holdPeriodHours.
    holdExpiresAt    Timestamp,
    -- State-transition timestamps. CDC diffs them → activity / notifications.
    createdAt        Timestamp NOT NULL,
    updatedAt        Timestamp NOT NULL,
    authorizedAt     Timestamp,
    capturedAt       Timestamp,
    refundedAt       Timestamp,
    canceledAt       Timestamp,
    failedAt         Timestamp,
    expiredAt        Timestamp,
    -- Free-form provider failure reason (NEVER includes PAN — middleware
    -- redacts upstream). Useful for ops dashboards.
    failureReason    Utf8,
    -- Audit
    createdBy        Utf8 NOT NULL,
    updatedBy        Utf8 NOT NULL,
    PRIMARY KEY (tenantId, propertyId, bookingId, id),
    -- Receivables / aging dashboard query
    INDEX ixPaymentOrgStatus GLOBAL SYNC ON (tenantId, propertyId, status),
    -- Provider webhook dedup (NULL allowed multiple times per YDB UNIQUE
    -- semantics — each NULL is unique). Becomes a hard collision once
    -- provider returns the id.
    INDEX ixPaymentProvider GLOBAL UNIQUE SYNC ON (tenantId, providerCode, providerPaymentId),
    -- IETF Idempotency-Key dedup. UNIQUE per tenant — different tenants can
    -- generate same key (typeids are unique enough but defense-in-depth).
    INDEX ixPaymentIdempotency GLOBAL UNIQUE SYNC ON (tenantId, idempotencyKey)
);

ALTER TABLE payment SET (AUTO_PARTITIONING_BY_LOAD = ENABLED);

ALTER TABLE payment ADD CHANGEFEED payment_events WITH (
    MODE = 'NEW_AND_OLD_IMAGES',
    FORMAT = 'JSON',
    VIRTUAL_TIMESTAMPS = TRUE,
    RETENTION_PERIOD = Interval("PT72H"),
    TOPIC_AUTO_PARTITIONING = 'ENABLED'
);
