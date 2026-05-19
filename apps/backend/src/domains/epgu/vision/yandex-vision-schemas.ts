/**
 * Yandex Cloud OCR API — boundary Zod schemas (P2, 2026-05-19).
 *
 * Defensive validation на receive — catches API drift loud. Empirical endpoint
 * (verified via `scripts/verify-vision-empirical.ts` prior session, Q1 2026
 * migration): Vision passport-model now lives под OCR namespace:
 *
 *   POST https://ocr.api.cloud.yandex.net/ocr/v1/recognizeText
 *
 * Headers:
 *   - Authorization: `Api-Key <key>`
 *   - x-folder-id: <folder_id>   (Api-Key carries no folder context)
 *   - x-data-logging-enabled: 'false' (privacy — 152-ФЗ + PII redaction)
 *
 * Body:
 *   {
 *     content: <base64 image bytes>,
 *     mimeType: 'image/jpeg' | 'image/png' | 'image/heic' | 'application/pdf',
 *     languageCodes: ['ru', 'en'],
 *     model: 'passport' | 'driver-license-front' | 'vehicle-registration' | ...
 *   }
 *
 * Response: chunked stream of `RecognizeTextResponse` envelopes (one per page).
 * For passport (single page) — typically 1 chunk. Parse first non-empty line.
 *
 *   {
 *     result: {
 *       textAnnotation: { width, height, entities[], fullText },
 *       page: '0'
 *     }
 *   }
 * OR error:
 *   {
 *     error: { code, message, details[] }
 *   }
 *
 * Domain types (PassportEntities, RecognizePassportResponse) live в `./types.ts`
 * — Mock + real adapter use SAME domain shape. This file = API-boundary only.
 */

import { z } from 'zod'

/** Single entity returned from OCR (snake_case from API). */
export const yandexVisionEntitySchema = z.object({
	name: z.string().min(1),
	text: z.string(),
})

export const yandexVisionTextAnnotationSchema = z.object({
	width: z.string().optional(),
	height: z.string().optional(),
	entities: z.array(yandexVisionEntitySchema).optional(),
	fullText: z.string().optional(),
})

export const yandexVisionResultSchema = z.object({
	textAnnotation: yandexVisionTextAnnotationSchema.optional(),
	page: z.string().optional(),
})

/** Yandex Cloud error envelope (RFC-style gRPC-status mirror in REST). */
export const yandexVisionErrorSchema = z.object({
	code: z.number().int(),
	message: z.string(),
	details: z.array(z.unknown()).optional(),
})

/**
 * Chunk envelope — Yandex Cloud OCR streams chunked responses (one per page);
 * single-page passport = 1 chunk. Either `result` OR `error` present, not both.
 */
export const yandexVisionChunkSchema = z.object({
	result: yandexVisionResultSchema.optional(),
	error: yandexVisionErrorSchema.optional(),
})

// YandexVisionChunk inferred type would be unused export — schema validates
// inline в provider.ts via `.parse(raw)`. Inferred type re-derivable on demand
// (z.infer<typeof yandexVisionChunkSchema>) if external consumer ever needs it.

// -----------------------------------------------------------------------------
// Pure-fn mapping helpers (testable independently)
// -----------------------------------------------------------------------------

/**
 * Yandex Vision returns entity names в snake_case. Map к our domain camelCase.
 * Returns `null` для unknown names — caller skips (forward-compat with future
 * passport entity additions от Yandex).
 *
 * 9 canonical + 1 conditional per Q2 2026 canon (research 2026-05-19):
 *   surname | name | middle_name | gender | citizenship | birth_date |
 *   birth_place | number | issue_date | expiration_date (conditional)
 */
export function snakeToCamelEntityName(
	name: string,
): keyof import('./types.ts').PassportEntities | null {
	switch (name) {
		case 'surname':
			return 'surname'
		case 'name':
			return 'name'
		case 'middle_name':
			return 'middleName'
		case 'gender':
			return 'gender'
		case 'citizenship':
			return 'citizenshipIso3'
		case 'birth_date':
			return 'birthDate'
		case 'birth_place':
			return 'birthPlace'
		case 'number':
			return 'documentNumber'
		case 'issue_date':
			return 'issueDate'
		case 'expiration_date':
			return 'expirationDate'
		default:
			return null
	}
}

