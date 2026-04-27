-- =============================================================================
-- Migration 0026 — featureFlag: per-tenant feature toggles
-- =============================================================================
--
-- Lightweight feature-flag store. M8.0 prep — see plans/local-complete-system-v2.md §6
-- and plans/research/architecture-patterns.md §1.3.
--
-- Why this exists (NOT Unleash / NOT LaunchDarkly):
--
--   The wave-3 architecture research recommended OpenFeature + Flagd / Unleash /
--   LaunchDarkly. After self-audit (user mandate "только Yandex Cloud, native стек")
--   we rejected those — Unleash / LaunchDarkly are non-RU SaaS, and adding
--   OpenFeature client + provider for the current scale (≤6 distinct flags)
--   is over-engineering. Plan v2 §15.2 captures the canonical choice:
--
--     Phase 1 (NOW)     — env vars + this DB table per-tenant override.
--     Phase 2 (later)   — Flagd self-host in Yandex Cloud k8s if/when needed.
--     Phase 3 (NEVER)   — Unleash/LaunchDarkly SaaS.
--
-- Resolution semantics (application-level, see env.ts + the flag service):
--
--   1. ENV (process-level boolean, e.g. `FEATURE_EPGU_ENABLED=true`) is the
--      hard floor. If the env says `false`, the feature is OFF for everyone,
--      regardless of DB rows. Operators turning a feature off must always
--      win — DB drift can't override a deliberate kill-switch.
--   2. DB row per (tenantId, key) — overrides ENV `true` per-tenant only when
--      env says ON (i.e. allows opting OUT a specific tenant from a globally
--      enabled feature, OR opting IN a specific tenant to a beta feature).
--   3. Default — env-true means ON for all tenants without a DB row.
--
-- Keys are free-form strings (not enum) so adding a new flag is a code-only
-- change, no migration. We rely on TypeScript Zod-validated names at the
-- service boundary.
--
-- ## Data lifecycle
--
--   - Insert when an admin overrides a flag in the UI.
--   - Update when the value changes; bump `updatedAt` + `updatedBy`.
--   - Delete (or set `enabled=null`?) when reverting to env-default. Choosing
--     DELETE here — null in `enabled` would be ambiguous («unset» vs «forced
--     off»). The DB row is the override; absence of row = «follow env».
--
-- ## Why no global (tenant-less) flags
--
--   Global flags belong in env vars (kill switch, gradual rollout). Per-tenant
--   overrides belong here. Two-tier separation prevents the «accidentally
--   disabled production for everyone» class of incidents.
--
-- =============================================================================

CREATE TABLE featureFlag (
    -- Tenant-scoped. PK starts with tenantId so per-tenant flag listing is a
    -- single-shard scan (admin UI «show all overrides for org X»).
    tenantId  Utf8 NOT NULL,

    -- Stable feature identifier, free-form string. Convention: snake_case.
    -- Examples: 'epgu_enabled', 'public_widget_enabled', 'mcp_server_enabled',
    -- 'channel_manager_enabled', 'kpi_dashboard_v2'.
    -- Validated against an allow-list at the service boundary (Zod enum).
    key       Utf8 NOT NULL,

    -- Simple boolean override. NOT nullable — absence of a row is the «follow
    -- env» state, presence with `enabled=true/false` is the explicit override.
    enabled   Bool NOT NULL,

    -- Optional reason / ticket reference for the override. Surfaced in the
    -- admin UI for ops handoff.
    reason    Utf8,

    -- Optional auto-expiry. NULL = permanent override. Workers / admin UI
    -- can warn/clean up expired overrides. NOT enforced by YDB CHECK
    -- (no CHECK in YDB) — application-level invariant.
    expiresAt Timestamp,

    -- Audit
    createdAt Timestamp NOT NULL,
    createdBy Utf8 NOT NULL,
    updatedAt Timestamp NOT NULL,
    updatedBy Utf8 NOT NULL,

    PRIMARY KEY (tenantId, key)
);

ALTER TABLE featureFlag SET (AUTO_PARTITIONING_BY_LOAD = ENABLED);
