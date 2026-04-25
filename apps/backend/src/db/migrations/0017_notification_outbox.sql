-- =============================================================================
-- Migration 0017 — M6.5B: notificationOutbox (transactional outbox pattern)
-- =============================================================================
--
-- Production-grade outbox for guest + ops notifications. Created in the SAME
-- tx as the source state transition (via `notification_writer` CDC handler),
-- so we never lose the intent of "send guest a receipt link" because the
-- email service was momentarily down. A separate worker (Phase 3) reads
-- `WHERE status = 'pending'` rows and dispatches via SMTP / SMS / push.
--
-- Per canon `feedback_no_halfway`: notification_writer is NOT a logger-only
-- stub. It writes a real persisted row that survives crashes. The actual
-- email send happens at Phase 3 when SMTP integration ships.
--
-- ## Trigger sources
--
-- Created by `notification_writer` CDC handler (handlers/notification.ts)
-- on these source events (registered via migration 0015):
--   - `payment/payment_events`:
--       * payment.status → 'succeeded' → kind='payment_succeeded'
--         (guest receipt link)
--       * payment.status → 'failed'    → kind='payment_failed'  (ops alert)
--   - `receipt/receipt_events`:
--       * receipt.status → 'confirmed' → kind='receipt_confirmed'
--         (guest QR-код email per 54-ФЗ delivery)
--       * receipt.status → 'failed'    → kind='receipt_failed'  (ops fiscal alert)
--
-- ## Idempotency
--
-- `sourceEventDedupKey` = `${sourceObjectType}:${sourceObjectId}:${kind}` —
-- UNIQUE per tenant. The handler does SELECT-then-UPSERT inside the CDC
-- consumer's tx; redelivery of the same source event sees the existing
-- notification row and skips. UNIQUE collision is the canonical YDB
-- dedup pattern (same as refund causality, payment idempotency keys).
--
-- ## Status SM (3-state, simple)
--
-- `pending → sent | failed`. Both `sent` and `failed` terminal. `failed`
-- after `retryCount` exhaustion → ops dashboard alert (no auto-retry on
-- terminal). retryCount bumps inside attempt, status stays `pending` until
-- decision.
--
-- ## Channel
--
-- `email | sms | push` — V1 emits all as `email` (V1 SMTP only via Mailpit
-- in dev, Yandex Cloud SES in prod when SES integration ships Phase 3).
-- SMS / push are V2.
--
-- =============================================================================

CREATE TABLE notificationOutbox (
    tenantId         Utf8 NOT NULL,
    id               Utf8 NOT NULL,
    -- Notification kind:
    --   'payment_succeeded' | 'payment_failed' | 'receipt_confirmed' | 'receipt_failed'
    --   (extensible — service layer maps kind → template)
    kind             Utf8 NOT NULL,
    -- Channel:
    --   'email' | 'sms' | 'push' (V1: email only)
    channel          Utf8 NOT NULL,
    -- Recipient: email address, E.164 phone, or push endpoint id.
    recipient        Utf8 NOT NULL,
    -- Subject line (email) / SMS preview / push title.
    subject          Utf8 NOT NULL,
    -- Pre-rendered body text. NULL means worker renders from template at
    -- send time (template id encoded in `kind`). For V1 we rely on the
    -- worker to render; column reserved.
    bodyText         Utf8,
    -- Template variables / contextual data. JSON.
    payloadJson      Json NOT NULL,
    -- 3-state SM: pending → sent | failed (terminal both).
    status           Utf8 NOT NULL,
    -- State-transition timestamps for CDC diffing.
    sentAt           Timestamp,
    failedAt         Timestamp,
    -- Free-form failure reason from SMTP / SMS gateway.
    failureReason    Utf8,
    -- Send attempt counter. Worker bumps before each call; ops sees stuck
    -- pending rows with retryCount >= N.
    retryCount       Int32 NOT NULL,
    -- Source identity: which domain row triggered this notification.
    sourceObjectType Utf8 NOT NULL, -- 'payment' | 'receipt' (V1)
    sourceObjectId   Utf8 NOT NULL,
    -- Dedup key: `${sourceObjectType}:${sourceObjectId}:${kind}`. UNIQUE per tenant.
    sourceEventDedupKey Utf8 NOT NULL,
    -- Audit
    createdAt        Timestamp NOT NULL,
    updatedAt        Timestamp NOT NULL,
    createdBy        Utf8 NOT NULL,
    updatedBy        Utf8 NOT NULL,
    PRIMARY KEY (tenantId, id),
    -- Pending-rows query for the worker (retry job)
    INDEX ixNotificationStatus GLOBAL SYNC ON (tenantId, status),
    -- Idempotency dedup — UNIQUE per tenant on (sourceObjectType, sourceObjectId, kind).
    -- Encoded as a single key column to keep the inline UNIQUE simple
    -- (gotcha #12: UNIQUE inline only at CREATE TABLE).
    INDEX ixNotificationDedup GLOBAL UNIQUE SYNC ON (tenantId, sourceEventDedupKey)
);

ALTER TABLE notificationOutbox SET (AUTO_PARTITIONING_BY_LOAD = ENABLED);

-- No CHANGEFEED — outbox state is consumed by the dispatcher worker,
-- which polls or listens via separate mechanism. Adding a CHANGEFEED
-- now would be premature; can be added later for an "all notifications"
-- audit consumer if requested.
