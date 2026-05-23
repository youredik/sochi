/**
 * Current 152-ФЗ consent text version. Bumped when legal text changes.
 * Used to detect старые consents (старая version → re-prompt).
 *
 * 2026-05-22b — Sprint B Round 4 native YC Object Storage canon:
 *   - photo storage в YC Object Storage с 90-day retention (lifecycle policy),
 *     SSE-S3 encryption-at-rest
 *   - 5-year retention для structured text + consent journal
 *   - переписан раздел «Сроки хранения» с разделением по типам данных
 * Старые версии (2026-04-28, 2026-05-22) считаются устаревшими.
 */
export const CONSENT_152FZ_VERSION = '2026-05-22b' as const
