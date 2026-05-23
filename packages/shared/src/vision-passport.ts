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

/**
 * Entities returned by Yandex Vision `passport` model (always together).
 *
 * Canonical 9 fields per research-cache `plans/research/yandex-vision-passport.md`
 * §2.3 (2026-04-27) + 1 conditional field (`expirationDate`) for загран/СНГ
 * documents per §1.6. RU-internal паспорт returns `expirationDate: null`
 * (РФ internal паспорт не имеет даты истечения).
 *
 * Fields explicitly NOT here per research-cache §2.3:
 *   `subdivision` (код подразделения), `issuedBy` (issuing authority) —
 *   these are NOT returned in Vision `entities[]`; they exist only in
 *   `fullText` and require regex-parse on our side. When/if we surface
 *   them, layer them through a separate `parseSubdivisionFromFullText`
 *   helper, NOT через PassportEntities interface.
 */
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
	/**
	 * Passport expiration date (YYYY-MM-DD). NULL for RU-internal passports
	 * (РФ internal без срока действия) and for any document without explicit
	 * expiry. Populated for загран РФ + СНГ + foreign passports.
	 */
	readonly expirationDate: string | null
}

/**
 * РКЛ (Реестр Контролируемых Лиц) status, returned by passport.scan endpoint.
 *
 *   - clean:        adapter confirmed clean (or RU-bypass whitelist)
 *   - match:        adapter found a match — operator attention required, Save blocked
 *   - inconclusive: adapter could not decide — operator warned, Save allowed
 *   - check_failed: adapter threw / network error / insufficient data — Save allowed (МВД re-checks at submit)
 *   - skipped_ru:   RU citizen — РКЛ not applicable (registry foreign-only)
 *
 * Sprint C: surfaced к frontend so operator sees RKL status в ConfirmStage badge.
 */
export type RklStatusForScan = 'clean' | 'match' | 'inconclusive' | 'check_failed' | 'skipped_ru'

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
	/**
	 * Sprint C: РКЛ pre-check outcome — surfaced для operator UX badge в ConfirmStage.
	 * 'match' = Save кнопка disabled (гость в реестре контролируемых лиц МВД).
	 */
	readonly rklStatus: RklStatusForScan
	readonly rklMatchType: 'exact' | 'partial' | null
	/** RKL registry version если adapter call был сделан. Null если skipped_ru / insufficient data. */
	readonly rklRegistryRevision: string | null
}

/**
 * Sprint C: PASSPORT_COUNTRY_WHITELIST + RU labels lifted к shared.
 *
 * Yandex Vision passport model поддерживает 20 ISO-3166-1 alpha-3 кодов
 * (research-cache yandex-vision-passport.md §2.1, 2026-04-27). Frontend
 * использует labels для Select dropdown в ConfirmStage; backend проверяет
 * `isCountryWhitelisted` для outcome classification.
 *
 * **Не дублировать в backend** — backend re-exports same Set через alias
 * (apps/backend/src/domains/epgu/vision/types.ts).
 */
export const PASSPORT_COUNTRY_WHITELIST_RU: ReadonlyArray<{
	readonly iso3: string
	readonly labelRu: string
}> = [
	{ iso3: 'rus', labelRu: 'Россия' },
	{ iso3: 'blr', labelRu: 'Беларусь' },
	{ iso3: 'kaz', labelRu: 'Казахстан' },
	{ iso3: 'kgz', labelRu: 'Кыргызстан' },
	{ iso3: 'tjk', labelRu: 'Таджикистан' },
	{ iso3: 'uzb', labelRu: 'Узбекистан' },
	{ iso3: 'arm', labelRu: 'Армения' },
	{ iso3: 'aze', labelRu: 'Азербайджан' },
	{ iso3: 'mda', labelRu: 'Молдова' },
	{ iso3: 'tkm', labelRu: 'Туркменистан' },
	{ iso3: 'ukr', labelRu: 'Украина' },
	{ iso3: 'tur', labelRu: 'Турция' },
	{ iso3: 'isr', labelRu: 'Израиль' },
	{ iso3: 'usa', labelRu: 'США' },
	{ iso3: 'gbr', labelRu: 'Великобритания' },
	{ iso3: 'deu', labelRu: 'Германия' },
	{ iso3: 'fra', labelRu: 'Франция' },
	{ iso3: 'ita', labelRu: 'Италия' },
	{ iso3: 'esp', labelRu: 'Испания' },
	{ iso3: 'chn', labelRu: 'Китай' },
] as const

/** Fast lookup для backend `isCountryWhitelisted` check. */
export const PASSPORT_COUNTRY_WHITELIST_SET: ReadonlySet<string> = new Set(
	PASSPORT_COUNTRY_WHITELIST_RU.map((c) => c.iso3),
)
