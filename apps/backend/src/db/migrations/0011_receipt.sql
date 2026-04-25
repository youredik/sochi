-- =============================================================================
-- Migration 0011 — M6 Payment domain pt.5: Receipt (54-ФЗ ФФД 1.2)
-- =============================================================================
--
-- Fiscal receipt row — 54-ФЗ-compliant cash-register record sent to the OFD
-- (operator of fiscal data) which forwards to ФНС. Required by Russian
-- federal law for every payment from a guest, plus every refund.
--
-- Canon (memory `project_payment_domain_canonical.md` "Fiscalization decision"):
--   - V1 primary provider: ЮKassa "Чеки от ЮKassa" (0₽ abonment, 0.8-1.2%
--     surcharge on top of payment provider fee, 152-ФЗ-fit).
--   - V1 escape-hatch (interface seam, не impl): ATOL Online (1733₽/mo,
--     supports correction чек). Activates when monthly volume justifies.
--   - V1 stub provider: emits stub receipts in dev / demo mode (no real
--     ОФД call).
--
-- ## State machine (5 states)
--
--   pending → sent → confirmed (terminal)
--                  ↘ failed    (terminal — retryable via new attempt)
--                  ↘ corrected (terminal — superseded by chain successor)
--
-- 54-ФЗ does NOT allow void / edit. Mistakes are corrected via a NEW
-- receipt with `correctsReceiptId` referencing the original. Domain layer
-- enforces correction chain depth ≤ 3 (ФНС regulatory limit).
--
-- ## FFD 1.2 fiscal tags (canon — Сочи hospitality 2026)
--
--   - tag1054 — приход (1) | возврат (2) | коррекция_приход (3) | коррекция_возврат (4)
--   - tag1212 — предмет расчёта = 4 ('услуга' — для гостиницы)
--   - tag1214 — способ расчёта 1..4 per scenario:
--       * prepayment_full → 1 (полная предоплата)
--       * advance with room known → 2 (частичная предоплата)
--       * advance TBD → 3 (аванс)
--       * final settlement + offset → 4 (полный расчёт) + tag1215 зачёт аванса
--       * refund → mirror original
--   - tag1199 — НДС = 5 (0%, accommodation продлено до 31.12.2030 ФНС)
--   - tag1008 — email|phone клиента (mandatory online sale с 2025-09-01)
--   - linesJson — массив с tag1059 (предметы расчёта)
--
-- Tourism tax 2% Сочи 2026 НЕ попадает в чек (Минфин 04.10.2024
-- № 03-05-08/96119) — отображается только в счёте/инвойсе.
--
-- ## Money model
--
-- `totalMinor Int64` копейки — same convention as payment / refund / folio.
-- Conversion at the SDK boundary (ЮKassa Чеки API expects RUB minor as Int).
--
-- ## Indexes
--
-- - PK `(tenantId, paymentId, id)` — single-shard "all receipts for payment X"
--   query (correction chain traversal).
-- - `ixReceiptIdempotency GLOBAL UNIQUE SYNC ON (tenantId, provider, idempotencyKey)`
--   — fiscal API idempotency dedup (canon: provider Idempotence-Key UUIDv4
--   with exponential backoff 2-4-8-16-32-64s; same key replays return same
--   receipt without double-fiscalization).
-- - `ixReceiptStatus GLOBAL SYNC ON (tenantId, status)` — retry job for
--   pending / failed receipts (SLO: 99.5% confirmed within 60s).
-- - `ixReceiptCorrects GLOBAL SYNC ON (tenantId, correctsReceiptId)` —
--   chain successor lookup (depth check + correction discovery).
--
-- ## CHANGEFEED
--
-- `receipt_events` for downstream consumers:
--   - activity_writer — every state transition → `activity` row.
--   - notification_writer — `confirmed` → email guest with QR код /
--     `failed` → ops alert.
--
-- =============================================================================

