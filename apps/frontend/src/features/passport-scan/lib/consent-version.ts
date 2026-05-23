/**
 * Current 152-ФЗ consent text version. Bumped when legal text changes.
 * Used to detect старые consents (старая version → re-prompt).
 *
 * 2026-05-23d — Sprint C+ legal-expert audit findings (5-parallel experts):
 *   - **DROPPED `citizenshipSpecial` checkbox**: ст.10 ч.1 152-ФЗ verbatim lists
 *     «расовая, национальная принадлежность» — это ETHNIC ORIGIN, not citizenship.
 *     Citizenship (гражданство) = country code (ISO 3166-1) — это общие ПДн под
 *     ст.6, не спецкатегория. Mis-labeling «citizenshipSpecial = ст.10 спецкат»
 *     = первое что РКН inspection поймёт (Tinkoff УКБО precedent). 2-checkbox
 *     model: generalPdn (ст.6) + biometricPhoto (ст.11). Backend schema keeps
 *     `citizenshipSpecial` optional для backward-compat со старыми клиентами/БД.
 *   - **FIXED ПП-1937 → ПП-1912 от 27.11.2025**: ПП-1937 = procurement/325-ФЗ
 *     (значимые ПО разработчики), НЕ гостиничный акт. Hotel guest ID canonical
 *     act = ПП-1912 от 27.11.2025 (effective 01.03.2026, replaces ПП-1853).
 *     Verified via http://government.ru/docs/all/162231/ + garant.ru.
 *   - **FIXED 421-ФЗ → 420-ФЗ**: КоАП ред. 30.11.2024 — это 420-ФЗ. 421-ФЗ —
 *     отдельный закон об УК (не наш domain). Verified pravo.gov.ru.
 *   - **FIXED повторно «25-30 млн ₽» → ч.18 оборотный 1-3% выручки, 25-500 млн**:
 *     Repeat regime is КоАП ст.13.11 ч.18, NOT ч.17. Floor 25 млн, ceiling 500 млн.
 *     Verified consultant.ru cons_doc_LAW_34661.
 *   - **CORRECTED ст.20 ↔ ст.21 ч.5 timers**: ст.20 152-ФЗ = право отзыва (без
 *     timer'а). Destruction timer после отзыва = ст.21 ч.5 = 30 дней (NOT 10).
 *     ст.21 ч.3 = 10 раб.дней для неправомерной обработки (другой scenario).
 *     ст.14 = 10 раб.дней для DSAR (право на доступ — это другой timer, был
 *     verbatim verified). Differentiated three timers в тексте.
 *   - **DROPPED «572-ФЗ ст.1 storage-only»**: phrasing was speculative. Removed.
 *   - **HONEST storage label**: «загружается в Yandex Object Storage» qualified
 *     с «при наличии production storage configuration» — demo deployment uses
 *     in-process mock (Senior P1-2 finding).
 *
 * 2026-05-23c — Round 4 legal citation corrections (SUPERSEDED, fictitious refs):
 *   - REMOVED fictitious ПП-1668 от 27.10.2025. Replaced с canonical ПП-1937
 *     (которое тоже неправильно — fixed в 2026-05-23d).
 *   - Multiple wrong ст-citations (см. 2026-05-23d corrections).
 *
 * 2026-05-22b — Sprint B (superseded): photo storage в YC Object Storage,
 *   90-day retention, 5-year text retention. Содержал FICTIONAL act references.
 *
 * Старые версии (2026-04-28, 2026-05-22, 2026-05-22b, 2026-05-23c) считаются устаревшими.
 */
export const CONSENT_152FZ_VERSION = '2026-05-23d' as const
