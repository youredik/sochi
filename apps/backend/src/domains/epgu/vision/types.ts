/**
 * VisionOcrAdapter — channel-agnostic interface для passport OCR.
 *
 * Production-grade contract: тот же shape, что Mock и real Yandex Vision
 * AI Studio adapter. Swap через factory binding в M8.A.live.
 *
 * Source: research/yandex-vision-passport.md (canonical Yandex AI Studio
 * `passport` model spec).
 */

/** 9 entities returned by Yandex Vision passport model (always together). */
export interface PassportEntities {
	readonly surname: string | null
	readonly name: string | null
	readonly middleName: string | null
	readonly gender: 'male' | 'female' | null
	/** ISO 3166-1 alpha-3, lowercase: 'rus', 'blr', 'kaz', ... */
	readonly citizenshipIso3: string | null
	/** YYYY-MM-DD (ISO 8601) — converted from API's DD.MM.YYYY format */
	readonly birthDate: string | null
	readonly birthPlace: string | null
	/** Passport series + number combined (e.g. '4608 123456' for RU). */
	readonly documentNumber: string | null
	/** YYYY-MM-DD (ISO 8601). */
	readonly issueDate: string | null
}

export interface RecognizePassportRequest {
	/** Original document bytes. */
	readonly bytes: Uint8Array
	/** image/jpeg | image/png | image/heic | application/pdf */
	readonly mimeType: string
	/**
	 * Heuristic country hint. Vision model is multi-country (20 countries
	 * supported), but if caller knows the country — speeds up recognition.
	 * Null = auto-detect.
	 */
	readonly countryHint?: string | null
}

export interface RecognizePassportResponse {
	/** Detected ISO-3 country code, или null если не определилось. */
	readonly detectedCountryIso3: string | null
	/** Whether detected country is in our 20-country whitelist. */
	readonly isCountryWhitelisted: boolean
	/** All 9 entities (each null if not extracted). */
	readonly entities: PassportEntities
	/**
	 * API's raw confidence — usually 0.0 (known issue per research §3.2).
	 * Stored for historical tracking когда Yandex исправит.
	 */
	readonly apiConfidenceRaw: number
	/**
	 * Our heuristic confidence ∈ [0, 1]:
	 *   - regex passport_ru series/number
	 *   - sanity: dates ≤ today, > 1900
	 *   - age check ≥ 14 (РФ паспорт от 14 лет)
	 *   - name length sanity 1-50 chars
	 */
	readonly confidenceHeuristic: number
	/**
	 * Outcome classification (для UI badge):
	 *   - success: confidenceHeuristic ≥ 0.75, all required entities present
	 *   - low_confidence: < 0.75, оператор должен проверить
	 *   - api_error: HTTP error или empty entities
	 *   - invalid_document: detected_country НЕ в whitelist
	 */
	readonly outcome: 'success' | 'low_confidence' | 'api_error' | 'invalid_document'
	/** Latency, ms — для cost monitoring. */
	readonly latencyMs: number
	/** HTTP status code. 200 для success, 400/401/429/503 для errors. */
	readonly httpStatus: number
}

/**
 * Whitelist of 20 countries supported by Yandex Vision passport model
 * (research/yandex-vision-passport.md §2.1).
 */
export const PASSPORT_COUNTRY_WHITELIST: ReadonlySet<string> = new Set([
	'rus', // Россия (внутренний + загран)
	'blr', // Беларусь
	'kaz', // Казахстан
	'kgz', // Кыргызстан
	'tjk', // Таджикистан
	'uzb', // Узбекистан
	'arm', // Армения
	'aze', // Азербайджан
	'mda', // Молдова
	'tkm', // Туркменистан
	'ukr', // Украина
	'tur', // Турция
	'isr', // Израиль
	'usa', // США
	'gbr', // Великобритания
	'deu', // Германия
	'fra', // Франция
	'ita', // Италия
	'esp', // Испания
	'chn', // Китай
])

export interface VisionOcrAdapter {
	/** Identifier для audit (`yandex_vision` | `mock_vision` | `sora_ocr_2027`). */
	readonly source: string
	recognizePassport(req: RecognizePassportRequest): Promise<RecognizePassportResponse>
}
