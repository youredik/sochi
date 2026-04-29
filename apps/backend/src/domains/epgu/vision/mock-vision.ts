/**
 * MockVisionOcrAdapter — behaviour-faithful production-grade simulator.
 *
 * Same interface как real Yandex Vision AI Studio adapter (M8.A.3.live).
 * Swap = factory binding change в adapter registry.
 *
 * Behaviour spec (research/yandex-vision-passport.md §3 + §4):
 *   * Latency 800-2500 ms (real API range)
 *   * 9 entities returned together (never partial-by-design)
 *   * apiConfidenceRaw = 0.0 (matches known Yandex issue)
 *   * Edge cases:
 *     - 3% invalid_argument (HTTP 400) — corrupted bytes, wrong format
 *     - 2% unavailable (HTTP 503) — Yandex Cloud downtime
 *     - 5% empty entities — low-quality scan, ALL fields null
 *     - 7% partial entities (4-6 fields) — partial extract, low confidence
 *     - rest (~83%) — full extract with realistic data
 *   * Whitelist 20 countries (PASSPORT_COUNTRY_WHITELIST).
 *
 * Heuristic confidence calibration (research §3.2):
 *   - 1.00 base, then deduct:
 *   - -0.20 if any required entity (surname/name/documentNumber/birthDate) null
 *   - -0.15 if documentNumber doesn't match RU regex /^\d{4}\s?\d{6}$/ for citizenshipIso3='rus'
 *   - -0.10 if birthDate year > today or < 1900
 *   - -0.20 if age < 14 (RU паспорт invariant)
 *   - -0.10 if name length < 2 OR > 50
 *   - clamp to [0, 1]
 */
import {
	PASSPORT_COUNTRY_WHITELIST,
	type PassportEntities,
	type RecognizePassportRequest,
	type RecognizePassportResponse,
	type VisionOcrAdapter,
} from './types.ts'

export interface MockVisionOcrOptions {
	readonly random?: () => number
	readonly now?: () => number
	/** Speed-up factor for latency (1.0 = real 800-2500ms). Tests use 1000. */
	readonly speedUpFactor?: number
	/**
	 * Override outcome distribution. Test may force `invalid_document`
	 * to assert UI badge handling.
	 */
	readonly forceOutcome?: RecognizePassportResponse['outcome']
}

const SAMPLE_RUS_SURNAMES = ['Иванов', 'Петров', 'Сидоров', 'Кузнецов', 'Смирнов']
const SAMPLE_RUS_NAMES = ['Алексей', 'Дмитрий', 'Иван', 'Сергей', 'Михаил']
const SAMPLE_RUS_MIDDLE = ['Александрович', 'Петрович', 'Иванович']
const SAMPLE_RUS_PLACES = ['г. Москва', 'г. Санкт-Петербург', 'г. Сочи', 'г. Краснодар']

function randomDateInRange(random: () => number, fromYear: number, toYear: number): string {
	const year = fromYear + Math.floor(random() * (toYear - fromYear + 1))
	const month = 1 + Math.floor(random() * 12)
	const day = 1 + Math.floor(random() * 28)
	const mm = month.toString().padStart(2, '0')
	const dd = day.toString().padStart(2, '0')
	return `${year}-${mm}-${dd}`
}

function randomPassportNumber(random: () => number): string {
	const series = Array.from({ length: 4 }, () => Math.floor(random() * 10)).join('')
	const number = Array.from({ length: 6 }, () => Math.floor(random() * 10)).join('')
	return `${series} ${number}`
}

function pick<T>(arr: ReadonlyArray<T>, random: () => number): T {
	const idx = Math.floor(random() * arr.length)
	const item = arr[idx]
	if (item === undefined) throw new Error('pick: empty array')
	return item
}

function buildFullEntities(random: () => number): PassportEntities {
	// 80% RU-internal (expirationDate=null), 20% загран/СНГ (with expiry).
	// Real Yandex Vision returns expirationDate only for non-РФ-internal docs.
	const isInternational = random() < 0.2
	const issueDate = randomDateInRange(random, 2010, 2024)
	let expirationDate: string | null = null
	if (isInternational) {
		// Загран РФ valid 10 years; СНГ similar — synth +10y from issueDate.
		const issueYear = Number.parseInt(issueDate.slice(0, 4), 10)
		const expiryYear = issueYear + 10
		expirationDate = `${expiryYear}${issueDate.slice(4)}`
	}
	return {
		surname: pick(SAMPLE_RUS_SURNAMES, random),
		name: pick(SAMPLE_RUS_NAMES, random),
		middleName: pick(SAMPLE_RUS_MIDDLE, random),
		gender: random() < 0.5 ? 'male' : 'female',
		citizenshipIso3: 'rus',
		birthDate: randomDateInRange(random, 1960, 2008),
		birthPlace: pick(SAMPLE_RUS_PLACES, random),
		documentNumber: randomPassportNumber(random),
		issueDate,
		expirationDate,
	}
}

function buildPartialEntities(random: () => number): PassportEntities {
	const full = buildFullEntities(random)
	// Drop 3-5 random fields
	const fieldsToDrop = 3 + Math.floor(random() * 3)
	const keys = Object.keys(full) as Array<keyof PassportEntities>
	const shuffled = [...keys].sort(() => random() - 0.5)
	const partial = { ...full } as Record<string, PassportEntities[keyof PassportEntities]>
	for (let i = 0; i < fieldsToDrop && i < shuffled.length; i++) {
		const k = shuffled[i]
		if (k !== undefined) partial[k] = null
	}
	return partial as unknown as PassportEntities
}

