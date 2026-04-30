-- 0045_magic_link_token.sql — M9.widget.5 — single-use magic-link tokens.
--
-- Stateful single-use enforcement: atomic UPDATE WHERE consumedAt IS NULL inside
-- serializable transaction. Per `plans/m9_widget_5_canonical.md` §D1: two-step
-- GET-render → POST-consume для mutate (Apple MPP / Slack unfurl prefetch DoS
-- защита) + allowedAttempts >= 1 — для view scope = 5, для mutate = 1.
--
-- Per-tenant — tenant.organizationProfile.magicLinkSecret signs JWT (HS256,
-- jose 6.2.3); table records consumption + audit metadata (152-ФЗ ст. 22.1
-- DPO recordkeeping).
--
-- Retention: 30 days post-expiry для audit window (cleanup cron M11+).

CREATE TABLE IF NOT EXISTS magicLinkToken (
    tenantId            Utf8 NOT NULL,
    jti                 Utf8 NOT NULL,
    bookingId           Utf8 NOT NULL,
    scope               Utf8 NOT NULL,            -- 'view' | 'mutate'
    issuedAt            Timestamp NOT NULL,
    expiresAt           Timestamp NOT NULL,
    consumedAt          Timestamp,                -- NULL = active; non-NULL = consumed
    consumedFromIp      Utf8,                     -- audit (152-ФЗ ст. 22.1)
    consumedFromUa      Utf8,                     -- audit
    issuedFromIp        Utf8,                     -- audit (для «consume from different IP» admin alert)
    attemptsRemaining   Int32 NOT NULL,           -- view tokens=5; mutate tokens=1
    PRIMARY KEY (tenantId, jti),
    INDEX idxMagicLinkBooking GLOBAL SYNC ON (tenantId, bookingId),
    INDEX idxMagicLinkExpires GLOBAL SYNC ON (tenantId, expiresAt)
);

-- Per-tenant magic-link signing secret. 32-byte cryptographically random,
-- base64-encoded. Phase 1: column-stored on organizationProfile. Phase 2
-- (Track B5/Lockbox): replace with Lockbox secret reference.
ALTER TABLE organizationProfile ADD COLUMN magicLinkSecret Utf8;
