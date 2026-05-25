-- =============================================================================
-- Migration 0075 — DemoInbox capture persistence (Round 7 v3 race fix)
-- =============================================================================
--
-- Round 7 v3 2026-05-25 — eliminates DemoInbox multi-instance race.
--
-- ## Root cause being fixed
--
-- DemoInboxAdapter was in-process `Map<email, captures[]>` singleton. YC
-- Serverless Container с `min_instances=1` auto-scales к multiple instances
-- under concurrent load (per yandex.cloud docs container.md «If the container
-- is invoked faster than the instance can process the request, the service
-- scales the container by running additional instances»). Capture lands on
-- instance X, inbox poll routes to instance Y → 50/50 race на every demo
-- visit.
--
-- Empirical: E2 smoke `[E2] return-visit` reproduced 3/3 локально 2026-05-25;
-- `repro2-/dup-test-...` curl tests showed null capture after 10s — clear
-- evidence of multi-instance state isolation OR BA send pipeline tail-latency
-- exceeding singleton's TTL window.
--
-- ## Solution
--
-- YDB-backed persistence + native TTL (P6M = magic-link TTL 5min + 1min slack).
-- All container instances share same YDB state → race eliminated by design.
-- Native YC services first canon ([[feedback_native_yc_services_first_canon_
-- 2026_05_24]]) — TTL handled by YDB without application cron.
--
-- ## Schema
--
-- PK (email, capturedAt) supports multiple captures per email + time-ordered
-- iteration. capturedAt also drives TTL — YDB auto-deletes rows older than
-- 6 minutes.
--
-- ## Cost (free tier impact)
--
-- Demo volume: ~10 captures/day × 30 days = 300 rows × ~500 bytes = ~150 KB
-- steady-state (TTL keeps только 6-min window in practice ~10 rows live).
-- YDB Serverless free tier: 1 GB storage + 1M operations/month. Demo uses
-- <0.01% capacity. Cost: ₽0/мес.

CREATE TABLE IF NOT EXISTS demoInboxCapture (
    email          Utf8 NOT NULL,
    capturedAt     Timestamp NOT NULL,
    -- nullable: capture-only-subject emails (welcome ping без magic-link).
    magicLinkUrl   Utf8,
    subject        Utf8 NOT NULL,
    PRIMARY KEY (email, capturedAt)
) WITH (TTL = Interval("PT6M") ON capturedAt);

ALTER TABLE demoInboxCapture SET (AUTO_PARTITIONING_BY_LOAD = ENABLED);
