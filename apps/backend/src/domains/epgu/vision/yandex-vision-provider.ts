/**
 * Yandex Cloud OCR — REAL VisionOcrAdapter implementation (P2, 2026-05-19).
 *
 * Replaces previous mock-only path. Conforms к canonical `VisionOcrAdapter`
 * interface (`./types.ts`). Production-grade — used in APP_MODE=sandbox
 * (Yandex Cloud free-tier grant 4 000 ₽ on signup) AND APP_MODE=production.
 * Same code path; mode is registry metadata + APP_MODE startup gate.
 *
 * ## Canon refs (verified 2026-05-19)
 *
 * - Endpoint: `https://ocr.api.cloud.yandex.net/ocr/v1/recognizeText`
 *   (Vision passport-model migrated к OCR namespace Q1 2026, empirical-verified
 *   via `scripts/verify-vision-empirical.ts` prior session)
 * - Auth: `Authorization: Api-Key <key>` + `x-folder-id: <folder>` header
 *   (Api-Key carries no folder context, MUST pass separately)
 * - Privacy: `x-data-logging-enabled: false` (152-ФЗ + PII redaction)
 * - Idempotency: Yandex Cloud canon header `Idempotency-Key` (NOTE: differs
 *   от ЮKassa `Idempotence-Key` — Yandex Cloud follows IETF draft spelling)
 * - Response: chunked stream of `RecognizeTextResponse` envelopes (one per
 *   page); single-page passport = 1 chunk. Parse first non-empty line.
 *
 * ## Resilience (cockatiel 3.2 composable policy)
 *
 * - Retry: 3 attempts max (1 initial + 2 retries) для transient 5xx / 429 /
 *   network. Vision OCR async по nature — bumping retry count vs Stripe canon.
 * - Exp backoff 200→400→800→1600ms (industry OCR retry pattern)
 * - Circuit Breaker: 5 consecutive failures, 30s half-open probe
 * - Timeout: 30s aggressive
 *
 * ## Error mapping
 *
 * REST errors → typed exceptions OR mapped к `outcome: 'api_error'` для
 * graceful degradation в UI (passport scan failed — operator retries).
 * 4xx other than 429 = not retried.
 */

import {
	circuitBreaker,
	ConsecutiveBreaker,
	ExponentialBackoff,
	handleType,
	retry,
	timeout,
	TimeoutStrategy,
	wrap,
} from 'cockatiel'
import { computeHeuristicConfidence } from './mock-vision.ts'
import {
	PASSPORT_COUNTRY_WHITELIST,
	type PassportEntities,
	type RecognizePassportRequest,
	type RecognizePassportResponse,
	type VisionOcrAdapter,
} from './types.ts'
import {
	normalizeCitizenshipToIso3,
	normalizeGender,
	parseDateDdMmYyyyToIso,
	snakeToCamelEntityName,
	yandexVisionChunkSchema,
} from './yandex-vision-schemas.ts'

// -----------------------------------------------------------------------------
// Resilience constants (rationale inline — DO NOT inline as magic)
// -----------------------------------------------------------------------------

/**
 * Number of *additional* attempts after initial (cockatiel semantics).
 * Vision OCR canon — 2 retries OK (vs Stripe payment 1) — OCR не money,
 * retry risk = duplicated extracted-fields email/SMS, low blast radius.
 * Total 3 attempts max.
 */
const RETRY_ADDITIONAL_ATTEMPTS = 2

/** Initial backoff delay (ms). Equal-Jitter exp пер AWS Builders Library 2026. */
const RETRY_INITIAL_DELAY_MS = 200

/** Exp base for retry backoff (200→400→800→1600 ms). */
const RETRY_EXPONENT = 2

/** Cap on backoff to avoid pathological waits. */
const RETRY_MAX_DELAY_MS = 1_600

/**
 * Consecutive failures before circuit opens. 5 = balances false-trip vs
 * detection latency (cockatiel canon, Netflix Hystrix lineage).
 */
const CIRCUIT_CONSECUTIVE_FAILURES = 5

