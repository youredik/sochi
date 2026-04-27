-- 0031_property_addons.sql — M8.A.0.5 — bookable addons (Apaleo Services
-- pattern). Per plan v2 §7.1 #4 + research/hotel-addons-extras.md §§1-6.
--
-- Schema:
--   - PK (tenantId, propertyId, addonId).
--   - `code` is operator-supplied unique-per-property string (e.g. "BREAKFAST")
--     used in folio lines + OTA mapping. Service layer enforces uniqueness
--     within a property at create time (no DB index — YDB unique-secondary
--     not used; SELECT-then-UPSERT pattern).
--   - `seasonalTagsJson` Utf8 holds JSON-stringified tag array, validated on
--     read against `addonSeasonalTagSchema` (.strict).
--   - `vatBps` snapshot — 376-ФЗ 2026 raised RU base rate to 22%; folio
--     lines snapshot rate at service-date so a mid-year change doesn't
--     re-tax existing posts.
--   - `inventoryMode` { NONE | DAILY_COUNTER | TIME_SLOT } — TIME_SLOT
--     reserved (rejected at app boundary until M9+).

CREATE TABLE propertyAddon (
    tenantId            Utf8 NOT NULL,
    propertyId          Utf8 NOT NULL,
    addonId             Utf8 NOT NULL,
    code                Utf8 NOT NULL,
    category            Utf8 NOT NULL,
    nameRu              Utf8 NOT NULL,
    nameEn              Utf8,
    descriptionRu       Utf8,
    descriptionEn       Utf8,
    pricingUnit         Utf8 NOT NULL,
    priceMicros         Int64 NOT NULL,
    currency            Utf8 NOT NULL,
    vatBps              Int32 NOT NULL,
    isActive            Bool NOT NULL,
    isMandatory         Bool NOT NULL,
    inventoryMode       Utf8 NOT NULL,
    dailyCapacity       Int32,
    seasonalTagsJson    Utf8 NOT NULL, -- always populated; '[]' if none
    sortOrder           Int32 NOT NULL,
    createdAt           Timestamp NOT NULL,
    createdBy           Utf8 NOT NULL,
    updatedAt           Timestamp NOT NULL,
    updatedBy           Utf8 NOT NULL,
    PRIMARY KEY (tenantId, propertyId, addonId)
);
