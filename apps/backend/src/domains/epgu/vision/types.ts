/**
 * VisionOcrAdapter — channel-agnostic interface для document OCR.
 *
 * Production-grade contract: тот же shape, что Mock и real Yandex Vision
 * AI Studio adapter. Swap через factory binding.
 *
 * Поддерживаемые типы (через `identityMethod` в request):
 *   - `passport_paper`   — паспорт РФ внутренний → Vision `passport` model
 *   - `passport_zagran`  — загранпаспорт РФ → `recognizeText` + MRZ-парсер
 *   - `driver_license`   — ВУ РФ → `driver-license-front` + `-back`
 *   - `ebs` / `digital_id_max` — не OCR, handled outside Vision adapter
 *
 * Source: research/yandex-vision-passport.md (canonical Yandex AI Studio
 * `passport` model spec) + round-2 ресёрч 2026-05-22 §1 (template coverage).
 */
import { type IdentityMethod, PASSPORT_COUNTRY_WHITELIST_SET } from '@horeca/shared'

/**
 * Vision `passport` model entities — 9 canonical + 1 conditional (`expirationDate`).
 *
 * Per research-cache `plans/research/yandex-vision-passport.md` §2.3 + §1.6:
 *   - 9 always returned together (or all null on parse failure)
 *   - `expirationDate` populated for загран РФ + СНГ + foreign; null for РФ-internal
 *   - `subdivision` (код подразделения) and `issued_by` (кем выдан) are NOT
 *     entities — must be parsed из fullText if needed (separate helper)
 */
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
	/**
	 * Expiration date (YYYY-MM-DD). NULL for РФ-internal паспорт (без срока).
	 * Populated for загран РФ + СНГ + foreign documents.
	 */
	readonly expirationDate: string | null
}

export interface RecognizePassportRequest {
	/** Original document bytes. */
	readonly bytes: Uint8Array
	/**
	 * MIME type документа. Vision принимает только JPEG/PNG/PDF (research §1,
	 * 2026-05-22). HEIC отвергается; frontend делает client-side transcode.
	 */
	readonly mimeType: string
	/**
	 * Heuristic country hint. Vision model is multi-country (20 countries
	 * supported), но если caller знает страну — ускоряет recognition.
	 * Null = auto-detect.
	 */
	readonly countryHint?: string | null
	/**
	 * Тип документа — определяет какую Vision модель использовать (см.
	 * VisionOcrAdapter doc). Default: 'passport_paper' (backward-compat).
	 *
	 * - `passport_paper`   → Vision `passport` model (20 countries, structured)
	 * - `passport_zagran`  → Vision `recognizeText` + MRZ-парсер (ICAO 9303)
	 * - `driver_license`   → 2× Vision calls (front + back), merged
	 * - `ebs` / `digital_id_max` → adapter should reject (handled outside)
	 */
	readonly identityMethod?: IdentityMethod
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
 * (research/yandex-vision-passport.md §2.1). Sprint C lifted к
 * `@horeca/shared` (PASSPORT_COUNTRY_WHITELIST_RU + _SET) для frontend
 * Select dropdown re-use. This alias preserves backend API surface.
 */
export const PASSPORT_COUNTRY_WHITELIST = PASSPORT_COUNTRY_WHITELIST_SET

export interface VisionOcrAdapter {
	/** Identifier для audit (`yandex_vision` | `mock_vision` | `sora_ocr_2027`). */
	readonly source: string
	recognizePassport(req: RecognizePassportRequest): Promise<RecognizePassportResponse>
}
