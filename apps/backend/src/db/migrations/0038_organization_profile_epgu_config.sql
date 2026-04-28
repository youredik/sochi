-- 0038_organization_profile_epgu_config.sql — M8.A.5.cdc.A
-- per project_initial_framing.md (Боль 1.1 closure) + research/epgu-rkl.md §3.
--
-- Adds per-tenant ЕПГУ submission config. Required by the
-- `migration_registration_enqueuer` CDC handler — without these fields
-- the handler graceful-skips (logs warning, no row created) because
-- migrationRegistration.{epguChannel,supplierGid,regionCode} are NOT NULL.
--
-- Fields:
--
--   * `epguDefaultChannel` — gost-tls | svoks | proxy-via-partner. Per
--     research/epgu-rkl.md §1, three transport methods to ЕПГУ. Default
--     for new registrations; can be overridden per-call via UI submit
--     route. Most tenants pick one and stick (operator decision at
--     onboarding wizard).
--
--   * `epguSupplierGid` — UUID issued by МВД ОВМ during onboarding
--     (multi-week agreement window). Identifies the средство размещения
--     in ЕПГУ. Per-property in canonical multi-property tenants; for v1
--     stored at tenant-level (1 property = 1 tenant assumed); refactor
--     to property-level when multi-property tenant work lands.
--
--   * `epguRegionCodeFias` — ФИАС GUID of the property's region. For
--     Сочи / Сириус targets this is constant per municipality but the
--     value itself comes from МВД ОВМ during onboarding. Required by
--     ЕПГУ to route the notification to the correct МВД отдел.
--
-- Why nullable: tenants без МВД ОВМ onboarding ещё не могут submit
-- to ЕПГУ. Wizard step (lands в M8.A.6) populates the fields after
-- operator confirms ОВМ agreement. Until populated, the CDC handler
-- skips graceful — booking still completes check-in, миграционный учёт
-- registration row просто не создаётся (operator может создать manually
-- через POST /migration-registrations endpoint в M8.A.6 UI).
--
-- Forward-compat: when multi-property tenants land (M11+), these fields
-- migrate from organizationProfile to property table. The migration
-- script for that move is documented in project_custom_object_engine_future.md.

ALTER TABLE organizationProfile ADD COLUMN epguDefaultChannel Utf8;

ALTER TABLE organizationProfile ADD COLUMN epguSupplierGid Utf8;

ALTER TABLE organizationProfile ADD COLUMN epguRegionCodeFias Utf8;
