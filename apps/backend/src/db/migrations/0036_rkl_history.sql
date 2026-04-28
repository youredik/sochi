-- 0036_rkl_history.sql — M8.A.1 — РКЛ (реестр контролируемых лиц) check history
-- per plan v2 §8.2 + research/epgu-rkl.md §6 (РКЛ) + §6.1 (Контур.ФМС API).
--
-- Closes (from 7×3 mandate):
--   * Function 1.1 (Госуслуги ЕПГУ) — РКЛ-проверка ОБЯЗАТЕЛЬНА перед
--     заселением иностранца. Без проверки — отказ ЕПГУ с error
--     `rkl_match` И штраф МВД. РКЛ обновляется МВД РФ ежедневно.
--
-- Background (research/epgu-rkl.md §6):
--   РКЛ = Реестр Контролируемых Лиц. С 5 февраля 2025 — обязательная
--   проверка иностранцев перед заселением. РКЛ содержит:
--     * Лица под уголовным преследованием
--     * Лица с просроченным сроком пребывания
--     * Депортированные / persona non grata
--     * Особый контроль (политически чувствительные)
--
-- Mock distribution (research/epgu-rkl.md §6.2):
--   * 99%   clean         — гость не в реестре, can proceed
--   * 0.5%  match         — гость в реестре, БЛОКИРОВКА заселения
--                           (требует ручной проверки в ОВМ МВД)
--   * 0.5%  inconclusive  — partial match (имя совпадает, но
--                           document data не подтверждает) — warning
--                           оператору, не блокировка
--   Latency: 50-300 мс.
--   Snapshot updates: 2-3 раза в сутки (каждые ~8 часов; in-memory).
--
-- Real API (Контур.ФМС, research/epgu-rkl.md §6.1):
--   POST https://api.kontur.ru/fms/v1/rkl/check
--   {
--     documentType: 'passport_ru' | 'passport_zagran' | ...,
--     series: '4608',
--     number: '123456',
--     birthdate: '1979-05-12'
--   }
--   →
--   {
--     status: 'clean' | 'match' | 'inconclusive',
--     checked_at: '2026-04-27T15:30:00+03:00',
--     registry_revision: '2026-04-27.043'  -- daily snapshot id
--   }
--
-- Retention: 30 days (КоАП — для аудита проверок).
-- Cleanup cron (M8.A.5) удаляет rows старше 30 дней.
--
-- Privacy: result data не содержит passport content (ссылка на
-- guestDocument.id вместо дублирования series/number).

CREATE TABLE IF NOT EXISTS rklHistory (
    tenantId            Utf8 NOT NULL,
    id                  Utf8 NOT NULL,             -- newId('rkl')

    -- Domain links
    guestId             Utf8 NOT NULL,
    documentId          Utf8 NOT NULL,             -- FK guestDocument.id

    -- Result
    -- 'clean' | 'match' | 'inconclusive' (Zod-validated в repo)
    status              Utf8 NOT NULL,
    -- 'exact' | 'partial' (только когда status != 'clean')
    matchType           Utf8,
    -- Daily registry version from МВД (e.g. '2026-04-27.043')
    registryRevision    Utf8 NOT NULL,
    -- Latency самого RKL-call для adapter monitoring
    latencyMs           Int32 NOT NULL,
    -- Полный raw response (audit, debug)
    rawResponseJson     Json,

    -- Audit
    checkedAt           Timestamp NOT NULL,
    -- Который запрос вызвал check (booking_confirmed | manual_re_check)
    triggerSource       Utf8 NOT NULL,             -- 'booking_confirmed' | 'manual'
    -- bookingId если check был от bookingFlow, NULL если manual
    bookingId           Utf8,

    PRIMARY KEY (tenantId, id),

    -- Index by guest для history view.
    INDEX idxRklHistoryTenantGuest GLOBAL SYNC ON (tenantId, guestId),
    -- Index by checkedAt для cleanup cron (rows старше 30 дней).
    INDEX idxRklHistoryCheckedAt GLOBAL SYNC ON (checkedAt),
    -- Index по status — фильтр «показать только matches» в admin UI.
    INDEX idxRklHistoryTenantStatus GLOBAL SYNC ON (tenantId, status)
);
