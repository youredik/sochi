-- M10 / A7.1 — webhook secret rotation table (D25 multi-key kid).
--
-- Per `plans/m10_canonical.md` §2 D25: Standard Webhooks signature scheme с
-- multi-key rotation built-in. NOT JWKS — flat in-memory rotation per channel.
--
-- Rotation flow:
--   1. New secret → INSERT с status='active', existing 'active' → 'previous'
--   2. 48h grace period — verifier accepts BOTH active + previous
--   3. After grace → INSERT marker UPDATE 'previous' → 'expired' (manual or cron)
--
-- For Mock channels, secret is dev-time stub (whsec_mock_*). For sandbox/live
-- channels, secret comes из YC Lockbox per D29.

CREATE TABLE webhookSecret (
    -- Channel scope (per channelId — NOT per-tenant; one secret rotates across
    -- all tenants who receive from this channel. Per-tenant separation lives
    -- on Lockbox secret slot reference в channelConnection.credentialsLockboxRef).
    channelId    Utf8 NOT NULL,
    -- Key id для multi-key signature `v1,<base64>` — emitted в metric tag
    -- `webhook.signature.legacy_key_used{kid}` for cutover observability.
    kid          Utf8 NOT NULL,
    secret       Utf8 NOT NULL,
    -- 'active' (current canonical) | 'previous' (in 48h rotation grace)
    -- | 'expired' (do not accept).
    status       Utf8 NOT NULL,
    activatedAt  Timestamp NOT NULL,
    expiresAt    Timestamp,
    PRIMARY KEY (channelId, kid),
    INDEX idxWebhookSecretActive GLOBAL SYNC ON (channelId, status)
);

ALTER TABLE webhookSecret SET (AUTO_PARTITIONING_BY_LOAD = ENABLED);