/** Half-open probe interval (ms). */
const CIRCUIT_HALF_OPEN_AFTER_MS = 30_000

/** Request timeout (ms). Vision OCR P95 ≈ 800-2500ms; 30s = headroom × 12. */
const REQUEST_TIMEOUT_MS = 30_000

/** OCR endpoint base (Q1 2026 migration: vision → ocr namespace). */
const DEFAULT_OCR_API_BASE = 'https://ocr.api.cloud.yandex.net'
const OCR_RECOGNIZE_PATH = '/ocr/v1/recognizeText'

/** Yandex Cloud canon idempotency header (IETF draft spelling). */
const IDEMPOTENCY_KEY_HEADER = 'Idempotency-Key'

/** Privacy gate — disables Yandex side request-body logging (152-ФЗ + PII). */
const DATA_LOGGING_DISABLED_HEADER = 'x-data-logging-enabled'

/** Confidence threshold для outcome='success' classification (Q2 2026 canon). */
const SUCCESS_CONFIDENCE_THRESHOLD = 0.75

/** Successful HTTP statuses for Yandex Cloud OCR. */
const HTTP_OK = 200
const HTTP_CREATED = 201

// -----------------------------------------------------------------------------
// Public configuration
// -----------------------------------------------------------------------------

export type YandexVisionOptions = {
	/** Service-account API key with role `ai.vision.user`. */
	apiKey: string
	/** Yandex Cloud folder ID — Api-Key carries no folder context. */
	folderId: string
	/** Endpoint base URL. Override only для network testing (mocked fetch). */
	apiBase?: string
	/**
	 * UUIDv4 generator for `Idempotency-Key`. Injected для tests; default
	 * `crypto.randomUUID()`.
	 */
	uuid?: () => string
	/** Wall-clock for `latencyMs` measurement. Default `Date.now`. */
	now?: () => number
	/**
	 * `fetch` injection seam (tests OR custom HTTP-agent для outbound proxy).
	 * Default `globalThis.fetch.bind(globalThis)`. Narrowed signature — drops
	 * Bun's `preconnect` method we don't use.
	 */
	fetch?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>
	/**
	 * Structured logger (Pino-compatible). Optional — no-op when absent.
	 * NEVER log raw image bytes OR API key.
	 */
	logger?: {
		debug(obj: Record<string, unknown>, msg?: string): void
		info(obj: Record<string, unknown>, msg?: string): void
		warn(obj: Record<string, unknown>, msg?: string): void
		error(obj: Record<string, unknown>, msg?: string): void
	}
}

// -----------------------------------------------------------------------------
// Typed errors
// -----------------------------------------------------------------------------

export class YandexVisionError extends Error {
	readonly status: number
	readonly bodyText: string | null
	constructor(message: string, status: number, bodyText: string | null) {
		super(message)
		this.name = 'YandexVisionError'
		this.status = status
		this.bodyText = bodyText
	}
}

export class YandexVisionBadRequestError extends YandexVisionError {
	constructor(message: string, bodyText: string | null) {
		super(message, 400, bodyText)
		this.name = 'YandexVisionBadRequestError'
	}
}

export class YandexVisionAuthError extends YandexVisionError {
	constructor(message: string) {
		super(message, 401, null)
		this.name = 'YandexVisionAuthError'
	}
}

export class YandexVisionRateLimitError extends YandexVisionError {
	readonly retryAfterSeconds: number | null
	constructor(message: string, retryAfterSeconds: number | null) {
		super(message, 429, null)
		this.name = 'YandexVisionRateLimitError'
		this.retryAfterSeconds = retryAfterSeconds
	}
}

export class YandexVisionTransientError extends YandexVisionError {
	constructor(message: string, status: number, bodyText: string | null) {
		super(message, status, bodyText)
		this.name = 'YandexVisionTransientError'
	}
}

export class YandexVisionNetworkError extends Error {
	constructor(message: string, cause?: unknown) {
		super(message, { cause })
		this.name = 'YandexVisionNetworkError'
	}
}

