-- 0048_widget_release_audit.sql — M9.widget.6 / А4.3
-- per plans/m9_widget_6_canonical.md §D26 — kill-switch atomicity + tamper-evidence
-- + project_m9_widget_6_canonical.md memory.
--
-- Append-only audit log for widget bundle release lifecycle. Every embed
-- bundle hash that gets PUBLISHED, REVOKED or RE-AUTHORIZED creates one
-- row. This is the forensic baseline when SRI hash revocation has to
-- happen (R2 F7 — there is no browser-side mechanism to invalidate a
-- pinned `<script integrity="sha384-…">` once a tenant page hardcodes it).
--
-- Why append-only:
--   * tamper-evidence — operators can READ the history but cannot rewrite
--     past actions (zero UPDATE/DELETE in production code paths).
--   * forensic base for incident response — when a tenant reports a
--     compromised bundle, audit log shows exactly when the hash was
--     published, who revoked it, and what reason was given.
--   * hash transparency — paired with `widget_release` table (latest
--     bundle hash per slug) this lets us answer «was hash X ever served?».
--
-- POST /embed/v1/_kill/:hash route writes:
--   1. UPDATE `widget_release` SET status = 'revoked' WHERE hash = :hash
--   2. INSERT INTO `widget_release_audit` (action='revoked', ...)
--   Both within a single sql.begin() YDB tx. CDN purge is fire-and-forget
--   AFTER the tx commits — never block on async edge propagation.
--
-- Retention: keep forever (small volume; audit-log canon).
-- Privacy: no PII — only operator user IDs + bundle hashes + reasons.
--
-- Related migrations:
--   * 0047_property_public_embed_domains.sql — sibling allowlist column
--
-- Cross-tenant data isolation:
--   tenantId is the partition key. Every read MUST `WHERE tenantId = ?` —
--   audit log is per-tenant, NOT system-global (operators see only their
--   own tenant's release history).

CREATE TABLE IF NOT EXISTS widgetReleaseAudit (
    tenantId            Utf8 NOT NULL,
    id                  Utf8 NOT NULL,             -- newId('widgetReleaseAudit')

    -- Bundle identity
    -- SHA-384 fingerprint of the IIFE bytes (matches SRI integrity= attr).
    hash                Utf8 NOT NULL,
    -- 'embed' | 'booking-flow' (Zod enforced repo-side)
    bundleKind          Utf8 NOT NULL,

    -- Lifecycle action
    -- 'published' | 'revoked' | 'reauthorized' (Zod enforced)
    action              Utf8 NOT NULL,
    -- Free-text reason, REQUIRED for 'revoked' (operator policy).
    -- Sanitized at insert: max 500 chars, NO \r\n (defense-in-depth для
    -- header-injection per D24 — even though this never flows back into
    -- response headers, treat as untrusted operator-controlled).
    reason              Utf8,

    -- Operator identity
    -- userId who triggered the action (or 'system:cron' for scheduled
    -- rotations; or 'system:ci' for CI-driven releases).
    actorUserId         Utf8 NOT NULL,
    -- Source of the action для forensic context.
    -- 'admin_ui' | 'cli' | 'ci' | 'cron'
    actorSource         Utf8 NOT NULL,

    -- Timing
    actionAt            Timestamp NOT NULL,
    createdAt           Timestamp NOT NULL,

    PRIMARY KEY (tenantId, id),

    -- Index by hash для look-up "is this hash valid right now?"
    -- (also sorts by latest action via secondary actionAt sort).
    INDEX idxWidgetReleaseAuditHash GLOBAL SYNC ON (tenantId, hash),
    -- Index by actionAt для retention scans + admin chronological views.
    INDEX idxWidgetReleaseAuditActionAt GLOBAL SYNC ON (tenantId, actionAt)
);
