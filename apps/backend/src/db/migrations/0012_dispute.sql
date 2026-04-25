-- =============================================================================
-- Migration 0012 — M6 Payment domain pt.6: Dispute (chargeback)
-- =============================================================================
--
-- Card-network dispute / chargeback row. One Payment → 0+ Disputes (rare;
-- typical hotel sees <0.1% chargeback rate, but a single dispute can be
-- 100K+ ₽ so we need first-class handling).
--
-- Canon (memory `project_payment_domain_canonical.md`):
--   - 5-state SM: opened → evidence_submitted → won | lost | expired.
--   - won: blocks new refund 180d (`representmentBlockedUntil`) — networks
--     can re-present the same case within this window.
--   - lost: auto-creates compensating Refund with `causalityId='dispute:<id>'`
--     UNIQUE (canon #15 — see refund migration 0009 ixRefundCausality).
--   - expired: dueAt passed without evidence → auto-lost in most cases.
--
-- ## Why dispute as a first-class table (not in payment row)
--
-- A single payment can have multiple disputes (rare but legal — e.g.
-- partial dispute then full dispute when guest escalates). Each dispute
-- has its own SM, its own evidence package, its own provider id. Storing
-- as a child table mirrors the network model 1:1.
--
-- ## Money model
--
-- `amountMinor Int64` копейки — disputed amount (may differ from
-- `payment.amountMinor` for partial disputes; e.g. guest disputes only
-- the minibar charge from a 3-night stay).
--
-- ## Auto-refund on lost
--
-- Domain layer (M6.5 dispute consumer) listens for `status` transition
-- to `lost` and creates a Refund with:
--   `causalityId = 'dispute:' + dispute.id`
--   `amountMinor = dispute.amountMinor`
-- The UNIQUE on `ixRefundCausality` (migration 0009) guarantees idempotent
-- creation under retry / replay.
--
-- ## Anti-fraud: representmentBlockedUntil
--
-- After a `won` decision, card networks (Visa/MC) typically allow the
-- merchant 180d before the cardholder can re-dispute the same charge.
-- We set `representmentBlockedUntil = resolvedAt + 180d` and the refund
-- domain checks this column before accepting a `dispute:` causality
-- refund (canon invariant #5: dispute won → no Refund 180d).
--
-- ## Indexes
--
-- - PK `(tenantId, paymentId, id)` — single-shard query for "all disputes
--   on payment X" (correction-chain analog).
-- - `ixDisputeProvider GLOBAL UNIQUE SYNC ON (tenantId, providerCode, providerDisputeId)`
--   — provider-side dedup (network case id is unique per provider).
-- - `ixDisputeStatus GLOBAL SYNC ON (tenantId, status)` — ops dashboard
--   (open disputes by tenant, evidence-submission deadlines).
-- - `ixDisputeDueAt GLOBAL SYNC ON (tenantId, status, dueAt)` — scheduler
--   for auto-expire job (find opened/evidence_submitted with dueAt < now).
--
-- ## CHANGEFEED
--
-- `dispute_events` for downstream consumers:
--   - activity_writer — every state transition → `activity` row.
--   - refund_creator_writer — `lost` transition → auto-create Refund
--     with `causalityId='dispute:<id>'`.
--
-- =============================================================================

CREATE TABLE dispute (
    tenantId          Utf8 NOT NULL,
    paymentId         Utf8 NOT NULL,
    id                Utf8 NOT NULL,
    -- Mirror of payment.providerCode (frozen at create time).
    providerCode      Utf8 NOT NULL,
    -- Network case id — set by provider via webhook. NULL until provider
    -- confirms. UNIQUE (with NULL multiplicity allowed per YDB semantics).
    providerDisputeId Utf8,
    -- Network reason code: 4853, 4855, 10.4, 13.1, etc. Free-form Utf8 —
    -- card networks evolve codes over time and we don't want a migration
    -- for every new variant.
    reasonCode        Utf8 NOT NULL,
    -- 5-state SM. Terminal: won | lost | expired.
    --   opened → evidence_submitted → won | lost | expired
    status            Utf8 NOT NULL,
    -- Disputed amount in копейки (may be < payment.amountMinor for partial).
    amountMinor       Int64 NOT NULL,
    currency          Utf8 NOT NULL,
    -- Evidence package: JSON metadata about uploaded documents (PDFs of
    -- guest registration card, signed folio, communications log).
    -- Document binaries themselves live in object storage; we store
    -- metadata + URIs here for audit reproducibility.
    evidenceJson      Json,
    -- Provider deadline for evidence submission (network sets this when
    -- opening the case). Auto-expire job runs against this column.
    dueAt             Timestamp NOT NULL,
    -- When we submitted evidence to the provider (status -> evidence_submitted).
    submittedAt       Timestamp,
    -- When the network resolved the case (status -> won | lost).
    resolvedAt        Timestamp,
    -- Free-form network outcome message (e.g. "Cardholder withdrew claim").
    outcome           Utf8,
    -- After `won`, this row blocks new dispute-causality refunds for 180d
    -- to prevent merchant abuse / network re-presentment race. Set by
    -- domain layer on the `won` transition: resolvedAt + 180d.
    representmentBlockedUntil Timestamp,
    -- OCC version (Int32 per gotcha #9).
    version           Int32 NOT NULL,
    -- State-transition timestamps for CDC diff projection.
    createdAt         Timestamp NOT NULL,
    updatedAt         Timestamp NOT NULL,
    -- Audit.
    createdBy         Utf8 NOT NULL,
    updatedBy         Utf8 NOT NULL,
    PRIMARY KEY (tenantId, paymentId, id),
    -- Provider-side dedup (network case id)
    INDEX ixDisputeProvider GLOBAL UNIQUE SYNC ON (tenantId, providerCode, providerDisputeId),
    -- Ops dashboard
    INDEX ixDisputeStatus GLOBAL SYNC ON (tenantId, status),
    -- Scheduled auto-expire job
    INDEX ixDisputeDueAt GLOBAL SYNC ON (tenantId, status, dueAt)
);

ALTER TABLE dispute SET (AUTO_PARTITIONING_BY_LOAD = ENABLED);

ALTER TABLE dispute ADD CHANGEFEED dispute_events WITH (
    MODE = 'NEW_AND_OLD_IMAGES',
    FORMAT = 'JSON',
    VIRTUAL_TIMESTAMPS = TRUE,
    RETENTION_PERIOD = Interval("PT72H"),
    TOPIC_AUTO_PARTITIONING = 'ENABLED'
);
