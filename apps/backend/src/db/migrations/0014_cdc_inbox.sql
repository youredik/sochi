-- =============================================================================
-- Migration 0014 — M6 Payment domain pt.8: cdcInbox (at-least-once dedup)
-- =============================================================================
--
-- At-least-once consumer dedup — copied verbatim pattern from stankoff-v2
-- per canon (memory `project_payment_domain_canonical.md` "Concurrency").
-- Source: stankoff-v2 `apps/backend/src/services/cdc-consumer.ts` + the
-- consumer-side `INSERT INTO cdcInbox WHERE NOT EXISTS` guard pattern.
--
-- ## Why this table exists
--
-- YDB topic readers deliver messages AT LEAST ONCE — in failure modes,
-- the same `(topic, partitionId, offset)` may be redelivered after a
-- consumer restart. Without dedup, a payment.succeeded event could fire
-- the activity_writer projection twice → duplicate audit row → reporting
-- shows 2x revenue. Money domain demands stronger semantics.
--
-- The cdcInbox table tracks (per consumer) which messages have already
-- been processed. Each consumer's projection wraps:
--
--   await sql.begin(async (tx) => {
--     // 1. Try to claim this offset for this consumer
--     await tx`
--       UPSERT INTO cdcInbox
--         (consumerName, topic, partitionId, offset, processedAt)
--       VALUES (?, ?, ?, ?, ?)
--     `
--     // 2. If we got here without throwing, this is the first time we see
--     //    this offset for this consumer — apply the projection.
--     await projectionHandler(event)
--   })
--
-- The PK collision on a re-delivered offset would surface as a YDB error
-- but the IF NOT EXISTS / UPSERT pattern uses tx semantics: the projection
-- is applied iff this is a new offset within the consumer's history.
--
-- ## Why Int64 for partitionId / offset
--
-- @ydbjs/topic 6.1.x exposes partition IDs and offsets as bigint. JS
-- number → Int32 inference (gotcha #9) would cap us at 2^31 partitions /
-- offsets, which is fine for partitions but offsets in a long-running
-- topic exceed Int32 quickly. Int64 is the safe choice.
--
-- ## Why TTL on processedAt
--
-- Consumer rewinds beyond 30d would re-process old events. CHANGEFEED
-- retention is 24-72h (canon), so 30d in cdcInbox is generous slack —
-- well beyond any plausible rewind window. After 30d, GC reclaims rows.
--
-- ## PK
--
-- `(consumerName, topic, partitionId, offset)` — natural composite key.
-- consumerName leads so each consumer's history is co-located on shard.
--
-- ## No indexes besides PK
--
-- The only query pattern is the UPSERT-claim above. No range scans.
--
-- =============================================================================

CREATE TABLE cdcInbox (
    -- Consumer name as registered via ALTER TOPIC ... ADD CONSUMER.
    -- E.g. 'activity_writer', 'folio_balance_writer', 'notification_writer'.
    consumerName     Utf8 NOT NULL,
    -- Topic path — for table changefeeds, format `<table>/<changefeedName>`.
    -- E.g. 'payment/payment_events'.
    topic            Utf8 NOT NULL,
    -- Partition id within the topic. @ydbjs/topic exposes as bigint.
    partitionId      Int64 NOT NULL,
    -- Offset within the partition. Monotonic per partition. Int64 to
    -- avoid Int32 ceiling on long-running topics (gotcha #9).
    offset           Int64 NOT NULL,
    -- When the consumer's projection committed (used as TTL anchor).
    processedAt      Timestamp NOT NULL,
    PRIMARY KEY (consumerName, topic, partitionId, offset)
);

ALTER TABLE cdcInbox SET (AUTO_PARTITIONING_BY_LOAD = ENABLED);

-- 30-day window — well beyond CHANGEFEED retention (24-72h canon),
-- so any plausible consumer rewind / replay finds dedup history intact.
ALTER TABLE cdcInbox SET (TTL = Interval("P30D") ON processedAt);
