-- 0037_passport_ocr_audit.sql — M8.A.1 — Yandex Vision OCR call audit
-- per plan v2 §8.2 + research/yandex-vision-passport.md §8.
--
-- Closes (from 7×3 mandate):
--   * Function 1.2 (AI passport scan) — без OCR-аудита нельзя
--     дебажить false-positives, retraining feedback не возможен,
--     152-ФЗ ст.21 ч.4 не выполняется (lack of accountability).
--
-- Why audit table (research/yandex-vision-passport.md §8):
--   1. **Debugging false-positives**: OCR ошибается на handwritten
--      paragraphs, поврежденных документах, плохом освещении. Без
--      audit log нельзя retrain heuristic confidence.
--   2. **152-ФЗ ст.21 ч.4 — accountability**: «оператор обязан вести
--      учёт обработки персональных данных». Audit table = такой учёт.
--   3. **Heuristic confidence calibration** (research §3): API
--      возвращает 0.0 confidence как known issue → наш heuristic
--      (regex + sanity check + age check). Audit log накапливает
--      «good cases» для improvement heuristic.
--   4. **Retention**: 90 дней (ст.21 ч.7 — «не дольше необходимого
--      для целей»). Cleanup cron deletes rows старше 90 дней.
--
-- Yandex Vision API (research/yandex-vision-passport.md §1.2):
--   POST https://ocr.api.cloud.yandex.net/ocr/v1/recognizeText
--   Body: { mimeType: 'JPEG'|'PNG'|'PDF', languageCodes: ['ru','en'],
--           model: 'passport', content: '<base64-encoded image>' }
--
-- 9 entities returned (research §3.1, all blocks always present):
--   surname | name | middle_name | gender (male|female)
--   citizenship (ISO-3) | birth_date (DD.MM.YYYY) | birth_place
--   number (series+number) | issue_date
--
-- Confidence quirk (research §3.2):
--   API returns 0.0 confidence. We compute heuristic locally:
--     - regex passport_ru series/number: /^\d{4}\s?\d{6}$/
--     - date sanity: year ≤ today AND > 1900
--     - age check: ≥ 14 (РФ паспорт от 14 лет)
--     - name length sanity (1-50 chars, кириллица/латиница)
--   Heuristic ∈ [0, 1] stored как `confidenceHeuristic`.
--
-- 20 countries passport model (research §2.1): RU + СНГ + Europe +
-- Турция + Израиль + США + UK. Если detected_country НЕ в whitelist
-- → flag для manual review (но row сохраняется).

CREATE TABLE IF NOT EXISTS passportOcrAudit (
    tenantId             Utf8 NOT NULL,
    id                   Utf8 NOT NULL,             -- newId('ocra')

    -- Optional links (NULL до создания guest/document — staging-only)
    guestId              Utf8,
    documentId           Utf8,                      -- FK guestDocument.id когда сохранено
    bookingId            Utf8,                      -- если scan был для конкретной brони

    -- Operator who initiated scan
    operatorUserId       Utf8 NOT NULL,

    -- Scan input metadata
    inputMimeType        Utf8 NOT NULL,             -- 'image/jpeg' | 'image/png' | 'image/heic' | 'application/pdf'
    inputSizeBytes       Int64 NOT NULL,
    -- Object Storage путь к raw photo (TTL = 90 дней + auto-delete после ЕПГУ confirmed)
    -- NULL если scan failed before upload.
    inputObjectKey       Utf8,

    -- Yandex Vision request/response
    -- API endpoint URL (для debug — может меняться в AI Studio rollout)
    apiEndpoint          Utf8 NOT NULL,             -- 'https://ocr.api.cloud.yandex.net/ocr/v1/recognizeText'
    -- Какая модель использована (для версионирования: passport, passport_v2, ...)
    apiModel             Utf8 NOT NULL,             -- 'passport'
    -- HTTP status: 200 | 400 | 401 | 403 | 429 | 503
    httpStatus           Int32 NOT NULL,
    -- Latency для cost monitoring
    latencyMs            Int32 NOT NULL,

    -- Extracted entities (9 fields per research §3.1).
    -- NULL когда API не вернул entity (low quality / partial extract).
    surname              Utf8,
    name                 Utf8,
    middleName           Utf8,
    gender               Utf8,                      -- 'male' | 'female'
    citizenshipIso3      Utf8,                      -- 'rus', 'blr', 'kaz', ...
    birthDate            Date,
    birthPlace           Utf8,
    documentNumber       Utf8,                      -- series+number combined
    issueDate            Date,

    -- Country detected (для multi-country model). NULL если не однозначно.
    detectedCountryIso3  Utf8,
    -- Whitelist 20 countries — if detected outside, flag для manual review
    isCountryWhitelisted Bool NOT NULL,

    -- Our heuristic confidence (research §3.2 — API returns 0.0 broken).
    -- Real Yandex confidence (для historical compare когда API исправит).
    apiConfidenceRaw     Double,                    -- usually 0.0
    confidenceHeuristic  Double,                    -- 0..1, computed locally

    -- Outcome (для downstream pipeline)
    outcome              Utf8 NOT NULL,             -- 'success' | 'low_confidence' | 'api_error' | 'invalid_document'

    -- Полный raw response for replay/debug
    rawResponseJson      Json,

    -- 152-ФЗ link (consent для photo storage)
    photoConsentLogId    Utf8,                      -- NULL если scan failed before upload

    -- Audit
    createdAt            Timestamp NOT NULL,

    PRIMARY KEY (tenantId, id),

    -- Index for cleanup cron (90-day retention).
    INDEX idxOcrAuditCreatedAt GLOBAL SYNC ON (createdAt),
    -- Index by guest для history view + retraining feedback.
    INDEX idxOcrAuditTenantGuest GLOBAL SYNC ON (tenantId, guestId),
    -- Index by operator для usage tracking.
    INDEX idxOcrAuditTenantOperator GLOBAL SYNC ON (tenantId, operatorUserId),
    -- Index by outcome для analytics («сколько scans низкой confidence»).
    INDEX idxOcrAuditTenantOutcome GLOBAL SYNC ON (tenantId, outcome)
);
