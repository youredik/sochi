-- 0071_passport_scan_scrub_log.sql — append-only RTBF scrub event journal 2026-05-23d.
--
-- Sprint C+ Legal P1 + Senior P1 (5-expert audit 2026-05-23):
--   Round 4 RTBF cascade uses UPDATE-in-place semantics on passportOcrAudit +
--   guestDocument (setting entitiesAnonymizedAt timestamp). This is defensible
--   under 152-ФЗ ст.21 ч.4 + РКН Приказ 178/2022, но best-practice canon
--   prefers a SEPARATE append-only event journal для «уничтожение ПДн» events:
--
--     - Mutable consent/audit/document tables — current value (UPDATE OK)
--     - Append-only scrub log — immutable forensic record что каждый scrub
--       событие происходило (when, who, what counts) — Roskomnadzor inspection
--       canonical form. No row mutation = guaranteed integrity (FSTEK Приказ
--       21, «защита от несанкционированных изменений»).
--
-- Each row = ONE scrub event (one RTBF revoke = one passportOcrAuditScrubLog
-- row, even if cascade affects N audit + M document rows). Counts captured
-- inline для quick «сколько ПДн уничтожено для гостя X».
--
-- TTL 5 years — same as consent log (proof что мы исполнили право отзыва per
-- 152-ФЗ ст.21 ч.5 в течение 30 дней).

CREATE TABLE IF NOT EXISTS passportOcrAuditScrubLog (
    tenantId             Utf8 NOT NULL,
    id                   Utf8 NOT NULL,           -- newId('passportOcrScrubLog')

    -- Soft FK photoConsentLog.id — какое согласие отозвано.
    photoConsentLogId    Utf8 NOT NULL,

    -- guestId — для DSAR queries «история уничтожений ПДн моих данных».
    guestId              Utf8 NOT NULL,

    -- Reason verbatim, как операторе вводил в revoke route body
    -- (user_request | dsar_152fz | mistake | other + reasonText).
    scrubReason          Utf8 NOT NULL,

    -- Кто инициировал scrub. 'unknown' fallback допустим, но WARN-логируется.
    operatorUserId       Utf8 NOT NULL,

    -- Counters — сколько rows scrub'ились во время cascade.
    auditRowsScrubbed         Int64 NOT NULL,
    guestDocumentRowsScrubbed Int64 NOT NULL,
    objectKeysDeleted         Int64 NOT NULL,
    objectKeysFailed          Int64 NOT NULL,   -- S3 delete fails (lifecycle backstop)

    -- Server clock when cascade completed.
    scrubbedAt           Timestamp NOT NULL,

    -- Standard audit columns.
    createdAt            Timestamp NOT NULL,

    PRIMARY KEY (tenantId, id),

    -- Index by guest для DSAR query «история scrub'ов».
    INDEX idxScrubLogTenantGuest GLOBAL SYNC ON (tenantId, guestId),
    -- Index by consent для cascade idempotency check (rare but defensive).
    INDEX idxScrubLogTenantConsent GLOBAL SYNC ON (tenantId, photoConsentLogId)
)
WITH (
    -- 5-year retention canon — same as photoConsentLog. Append-only event = forensic
    -- proof что оператор исполнил ст.21 ч.5 destruction в течение 30 дней.
    TTL = Interval("P1825D") ON createdAt,
    AUTO_PARTITIONING_BY_LOAD = ENABLED,
    -- Stankoff canon (016-channels.sql + 017-reconciliation.sql) — MIN=2 split
    -- up-front, MAX=16 ceiling для Сочи peak бурстов.
    AUTO_PARTITIONING_MIN_PARTITIONS_COUNT = 2,
    AUTO_PARTITIONING_MAX_PARTITIONS_COUNT = 16
);

-- **NOTE on FAMILY clause omission**: Production YDB clusters have named
-- storage pools (`ssd`, `hdd`, etc.) и FAMILY clauses route data к specific
-- pools. Local YDB (in-memory PDisks per [[feedback_ydb_inmem_no_restart]])
-- doesn't have these pools и REJECTS migrations с explicit FAMILY references
-- («database doesn't have required storage pools»). Other tables в этом repo
-- omit FAMILY entirely (rely on YDB default), so we do same here для local-dev
-- parity. Production deploy uses YC Serverless single-tier storage — no
-- separate pool routing needed.
