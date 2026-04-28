/**
 * Public Vision OCR types — shared между backend (adapter) и frontend
 * (passport scan UI). Backend's apps/backend/src/domains/epgu/vision/types.ts
 * имеет broader interface (RecognizePassportRequest с bytes); these are
 * the wire-format types frontend нуждается через RPC client.
 *
 * Per `project_m8_a_6_ui_canonical.md`: passport scan UI consumes
 * RecognizePassportResponse + PassportEntities; не нуждается в
 * adapter interface itself.
 */

/** 9 entities returned by Yandex Vision passport model (always together). */
export interface PassportEntities {
	readonly surname: string | null
	readonly name: string | null
	readonly middleName: string | null
	readonly gender: 'male' | 'female' | null
	/** ISO 3166-1 alpha-3, lowercase: 'rus', 'blr', 'kaz', ... */
	readonly citizenshipIso3: string | null
	/** YYYY-MM-DD (ISO 8601). */
	readonly birthDate: string | null
	readonly birthPlace: string | null
	/** Passport series + number combined (e.g. '4608 123456' for RU). */
	readonly documentNumber: string | null
	/** YYYY-MM-DD (ISO 8601). */
	readonly issueDate: string | null
}

export interface RecognizePassportResponse {
	/** Detected ISO-3 country code, или null если не определилось. */
	readonly detectedCountryIso3: string | null
	/** Whether detected country is in our 20-country whitelist. */
	readonly isCountryWhitelisted: boolean
	readonly entities: PassportEntities
	/**
	 * API's raw confidence — usually 0.0 (known issue per research §3.2).
	 * Stored для historical tracking когда Yandex исправит.
	 */
	readonly apiConfidenceRaw: number
	/**
	 * Heuristic confidence ∈ [0, 1]:
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
