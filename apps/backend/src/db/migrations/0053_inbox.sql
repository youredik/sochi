-- M10 / A7.1 — inbox: inbound webhook idempotency dedup.
--
-- Per `plans/m10_canonical.md` §2 D11 + D12 + D31 (stankoff-v2 028 borrow):
--   - CloudEvents 1.0.2 universal idempotency tuple `(source, id)` = composite PK.
--   - UNIQUE constraint enforced inside booking-create transaction.
--   - Duplicate webhook delivery → cached 200 idempotent return.
--
-- TTL 7 days (matches stankoff-v2 028-integration-dedupe.sql precedent).
-- signatureHash = HMAC-SHA256 of canonical signed string per Standard Webhooks
-- spec; stored для forensics + tamper detection on replay.

CREATE TABLE channelInbox (
    -- Composite PK = CloudEvents idempotency tuple (D11).
    source          Utf8 NOT NULL,
    eventId         Utf8 NOT NULL,
    -- Tenant scoping (cross-tenant isolation per `feedback_pre_done_audit.md` matrix).
    tenantId        Utf8 NOT NULL,
    channelId       Utf8 NOT NULL,
    eventType       Utf8 NOT NULL,
    receivedAt      Timestamp NOT NULL,
    -- Body raw-bytes hash для tamper detection (separate from signature).
    -- Differing bodies на same eventId → indicate replay attack OR sender bug.
    bodyHash        Utf8 NOT NULL,
    -- Webhook signature kid (Standard Webhooks v1) for rotation telemetry.
    signatureKid    Utf8,
    status          Utf8 NOT NULL, -- 'received' | 'processing' | 'processed' | 'failed'
    -- Cached 200 response для replay (returned идempotently on duplicate eventId).
    responseJson    Json,
    retryCount      Int32 NOT NULL,
    PRIMARY KEY (source, eventId),
    INDEX idxInboxByTenant GLOBAL SYNC ON (tenantId, channelId, receivedAt)
) WITH (TTL = Interval("P7D") ON receivedAt);

ALTER TABLE channelInbox SET (AUTO_PARTITIONING_BY_LOAD = ENABLED);
