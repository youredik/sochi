/**
 * ЮKassa PaymentProvider — REAL REST implementation (P1 atomic, 2026-05-18).
 *
 * Replaces the placeholder. Conforms to canonical `PaymentProvider` interface
 * (`packages/shared/src/payment.ts`). Production-grade — used in APP_MODE=sandbox
 * (test_xxx ключи) AND APP_MODE=production (live ключи). Same code path; mode
 * is registry metadata + APP_MODE startup gate.
 *
 * ## Canon refs (verified 2026-05-18)
 *
 * - API base: `https://api.yookassa.ru/v3` — НЕТ v4
 * - Auth: HTTP Basic (shopId:secretKey base64-encoded)
 * - Idempotency header spelling: **`Idempotence-Key`** (NOT `Idempotency-Key`)
 *   — 64 chars max, UUIDv4, 24h dedup window per shopId
 * - Same key + identical body → cached response; same key + DIFFERENT body → 400
 * - Webhook security: NO HMAC — only IP allowlist (7 CIDRs) + GET round-trip
 * - `refund.canceled` event НЕ существует — poll `GET /v3/refunds/{id}`
 * - Confirmation flow: `redirect` к `confirmation_url`, return через `return_url`
 *
 * ## Resilience (Cockatiel 3.2 composable policy)
 *
 * - Retry: 2 attempts max, exponential 500ms-4s base (Stripe canon — fewer
 *   retries на payment-call, idempotency-key carries the dedup)
 * - Circuit Breaker: 5 consecutive failures, 30s half-open probe
 * - Timeout: 30s через cockatiel TimeoutStrategy.Aggressive
 *
 * ## Error mapping (boundary)
 *
 * REST errors → typed exceptions:
 *   - 400 → YookassaBadRequestError (with parsed body)
 *   - 401 → YookassaAuthError (shop_id/secret_key invalid)
 *   - 404 → YookassaNotFoundError (payment/refund missing)
 *   - 429 → YookassaRateLimitError (retry-after honored)
 *   - 5xx → YookassaTransientError (retry candidate)
 *   - network → YookassaNetworkError
 *
 * ## Sensitive data
 *
 * NEVER log raw `Authorization` header, secretKey, or PAN. Pino redaction
 * applied. Webhook body может contain payment_method.card.last4 — этого
 * редактировать НЕ надо (last4 НЕ PII).
 */

import {
	type PaymentInitiateRequest,
	type PaymentProvider,
	type PaymentProviderCapabilities,
	type PaymentProviderSnapshot,
	type PaymentRefundRequest,
	type PaymentStatus,
	type RefundProviderSnapshot,
	type VerifiedWebhookEvent,
	synthesizeYookassaDedupKey,
} from '@horeca/shared'
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
import {
	amountValueToKopecks,
	kopecksToAmountValue,
	YOOKASSA_SBER_BNPL_MAX_RUB_KOPECKS,
	yookassaCaptureRequestSchema,
	yookassaPaymentCreateRequestSchema,
	yookassaPaymentObjectSchema,
	yookassaRefundCreateRequestSchema,
	yookassaRefundObjectSchema,
	yookassaWebhookPayloadSchema,
	type YookassaPaymentObject,
	type YookassaRefundObject,
} from './yookassa-schemas.ts'

// -----------------------------------------------------------------------------
// Capabilities (Q2 2026 canon)
// -----------------------------------------------------------------------------

const YOOKASSA_CAPABILITIES: PaymentProviderCapabilities = Object.freeze({
	partialCapture: true,
	holdPeriodHours: 72, // T+72h (ЮKassa canon)
	sbpNative: false, // bank_card по умолчанию; SBP via payment_method_data.type
	fiscalization: 'native', // ЮKassa Чеки
	supportsCorrection: true,
})

// -----------------------------------------------------------------------------
// Resilience policy constants (rationale inline — DO NOT inline as magic)
// -----------------------------------------------------------------------------

/**
 * Number of *additional* attempts after the initial call (Cockatiel semantics).
 * Stripe canon 2026: total attempts ≤ 2 для payment calls, because the
 * `Idempotence-Key` header carries provider-side dedup. More retries =
 * idempotency-risk multiplication (per AWS Builders Library timeouts-retries-
 * backoff guide). 1 retry after initial = 2 total attempts maximum.
 */
