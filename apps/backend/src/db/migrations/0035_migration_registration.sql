-- 0035_migration_registration.sql — M8.A.1 — ЕПГУ submission FSM
-- per plan v2 §8.2 + research/epgu-rkl.md §3-§5.
--
-- Closes (from 7×3 mandate):
--   * Function 1.1 (Госуслуги Скала-ЕПГУ) — existential compliance,
--     штраф до 500к₽ + КоАП 80-200к₽. С 1.1.2026 обязательно для ВСЕХ
--     accommodation типов (отели, хостелы, гостевые дома, базы, глэм-
--     пинги). Без интеграции продавать SaaS отелям РФ нелегально.
--
-- Replaces (semantically) the more generic `migrationReport` table
-- from 0001_init.sql for ЕПГУ-flow specifically. `migrationReport`
-- остаётся как backwards-compat для legacy non-ЕПГУ submissions
-- (Контур.ФМС CSV-export + manual upload в M8.A.2.fallback). После
-- M8.A.7 production-ready ЕПГУ flow + 6 месяцев observation,
-- migrationReport помечается deprecated и удаляется в M11.
--
-- Status FSM (research/epgu-rkl.md §3.1, mirror of types.ts EpguStatusResponse):
--   0  — draft (внутренний, до отправки)
--   1  — registered (принято от заявителя, после СМЭВ; 1-2 мин)
--   2  — sent_to_authority (отправлено в ведомство; промежуточный)
--   3  — executed [FINAL] (исполнено; P95=20мин, P99=60мин)
--   4  — refused [FINAL] (отказ; см. reasonRefuse)
--   5  — send_error (transport-level error, retry)
--   9  — cancellation_pending (для снятия с учёта)
--   10 — cancelled [FINAL]
--   14 — awaiting_info (МВД запросил уточнение)
--   15 — requires_correction
--   17 — submitted (immediately after pushArchive ack)
--   21 — acknowledged (промежуточный, 30-90 сек)
--   22 — delivery_error
--   24 — processing_error
--
-- 8 error categories (research/epgu-rkl.md §4 — для статуса 4):
--   * validation_format         — паспорт не подходит маске ФЛК
--   * signature_invalid         — ошибка ГОСТ Р 34.10-2012 сертификата
--   * duplicate_notification    — дубль по applicationNumber или
--                                 (supplierGid + ИГ + arrival_date)
--   * document_lost_or_invalid  — паспорт в реестре утраченных МВД
--   * rkl_match                 — иностранец в РКЛ
--   * region_mismatch           — подразделение МВД региона не совпадает
--   * stay_period_exceeded      — > 90 дней (безвиз) или > 180 (с визой)
--   * service_temporarily_unavailable — HTTP 503 + Retry-After
--
-- Polling cadence (research/epgu-rkl.md §3.3):
--   первые 10 мин: 1м интервал
--   до часа:      5м интервал
--   далее:        экспоненциально
-- Хранится в `nextPollAt` (вычисляется в repo по lastPolledAt + retryCount).
--
-- Edge case: 5-10% «lost confirmation» при снятии с учёта (research §5.6).
-- Mock эмулирует случайностью, real-flow требует ежедневной ручной сверки
-- через ЛК Госуслуг — в UI M8.A.6 будет «Проверить вручную» button.

CREATE TABLE IF NOT EXISTS migrationRegistration (
    -- PK
    tenantId              Utf8 NOT NULL,
    id                    Utf8 NOT NULL,           -- newId('mreg')

    -- Domain links
    bookingId             Utf8 NOT NULL,
    guestId               Utf8 NOT NULL,
    documentId            Utf8 NOT NULL,           -- FK guestDocument.id

    -- ЕПГУ канал (gost-tls | svoks | proxy-via-partner)
    -- Mirrors EpguChannel discriminated union в types.ts.
    epguChannel           Utf8 NOT NULL,

    -- Phase 1 result: orderId reserved by ЕПГУ
    epguOrderId           Utf8,                    -- null until reserveOrder succeeds
    epguApplicationNumber Utf8,                    -- ЕПГУ-side application number (после статуса 1)

    -- Operation context (для дубль-детекции и audit)
    serviceCode           Utf8 NOT NULL,           -- e.g. '10000103652' (ИГ постановка)
    targetCode            Utf8 NOT NULL,           -- e.g. '-1000444103652'
    supplierGid           Utf8 NOT NULL,           -- supplier identifier from МВД соглашение
    regionCode            Utf8 NOT NULL,           -- ФИАС UUID региона прибытия

    -- Stay window (для validation статуса)
    arrivalDate           Date NOT NULL,
    departureDate         Date NOT NULL,

    -- Status FSM
    statusCode            Int32 NOT NULL,          -- 0 (draft) initially; см. enum выше
    isFinal               Bool NOT NULL,           -- true когда statusCode in {3, 4, 10}
    reasonRefuse          Utf8,                    -- free-text reason при statusCode=4

    -- 8-category classification (NULL когда не отказ)
    errorCategory         Utf8,                    -- validation_format | signature_invalid | ...

    -- Timing
    submittedAt           Timestamp,               -- when pushArchive acked (status 17)
    lastPolledAt          Timestamp,
    nextPollAt            Timestamp,               -- вычислено по cadence
    finalizedAt           Timestamp,               -- когда isFinal=true

    -- Retry state
    retryCount            Int32 NOT NULL,          -- 0 initially, ++ per pollOnce attempt
    -- JSON history of attempts: [{at: ts, statusCode, reasonRefuse?}]
    attemptsHistoryJson   Json,

    -- Outbox / CDC integration (per project_event_architecture.md):
    -- Booking confirmed → CDC writer enqueues row here with status=0.
    -- Cron picks up status=0 → calls reserveOrder + pushArchive.
    -- Cron polls non-final rows per nextPollAt.

    -- Audit
    createdAt             Timestamp NOT NULL,
    updatedAt             Timestamp NOT NULL,
    createdBy             Utf8 NOT NULL,
    updatedBy             Utf8 NOT NULL,

    PRIMARY KEY (tenantId, id),

    -- Index by booking — UI «миграционный учёт» показывает per-booking.
    INDEX idxMigRegTenantBooking GLOBAL SYNC ON (tenantId, bookingId),
    -- Index by guest — history все регистрации одного гостя.
    INDEX idxMigRegTenantGuest GLOBAL SYNC ON (tenantId, guestId),
    -- Index by status + nextPollAt — cron picks rows ready to poll.
    -- Composite key matches the cron's WHERE: status NOT IN (3,4,10)
    --   AND nextPollAt <= now ORDER BY nextPollAt LIMIT batch.
    INDEX idxMigRegStatusPoll GLOBAL SYNC ON (statusCode, nextPollAt),
    -- Index by orderId (lookup при receive callback / manual check).
    INDEX idxMigRegTenantOrder GLOBAL SYNC ON (tenantId, epguOrderId)
);
