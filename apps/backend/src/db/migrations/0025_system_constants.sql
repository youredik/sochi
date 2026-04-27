-- =============================================================================
-- Migration 0025 — system_constants: year-versioned regulatory constants
-- =============================================================================
--
-- Source-of-truth table for values that change by federal law / regional act
-- on a known schedule. Replaces hard-coded magic numbers across the codebase
-- (НДС rates, тур.налог percentages, НПД limits, УСН VAT thresholds, etc.).
--
-- Why this table exists (M8.0 prep — see plans/local-complete-system-v2.md §6):
--
--   The codebase had constants like `taxRateBps = 0  -- 0% accommodation` and
--   `2% tourism tax for Sochi 2026` hardcoded in migrations and workers. After
--   the wave-4 freshness research (plans/research/wave4-q1q2-2026-freshness.md)
--   we found:
--
--     1. 0% НДС accommodation льгота expires 30.06.2027 (NOT 31.12.2030 as
--        was assumed in earlier code comments) — Минфин поддержал продление
--        до 2030, но закон не принят на 27.04.2026.
--     2. Tourism tax Sochi rate grows by 1%/year: 2% (2026) → 3% (2027) →
--        4% (2028) → 5% (2029) (Решение ГорСобрания Sochi №100 от 31.10.2024).
--     3. НПД limit grows: 3.6 млн (2025) → 3.8 млн (2026) → 4.0 млн (2027)
--        → 4.2 млн (2028) (422-ФЗ + изменения).
--     4. НДС general 20% → 22% с 01.01.2026 (376-ФЗ от 12.07.2024).
--
--   Hardcoding any of these breaks silently when the year changes. This table
--   centralizes them with explicit `yearFrom`/`yearTo` ranges and a `source`
--   citation pointing to the original law.
--
-- ## Read pattern
--
--   await sql<[{ data: string }]>`
--     SELECT data FROM systemConstants
--     WHERE category = 'tax' AND key = 'vat_accommodation_rate_bps'
--       AND yearFrom <= ${currentYear} AND yearTo >= ${currentYear}
--   `
--
-- The repo (`apps/backend/src/domains/systemConstant/`) caches reads in
-- memory for 5 minutes — these constants change at most once per year so
-- aggressive caching is safe.
--
-- ## Seed
--
-- Initial values populated by `db/seed-system-constants.ts` (run after
-- `apply-migrations.ts` as part of `pnpm migrate`). Seed is idempotent
-- (UPSERT) so re-runs are safe.
--
-- ## Why no `tenantId` in PK
--
-- These are FEDERAL/REGIONAL regulatory constants — same for every tenant in
-- the same jurisdiction. If a multi-region future requires per-region
-- override (e.g. tourism tax differs by city), add `regionCode` to the PK in
-- a future migration. For now `Sochi` is implicit; non-Sochi tenants are
-- out of scope for V1.
--
-- =============================================================================

CREATE TABLE systemConstant (
    -- Category groups related constants for selective queries.
    --   'tax'     — rates / vat_codes / fiscal_marks
    --   'limit'   — annual revenue thresholds (УСН, НПД, АУСН)
    --   'rate'    — interest / penalty rates (ЗоЗПП пеня, ЦБ rate)
    --   'minimum' — fixed minimum amounts (тур.налог 100₽/сутки)
    --   'compliance' — regulatory deadlines, registry IDs
    category Utf8 NOT NULL,

    -- Stable identifier within category. Convention: snake_case, descriptive.
    --   'vat_accommodation_rate_bps'  — НДС-льгота на проживание (0% до 30.06.2027)
    --   'vat_general_rate_bps'        — общая ставка НДС (22% с 01.01.2026)
    --   'tourism_tax_sochi_rate_bps'  — туристический налог Сочи (2% 2026 ...)
    --   'tourism_tax_min_per_night_kop' — минимум 100₽/сутки за номер
    --   'npd_self_employed_annual_limit_kop' — годовой лимит самозанятых
    --   'usn_vat_threshold_kop'       — порог УСН для НДС-обязанности
    -- All numeric values stored as basis points (bps, 1/100 of a percent) or
    -- in копейках (kop, 1/100 of a ruble) — never floating-point.
    key Utf8 NOT NULL,

    -- Inclusive year range. yearTo=9999 = "indefinitely" (until law changes).
    -- Range queries: `WHERE yearFrom <= $year AND yearTo >= $year`.
    -- Non-overlapping ranges per (category, key) are an application-level
    -- invariant validated by the seed script — YDB doesn't have CHECK
    -- constraints to enforce this automatically.
    yearFrom Int32 NOT NULL,
    yearTo   Int32 NOT NULL,

    -- Canonical JSON payload. Schema is enforced at the application boundary
    -- via Zod (see `domains/systemConstant/repo.ts`). Storing structured
    -- data (instead of one column per type) keeps the table schema stable
    -- as new constants are added.
    data Utf8 NOT NULL,

    -- Citation pointing to the law/decree that establishes this value.
    -- Examples: '376-ФЗ', 'НК ст. 164 п.3', 'Постановление №1912',
    -- 'Решение ГорСобрания Сочи №100 от 31.10.2024'.
    -- Required field — undocumented constants are dangerous compliance risks.
    source Utf8 NOT NULL,

    -- Optional human notes (transitional rules, related decisions, planned
    -- amendments). NOT a substitute for the source field.
    notes Utf8,

    -- Optional fine-grained effective dates. yearFrom/yearTo cover the
    -- common case ("rate X applies during 2026"); these handle edge cases
    -- like "льгота до 30 ИЮНЯ 2027 года" where the year boundary is split.
    effectiveFromDate Date,
    effectiveToDate   Date,

    -- Audit
    createdAt Timestamp NOT NULL,
    createdBy Utf8 NOT NULL,
    updatedAt Timestamp NOT NULL,
    updatedBy Utf8 NOT NULL,

    PRIMARY KEY (category, key, yearFrom)
);

ALTER TABLE systemConstant SET (AUTO_PARTITIONING_BY_LOAD = ENABLED);