// -----------------------------------------------------------------------------
// HTTP helper
// -----------------------------------------------------------------------------

type ProviderFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

function parseRetryAfterSeconds(headerValue: string | null): number | null {
	if (headerValue === null) return null
	const n = Number(headerValue)
	if (Number.isFinite(n) && n >= 0) return Math.floor(n)
	return null
}

type CallInput = {
	url: string
	apiKey: string
	folderId: string
	idempotencyKey: string
	body: unknown
}

async function callYandexOcr(opts: {
	fetcher: ProviderFetch
	input: CallInput
	abortSignal: AbortSignal
}): Promise<unknown> {
	const headers: Record<string, string> = {
		Authorization: `Api-Key ${opts.input.apiKey}`,
		'Content-Type': 'application/json',
		'x-folder-id': opts.input.folderId,
		[DATA_LOGGING_DISABLED_HEADER]: 'false', // privacy
		[IDEMPOTENCY_KEY_HEADER]: opts.input.idempotencyKey,
	}

	let res: Response
	try {
		res = await opts.fetcher(opts.input.url, {
			method: 'POST',
			headers,
			body: JSON.stringify(opts.input.body),
			signal: opts.abortSignal,
		})
	} catch (err) {
		throw new YandexVisionNetworkError(`Network error calling ${opts.input.url}`, err)
	}

	const bodyText = await res.text()
	if (res.status === HTTP_OK || res.status === HTTP_CREATED) {
		// Vision OCR returns chunked stream — for single-page passport take
		// first non-empty line. Multi-page would loop, but passport=1 page.
		const firstChunk = bodyText.split('\n').find((l) => l.trim().length > 0) ?? '{}'
		try {
			return JSON.parse(firstChunk)
		} catch (err) {
			throw new YandexVisionBadRequestError(
				`Yandex Vision returned non-JSON 2xx body: ${(err as Error).message}`,
				bodyText,
			)
		}
	}

	if (res.status === 400) {
		throw new YandexVisionBadRequestError(`Yandex Vision 400 Bad Request`, bodyText)
	}
	if (res.status === 401 || res.status === 403) {
		throw new YandexVisionAuthError(
			`Yandex Vision ${res.status} — invalid Api-Key OR insufficient role (ai.vision.user required)`,
		)
	}
	if (res.status === 429) {
		throw new YandexVisionRateLimitError(
			`Yandex Vision 429 Too Many Requests — folder rate-limit hit`,
			parseRetryAfterSeconds(res.headers.get('Retry-After')),
		)
	}
	if (res.status >= 500 && res.status < 600) {
		throw new YandexVisionTransientError(
			`Yandex Vision ${res.status} server error`,
			res.status,
			bodyText,
		)
	}
	throw new YandexVisionError(`Yandex Vision unexpected ${res.status}`, res.status, bodyText)
}

// -----------------------------------------------------------------------------
// Entity mapping (snake_case API → camelCase PassportEntities domain)
// -----------------------------------------------------------------------------

export function emptyPassportEntities(): PassportEntities {
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

type RawEntity = { name: string; text: string }

/** Mutable accumulator type — strips `readonly` from PassportEntities fields. */
type MutablePartialEntities = {
	-readonly [K in keyof PassportEntities]?: PassportEntities[K]
}

export function mapApiEntitiesToDomain(rawEntities: ReadonlyArray<RawEntity>): PassportEntities {
	const partial: MutablePartialEntities = {}
	for (const e of rawEntities) {
		const camelKey = snakeToCamelEntityName(e.name)
		if (camelKey === null) continue // forward-compat: unknown entity → skip
		const text = e.text.trim()
		if (text.length === 0) continue
		if (camelKey === 'gender') {
			partial.gender = normalizeGender(text)
		} else if (camelKey === 'citizenshipIso3') {
			partial.citizenshipIso3 = normalizeCitizenshipToIso3(text)
		} else if (
			camelKey === 'birthDate' ||
			camelKey === 'issueDate' ||
			camelKey === 'expirationDate'
		) {
			partial[camelKey] = parseDateDdMmYyyyToIso(text)
		} else {
			// surname/name/middleName/birthPlace/documentNumber — string-as-is
			partial[camelKey] = text
		}
	}
	return {
		surname: partial.surname ?? null,
		name: partial.name ?? null,
		middleName: partial.middleName ?? null,
		gender: partial.gender ?? null,
		citizenshipIso3: partial.citizenshipIso3 ?? null,
		birthDate: partial.birthDate ?? null,
		birthPlace: partial.birthPlace ?? null,
		documentNumber: partial.documentNumber ?? null,
		issueDate: partial.issueDate ?? null,
		expirationDate: partial.expirationDate ?? null,
	}
}

// -----------------------------------------------------------------------------
// Outcome classification (canon — mirrors mock-vision; documented в types.ts)
// -----------------------------------------------------------------------------

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
	if (allRequired && confidenceHeuristic >= SUCCESS_CONFIDENCE_THRESHOLD) return 'success'
	return 'low_confidence'
}

