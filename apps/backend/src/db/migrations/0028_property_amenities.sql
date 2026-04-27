-- 0028_property_amenities.sql — M8.A.0.2 — property amenities (M:N).
-- Per plan v2 §7.1 #2 + research/hotel-content-amenities-media.md §1.5.
--
-- Schema rationale:
--   - Amenity *codes* are NOT in the DB — they live in
--     `packages/shared/src/amenities.ts` (git-versioned). The DB only stores
--     which amenities a property has + per-property pricing/value override.
--     OTA mappings (Booking HAC/RMA, Expedia EQC) are also in code so channel
--     adapters read one source of truth (research §1.5).
--   - PRIMARY KEY (tenantId, propertyId, amenityCode) — 1 row per
--     (property, amenity). Re-assigning an amenity is an UPSERT.
--   - `scope` is denormalized from the catalog so we can index/query
--     room-scope vs property-scope without joining the in-memory catalog.
--   - `value` is bound by the canonical catalog's `supportsValue` flag,
--     enforced at the SERVICE boundary via `checkAmenityValueInvariant`.
--     The DB allows any string ≤ 200 chars; service-level validation is
--     the contract.

CREATE TABLE propertyAmenity (
    tenantId        Utf8 NOT NULL,
    propertyId      Utf8 NOT NULL,
    amenityCode     Utf8 NOT NULL,
    scope           Utf8 NOT NULL,
    freePaid        Utf8 NOT NULL,
    value           Utf8,
    createdAt       Timestamp NOT NULL,
    createdBy       Utf8 NOT NULL,
    updatedAt       Timestamp NOT NULL,
    updatedBy       Utf8 NOT NULL,
    PRIMARY KEY (tenantId, propertyId, amenityCode)
);