function emptyEntities(): PassportEntities {
	return {
		surname: null,
		name: null,
		middleName: null,
		gender: null,
		citizenshipIso3: null,
		birthDate: null,
		birthPlace: null,
		documentNumber: null,
		issueDate: null,
		expirationDate: null,
	}
}

/**
 * Heuristic confidence per research §3.2 — наша логика поверх API
 * (которое возвращает 0.0 broken). Used by both Mock + real adapter.
 */
export function computeHeuristicConfidence(entities: PassportEntities, today: Date): number {
	let score = 1.0
	if (entities.surname === null || entities.name === null || entities.documentNumber === null) {
		score -= 0.2
	}
	if (entities.birthDate === null) score -= 0.2
	// Document number regex check
	if (entities.documentNumber !== null && entities.citizenshipIso3 === 'rus') {
		if (!/^\d{4}\s?\d{6}$/.test(entities.documentNumber)) score -= 0.15
	}
	// Birth date sanity
	if (entities.birthDate !== null) {
		const bd = new Date(entities.birthDate)
		if (Number.isNaN(bd.getTime())) {
			score -= 0.1
		} else {
			const year = bd.getFullYear()
			if (year < 1900 || bd > today) score -= 0.1
			// Age check ≥ 14 (РФ паспорт invariant)
			const ageYears = (today.getTime() - bd.getTime()) / (365.25 * 24 * 3600 * 1000)
			if (ageYears < 14) score -= 0.2
		}
	}
	// Name length sanity
	if (entities.surname !== null && (entities.surname.length < 2 || entities.surname.length > 50)) {
		score -= 0.1
	}
	if (entities.name !== null && (entities.name.length < 2 || entities.name.length > 50)) {
		score -= 0.1
	}
	return Math.max(0, Math.min(1, score))
}

function classifyOutcome(
	entities: PassportEntities,
	confidenceHeuristic: number,
	httpStatus: number,
	isCountryWhitelisted: boolean,
): RecognizePassportResponse['outcome'] {
	if (httpStatus >= 400) return 'api_error'
	if (!isCountryWhitelisted && entities.citizenshipIso3 !== null) return 'invalid_document'
	const allRequired =
		entities.surname !== null &&
		entities.name !== null &&
		entities.documentNumber !== null &&
		entities.birthDate !== null
	if (allRequired && confidenceHeuristic >= 0.75) return 'success'
	return 'low_confidence'
}

export function createMockVisionOcr(opts: MockVisionOcrOptions = {}): VisionOcrAdapter {
	const random = opts.random ?? Math.random
	const now = opts.now ?? Date.now
	const speedUpFactor = opts.speedUpFactor ?? 1.0
	return {
		source: 'mock_vision',
		async recognizePassport(req: RecognizePassportRequest): Promise<RecognizePassportResponse> {
			const startMs = now()
			const realLatencyMs = 800 + Math.floor(random() * 1700) // 800-2500
			const effectiveLatencyMs = Math.max(1, Math.floor(realLatencyMs / speedUpFactor))
			// Don't actually sleep — for sync test predictability mock just returns latencyMs.
			// In live mode the real Vision SDK will block, in mock-mode wall-clock = ~0.
			void startMs

			// Validate input
			if (req.bytes.length === 0) {
				return {
					detectedCountryIso3: null,
					isCountryWhitelisted: false,
					entities: emptyEntities(),
					apiConfidenceRaw: 0,
					confidenceHeuristic: 0,
					outcome: 'api_error',
					latencyMs: effectiveLatencyMs,
					httpStatus: 400,
				}
			}

			// Outcome distribution
			const roll = random()
			let outcome: RecognizePassportResponse['outcome']
			let entities: PassportEntities
			let httpStatus = 200
			if (opts.forceOutcome) {
				outcome = opts.forceOutcome
				switch (outcome) {
					case 'api_error':
						httpStatus = 400
						entities = emptyEntities()
						break
					case 'invalid_document':
						entities = buildFullEntities(random)
						break
					case 'low_confidence':
						entities = buildPartialEntities(random)
						break
					default:
						entities = buildFullEntities(random)
				}
			} else if (roll < 0.03) {
				// 3% invalid_argument
				outcome = 'api_error'
				httpStatus = 400
				entities = emptyEntities()
			} else if (roll < 0.05) {
				// 2% unavailable
				outcome = 'api_error'
				httpStatus = 503
				entities = emptyEntities()
			} else if (roll < 0.1) {
				// 5% empty entities (low-quality scan)
				outcome = 'low_confidence'
				entities = emptyEntities()
			} else if (roll < 0.17) {
				// 7% partial entities
				outcome = 'low_confidence'
				entities = buildPartialEntities(random)
			} else {
				// ~83% full extract
				entities = buildFullEntities(random)
				outcome = 'success' // re-classified below by computeHeuristic
			}

			const detectedCountryIso3 = entities.citizenshipIso3
			const isCountryWhitelisted =
				detectedCountryIso3 !== null && PASSPORT_COUNTRY_WHITELIST.has(detectedCountryIso3)
			const confidenceHeuristic = computeHeuristicConfidence(entities, new Date(now()))
			// Final outcome reclassified after confidence compute (more accurate)
			const finalOutcome = opts.forceOutcome
				? outcome
				: classifyOutcome(entities, confidenceHeuristic, httpStatus, isCountryWhitelisted)

			return {
				detectedCountryIso3,
				isCountryWhitelisted,
				entities,
				apiConfidenceRaw: 0, // matches Yandex Vision known broken
				confidenceHeuristic,
				outcome: finalOutcome,
				latencyMs: effectiveLatencyMs,
				httpStatus,
			}
		},
	}
}