// -----------------------------------------------------------------------------
// Resilience policy
// -----------------------------------------------------------------------------

function buildResiliencePolicy() {
	// Retry: only network + 5xx + 429. Auth / 400 / NEVER retried (caller errors).
	// `handleType()` NARROW match canon; `handleAll` would defeat the purpose.
	const retryPolicy = retry(
		handleType(YandexVisionTransientError)
			.orType(YandexVisionRateLimitError)
			.orType(YandexVisionNetworkError),
		{
			maxAttempts: RETRY_ADDITIONAL_ATTEMPTS,
			backoff: new ExponentialBackoff({
				initialDelay: RETRY_INITIAL_DELAY_MS,
				exponent: RETRY_EXPONENT,
				maxDelay: RETRY_MAX_DELAY_MS,
			}),
		},
	)
	const breaker = circuitBreaker(
		handleType(YandexVisionTransientError).orType(YandexVisionNetworkError),
		{
			halfOpenAfter: CIRCUIT_HALF_OPEN_AFTER_MS,
			breaker: new ConsecutiveBreaker(CIRCUIT_CONSECUTIVE_FAILURES),
		},
	)
	const timeoutPolicy = timeout(REQUEST_TIMEOUT_MS, TimeoutStrategy.Aggressive)
	return wrap(retryPolicy, breaker, timeoutPolicy)
}

// -----------------------------------------------------------------------------
// Provider factory
// -----------------------------------------------------------------------------

