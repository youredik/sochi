-- 0034_guest_documents.sql — M8.A.1 — Guest identity documents (passport scans + structured fields)
-- per plan v2 §8.2 + research/epgu-rkl.md + research/yandex-vision-passport.md.
--
-- Closes (from 7×3 mandate):
--   * Function 1.1 (ЕПГУ Скала) — нужны точные паспортные данные для
--     `req.xml` многократно (один гость = много бронирований одинаковыми
--     данными). Отдельная таблица documents избегает дублирования полей
--     и привязки документа к одной brони.
--   * Function 1.2 (AI passport) — endpoint Yandex Vision OCR заполняет
--     эту таблицу через `POST /api/v1/guests/scan-document` (M8.A.3).
--
-- ПП-174 (с 01.03.2026) — `identity_method` enum 5 values per новой
-- редакции Постановления Правительства о порядке миграционного учёта:
--   * `passport_paper`    — паспорт РФ бумажный (внутренний)
--   * `passport_zagran`   — заграничный паспорт РФ
--   * `driver_license`    — водительское удостоверение (для граждан РФ)
--   * `ebs`               — ЕБС (Единая Биометрическая Система)
--   * `digital_id_max`    — Цифровой ID через приложение «МАX»
-- Validated at Zod service boundary; SQL keeps Utf8 for forward-compat
-- (новые методы могут добавиться без миграции).
--
-- Hierarchy (1:N): один guest → много documents (например, изначально
-- сканировали внутренний паспорт, потом загран для visa-flow). Каждый
-- document может быть привязан к bookingId на момент scan-операции.
--
-- Storage: `objectStoragePath` ссылается на Yandex Object Storage key
-- (формат `passport-scans/<tenantId>/<guestId>/<documentId>.<ext>`).
-- TTL: lifecycle-rule auto-delete через 90 дней после ЕПГУ confirmed
-- (research/yandex-vision-passport.md §6: «Лучшая практика — удалить
-- фото через 90 дней после ЕПГУ confirmed, оставить только структу-
-- рированные поля»). 152-ФЗ ст.21 ч.7 — retention bounded to purpose.
--
-- 152-ФЗ ст.9 (ред. 30.08.2025): отдельный документ согласия на
-- обработку passport-photo требуется. В этой таблице храним только
-- ссылку на consentLog row, не сам текст. Штраф за нарушение — 700k₽
-- (research/yandex-vision-passport.md §6).

CREATE TABLE IF NOT EXISTS guestDocument (
    -- Composite PK тенант+id для cross-tenant isolation (canonical).
    tenantId             Utf8 NOT NULL,
    id                   Utf8 NOT NULL,           -- newId('gdoc')

    -- FK to guest. Не constraint в YDB, валидация в repo.
    guestId              Utf8 NOT NULL,

    -- ПП-174 enum (string for forward-compat, see header).
    identityMethod       Utf8 NOT NULL,           -- passport_paper | passport_zagran | driver_license | ebs | digital_id_max

    -- Структурированные поля (extracted via OCR or manual entry).
    -- Null если identityMethod не требует поля (например ebs не имеет
    -- documentSeries — биометрический slug в documentNumber).
    documentSeries       Utf8,                    -- e.g. '4608' (RU паспорт)
    documentNumber       Utf8 NOT NULL,           -- e.g. '123456'
    documentIssuedBy     Utf8,
    documentIssuedDate   Date,
    documentExpiryDate   Date,                    -- для загранки/виз
    citizenshipIso3      Utf8 NOT NULL,           -- 'rus', 'blr', 'kaz' (ISO 3166-1 alpha-3)

    -- Object Storage key для скан-фото. Null если ввели вручную.
    objectStoragePath    Utf8,
    -- MIME type оригинального файла (image/jpeg | image/png | image/heic | application/pdf)
    objectMimeType       Utf8,
    -- Размер в байтах (Int64 совместимо с canonical fileSizeBytes
    -- в propertyMedia).
    objectSizeBytes      Int64,

    -- Yandex Vision OCR confidence (наша heuristic, NOT API value).
    -- 0..1, NULL для manual entry. Используется для UI «низкая
    -- уверенность OCR — проверьте» badge.
    ocrConfidenceHeuristic Double,
    -- 'yandex_vision' | 'manual' | 'sora_ocr_2027' (forward-compat для
    -- альтернативных провайдеров)
    ocrSource              Utf8,

    -- 152-ФЗ ст.9 — link to consent для photo storage.
    -- Если null И objectStoragePath не null → invariant violation
    -- (валидируется в repo create/patch).
    photoConsentLogId      Utf8,

    -- Audit / FSM fields
    createdAt              Timestamp NOT NULL,
    updatedAt              Timestamp NOT NULL,
    createdBy              Utf8 NOT NULL,
    updatedBy              Utf8 NOT NULL,

    PRIMARY KEY (tenantId, id),

    -- Index by guestId — most common lookup: «все документы гостя».
    INDEX idxGuestDocumentTenantGuest GLOBAL SYNC ON (tenantId, guestId),
    -- Index by document number — для дубль-детекции при scan
    -- (canonical case: гость уже зарегистрирован под этим документом).
    INDEX idxGuestDocumentTenantNumber GLOBAL SYNC ON (tenantId, documentNumber)
);