CREATE TABLE receipt (
    tenantId          Utf8 NOT NULL,
    paymentId         Utf8 NOT NULL,
    id                Utf8 NOT NULL,
    -- Optional link to the refund this receipt fiscalizes (NULL for
    -- non-refund receipts). FK-by-convention.
    refundId          Utf8,
    -- Receipt kind:
    --   advance | prepayment_full | final | refund | correction
    kind              Utf8 NOT NULL,
    -- Correction chain backlink. NULL for original receipts; set on the
    -- corrector when superseding a prior receipt. Domain enforces depth ≤ 3.
    correctsReceiptId Utf8,
    -- 5-state SM (see header). Terminal: confirmed | failed | corrected.
    status            Utf8 NOT NULL,
    -- Provider taxonomy: yookassa_cheki | atol_online | stub
    provider          Utf8 NOT NULL,
    -- ===== 54-ФЗ FFD 1.2 fiscal tags =====
    -- tag1054 — operation type (1=приход, 2=возврат, 3=корр.приход, 4=корр.возврат)
    tag1054           Int32 NOT NULL,
    -- tag1212 — предмет расчёта (=4 for hotel 'услуга')
    tag1212           Int32 NOT NULL,
    -- tag1214 — способ расчёта (1..4 per FFD 1.2 scenario)
    tag1214           Int32 NOT NULL,
    -- tag1199 — НДС (=5 for 0%, accommodation продлено до 31.12.2030)
    tag1199           Int32 NOT NULL,
    -- tag1008 — email|phone клиента (mandatory с 2025-09-01)
    tag1008           Utf8 NOT NULL,
    -- Line items: JSON array per FFD 1.2 (tag 1059 + sub-tags name/qty/price/sum)
    linesJson         Json NOT NULL,
    -- Total in копейки. Equals SUM(linesJson[].amountMinor).
    totalMinor        Int64 NOT NULL,
    -- ISO 4217 — V1 RUB only. Reserved for V2.
    currency          Utf8 NOT NULL,
    -- ===== ОФД/ФНС confirmation (NULL until confirmed) =====
    -- Регистрационный номер ККТ (16 chars per ФЗ)
    fnsRegId          Utf8,
    -- ФД номер (sequential within ККТ, monotonic per fiscal session)
    fdNumber          Int64,
    -- Fiscal sign / fiscal protective data — 10 digit hash from ФН
    fp                Utf8,
    -- QR payload string for client-side ФНС verification (per ФЗ)
    -- format: t=YYYYMMDDTHHMM&s=AMOUNT&fn=FN&i=FD&fp=FP&n=TYPE
    qrPayload         Utf8,
    -- ===== Idempotency / OCC =====
    -- IETF Idempotency-Key for retry-safe POST к provider (canon: UUIDv4
    -- with exponential backoff 2-4-8-16-32-64s, 6 attempts).
    idempotencyKey    Utf8 NOT NULL,
    -- OCC version. Int32 per gotcha #9 (JS number → Int32 inference).
    version           Int32 NOT NULL,
    -- ===== State-transition timestamps =====
    createdAt         Timestamp NOT NULL,
    updatedAt         Timestamp NOT NULL,
    sentAt            Timestamp,
    confirmedAt       Timestamp,
    failedAt          Timestamp,
    correctedAt       Timestamp,
    -- Free-form failure reason from ОФД / ФНС (e.g. "ФН-память переполнена").
    -- PAN never included — middleware redacts upstream.
    failureReason     Utf8,
    -- ===== Audit =====
    createdBy         Utf8 NOT NULL,
    updatedBy         Utf8 NOT NULL,
    PRIMARY KEY (tenantId, paymentId, id),
    -- Provider Idempotence-Key dedup
    INDEX ixReceiptIdempotency GLOBAL UNIQUE SYNC ON (tenantId, provider, idempotencyKey),
    -- Retry job: WHERE status IN ('pending','failed')
    INDEX ixReceiptStatus GLOBAL SYNC ON (tenantId, status),
    -- Correction chain successor lookup
    INDEX ixReceiptCorrects GLOBAL SYNC ON (tenantId, correctsReceiptId)
);

ALTER TABLE receipt SET (AUTO_PARTITIONING_BY_LOAD = ENABLED);

ALTER TABLE receipt ADD CHANGEFEED receipt_events WITH (
    MODE = 'NEW_AND_OLD_IMAGES',
    FORMAT = 'JSON',
    VIRTUAL_TIMESTAMPS = TRUE,
    RETENTION_PERIOD = Interval("PT72H"),
    TOPIC_AUTO_PARTITIONING = 'ENABLED'
);
