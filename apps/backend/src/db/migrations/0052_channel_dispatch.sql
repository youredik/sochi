-- M10 / A7.1 — channel_dispatch: outbound retry state per R3b verdict.
--
-- Per `plans/m10_canonical.md` §2 D14 + D14.b (post-R3 revision):
--   - CDC = fan-out only; this table = retry state for external HTTP delivery.
--   - YDB CDC «exactly-once» applies к topic write, NOT external HTTP side-effect.
--   - Hookdeck 2026 tiered retry canon: 100ms → 500ms → 1m → 5m → 15m → 30m
--     → 1h × 5-10 → hourly to 72h → DLQ. ~30 retries over 72h.
--   - Per-(tenantId, channelId) circuit breaker auto-disable after 7 days
--     continuous failure (Apaleo precedent).
--
-- CDC consumer (workers/cdc-consumer.ts existing) reads booking/rate/availability
-- CHANGEFEED → fans out INSERT into channelDispatch (one row per active channel
-- per tenant). Separate dispatcher poller works this table; CDC consumer не
-- знает HTTP.
--
-- idempotencyKey = deterministic `${tenantId}:${aggregateId}:${cdcVersion}:${channelId}`
-- → sent в HTTP header AND embedded в payload (TL has no header support — we
-- send в обоих).

CREATE TABLE channelDispatch (
    tenantId        Utf8 NOT NULL,
    dispatchId      Utf8 NOT NULL, -- UUID v4 per dispatch row
    channelId       Utf8 NOT NULL,
    -- Source CloudEvent identity (idempotency tuple per CE 1.0.2).
    eventSource     Utf8 NOT NULL,
    eventId         Utf8 NOT NULL,
    eventType       Utf8 NOT NULL,
    -- Idempotency key sent в HTTP — caller-deterministic.
    idempotencyKey  Utf8 NOT NULL,
    payloadJson     Json NOT NULL,
    -- Retry state per Hookdeck tiered canon.
    attemptCount    Int32 NOT NULL,
    lastHttpStatus  Int32,
    lastErrorJson   Json,
    nextAttemptAt   Timestamp NOT NULL,
    -- 'pending' = scheduled для next attempt
    -- 'sent'    = HTTP 2xx received
    -- 'dlq'     = exceeded ~30 retries / 72h budget
    -- 'disabled' = adapter circuit-breaker auto-disabled (per-tenant per-channel)
    status          Utf8 NOT NULL,
    createdAt       Timestamp NOT NULL,
    updatedAt       Timestamp NOT NULL,
    PRIMARY KEY (tenantId, dispatchId),
    -- Dispatcher poller scans pending rows by nextAttemptAt.
    INDEX idxDispatchPending GLOBAL SYNC ON (status, nextAttemptAt),
    -- Per-(tenantId, channelId) failure-rate aggregation для circuit breaker.
    INDEX idxDispatchByChannel GLOBAL SYNC ON (tenantId, channelId, status)
);

ALTER TABLE channelDispatch SET (AUTO_PARTITIONING_BY_LOAD = ENABLED);
