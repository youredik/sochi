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

-- NOTE: superAdmin table is ALREADY created in 0001_init.sql with schema
-- (userId PK, grantedAt, grantedBy). This migration originally tried to
-- CREATE it again with a different schema (createdAt, note), which fails
-- on a fresh DB because 0001 ran first. Removed the duplicate CREATE —
-- impersonation schema only needs the activity.impersonatorUserId column.
-- Caught 2026-04-24 when docker compose down -v + migrate surfaced the
-- conflict.
