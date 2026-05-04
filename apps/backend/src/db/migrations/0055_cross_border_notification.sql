-- M10 / A7.1 — RKN cross-border-transfer notification ledger (D19).
--
-- Per `plans/m10_canonical.md` §2 D19 + project_ru_legal_canonical_corrections_2026.md
-- + 152-ФЗ ст. 12.1 (since 1 Mar 2023): cross-border PII transfer requires
-- notification к Roskomnadzor с named recipient country, legal basis, protective
-- measures.
--
-- Adapter MUST check `status='filed'` before any outbound PII send to non-RU
-- recipient. NULL row OR status != 'filed' → adapter denies send.
--
-- For RU-resident channels (TL/YT/Ostrovok ETG) this is N/A — table empty for
-- those tenant-channel combos. Ready для phase 2/3 when Booking.com / Expedia
-- sanctions lift.

CREATE TABLE crossBorderNotification (
    tenantId             Utf8 NOT NULL,
    notificationId       Utf8 NOT NULL,
    recipientCountry     Utf8 NOT NULL, -- ISO-2 code; 'NL' for Booking.com (when re-enabled), 'US' for Expedia
    recipientChannelId   Utf8 NOT NULL,
    legalBasis           Utf8 NOT NULL, -- 'execution_of_contract' | 'consent' | 'legal_obligation'
    protectiveMeasures   Json NOT NULL,
    -- 'pending' (preparing) | 'filed' (RKN confirmation received) | 'denied' (RKN refused)
    -- adapter only sends когда status='filed'.
    status               Utf8 NOT NULL,
    rknSubmittedAt       Timestamp,
    rknConfirmedAt       Timestamp,
    rknDeniedAt          Timestamp,
    rknDenialReason      Utf8,
    createdAt            Timestamp NOT NULL,
    updatedAt            Timestamp NOT NULL,
    PRIMARY KEY (tenantId, notificationId),
    INDEX idxCbnByChannel GLOBAL SYNC ON (tenantId, recipientChannelId, status)
);

ALTER TABLE crossBorderNotification SET (AUTO_PARTITIONING_BY_LOAD = ENABLED);
