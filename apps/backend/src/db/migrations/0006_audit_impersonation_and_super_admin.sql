-- Migration 0006: Impersonation support in audit log + superAdmin table.
--
-- Source: Pigment Engineering, "Safe User Impersonation", 2026-04-08
--   https://engineering.pigment.com/2026/04/08/safe-user-impersonation/
--
-- Pattern: every mutation activity carries both the nominal actor (the
-- tenant user whose identity was used) AND — if present — the super-admin
-- who was acting as that user. UI + compliance reports read both so
-- "Ivan cancelled booking X" never hides "support-team impersonated Ivan".
--
-- M5a ships the schema only. The actual impersonation initiate-flow
-- (UI, short-lived signed JWT, read-only middleware, CI annotation gate)
-- is deferred to phase 2+. Getting the column in place now avoids the
-- 100-routes retrofit Pigment explicitly flags as expensive-later.

-- 1. Nullable: NULL means "the actor themselves did it", non-NULL means
--    "a super-admin was impersonating them". Index not required — we
--    query by tenantId/objectType/recordId already (composite PK), and
--    impersonation is expected to be rare enough that a full-scan filter
--    suffices for the audit-log UI.
ALTER TABLE activity ADD COLUMN impersonatorUserId Utf8?;

-- 2. superAdmin table — allow-list for platform ops / support. Separate
--    from tenant `user` / `member` so role escalation requires an explicit
--    row here, not a column flip on a regular user. Seeded post-deploy
--    via `yc` CLI or a protected migration seed; empty in local dev.
--
--    No TTL — super-admins persist until explicitly removed. `note` is
--    free-form ("Ivanov, 1st-line support") for audit clarity; surface it
--    in impersonation trail rendering.
CREATE TABLE superAdmin (
    userId    Utf8 NOT NULL,
    createdAt Timestamp NOT NULL,
    note      Utf8,
    PRIMARY KEY (userId)
);
