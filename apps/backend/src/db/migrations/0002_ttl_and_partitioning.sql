-- =============================================================================
-- Migration 0002 — TTL on invitation + AUTO_PARTITIONING_BY_LOAD on domain
-- =============================================================================
--
-- Context (all per memory project_ydb_specifics.md):
--
-- 1. TTL (YDB native row-eviction by column value):
--    `session` and `verification` already got inline `WITH (TTL = …)` in 0001.
--    `invitation` was missed — add it now. `Interval("PT0S")` = delete the row
--    exactly when `expiresAt` passes, no grace period. BA creates invitations
--    with a 7-day future `expiresAt`; once it's past, YDB auto-reaps.
--
-- 2. AUTO_PARTITIONING_BY_LOAD (updateable, verified empirically 2026-04-23):
--    Default is BY_SIZE only. For tenant-first PK tables, one heavy tenant can
--    monopolize a single partition under peak load (Sochi summer season is the
--    classic case). Enabling BY_LOAD lets YDB split hot partitions horizontally
--    on shard CPU, so one busy tenant no longer throttles everyone else.
--
--    We enable it across every domain-level table (tenant-first PK); Better
--    Auth tables (user/session/organization/…) have different PK shapes and
--    their hotspots live in BA's own query patterns — leave them.

ALTER TABLE invitation SET (TTL = Interval("PT0S") ON expiresAt);

ALTER TABLE property SET (AUTO_PARTITIONING_BY_LOAD = ENABLED);
ALTER TABLE roomType SET (AUTO_PARTITIONING_BY_LOAD = ENABLED);
ALTER TABLE room SET (AUTO_PARTITIONING_BY_LOAD = ENABLED);
ALTER TABLE ratePlan SET (AUTO_PARTITIONING_BY_LOAD = ENABLED);
ALTER TABLE availability SET (AUTO_PARTITIONING_BY_LOAD = ENABLED);
ALTER TABLE rate SET (AUTO_PARTITIONING_BY_LOAD = ENABLED);
ALTER TABLE booking SET (AUTO_PARTITIONING_BY_LOAD = ENABLED);
ALTER TABLE guest SET (AUTO_PARTITIONING_BY_LOAD = ENABLED);
ALTER TABLE job SET (AUTO_PARTITIONING_BY_LOAD = ENABLED);
ALTER TABLE webhookInbox SET (AUTO_PARTITIONING_BY_LOAD = ENABLED);
ALTER TABLE migrationReport SET (AUTO_PARTITIONING_BY_LOAD = ENABLED);
ALTER TABLE consentLog SET (AUTO_PARTITIONING_BY_LOAD = ENABLED);
ALTER TABLE organizationProfile SET (AUTO_PARTITIONING_BY_LOAD = ENABLED);