/**
 * Yandex Vision returns dates in DD.MM.YYYY (RU format). Map к ISO 8601 (YYYY-MM-DD).
 * Returns null on parse failure (caller marks confidence-low).
 *
 * Accepts: "07.03.1985" (canon)
 * Rejects: empty, malformed, out-of-range day/month/year.
 */
export function parseDateDdMmYyyyToIso(value: string): string | null {
	const match = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(value.trim())
	if (match === null) return null
	const day = Number(match[1])
	const month = Number(match[2])
	const year = Number(match[3])
	if (day < 1 || day > 31) return null
	if (month < 1 || month > 12) return null
	if (year < 1900 || year > 2100) return null
	const dd = String(day).padStart(2, '0')
	const mm = String(month).padStart(2, '0')
	return `${year}-${mm}-${dd}`
}

/**
 * Yandex returns citizenship in mixed format. Sample observed values from
 * empirical curl (2026, evidence dir): "RUS", "Russian Federation", "Россия",
 * "БЕЛАРУСЬ", lowercase "rus". Normalize к ISO 3166-1 alpha-3 lowercase.
 *
 * Returns null if cannot map (caller marks isCountryWhitelisted=false).
 */
const CITIZENSHIP_MAP: ReadonlyMap<string, string> = new Map([
	// Common English/abbrevs
	['rus', 'rus'],
	['russian federation', 'rus'],
	['russia', 'rus'],
	['blr', 'blr'],
	['belarus', 'blr'],
	['kaz', 'kaz'],
	['kazakhstan', 'kaz'],
	['kgz', 'kgz'],
	['kyrgyzstan', 'kgz'],
	['tjk', 'tjk'],
	['tajikistan', 'tjk'],
	['uzb', 'uzb'],
	['uzbekistan', 'uzb'],
	['arm', 'arm'],
	['armenia', 'arm'],
	['aze', 'aze'],
	['azerbaijan', 'aze'],
	['mda', 'mda'],
	['moldova', 'mda'],
	['tkm', 'tkm'],
	['turkmenistan', 'tkm'],
	['ukr', 'ukr'],
	['ukraine', 'ukr'],
	['tur', 'tur'],
	['turkey', 'tur'],
	['isr', 'isr'],
	['israel', 'isr'],
	['usa', 'usa'],
	['united states', 'usa'],
	['gbr', 'gbr'],
	['united kingdom', 'gbr'],
	['great britain', 'gbr'],
	['deu', 'deu'],
	['germany', 'deu'],
	['fra', 'fra'],
	['france', 'fra'],
	['ita', 'ita'],
	['italy', 'ita'],
	['esp', 'esp'],
	['spain', 'esp'],
	['chn', 'chn'],
	['china', 'chn'],
	// Cyrillic common
	['россия', 'rus'],
	['российская федерация', 'rus'],
	['беларусь', 'blr'],
	['казахстан', 'kaz'],
	['кыргызстан', 'kgz'],
	['таджикистан', 'tjk'],
	['узбекистан', 'uzb'],
	['армения', 'arm'],
	['азербайджан', 'aze'],
	['молдова', 'mda'],
	['туркменистан', 'tkm'],
	['украина', 'ukr'],
	['турция', 'tur'],
	['израиль', 'isr'],
	['сша', 'usa'],
	['великобритания', 'gbr'],
	['германия', 'deu'],
	['франция', 'fra'],
	['италия', 'ita'],
	['испания', 'esp'],
	['китай', 'chn'],
])

export function normalizeCitizenshipToIso3(value: string): string | null {
	const k = value.trim().toLowerCase()
	return CITIZENSHIP_MAP.get(k) ?? null
}

/**
 * Normalize gender from Yandex Vision raw text к domain `'male' | 'female' | null`.
 * Yandex emits 'муж' / 'жен' / 'M' / 'F' / 'male' / 'female' depending on locale.
 */
export function normalizeGender(value: string): 'male' | 'female' | null {
	const k = value.trim().toLowerCase()
	if (k === 'муж' || k === 'муж.' || k === 'm' || k === 'male' || k === 'м') return 'male'
	if (k === 'жен' || k === 'жен.' || k === 'f' || k === 'female' || k === 'ж') return 'female'
	return null
}
