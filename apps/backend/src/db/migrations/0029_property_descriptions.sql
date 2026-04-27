-- 0029_property_descriptions.sql — M8.A.0.3 — i18n property descriptions
-- per plan v2 §7.1 #3 + research/hotel-content-amenities-media.md §6.
--
-- One row per (tenantId, propertyId, locale).  Locale enum {ru, en} for
-- now; extending requires adding a value to
-- `propertyDescriptionLocaleValues` in shared + a service-boundary check.
--
-- Sections live in a single Json column (8 canonical keys, all optional).
-- Validated at app boundary via `propertyDescriptionSectionsSchema`
-- (.strict — rejects unknown keys).

CREATE TABLE propertyDescription (
    tenantId            Utf8 NOT NULL,
    propertyId          Utf8 NOT NULL,
    locale              Utf8 NOT NULL,
    title               Utf8 NOT NULL,
    tagline             Utf8,
    summaryMd           Utf8 NOT NULL,
    longDescriptionMd   Utf8,
    sectionsJson        Utf8 NOT NULL, -- always populated; '{}' if no sections
    seoMetaTitle        Utf8,
    seoMetaDescription  Utf8,
    seoH1               Utf8,
    createdAt           Timestamp NOT NULL,
    createdBy           Utf8 NOT NULL,
    updatedAt           Timestamp NOT NULL,
    updatedBy           Utf8 NOT NULL,
    PRIMARY KEY (tenantId, propertyId, locale)
);
