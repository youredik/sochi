-- M10 / A7.1 — channel_sync_log: append-only diagnostic log for channel sync events.
--
-- NOT a primary state table — that's `channelDispatch` (0052) for outbound retry
-- state + `inbox` (0053) for inbound dedup. This table is forensic / admin-UI
-- timeline view: «what did channel X attempt + receive, by tenant, по дате?».
--
-- Append-only, TTL 90 days. NO update/delete by application code.

CREATE TABLE channelSyncLog (
    tenantId    Utf8 NOT NULL,
    propertyId  Utf8 NOT NULL,
    channelId   Utf8 NOT NULL,
    eventAt     Timestamp NOT NULL,
    id          Utf8 NOT NULL, -- random UUID per row
    direction   Utf8 NOT NULL, -- 'outbound' | 'inbound'
    eventKind   Utf8 NOT NULL, -- 'ari_pushed' | 'booking_created' | 'booking_cancelled' | 'sync_disabled' | 'auth_refreshed' | ...
    severity    Utf8 NOT NULL, -- 'info' | 'warn' | 'error'
    summary     Utf8 NOT NULL,
    detailJson  Json,
    PRIMARY KEY (tenantId, propertyId, channelId, eventAt, id)
) WITH (TTL = Interval("P90D") ON eventAt);

ALTER TABLE channelSyncLog SET (AUTO_PARTITIONING_BY_LOAD = ENABLED);