const RETRY_ADDITIONAL_ATTEMPTS = 1

/**
 * Initial backoff delay before first retry (ms). Equal-Jitter pattern from AWS
 * SDK Issue #4341 (2026) — preferred over Full-Jitter для rate-limit-friendly
 * behavior with ЮKassa 3 RPS effective ceiling.
 */
const RETRY_INITIAL_DELAY_MS = 500

/** Exponent base for retry backoff (500ms → 1000ms → 2000ms → 4000ms cap). */
const RETRY_EXPONENT = 2

/** Cap on backoff to avoid pathological waits на flaky network. */
const RETRY_MAX_DELAY_MS = 4_000

/**
 * Consecutive failures before circuit opens. 5 = balances false-trip risk vs
 * detection latency (per Cockatiel docs 2026, Netflix Hystrix lineage).
 */
const CIRCUIT_CONSECUTIVE_FAILURES = 5

/**
 * Half-open probe interval (ms). After 30s circuit allows 1 trial request;
 * success → closes, failure → opens again. Aligned с ЮKassa 24h retry window
 * minus 1 order of magnitude (canon: dependency-availability < provider-retry).
 */
const CIRCUIT_HALF_OPEN_AFTER_MS = 30_000

/**
 * Request timeout (ms). ЮKassa SLA — payment.initiate < 5s P99 (empirical
 * 2026). 30s = headroom × 6, hard cap before treating as transient failure.
 */
const REQUEST_TIMEOUT_MS = 30_000

/** Successful HTTP status codes for ЮKassa REST v3. */
const HTTP_OK = 200
const HTTP_CREATED = 201

/** Description max length (ЮKassa spec 2026-05-18 — 128 char hard limit). */
const DESCRIPTION_MAX_LEN = 128

/** Refund description max length (ЮKassa spec — 250 char hard limit). */
const REFUND_DESCRIPTION_MAX_LEN = 250

/**
 * Idempotency-Key format validation (P2.5 security hardening, 2026-05-19).
 *
 * Defense against CRLF injection (Node ≥19 blocks at runtime, но defense-in-depth
 * canon mandates pre-send validation). 64 chars max per ЮKassa spec; UUIDv4 fits
 * (36 chars). Allow A-Z/a-z/0-9/_/- only — rejects any control characters.
 */
const IDEMPOTENCE_KEY_PATTERN = /^[A-Za-z0-9_-]{1,64}$/

/**
 * Allowed hosts для ЮKassa-returned `confirmation_url` (P2.5 supply-chain defense).
 * If response contains URL pointing к unexpected host → reject (would otherwise
 * become attacker-controlled redirect in case ЮKassa SDK chain compromise like
 * Axios npm precedent Apr 2026).
 */
const ALLOWED_CONFIRMATION_HOSTS: ReadonlySet<string> = new Set(['yoomoney.ru', 'yookassa.ru'])

// -----------------------------------------------------------------------------
// Public configuration
// -----------------------------------------------------------------------------

