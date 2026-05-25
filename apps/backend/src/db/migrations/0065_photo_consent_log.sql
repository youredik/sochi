-- 0065_photo_consent_log.sql — 152-ФЗ ст.9 ч.4 separate-document consent audit
-- M8.A.6 Sprint B, 2026-05-22. FK target для guestDocument.photoConsentLogId
-- (migration 0034) и passportOcrAudit.photoConsentLogId (migration 0037).
--
-- WHY:
-- 152-ФЗ ст.9 ч.4 (2025-09-01 редакция) — каждое согласие = separate document,
-- version-pinned, revocable, with audit (timestamp + IP + UA). Roskomnadzor
-- inspections 2026 enforce 5-year retention from acceptedAt. Штраф до 700к ₽
-- за breach. До этой миграции photoConsentLogId FK в 0034/0037 ссылался на
-- НЕ СУЩЕСТВУЮЩУЮ таблицу — dangling FK + audit log нечем доказать.
--
-- SECURITY CANON:
-- `ipAddress` resolved backend via right-most-trusted-proxy XFF (canon
-- `lib/net/client-ip.ts`) — НЕ от frontend (forgeable). `acceptedAt`
-- = server clock (Date.now()) — НЕ от frontend (clock skew + adversarial).
-- Frontend value логируется но не персистится как truth.
--
-- SCHEMA:
-- Composite PK (tenantId, id) — tenant isolation canon.
-- `scope` field forward-compat (passport_ocr сейчас; будущие consent
-- categories — selfie_biometric, voice_recording — same table).
-- `revokedAt` NULL = active; non-null = right-to-be-forgotten executed.

CREATE TABLE IF NOT EXISTS photoConsentLog (
    tenantId        Utf8 NOT NULL,
    id              Utf8 NOT NULL,           -- newId('consent') → cns_<typeid>
    guestId         Utf8 NOT NULL,           -- soft FK guest.id (по tenantId)

    -- Consent contract
    version         Utf8 NOT NULL,           -- semver-style '2026-05-22' (matches frontend CONSENT_152FZ_VERSION)
    scope           Utf8 NOT NULL,           -- 'passport_ocr' для текущего use case

    -- Audit trail (152-ФЗ ст.9 ч.4 — proof of acceptance)
    acceptedAt      Timestamp NOT NULL,      -- server clock at INSERT (НЕ от frontend)
    ipAddress       Utf8 NOT NULL,           -- right-most-trusted-proxy resolved
    userAgent       Utf8 NOT NULL,           -- request UA header

    -- Right to be forgotten: 152-ФЗ ст.20 (revocation right) + ст.21 ч.5
    -- (30 days destruction SLA after revocation request). Round 8 P2-G fix
    -- (canon `feedback_legal_round_5_corrections_canon_2026_05_23.md`): comment
    -- previously incorrectly cited «10 рабочих дней» — that's ст.20 ответ срок,
    -- not destruction срок. Schema unchanged.
    revokedAt       Timestamp,               -- NULL = active
    revokedReason   Utf8,                    -- 'user_request' | 'gdpr_export' | etc.

    createdAt       Timestamp NOT NULL,

    PRIMARY KEY (tenantId, id),

    -- Index: lookup всех consents гостя (revocation flow, audit dashboard)
    INDEX idxConsentTenantGuest GLOBAL SYNC ON (tenantId, guestId),
    -- Index: queries по scope+version (version bump migration analytics)
    INDEX idxConsentTenantScopeVersion GLOBAL SYNC ON (tenantId, scope, version)
);