export function createYandexVisionOcr(opts: YandexVisionOptions): VisionOcrAdapter {
	if (!opts.apiKey) {
		throw new Error('Yandex Vision provider requires non-empty apiKey')
	}
	if (!opts.folderId) {
		throw new Error('Yandex Vision provider requires non-empty folderId')
	}
	const apiBase = (opts.apiBase ?? DEFAULT_OCR_API_BASE).replace(/\/$/, '')
	const uuid = opts.uuid ?? (() => crypto.randomUUID())
	const now = opts.now ?? Date.now
	const fetcher: ProviderFetch = opts.fetch ?? ((input, init) => globalThis.fetch(input, init))
	const logger = opts.logger
	const policy = buildResiliencePolicy()
	const url = `${apiBase}${OCR_RECOGNIZE_PATH}`

	return {
		source: 'yandex_vision',
		/**
		 * 152-ФЗ canon (P2.5): adapter does NOT retain `req.bytes` beyond this
		 * function scope. Bytes are base64-encoded into the request body for
		 * ONE fetch call, then eligible для GC. Caller MUST zero-out their own
		 * `bytes` Uint8Array после receiving the response (defense-in-depth для
		 * passport biometric-class data per Roskomnadzor 2026 clarifications —
		 * delete within 5 min of processing). No persistent caching, no logging
		 * of raw bytes (Pino redact paths `*.bytes` / `*.content`).
		 */
		async recognizePassport(req: RecognizePassportRequest): Promise<RecognizePassportResponse> {
			const t0 = now()

			// Validate input
			if (req.bytes.length === 0) {
				return {
					detectedCountryIso3: null,
					isCountryWhitelisted: false,
					entities: emptyPassportEntities(),
					apiConfidenceRaw: 0,
					confidenceHeuristic: 0,
					outcome: 'api_error',
					latencyMs: now() - t0,
					httpStatus: 400,
				}
			}

			const body = {
				content: Buffer.from(req.bytes).toString('base64'),
				mimeType: req.mimeType,
				languageCodes: ['ru', 'en'],
				model: 'passport',
			}

			logger?.info(
				{
					provider: 'yandex_vision',
					mimeType: req.mimeType,
					bytesLen: req.bytes.length,
					countryHint: req.countryHint ?? null,
				},
				'yandex_vision.recognizePassport',
			)

			// Idempotency-Key generated ONCE outside retry callback — retries MUST
			// reuse same key for Yandex Cloud server-side dedup (IETF canon).
			// Generating inside `policy.execute` callback would defeat idempotency
			// because cockatiel re-invokes the closure on each retry.
			const idempotencyKey = uuid()

			let httpStatus = HTTP_OK
			let chunk: unknown
			try {
				chunk = await policy.execute(({ signal }) =>
					callYandexOcr({
						fetcher,
						input: {
							url,
							apiKey: opts.apiKey,
							folderId: opts.folderId,
							idempotencyKey,
							body,
						},
						abortSignal: signal,
					}),
				)
			} catch (err) {
				if (err instanceof YandexVisionError) {
					httpStatus = err.status
				} else if (err instanceof YandexVisionNetworkError) {
					httpStatus = 0 // 0 = network failure (no HTTP exchange)
				} else {
					throw err
				}
				logger?.warn(
					{
						provider: 'yandex_vision',
						httpStatus,
						err: (err as Error).message,
					},
					'yandex_vision.recognizePassport: API failure → api_error outcome',
				)
				return {
					detectedCountryIso3: null,
					isCountryWhitelisted: false,
					entities: emptyPassportEntities(),
					apiConfidenceRaw: 0,
					confidenceHeuristic: 0,
					outcome: 'api_error',
					latencyMs: now() - t0,
					httpStatus,
				}
			}

			// Parse chunk envelope. Zod validates shape — if API drifts, fail loud.
			const parsed = yandexVisionChunkSchema.parse(chunk)
			if (parsed.error !== undefined) {
				logger?.warn(
					{
						provider: 'yandex_vision',
						errCode: parsed.error.code,
						errMessage: parsed.error.message,
					},
					'yandex_vision.recognizePassport: API error envelope → api_error outcome',
				)
				return {
					detectedCountryIso3: null,
					isCountryWhitelisted: false,
					entities: emptyPassportEntities(),
					apiConfidenceRaw: 0,
					confidenceHeuristic: 0,
					outcome: 'api_error',
					latencyMs: now() - t0,
					httpStatus,
				}
			}

			const rawEntities = parsed.result?.textAnnotation?.entities ?? []
			const entities = mapApiEntitiesToDomain(rawEntities)
			const detectedCountryIso3 = entities.citizenshipIso3
			const isCountryWhitelisted =
				detectedCountryIso3 !== null && PASSPORT_COUNTRY_WHITELIST.has(detectedCountryIso3)
			const confidenceHeuristic = computeHeuristicConfidence(entities, new Date(now()))
			const outcome = classifyOutcome(
				entities,
				confidenceHeuristic,
				httpStatus,
				isCountryWhitelisted,
			)
			const latencyMs = now() - t0

			logger?.info(
				{
					provider: 'yandex_vision',
					outcome,
					confidenceHeuristic,
					detectedCountryIso3,
					latencyMs,
				},
				'yandex_vision.recognizePassport: complete',
			)

			return {
				detectedCountryIso3,
				isCountryWhitelisted,
				entities,
				apiConfidenceRaw: 0, // Yandex Vision canon — broken upstream (per types.ts §3.2)
				confidenceHeuristic,
				outcome,
				latencyMs,
				httpStatus,
			}
		},
	}
}
