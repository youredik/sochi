-- =============================================================================
-- Migration 0010 — M6 Payment domain pt.4: paymentWebhookEvent
-- =============================================================================
--
-- Provider-agnostic webhook inbox for the payment domain. Distinct from the
-- generic `webhookInbox` table (0001) which is reserved for МВД / РКЛ /
-- channel-manager webhooks where tenant resolution happens separately.
--
-- Why a dedicated payment table:
--   - tenantId is NOT NULL (multi-tenant safety; webhook payloads are
--     resolved to a tenant via providerPaymentId → payment lookup BEFORE
--     insert, so we always know which tenant to scope the row to).
--   - Replay-safety dedup keys are provider-specific:
--       * T-Kassa: HMAC-SHA256-verified `event_id` from header (canon).
--       * ЮKassa: synthesized `${providerPaymentId}|${event}|${status}|${amount_value}`
--         (no native HMAC — IP allowlist only; we synthesise stable key).
--       * СБП (НСПК): mTLS cert verified + НСПК `transactionId` as dedup.
--       * Stub: header `X-Stub-Signature: stub-ok` + UUID(requestId).
--   - 30-day TTL on `verifiedAt` covers the maximum provider replay window
--     (T-Kassa redelivers up to 24h, ЮKassa up to 14d on disputes).
--
-- ## Table shape
--
-- PK `(tenantId, providerCode, dedupKey)` — every webhook is uniquely
-- identified within its tenant + provider scope. UNIQUE PK is the dedup
-- mechanism: a duplicate redelivery hits PK collision (translatable to
-- domain `WebhookAlreadyProcessedError` via `err.cause.code === 400120`,
-- canon pattern from M6.2/M6.3).
--
-- ## Why no CHANGEFEED
--
-- This table IS the event sink — adding a changefeed on it would create a
-- circular processing chain. Downstream effects (creating Payment, Refund,
-- Dispute rows) happen INLINE from the webhook handler (canon: webhook is
-- the synchronous boundary; subsequent state transitions emit their OWN
-- changefeeds — payment_events, refund_events, dispute_events).
--
-- ## Gotchas applied
--
-- - tenantId NOT NULL (different from generic webhookInbox).
-- - TTL on `verifiedAt` (Timestamp), not on a Datetime — Datetime is
--   second-resolution and we need ms precision for replay de-dup windows.
-- - `payloadJson Json` (parsed AFTER HMAC verification — canon: HMAC
--   verify on raw bytes BEFORE JSON.parse).
-- - signatureHeader stored for audit (some providers update keys; we want
--   to be able to re-verify months later if needed).
--
-- ## Indexes
--
-- - PK is the dedup index; no further UNIQUE needed.
-- - `ixWebhookEventProcessed GLOBAL SYNC ON (tenantId, processedAt)` —
--   ops dashboard "all unprocessed events" + retry job.
--
-- =============================================================================

CREATE TABLE paymentWebhookEvent (
    tenantId         Utf8 NOT NULL,
    -- Provider taxonomy — matches `payment.providerCode`
    --   stub | yookassa | tkassa | sbp | digital_ruble
    providerCode     Utf8 NOT NULL,
    -- Provider-specific dedup key (see header for synthesis rules)
    dedupKey         Utf8 NOT NULL,
    -- Provider event name (e.g. 'payment.succeeded', 'refund.failed').
    -- Free-form Utf8 — providers evolve their event taxonomies and we don't
    -- want a migration every time T-Kassa adds a new event.
    eventType        Utf8 NOT NULL,
    -- Linked entities (set when resolvable from payload — NULL otherwise).
    -- These are NOT FKs (YDB has no FKs); they're correlation hints for ops.
    providerPaymentId Utf8,
    providerRefundId  Utf8,
    -- Parsed payload AFTER HMAC verification. Raw bytes are NOT stored —
    -- HMAC verification happens once, on the wire; storing raw bytes would
    -- duplicate sensitive cardholder data unnecessarily (PCI-DSS minimisation).
    payloadJson      Json NOT NULL,
    -- Original HTTP signature header (e.g. T-Kassa `Signature: <hex>`),
    -- preserved for audit / re-verification debugging.
    signatureHeader  Utf8,
    -- Source IP — useful for IP-allowlist provider audits (ЮKassa).
    sourceIp         Utf8,
    -- When we successfully verified the signature / IP-allowlist match.
    -- TTL anchor (30d). Always set on row insert.
    verifiedAt       Timestamp NOT NULL,
    -- When we processed the event (created Payment/Refund/Dispute, etc.).
    -- NULL = not yet processed (retry job picks these up).
    processedAt      Timestamp,
    -- If processing failed mid-flight, we record the reason here and the
    -- retry job re-runs. Failure is non-terminal — payload is preserved.
    processingError  Utf8,
    -- Audit: who/what consumed it (worker hostname or 'webhook-handler').
    processedBy      Utf8,
    PRIMARY KEY (tenantId, providerCode, dedupKey),
    -- Ops dashboard: pending vs processed, error filter
    INDEX ixWebhookEventProcessed GLOBAL SYNC ON (tenantId, processedAt)
);

ALTER TABLE paymentWebhookEvent SET (AUTO_PARTITIONING_BY_LOAD = ENABLED);

-- 30-day TTL covers max provider replay window (T-Kassa 24h + ЮKassa 14d
-- + dispute correlation 30d). After 30d the row is removed by YDB GC; if
-- we ever need longer retention, the row is also projected into
-- `activity` via the activity_writer consumer (separate audit trail).
ALTER TABLE paymentWebhookEvent SET (TTL = Interval("P30D") ON verifiedAt);