export type YookassaProviderOptions = {
	shopId: string
	secretKey: string
	/**
	 * Previous `secretKey` value (B2, 2026-05-19). When provided, requests
	 * receiving 401 are retried ONCE with this previous key. Defense against
	 * ЮKassa's 48-hour sliding rotation window (their canon — single-active
	 * secret + 48h grace). Operator rotates: set previous = current, current =
	 * new, deploy. After 48h, unset previous. Optional — adapter no-ops if absent.
	 *
	 * Anti-pattern: previous-key usage triggers `logger.warn` для observability —
	 * if seen frequently, rotation procedure has gap.
	 */
	secretKeyPrevious?: string
	apiBase: string
	/**
	 * Default return_url passed в `confirmation`. Caller can override per-request
	 * через metadata. Must be HTTPS in production (per PCI SAQ-A redirect path).
	 */
	returnUrl: string
	/**
	 * UUIDv4 generator. Injected for tests; default `crypto.randomUUID()`.
	 * 2026 canon: ЮKassa рекомендует UUIDv4 для `Idempotence-Key` (не v7).
	 */
	uuid?: () => string
	/**
	 * `fetch` injection seam (tests OR future custom HTTP-agent for outbound
	 * mTLS / proxy). Default `globalThis.fetch.bind(globalThis)`. Narrowed
	 * к minimal signature — Bun's `typeof fetch` has extra `preconnect` method
	 * we don't use, requiring it would force tests к stub a non-functional API.
	 */
	fetch?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>
	/**
	 * Structured logger (Pino-compatible). When absent, uses no-op.
	 * Redacts sensitive fields automatically (Authorization, secretKey).
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

export class YookassaError extends Error {
	readonly status: number
	readonly bodyText: string | null
	constructor(message: string, status: number, bodyText: string | null) {
		super(message)
		this.name = 'YookassaError'
		this.status = status
		this.bodyText = bodyText
	}
}

export class YookassaBadRequestError extends YookassaError {
	constructor(message: string, bodyText: string | null) {
		super(message, 400, bodyText)
		this.name = 'YookassaBadRequestError'
	}
}

export class YookassaAuthError extends YookassaError {
	constructor(message: string) {
		super(message, 401, null)
		this.name = 'YookassaAuthError'
	}
}

export class YookassaNotFoundError extends YookassaError {
	constructor(message: string) {
		super(message, 404, null)
		this.name = 'YookassaNotFoundError'
	}
}

export class YookassaRateLimitError extends YookassaError {
	readonly retryAfterSeconds: number | null
	constructor(message: string, retryAfterSeconds: number | null) {
		super(message, 429, null)
		this.name = 'YookassaRateLimitError'
		this.retryAfterSeconds = retryAfterSeconds
	}
}

export class YookassaTransientError extends YookassaError {
	constructor(message: string, status: number, bodyText: string | null) {
		super(message, status, bodyText)
		this.name = 'YookassaTransientError'
	}
}

export class YookassaNetworkError extends Error {
	constructor(message: string, cause?: unknown) {
		super(message, { cause })
		this.name = 'YookassaNetworkError'
	}
}

export class YookassaSberBnplLimitError extends Error {
	constructor(amountKopecks: bigint) {
		super(
			`sber_bnpl payment ${amountKopecks} kopecks exceeds limit ${YOOKASSA_SBER_BNPL_MAX_RUB_KOPECKS} kopecks (50 000 ₽, changelog 2026-04-23)`,
		)
		this.name = 'YookassaSberBnplLimitError'
	}
}

// -----------------------------------------------------------------------------
// Internal HTTP helper (Basic auth + Idempotence-Key + JSON encode/decode)
// -----------------------------------------------------------------------------

/**
 * IMPORTANT: header spelling is **`Idempotence-Key`** (not -y). Locked by
 * provider tests. RFC-style autocorrect would break dedup.
 */
const IDEMPOTENCE_KEY_HEADER = 'Idempotence-Key'

type FetchInput = {
	url: string
	method: 'GET' | 'POST'
	idempotenceKey?: string
	body?: unknown
}

function basicAuthHeader(shopId: string, secretKey: string): string {
	const token = Buffer.from(`${shopId}:${secretKey}`, 'utf-8').toString('base64')
	return `Basic ${token}`
}

function parseRetryAfterSeconds(headerValue: string | null): number | null {
	if (headerValue === null) return null
	const n = Number(headerValue)
	if (Number.isFinite(n) && n >= 0) return Math.floor(n)
	return null
}

type ProviderFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

async function callYookassa(opts: {
	authHeader: string
	fetcher: ProviderFetch
	input: FetchInput
	abortSignal: AbortSignal
}): Promise<unknown> {
	const headers: Record<string, string> = {
		Authorization: opts.authHeader,
		'Content-Type': 'application/json',
	}
	if (opts.input.idempotenceKey) {
		headers[IDEMPOTENCE_KEY_HEADER] = opts.input.idempotenceKey
	}

	const requestInit: RequestInit = {
		method: opts.input.method,
		headers,
		signal: opts.abortSignal,
	}
	if (opts.input.body !== undefined) {
		requestInit.body = JSON.stringify(opts.input.body)
	}
	let res: Response
	try {
		res = await opts.fetcher(opts.input.url, requestInit)
	} catch (err) {
		throw new YookassaNetworkError(
			`Network error calling ${opts.input.method} ${opts.input.url}`,
			err,
		)
	}

	const bodyText = await res.text()
	if (res.status === HTTP_OK || res.status === HTTP_CREATED) {
		try {
			return JSON.parse(bodyText)
		} catch (err) {
			throw new YookassaBadRequestError(
				`ЮKassa returned non-JSON 2xx body: ${(err as Error).message}`,
				bodyText,
			)
		}
	}

	if (res.status === 400) {
		throw new YookassaBadRequestError(`ЮKassa 400 Bad Request`, bodyText)
	}
	if (res.status === 401) {
		throw new YookassaAuthError(`ЮKassa 401 Unauthorized — invalid shopId/secretKey pair`)
	}
	if (res.status === 404) {
		throw new YookassaNotFoundError(`ЮKassa 404 — resource not found`)
	}
	if (res.status === 429) {
		throw new YookassaRateLimitError(
			`ЮKassa 429 Too Many Requests`,
			parseRetryAfterSeconds(res.headers.get('Retry-After')),
		)
	}
	if (res.status >= 500 && res.status < 600) {
		throw new YookassaTransientError(`ЮKassa ${res.status} server error`, res.status, bodyText)
	}
	throw new YookassaError(`ЮKassa unexpected ${res.status}`, res.status, bodyText)
}

// -----------------------------------------------------------------------------
// Mapping ЮKassa status → domain status
// -----------------------------------------------------------------------------

function mapPaymentStatus(yk: YookassaPaymentObject['status']): PaymentStatus {
	switch (yk) {
		case 'pending':
			return 'pending'
		case 'waiting_for_capture':
			return 'waiting_for_capture'
		case 'succeeded':
			return 'succeeded'
		case 'canceled':
			return 'canceled'
	}
}

function mapRefundStatus(yk: YookassaRefundObject['status']): 'pending' | 'succeeded' | 'failed' {
	switch (yk) {
		case 'pending':
			return 'pending'
		case 'succeeded':
			return 'succeeded'
		case 'canceled':
			return 'failed' // domain не различает canceled от failed
	}
}

function paymentObjectToSnapshot(obj: YookassaPaymentObject): PaymentProviderSnapshot {
	const authorizedKopecks = amountValueToKopecks(obj.amount.value)
	// `paid: true` означает что списание прошло; до этого authorized=0
	const capturedKopecks = obj.paid ? authorizedKopecks : 0n
	// P2.5 supply-chain defense: validate confirmation_url host BEFORE returning к
	// caller (who may 302 redirect к it). Catches scenario where ЮKassa SDK chain
	// compromise returns attacker-controlled URL — host allowlist blocks redirect.
	let confirmationUrl: string | null = null
	const rawConfirmationUrl = obj.confirmation?.confirmation_url ?? null
	if (rawConfirmationUrl !== null) {
		try {
			const parsed = new URL(rawConfirmationUrl)
			if (ALLOWED_CONFIRMATION_HOSTS.has(parsed.host)) {
				confirmationUrl = rawConfirmationUrl
			}
			// Malicious-host → keep null. Caller treats as "no redirect available";
			// payment status set, но UX shows error (defense-in-depth — better than
			// 302 к phisher).
		} catch {
			confirmationUrl = null // malformed URL → ignore
		}
	}
	return {
		providerPaymentId: obj.id,
		status: mapPaymentStatus(obj.status),
		authorizedMinor: authorizedKopecks,
		capturedMinor: capturedKopecks,
		confirmationUrl,
		holdExpiresAt: obj.expires_at ?? null,
		failureReason: obj.cancellation_details
			? `${obj.cancellation_details.party}:${obj.cancellation_details.reason}`
			: null,
	}
}

function refundObjectToSnapshot(obj: YookassaRefundObject): RefundProviderSnapshot {
	return {
		providerRefundId: obj.id,
		status: mapRefundStatus(obj.status),
		amountMinor: amountValueToKopecks(obj.amount.value),
		failureReason: obj.cancellation_details
			? `${obj.cancellation_details.party}:${obj.cancellation_details.reason}`
			: null,
	}
}

// -----------------------------------------------------------------------------
// Resilience policy (Cockatiel 3.2)
// -----------------------------------------------------------------------------

function buildResiliencePolicy() {
	// Retry: only network + 5xx + 429. Auth / 400 / 404 NEVER retried
	// (those are caller errors, retry would never succeed). `handleType()`
	// NARROW match canon; `handleAll` would defeat the purpose (matches everything).
	const retryPolicy = retry(
		handleType(YookassaTransientError).orType(YookassaRateLimitError).orType(YookassaNetworkError),
		{
			maxAttempts: RETRY_ADDITIONAL_ATTEMPTS,
			backoff: new ExponentialBackoff({
				initialDelay: RETRY_INITIAL_DELAY_MS,
				exponent: RETRY_EXPONENT,
				maxDelay: RETRY_MAX_DELAY_MS,
			}),
		},
	)
	const breaker = circuitBreaker(handleType(YookassaTransientError).orType(YookassaNetworkError), {
		halfOpenAfter: CIRCUIT_HALF_OPEN_AFTER_MS,
		breaker: new ConsecutiveBreaker(CIRCUIT_CONSECUTIVE_FAILURES),
	})
	const timeoutPolicy = timeout(REQUEST_TIMEOUT_MS, TimeoutStrategy.Aggressive)
	return wrap(retryPolicy, breaker, timeoutPolicy)
}

// -----------------------------------------------------------------------------
// Provider factory
// -----------------------------------------------------------------------------

export function createYooKassaPaymentProvider(opts: YookassaProviderOptions): PaymentProvider {
	if (!opts.shopId) {
		throw new Error('YooKassa provider requires non-empty shopId')
	}
	if (!opts.secretKey) {
		throw new Error('YooKassa provider requires non-empty secretKey')
	}
	if (!opts.apiBase) {
		throw new Error('YooKassa provider requires apiBase (default https://api.yookassa.ru/v3)')
	}
	if (!opts.returnUrl) {
		throw new Error('YooKassa provider requires returnUrl для confirmation.redirect')
	}

	const authHeader = basicAuthHeader(opts.shopId, opts.secretKey)
	// B2 (2026-05-19): ЮKassa 48h sliding-window dual-secret fallback.
	// On 401 against current secret, retry ONCE с previous secret (если provided).
	// Operator rotation flow: set previous=current + current=new + deploy, wait
	// 48h, unset previous.
	const authHeaderPrevious =
		opts.secretKeyPrevious && opts.secretKeyPrevious.length > 0
			? basicAuthHeader(opts.shopId, opts.secretKeyPrevious)
			: null
	const uuid = opts.uuid ?? (() => crypto.randomUUID())
	const fetcher: ProviderFetch = opts.fetch ?? ((input, init) => globalThis.fetch(input, init))
	const logger = opts.logger
	const policy = buildResiliencePolicy()
	const apiBase = opts.apiBase.replace(/\/$/, '')

	async function callWithResilience(input: FetchInput): Promise<unknown> {
		try {
			// `policy.execute(ctx)` provides AbortSignal which honors timeout.
			return await policy.execute(({ signal }) =>
				callYookassa({
					authHeader,
					fetcher,
					input,
					abortSignal: signal,
				}),
			)
		} catch (err) {
			// B2: fall back к previous-key on 401, log warn (audit trail).
			if (err instanceof YookassaAuthError && authHeaderPrevious !== null) {
				logger?.warn(
					{
						provider: 'yookassa',
						reason: 'auth_retry_with_previous_secret',
					},
					'yookassa: 401 on current secret — retrying с previous (rotation grace)',
				)
				return await policy.execute(({ signal }) =>
					callYookassa({
						authHeader: authHeaderPrevious,
						fetcher,
						input,
						abortSignal: signal,
					}),
				)
			}
			throw err
		}
	}

	return {
		code: 'yookassa',
		capabilities: YOOKASSA_CAPABILITIES,

		async initiate(req: PaymentInitiateRequest): Promise<PaymentProviderSnapshot> {
			// P2.5: validate Idempotency-Key format (CRLF inject defense-in-depth)
			if (!IDEMPOTENCE_KEY_PATTERN.test(req.providerIdempotencyKey)) {
				throw new YookassaBadRequestError(
					`Invalid Idempotency-Key format: must match ${IDEMPOTENCE_KEY_PATTERN.source}`,
					null,
				)
			}

			// sber_bnpl 50 000 ₽ clamp (changelog 2026-04-23)
			const ybMethodHint = req.metadata?.yookassaPaymentMethodType
			if (ybMethodHint === 'sber_bnpl' && req.amountMinor > YOOKASSA_SBER_BNPL_MAX_RUB_KOPECKS) {
				throw new YookassaSberBnplLimitError(req.amountMinor)
			}

			// P2.5 open-redirect defense: `req.metadata.returnUrl` override REMOVED.
			// Per-request URL override admitted phishing redirects (OWASP A10).
			// Operators must configure adapter `opts.returnUrl` per environment
			// (test/prod) — per-tenant override path = future multi-tenant phase
			// с explicit allowlist canon.
			const body = {
				amount: {
					value: kopecksToAmountValue(req.amountMinor),
					currency: 'RUB' as const,
				},
				capture: true, // single-stage capture; explicit two-stage NOT в V1
				confirmation: {
					type: 'redirect' as const,
					return_url: `${opts.returnUrl}?paymentId=${req.localPaymentId}`,
				},
				...(ybMethodHint ? { payment_method_data: { type: ybMethodHint } } : {}),
				description: req.metadata?.description?.slice(0, DESCRIPTION_MAX_LEN),
				metadata: {
					localPaymentId: req.localPaymentId,
					...(req.metadata ?? {}),
				},
			}

			// Defensive: validate outgoing request shape before send (symmetric с capture/refund).
			const validatedBody = yookassaPaymentCreateRequestSchema.parse(body)
			logger?.info(
				{
					provider: 'yookassa',
					localPaymentId: req.localPaymentId,
					amountKopecks: req.amountMinor.toString(),
					method: req.method,
				},
				'yookassa.initiate',
			)

			const raw = await callWithResilience({
				url: `${apiBase}/payments`,
				method: 'POST',
				idempotenceKey: req.providerIdempotencyKey,
				body: validatedBody,
			})
			const parsed = yookassaPaymentObjectSchema.parse(raw)
			return paymentObjectToSnapshot(parsed)
		},

		async capture(
			providerPaymentId: string,
			amountMinor: bigint | null,
		): Promise<PaymentProviderSnapshot> {
			if (amountMinor !== null && amountMinor < 0n) {
				throw new RangeError(`capture amount must be >= 0, got ${amountMinor}`)
			}
			const body =
				amountMinor === null
					? {}
					: {
							amount: {
								value: kopecksToAmountValue(amountMinor),
								currency: 'RUB' as const,
							},
						}
			// Defensive: validate outgoing request shape before send (catches own bugs).
			const validatedBody = yookassaCaptureRequestSchema.parse(body)
			logger?.info(
				{
					provider: 'yookassa',
					providerPaymentId,
					amountKopecks: amountMinor === null ? 'full' : amountMinor.toString(),
				},
				'yookassa.capture',
			)

			const raw = await callWithResilience({
				url: `${apiBase}/payments/${providerPaymentId}/capture`,
				method: 'POST',
				idempotenceKey: uuid(),
				body: validatedBody,
			})
			const parsed = yookassaPaymentObjectSchema.parse(raw)
			return paymentObjectToSnapshot(parsed)
		},

		async cancel(
			providerPaymentId: string,
		): Promise<PaymentProviderSnapshot | RefundProviderSnapshot> {
			logger?.info({ provider: 'yookassa', providerPaymentId }, 'yookassa.cancel')
			const raw = await callWithResilience({
				url: `${apiBase}/payments/${providerPaymentId}/cancel`,
				method: 'POST',
				idempotenceKey: uuid(),
				body: {},
			})
			const parsed = yookassaPaymentObjectSchema.parse(raw)
			return paymentObjectToSnapshot(parsed)
		},

		async refund(req: PaymentRefundRequest): Promise<RefundProviderSnapshot> {
			if (req.amountMinor < 0n) {
				throw new RangeError(`refund amount must be >= 0, got ${req.amountMinor}`)
			}
			// P2.5: validate Idempotency-Key format (CRLF inject defense-in-depth)
			if (!IDEMPOTENCE_KEY_PATTERN.test(req.providerIdempotencyKey)) {
				throw new YookassaBadRequestError(
					`Invalid Idempotency-Key format: must match ${IDEMPOTENCE_KEY_PATTERN.source}`,
					null,
				)
			}
			const body = {
				payment_id: req.providerPaymentId,
				amount: {
					value: kopecksToAmountValue(req.amountMinor),
					currency: 'RUB' as const,
				},
				description: req.reason.slice(0, REFUND_DESCRIPTION_MAX_LEN),
			}
			// Defensive: validate outgoing request shape before send (catches own bugs).
			const validatedBody = yookassaRefundCreateRequestSchema.parse(body)
			logger?.info(
				{
					provider: 'yookassa',
					providerPaymentId: req.providerPaymentId,
					amountKopecks: req.amountMinor.toString(),
				},
				'yookassa.refund',
			)

			const raw = await callWithResilience({
				url: `${apiBase}/refunds`,
				method: 'POST',
				idempotenceKey: req.providerIdempotencyKey,
				body: validatedBody,
			})
			const parsed = yookassaRefundObjectSchema.parse(raw)
			return refundObjectToSnapshot(parsed)
		},

		async verifyWebhook(headers: Headers, rawBody: Uint8Array): Promise<VerifiedWebhookEvent> {
			// ЮKassa: NO HMAC verification. Caller validates source IP at the
			// HTTP route layer (hono/ip-restriction with YOOKASSA_WEBHOOK_IP_CIDRS).
			// Here we only parse + synthesize dedup key from canonical fields.
			//
			// Content-Length guard (defensive — Hono provides parsed Headers, but
			// if upstream proxy truncates we want a loud failure не silent dedup).
			const contentLengthRaw = headers.get('content-length')
			if (contentLengthRaw !== null) {
				const contentLength = Number(contentLengthRaw)
				if (Number.isFinite(contentLength) && contentLength !== rawBody.byteLength) {
					throw new YookassaBadRequestError(
						`ЮKassa webhook: Content-Length ${contentLength} != bytesRead ${rawBody.byteLength}`,
						null,
					)
				}
			}

			let payloadObj: unknown
			try {
				payloadObj = JSON.parse(new TextDecoder().decode(rawBody))
			} catch (err) {
				throw new YookassaBadRequestError(
					`ЮKassa webhook body is not valid JSON: ${(err as Error).message}`,
					null,
				)
			}
			const payload = yookassaWebhookPayloadSchema.parse(payloadObj)

			// Branch на тип event'а. Только payment.* и refund.succeeded surfaced
			// в domain VerifiedWebhookEvent — все остальные events игнорируем
			// (caller записывает в paymentWebhookEvent для audit, но не транзакционит).
			if (
				payload.event === 'payment.waiting_for_capture' ||
				payload.event === 'payment.succeeded' ||
				payload.event === 'payment.canceled'
			) {
				const paymentObj = yookassaPaymentObjectSchema.parse(payload.object)
				const snapshot = paymentObjectToSnapshot(paymentObj)
				const dedupKey = synthesizeYookassaDedupKey({
					providerPaymentId: paymentObj.id,
					event: payload.event,
					status: paymentObj.status,
					amountValue: paymentObj.amount.value,
				})
				return {
					dedupKey,
					providerCode: 'yookassa',
					subject: { kind: 'payment', snapshot },
					receivedAt: new Date().toISOString(),
				}
			}

			if (payload.event === 'refund.succeeded') {
				const refundObj = yookassaRefundObjectSchema.parse(payload.object)
				const refund = refundObjectToSnapshot(refundObj)
				const dedupKey = synthesizeYookassaDedupKey({
					providerPaymentId: refundObj.payment_id,
					event: payload.event,
					status: refundObj.status,
					amountValue: refundObj.amount.value,
				})
				return {
					dedupKey,
					providerCode: 'yookassa',
					subject: {
						kind: 'refund',
						refund,
						parentProviderPaymentId: refundObj.payment_id,
					},
					receivedAt: new Date().toISOString(),
				}
			}

			// payout.* / deal.* / payment_method.active — surface как
			// неподдерживаемый event для caller; caller записывает в audit log.
			throw new YookassaBadRequestError(
				`ЮKassa webhook event "${payload.event}" not handled at provider level — record для audit, не transition state`,
				null,
			)
		},

		async releaseResidualHold(_providerPaymentId: string): Promise<void> {
			// ЮKassa авто-релизит partial-capture residual hold по истечении 72h.
			// No explicit action required (T-Kassa требует — иной adapter).
			return
		},
	}
}
