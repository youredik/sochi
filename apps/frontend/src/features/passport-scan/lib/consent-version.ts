/**
 * Current 152-ФЗ consent text version. Bumped when legal text changes.
 * Used to detect старые consents (старая version → re-prompt).
 *
 * 2026-05-23c — Round 4 legal citation corrections (РКН-blocker fixes):
 *   - REMOVED fictitious «ПП-1668 от 27.10.2025» (not in pravo.gov.ru registry).
 *     Replaced с canonical: до 01.03.2026 — № 109-ФЗ + ПП № 9 от 15.01.2007,
 *     с 01.03.2026 — ПП РФ № 1937 от 28.11.2025 (per primary source garant.ru).
 *   - FIXED wrong ст.10 ч.2 п.6 citation (this paragraph governs defense/security/
 *     anti-corruption — NOT migration). Replaced с honest: для RU граждан
 *     национальность не относится к спецкатегории, для иностранных граждан —
 *     ст.10 ч.1 152-ФЗ requires explicit consent.
 *   - CORRECTED 152-ФЗ ст.18 ч.5 reference — now cites актуальную редакцию
 *     № 23-ФЗ от 28.02.2025 vstuplenie 01.07.2025 (not the 2015 base).
 *   - CORRECTED ст.21 ч.7 (non-existent) → ст.5 ч.7 + ст.21 ч.5 actual canon.
 *   - CORRECTED ст.20 RTBF reference — actual canon ст.21 ч.3 (в ред. № 23-ФЗ
 *     от 28.02.2025) с 10-рабочих-дней SLA, not «ст.20».
 *   - REMOVED unverifiable «Госуслуги consent registry 01.03.2028» —
 *     no published 572-ФЗ amendment confirms this date.
 *   - ADDED explicit reference к 156-ФЗ от 24.06.2025 vstuplenie 01.09.2025
 *     (separate-document consent strictness) — verified via
 *     publication.pravo.gov.ru/document/0001202506240021.
 *   - ADDED 572-ФЗ ст.1 reference for biometric scope clarification
 *     (storage-only ≠ biometric).
 *
 * 2026-05-22b — Sprint B (superseded): photo storage в YC Object Storage,
 *   90-day retention, 5-year text retention. Содержал FICTIONAL act references
 *   ПП-1668 и wrong ст.10 ч.2 п.6 — РКН inspection blocker. Не пере-prompt'ить
 *   existing accepted consents автоматически, но new scans MUST use 2026-05-23c.
 *
 * Старые версии (2026-04-28, 2026-05-22, 2026-05-22b) считаются устаревшими.
 */
export const CONSENT_152FZ_VERSION = '2026-05-23c' as const
