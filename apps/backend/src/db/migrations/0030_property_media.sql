-- 0030_property_media.sql — M8.A.0.4 — property/room media metadata.
-- Per plan v2 §7.1 #1 + research/hotel-content-amenities-media.md §§5.1-5.5.
--
-- Schema rationale:
--   - Originals + derived files live in Object Storage; this table holds
--     METADATA only (operator alt text, dimensions, processing flags).
--   - `derivedReady=true` is set by Cloud Function callback after writing
--     12 derived files (6 variants × 2 formats). UI hides photos with
--     derivedReady=false from public widget (still visible to operator).
--   - `exifStripped=true` set by same Cloud Function — privacy invariant
--     (research §5.3: GPS / device metadata strip mandatory).
--   - `isHero=true` should be exactly ONE per (tenantId, propertyId,
--     roomTypeId-or-NULL). Service layer enforces by unsetting other
--     heroes when one is promoted. We do NOT add a UNIQUE index because
--     YDB doesn't support partial uniqueness AND the service-side guard
--     is sufficient for the wizard flow.
--   - `roomTypeId` nullable: NULL = property-scope (lobby/exterior),
--     non-NULL = room-scope (specific UnitGroup gallery).
--
-- altRu required (a11y); altEn optional. Captions separate from alt
-- per WCAG (research §5.4).

CREATE TABLE propertyMedia (
    tenantId        Utf8 NOT NULL,
    propertyId      Utf8 NOT NULL,
    mediaId         Utf8 NOT NULL,
    roomTypeId      Utf8,
    kind            Utf8 NOT NULL,
    originalKey     Utf8 NOT NULL,
    mimeType        Utf8 NOT NULL,
    widthPx         Int32 NOT NULL,
    heightPx        Int32 NOT NULL,
    fileSizeBytes   Int64 NOT NULL,
    exifStripped    Bool NOT NULL,
    derivedReady    Bool NOT NULL,
    sortOrder       Int32 NOT NULL,
    isHero          Bool NOT NULL,
    altRu           Utf8 NOT NULL,
    altEn           Utf8,
    captionRu       Utf8,
    captionEn       Utf8,
    createdAt       Timestamp NOT NULL,
    createdBy       Utf8 NOT NULL,
    updatedAt       Timestamp NOT NULL,
    updatedBy       Utf8 NOT NULL,
    PRIMARY KEY (tenantId, propertyId, mediaId)
);
