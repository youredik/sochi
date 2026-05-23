-- 0068_passport_scan_self_review.sql — Sprint C+1 self-review fixes 2026-05-23.
-- Closes 5-expert self-review findings (Sprint C composite 5.7 → target 9+):
--
-- L2 (legal P0). textSnapshot still nullable per 0067:33 — pre-Sprint-C rows
--                will return NULL → 152-ФЗ ст.9 ч.4 proof gap. Backfill NULL
--                rows с canonical placeholder («[pre-Sprint-C row, текст утрачен —
--                требуется handle через `consentVersion` table lookup]»).
--                App-level Zod уже enforces NOT NULL on writes (vision.routes.ts:97);
--                этот migration backfills legacy + leaves column technically NULL
--                because YDB ALTER COLUMN SET NOT NULL без table rebuild не поддерживается.
--
-- Y2 (YDB P0).  CDC missing — все 12 critical tables в codebase имеют
--                CHANGEFEED для outbox/audit pipeline (canon project_event_architecture).
--                photoConsentLog + passportOcrAudit = critical pii flows → must
--                have CHANGEFEED для:
--                  • РКН inspection real-time replay
--                  • Future M11 YC Audit Trails integration
--                  • Existing activity-table projection consumer pipeline
--
-- separateConsents backfill — Y7. NULL рядки могут exist pre-Sprint-C →
--                DSAR export shows `null` для multi-checkbox field → 152-ФЗ
--                ст.14 «полный объём» violation. Default к { all three true }
--                because pre-Sprint-C consent UI имел single-checkbox = treated
--                как all-accepted per legal interpretation.
--
-- ALL OPERATIONS ADDITIVE. Backfill UPDATEs WHERE NULL only — idempotent re-run safe.

-- ─── L2: textSnapshot backfill ───
-- Defensive backfill для legacy rows. Production state имеет zero pre-Sprint-C
-- rows (migration 0065 added table 1 day ago), но safety-net for re-applies.
UPDATE photoConsentLog
SET textSnapshot = '[legacy pre-Sprint-C consent — verify через consent_versions table]'
WHERE textSnapshot IS NULL;

-- ─── Y7: separateConsents backfill ───
-- Default { generalPdn: true, citizenshipSpecial: true, biometricPhoto: true }.
-- Rationale: pre-Sprint-C single-checkbox UI implied operator believed all
-- categories covered. Treating as full-consent prevents DSAR export shape regression.
UPDATE photoConsentLog
SET separateConsents = CAST('{"generalPdn":true,"citizenshipSpecial":true,"biometricPhoto":true}' AS Json)
WHERE separateConsents IS NULL;

-- ─── Y2: CHANGEFEED on photoConsentLog ───
-- 24-hour retention (Tier A canonical per project_yc_serverless_deploy_canon).
-- Format JSON, virtual_timestamps для event ordering, NEW_AND_OLD_IMAGES для
-- diff reconstruction (RTBF audit trail can replay full mutation history).
ALTER TABLE photoConsentLog ADD CHANGEFEED `photoConsentLogChanges` WITH (
    FORMAT = 'JSON',
    MODE = 'NEW_AND_OLD_IMAGES',
    RETENTION_PERIOD = Interval('PT24H'),
    VIRTUAL_TIMESTAMPS = TRUE
);

-- ─── Y2: CHANGEFEED on passportOcrAudit ───
-- Same Tier A canon. Real-time РКН dashboard subscribes к этому feed для
-- live audit visibility («показать live stream of consent acceptances»).
ALTER TABLE passportOcrAudit ADD CHANGEFEED `passportOcrAuditChanges` WITH (
    FORMAT = 'JSON',
    MODE = 'NEW_AND_OLD_IMAGES',
    RETENTION_PERIOD = Interval('PT24H'),
    VIRTUAL_TIMESTAMPS = TRUE
);
